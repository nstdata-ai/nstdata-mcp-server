import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import http from 'node:http';
import { createRequire } from 'node:module';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { cli } from './helpers.mjs';

const { createOAuthProvider } = await import(new URL('./oauth-provider.js', pathToFileURL(cli)));
const { createRedisKeys, RedisStoreError } = await import(new URL('./redis/shared.js', pathToFileURL(cli)));
const fromProvider = createRequire(createRequire(cli).resolve('oidc-provider'));
const fromKoa = createRequire(fromProvider.resolve('koa'));
const Keygrip = createRequire(fromKoa.resolve('cookies'))('keygrip');
const signingKey = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'jwk' });
const binding = { id: 'b'.repeat(43), version: 1 };
const signal = () => new AbortController().signal;

// A bounded command seam exercises actual provider models and verifier branches.
// It does not emulate Redis atomicity; isolated real-Redis acceptance covers that.
function fixture(extra = {}) {
    const records = new Map(), commands = [];
    const keys = createRedisKeys('oauth_provider_unit');
    const state = { active: true, version: 1, hook: undefined };
    const execute = async args => {
        assert.equal(args[0], 'EVAL');
        if (args[2] === '6') {
            records.set(args[3], { raw: args[10], bindingId: args[14], version: String(state.version) });
            return 1;
        }
        assert.equal(args[2], '1');
        const record = records.get(args[3]);
        return record ? [record.raw, '', record.bindingId, record.bindingId ? record.version : ''] : null;
    };
    const command = async args => {
        commands.push(args);
        return state.hook ? state.hook(args, () => execute(args)) : execute(args);
    };
    const options = {
        issuerUrl: 'http://127.0.0.1:43999', resourceUrl: 'http://127.0.0.1:43999/mcp',
        clients: [{ clientId: 'fixed-client', clientSecret: 'fixture-secret-32-bytes-long-minimum', redirectUris: ['http://127.0.0.1:43999/callback'] }],
        cookieKeys: ['fixture-cookie-signing-key-at-least-32-bytes'], jwks: { keys: [{ ...signingKey, use: 'sig', alg: 'ES256' }] },
        store: { command, namespace: 'oauth_provider_unit', maxTtlSeconds: 3600 },
        credentials: {
            authorize: async () => binding, revoke: async () => false,
            resolve: async (id, version) => state.active && id === binding.id && version === state.version
                ? { subject: id, apiToken: 'virtual-upstream-key-never-a-token-claim' } : null,
        }, ...extra,
    };
    const host = createOAuthProvider(options);
    const resourceUrl = options.resourceUrl;
    const payload = (model, id) => JSON.parse(records.get(keys.record(model, id)).raw);
    const replace = (model, id, change) => {
        const record = records.get(keys.record(model, id));
        const value = JSON.parse(record.raw); change(value); record.raw = JSON.stringify(value);
    };
    async function issue() {
        const grantId = await host.createGrant(binding, 'fixed-client', ['crawl:use', 'offline_access'], signal());
        const token = new host.provider.AccessToken({ accountId: binding.id, clientId: 'fixed-client', grantId,
            scope: 'crawl:use', aud: resourceUrl, expiresIn: 60 });
        const raw = await token.save();
        return { grantId, raw };
    }
    return { host, options, records, commands, state, keys, payload, replace, issue };
}

test('provider validates fixed clients, key inputs and TTL policy before Redis', () => {
    const { options, commands } = fixture();
    for (const change of [
        { issuerUrl: 'http://public.example.test' }, { resourceUrl: 'https://example.test/mcp?x=1' },
        { clients: [] }, { cookieKeys: [] }, { cookieKeys: ['short'] }, { jwks: { keys: [] } },
        { ttl: { AccessToken: 3601 } }, { ttl: { Grant: 0 } }, { ttl: { Other: 10 } },
        { clients: [{ ...options.clients[0], clientSecret: '' }] },
        { clients: [{ ...options.clients[0], redirectUris: ['http://public.example.test/callback'] }] },
        { clients: [{ ...options.clients[0], redirectUris: ['https://example.test/*'] }] },
        { clients: [{ ...options.clients[0], redirectUris: ['https://example.test/callback#fragment'] }] },
        { clients: [options.clients[0], options.clients[0]] },
    ]) assert.throws(() => createOAuthProvider({ ...options, ...change }), /^Error: Invalid OAuth provider configuration$/);
    assert.equal(commands.length, 0);
});

