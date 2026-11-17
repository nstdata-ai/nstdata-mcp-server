import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { syncBuiltinESMExports } from 'node:module';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { isolatedRedis } from './redis-fixture.mjs';
import { remoteCli } from '../helpers.mjs';
import { callbackFromResponse } from '../callback-page.mjs';

const executable = pathToFileURL(remoteCli);
const upstream = 'https://automatic-onboarding.invalid';
const keys = { A: 'synthetic-automatic-key-A', B: 'synthetic-automatic-key-B', rejected: 'synthetic-rejected-key' };

test('automatic Remote onboarding uses public OAuth clients and independent per-request API keys', { timeout: 30_000 }, async t => {
    const origins = [], verifiedKeys = [], business = [], authorizations = [], connected = [], grantWrites = new Set();
    let application, unavailable = false;
    const redis = await isolatedRedis(t, { allowedOrigins: () => origins, virtualFetch: async (request, url) => {
        if (url.origin !== upstream) return undefined;
        assert.equal(request.method, 'GET');
        assert.equal(request.headers.has('authorization'), false);
        const key = request.headers.get('x-api-key');
        const label = ['A', 'B'].find(value => keys[value] === key);
        assert(label, 'only synthetic accepted keys may reach the upstream');
        assert.equal(url.pathname, `/api/v1/crawl/existing-${label}`);
        business.push(label);
        return Response.json({ code: 200, err: false, msg: 'SUCCESS', data: { status: 'processing', pending: label === 'A' ? 1 : 2 } });
    } });
    const { createRemoteHandler } = await import(new URL('./remote-handler.js', executable));
    const { createRedisCredentialStore } = await import(new URL('./redis/credential-store.js', executable));
    const { Client, StreamableHTTPClientTransport } = await import('@modelcontextprotocol/client');
    const server = http.createServer((request, response) => { void application.handle(request, response); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    origins.push(origin);
    const resource = `${origin}/crawl`;
    const store = { namespace: `automatic_${randomBytes(8).toString('hex')}`, maxTtlSeconds: 600, command: async args => {
        if (args[0] === 'EVAL' && args[1].includes("redis.call('HSET', key, 'payload'") && args[3].includes(':record:R3JhbnQ:')) grantWrites.add(args[3]);
        return redis.command(args);
    } };
    const fingerprintKey = randomBytes(32);
    const actualCredentials = createRedisCredentialStore({ ...store, encryptionKeys: { fixture: randomBytes(32) }, currentKeyId: 'fixture', fingerprintKey });
    const credentials = { ...actualCredentials, async authorize(key) {
        const binding = await actualCredentials.authorize(key); authorizations.push(binding); return binding;
    } };
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const options = { issuerUrl: origin, resourceUrl: resource, clients: [],
        cookieKeys: ['synthetic-automatic-cookie-signing-key'],
        jwks: { keys: [{ ...privateKey.export({ format: 'jwk' }), kid: 'fixture', use: 'sig', alg: 'RS256' }] },
        store, credentials, apiKeyIdentityKey: fingerprintKey,
        verifyApiKey: async (key, signal) => {
            signal.throwIfAborted(); verifiedKeys.push(key);
            if (unavailable) throw new Error('synthetic verification outage');
            return key === keys.A || key === keys.B;
        },
        allowedOrigins: [origin], crawl: { baseURL: upstream, httpTimeoutMs: 1000 },
        maxRequestBodyBytes: 8192, maxFormBodyBytes: 4096, requestTimeoutMs: 3000,
        ttl: { AccessToken: 120, AuthorizationCode: 60, RefreshToken: 240, Grant: 300, Session: 300, Interaction: 120 },
    };
    t.after(async () => {
        for (const client of connected) await client.close().catch(() => {});
        await application?.close(); server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
    });
    application = createRemoteHandler(options);
    const metadata = await (await fetch(`${origin}/.well-known/oauth-authorization-server`)).json();
    const noKey = value => assert(Object.values(keys).every(key => !String(value).includes(key)), 'no raw key in response');
    function browser() {
        const cookies = new Map();
        return { async fetch(url, init = {}) {
            const headers = new Headers(init.headers);
            if (cookies.size) headers.set('cookie', [...cookies].map(([name, value]) => `${name}=${value}`).join('; '));
            const response = await fetch(url, { ...init, headers, redirect: 'manual' });
            for (const item of response.headers.getSetCookie()) {
                const pair = item.split(';')[0], split = pair.indexOf('=');
                if (/max-age=0(?:;|$)/i.test(item)) cookies.delete(pair.slice(0, split));
                else cookies.set(pair.slice(0, split), pair.slice(split + 1));
            }
            noKey(response.headers.get('location'));
            return response;
        } };
    }
    const publicClient = label => ({ client_name: label === 'A' ? 'Fixture <A> & Team' : `Fixture ${label}`, application_type: 'native',
        redirect_uris: [`http://127.0.0.1:65431/callback/${label}`], token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], scope: 'crawl:use offline_access' });
    async function register(value) {
        const response = await fetch(metadata.registration_endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
        const payload = await response.json(); noKey(JSON.stringify(payload));
        return { status: response.status, payload };
    }
    function authorizationUrl(client, parameters = {}) {
        const verifier = randomBytes(32).toString('base64url'), state = randomBytes(12).toString('hex');
        const redirect = parameters.redirect_uri ?? client.redirect_uris[0];
        const url = `${metadata.authorization_endpoint}?${new URLSearchParams({ client_id: client.client_id,
            redirect_uri: redirect, response_type: 'code', scope: 'crawl:use', resource, state,
            code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url'), ...parameters })}`;
        return { url, verifier, state, redirect, client, responseMode: parameters.response_mode };
    }
    async function authorize(client, key, parameters = {}) {
        const page = browser(), flow = authorizationUrl(client, parameters);
        let response = await page.fetch(flow.url);
        const interaction = new URL(response.headers.get('location'), origin);
        assert.equal(interaction.origin, origin);
        assert.match(interaction.pathname, /^\/oauth\/interaction\//);
        response = await page.fetch(interaction);
        const html = await response.text(); noKey(html);
        assert.equal(response.status, 200);
        const displayName = client.client_name.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
        assert(html.includes(displayName), 'consent escapes the dynamically registered client name');
        assert(html.includes(client.client_id), 'consent displays the resolved client identifier');
        assert(html.includes(new URL(flow.redirect).protocol === 'cursor:' ? flow.redirect.replaceAll('&', '&amp;') : new URL(flow.redirect).origin), 'consent displays the actual validated callback');
        const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1]; assert(csrf);
        response = await page.fetch(interaction, { method: 'POST', headers: { origin, 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ csrf, apiToken: key, decision: 'allow' }) });
        for (let budget = 0; budget < 6; budget++) {
            if (response.status === 200) {
                const callback = await callbackFromResponse(response, noKey); noKey(callback.href);
                const selected = new URL(flow.redirect);
                assert.equal(callback.protocol, selected.protocol);
                assert.equal(callback.host, selected.host);
                assert.equal(callback.pathname, selected.pathname);
                for (const [name, value] of selected.searchParams) assert.equal(callback.searchParams.get(name), value);
                const result = flow.responseMode === 'fragment' ? new URLSearchParams(callback.hash.slice(1)) : callback.searchParams;
                assert.equal(result.get('state'), flow.state);
                assert.equal(result.get('iss'), origin);
                assert(result.get('code'));
                return { ...flow, code: result.get('code'), page, interaction, csrf };
            }
            assert([302, 303].includes(response.status), `authorization redirect status=${response.status}`);
            const next = new URL(response.headers.get('location'), origin);
            assert.equal(next.origin, origin);
            response = await page.fetch(next);
        }
        assert.fail('authorization exceeded its redirect bound');
    }
    async function token(body) {
        const response = await fetch(metadata.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });
        const payload = await response.json(); noKey(JSON.stringify(payload));
        return { status: response.status, payload };
    }
    const exchange = (flow, change = {}) => token({ client_id: flow.client.client_id, grant_type: 'authorization_code', code: flow.code,
        code_verifier: flow.verifier, redirect_uri: flow.redirect, resource, ...change });
    const refresh = (client, raw, scope) => token({ client_id: client.client_id, grant_type: 'refresh_token',
        refresh_token: raw, resource, ...(scope === undefined ? {} : { scope }) });
    async function applicationCallback(page, response, flow) {
        for (let budget = 0; budget < 6; budget++) {
            if (response.status === 200) {
                const callback = await callbackFromResponse(response, noKey); noKey(callback.href);
                assert.equal(callback.protocol, new URL(flow.redirect).protocol);
                assert.equal(callback.host, new URL(flow.redirect).host);
                assert.equal(callback.origin, new URL(flow.redirect).origin);
                assert.equal(callback.pathname, new URL(flow.redirect).pathname);
                assert.equal(callback.searchParams.get('state'), flow.state);
                assert.equal(callback.searchParams.get('iss'), origin);
                return callback;
            }
            assert([302, 303].includes(response.status), `IPv6 authorization redirect status=${response.status}`);
            const next = new URL(response.headers.get('location'), origin);
            assert.equal(next.origin, origin, 'an IPv6 callback must use the HTML bridge instead of an external HTTP redirect');
            response = await page.fetch(next);
        }
        assert.fail('IPv6 authorization exceeded its redirect bound');
    }
    async function connect(headers) {
        const client = new Client({ name: 'automatic-onboarding-fixture', version: '1.0.0' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
        connected.push(client);
        await client.connect(new StreamableHTTPClientTransport(new URL(resource), { requestInit: { headers } }));
        assert.equal((await client.listTools()).tools.length, 6);
        return client;
    }
    async function protectedRequest(headers, url = resource) {
        const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
        await response.arrayBuffer(); return response;
    }
    async function rawRequest(headers) {
        return new Promise((resolve, reject) => {
            const request = http.request({ hostname: '127.0.0.1', port: server.address().port, path: '/crawl', method: 'POST', agent: false,
                headers: ['Host', new URL(origin).host, 'Content-Type', 'application/json', 'Accept', 'application/json, text/event-stream', ...headers] }, response => {
                const chunks = []; response.on('data', chunk => chunks.push(chunk));
                response.on('end', () => { noKey(Buffer.concat(chunks).toString()); resolve(response.statusCode); }); response.on('error', reject);
            });
            request.on('error', reject); request.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }));
        });
    }
    let clientA, clientB, flowA, authA, authB;
    await t.test('zero configured clients advertise actual automatic registration and canonical OAuth discovery', async () => {
        assert.equal(metadata.issuer, origin);
        assert.equal(metadata.client_id_metadata_document_supported, true);
        assert.equal(new URL(metadata.registration_endpoint).origin, origin);
        assert(metadata.token_endpoint_auth_methods_supported.includes('none'));
        assert(metadata.token_endpoint_auth_methods_supported.includes('client_secret_basic'));
        assert.deepEqual(metadata.code_challenge_methods_supported, ['S256']);
        assert.deepEqual(metadata.scopes_supported, ['crawl:use', 'offline_access']);
        const unauthenticated = await protectedRequest({});
        assert.equal(unauthenticated.status, 401);
        assert(unauthenticated.headers.get('www-authenticate').includes(`${origin}/.well-known/oauth-protected-resource/crawl`));
        const protectedMetadata = await (await fetch(`${origin}/.well-known/oauth-protected-resource/crawl`)).json();
        assert.equal(protectedMetadata.resource, resource);
        assert.deepEqual(protectedMetadata.scopes_supported, ['crawl:use']);
        assert.equal(verifiedKeys.length, 0); assert.equal(authorizations.length, 0);
    });
    await t.test('DCR issues public clients without shared secrets or predetermined local ports', async () => {
        for (const label of ['A', 'B']) {
            const result = await register(publicClient(label));
            assert.equal(result.status, 201, `registration failed (${result.payload.error ?? 'no error'})`);
            assert.equal(result.payload.token_endpoint_auth_method, 'none');
            assert.equal(result.payload.client_secret, undefined);
            assert.equal(typeof result.payload.client_id, 'string');
            if (label === 'A') clientA = result.payload; else clientB = result.payload;
        }
        assert.notEqual(clientA.client_id, clientB.client_id);
        assert.equal(authorizations.length, 0);
    });
    await t.test('DCR rejects grants and callbacks outside its public-client policy', async () => {
        const before = authorizations.length;
        for (const change of [{ redirect_uris: ['http://127.0.0.1:65431/callback/*'] },
            { redirect_uris: ['http://example.invalid/callback'] },
            { grant_types: ['client_credentials'] }, { response_types: ['token'] }]) {
            const result = await register({ ...publicClient('A'), ...change });
            assert.equal(result.status, 400);
            assert.equal(typeof result.payload.error, 'string');
        }
        assert.equal(authorizations.length, before);
    });
    await t.test('unverified client display names cannot hide a distinct registration and callback origin', async () => {
        const redirect = 'https://different-client.example/callback';
        const result = await register({ ...publicClient('S'), client_name: clientA.client_name, redirect_uris: [redirect] });
        assert.equal(result.status, 201, result.payload.error);
        assert.notEqual(result.payload.client_id, clientA.client_id);
        const page = browser();
        const response = await page.fetch(authorizationUrl(result.payload, { redirect_uri: redirect }).url);
        const next = new URL(response.headers.get('location'), origin);
        assert.equal(next.origin, origin);
        const consent = await page.fetch(next), html = await consent.text(); noKey(html);
        assert.equal(consent.status, 200);
        assert(html.includes('Fixture &lt;A&gt; &amp; Team') && !html.includes(clientA.client_name));
        assert(html.includes(result.payload.client_id), 'a copied display name must still show the distinct client identifier');
        assert(html.includes(new URL(redirect).origin), 'the actual validated return origin must be visible');
        assert.equal(authorizations.length, 0);
    });
    await t.test('public authorization, consent and code exchange isolate two users at actual MCP calls', async () => {
        flowA = await authorize(clientA, keys.A);
        const first = await exchange(flowA); assert.equal(first.status, 200, first.payload.error);
        authA = first.payload;
        const second = await exchange(await authorize(clientB, keys.B)); assert.equal(second.status, 200, second.payload.error);
        authB = second.payload;
        assert(authA.access_token && authA.refresh_token && authB.access_token && authB.refresh_token);
        assert.equal(authA.id_token, undefined); assert.notEqual(authorizations[0].id, authorizations[1].id);
        const clients = await Promise.all([authA, authB].map(auth => connect({ authorization: `Bearer ${auth.access_token}` })));
        const results = await Promise.all(clients.map((client, index) => client.callTool({ name: 'nstdata_crawl_status', arguments: { crawlId: `existing-${index ? 'B' : 'A'}` } })));
        assert.equal(results[0].structuredContent?.pending, 1); assert.equal(results[1].structuredContent?.pending, 2);
        assert.deepEqual(business.sort(), ['A', 'B']);
    });
    await t.test('CIMD rejects private and loopback metadata URLs before consent or business work', async () => {
        const before = [authorizations.length, verifiedKeys.length, business.length];
        for (const clientId of ['https://127.0.0.1/client.json', 'https://[::1]/client.json',
            'https://169.254.169.254/latest/meta-data', 'https://10.0.0.1/client.json']) {
            const response = await fetch(authorizationUrl(clientA, { client_id: clientId }).url, { redirect: 'manual' });
            const location = response.headers.get('location'), next = location && new URL(location, origin);
            assert(!next?.pathname.startsWith('/oauth/interaction/'), 'private metadata must not reach consent');
            if (next) assert(next.searchParams.has('error'));
            else assert(response.status >= 400 && response.status < 500);
            noKey(await response.text());
        }
        assert.deepEqual([authorizations.length, verifiedKeys.length, business.length], before);
    });
    await t.test('registered Client survives a new provider instance and public refresh rotates', async () => {
        await application.close(); application = createRemoteHandler(options);
        const refreshed = await token({ client_id: clientA.client_id, grant_type: 'refresh_token', refresh_token: authA.refresh_token, resource });
        assert.equal(refreshed.status, 200, refreshed.payload.error);
        assert(refreshed.payload.access_token && refreshed.payload.refresh_token);
        assert.notEqual(refreshed.payload.refresh_token, authA.refresh_token);
        authA = refreshed.payload;
        const client = await connect({ authorization: `Bearer ${authA.access_token}` });
        assert.equal((await client.listTools()).tools.length, 6);
        assert.equal(authorizations.length, 2);
    });
    await t.test('code replay, missing PKCE and unregistered callback paths fail without more consent writes', async () => {
        const before = authorizations.length;
        assert.equal((await exchange(flowA)).status, 400);
        for (const parameters of [{ code_challenge: '', code_challenge_method: '' }, { redirect_uri: `${origin}/unregistered` }, { scope: 'proxy:use' }, { resource: `${origin}/wrong` }]) {
            const page = browser();
            const response = await page.fetch(authorizationUrl(clientA, parameters).url);
            if (response.status === 200) {
                const callback = await callbackFromResponse(response);
                assert(callback.searchParams.has('error')); continue;
            }
            const location = response.headers.get('location');
            const next = location && new URL(location, origin);
            if (next?.pathname.startsWith('/oauth/interaction/')) {
                assert.equal(Object.keys(parameters).join(','), 'scope');
                const denied = await page.fetch(next);
                assert.equal(denied.status, 400);
                const html = await denied.text();
                assert.match(denied.headers.get('content-type'), /^text\/html/);
                assert.match(html, /Invalid authorization request/);
                assert.doesNotMatch(html, /<form\b|name="apiToken"/); noKey(html);
            } else if (next) assert(next.searchParams.has('error'));
            else assert(response.status >= 400 && response.status < 500);
            noKey(await response.text());
        }
        assert.equal(authorizations.length, before);
    });
    const ipv6Redirect = 'http://[::1]:65431/callback/ipv6';
    let ipv6Client;
    await t.test('IPv6 DCR callback completes query authorization through an HTML bridge and PKCE exchange', async () => {
        const registered = await register({ ...publicClient('IPv6'), redirect_uris: [ipv6Redirect] });
        assert.equal(registered.status, 201, registered.payload.error);
        ipv6Client = registered.payload;
        assert.deepEqual(ipv6Client.redirect_uris, [ipv6Redirect]);
        const page = browser(), flow = { ...authorizationUrl(ipv6Client, { redirect_uri: ipv6Redirect }), redirect: ipv6Redirect };
        let response = await page.fetch(flow.url);
        const interaction = new URL(response.headers.get('location'), origin);
        assert.equal(interaction.origin, origin);
        assert.match(interaction.pathname, /^\/oauth\/interaction\//);
        response = await page.fetch(interaction);
        assert.equal(response.status, 200);
        assert.match(response.headers.get('content-security-policy'), /form-action 'self';/);
        assert.doesNotMatch(response.headers.get('content-security-policy'), /\[::1\]/);
        const html = await response.text(); noKey(html);
        assert(html.includes(new URL(ipv6Redirect).origin), 'consent displays the validated IPv6 callback origin');
        const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1]; assert(csrf);
        const before = [verifiedKeys.length, authorizations.length, grantWrites.size];
        response = await page.fetch(interaction, { method: 'POST', headers: { origin, 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ csrf, apiToken: keys.A, decision: 'allow' }) });
        const callback = await applicationCallback(page, response, flow);
        assert.equal(callback.searchParams.get('error'), null);
        assert(callback.searchParams.get('code'));
        assert.deepEqual([verifiedKeys.length, authorizations.length, grantWrites.size], before.map(value => value + 1));
        const exchanged = await exchange({ ...flow, code: callback.searchParams.get('code') });
        assert.equal(exchanged.status, 200, exchanged.payload.error);
        assert(exchanged.payload.access_token);
    });
    await t.test('IPv6 cancellation bridges the error without key verification or credential and Grant writes', async () => {
        const before = [verifiedKeys.length, authorizations.length, grantWrites.size];
        const page = browser(), flow = { ...authorizationUrl(ipv6Client, { redirect_uri: ipv6Redirect }), redirect: ipv6Redirect };
        let response = await page.fetch(flow.url);
        const interaction = new URL(response.headers.get('location'), origin);
        assert.equal(interaction.origin, origin);
        response = await page.fetch(interaction);
        assert.equal(response.status, 200);
        const html = await response.text(); noKey(html);
        const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1]; assert(csrf);
        response = await page.fetch(interaction, { method: 'POST', headers: { origin, 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ csrf, apiToken: keys.A, decision: 'deny' }) });
        const callback = await applicationCallback(page, response, flow);
        assert.equal(callback.searchParams.get('error'), 'access_denied');
        assert.equal(callback.searchParams.get('code'), null);
        assert.deepEqual([verifiedKeys.length, authorizations.length, grantWrites.size], before);
    });
    await t.test('IPv6 form_post and unregistered callback paths fail before consent or authorization writes', async () => {
        const before = [verifiedKeys.length, authorizations.length, grantWrites.size];
        for (const parameters of [{}, { prompt: 'none' }]) {
            const url = authorizationUrl(ipv6Client, { redirect_uri: ipv6Redirect, response_mode: 'form_post', ...parameters }).url;
            const response = await browser().fetch(url);
            assert.equal(response.status, 400, `form_post with prompt=${parameters.prompt ?? 'default'} must fail at the authorization endpoint`);
            assert.equal(response.headers.get('location'), null);
            assert.match(response.headers.get('content-type'), /^text\/html/);
            const html = await response.text(); noKey(html);
            assert.match(html, /Unsupported callback mode/);
            assert.doesNotMatch(html, /<form\b|name="apiToken"/);
            assert.deepEqual([verifiedKeys.length, authorizations.length, grantWrites.size], before);
        }
        const response = await browser().fetch(authorizationUrl(ipv6Client, { redirect_uri: 'http://[::1]:65431/unregistered' }).url);
        assert(response.status >= 400 && response.status < 500);
        assert.equal(response.headers.get('location'), null, 'unregistered IPv6 callbacks cannot redirect or reach consent');
        noKey(await response.text());
        assert.deepEqual([verifiedKeys.length, authorizations.length, grantWrites.size], before);
    });
    const cursorNative = 'cursor://anysphere.cursor-mcp/oauth/callback?fixed=one%20two&other=%22%3C%3E%26';
    await t.test('explicit fragment code responses retain the IPv6 return bridge and work for HTTPS and Cursor', async () => {
        const redirects = [ipv6Redirect, 'https://www.cursor.com/agents/mcp/oauth/callback?fixed=preserved', cursorNative];
        const registered = await register({ ...publicClient('Fragment'), redirect_uris: redirects });
        assert.equal(registered.status, 201, registered.payload.error);
        for (const redirect of redirects) {
            const flow = await authorize(registered.payload, keys.A, { redirect_uri: redirect, response_mode: 'fragment' });
            const issued = await exchange(flow);
            assert.equal(issued.status, 200, issued.payload.error);
            assert(issued.payload.access_token && issued.payload.refresh_token);
        }
    });
    await t.test('Cursor dual and triple callback registrations complete each selected callback with PKCE, refresh and revocation', async () => {
        const web = 'https://www.cursor.com/agents/mcp/oauth/callback?fixed=one%20two&other=%22%3C%3E%26';
        const local = 'http://localhost:8787/callback?fixed=one%20two&other=%22%3C%3E%26';
        for (const redirects of [[web, local], [cursorNative, web, local]]) {
            const registered = await register({ ...publicClient('Cursor'), redirect_uris: redirects });
            assert.equal(registered.status, 201, registered.payload.error);
            const client = registered.payload;
            assert.deepEqual(client.redirect_uris, redirects);
            for (const redirect of redirects) {
                const before = [verifiedKeys.length, authorizations.length, grantWrites.size];
                const flow = await authorize(client, keys.A, { redirect_uri: redirect });
                assert.equal(flow.redirect, redirect, 'the selected callback, not the first registered one, is exchanged');
                assert.deepEqual([verifiedKeys.length, authorizations.length, grantWrites.size], before.map(value => value + 1));
                const beforeReplay = [verifiedKeys.length, authorizations.length, grantWrites.size];
                const replay = await flow.page.fetch(flow.interaction, { method: 'POST', headers: { origin, 'content-type': 'application/x-www-form-urlencoded' },
                    body: new URLSearchParams({ csrf: flow.csrf, apiToken: keys.A, decision: 'allow' }) });
                assert.equal(replay.status, 400); noKey(await replay.text());
                assert.deepEqual([verifiedKeys.length, authorizations.length, grantWrites.size], beforeReplay, 'the consumed form cannot verify or store credentials again');
                const issued = await exchange(flow); assert.equal(issued.status, 200, issued.payload.error);
                assert(issued.payload.access_token && issued.payload.refresh_token);
                const refreshed = await refresh(client, issued.payload.refresh_token);
                assert.equal(refreshed.status, 200, refreshed.payload.error);
                assert.notEqual(refreshed.payload.refresh_token, issued.payload.refresh_token);
                assert.equal((await protectedRequest({ authorization: `Bearer ${refreshed.payload.access_token}` })).status, 200);
                const revoked = await fetch(metadata.revocation_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
                    body: new URLSearchParams({ client_id: client.client_id, token: refreshed.payload.refresh_token, token_type_hint: 'refresh_token' }) });
                await revoked.arrayBuffer(); assert.equal(revoked.status, 200);
                assert.equal((await protectedRequest({ authorization: `Bearer ${refreshed.payload.access_token}` })).status, 401);
                assert.equal((await exchange(flow)).status, 400, 'the returned authorization code remains single-use');
                const page = browser(), deniedFlow = authorizationUrl(client, { redirect_uri: redirect });
                let response = await page.fetch(deniedFlow.url);
                const interaction = new URL(response.headers.get('location'), origin);
                assert.equal(interaction.origin, origin);
                response = await page.fetch(interaction);
                const html = await response.text(); noKey(html);
                const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1]; assert(csrf);
                const beforeDenial = [verifiedKeys.length, authorizations.length, grantWrites.size];
                response = await page.fetch(interaction, { method: 'POST', headers: { origin, 'content-type': 'application/x-www-form-urlencoded' },
                    body: new URLSearchParams({ csrf, decision: 'deny', apiToken: keys.A }) });
                const callback = await applicationCallback(page, response, deniedFlow);
                assert.equal(callback.searchParams.get('error'), 'access_denied');
                assert.equal(callback.searchParams.get('code'), null);
                for (const [name, value] of new URL(redirect).searchParams) assert.equal(callback.searchParams.get(name), value);
                assert.deepEqual([verifiedKeys.length, authorizations.length, grantWrites.size], beforeDenial);
            }
        }
    });
    await t.test('Cursor compatibility does not accept other schemes, endpoints, malformed URIs or native form_post', async () => {
        const before = [verifiedKeys.length, authorizations.length, grantWrites.size];
        for (const redirect of ['javascript:alert(1)', 'data:text/html,example', 'vscode://anysphere.cursor-mcp/oauth/callback',
            'cursor://attacker.example/oauth/callback', 'cursor://anysphere.cursor-mcp/oauth/other',
            'cursor://anysphere.cursor-mcp:1234/oauth/callback', 'cursor://user@anysphere.cursor-mcp/oauth/callback',
            'cursor://anysphere.cursor-mcp/oauth/callback#fragment', 'cursor://anysphere.cursor-mcp/oauth/callback\n']) {
            const result = await register({ ...publicClient('Invalid'), redirect_uris: [redirect] });
            assert.equal(result.status, 400); assert.equal(result.payload.error, 'invalid_client_metadata');
        }
        const web = await register({ ...publicClient('Web'), application_type: 'web', redirect_uris: [cursorNative] });
        assert.equal(web.status, 400);
        const registered = await register({ ...publicClient('Cursor'), redirect_uris: [cursorNative] });
        assert.equal(registered.status, 201);
        for (const parameters of [{ response_mode: 'form_post' }, { response_mode: 'form_post', prompt: 'none' }]) {
            const response = await browser().fetch(authorizationUrl(registered.payload, parameters).url);
            assert.equal(response.status, 400); assert.equal(response.headers.get('location'), null);
            const html = await response.text(); noKey(html);
            assert.match(html, /Unsupported callback mode/); assert.doesNotMatch(html, /<form\b|name="apiToken"/);
        }
        const invalid = await browser().fetch(authorizationUrl(registered.payload, { redirect_uri: 'cursor://anysphere.cursor-mcp/oauth/callback?fixed=changed' }).url);
        assert.equal(invalid.status, 400); assert.equal(invalid.headers.get('location'), null);
        noKey(await invalid.text());
        assert.deepEqual([verifiedKeys.length, authorizations.length, grantWrites.size], before);
    });
    await t.test('CIMD completes real provider consent, token and MCP with a synthetic HTTPS metadata transport', async () => {
        const metadataClient = { ...publicClient('C'), client_id: 'https://fixture-client.example/client.json' };
        delete metadataClient.scope; // Native clients can omit optional scope metadata; server defaults stay Crawl-only.
        const original = https.request;
        let metadataRequests = 0;
        // Only TLS transport is synthetic; provider metadata parsing, policy, consent, Redis and MCP are real.
        https.request = (url, init, callback) => {
            assert.equal(String(url), metadataClient.client_id);
            assert.equal(init.method, 'GET');
            metadataRequests++;
            const request = new EventEmitter();
            request.destroy = error => { if (error) queueMicrotask(() => request.emit('error', error)); return request; };
            request.end = () => queueMicrotask(() => {
                const socket = new EventEmitter(); socket.remoteAddress = '8.8.8.8';
                request.emit('socket', socket); socket.emit('connect');
                const response = new PassThrough();
                response.statusCode = 200;
                response.headers = { 'content-type': 'application/json', 'cache-control': 'max-age=60' };
                response.complete = true;
                callback(response); response.end(JSON.stringify(metadataClient));
            });
            return request;
        };
        syncBuiltinESMExports();
        try {
            const result = await exchange(await authorize(metadataClient, keys.A));
            assert.equal(result.status, 200, result.payload.error);
            const client = await connect({ authorization: `Bearer ${result.payload.access_token}` });
            const status = await client.callTool({ name: 'nstdata_crawl_status', arguments: { crawlId: 'existing-A' } });
            assert.equal(status.structuredContent?.pending, 1);
            assert.equal(metadataRequests, 1, 'provider reuses its bounded client metadata cache');
        } finally { https.request = original; syncBuiltinESMExports(); }
    });
    await t.test('direct keys authenticate every request without creating OAuth state or crossing identities', async () => {
        const before = authorizations.length, beforeVerifications = verifiedKeys.length;
        const clients = await Promise.all(['A', 'B'].map(label => connect({ 'x-api-key': keys[label] })));
        const results = await Promise.all(clients.map((client, index) => client.callTool({ name: 'nstdata_crawl_status', arguments: { crawlId: `existing-${index ? 'B' : 'A'}` } })));
        assert.equal(results[0].structuredContent?.pending, 1); assert.equal(results[1].structuredContent?.pending, 2);
        assert(verifiedKeys.length >= beforeVerifications + 6, 'initialization, tool listing and tool call each verify the key');
        assert.equal(authorizations.length, before);
    });
    await t.test('bad, mixed and duplicated credentials never downgrade or reach business calls', async () => {
        const before = business.length, beforeConsent = authorizations.length;
        assert.equal((await protectedRequest({ 'x-api-key': keys.rejected })).status, 401);
        const beforeBearer = verifiedKeys.length;
        assert.equal((await protectedRequest({ authorization: `Bearer ${keys.A}` })).status, 401);
        assert.equal(verifiedKeys.length, beforeBearer, 'Bearer must never enter API-key verification');
        assert.equal((await protectedRequest({ authorization: `Bearer ${authA.access_token}`, 'x-api-key': keys.A })).status, 400);
        assert.equal(await rawRequest(['X-API-Key', keys.A, 'x-api-key', keys.B]), 400);
        assert.equal(await rawRequest(['Authorization', `Bearer ${authA.access_token}`, 'authorization', `Bearer ${authB.access_token}`]), 400);
        assert.equal(verifiedKeys.length, beforeBearer, 'ambiguous credential headers are rejected before verification');
        assert.equal(business.length, before); assert.equal(authorizations.length, beforeConsent);
    });
    await t.test('key verifier outage fails closed and a later valid request is not permanently revoked', async () => {
        const before = authorizations.length;
        unavailable = true;
        try { assert.equal((await protectedRequest({ 'x-api-key': keys.A })).status, 503); }
        finally { unavailable = false; }
        const client = await connect({ 'x-api-key': keys.A });
        assert.equal((await client.listTools()).tools.length, 6);
        assert.equal(authorizations.length, before);
    });
    await t.test('public refresh revocation denies the OAuth grant without revoking the independent API key', async () => {
        const response = await fetch(metadata.revocation_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ client_id: clientB.client_id, token: authB.refresh_token, token_type_hint: 'refresh_token' }) });
        await response.arrayBuffer(); assert.equal(response.status, 200);
        assert.equal((await protectedRequest({ authorization: `Bearer ${authB.access_token}` })).status, 401);
        const refreshed = await token({ client_id: clientB.client_id, grant_type: 'refresh_token', refresh_token: authB.refresh_token, resource });
        assert.equal(refreshed.status, 400);
        assert.equal(refreshed.payload.error, 'invalid_grant');
        const binding = authorizations[1];
        assert.equal(await actualCredentials.revoke(binding.id, binding.version), true);
        const before = authorizations.length;
        const client = await connect({ 'x-api-key': keys.B });
        assert.equal((await client.listTools()).tools.length, 6);
        assert.equal(authorizations.length, before, 'direct keys must not reactivate a revoked OAuth binding');
        assert.equal(await actualCredentials.resolve(binding.id, binding.version), null);
    });
    await t.test('public OAuth preserves requested offline access without an OIDC consent prompt', async () => {
        for (const parameters of [{}, { prompt: 'consent' }]) {
            const issued = await exchange(await authorize(clientA, keys.A, { scope: 'crawl:use offline_access', ...parameters }));
            assert.equal(issued.status, 200, issued.payload.error);
            let auth = issued.payload;
            assert(auth.access_token && auth.refresh_token);
            assert.equal(auth.scope, 'crawl:use', 'the resource access token remains Crawl-only');
            for (const scope of ['crawl:use offline_access', undefined, 'crawl:use']) {
                const refreshed = await refresh(clientA, auth.refresh_token, scope);
                assert.equal(refreshed.status, 200, refreshed.payload.error_description ?? refreshed.payload.error);
                assert(refreshed.payload.access_token && refreshed.payload.refresh_token);
                assert.notEqual(refreshed.payload.refresh_token, auth.refresh_token);
                assert.equal(refreshed.payload.scope, 'crawl:use');
                auth = refreshed.payload;
            }
            const client = await connect({ authorization: `Bearer ${auth.access_token}` });
            assert.equal((await client.listTools()).tools.length, 6);
        }
    });
    await t.test('invalid refresh scopes cannot expand an original grant or consume its refresh token', async () => {
        for (const [initialScope, rejectedScope, missingScope] of [
            ['crawl:use', 'crawl:use offline_access', 'offline_access'],
            ['crawl:use offline_access', 'crawl:use offline_access proxy:use', 'proxy:use'],
        ]) {
            const issued = await exchange(await authorize(clientA, keys.A, { scope: initialScope }));
            assert.equal(issued.status, 200, issued.payload.error);
            const rejected = await refresh(clientA, issued.payload.refresh_token, rejectedScope);
            assert.equal(rejected.status, 400);
            assert.equal(rejected.payload.error, 'invalid_scope');
            assert.equal(rejected.payload.scope, missingScope, 'error.scope identifies the missing scope, not an issued token scope');
            assert.equal(rejected.payload.access_token, undefined); assert.equal(rejected.payload.refresh_token, undefined);
            assert.equal((await protectedRequest({ authorization: `Bearer ${issued.payload.access_token}` })).status, 200);
            const recovered = await refresh(clientA, issued.payload.refresh_token);
            assert.equal(recovered.status, 200, 'scope rejection must not consume the original refresh token');
            assert.notEqual(recovered.payload.refresh_token, issued.payload.refresh_token);
            assert.equal((await protectedRequest({ authorization: `Bearer ${recovered.payload.access_token}` })).status, 200);
            if (initialScope === 'crawl:use') {
                const expansion = await refresh(clientA, recovered.payload.refresh_token, 'crawl:use offline_access');
                assert.equal(expansion.status, 400); assert.equal(expansion.payload.error, 'invalid_scope');
                assert.equal(expansion.payload.access_token, undefined); assert.equal(expansion.payload.refresh_token, undefined);
            }
        }
    });
    await t.test('offline consent preserves explicit prompts, duplicate-parameter rejection and GET-only authorization', async () => {
        const before = [verifiedKeys.length, authorizations.length, grantWrites.size];
        const noPrompt = await fetch(authorizationUrl(clientA, { scope: 'crawl:use offline_access', prompt: 'none' }).url, { redirect: 'manual' });
        const destination = await callbackFromResponse(noPrompt);
        assert.equal(destination.pathname, new URL(clientA.redirect_uris[0]).pathname);
        assert.equal(destination.searchParams.get('error'), 'login_required');
        const flow = authorizationUrl(clientA, { scope: 'crawl:use offline_access', prompt: 'consent' });
        for (const duplicate of ['scope=crawl%3Ause', 'prompt=none']) {
            const response = await fetch(`${flow.url}&${duplicate}`, { redirect: 'manual' });
            const next = response.headers.get('location'), text = await response.text();
            if (next) assert.equal(new URL(next, origin).searchParams.get('error'), 'invalid_request');
            else if (response.status === 200) assert.equal((await callbackFromResponse({ status: response.status, headers: response.headers, body: text })).searchParams.get('error'), 'invalid_request');
            else assert.equal(JSON.parse(text).error, 'invalid_request');
        }
        const post = await fetch(metadata.authorization_endpoint, { method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URL(flow.url).searchParams });
        await post.arrayBuffer(); assert.equal(post.status, 404);
        assert.deepEqual([verifiedKeys.length, authorizations.length, grantWrites.size], before);
    });
    await t.test('an expired public access token refreshes with its requested scope and resumes MCP tools', async () => {
        await application.close(); application = createRemoteHandler({ ...options, ttl: { ...options.ttl, AccessToken: 2 } });
        const issued = await exchange(await authorize(clientA, keys.A, { scope: 'crawl:use offline_access' }));
        assert.equal(issued.status, 200); assert.equal(issued.payload.expires_in, 2);
        let auth = { ...issued.payload, issuer: origin }, refreshes = 0;
        const authProvider = {
            redirectUrl: clientA.redirect_uris[0], clientMetadata: publicClient('A'),
            clientInformation: () => ({ ...clientA, issuer: origin }), tokens: () => auth,
            saveTokens: value => { auth = value; },
            redirectToAuthorization: () => assert.fail('an unexpired refresh token must not require new authorization'),
            saveCodeVerifier: () => assert.fail('refresh must not start a new PKCE flow'), codeVerifier: () => assert.fail('refresh does not use a code verifier'),
            addClientAuthentication: (_headers, params) => {
                assert.equal(params.get('grant_type'), 'refresh_token');
                params.set('client_id', clientA.client_id); params.set('scope', 'crawl:use offline_access'); refreshes++;
            },
        };
        const client = new Client({ name: 'public-refresh-fixture', version: '1.0.0' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
        connected.push(client);
        await client.connect(new StreamableHTTPClientTransport(new URL(resource), { authProvider }));
        assert.equal((await client.listTools()).tools.length, 6);
        const expired = auth, beforeRefresh = refreshes;
        await new Promise(resolve => setTimeout(resolve, 2100));
        assert.equal((await protectedRequest({ authorization: `Bearer ${expired.access_token}` })).status, 401);
        assert.equal((await client.listTools()).tools.length, 6);
        assert.equal(refreshes, beforeRefresh + 1); assert.notEqual(auth.refresh_token, expired.refresh_token);
        assert.equal(auth.scope, 'crawl:use');
    });
    // Independent handler instances share Redis; short synthetic expiries exercise day-scale policy.
    const { createRedisKeys } = await import(new URL('./redis/shared.js', executable));
    const redisKeys = createRedisKeys(store.namespace);
    const record = async (model, id) => JSON.parse(await redis.command(['HGET', redisKeys.record(model, id), 'payload']));
    const issue = async () => {
        const issued = await exchange(await authorize(clientA, keys.A, { scope: 'crawl:use offline_access' }));
        assert.equal(issued.status, 200, issued.payload.error); return issued.payload;
    };
    const ageRotation = raw => redis.command(['HSET', redisKeys.record('RefreshToken', raw), 'consumedAtMs', String(Date.now() - 6000)]);
    const manage = async (page, csrf, change = {}, headers = {}) => {
        const response = await page.fetch(`${origin}/oauth/authorizations`, { method: 'POST',
            headers: { origin, 'content-type': 'application/x-www-form-urlencoded', ...headers },
            body: new URLSearchParams({ csrf, apiToken: keys.A, confirm: 'revoke-all', decision: 'revoke', ...change }) });
        const html = await response.text(); noKey(html); return { response, html };
    };
    async function managementForm() {
        const page = browser(), response = await page.fetch(`${origin}/oauth/authorizations`);
        const html = await response.text(); noKey(html); assert.equal(response.status, 200);
        return { page, csrf: /name="csrf" value="([^"]+)"/.exec(html)?.[1] };
    }
    await t.test('identical simultaneous public refreshes across handler instances receive one encrypted successor pair', async () => {
        await application.close();
        const first = createRemoteHandler(options), second = createRemoteHandler(options); let calls = 0;
        application = { handle: (request, response) => (++calls % 2 ? first : second).handle(request, response),
            close: async () => { await first.close(); await second.close(); } };
        const auth = await issue();
        const results = await Promise.all([refresh(clientA, auth.refresh_token), refresh(clientA, auth.refresh_token)]);
        assert.deepEqual(results.map(value => value.status), [200, 200]);
        assert.equal(results[0].payload.access_token, results[1].payload.access_token);
        assert.equal(results[0].payload.refresh_token, results[1].payload.refresh_token);
        assert(results[1].payload.expires_in <= results[0].payload.expires_in + 1);
        assert.notEqual(auth.refresh_token, results[0].payload.refresh_token);
        const stored = await redis.command(['KEYS', `${redisKeys.prefix}refresh-*`]);
        assert(stored.length > 0);
        for (const key of stored) {
            assert(!key.includes(auth.refresh_token));
            const value = await redis.command(['GET', key]);
            assert(!value.includes(auth.refresh_token)); assert(!value.includes(results[0].payload.access_token));
            assert(!value.includes(results[0].payload.refresh_token));
        }
        const reordered = await token({ resource, refresh_token: auth.refresh_token, grant_type: 'refresh_token', client_id: clientA.client_id });
        assert.equal(reordered.status, 200); assert.equal(reordered.payload.refresh_token, results[0].payload.refresh_token);
        assert.equal((await protectedRequest({ authorization: `Bearer ${results[0].payload.access_token}` })).status, 200);
    });
    await t.test('refresh overlap rejects altered client, scope, resource and extra parameters without cached credentials or collateral revocation', async () => {
        const auth = await issue(), rotated = await refresh(clientA, auth.refresh_token); assert.equal(rotated.status, 200);
        for (const change of [{ client_id: clientB.client_id }, { scope: 'crawl:other' }, { scope: 'crawl:use' },
            { resource: `${origin}/wrong` }, { extra: 'changed' }]) {
            const result = await token({ client_id: clientA.client_id, grant_type: 'refresh_token', refresh_token: auth.refresh_token, resource, ...change });
            assert.equal(result.status, 400); assert.equal(result.payload.access_token, undefined);
        }
        assert.equal((await refresh(clientA, auth.refresh_token)).payload.refresh_token, rotated.payload.refresh_token);
        for (const suffix of ['&scope=x&scope=y', '&resource=%ZZ', '&extra=%C0%AE']) {
            const response = await fetch(metadata.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({ client_id: clientA.client_id, grant_type: 'refresh_token', refresh_token: auth.refresh_token, resource }).toString() + suffix });
            assert.equal(response.status, 400); assert.equal((await response.json()).access_token, undefined);
        }
        assert.equal((await protectedRequest({ authorization: `Bearer ${rotated.payload.access_token}` })).status, 200);
    });
    await t.test('older-than-immediate and outside-window reuse retain family revocation', async () => {
        for (const older of [false, true]) {
            const auth = await issue(), first = await refresh(clientA, auth.refresh_token); assert.equal(first.status, 200);
            let current = first.payload;
            if (older) { const second = await refresh(clientA, first.payload.refresh_token); assert.equal(second.status, 200); current = second.payload; }
            else await ageRotation(auth.refresh_token);
            assert.equal((await refresh(clientA, auth.refresh_token)).status, 400);
            assert.equal((await protectedRequest({ authorization: `Bearer ${current.access_token}` })).status, 401);
            assert.equal((await refresh(clientA, current.refresh_token)).status, 400);
        }
    });
    await t.test('grant, binding and individually revoked access tokens cannot be revived by the overlap cache', async () => {
        for (const mode of ['grant', 'access', 'binding']) {
            const auth = await issue(), rotated = await refresh(clientA, auth.refresh_token); assert.equal(rotated.status, 200);
            if (mode === 'binding') {
                const binding = await actualCredentials.findBinding(keys.A); assert(binding); await actualCredentials.revoke(binding.id, binding.version);
            } else if (mode === 'access') {
                const token = await record('AccessToken', rotated.payload.access_token);
                await redis.command(['HSET', redisKeys.record('AccessToken', rotated.payload.access_token), 'destroyed', '1', 'expiresAt', '0']);
                assert(await record('Grant', token.grantId));
                assert.equal((await record('RefreshToken', rotated.payload.refresh_token)).consumed, undefined);
            } else {
                const response = await fetch(metadata.revocation_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
                    body: new URLSearchParams({ client_id: clientA.client_id, token: mode === 'grant' ? rotated.payload.refresh_token : rotated.payload.access_token }) });
                await response.arrayBuffer(); assert.equal(response.status, 200);
            }
            const result = await refresh(clientA, auth.refresh_token);
            assert.notEqual(result.status, 200); assert.equal(result.payload.access_token, undefined);
        }
    });
    await t.test('missing response cache after rotation fails temporarily in-window and never mints a parallel chain', async () => {
        const auth = await issue(), rotated = await refresh(clientA, auth.refresh_token); assert.equal(rotated.status, 200);
        const before = await redis.command(['KEYS', `${redisKeys.prefix}record:UmVmcmVzaFRva2Vu:*`]);
        const cache = await redis.command(['KEYS', `${redisKeys.prefix}refresh-response:*`]);
        await redis.command(['DEL', ...cache]);
        const result = await refresh(clientA, auth.refresh_token); assert.equal(result.status, 503); assert.equal(result.payload.access_token, undefined);
        assert.deepEqual(await redis.command(['KEYS', `${redisKeys.prefix}record:UmVmcmVzaFRva2Vu:*`]), before);
        assert.equal((await protectedRequest({ authorization: `Bearer ${rotated.payload.access_token}` })).status, 200);
        await ageRotation(auth.refresh_token);
        assert.equal((await refresh(clientA, auth.refresh_token)).status, 400);
    });
    await t.test('rotation refreshes inactivity while preserving absolute grant expiry and capping descendant tokens', async () => {
        const auth = await issue(), old = await record('RefreshToken', auth.refresh_token), grant = await record('Grant', old.grantId);
        const deadline = Math.floor(Date.now() / 1000) + 4;
        grant.exp = deadline;
        await redis.command(['HSET', redisKeys.record('Grant', old.grantId), 'payload', JSON.stringify(grant), 'expiresAt', String(deadline)]);
        const rotated = await refresh(clientA, auth.refresh_token); assert.equal(rotated.status, 200);
        assert(rotated.payload.expires_in > 0 && rotated.payload.expires_in <= 4);
        assert.equal((await record('RefreshToken', rotated.payload.refresh_token)).exp, deadline);
        assert.equal((await record('AccessToken', rotated.payload.access_token)).exp, deadline);
        assert.equal((await record('Grant', old.grantId)).exp, deadline);
        grant.exp = Math.floor(Date.now() / 1000) - 1;
        await redis.command(['HSET', redisKeys.record('Grant', old.grantId), 'payload', JSON.stringify(grant), 'expiresAt', String(grant.exp)]);
        assert.equal((await protectedRequest({ authorization: `Bearer ${rotated.payload.access_token}` })).status, 401);
        assert.equal((await refresh(clientA, auth.refresh_token)).status, 400);
    });
    await t.test('authorization management validates key and one-use same-origin CSRF then revokes only matching-key OAuth grants', async () => {
        const first = await issue(), another = await issue();
        const other = await exchange(await authorize(clientB, keys.B)); assert.equal(other.status, 200);
        const authState = authorizations.length;
        let form = await managementForm(); assert(form.csrf);
        assert.equal((await manage(form.page, form.csrf, {}, { origin: 'https://cross-origin.invalid' })).response.status, 403);
        assert.equal((await manage(form.page, form.csrf, { confirm: '' })).response.status, 403);
        form = await managementForm();
        assert.equal((await manage(form.page, form.csrf, { apiToken: keys.rejected })).response.status, 401);
        assert.equal((await protectedRequest({ authorization: `Bearer ${first.access_token}` })).status, 200);
        form = await managementForm();
        const revoked = await manage(form.page, form.csrf); assert.equal(revoked.response.status, 200); assert.match(revoked.html, /revoked/i);
        const replay = await manage(form.page, form.csrf); assert.equal(replay.response.status, 403);
        for (const auth of [first, another]) {
            assert.equal((await protectedRequest({ authorization: `Bearer ${auth.access_token}` })).status, 401);
            assert.equal((await refresh(clientA, auth.refresh_token)).status, 400);
        }
        assert.equal((await protectedRequest({ authorization: `Bearer ${other.payload.access_token}` })).status, 200);
        assert.equal((await protectedRequest({ 'x-api-key': keys.A })).status, 200);
        assert.equal(authorizations.length, authState, 'management cannot authorize or extend a binding');
        form = await managementForm(); assert.match((await manage(form.page, form.csrf)).html, /No active MCP access/);
        const reauthorized = await issue(); assert.equal((await protectedRequest({ authorization: `Bearer ${reauthorized.access_token}` })).status, 200);
        assert.equal((await protectedRequest({ authorization: `Bearer ${other.payload.access_token}` })).status, 200);
    });

    await t.test('retained cookie keys decrypt overlap responses after rotation and overlap zero restores immediate reuse revocation', async () => {
        const auth = await issue(), rotated = await refresh(clientA, auth.refresh_token); assert.equal(rotated.status, 200);
        await application.close(); application = createRemoteHandler({ ...options, cookieKeys: ['synthetic-next-cookie-signing-key-minimum', ...options.cookieKeys] });
        const cached = await refresh(clientA, auth.refresh_token);
        assert.equal(cached.status, 200); assert.equal(cached.payload.refresh_token, rotated.payload.refresh_token);
        const strictAuth = await issue();
        await application.close(); application = createRemoteHandler({ ...options, rotationOverlapSeconds: 0 });
        const first = await refresh(clientA, strictAuth.refresh_token); assert.equal(first.status, 200);
        assert.equal((await refresh(clientA, strictAuth.refresh_token)).status, 400);
        assert.equal((await protectedRequest({ authorization: `Bearer ${first.payload.access_token}` })).status, 401);
    });
    await t.test('a lost lease fences response publication and cannot delete a successor owner lease', async () => {
        await application.close(); application = createRemoteHandler(options);
        const auth = await issue(); let successorLease;
        const cachesBefore = (await redis.command(['KEYS', `${redisKeys.prefix}refresh-response:*`])).sort();
        await application.close();
        application = createRemoteHandler({ ...options, store: { ...store, command: async args => {
            if (args[0] === 'EVAL' && args[1].includes('for i=8,#KEYS')) {
                successorLease = args[10];
                await redis.command(['SET', successorLease, 'synthetic-successor-owner', 'PX', '1000']);
            }
            return store.command(args);
        } } });
        const result = await refresh(clientA, auth.refresh_token);
        assert.equal(result.status, 503); assert.equal(result.payload.access_token, undefined);
        assert.equal(await redis.command(['GET', successorLease]), 'synthetic-successor-owner');
        const caches = await redis.command(['KEYS', `${redisKeys.prefix}refresh-response:*`]);
        assert.deepEqual(caches.sort(), cachesBefore, 'a stale lease owner must not publish any response cache');
        await redis.command(['DEL', successorLease]);
        const retry = await refresh(clientA, auth.refresh_token); assert.equal(retry.status, 503); assert.equal(retry.payload.refresh_token, undefined);
        await application.close(); application = createRemoteHandler(options);
    });

});
