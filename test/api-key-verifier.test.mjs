import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { cli } from './helpers.mjs';

const { createApiKeyVerifier } = await import(new URL('./api-key-verifier.js', pathToFileURL(cli)));
const endpoint = 'https://api.nstdata.io/api/v1/api/user/info';
const signal = () => new AbortController().signal;
const data = (balance = 1) => ({ email: 'synthetic@example.test', balance, referralBalance: 0 });
const envelope = (value = data()) => ({ data: value, err: false, msg: 'SUCCESS', code: 200 });
const accepted = value => Response.json(envelope(value));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const redacted = error => {
    assert.equal(error.constructor, Error);
    assert.equal(error.message, 'API key verification unavailable');
    assert.equal(Object.hasOwn(error, 'cause'), false);
    assert.doesNotMatch(JSON.stringify(error), /synthetic|private|https?:|x-api-key|Authorization/);
    return true;
};

test('user-info acceptance sends exactly one fixed GET with only the key and returns a boolean, including zero/negative balances', async () => {
    const requests = [];
    const verify = createApiKeyVerifier({ fetch: async (url, init) => {
        assert.equal(url, endpoint);
        assert.equal(init.method, 'GET');
        assert.equal(init.redirect, 'error');
        assert.ok(init.signal instanceof AbortSignal);
        assert.equal(init.signal.aborted, false);
        assert.deepEqual(Object.keys(init).sort(), ['headers', 'method', 'redirect', 'signal']);
        assert.deepEqual(init.headers, { 'x-api-key': 'synthetic-key' });
        requests.push(init);
        return accepted(data(requests.length === 1 ? 0 : -1));
    } });
    assert.equal(await verify('synthetic-key', signal()), true);
    assert.equal(await verify('synthetic-key', signal()), true);
    assert.equal(requests.length, 2, 'one request per attempt, no retries or account bindings');
    assert.notEqual(requests[0].headers, requests[1].headers);
    assert.notEqual(requests[0].signal, requests[1].signal);
});

test('invalid/injected/noncanonical/oversize keys are denied locally without trimming or network access', async () => {
    let calls = 0;
    const verify = createApiKeyVerifier({ fetch: async () => { calls++; return accepted(); } });
    for (const key of [undefined, null, 1, {}, '', ' ', ' synthetic', 'synthetic ', 'syn thetic', 'synthetic\tkey',
        'synthetic\r\nx-team-id: private', 'synthetic\0key', 'synthetic\u007fkey', 'synthetic\u00a0key', '\ud800',
        'a'.repeat(16_385), 'é'.repeat(8_193)]) {
        assert.equal(await verify(key, signal()), false);
    }
    assert.equal(calls, 0);
    assert.equal(await verify('a'.repeat(16_384), signal()), true);
    assert.equal(await verify('é'.repeat(8_192), signal()), true, 'the cap counts UTF-8 bytes');
    assert.equal(calls, 2);
});

test('401/403/470 reject only this attempt and cancel bodies without parsing response details', async () => {
    let calls = 0, cancellations = 0;
    const responses = [401, 403, 470];
    const verify = createApiKeyVerifier({ fetch: async () => {
        calls++;
        if (calls > 3) return accepted();
        return new Response(new ReadableStream({ cancel() { cancellations++; return new Promise(() => {}); } }),
            { status: responses[calls - 1], headers: { 'content-length': '999999999' } });
    } });
    for (const _status of responses) assert.equal(await verify('synthetic-key', signal()), false);
    assert.equal(cancellations, 3);
    assert.equal(await verify('synthetic-key', signal()), true, 'a denial never permanently revokes or caches the key');
    assert.equal(calls, 4);
});