test('actual discovery matches trusted metadata and rejects openid for the fixed client', async t => {
    const server = http.createServer();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const f = fixture({ issuerUrl: origin, resourceUrl: `${origin}/mcp`,
        clients: [{ clientId: 'fixed-client', clientSecret: 'fixture-secret-32-bytes-long-minimum', redirectUris: [`${origin}/callback`] }] });
    server.on('request', f.host.callback);
    const response = await fetch(`${origin}/.well-known/openid-configuration`);
    assert.equal(response.status, 200);
    const discovery = await response.json();
    for (const [field, value] of Object.entries(f.host.metadata)) assert.deepEqual(discovery[field], value, field);
    assert.equal(discovery.registration_endpoint, undefined);
    assert.equal(discovery.client_id_metadata_document_supported, undefined);
    assert.equal(discovery.userinfo_endpoint, undefined);
    assert.equal(discovery.end_session_endpoint, undefined);
    assert.equal(discovery.pushed_authorization_request_endpoint, undefined);
    assert.equal(discovery.dpop_signing_alg_values_supported, undefined);
    const auth = new URL(`${origin}/auth`);
    auth.search = new URLSearchParams({ client_id: 'fixed-client', redirect_uri: f.options.clients[0].redirectUris[0],
        response_type: 'code', scope: 'openid crawl:use', state: 'fixture-state', code_challenge: 'x'.repeat(43), code_challenge_method: 'S256' });
    const denied = await fetch(auth, { redirect: 'manual' });
    assert.equal(denied.status, 303);
    assert.equal(new URL(denied.headers.get('location')).searchParams.get('error'), 'invalid_scope');
    assert.equal(f.commands.length, 0);
});

test('actual login policy requests fresh authorization for missing or inactive current-client grants', { timeout: 5000 }, async t => {
    const server = http.createServer();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const f = fixture({ issuerUrl: origin, resourceUrl: `${origin}/mcp`,
        clients: [{ clientId: 'fixed-client', clientSecret: 'fixture-secret-32-bytes-long-minimum', redirectUris: [`${origin}/callback`] }] });
    server.on('request', f.host.callback);
    for (const inactive of [false, true]) {
        f.state.active = true;
        const session = new f.host.provider.Session();
        session.loginAccount({ accountId: binding.id });
        if (inactive) {
            const grantId = await f.host.createGrant(binding, 'fixed-client', ['crawl:use'], signal());
            session.grantIdFor('fixed-client', grantId);
            f.state.active = false;
        }
        await session.save(300);
        const name = f.host.provider.cookieName('session');
        const cookie = `${name}=${session.id}`;
        const auth = `${origin}/auth?${new URLSearchParams({ client_id: 'fixed-client', redirect_uri: `${origin}/callback`,
            response_type: 'code', scope: 'crawl:use', state: 'policy-fixture', resource: `${origin}/mcp`,
            code_challenge_method: 'S256', code_challenge: 'x'.repeat(43) })}`;
        const response = await fetch(auth, { redirect: 'manual', headers: { cookie: `${cookie}; ${name}.sig=${new Keygrip(f.options.cookieKeys).sign(cookie)}` } });
        assert.equal(response.status, 303);
        const destination = new URL(response.headers.get('location'), origin);
        assert(destination.pathname.startsWith('/oauth/interaction/'));
        const interaction = await f.host.provider.Interaction.find(destination.pathname.split('/').at(-1));
        assert.equal(interaction.prompt.name, 'login');
        assert(interaction.prompt.reasons.includes('missing_live_account'));
    }
});

