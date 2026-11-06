import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { cli } from './helpers.mjs';

const { createHttpHandler } = await import(new URL('./http-handler.js', pathToFileURL(cli)));
const { createServer } = await import(new URL('./server.js', pathToFileURL(cli)));
const { guard } = await import(new URL('./shared/errors.js', pathToFileURL(cli)));

const resourceUrl = 'https://mcp.fixture.test/crawl';
const upstream = 'https://upstream.fixture.test';
const tools = ['nstdata_crawl_pages', 'nstdata_crawl_read_result', 'nstdata_crawl_scrape',
    'nstdata_crawl_scrape_result', 'nstdata_crawl_start', 'nstdata_crawl_status'];
const identity = who => ({ subject: `validated-binding-${who}`, apiToken: `synthetic-key-${who}` });
const envelope = data => Response.json({ code: 200, err: false, msg: 'SUCCESS', data });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

// All product requests terminate here. Unexpected hosts fail before any network operation.
function guardNetwork(t, respond = () => { throw new Error('Unexpected upstream request'); }) {
    const requests = [];
    t.mock.method(globalThis, 'fetch', async (input, init) => {
        const request = new Request(input, init);
        assert.equal(new URL(request.url).origin, upstream, 'external network access is forbidden');
        requests.push(request);
        return respond(request, requests);
    });
    return requests;
}

function handler(t, options = {}) {
    const h = createHttpHandler({ resourceUrl, allowedOrigins: ['https://client.fixture.test'],
        authenticate: async request => {
            const who = request.headers.get('authorization');
            return ['A', 'B'].includes(who) ? identity(who) : null;
        }, crawl: { baseURL: upstream, httpTimeoutMs: 500, maxCrawlPages: 4 }, ...options });
    t.after(() => h.close());
    return h;
}

async function client(t, h, who = 'A', era = 'modern', requestSignal, prepareRequest = request => request) {
    const c = new Client({ name: 'synthetic-http-integration', version: '1.0.0' }, {
        versionNegotiation: { mode: era === 'modern' ? { pin: '2026-07-28' } : 'legacy' },
    });
    const transport = new StreamableHTTPClientTransport(new URL(resourceUrl), {
        requestInit: { headers: { Authorization: who } },
        fetch: async (input, init) => {
            const request = await prepareRequest(new Request(input, init));
            const signal = requestSignal ? AbortSignal.any([request.signal, requestSignal]) : request.signal;
            return h.fetch(new Request(request, { signal }));
        },
    });
    t.after(() => c.close());
    await c.connect(transport);
    return c;
}

function post(body, headers = {}, url = resourceUrl) {
    return new Request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
        body: typeof body === 'string' ? body : JSON.stringify(body) });
}

test('the shared guard honors both HTTP and protocol cancellation, including a pre-aborted HTTP request', { timeout: 10000 }, async t => {
    const requests = guardNetwork(t);
    for (const source of ['pre-aborted HTTP', 'HTTP', 'protocol']) {
        const http = new AbortController(), protocol = new AbortController(), started = deferred();
        if (source === 'pre-aborted HTTP') http.abort();
        const pending = guard({ mcpReq: { signal: protocol.signal }, http: { req: new Request(resourceUrl, { signal: http.signal }) } },
            { httpTimeoutMs: 1000, maxResponseBytes: 1024, maxOutputChars: 1024 }, async options => {
                options.signal.throwIfAborted();
                return new Promise((_resolve, reject) => {
                    options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
                    started.resolve();
                });
            });
        if (source !== 'pre-aborted HTTP') {
            await started.promise;
            (source === 'HTTP' ? http : protocol).abort();
        }
        const result = await pending;
        assert.equal(result.isError, true);
        assert.equal(result.structuredContent.error.code, 'CANCELLED');
    }
    assert.equal(requests.length, 0);
});