test('unexpected status, malformed envelopes, invalid JSON and invalid UTF-8 never authenticate or leak payloads', async () => {
    const malformed = [null, [], {}, { ...envelope(), err: true }, { ...envelope(), err: 0 },
        { ...envelope(), code: '200' }, { ...envelope(), code: 201 }, { ...envelope(), msg: 'private' },
        { ...envelope(), data: null }, { ...envelope(), data: [] }, envelope({ ...data(), email: '' }),
        envelope({ ...data(), email: ' ' }), envelope({ ...data(), email: null }), envelope({ ...data(), balance: '0' }),
        envelope({ ...data(), balance: null }), envelope({ email: 'private', balance: 0 }),
        envelope({ ...data(), referralBalance: false }), envelope({ userId: 'private', teamId: 'private', scopes: ['crawl:use'] })];
    for (const value of malformed) {
        await assert.rejects(createApiKeyVerifier({ fetch: async () => Response.json(value) })('synthetic-private', signal()), redacted);
    }
    for (const status of [201, 204, 301, 302, 307, 400, 404, 429, 500, 503]) {
        await assert.rejects(createApiKeyVerifier({ fetch: async () => new Response(null, { status }) })('synthetic-private', signal()), redacted);
    }
    for (const body of ['private not JSON', '{"data":', new Uint8Array([0xff, 0xfe])]) {
        await assert.rejects(createApiKeyVerifier({ fetch: async () => new Response(body) })('synthetic-private', signal()), redacted);
    }
});

test('declared and streamed byte limits reject early, cancel the body and do not trust Content-Length', async () => {
    for (const length of ['17', '9999999999999999999999999999999', '-1', '1.5', 'private']) {
        let reads = 0, cancelled = 0;
        const body = new ReadableStream({ pull() { reads++; }, cancel() { cancelled++; } }, { highWaterMark: 0 });
        const verify = createApiKeyVerifier({ maxResponseBytes: 16, fetch: async () => new Response(body, { headers: { 'content-length': length } }) });
        await assert.rejects(verify('synthetic-private', signal()), redacted);
        assert.equal(reads, 0);
        assert.equal(cancelled, 1);
    }
    for (const headers of [{}, { 'content-length': '1' }]) {
        let cancelled = 0;
        const body = new ReadableStream({ start(controller) {
            controller.enqueue(new Uint8Array(10));
            controller.enqueue(new Uint8Array(10));
        }, cancel() { cancelled++; return new Promise(() => {}); } });
        await assert.rejects(createApiKeyVerifier({ maxResponseBytes: 16, fetch: async () => new Response(body, { headers }) })
            ('synthetic-private', signal()), redacted);
        assert.equal(cancelled, 1);
    }
    const body = JSON.stringify(envelope());
    assert.equal(await createApiKeyVerifier({ maxResponseBytes: Buffer.byteLength(body),
        fetch: async () => new Response(body, { headers: { 'content-length': String(Buffer.byteLength(body)) } }) })
        ('synthetic-key', signal()), true);
    await assert.rejects(createApiKeyVerifier({ maxResponseBytes: Buffer.byteLength(body) - 1,
        fetch: async () => new Response(body) })('synthetic-private', signal()), redacted);
});

test('the default 16 KiB body bound applies to chunked responses', async () => {
    let cancelled = 0;
    const body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(16_385)); }, cancel() { cancelled++; } });
    await assert.rejects(createApiKeyVerifier({ fetch: async () => new Response(body) })('synthetic-private', signal()), redacted);
    assert.equal(cancelled, 1);
});

test('a finite deadline covers stalled headers and stalled bodies even when fetch/cancel ignore abort', { timeout: 2000 }, async () => {
    let headersSignal, bodySignal, cancelled = 0;
    const before = performance.now();
    await assert.rejects(createApiKeyVerifier({ timeoutMs: 20, fetch: async (_url, init) => {
        headersSignal = init.signal;
        return new Promise(() => {});
    } })('synthetic-private', signal()), redacted);
    assert.equal(headersSignal.aborted, true);
    await assert.rejects(createApiKeyVerifier({ timeoutMs: 20, fetch: async (_url, init) => {
        bodySignal = init.signal;
        return new Response(new ReadableStream({ cancel() { cancelled++; return new Promise(() => {}); } }));
    } })('synthetic-private', signal()), redacted);
    assert.equal(bodySignal.aborted, true);
    assert.equal(cancelled, 1);
    assert.ok(performance.now() - before < 1000);
});

