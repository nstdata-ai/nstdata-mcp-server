import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { cli } from './helpers.mjs';

const { createOAuthHttpHandler } = await import(new URL('./oauth-resource.js', pathToFileURL(cli)));
const { createHttpHandler } = await import(new URL('./http-handler.js', pathToFileURL(cli)));
const sdk = await import(pathToFileURL(createRequire(pathToFileURL(cli)).resolve('@modelcontextprotocol/server')));
const resourceUrl = 'https://mcp.fixture.test/crawl';
const upstream = 'https://upstream.fixture.test';
const metadataUrl = sdk.getOAuthProtectedResourceMetadataUrl(new URL(resourceUrl));
const mirrorUrl = 'https://mcp.fixture.test/.well-known/oauth-authorization-server';
const tools = ['nstdata_crawl_pages', 'nstdata_crawl_read_result', 'nstdata_crawl_scrape',
    'nstdata_crawl_scrape_result', 'nstdata_crawl_start', 'nstdata_crawl_status'];
const metadata = () => ({ issuer: 'https://issuer.fixture.test', authorization_endpoint: 'https://issuer.fixture.test/auth',
    token_endpoint: 'https://issuer.fixture.test/token', response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'], scopes_supported: ['crawl:use'],
    code_challenge_methods_supported: ['S256'] });
const verified = (who = 'A', extra = {}) => ({
    authInfo: { token: `virtual-access-${who}`, clientId: `virtual-client-${who}`, scopes: ['crawl:use'],
        resource: new URL(resourceUrl), expiresAt: Math.floor(Date.now() / 1000) + 600, ...extra },
    identity: { subject: `verified-binding-${who}`, apiToken: `synthetic-upstream-${who}` },
});
const envelope = data => Response.json({ code: 200, err: false, msg: 'SUCCESS', data });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

// This suite uses virtual bindings at the verifier seam, never an issuer or a real account/key.
function guardNetwork(t, respond = () => { throw new Error('Unexpected business request'); }) {
    const requests = [];
    t.mock.method(globalThis, 'fetch', async (input, init) => {
        const request = new Request(input, init);
        assert.equal(new URL(request.url).origin, upstream, 'all external network access is forbidden');
        requests.push(request);
        return respond(request, requests);
    });
    return requests;
}

function handler(t, options = {}) {
    const h = createOAuthHttpHandler({ resourceUrl, allowedOrigins: ['https://client.fixture.test'], oauthMetadata: metadata(),
        verifyCredential: async token => ['virtual-access-A', 'virtual-access-B'].includes(token) ? verified(token.at(-1)) : null,
        crawl: { baseURL: upstream, httpTimeoutMs: 500, maxCrawlPages: 4 }, ...options });
    t.after(() => h.close());
    return h;
}

function post(body = {}, authorization, extra = {}) {
    return new Request(resourceUrl, { method: 'POST', headers: { 'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream', ...(authorization ? { Authorization: authorization } : {}), ...extra },
    body: typeof body === 'string' ? body : JSON.stringify(body) });
}

async function client(t, h, who = 'A', era = 'modern') {
    const c = new Client({ name: 'virtual-oauth-resource-integration', version: '1.0.0' }, {
        versionNegotiation: { mode: era === 'modern' ? { pin: '2026-07-28' } : 'legacy' },
    });
    const transport = new StreamableHTTPClientTransport(new URL(resourceUrl), {
        requestInit: { headers: { Authorization: `Bearer virtual-access-${who}` } },
        fetch: (input, init) => h.fetch(new Request(input, init)),
    });
    t.after(() => c.close());
    await c.connect(transport);
    return c;
}

test('an SDK Bearer challenge leads to path-aware resource metadata and trusted AS metadata without verification or business requests', async t => {
    const requests = guardNetwork(t);
    let calls = 0;
    const h = handler(t, { verifyCredential: async () => { calls++; throw new Error('must not run'); } });
    const request = post('malformed unread JSON');
    const response = await h.fetch(request);
    const expected = await sdk.requireBearerAuth({ verifier: { verifyAccessToken: async () => { throw new Error('must not run'); } },
        expectedResource: new URL(resourceUrl), requiredScopes: ['crawl:use'], resourceMetadataUrl: metadataUrl })(post());
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('www-authenticate'), expected.headers.get('www-authenticate'));
    assert.deepEqual(await response.json(), await expected.json());
    const advertised = response.headers.get('www-authenticate').match(/resource_metadata="([^"]+)"/)[1];
    assert.equal(advertised, metadataUrl);
    const discovery = await h.fetch(new Request(advertised));
    assert.equal(discovery.headers.get('access-control-allow-origin'), '*');
    assert.equal(discovery.headers.get('cache-control'), 'no-store');
    const resource = await discovery.json();
    assert.deepEqual(resource, JSON.parse(JSON.stringify(sdk.buildOAuthProtectedResourceMetadata({ resourceServerUrl: new URL(resourceUrl),
        oauthMetadata: metadata(), scopesSupported: ['crawl:use'] }))));
    assert.deepEqual(resource.authorization_servers, [metadata().issuer]);
    const mirror = await h.fetch(new Request(mirrorUrl));
    assert.deepEqual(await mirror.json(), metadata());
    assert.equal(calls, 0);
    assert.equal(requests.length, 0);
});