for (const era of ['modern', 'legacy']) {
    test(`${era} official HTTP client discovers only the existing six Crawl tools without business requests`, { timeout: 10000 }, async t => {
        const requests = guardNetwork(t);
        const h = handler(t);
        const c = await client(t, h, 'A', era);
        const discovered = (await c.listTools()).tools;
        assert.deepEqual(discovered.map(tool => tool.name).sort(), tools);
        assert.equal(discovered.find(tool => tool.name === 'nstdata_crawl_start').inputSchema.properties.maxPages.maximum, 4);
        assert.equal(requests.length, 0);
    });

    test(`${era} concurrent A/B status requests retain independent validated keys and trusted configuration`, { timeout: 10000 }, async t => {
        const arrived = deferred(), release = deferred();
        const requests = guardNetwork(t, async request => {
            assert.equal(request.method, 'GET', 'this test must never create a task');
            const key = request.headers.get('x-api-key');
            if (key === identity('A').apiToken) { arrived.resolve(); await release.promise; }
            return envelope({ status: 'processing', pending: key === identity('A').apiToken ? 1 : 2 });
        });
        const settings = { baseURL: upstream, httpTimeoutMs: 1000, maxCrawlPages: 4 };
        const h = handler(t, { crawl: settings });
        settings.baseURL = 'https://forbidden.fixture.test';
        settings.maxCrawlPages = 999;
        const [a, b] = await Promise.all([client(t, h, 'A', era), client(t, h, 'B', era)]);
        const pendingA = a.callTool({ name: 'nstdata_crawl_status', arguments: { crawlId: 'existing-A' } });
        await arrived.promise;
        const resultB = await b.callTool({ name: 'nstdata_crawl_status', arguments: { crawlId: 'existing-B' } });
        release.resolve();
        const resultA = await pendingA;
        assert.equal(resultA.structuredContent.pending, 1);
        assert.equal(resultB.structuredContent.pending, 2);
        assert.equal(resultA.structuredContent.crawlId, 'existing-A');
        assert.equal(resultB.structuredContent.crawlId, 'existing-B');
        assert.deepEqual(requests.map(r => [new URL(r.url).pathname, r.headers.get('x-api-key')]), [
            ['/api/v1/crawl/existing-A', identity('A').apiToken],
            ['/api/v1/crawl/existing-B', identity('B').apiToken],
        ]);
        assert.notEqual(requests[0].signal, requests[1].signal);
        for (const c of [a, b]) {
            assert.equal((await c.listTools()).tools.find(tool => tool.name === 'nstdata_crawl_start').inputSchema.properties.maxPages.maximum, 4);
        }
        assert.equal(requests.length, 2, 'no hidden submissions or retries');
    });

    test(`${era} one bounded upstream failure is redacted and leaves the other identity usable`, { timeout: 10000 }, async t => {
        const requests = guardNetwork(t, request => request.headers.get('x-api-key') === identity('A').apiToken
            ? new Response(`${identity('A').apiToken} private upstream body`, { status: 503 })
            : envelope({ status: 'processing', pending: 2 }));
        const h = handler(t);
        const [a, b] = await Promise.all([client(t, h, 'A', era), client(t, h, 'B', era)]);
        const call = c => c.callTool({ name: 'nstdata_crawl_status', arguments: { crawlId: 'existing' } });
        const [failed, successful] = await Promise.all([call(a), call(b)]);
        assert.equal(failed.isError, true);
        assert.equal(failed.structuredContent.error.code, 'UPSTREAM_ERROR');
        assert.equal(failed.structuredContent.error.statusCode, 503);
        assert.equal(successful.structuredContent.pending, 2);
        assert.doesNotMatch(JSON.stringify(failed), /synthetic-key|private upstream/);
        assert.equal(requests.length, 2);
        assert.ok(requests.every(request => request.method === 'GET'));
    });
}

test('missing, invalid and throwing authenticators fail before protocol parsing or upstream calls', { timeout: 10000 }, async t => {
    const requests = guardNetwork(t);
    for (const result of [null, undefined, {}, { subject: '', apiToken: 'secret-key' }, { subject: 'binding', apiToken: ' ' }]) {
        const h = handler(t, { authenticate: async () => result });
        const response = await h.fetch(post('not JSON, secret-caller-token', { Authorization: 'secret-caller-token' }));
        assert.equal(response.status, 401);
        assert.equal(response.headers.get('www-authenticate'), 'Bearer');
        assert.equal(response.headers.get('cache-control'), 'no-store');
        assert.deepEqual(await response.json(), { error: 'Unauthorized' });
    }
    const h = handler(t, { authenticate: async () => { throw new Error('secret-caller-token secret-key'); }, maxRequestBodyBytes: 1 });
    const response = await h.fetch(post('oversized secret-caller-token'));
    assert.equal(response.status, 503, 'verifier failure must precede SDK parsing and remain distinct from an invalid caller');
    assert.equal(response.headers.has('www-authenticate'), false);
    assert.doesNotMatch(await response.text(), /secret-caller-token|secret-key/);
    assert.equal(requests.length, 0);
});