test('a delayed response cannot succeed after its deadline and its late body is cancelled', { timeout: 2000 }, async () => {
    const release = deferred();
    let cancelled = 0;
    const pending = createApiKeyVerifier({ timeoutMs: 20, fetch: async () => release.promise })('synthetic-private', signal());
    await assert.rejects(pending, redacted);
    release.resolve(new Response(new ReadableStream({ cancel() { cancelled++; } })));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(cancelled, 1);
});

test('the deadline is checked after synchronous parsing even before the timer can fire', async t => {
    const body = JSON.stringify(envelope());
    const parse = JSON.parse;
    t.mock.method(JSON, 'parse', (...args) => {
        const until = performance.now() + 25;
        while (performance.now() < until) { /* Simulate parsing that consumes the remaining deadline. */ }
        return parse(...args);
    });
    await assert.rejects(createApiKeyVerifier({ timeoutMs: 15, fetch: async () => new Response(body) })
        ('synthetic-private', signal()), redacted);
});

test('abort before, during headers, during body and immediately after fetch cannot authenticate', { timeout: 2000 }, async () => {
    const pre = new AbortController();
    pre.abort(new Error('synthetic-private'));
    let calls = 0;
    await assert.rejects(createApiKeyVerifier({ fetch: async () => { calls++; return accepted(); } })('synthetic-private', pre.signal), redacted);
    assert.equal(calls, 0);
    for (const phase of ['headers', 'body', 'after']) {
        const controller = new AbortController(), started = deferred();
        let forwarded, cancelled = 0;
        const verify = createApiKeyVerifier({ fetch: async (_url, init) => {
            forwarded = init.signal;
            if (phase === 'after') { controller.abort(new Error('synthetic-private')); return accepted(); }
            started.resolve();
            return phase === 'headers' ? new Promise(() => {})
                : new Response(new ReadableStream({ cancel() { cancelled++; return new Promise(() => {}); } }));
        } });
        const pending = verify('synthetic-private', controller.signal);
        if (phase !== 'after') { await started.promise; await Promise.resolve(); controller.abort(new Error('synthetic-private')); }
        await assert.rejects(pending, redacted);
        assert.equal(forwarded.aborted, true);
        if (phase === 'body') assert.equal(cancelled, 1);
    }
});

test('network/reader errors and fetch rejections have the same constant redacted error without retries', async () => {
    for (const fail of [async () => { throw new Error('synthetic-private https://private.test x-api-key: private', { cause: 'private' }); },
        async () => new Response(new ReadableStream({ start(controller) { controller.error(new Error('synthetic-private body')); } }))]) {
        let calls = 0;
        await assert.rejects(createApiKeyVerifier({ fetch: async (...args) => { calls++; return fail(...args); } })('synthetic-private', signal()), redacted);
        assert.equal(calls, 1);
    }
});

test('construction eagerly rejects invalid origins, fetch functions and finite bound configuration without echoing values', () => {
    for (const baseURL of ['not a URL private', 'http://private.test', 'ftp://localhost', 'https://user:private@api.nstdata.io',
        'https://api.nstdata.io/private', 'https://api.nstdata.io/?private', 'https://api.nstdata.io/#private',
        'https://api.nstdata.io/?', 'https://api.nstdata.io/#', ' https://api.nstdata.io', null, {}, 1]) {
        assert.throws(() => createApiKeyVerifier({ baseURL }), { message: 'Invalid API key verifier configuration' });
    }
    for (const options of [null, [], { fetch: null }, { fetch: true }, { fetch: {} }, ...[0, -1, 1.5, Infinity, NaN, '20', null,
        Number.MAX_SAFE_INTEGER + 1].flatMap(value => [{ timeoutMs: value }, { maxResponseBytes: value }]), { timeoutMs: 2_147_483_648 }]) {
        assert.throws(() => createApiKeyVerifier(options), { message: 'Invalid API key verifier configuration' });
    }
});