test('both discovery routes preserve SDK GET/HEAD/preflight/method behavior without requiring MCP Origin access', async t => {
    const requests = guardNetwork(t);
    const h = handler(t, { verifyCredential: async () => { throw new Error('must not run'); } });
    for (const url of [metadataUrl, mirrorUrl]) {
        for (const method of ['GET', 'HEAD', 'OPTIONS', 'POST']) {
            const response = await h.fetch(new Request(url, { method, headers: {
                Origin: 'https://unlisted-browser.fixture.test', 'Access-Control-Request-Headers': 'authorization, mcp-protocol-version',
            } }));
            const expected = sdk.oauthMetadataResponse(new Request(url, { method, headers: {
                'Access-Control-Request-Headers': 'authorization, mcp-protocol-version',
            } }), { resourceServerUrl: new URL(resourceUrl), oauthMetadata: metadata(), scopesSupported: ['crawl:use'] });
            assert.equal(response.status, expected.status);
            for (const header of ['access-control-allow-origin', 'access-control-allow-headers', 'access-control-allow-methods', 'allow', 'vary']) {
                assert.equal(response.headers.get(header), expected.headers.get(header));
            }
            assert.equal(await response.text(), await expected.text());
        }
    }
    assert.equal(requests.length, 0);
});

test('discovery guards exact routes, URL authority and Host before the SDK path matcher', async t => {
    const requests = guardNetwork(t);
    let calls = 0;
    const h = handler(t, { verifyCredential: async () => { calls++; return verified(); } });
    for (const [url, headers, status] of [
        [metadataUrl.replace('mcp.fixture.test', 'attacker.fixture.test'), {}, 404],
        [`${metadataUrl}?token=private`, {}, 404], [`${metadataUrl}#private`, {}, 404],
        [`${metadataUrl}/`, {}, 404], ['https://mcp.fixture.test/.well-known/oauth-protected-resource', {}, 404],
        [metadataUrl, { Host: 'attacker.fixture.test' }, 403], [metadataUrl, { Host: 'mcp.fixture.test:444' }, 403],
        ['https://mcp.fixture.test/arbitrary', { 'X-Forwarded-Host': 'mcp.fixture.test', 'X-Forwarded-Proto': 'https' }, 404],
    ]) {
        const response = await h.fetch(new Request(url, { headers }));
        assert.equal(response.status, status);
        assert.equal(response.headers.get('cache-control'), 'no-store');
        assert.doesNotMatch(await response.text(), /private|attacker|issuer/);
    }
    const response = await h.fetch(new Request(metadataUrl, { headers: { Host: 'MCP.FIXTURE.TEST', 'X-Forwarded-Host': 'attacker.fixture.test' } }));
    assert.equal(response.status, 200);
    await response.text();
    assert.equal(calls, 0);
    assert.equal(requests.length, 0);
});

test('trusted metadata and allowed origins are snapshotted at construction', async t => {
    const requests = guardNetwork(t);
    const oauthMetadata = metadata(), allowedOrigins = ['https://client.fixture.test'];
    const h = handler(t, { oauthMetadata, allowedOrigins });
    oauthMetadata.issuer = 'https://changed.fixture.test';
    oauthMetadata.token_endpoint = 'https://changed.fixture.test/token';
    oauthMetadata.scopes_supported.push('private:scope');
    allowedOrigins.push('https://changed.fixture.test');
    assert.deepEqual(await (await h.fetch(new Request(mirrorUrl))).json(), metadata());
    const denied = await h.fetch(post({}, 'Bearer virtual-access-A', { Origin: 'https://changed.fixture.test' }));
    assert.equal(denied.status, 403);
    assert.equal(requests.length, 0);
});