test('exact resource, Host and Origin policy rejects untrusted requests before authentication', { timeout: 10000 }, async t => {
    const requests = guardNetwork(t);
    let authenticated = 0;
    const h = handler(t, { authenticate: async () => { authenticated++; return identity('A'); } });
    for (const [request, expected] of [
        [post({}, {}, `${resourceUrl}/`), 404], [post({}, {}, `${resourceUrl}?access_token=secret`), 404],
        [post({}, {}, 'https://wrong.fixture.test/crawl'), 404], [post({}, { Host: 'wrong.fixture.test' }), 403],
        [post({}, { Host: 'mcp.fixture.test:444' }), 403], [post({}, { Origin: 'null' }), 403],
        [post({}, { Origin: 'https://wrong.fixture.test' }), 403],
        [new Request(resourceUrl, { method: 'PUT' }), 405], [new Request(resourceUrl, { method: 'OPTIONS' }), 405],
    ]) {
        const response = await h.fetch(request);
        assert.equal(response.status, expected);
        assert.doesNotMatch(await response.text(), /secret|wrong\.fixture/);
    }
    assert.equal(authenticated, 0);
    for (const headers of [{}, { Host: 'MCP.FIXTURE.TEST', Origin: 'https://client.fixture.test' }]) {
        const response = await h.fetch(post({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, headers));
        assert.equal(response.status, 200);
        const body = await response.text();
        const rpc = response.headers.get('content-type').includes('text/event-stream')
            ? JSON.parse(body.split('\n').find(line => line.startsWith('data: ')).slice(6)) : JSON.parse(body);
        assert.deepEqual(rpc.result.tools.map(tool => tool.name).sort(), tools);
    }
    assert.equal(authenticated, 2, 'native Fetch needs no explicit Host header');
    assert.equal(requests.length, 0);
});

test('SDK stateless GET/DELETE and body limits remain bounded without creating tasks', { timeout: 10000 }, async t => {
    const requests = guardNetwork(t);
    const h = handler(t, { maxRequestBodyBytes: 256 });
    for (const method of ['GET', 'DELETE']) {
        const response = await h.fetch(new Request(resourceUrl, { method, headers: { Authorization: 'A' } }));
        assert.equal(response.status, 405);
        await response.text();
    }
    for (const extra of [{}, { 'Content-Length': '1' }]) {
        const response = await h.fetch(post('x'.repeat(257), { Authorization: 'A', ...extra }));
        assert.equal(response.status, 413, 'count actual bytes, not just Content-Length');
        assert.doesNotMatch(await response.text(), /synthetic-key/);
    }
    const bytes = new TextEncoder().encode('😀'.repeat(65));
    const response = await h.fetch(new Request(resourceUrl, { method: 'POST', headers: {
        Authorization: 'A', 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
    }, body: new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }), duplex: 'half' }));
    assert.equal(response.status, 413, 'the body bound counts UTF-8 bytes in streamed bodies');
    await response.text();
    assert.equal(requests.length, 0);
});

