import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { isolatedRedis } from './redis-fixture.mjs';
import { remoteCli } from '../helpers.mjs';

const executable = pathToFileURL(remoteCli);
const upstream = 'https://remote-integration.invalid';
const keys = { A: 'synthetic-upstream-A', B: 'synthetic-upstream-B', bad: 'synthetic-rejected', invalid: 'synthetic-malformed', timeout: 'synthetic-timeout', abort: 'synthetic-abort' };
const keyLabels = new Map(Object.entries(keys).map(([label, value]) => [value, label]));

for (const mcpPath of ['/mcp', '/crawl']) test(`actual Remote consent, OAuth and MCP remain bound to live Redis authorization at ${mcpPath}`, { timeout: 20_000 }, async t => {
    let origin, application, startedAbort;
    const origins = [], extraHosts = [];
    const abortStarted = new Promise(resolve => { startedAbort = resolve; });
    const upstreamCalls = [], business = [], aborted = [];
    const redis = await isolatedRedis(t, { allowedOrigins: () => origins, virtualFetch: async (request, url) => {
        if (url.origin !== upstream) return undefined;
        assert(request.method === 'GET' && !url.search && !request.headers.has('authorization'));
        const label = keyLabels.get(request.headers.get('x-api-key'));
        assert(label, 'only fixture keys may reach the virtual upstream');
        if (url.pathname === '/api/v1/api/user/info') {
            upstreamCalls.push(label);
            if (label === 'bad') return new Response(null, { status: 401 });
            if (label === 'invalid') return Response.json({ code: 200, err: false, msg: 'SUCCESS', data: {} });
            if (label === 'timeout' || label === 'abort') return new Promise((_resolve, reject) => {
                request.signal.addEventListener('abort', () => { aborted.push(label); reject(new Error('fixture stopped')); }, { once: true });
                if (label === 'abort') startedAbort();
            });
            return Response.json({ code: 200, err: false, msg: 'SUCCESS', data: { email: `${label}@example.test`, balance: 1, referralBalance: 0 } });
        }
        assert(url.pathname === `/api/v1/crawl/existing-${label}` && ['A', 'B'].includes(label));
        business.push(label);
        return Response.json({ code: 200, err: false, msg: 'SUCCESS', data: { status: 'processing', pending: label === 'A' ? 1 : 2 } });
    } });
    const { createRemoteHandler } = await import(new URL('./remote-handler.js', executable));
    const { createApiKeyVerifier } = await import(new URL('./api-key-verifier.js', executable));
    const { createRedisCredentialStore } = await import(new URL('./redis/credential-store.js', executable));
    const { Client, StreamableHTTPClientTransport } = await import('@modelcontextprotocol/client');
    const server = http.createServer((request, response) => { void application.handle(request, response); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${server.address().port}`;
    origins.push(origin);
    const resource = `${origin}${mcpPath}`, alternatePath = mcpPath === '/mcp' ? '/crawl' : '/mcp';
    const clients = ['A', 'B'].map(label => ({ clientId: `client-${label}`, name: label === 'A' ? 'Client <A> & Team' : 'Client B', clientSecret: `synthetic-confidential-client-secret-${label}`, redirectUris: [`${origin}/callback/${label}`] }));
    clients.push({ clientId: 'client-form-post', clientSecret: 'synthetic-confidential-form-post-secret', redirectUris: ['https://configured-callback.invalid/oauth/callback'] });
    const authorizations = [], grantWrites = new Set(), mcpClients = [];
    t.after(async () => {
        for (const client of mcpClients) await client.close().catch(() => {});
        for (const host of extraHosts) { await host.application?.close(); host.server.closeAllConnections(); await new Promise(resolve => host.server.close(resolve)); }
        await application?.close();
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
    });
    let verifies = 0, round = 0;
    const store = { namespace: `remote_${randomBytes(8).toString('hex')}`, maxTtlSeconds: 300, command: async args => {
        // Observe real Grant creation without substituting provider or storage behavior.
        if (args[0] === 'EVAL' && args[1].includes("redis.call('HSET', key, 'payload'") && args[3].includes(':record:R3JhbnQ:')) grantWrites.add(args[3]);
        return (round++ % 2 ? redis.command2 : redis.command)(args);
    } };
    const actualCredentials = createRedisCredentialStore({ ...store, encryptionKeys: { fixture: randomBytes(32) }, currentKeyId: 'fixture', fingerprintKey: randomBytes(32) });
    const credentials = { ...actualCredentials, async authorize(token) { const binding = await actualCredentials.authorize(token); authorizations.push(binding); return binding; } };
    const verifier = createApiKeyVerifier({ baseURL: upstream, timeoutMs: 500 });
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwk = { ...privateKey.export({ format: 'jwk' }), kid: 'fixture', use: 'sig', alg: 'RS256' };
    const handlerOptions = { issuerUrl: origin, resourceUrl: resource, clients, cookieKeys: ['synthetic-cookie-signing-key-20261106'], jwks: { keys: [jwk] }, store, credentials,
        verifyApiKey: (token, signal) => { verifies++; return verifier(token, signal); }, allowedOrigins: [origin], crawl: { baseURL: upstream, httpTimeoutMs: 1000 },
        maxRequestBodyBytes: 8192, maxFormBodyBytes: 4096, requestTimeoutMs: 2000, ttl: { AccessToken: 60, AuthorizationCode: 60, RefreshToken: 180, Grant: 240, Session: 240, Interaction: 120 } };
    application = createRemoteHandler(handlerOptions);
    const metadata = await (await fetch(`${origin}/.well-known/openid-configuration`)).json();
    assert.equal(metadata.issuer, origin);
    const snapshot = () => [verifies, authorizations.length, grantWrites.size, upstreamCalls.length];
    const noKey = value => assert(Object.values(keys).every(key => !String(value).includes(key)), 'responses and redirects never contain an upstream key');
    function browser() {
        const cookies = new Map();
        return { cookies, async fetch(url, options = {}) {
            const headers = new Headers(options.headers);
            if (cookies.size) headers.set('cookie', [...cookies].map(([name, value]) => `${name}=${value}`).join('; '));
            const response = await fetch(url, { ...options, headers, redirect: 'manual' });
            for (const item of response.headers.getSetCookie()) {
                const pair = item.split(';')[0], split = pair.indexOf('=');
                if (/max-age=0(?:;|$)/i.test(item)) cookies.delete(pair.slice(0, split));
                else cookies.set(pair.slice(0, split), pair.slice(split + 1));
            }
            noKey(response.headers.get('location'));
            return response;
        } };
    }
    async function begin(client = clients[0], page = browser(), parameters = {}, target = { origin, metadata, resource }) {
        const verifier = randomBytes(32).toString('base64url'), state = randomBytes(12).toString('hex');
        const response = await page.fetch(`${target.metadata.authorization_endpoint}?${new URLSearchParams({ client_id: client.clientId, redirect_uri: client.redirectUris[0], response_type: 'code', scope: 'crawl:use', resource: target.resource, state, code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url'), ...parameters })}`);
        const url = new URL(response.headers.get('location'), target.origin);
        assert(url.origin === target.origin && url.pathname.startsWith('/oauth/interaction/'));
        const form = await page.fetch(url), html = await form.text(); noKey(html);
        if (client.name === 'Client <A> & Team') assert(html.includes('Client &lt;A&gt; &amp; Team') && !html.includes(client.name), 'configured client display name is escaped');
        assert(form.status === 200 && /name="apiToken" type="password"/.test(html) && !/name="apiToken"[^>]*value=/.test(html));
        assert(form.headers.getSetCookie().some(cookie => cookie.startsWith('nstdata_oauth_csrf=') && cookie.includes('HttpOnly') && cookie.includes('SameSite=Strict') && cookie.includes(`Path=${url.pathname};`)));
        const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1]; assert(csrf);
        return { ...target, page, client, verifier, state, url, csrf };
    }
    const submit = (flow, fields = {}, headers = {}) => flow.page.fetch(flow.url, { method: 'POST', headers: { origin: flow.origin, 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams({ csrf: flow.csrf, apiToken: keys.A, decision: 'allow', ...fields }) });
    function nativePost(flow, headers) {
        return new Promise((resolve, reject) => {
            const request = http.request({ host: '127.0.0.1', port: new URL(origin).port, path: flow.url.pathname, method: 'POST', agent: false,
                headers: { origin, 'content-type': 'application/x-www-form-urlencoded', cookie: [...flow.page.cookies].map(([name, value]) => `${name}=${value}`).join('; '), ...headers } }, response => {
                response.resume(); response.once('end', () => resolve({ status: response.statusCode })); response.once('error', reject);
            });
            request.once('error', reject);
            request.end(new URLSearchParams({ csrf: flow.csrf, apiToken: keys.A, decision: 'allow' }).toString());
        });
    }
    async function authorize(label, client, page, parameters, target) {
        const flow = await begin(client, page, parameters, target);
        let internalAutoForms = 0;
        let response = await submit(flow, { apiToken: keys[label] });
        for (let budget = 0; budget < 6; budget++) {
            if (response.status === 200) {
                const html = await response.text(), action = /<form[^>]+action="([^"]+)"/.exec(html)?.[1], script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1]; noKey(html);
                const next = new URL(action, flow.origin), policy = response.headers.get('content-security-policy') ?? '';
                assert(next.origin === flow.origin && next.pathname === '/session/end/confirm' && script);
                assert((policy.split(';').find(value => value.trim().startsWith('script-src ')) ?? '').includes(`'sha256-${createHash('sha256').update(script).digest('base64')}'`));
                const fields = new URLSearchParams([...html.matchAll(/<input[^>]*name="([^"]+)"[^>]*value="([^"]*)"/g)].map(match => [match[1], match[2]]));
                assert(fields.size === 2 && fields.get('xsrf') && fields.get('logout') === 'yes');
                response = await flow.page.fetch(next, { method: 'POST', headers: { origin: flow.origin, 'content-type': 'application/x-www-form-urlencoded' }, body: fields }); internalAutoForms++; continue;
            }
            assert(response.status === 303 || response.status === 302);
            const next = new URL(response.headers.get('location'), flow.origin); noKey(next);
            if (next.pathname === new URL(flow.client.redirectUris[0]).pathname) {
                assert(next.searchParams.get('state') === flow.state && next.searchParams.get('iss') === flow.origin);
                const tokenResponse = await fetch(flow.metadata.token_endpoint, { method: 'POST', headers: { authorization: 'Basic ' + Buffer.from(`${flow.client.clientId}:${flow.client.clientSecret}`).toString('base64'), 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code: next.searchParams.get('code'), code_verifier: flow.verifier, redirect_uri: flow.client.redirectUris[0], resource: flow.resource }) });
                const token = await tokenResponse.json(); noKey(JSON.stringify(token));
                assert(tokenResponse.status === 200 && token.access_token && token.refresh_token && !token.id_token,
                    `token exchange status=${tokenResponse.status} error=${token.error ?? 'none'} access=${!!token.access_token} refresh=${!!token.refresh_token} id=${!!token.id_token}`);
                return { token, binding: authorizations.at(-1), page: flow.page, internalAutoForms };
            }
            response = await flow.page.fetch(next);
        }
        assert.fail('bounded authorization redirect budget');
    }
    async function denyMcp(token, status) {
        const before = business.length, response = await fetch(resource, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'tools/call', params: { name: 'nstdata_crawl_status', arguments: { crawlId: 'existing-A' } } }) });
        await response.arrayBuffer(); assert.equal(response.status, status); assert.equal(business.length, before);
    }

    let a, b;
    await t.test('unauthenticated Node MCP request preserves its Bearer discovery challenge', async () => {
        const before = snapshot(), response = await fetch(resource, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
        const metadataUrl = response.headers.get('www-authenticate')?.match(/resource_metadata="([^"]+)"/)?.[1];
        await response.arrayBuffer(); assert.equal(response.status, 401); assert(metadataUrl);
        assert.equal(metadataUrl, `${origin}/.well-known/oauth-protected-resource${mcpPath}`);
        const protectedMetadata = await (await fetch(metadataUrl)).json();
        assert(protectedMetadata.resource === resource && JSON.stringify(protectedMetadata.authorization_servers) === JSON.stringify([origin]));
        assert.deepEqual(snapshot(), before);
    });
    await t.test('only the canonical MCP path and its resource discovery are available', async () => {
        const before = snapshot();
        for (const pathname of [alternatePath, `${mcpPath}/`, `/.well-known/oauth-protected-resource${alternatePath}`]) {
            for (const method of ['GET', 'POST']) {
                const response = await fetch(origin + pathname, { method, redirect: 'manual' });
                await response.arrayBuffer();
                assert.equal(response.status, 404, `${method} ${pathname}`);
                assert.equal(response.headers.has('location'), false);
            }
        }
        assert.deepEqual(snapshot(), before);
    });
    await t.test('two actual authorize/form/PKCE flows isolate fixed clients and MCP upstream credentials', async () => {
        a = await authorize('A', clients[0]); b = await authorize('B', clients[1]);
        assert(a.binding.id !== b.binding.id && a.token.access_token !== b.token.access_token);
        const refreshResponse = await fetch(metadata.token_endpoint, { method: 'POST', headers: { authorization: 'Basic ' + Buffer.from(`${clients[1].clientId}:${clients[1].clientSecret}`).toString('base64'), 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: b.token.refresh_token, resource }) });
        const refreshed = await refreshResponse.json(); noKey(JSON.stringify(refreshed));
        assert(refreshResponse.status === 200 && refreshed.access_token && refreshed.refresh_token && refreshed.refresh_token !== b.token.refresh_token && !refreshed.id_token, 'ordinary OAuth refresh rotates without an OIDC prompt');
        b.token = refreshed;
        const connected = await Promise.all([a, b].map(async ({ token }) => {
            const client = new Client({ name: 'remote-integration', version: '1.0.0' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
            mcpClients.push(client);
            await client.connect(new StreamableHTTPClientTransport(new URL(resource), { requestInit: { headers: { authorization: `Bearer ${token.access_token}` } } }));
            assert.equal((await client.listTools()).tools.length, 6); return client;
        }));
        const responses = await Promise.all(connected.map((client, index) => client.callTool({ name: 'nstdata_crawl_status', arguments: { crawlId: `existing-${index ? 'B' : 'A'}` } })));
        assert(responses[0].structuredContent?.pending === 1 && responses[1].structuredContent?.pending === 2);
        assert.deepEqual(business.sort(), ['A', 'B']);
    });
    await t.test('an issued access token cannot authorize a different canonical resource path', async () => {
        const previous = application;
        const migrated = createRemoteHandler({ ...handlerOptions, resourceUrl: origin + alternatePath });
        const before = snapshot(), beforeBusiness = business.length;
        application = migrated;
        try {
            const response = await fetch(origin + alternatePath, { method: 'POST', headers: {
                authorization: `Bearer ${a.token.access_token}`, 'content-type': 'application/json',
                accept: 'application/json, text/event-stream',
            }, body: JSON.stringify({ jsonrpc: '2.0', id: 77, method: 'tools/list' }) });
            assert.equal(response.status, 401);
            assert.match(response.headers.get('www-authenticate'), /error="invalid_token"/);
            assert(response.headers.get('www-authenticate').includes(`resource_metadata="${origin}/.well-known/oauth-protected-resource${alternatePath}"`));
            await response.arrayBuffer();
            assert.equal(business.length, beforeBusiness);
            assert.deepEqual(snapshot(), before);
        } finally { application = previous; await migrated.close(); }
    });
    await t.test('unsupported OAuth scope is denied before key validation or authorization writes', async () => {
        const before = snapshot(), page = browser(), response = await page.fetch(`${metadata.authorization_endpoint}?${new URLSearchParams({ client_id: clients[0].clientId, redirect_uri: clients[0].redirectUris[0], response_type: 'code', scope: 'proxy:use', resource, state: 'unsupported-scope', code_challenge_method: 'S256', code_challenge: createHash('sha256').update(randomBytes(32)).digest('base64url') })}`);
        const location = response.headers.get('location'), body = await response.text(); noKey(body); noKey(location);
        const next = location ? new URL(location, origin) : undefined;
        if (next?.pathname.startsWith('/oauth/interaction/')) {
            assert.equal(next.origin, origin);
            const denied = await page.fetch(next), error = await denied.json();
            assert.equal(denied.status, 400); assert.equal(error.error, 'Invalid authorization request');
        } else assert.equal(next ? next.searchParams.get('error') : JSON.parse(body).error, 'invalid_scope');
        assert.deepEqual(snapshot(), before);
    });
    await t.test('real form_post callback has usable CSP without browsing its configured external origin', async () => {
        const flow = await begin(clients[2], browser(), { response_mode: 'form_post' });
        let response = await submit(flow);
        for (let redirects = 0; response.status >= 300 && response.status < 400 && redirects < 6; redirects++) {
            const next = new URL(response.headers.get('location'), origin);
            assert.equal(next.origin, origin); response = await flow.page.fetch(next);
        }
        const html = await response.text(), policy = response.headers.get('content-security-policy') ?? ''; noKey(html);
        const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1], action = /<form[^>]+action="([^"]+)"/.exec(html)?.[1];
        assert(response.status === 200 && script && action === clients[2].redirectUris[0]);
        const scriptDirective = policy.split(';').find(value => value.trim().startsWith('script-src ')) ?? '';
        const formDirective = policy.split(';').find(value => value.trim().startsWith('form-action ')) ?? '';
        assert(scriptDirective.includes(`'sha256-${createHash('sha256').update(script).digest('base64')}'`) && !scriptDirective.includes('unsafe-inline'));
        assert(formDirective.includes(new URL(action).origin) && /name="code"/.test(html) && html.includes(`value="${flow.state}"`));
    });
    await t.test('CSRF, cookie binding and explicit cancel cannot create credentials or Grants', async () => {
        for (const fields of [{ csrf: '' }, { csrf: 'wrong' }, { decision: '' }]) {
            const flow = await begin(), before = snapshot(), response = await submit(flow, fields); await response.arrayBuffer();
            assert.equal(response.status, 403); assert.deepEqual(snapshot(), before);
        }
        const missingCookie = await begin(), beforeCookie = snapshot();
        missingCookie.page.cookies.delete('nstdata_oauth_csrf');
        const withoutCookie = await submit(missingCookie); await withoutCookie.arrayBuffer();
        assert.equal(withoutCookie.status, 403); assert.deepEqual(snapshot(), beforeCookie);
        const first = await begin(), second = await begin(), beforeReplay = snapshot();
        second.page.cookies.set('nstdata_oauth_csrf', first.csrf);
        const replay = await submit(second, { csrf: first.csrf }); await replay.arrayBuffer();
        assert.equal(replay.status, 403); assert.deepEqual(snapshot(), beforeReplay);
        const cancelled = await begin(), beforeCancel = snapshot(), response = await submit(cancelled, { decision: 'deny', apiToken: '' });
        const resumed = await cancelled.page.fetch(new URL(response.headers.get('location'), origin));
        assert(new URL(resumed.headers.get('location'), origin).searchParams.get('error') === 'access_denied');
        await resumed.arrayBuffer(); assert.deepEqual(snapshot(), beforeCancel);
    });
    await t.test('concurrent duplicate consent validates and creates exactly one binding and Grant', async () => {
        const flow = await begin(), before = snapshot(), responses = await Promise.all([submit(flow), submit(flow)]);
        for (const response of responses) await response.arrayBuffer();
        assert.deepEqual(responses.map(response => response.status).sort(), [303, 403]);
        assert.deepEqual(snapshot(), before.map(value => value + 1));
    });
    await t.test('preflight, bad credentials, malformed response and timeout fail before credential/Grant writes', async () => {
        const hostFlow = await begin(), beforeHost = snapshot(), wrongHost = await nativePost(hostFlow, { host: 'attacker.invalid' });
        assert.equal(wrongHost.status, 400); assert.deepEqual(snapshot(), beforeHost);
        for (const headers of [{ origin: 'https://attacker.invalid' }, { 'content-type': 'application/json' }, { 'x-forwarded-host': 'attacker.invalid' }]) {
            const flow = await begin(), before = snapshot(), response = await submit(flow, {}, headers); await response.arrayBuffer();
            assert(response.status >= 400); assert.deepEqual(snapshot(), before);
        }
        const oversized = await begin(), beforeOversized = snapshot(), tooLarge = await submit(oversized, { apiToken: 'x'.repeat(5000) });
        await tooLarge.arrayBuffer(); assert.equal(tooLarge.status, 413); assert.deepEqual(snapshot(), beforeOversized);
        for (const [label, status] of [['bad', 401], ['invalid', 503], ['timeout', 503]]) {
            const flow = await begin(), before = snapshot(), response = await submit(flow, { apiToken: keys[label] }), html = await response.text(); noKey(html);
            assert.equal(response.status, status); assert.equal(authorizations.length, before[1]); assert.equal(grantWrites.size, before[2]);
        }
    });
    await t.test('actual HTTP disconnect aborts live verification before any binding or Grant', async () => {
        const flow = await begin(), before = snapshot(), cookie = [...flow.page.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
        const request = http.request({ host: '127.0.0.1', port: new URL(origin).port, path: flow.url.pathname, method: 'POST', headers: { origin, cookie, 'content-type': 'application/x-www-form-urlencoded' } });
        const disconnected = new Promise(resolve => request.once('error', resolve));
        request.end(new URLSearchParams({ csrf: flow.csrf, apiToken: keys.abort, decision: 'allow' }).toString());
        await abortStarted; const stoppedAt = performance.now(); request.destroy(new Error('fixture disconnect')); await disconnected;
        for (let count = 0; count < 20 && !aborted.includes('abort'); count++) await delay(10);
        assert(aborted.includes('abort') && performance.now() - stoppedAt < 250, 'disconnect must abort before the 500ms verifier deadline');
        assert.equal(authorizations.length, before[1]); assert.equal(grantWrites.size, before[2]);
    });
    await t.test('native AS chunked limits, timeout and close prevent late refresh dispatch', async () => {
        const host = { application: undefined, server: http.createServer((request, response) => { void host.application.handle(request, response); }) };
        extraHosts.push(host);
        await new Promise(resolve => host.server.listen(0, '127.0.0.1', resolve));
        const nativeOrigin = `http://127.0.0.1:${host.server.address().port}`; origins.push(nativeOrigin);
        let nativeCommands = 0, delayNextRecoveryCommand = false;
        const nativeStore = { ...store, namespace: `${store.namespace}_native`, command: async args => {
            nativeCommands++;
            if (delayNextRecoveryCommand) {
                delayNextRecoveryCommand = false;
                // Normal refresh storage may take longer than the interrupted request's deadline.
                await delay(200);
            }
            return redis.command(args);
        } };
        const nativeActualCredentials = createRedisCredentialStore({ ...nativeStore, encryptionKeys: { fixture: randomBytes(32) }, currentKeyId: 'fixture', fingerprintKey: randomBytes(32) });
        const nativeCredentials = { ...nativeActualCredentials, async authorize(token) { const binding = await nativeActualCredentials.authorize(token); authorizations.push(binding); return binding; } };
        const nativeClient = { ...clients[0], redirectUris: [`${nativeOrigin}/callback/A`] };
        const nativeOptions = { ...handlerOptions, issuerUrl: nativeOrigin, resourceUrl: `${nativeOrigin}${mcpPath}`, clients: [nativeClient], store: nativeStore, credentials: nativeCredentials, allowedOrigins: [nativeOrigin] };
        const recoveryApplication = createRemoteHandler(nativeOptions);
        const boundedApplication = createRemoteHandler({ ...nativeOptions, requestTimeoutMs: 150 });
        t.after(async () => { await boundedApplication.close(); await recoveryApplication.close(); });
        host.application = recoveryApplication;
        const nativeMetadata = await (await fetch(`${nativeOrigin}/.well-known/openid-configuration`)).json();
        const target = { origin: nativeOrigin, resource: `${nativeOrigin}${mcpPath}`, metadata: nativeMetadata };
        const granted = await authorize('A', nativeClient, undefined, undefined, target);
        let token = granted.token;
        for (const mode of ['oversize', 'timeout', 'disconnect', 'close']) {
            host.application = boundedApplication;
            const before = nativeCommands, body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: token.refresh_token, resource: target.resource }).toString();
            const received = new Promise(resolve => host.server.once('request', resolve));
            let finished;
            const stopped = new Promise(resolve => { finished = resolve; });
            const request = http.request({ host: '127.0.0.1', port: new URL(nativeOrigin).port, path: '/token', method: 'POST', agent: false, headers: { authorization: 'Basic ' + Buffer.from(`${nativeClient.clientId}:${nativeClient.clientSecret}`).toString('base64'), 'content-type': 'application/x-www-form-urlencoded', 'transfer-encoding': 'chunked' } }, response => { response.resume(); response.once('end', finished); response.once('error', finished); });
            request.on('error', finished);
            request.write(mode === 'oversize' ? 'x'.repeat(9000) : body.slice(0, body.length / 2));
            await received;
            if (mode === 'oversize') request.end();
            if (mode === 'disconnect') request.destroy(new Error('fixture disconnect'));
            if (mode === 'close') await host.application.close();
            await Promise.race([stopped, delay(1000, undefined, { ref: false }).then(() => assert.fail(`native ${mode} did not stop`))]);
            request.end(body.slice(body.length / 2), () => {});
            await delay(25);
            assert.equal(nativeCommands, before, `${mode} must never dispatch provider storage after an incomplete/oversized body`);
            host.application = recoveryApplication;
            if (mode !== 'close') {
                delayNextRecoveryCommand = mode === 'timeout';
                const refreshedResponse = await fetch(nativeMetadata.token_endpoint, { method: 'POST', headers: { authorization: 'Basic ' + Buffer.from(`${nativeClient.clientId}:${nativeClient.clientSecret}`).toString('base64'), 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: token.refresh_token, resource: target.resource }) });
                const refreshed = await refreshedResponse.json();
                assert.equal(refreshedResponse.status, 200, `${mode} recovery failed (${refreshed.error ?? 'no OAuth error'})`);
                assert(refreshed.refresh_token && refreshed.refresh_token !== token.refresh_token, `${mode} must return a rotated refresh token`); token = refreshed;
            }
        }
    });
    await t.test('standard revoke, binding revoke and real Redis outage deny MCP before business', async () => {
        const response = await fetch(metadata.revocation_endpoint, { method: 'POST', headers: { authorization: 'Basic ' + Buffer.from(`${clients[1].clientId}:${clients[1].clientSecret}`).toString('base64'), 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: b.token.refresh_token, token_type_hint: 'refresh_token' }) });
        await response.arrayBuffer(); assert.equal(response.status, 200); await denyMcp(b.token.access_token, 401);
        await actualCredentials.revoke(a.binding.id, a.binding.version); await denyMcp(a.token.access_token, 401);
        const recoveredA = await authorize('A', clients[0], a.page);
        assert(recoveredA.binding.id !== a.binding.id && recoveredA.binding.version === a.binding.version + 1, 'stale browser Grant must re-enter consent and reconnect');
        const switchedB = await authorize('B', clients[1], recoveredA.page);
        assert(switchedB.binding.id !== recoveredA.binding.id && switchedB.internalAutoForms > 0, 'same browser must finish actual provider account-switch confirmation from A to B');
        const switchedA = await authorize('A', clients[0], switchedB.page);
        const forcedB = await authorize('B', clients[0], switchedA.page, { prompt: 'login' });
        assert(forcedB.binding.id === switchedB.binding.id && forcedB.binding.id !== switchedA.binding.id, 'prompt=login must bind the submitted key B');
        await actualCredentials.revoke(forcedB.binding.id, forcedB.binding.version);
        const recoveredB = await authorize('B', clients[0], forcedB.page);
        assert(recoveredB.binding.id !== forcedB.binding.id && recoveredB.binding.version === forcedB.binding.version + 1);
        const live = await authorize('B', clients[1]);
        for (const client of mcpClients) await client.close();
        await redis.stop(); await denyMcp(live.token.access_token, 503);
        assert.equal(business.length, 2);
    });
});
