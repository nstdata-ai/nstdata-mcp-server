import assert from 'node:assert/strict';
import test from 'node:test';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtemp, writeFile, chmod, symlink, mkdir, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { cli } from './helpers.mjs';

const { parseRemoteConfig, loadRemoteConfig, RemoteConfigurationError } = await import(new URL('./remote-config.js', pathToFileURL(cli)));
const signing = (type, options, alg, kid = 'fixture-signing') => ({
    ...generateKeyPairSync(type, options).privateKey.export({ format: 'jwk' }), kid, use: 'sig', alg,
});
const rsa = signing('rsa', { modulusLength: 2048 }, 'RS256');
const ec = signing('ec', { namedCurve: 'P-256' }, 'ES256');
const encodedEncryption = randomBytes(32).toString('base64url');
const encodedFingerprint = randomBytes(32).toString('base64url');
function fixture() {
    return {
        issuerUrl: 'https://mcp.example.test', listen: { host: '0.0.0.0', port: 8443, tls: { keyFile: '/fixture/key.pem', certFile: '/fixture/cert.pem' } },
        redis: { url: 'rediss://fixture:synthetic-password@redis.example.test:6379/0', namespace: 'fixture' },
        clients: [{ clientId: 'fixture-client', clientSecret: 'synthetic-client-secret-at-least-32-bytes', redirectUris: ['https://client.example.test/oauth/callback?fixed=one'], name: 'Fixture client' }],
        cookieKeys: ['synthetic-cookie-secret-at-least-32-bytes'], jwks: { keys: [structuredClone(rsa)] },
        encryptionKeys: { current: encodedEncryption }, currentKeyId: 'current', fingerprintKey: encodedFingerprint,
    };
}
function rejected(error) {
    assert(error instanceof RemoteConfigurationError);
    assert.equal(error.message, 'Invalid Remote configuration. Check the protected configuration file.');
    assert.equal(Object.hasOwn(error, 'cause'), false);
    assert.doesNotMatch(String(error) + JSON.stringify(error), /synthetic|fixture|redis\.example|client\.example|BEGIN|\/private\//);
    return true;
}
function invalid(change) {
    const input = fixture(); change(input);
    assert.throws(() => parseRemoteConfig(input), rejected);
}

test('Remote configuration decodes deployment keys, copies data and adds no global API token', () => {
    const input = fixture(), before = structuredClone(input);
    const result = parseRemoteConfig(input);
    assert.deepEqual(input, before);
    assert.equal(result.issuerUrl, input.issuerUrl);
    assert.deepEqual(result.allowedOrigins, []);
    assert.deepEqual(Buffer.from(result.encryptionKeys.current), Buffer.from(encodedEncryption, 'base64url'));
    assert.deepEqual(Buffer.from(result.fingerprintKey), Buffer.from(encodedFingerprint, 'base64url'));
    assert.equal(Object.hasOwn(result, 'apiToken'), false);
    input.clients[0].clientSecret = 'changed'; input.jwks.keys[0].d = 'changed';
    assert.notEqual(result.clients[0].clientSecret, 'changed');
    assert.notEqual(result.jwks.keys[0].d, 'changed');
});

test('Remote configuration accepts explicit loopback development and local Unix Redis', () => {
    for (const [hostname, host] of [['127.0.0.1', '127.0.0.1'], ['[::1]', '::1']]) {
        const input = fixture();
        input.issuerUrl = `http://${hostname}:8080/`;
        input.listen = { host, port: 8080 };
        input.redis = { socketPath: '/fixture/redis.sock', namespace: 'local' };
        input.clients[0].redirectUris = [`http://${hostname}:9090/callback`];
        input.allowedOrigins = [`http://${hostname}:9090`];
        const result = parseRemoteConfig(input);
        assert.equal(result.issuerUrl, `http://${hostname}:8080`);
        assert.equal(result.redis.socketPath, input.redis.socketPath);
    }
    const input = fixture(); input.redis.url = 'redis://127.0.0.1:6379/12';
    assert.equal(parseRemoteConfig(input).redis.url, input.redis.url);
});

test('Remote configuration rejects unknown properties, coercion and malformed nested data', () => {
    for (const input of [null, [], 'synthetic-private-value', 1]) assert.throws(() => parseRemoteConfig(input), rejected);
    for (const change of [
        input => { input.apiToken = 'synthetic-private-value'; },
        input => { input.listen.extra = true; }, input => { input.redis.password = 'synthetic-private-value'; },
        input => { input.clients[0].scope = 'openid'; }, input => { input.jwks.extra = true; },
        input => { input.jwks.keys[0].extra = 'synthetic-private-value'; },
        input => { input.listen.port = '8443'; }, input => { input.listen.port = 0; }, input => { input.listen.port = 65536; },
        input => { input.listen.port = NaN; }, input => { input.listen.host = 'localhost'; },
        input => { input.clients = []; }, input => { input.cookieKeys = []; }, input => { input.encryptionKeys = {}; },
        input => { input.clients = Array.from({ length: 33 }, (_, i) => ({ ...input.clients[0], clientId: 'client-' + i })); },
    ]) invalid(change);
});

test('Remote configuration enforces exact HTTPS authority, matching loopback binds and bounded origins', () => {
    for (const issuer of ['https://mcp.example.test/path', 'https://mcp.example.test/?', 'https://mcp.example.test/#',
        'https://user:synthetic-password@mcp.example.test', 'http://mcp.example.test', 'http://localhost:8080',
        'https://MCP.EXAMPLE.TEST', 'https://mcp.example.test/../', 'https://*.example.test']) invalid(input => { input.issuerUrl = issuer; });
    invalid(input => { delete input.listen.tls; });
    invalid(input => { input.listen.tls.keyFile = 'relative.pem'; });
    invalid(input => { input.issuerUrl = 'http://127.0.0.1:8080'; input.listen = { host: '0.0.0.0', port: 8080 }; });
    invalid(input => { input.issuerUrl = 'http://127.0.0.1:8080'; input.listen = { host: '127.0.0.1', port: 8081 }; });
    invalid(input => { input.issuerUrl = 'http://127.0.0.1:8080'; input.listen.host = '127.0.0.1'; });
    for (const origin of ['https://client.example.test/path', 'https://client.example.test/', 'http://localhost:9000', 'null', '*']) {
        invalid(input => { input.allowedOrigins = [origin]; });
    }
    invalid(input => { input.allowedOrigins = ['https://client.example.test', 'https://client.example.test']; });
});

test('Remote Redis configuration rejects network downgrade, ambiguous endpoints and URL suffixes', () => {
    for (const url of ['redis://redis.example.test:6379/0', 'redis://localhost:6379', 'http://127.0.0.1:6379',
        'rediss://redis.example.test/0?', 'rediss://redis.example.test/0#', 'rediss://redis.example.test/-1',
        'rediss://redis.example.test/1.5', 'rediss://redis.example.test/00', 'rediss://redis.example.test/9007199254740992',
        'rediss://fixture:%invalid@redis.example.test/0', ' rediss://redis.example.test/0', 'rediss://redis.example.test/0\n']) invalid(input => { input.redis.url = url; });
    invalid(input => { input.redis.socketPath = '/fixture/redis.sock'; });
    invalid(input => { delete input.redis.url; });
    invalid(input => { input.redis = { socketPath: 'relative.sock', namespace: 'fixture' }; });
    invalid(input => { input.redis.namespace = 'shared:keys'; });
});

test('Remote fixed clients and callback URLs cannot introduce unregistered or malformed values', () => {
    invalid(input => { input.clients.push(structuredClone(input.clients[0])); });
    invalid(input => { input.clients[0].redirectUris.push(input.clients[0].redirectUris[0]); });
    invalid(input => { input.clients[0].clientSecret = 'too-short'; });
    invalid(input => { input.clients[0].clientId = 'bad id'; });
    invalid(input => { input.clients[0].name = '   '; });
    for (const uri of ['http://client.example.test/callback', 'https://client.example.test/callback#fragment',
        'https://user:synthetic-password@client.example.test/callback', 'https://client.example.test/*', 'https://client.example.test/callback\n']) invalid(input => { input.clients[0].redirectUris = [uri]; });
});

test('Remote signing configuration requires usable private keys with matching algorithms and unique ids', () => {
    const ed = signing('ed25519', {}, 'Ed25519');
    for (const key of [rsa, { ...rsa, alg: 'PS256' }, ec, ed, { ...ed, alg: 'EdDSA' }]) {
        const input = fixture(); input.jwks.keys = [structuredClone(key)];
        assert.equal(parseRemoteConfig(input).jwks.keys[0].alg, key.alg);
    }
    invalid(input => { delete input.jwks.keys[0].d; });
    invalid(input => { input.jwks.keys[0].use = 'enc'; });
    invalid(input => { input.jwks.keys[0].alg = 'ES256'; });
    invalid(input => { input.jwks.keys[0].key_ops = ['verify']; });
    invalid(input => { input.jwks.keys.push(structuredClone(input.jwks.keys[0])); });
    invalid(input => { input.jwks.keys[0].x = 'unused'; });
    invalid(input => { input.jwks.keys[0].d = 'invalid-signing-material'; });
    for (const field of ['n', 'e', 'd', 'p', 'q', 'dp', 'dq', 'qi']) {
        invalid(input => {
            const bytes = Buffer.from(input.jwks.keys[0][field], 'base64url'); bytes[bytes.length - 1] ^= 2;
            input.jwks.keys[0][field] = bytes.toString('base64url');
        });
    }
    invalid(input => { input.jwks.keys[0].d = randomBytes(1025).toString('base64url'); });
    invalid(input => { input.jwks.keys = [signing('rsa', { modulusLength: 1024 }, 'RS256')]; });
    invalid(input => { input.jwks.keys = [{ ...ec, d: signing('ec', { namedCurve: 'P-256' }, 'ES256').d }]; });
});

test('Remote encryption and fingerprint keys require canonical independent bytes and the current key id', () => {
    for (const value of [encodedEncryption + '=', encodedEncryption + 'x', 'a'.repeat(42), 'a'.repeat(43)]) {
        invalid(input => { input.encryptionKeys.current = value; });
    }
    invalid(input => { input.fingerprintKey = encodedEncryption; });
    invalid(input => { input.currentKeyId = 'missing'; });
    invalid(input => { input.cookieKeys = ['synthetic-cookie-value\nwith-secret-at-least-32-bytes']; });
});

test('Remote loader reads a protected regular file and protected symlink mount without changing permissions', async t => {
    const directory = await mkdtemp(path.join(tmpdir(), 'mcp-config-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const filename = path.join(directory, 'remote.json'), mounted = path.join(directory, 'mounted.json');
    await writeFile(filename, JSON.stringify(fixture()), { mode: 0o600 });
    assert.equal((await loadRemoteConfig(filename)).issuerUrl, 'https://mcp.example.test');
    if (process.platform !== 'win32') {
        await chmod(filename, 0o400);
        await symlink(filename, mounted);
        assert.equal((await loadRemoteConfig(mounted)).issuerUrl, 'https://mcp.example.test');
    }
});

test('Remote loader rejects unsafe files, malformed UTF8, excessive input and nonregular paths without leaking values', async t => {
    const directory = await mkdtemp(path.join(tmpdir(), 'mcp-config-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const filename = path.join(directory, 'synthetic-private-name.json');
    await assert.rejects(loadRemoteConfig('relative-synthetic-private-name.json'), rejected);
    await assert.rejects(loadRemoteConfig(filename), rejected);
    await assert.rejects(loadRemoteConfig(directory), rejected);
    for (const value of ['', '{"synthetic-private-value":', Buffer.from([0xff, 0xfe]), Buffer.alloc(1_048_577, 32)]) {
        await writeFile(filename, value, { mode: 0o600 });
        await assert.rejects(loadRemoteConfig(filename), rejected);
    }
    if (process.platform !== 'win32') {
        await writeFile(filename, JSON.stringify(fixture())); await chmod(filename, 0o640);
        await assert.rejects(loadRemoteConfig(filename), rejected);
        const fifo = path.join(directory, 'input.pipe');
        execFileSync('mkfifo', ['-m', '600', fifo]);
        await assert.rejects(loadRemoteConfig(fifo), rejected);
    }
    await mkdir(path.join(directory, 'nested'));
    await assert.rejects(loadRemoteConfig(path.join(directory, 'nested')), rejected);
});