test('trusted OAuth URLs require HTTPS except explicit loopback fixtures and reject credentials/query/fragment', async t => {
    guardNetwork(t);
    const bad = ['http://public.fixture.test/path', 'ftp://localhost/path', 'https://user:private@issuer.fixture.test',
        'https://issuer.fixture.test/path?private=yes', 'https://issuer.fixture.test/path#private', 'not a URL'];
    for (const value of bad) {
        for (const options of [{ resourceUrl: value }, { oauthMetadata: { ...metadata(), issuer: value } },
            { oauthMetadata: { ...metadata(), token_endpoint: value } }, { oauthMetadata: { ...metadata(), introspection_endpoint: value } },
            { allowedOrigins: [value] }]) {
            assert.throws(() => handler(t, options), error => !/private/.test(error.message));
        }
    }
    assert.throws(() => handler(t, { verifyCredential: undefined }));
    for (const host of ['localhost', '127.0.0.1', '[::1]']) {
        const issuer = `http://${host}:4567`;
        const h = handler(t, { resourceUrl: `http://${host}:4568/crawl`, allowedOrigins: [`http://${host}:4569`],
            oauthMetadata: { ...metadata(), issuer, authorization_endpoint: `${issuer}/auth`, token_endpoint: `${issuer}/token` } });
        const response = await h.fetch(new Request(`http://${host}:4568/.well-known/oauth-protected-resource/crawl`));
        assert.equal(response.status, 200);
        assert.deepEqual((await response.json()).authorization_servers, [issuer]);
    }
});

test('official SDK enforces expiry, resource and scope while invalid live bindings receive consistent generic challenges', async t => {
    const requests = guardNetwork(t);
    const cases = [
        ['expired', verified('A', { expiresAt: 1 }), 401, 'invalid_token'],
        ['missing-expiry', verified('A', { expiresAt: undefined }), 401, 'invalid_token'],
        ['missing-resource', verified('A', { resource: undefined }), 401, 'invalid_token'],
        ['wrong-resource', verified('A', { resource: new URL('https://another.fixture.test/crawl') }), 401, 'invalid_token'],
        ['missing-scope', verified('A', { scopes: [] }), 403, 'insufficient_scope'],
        ['unknown-token', null, 401, 'invalid_token'], ['revoked-grant', null, 401, 'invalid_token'],
        ['revoked-binding', null, 401, 'invalid_token'], ['old-binding-version', null, 401, 'invalid_token'],
        ['disabled-account', null, 401, 'invalid_token'], ['changed-client', null, 401, 'invalid_token'],
        ['invalid-binding', { ...verified(), identity: { subject: '', apiToken: 'synthetic-private' } }, 401, 'invalid_token'],
    ];
    let generic;
    for (const [token, result, status, error] of cases) {
        const h = handler(t, { verifyCredential: async raw => { assert.equal(raw, token); return result; } });
        const response = await h.fetch(post('bad JSON', `Bearer ${token}`));
        assert.equal(response.status, status, token);
        assert.equal(response.headers.get('cache-control'), 'no-store');
        const challenge = response.headers.get('www-authenticate');
        assert.match(challenge, new RegExp(`error="${error}"`));
        assert.ok(challenge.includes(`resource_metadata="${metadataUrl}"`));
        assert.match(challenge, /scope="crawl:use"/);
        const body = await response.json();
        assert.equal(body.error, error);
        assert.doesNotMatch(JSON.stringify(body), /synthetic-private|virtual-access/);
        if (result === null || token === 'invalid-binding') {
            generic ??= { challenge, body };
            assert.deepEqual({ challenge, body }, generic);
        }
    }
    assert.equal(requests.length, 0);
});

test('absent and malformed bearer credentials never reach verification, JSON parsing or business requests', async t => {
    const requests = guardNetwork(t);
    let calls = 0;
    const h = handler(t, { verifyCredential: async () => { calls++; return verified(); } });
    for (const authorization of [undefined, 'Basic private', 'Bearer', 'Bearer ', 'private']) {
        const response = await h.fetch(post('invalid JSON', authorization));
        assert.equal(response.status, 401);
        assert.match(response.headers.get('www-authenticate'), /resource_metadata=/);
        assert.doesNotMatch(await response.text(), /private|synthetic/);
    }
    assert.equal(calls, 0);
    assert.equal(requests.length, 0);
});

test('verifier/store errors are generic 503 with no challenge or leaked exception, even OAuthError', async t => {
    const requests = guardNetwork(t);
    for (const error of [new Error('virtual-access-private synthetic-upstream-private store password'),
        new sdk.OAuthError(sdk.OAuthErrorCode.InvalidToken, 'virtual-access-private synthetic-upstream-private')]) {
        const h = handler(t, { verifyCredential: async () => { throw error; } });
        const response = await h.fetch(post('invalid JSON', 'Bearer virtual-access-private'));
        assert.equal(response.status, 503);
        assert.equal(response.headers.has('www-authenticate'), false);
        assert.equal(response.headers.get('cache-control'), 'no-store');
        assert.deepEqual(await response.json(), { error: 'Service unavailable' });
    }
    assert.equal(requests.length, 0);
});