test('native callback aborts block later provider commands without leaking between request contexts', { timeout: 5000 }, async t => {
    const server = http.createServer();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const f = fixture({ issuerUrl: origin, resourceUrl: `${origin}/mcp`,
        clients: [{ clientId: 'fixed-client', clientSecret: 'fixture-secret-32-bytes-long-minimum', redirectUris: [`${origin}/callback`] }] });
    f.host.provider.silent = true;
    let requestSignal = AbortSignal.abort(), completed, failure;
    server.on('request', (request, response) => {
        completed = f.host.callback(request, response, requestSignal).catch(error => {
            failure = error;
            if (!response.writableEnded) { response.statusCode = 503; response.end('Service unavailable'); }
        });
    });
    let response = await fetch(`${origin}/.well-known/openid-configuration`);
    await response.arrayBuffer(); await completed;
    assert.equal(response.status, 503);
    assert(failure instanceof RedisStoreError);
    assert.equal(f.commands.length, 0);

    const controller = new AbortController();
    requestSignal = controller.signal;
    failure = undefined;
    let release, started;
    const pending = new Promise(resolve => { release = resolve; });
    const entered = new Promise(resolve => { started = resolve; });
    f.state.hook = async (args, next) => {
        if (args[2] === '6' && JSON.parse(args[10]).kind === 'Interaction') { started(); await pending; }
        return next();
    };
    const auth = `${origin}/auth?${new URLSearchParams({ client_id: 'fixed-client', redirect_uri: `${origin}/callback`,
        response_type: 'code', scope: 'crawl:use', resource: `${origin}/mcp`, state: 'abort-fixture',
        code_challenge_method: 'S256', code_challenge: 'x'.repeat(43) })}`;
    const waiting = fetch(auth, { redirect: 'manual' });
    await entered;
    const independentGrant = await f.host.createGrant(binding, 'fixed-client', ['crawl:use'], signal());
    assert(independentGrant);
    controller.abort(); release();
    response = await waiting;
    await response.arrayBuffer(); await completed;
    assert.equal(response.status, 500);
    assert(failure instanceof RedisStoreError);
    assert.equal(f.commands.length, 4, 'one sent Interaction save and three independent live-Grant commands, without a retry');

    requestSignal = undefined;
    response = await fetch(`${origin}/.well-known/openid-configuration`);
    await response.arrayBuffer(); await completed;
    assert.equal(response.status, 200, 'an unrelated callback without a signal retains its own context');
});

test('real opaque token resolves only its live grant and exact encrypted-binding generation', async () => {
    const f = fixture();
    const { grantId, raw } = await f.issue();
    assert.match(raw, /^[A-Za-z0-9_-]{43}$/);
    const verified = await f.host.verifyCredential(raw, signal());
    assert.deepEqual(verified.identity, { subject: binding.id, apiToken: 'virtual-upstream-key-never-a-token-claim' });
    assert.equal(verified.authInfo.clientId, 'fixed-client');
    assert.equal(verified.authInfo.resource.href, f.options.resourceUrl);
    assert.deepEqual(verified.authInfo.scopes, ['crawl:use']);
    assert.equal(verified.authInfo.expiresAt, f.payload('AccessToken', raw).exp);
    assert(!JSON.stringify(f.payload('Grant', grantId)).includes('virtual-upstream-key'));
    assert(!JSON.stringify(f.payload('AccessToken', raw)).includes('virtual-upstream-key'));
    f.state.version = 2;
    assert.equal(await f.host.verifyCredential(raw, signal()), null);
    f.state.version = 1; f.state.active = false;
    assert.equal(await f.host.verifyCredential(raw, signal()), null);
});

test('caller mutation cannot replace trusted store, client or credential-verifier configuration', async () => {
    const f = fixture();
    const callback = f.options.clients[0].redirectUris[0];
    f.options.issuerUrl = 'https://changed.example.test';
    f.options.resourceUrl = 'https://changed.example.test/mcp';
    f.options.clients[0].clientSecret = 'changed-secret';
    f.options.clients[0].redirectUris[0] = 'https://changed.example.test/callback';
    f.options.cookieKeys[0] = 'changed-cookie-key';
    f.options.store.maxTtlSeconds = 1;
    f.options.store.command = async () => { throw new Error('changed-store'); };
    f.options.credentials.resolve = async () => ({ subject: binding.id, apiToken: 'changed-upstream-key' });
    const { raw } = await f.issue();
    const verified = await f.host.verifyCredential(raw, signal());
    assert.equal(verified.identity.apiToken, 'virtual-upstream-key-never-a-token-claim');
    assert.equal(verified.authInfo.resource.href, 'http://127.0.0.1:43999/mcp');
    assert.deepEqual((await f.host.provider.Client.find('fixed-client')).redirectUris, [callback]);
    assert.equal(f.host.metadata.issuer, 'http://127.0.0.1:43999');
});

