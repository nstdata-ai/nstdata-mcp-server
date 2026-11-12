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

const executable = pathToFileURL(remoteCli);
const upstream = 'https://automatic-onboarding.invalid';
const keys = { A: 'synthetic-automatic-key-A', B: 'synthetic-automatic-key-B', rejected: 'synthetic-rejected-key' };

test('automatic Remote onboarding uses public OAuth clients and independent per-request API keys', { timeout: 30_000 }, async t => {
    const origins = [], verifiedKeys = [], business = [], authorizations = [], connected = [];
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
    const store = { namespace: `automatic_${randomBytes(8).toString('hex')}`, maxTtlSeconds: 600, command: redis.command };
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
        const redirect = new URL(new URL(client.redirect_uris[0]).pathname, origin).href;
        const url = `${metadata.authorization_endpoint}?${new URLSearchParams({ client_id: client.client_id,
            redirect_uri: redirect, response_type: 'code', scope: 'crawl:use', resource, state,
            code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url'), ...parameters })}`;
        return { url, verifier, state, redirect, client };
    }
    async function authorize(client, key) {
        const page = browser(), flow = authorizationUrl(client);
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
        assert(html.includes(new URL(flow.redirect).origin), 'consent displays the actual validated callback origin');
        const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1]; assert(csrf);
        response = await page.fetch(interaction, { method: 'POST', headers: { origin, 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ csrf, apiToken: key, decision: 'allow' }) });
        for (let budget = 0; budget < 6; budget++) {
            assert([302, 303].includes(response.status), `authorization redirect status=${response.status}`);
            const next = new URL(response.headers.get('location'), origin);
            if (next.pathname === new URL(flow.redirect).pathname) {
                assert.equal(next.origin, origin);
                assert.equal(next.searchParams.get('state'), flow.state);
                assert.equal(next.searchParams.get('iss'), origin);
                assert(next.searchParams.get('code'));
                return { ...flow, code: next.searchParams.get('code') };
            }
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
});