test('SDK denial responses cancel unread bodies and the base authenticator rejects successful/redirect responses', { timeout: 10000 }, async t => {
    const requests = guardNetwork(t);
    for (const result of [null, 'throw', new Response('private-success', { status: 200 }), new Response(null, { status: 302 })]) {
        const cancelled = deferred();
        const authenticate = async () => typeof result === 'object' && result !== null ? result : null;
        const h = result instanceof Response ? createHttpHandler({ resourceUrl, allowedOrigins: [], authenticate })
            : handler(t, { verifyCredential: async () => { if (result === 'throw') throw new Error('private'); return null; } });
        t.after(() => h.close());
        const request = new Request(resourceUrl, { method: 'POST', headers: { Authorization: 'Bearer private' },
            body: new ReadableStream({ cancel() { cancelled.resolve(); return new Promise(() => {}); } }, { highWaterMark: 0 }), duplex: 'half' });
        const response = await h.fetch(request);
        assert.equal(response.status, result === null ? 401 : 503);
        await cancelled.promise;
        assert.equal(response.headers.get('cache-control'), 'no-store');
        assert.doesNotMatch(await response.text(), /private/);
    }
    assert.equal(requests.length, 0);
});

for (const era of ['modern', 'legacy']) {
    test(`${era} official HTTP client discovers exactly six Crawl tools with a verified virtual binding`, { timeout: 10000 }, async t => {
        const requests = guardNetwork(t);
        const h = handler(t);
        const c = await client(t, h, 'A', era);
        assert.deepEqual((await c.listTools()).tools.map(tool => tool.name).sort(), tools);
        assert.equal(requests.length, 0);
    });

    test(`${era} concurrent virtual A/B credentials keep independent upstream keys and only read existing status`, { timeout: 10000 }, async t => {
        const arrived = deferred(), release = deferred();
        const requests = guardNetwork(t, async request => {
            assert.equal(request.method, 'GET', 'no task creation is allowed');
            const key = request.headers.get('x-api-key');
            assert.ok(['synthetic-upstream-A', 'synthetic-upstream-B'].includes(key));
            if (key === 'synthetic-upstream-A') { arrived.resolve(); await release.promise; }
            return envelope({ status: 'processing', pending: key === 'synthetic-upstream-A' ? 1 : 2 });
        });
        const h = handler(t);
        const [a, b] = await Promise.all([client(t, h, 'A', era), client(t, h, 'B', era)]);
        const pendingA = a.callTool({ name: 'nstdata_crawl_status', arguments: { crawlId: 'existing-A' } });
        await arrived.promise;
        const resultB = await b.callTool({ name: 'nstdata_crawl_status', arguments: { crawlId: 'existing-B' } });
        release.resolve();
        const resultA = await pendingA;
        assert.equal(resultA.structuredContent.pending, 1);
        assert.equal(resultB.structuredContent.pending, 2);
        assert.deepEqual(requests.map(request => [new URL(request.url).pathname, request.headers.get('x-api-key')]), [
            ['/api/v1/crawl/existing-A', 'synthetic-upstream-A'], ['/api/v1/crawl/existing-B', 'synthetic-upstream-B'],
        ]);
        assert.equal(requests.length, 2, 'no submissions, retries or other business operations');
    });

    test(`${era} a live binding revoke denies the same issued token on the next MCP request`, { timeout: 10000 }, async t => {
        const requests = guardNetwork(t);
        let active = true, verifiedCount = 0;
        const h = handler(t, { verifyCredential: async () => { verifiedCount++; return active ? verified() : null; } });
        const c = await client(t, h, 'A', era);
        assert.deepEqual((await c.listTools()).tools.map(tool => tool.name).sort(), tools);
        const before = verifiedCount;
        active = false;
        await assert.rejects(c.listTools());
        assert.ok(verifiedCount > before);
        const denied = await h.fetch(post({}, 'Bearer virtual-access-A'));
        assert.equal(denied.status, 401);
        assert.equal((await denied.json()).error, 'invalid_token');
        assert.equal(requests.length, 0);
    });
}

test('close aborts the per-request verifier signal and makes MCP plus metadata unavailable', { timeout: 10000 }, async t => {
    const requests = guardNetwork(t), started = deferred(), release = deferred();
    let signal;
    const h = handler(t, { verifyCredential: async (_token, currentSignal) => {
        signal = currentSignal;
        started.resolve();
        await release.promise;
        return verified();
    } });
    const pending = h.fetch(post({}, 'Bearer virtual-access-A'));
    await started.promise;
    await h.close();
    assert.equal(signal.aborted, true);
    release.resolve();
    assert.equal((await pending).status, 503);
    for (const url of [resourceUrl, metadataUrl, mirrorUrl]) {
        const response = await h.fetch(new Request(url));
        assert.equal(response.status, 503);
        assert.equal(response.headers.get('cache-control'), 'no-store');
    }
    assert.equal(requests.length, 0);
});