test('model-valid orphan token is denied without a live Grant', async () => {
    const f = fixture();
    const { grantId, raw } = await f.issue();
    f.records.delete(f.keys.record('Grant', grantId));
    assert.equal((await f.host.provider.AccessToken.find(raw)).isValid, true);
    assert.equal(await f.host.verifyCredential(raw, signal()), null);
});

test('verifier rejects expiry, audience, client, account, sender binding and ungranted scopes', async () => {
    for (const [model, change] of [
        ['AccessToken', token => { token.exp = Math.floor(Date.now() / 1000) - 1; }],
        ['AccessToken', token => { token.aud = 'https://other.example.test/mcp'; }],
        ['AccessToken', token => { token.clientId = 'unregistered-client'; }],
        ['AccessToken', token => { token.accountId = 'other-binding'; }],
        ['AccessToken', token => { token.jkt = 'sender-thumbprint'; }],
        ['AccessToken', token => { token.scope = 'crawl:other'; }],
        ['Grant', grant => { grant.clientId = 'different-client'; }],
        ['Grant', grant => { grant.accountId = 'other-binding'; }],
        ['Grant', grant => { grant.resources = {}; }],
        ['Grant', grant => { grant.exp = Math.floor(Date.now() / 1000) - 1; }],
    ]) {
        const f = fixture();
        const { grantId, raw } = await f.issue();
        f.replace(model, model === 'Grant' ? grantId : raw, change);
        assert.equal(await f.host.verifyCredential(raw, signal()), null);
    }
    const f = fixture(), { raw } = await f.issue();
    f.replace('AccessToken', raw, token => { token.scope = ''; });
    assert.deepEqual((await f.host.verifyCredential(raw, signal())).authInfo.scopes, []);
});

test('grant creation refuses unknown scopes, stale bindings and clients before saving', async () => {
    const f = fixture();
    for (const [currentBinding, clientId, grantedScopes] of [
        [binding, 'unknown', ['crawl:use']], [binding, 'fixed-client', ['openid', 'crawl:use']],
        [binding, 'fixed-client', ['offline_access']], [{ ...binding, version: 2 }, 'fixed-client', ['crawl:use']],
    ]) await assert.rejects(f.host.createGrant(currentBinding, clientId, grantedScopes, signal()), error => error.error === 'invalid_grant');
    assert.equal(f.commands.length, 0);
});

test('aborts stop subsequent reads and ambiguous writes never replay or leak store errors', async () => {
    const f = fixture(), { raw } = await f.issue();
    const before = f.commands.length;
    await assert.rejects(f.host.verifyCredential(raw, AbortSignal.abort()), RedisStoreError);
    assert.equal(f.commands.length, before);
    const controller = new AbortController();
    f.state.hook = async args => {
        const record = f.records.get(args[3]); controller.abort();
        return [record.raw, '', record.bindingId, record.bindingId ? record.version : ''];
    };
    await assert.rejects(f.host.verifyCredential(raw, controller.signal), RedisStoreError);
    assert.equal(f.commands.length, before + 1);
    f.state.hook = async () => { throw new Error('redis://private-user:private-secret@private-host'); };
    const writesBefore = f.commands.length;
    await assert.rejects(f.host.createGrant(binding, 'fixed-client', ['crawl:use'], signal()), error =>
        error instanceof RedisStoreError && error.message === 'Redis storage unavailable' && error.cause === undefined);
    assert.equal(f.commands.length, writesBefore + 1);
    await assert.rejects(f.host.verifyCredential(raw, signal()), error =>
        error instanceof RedisStoreError && !error.message.includes('private') && error.cause === undefined);
    assert.equal(f.commands.length, writesBefore + 2);
});