for (const era of ['modern', 'legacy']) {
    for (const point of ['before connect', 'after connect']) {
        for (const stop of ['request abort', 'handler close']) {
            test(`${era} ${stop} at ${point} cannot start a late upstream operation`, { timeout: 10000 }, async t => {
                const requests = guardNetwork(t, () => envelope({ status: 'processing' }));
                const arrived = deferred(), release = deferred();
                const h = handler(t), controller = new AbortController();
                const c = await client(t, h, 'A', era, controller.signal);
                const probe = createServer({ baseURL: upstream, modules: 'crawl', apiToken: 'synthetic-probe-key' });
                const prototype = Object.getPrototypeOf(probe), connect = prototype.connect;
                await probe.close();
                t.mock.method(prototype, 'connect', async function (transport) {
                    if (point === 'before connect') { arrived.resolve(); await release.promise; }
                    const result = await connect.call(this, transport);
                    if (point === 'after connect') { arrived.resolve(); await release.promise; }
                    return result;
                });
                const pending = c.callTool({ name: 'nstdata_crawl_status', arguments: { crawlId: 'existing' } });
                const settled = pending.then(result => ({ result }), error => ({ error }));
                await arrived.promise;
                if (stop === 'handler close') await h.close();
                else controller.abort();
                release.resolve();
                const outcome = await settled;
                assert.equal(requests.length, 0, 'cancelled handoff must never enter an upstream fetch');
                assert.ok(outcome.error || outcome.result.isError);
                if (outcome.result) assert.equal(outcome.result.structuredContent.error.code, 'CANCELLED');
            });
        }
    }

    for (const stop of ['request abort', 'handler close']) {
        test(`${era} ${stop} cancels an unfinished POST body and cannot dispatch it later`, { timeout: 10000 }, async t => {
            const requests = guardNetwork(t);
            const ingesting = deferred(), cancelled = deferred();
            let source, remainder;
            const h = handler(t), controller = new AbortController();
            const c = await client(t, h, 'A', era, controller.signal, async request => {
                if (request.method !== 'POST') return request;
                const text = await request.clone().text();
                if (JSON.parse(text).method !== 'tools/call') return request;
                remainder = text.slice(1);
                const body = new ReadableStream({
                    start(stream) { source = stream; stream.enqueue(new TextEncoder().encode(text.slice(0, 1))); },
                    pull() { ingesting.resolve(); },
                    cancel() { cancelled.resolve(); return new Promise(() => {}); },
                }, { highWaterMark: 0 });
                return new Request(request, { body, duplex: 'half' });
            });
            const pending = c.callTool({ name: 'nstdata_crawl_status', arguments: { crawlId: 'existing' } });
            const settled = assert.rejects(pending);
            await ingesting.promise;
            if (stop === 'handler close') await h.close();
            else controller.abort();
            // These must complete while the JSON source is still held open.
            await cancelled.promise;
            await settled;
            assert.throws(() => source.enqueue(new TextEncoder().encode(remainder)), TypeError);
            assert.equal(requests.length, 0, 'no post-close/abort upstream dispatch');
        });
    }

    test(`${era} the existing tool deadline aborts one read and permits the next request`, { timeout: 10000 }, async t => {
        const started = deferred(), aborted = deferred();
        const requests = guardNetwork(t, request => {
            if (!request.url.endsWith('/slow')) return envelope({ status: 'processing' });
            return new Promise((_resolve, reject) => {
                request.signal.addEventListener('abort', () => { aborted.resolve(); reject(request.signal.reason); }, { once: true });
                started.resolve();
            });
        });
        const h = handler(t, { crawl: { baseURL: upstream, httpTimeoutMs: 60 } });
        const c = await client(t, h, 'A', era);
        t.mock.timers.enable({ apis: ['setTimeout'] });
        const pending = c.callTool({ name: 'nstdata_crawl_status', arguments: { crawlId: 'slow' } });
        await started.promise;
        t.mock.timers.tick(60);
        await aborted.promise;
        const result = await pending;
        assert.equal(result.isError, true);
        assert.equal(result.structuredContent.error.code, 'TIMEOUT');
        const next = await c.callTool({ name: 'nstdata_crawl_status', arguments: { crawlId: 'next' } });
        assert.notEqual(next.isError, true);
        assert.equal(requests.length, 2);
        assert.ok(requests.every(request => request.method === 'GET'));
    });

    for (const stop of ['request abort', 'handler close']) {
        test(`${era} ${stop} propagates to the bounded upstream read`, { timeout: 10000 }, async t => {
            const started = deferred(), aborted = deferred();
            const requests = guardNetwork(t, request => new Promise((_resolve, reject) => {
                request.signal.addEventListener('abort', () => { aborted.resolve(); reject(request.signal.reason); }, { once: true });
                started.resolve();
            }));
            const h = handler(t, { crawl: { baseURL: upstream, httpTimeoutMs: 2000 } });
            const controller = new AbortController();
            const c = await client(t, h, 'A', era, controller.signal);
            const pending = c.callTool({ name: 'nstdata_crawl_status', arguments: { crawlId: 'existing' } });
            const settled = pending.then(result => ({ result }), error => ({ error }));
            await started.promise;
            if (stop === 'handler close') await h.close();
            else controller.abort();
            await aborted.promise;
            // A disconnected legacy exchange need not produce a terminal RPC response.
            await c.close();
            const outcome = await settled;
            assert.ok(outcome.error || outcome.result.isError);
            assert.equal(requests.length, 1, 'no cancellation retries or task creation');
            assert.equal(requests[0].method, 'GET');
            if (stop === 'handler close') assert.equal((await h.fetch(post({}))).status, 503);
        });
    }
}