test('trusted origins and each factory options/fetch are snapshotted and never read from request headers', async t => {
    const urls = [];
    for (const baseURL of ['https://trusted.fixture.test:8443', 'http://localhost:1234', 'http://127.0.0.1:1234', 'http://[::1]:1234']) {
        assert.equal(await createApiKeyVerifier({ baseURL, fetch: async url => { urls.push(url); return accepted(); } })('synthetic-key', signal()), true);
        assert.equal(urls.at(-1), `${new URL(baseURL).origin}/api/v1/api/user/info`);
    }
    const original = async url => { urls.push(url); return accepted(); };
    const nativeFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = nativeFetch; });
    globalThis.fetch = original;
    const options = { baseURL: 'https://trusted.fixture.test', timeoutMs: 500, maxResponseBytes: 16_384 };
    const verify = createApiKeyVerifier(options);
    Object.assign(options, { baseURL: 'https://private.test', timeoutMs: 1, maxResponseBytes: 1,
        fetch: async () => { throw new Error('must not be used'); } });
    globalThis.fetch = async () => { throw new Error('must not be used'); };
    assert.equal(await verify('synthetic-key', signal()), true);
    assert.equal(urls.at(-1), 'https://trusted.fixture.test/api/v1/api/user/info');
});

test('concurrent A/B attempts isolate keys, bodies and abort signals without caching', async () => {
    const arrived = deferred(), release = deferred(), requests = [];
    const a = new AbortController();
    const verify = createApiKeyVerifier({ fetch: async (url, init) => {
        requests.push({ url, init });
        if (init.headers['x-api-key'] === 'synthetic-A') { arrived.resolve(); await release.promise; }
        return accepted();
    } });
    const pendingA = verify('synthetic-A', a.signal);
    await arrived.promise;
    assert.equal(await verify('synthetic-B', signal()), true);
    a.abort(new Error('synthetic-private'));
    await assert.rejects(pendingA, redacted);
    release.resolve();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(requests.map(({ init }) => init.headers), [{ 'x-api-key': 'synthetic-A' }, { 'x-api-key': 'synthetic-B' }]);
    assert.notEqual(requests[0].init.headers, requests[1].init.headers);
    assert.notEqual(requests[0].init.signal, requests[1].init.signal);
});

test('native fetch rejects redirects and never sends the key to the redirect destination', { timeout: 2000 }, async t => {
    const requests = [];
    const fixture = http.createServer((request, response) => {
        requests.push({ path: request.url, headers: request.headers });
        if (request.url === '/api/v1/api/user/info') { response.writeHead(302, { Location: '/private-redirect' }); response.end(); }
        else { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(envelope())); }
    });
    fixture.listen(0, '127.0.0.1');
    await once(fixture, 'listening');
    t.after(() => { fixture.closeAllConnections(); fixture.close(); });
    const verify = createApiKeyVerifier({ baseURL: `http://127.0.0.1:${fixture.address().port}` });
    await assert.rejects(verify('synthetic-private', signal()), redacted);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].path, '/api/v1/api/user/info');
    assert.equal(requests[0].headers['x-api-key'], 'synthetic-private');
    assert.equal(requests[0].headers.authorization, undefined);
    assert.equal(requests[0].headers['x-team-id'], undefined);
});

test('even an injected fetch cannot authenticate a followed redirect or an unexpected response URL', async () => {
    for (const fields of [{ redirected: true }, { url: 'https://private.test/api/v1/api/user/info' }]) {
        const response = accepted();
        for (const [name, value] of Object.entries(fields)) Object.defineProperty(response, name, { value });
        await assert.rejects(createApiKeyVerifier({ fetch: async () => response })('synthetic-private', signal()), redacted);
    }
});