test('an oversized streamed body cancels its still-open source before SDK dispatch', { timeout: 10000 }, async t => {
    const requests = guardNetwork(t), cancelled = deferred();
    let source;
    const h = handler(t, { maxRequestBodyBytes: 256 });
    const body = new ReadableStream({
        start(stream) { source = stream; stream.enqueue(new Uint8Array(257)); },
        cancel() { cancelled.resolve(); return new Promise(() => {}); },
    }, { highWaterMark: 0 });
    const response = await h.fetch(new Request(resourceUrl, { method: 'POST', headers: {
        Authorization: 'A', 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
    }, body, duplex: 'half' }));
    assert.equal(response.status, 413);
    await cancelled.promise;
    assert.throws(() => source.enqueue(new Uint8Array(1)), TypeError);
    assert.equal(requests.length, 0);
});

test('null/throw authentication cancels unread input without awaiting untrusted cancellation', { timeout: 10000 }, async t => {
    const requests = guardNetwork(t);
    for (const throws of [false, true]) {
        const cancelled = deferred();
        const h = handler(t, { authenticate: async () => {
            if (throws) throw new Error('synthetic-secret');
            return null;
        } });
        const body = new ReadableStream({
            cancel() { cancelled.resolve(); return new Promise(() => {}); },
        }, { highWaterMark: 0 });
        const response = await h.fetch(new Request(resourceUrl, { method: 'POST', headers: {
            'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
        }, body, duplex: 'half' }));
        assert.equal(response.status, throws ? 503 : 401);
        await cancelled.promise;
        assert.doesNotMatch(await response.text(), /synthetic-secret/);
        await h.close();
    }
    assert.equal(requests.length, 0);
});

test('cancelling a legacy streaming response closes its request and upstream read', { timeout: 10000 }, async t => {
    const started = deferred(), aborted = deferred();
    const requests = guardNetwork(t, request => new Promise((_resolve, reject) => {
        request.signal.addEventListener('abort', () => { aborted.resolve(); reject(request.signal.reason); }, { once: true });
        started.resolve();
    }));
    const h = handler(t);
    const response = await h.fetch(post({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
        name: 'nstdata_crawl_status', arguments: { crawlId: 'existing' },
    } }, { Authorization: 'A' }));
    assert.match(response.headers.get('content-type'), /text\/event-stream/);
    await started.promise;
    await response.body.cancel();
    await aborted.promise;
    assert.equal(requests.length, 1);
});

test('closing during asynchronous authentication aborts its signal and cannot start the core afterwards', { timeout: 10000 }, async t => {
    const requests = guardNetwork(t), started = deferred(), release = deferred();
    let authSignal;
    const h = handler(t, { authenticate: async request => {
        authSignal = request.signal;
        started.resolve();
        await release.promise;
        return identity('A');
    } });
    const pending = h.fetch(post({ jsonrpc: '2.0', id: 1, method: 'tools/list' }));
    await started.promise;
    await h.close();
    assert.equal(authSignal.aborted, true);
    release.resolve();
    const response = await pending;
    assert.equal(response.status, 503);
    assert.equal(requests.length, 0);
});

test('untrusted resource and Origin configuration and a missing authenticator fail closed', () => {
    for (const options of [
        { resourceUrl: 'https://user:password@mcp.fixture.test/crawl' }, { resourceUrl: `${resourceUrl}?token=secret` },
        { resourceUrl: `${resourceUrl}#fragment` }, { allowedOrigins: ['null'] },
        { allowedOrigins: ['https://client.fixture.test/path'] }, { authenticate: undefined }, { maxRequestBodyBytes: 0 },
    ]) {
        assert.throws(() => createHttpHandler({ resourceUrl, allowedOrigins: [], authenticate: async () => null, ...options }));
    }
});
