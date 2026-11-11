import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { isolatedRedis } from './redis-fixture.mjs';
import { remoteCli } from '../helpers.mjs';

const executable = pathToFileURL(remoteCli);
const { startRemoteService, loadRemoteTls } = await import(new URL('./remote-service.js', executable));
const { privateKey } = generateKeyPairSync('ed25519');
const signingKey = { ...privateKey.export({ format: 'jwk' }), kid: 'fixture', use: 'sig', alg: 'Ed25519' };
const unavailable = 'Remote service unavailable. Check deployment configuration and Redis.';

async function port() {
    const server = net.createServer();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const number = server.address().port;
    await new Promise(resolve => server.close(resolve));
    return number;
}
function config(number, socketPath, secure = false) {
    const issuerUrl = `${secure ? 'https' : 'http'}://127.0.0.1:${number}`;
    return { issuerUrl, listen: { host: '127.0.0.1', port: number }, redis: { socketPath, namespace: 'fixture_' + randomBytes(6).toString('hex') },
        clients: [{ clientId: 'fixture-client', clientSecret: 'synthetic-client-secret-20261106-test', redirectUris: [`${issuerUrl}/callback`] }],
        cookieKeys: ['synthetic-cookie-key-20261106-test'], jwks: { keys: [signingKey] },
        encryptionKeys: { fixture: randomBytes(32) }, currentKeyId: 'fixture', fingerprintKey: randomBytes(32), allowedOrigins: [] };
}
async function request(url, options = {}) {
    return new Promise((resolve, reject) => {
        const parsed = new URL(url), transport = parsed.protocol === 'https:' ? https : http;
        const { body, ...settings } = options;
        const incoming = transport.request(parsed, { ...settings, agent: false }, response => {
            const chunks = [];
            response.on('data', data => chunks.push(data));
            response.once('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }));
        });
        incoming.once('error', reject); incoming.end(body);
    });
}

for (const mcpPath of [undefined, '/crawl']) test(`Remote service starts only after Redis readiness and serves health and OAuth discovery at ${mcpPath ?? '/mcp'}`, async t => {
    const origins = [];
    const redis = await isolatedRedis(t, { allowedOrigins: () => origins });
    const options = config(await port(), redis.socketPath); origins.push(options.issuerUrl);
    if (mcpPath !== undefined) options.mcpPath = mcpPath;
    const service = await startRemoteService(options);
    t.after(() => service.close());
    assert.equal(service.address.port, options.listen.port);
    for (const route of ['/health/live', '/health/ready']) {
        const response = await request(options.issuerUrl + route);
        assert.equal(response.status, 200); assert.deepEqual(JSON.parse(response.body), { status: 'ok' });
        assert.equal(response.headers['cache-control'], 'no-store');
        const denied = await request(options.issuerUrl + route, { method: 'POST' });
        assert.equal(denied.status, 405); assert.equal(denied.headers.allow, 'GET');
        assert.equal((await request(options.issuerUrl + route, { headers: { host: 'untrusted.invalid' } })).status, 400);
        assert.equal((await request(options.issuerUrl + route, { headers: { 'x-forwarded-host': 'untrusted.invalid' } })).status, 400);
    }
    const discovery = await request(options.issuerUrl + '/.well-known/openid-configuration');
    assert.equal(discovery.status, 200); assert.equal(JSON.parse(discovery.body).issuer, options.issuerUrl);
    const canonicalPath = mcpPath ?? '/mcp';
    const denied = await request(options.issuerUrl + canonicalPath, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
    assert.equal(denied.status, 401); assert.match(denied.headers['www-authenticate'], /Bearer/);
    assert(denied.headers['www-authenticate'].includes(`resource_metadata="${options.issuerUrl}/.well-known/oauth-protected-resource${canonicalPath}"`));
    const resourceDiscovery = await request(options.issuerUrl + '/.well-known/oauth-protected-resource' + canonicalPath);
    assert.equal(resourceDiscovery.status, 200);
    assert.equal(JSON.parse(resourceDiscovery.body).resource, options.issuerUrl + canonicalPath);
    const alternate = await request(options.issuerUrl + (canonicalPath === '/mcp' ? '/crawl' : '/mcp'));
    assert.equal(alternate.status, 404); assert.equal(alternate.headers.location, undefined);
    await service.close(); await service.close(); await service.closed;
    await assert.rejects(request(options.issuerUrl + '/health/live'));
});

test('Remote admission bounds a 120-request burst before Redis and releases completed or cancelled work once', { timeout: 10000 }, async t => {
    const sockets = new Set(), replies = [], requests = [], results = [];
    let held = true, evaluations = 0, service;
    const redis = net.createServer(socket => {
        sockets.add(socket); socket.once('close', () => sockets.delete(socket));
        let buffer = Buffer.alloc(0);
        socket.on('data', bytes => {
            buffer = Buffer.concat([buffer, bytes]);
            while (buffer.length) {
                const end = buffer.indexOf('\r\n');
                if (end < 0) return;
                const count = Number(buffer.toString('utf8', 1, end)), args = [];
                let offset = end + 2;
                for (let index = 0; index < count; index++) {
                    const next = buffer.indexOf('\r\n', offset);
                    if (next < 0) return;
                    const size = Number(buffer.toString('utf8', offset + 1, next));
                    if (buffer.length < next + 2 + size + 2) return;
                    args.push(buffer.toString('utf8', next + 2, next + 2 + size));
                    offset = next + 2 + size + 2;
                }
                buffer = buffer.subarray(offset);
                if (args[0] === 'PING') socket.write('+PONG\r\n');
                else {
                    assert.equal(args[0], 'EVAL'); evaluations++;
                    const respond = () => { if (!socket.destroyed) socket.write(':1\r\n'); };
                    if (held) replies.push(respond); else respond();
                }
            }
        });
    });
    await new Promise(resolve => redis.listen(0, '127.0.0.1', resolve));
    const options = config(await port());
    options.redis = { url: `redis://127.0.0.1:${redis.address().port}/0`, namespace: options.redis.namespace };
    const connect = net.Socket.prototype.connect, fetch = globalThis.fetch;
    const allowedPorts = [redis.address().port, options.listen.port];
    net.Socket.prototype.connect = function (...args) {
        const first = Array.isArray(args[0]) ? args[0][0] : args[0];
        if (first && typeof first === 'object' && first.host === '127.0.0.1' && allowedPorts.includes(Number(first.port))) return connect.apply(this, args);
        throw new Error('Admission test blocked an unexpected socket');
    };
    globalThis.fetch = async () => { throw new Error('Admission test blocked an upstream request'); };
    t.after(async () => {
        try {
            for (const pending of requests) pending.request.destroy();
            await service?.close();
            for (const socket of sockets) socket.destroy();
            await new Promise(resolve => redis.close(resolve));
        } finally { net.Socket.prototype.connect = connect; globalThis.fetch = fetch; }
    });
    service = await startRemoteService(options);
    const parameters = new URLSearchParams({ client_id: 'fixture-client', redirect_uri: options.clients[0].redirectUris[0],
        response_type: 'code', scope: 'crawl:use', resource: options.issuerUrl + '/mcp',
        code_challenge: randomBytes(32).toString('base64url'), code_challenge_method: 'S256' });
    const send = () => {
        const pending = { done: false };
        pending.result = new Promise(resolve => {
            const finish = result => { if (!pending.done) { pending.done = true; results.push(result); resolve(result); } };
            pending.request = http.get(options.issuerUrl + '/auth?' + parameters, { agent: false }, response => {
                let body = '';
                response.on('data', bytes => { body += bytes; });
                response.once('end', () => finish({ status: response.statusCode, body }));
                response.once('error', () => finish({ status: 'disconnected' }));
            });
            pending.request.once('error', () => finish({ status: 'disconnected' }));
        });
        requests.push(pending); return pending;
    };
    const until = async predicate => {
        const deadline = Date.now() + 1200;
        while (!predicate() && Date.now() < deadline) await delay(5);
        assert(predicate(), 'expected fixture progress before the Redis command deadline');
    };
    const release = () => { held = false; for (const respond of replies.splice(0)) respond(); };

    for (const round of [0, 1, 2]) {
        held = true;
        const beforeResults = results.length, beforeEvaluations = evaluations;
        const burst = Array.from({ length: 120 }, send);
        await until(() => results.length - beforeResults >= 88);
        assert.equal(results.length - beforeResults, 88);
        assert(results.slice(beforeResults).every(result => result.status === 503 && result.body === '{"status":"unavailable"}'));
        assert.equal(evaluations - beforeEvaluations, 32, 'only admitted requests reach the Redis queue');
        for (const endpoint of ['/health/live', '/health/ready']) assert.equal((await request(options.issuerUrl + endpoint)).status, 200);
        if (round === 1) {
            const cancelled = burst.find(pending => !pending.done);
            cancelled.request.destroy(); await until(() => cancelled.done);
            const replacement = send();
            await until(() => replacement.done || evaluations - beforeEvaluations > 32);
            assert.equal((await replacement.result).status, 503, 'a disconnected handler keeps its slot until its Redis command settles');
            assert.equal(evaluations - beforeEvaluations, 32);
        }
        release();
        const completed = await Promise.all(burst.map(pending => pending.result));
        assert.equal(completed.filter(result => result.status === 303).length, round === 1 ? 31 : 32);
        assert.equal((await request(options.issuerUrl + '/health/ready')).status, 200);
    }
});

test('Remote startup cleans its Redis connection when the listener is occupied', async t => {
    const redis = await isolatedRedis(t);
    const occupied = net.createServer();
    await new Promise(resolve => occupied.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => occupied.close(resolve)));
    const options = config(occupied.address().port, redis.socketPath);
    await assert.rejects(startRemoteService(options), error => error.message === unavailable);
    assert(occupied.listening, 'startup failure does not close a listener it does not own');
    assert.equal(await redis.command(['PING']), 'PONG');
});

test('Remote service rejects unsafe direct configuration before opening any connection', async t => {
    const redis = await isolatedRedis(t);
    const options = config(await port(), redis.socketPath);
    const connect = net.Socket.prototype.connect;
    let connections = 0;
    net.Socket.prototype.connect = function (...args) { connections++; return connect.apply(this, args); };
    try {
        for (const input of [
            { ...options, issuerUrl: options.issuerUrl.replace('http:', 'https:') },
            { ...options, issuerUrl: 'http://public.invalid', listen: { ...options.listen, host: '0.0.0.0' } },
            { ...options, issuerUrl: 'http://127.0.0.1:' + (options.listen.port === 65535 ? 65534 : options.listen.port + 1) },
            { ...options, redis: { namespace: options.redis.namespace } },
            { ...options, redis: { namespace: options.redis.namespace, url: 'redis://public.invalid:6379/0' } },
            ...['/auth', '/crawl/', '/crawl?private=yes', false].map(mcpPath => ({ ...options, mcpPath })),
        ]) await assert.rejects(startRemoteService(input), error => error.message === unavailable);
        assert.equal(connections, 0);
    } finally { net.Socket.prototype.connect = connect; }
});

test('Remote startup fails with a constant error when owned Redis is unavailable', async t => {
    const redis = await isolatedRedis(t);
    const options = config(await port(), redis.socketPath);
    await redis.stop();
    const before = performance.now();
    await assert.rejects(startRemoteService(options), error => error.message === unavailable && !error.message.includes(redis.socketPath));
    assert(performance.now() - before < 6000);
});

test('Redis disconnect fails closed and releases the listener without reconnecting', async t => {
    const origins = [];
    const redis = await isolatedRedis(t, { allowedOrigins: () => origins });
    const options = config(await port(), redis.socketPath); origins.push(options.issuerUrl);
    const service = await startRemoteService(options); t.after(() => service.close());
    const stopped = assert.rejects(service.closed, error => error.message === unavailable);
    await redis.stop(); await stopped; await service.close();
    const replacement = net.createServer();
    await new Promise((resolve, reject) => { replacement.once('error', reject); replacement.listen(options.listen.port, '127.0.0.1', resolve); });
    await new Promise(resolve => replacement.close(resolve));
});

test('Remote startup bounds a Redis authentication handshake and destroys the stalled socket', { timeout: 9000 }, async t => {
    const origins = [];
    await isolatedRedis(t, { allowedOrigins: () => origins });
    const sockets = new Set(); let received = false;
    const stalled = net.createServer(socket => {
        sockets.add(socket); socket.on('data', () => { received = true; }); socket.once('close', () => sockets.delete(socket));
    });
    await new Promise(resolve => stalled.listen(0, '127.0.0.1', resolve));
    t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => stalled.close(resolve)); });
    origins.push(`http://127.0.0.1:${stalled.address().port}`);
    const options = config(await port());
    delete options.redis.socketPath;
    options.redis.url = `redis://fixture:synthetic-password@127.0.0.1:${stalled.address().port}/0`;
    const before = performance.now();
    await assert.rejects(startRemoteService(options), error => error.message === unavailable);
    assert(received, 'the actual Redis handshake reached the owned socket');
    assert(performance.now() - before >= 4000 && performance.now() - before < 7000);
    await delay(30); assert.equal(sockets.size, 0);
});

test('An in-flight Redis command deadline terminates the service without replay', { timeout: 6500 }, async t => {
    const origins = [];
    await isolatedRedis(t, { allowedOrigins: () => origins });
    const sockets = new Set(); let connections = 0, traffic = '';
    const ping = '*1\r\n$4\r\nPING\r\n';
    const stalled = net.createServer(socket => {
        connections++; sockets.add(socket); let initial = '';
        socket.on('data', data => {
            traffic += data.toString('utf8');
            if (initial !== null) {
                initial += data.toString('utf8');
                if (initial.startsWith(ping)) { socket.write('+PONG\r\n'); initial = null; }
            }
        });
        socket.once('close', () => sockets.delete(socket));
    });
    await new Promise(resolve => stalled.listen(0, '127.0.0.1', resolve));
    t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => stalled.close(resolve)); });
    origins.push(`http://127.0.0.1:${stalled.address().port}`);
    const options = config(await port()); delete options.redis.socketPath;
    options.redis.url = `redis://127.0.0.1:${stalled.address().port}/0`; origins.push(options.issuerUrl);
    const service = await startRemoteService(options); t.after(() => service.close());
    const stopped = assert.rejects(service.closed, error => error.message === unavailable);
    const parameters = new URLSearchParams({ client_id: 'fixture-client', redirect_uri: options.clients[0].redirectUris[0],
        response_type: 'code', scope: 'crawl:use', resource: options.issuerUrl + '/mcp',
        code_challenge: randomBytes(32).toString('base64url'), code_challenge_method: 'S256' });
    const before = performance.now();
    const pending = request(options.issuerUrl + '/auth?' + parameters).catch(() => null);
    await stopped; await service.close(); await pending;
    assert(performance.now() - before >= 1500 && performance.now() - before < 4000);
    await delay(30); assert.equal(connections, 1); assert.equal(sockets.size, 0);
    assert.equal((traffic.match(/\r\n\$4\r\nEVAL\r\n/g) ?? []).length, 1, 'the storage write is not replayed after its result becomes unknown');
});

test('Remote shutdown aborts an incomplete native OAuth request', async t => {
    const origins = [];
    const redis = await isolatedRedis(t, { allowedOrigins: () => origins });
    const options = config(await port(), redis.socketPath); origins.push(options.issuerUrl);
    const service = await startRemoteService(options); t.after(() => service.close());
    const pending = http.request(options.issuerUrl + '/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Transfer-Encoding': 'chunked' }, agent: false });
    const ended = new Promise(resolve => { pending.once('error', resolve); pending.once('close', resolve); });
    pending.write('grant_type=refresh_token&');
    await delay(50);
    const before = performance.now();
    await service.close(); await service.closed; await ended;
    assert(performance.now() - before < 2000, 'handler shutdown aborts native parsing before the listener grace period');
});

test('Remote TLS validates protected matching keys and serves actual HTTPS', { timeout: 10000 }, async t => {
    const origins = [];
    const redis = await isolatedRedis(t, { allowedOrigins: () => origins });
    const directory = await fs.mkdtemp(path.join(tmpdir(), 'remote-tls-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const keyFile = path.join(directory, 'key.pem'), certFile = path.join(directory, 'cert.pem');
    const { privateKey: tlsKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    await fs.writeFile(keyFile, tlsKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    execFileSync('openssl', ['req', '-x509', '-new', '-sha256', '-key', keyFile, '-out', certFile, '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { timeout: 5000, stdio: 'pipe' });
    const options = config(await port(), redis.socketPath, true); options.listen.tls = { keyFile, certFile };
    origins.push('http://127.0.0.1:' + options.listen.port);
    const loaded = await loadRemoteTls(options.listen.tls, options.issuerUrl);
    assert.equal(loaded.minVersion, 'TLSv1.2');
    await assert.rejects(loadRemoteTls(options.listen.tls, 'https://wrong.invalid'), /Invalid Remote TLS configuration/);
    await fs.chmod(keyFile, 0o644);
    await assert.rejects(loadRemoteTls(options.listen.tls), /Invalid Remote TLS configuration/);
    await fs.chmod(keyFile, 0o600);
    const service = await startRemoteService(options); t.after(() => service.close());
    const ca = await fs.readFile(certFile);
    const response = await request(options.issuerUrl + '/health/ready', { ca });
    assert.equal(response.status, 200);
    assert.equal(JSON.parse((await request(options.issuerUrl + '/.well-known/openid-configuration', { ca })).body).issuer, options.issuerUrl);
    await assert.rejects(request(options.issuerUrl + '/health/ready'), /self-signed certificate/i);
    const otherKey = path.join(directory, 'other.pem');
    await fs.writeFile(otherKey, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    await assert.rejects(loadRemoteTls({ keyFile: otherKey, certFile }), /Invalid Remote TLS configuration/);
});

test('Remote CLI sends DNS SNI to Redis without disabling certificate verification', { timeout: 10000 }, async t => {
    const origins = [];
    await isolatedRedis(t, { allowedOrigins: () => origins });
    const directory = await fs.mkdtemp(path.join(tmpdir(), 'redis-sni-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const keyFile = path.join(directory, 'redis-key.pem'), certFile = path.join(directory, 'redis-ca.pem');
    const { privateKey: redisKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    await fs.writeFile(keyFile, redisKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    execFileSync('openssl', ['req', '-x509', '-new', '-sha256', '-key', keyFile, '-out', certFile, '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost'], { timeout: 5000, stdio: 'pipe' });
    const key = await fs.readFile(keyFile), cert = await fs.readFile(certFile), context = tls.createSecureContext({ key, cert });
    const sockets = new Set(), names = []; let pings = 0, child, childClosed;
    const redis = tls.createServer({ key, cert, minVersion: 'TLSv1.2', SNICallback(name, callback) {
        names.push(name); callback(name === 'localhost' ? null : new Error('Required SNI missing'), context);
    } }, socket => {
        if (socket.servername !== 'localhost') { socket.destroy(); return; }
        let received = '';
        socket.on('data', data => {
            received += data.toString('utf8');
            if (received === '*1\r\n$4\r\nPING\r\n') { pings++; socket.write('+PONG\r\n'); received = ''; }
        });
        socket.on('error', () => {});
    });
    redis.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
    redis.on('tlsClientError', () => {});
    t.after(async () => {
        if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
        const timer = setTimeout(() => child?.kill('SIGKILL'), 2000);
        try { await childClosed; } finally { clearTimeout(timer); }
        for (const socket of sockets) socket.destroy();
        await new Promise(resolve => redis.close(resolve));
    });
    await new Promise(resolve => redis.listen(0, '127.0.0.1', resolve));
    const redisPort = redis.address().port, options = config(await port()); origins.push(options.issuerUrl);
    options.redis = { url: `rediss://localhost:${redisPort}/0`, namespace: options.redis.namespace };
    const wire = { ...options, encryptionKeys: Object.fromEntries(Object.entries(options.encryptionKeys).map(([id, bytes]) => [id, Buffer.from(bytes).toString('base64url')])),
        fingerprintKey: Buffer.from(options.fingerprintKey).toString('base64url') };
    const filename = path.join(directory, 'remote.json'), guard = path.join(directory, 'guard.cjs');
    await fs.writeFile(filename, JSON.stringify(wire), { mode: 0o600 });
    await fs.writeFile(guard, `const net=require('node:net'),connect=net.Socket.prototype.connect;
net.Socket.prototype.connect=function(...args){
 const o=Array.isArray(args[0])?args[0][0]:args[0];
 if(o&&typeof o==='object'&&o.host==='localhost'&&Number(o.port)===${redisPort}){o.host='127.0.0.1';return Reflect.apply(connect,this,args);}
 process.exitCode=91;throw new Error('Unexpected connection blocked');
};
globalThis.fetch=async()=>{process.exitCode=91;throw new Error('Upstream request blocked');};\n`);
    let stdout = '', stderr = '';
    const launch = trusted => {
        stdout = ''; stderr = '';
        child = spawn(process.execPath, ['--require', guard, fileURLToPath(new URL('./remote.js', executable)), '--config', filename], {
            env: { PATH: process.env.PATH, HOME: directory, ...(trusted ? { NODE_EXTRA_CA_CERTS: certFile } : {}) }, stdio: ['ignore', 'pipe', 'pipe'] });
        childClosed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
        child.on('error', () => {});
        child.stdout.on('data', bytes => { stdout = (stdout + bytes).slice(-8192); });
        child.stderr.on('data', bytes => { stderr = (stderr + bytes).slice(-8192); });
    };
    launch(false); assert.deepEqual(await childClosed, { code: 1, signal: null });
    assert.equal(stdout, ''); assert.equal(pings, 0); assert.match(stderr, /^Remote service unavailable\./);
    names.length = 0; launch(true);
    const deadline = Date.now() + 7000;
    while (!stdout.includes('Nstdata Remote service started.') && child.exitCode === null && Date.now() < deadline) await delay(20);
    assert.match(stdout, /Nstdata Remote service started\./, stderr); assert.equal(stderr, '');
    assert.equal((await request(options.issuerUrl + '/health/ready')).status, 200);
    assert.deepEqual(names, ['localhost']); assert.equal(pings, 1);
    child.kill('SIGTERM'); assert.deepEqual(await childClosed, { code: 0, signal: null });
});


test('HTTPS gateway to HTTP Remote preserves OAuth, secure cookies and authenticated MCP while rejecting proxy bypass', { timeout: 20000 }, async t => {
    const origins = [], syntheticKey = 'synthetic-proxy-upstream-key';
    let userLookups = 0, crawlCalls = 0, service, gateway, client;
    const redis = await isolatedRedis(t, { allowedOrigins: () => origins, virtualFetch: async (input, url) => {
        if (url.origin !== 'https://api.nstdata.io') return undefined;
        assert.equal(input.headers.get('x-api-key'), syntheticKey);
        if (url.pathname === '/api/v1/api/user/info') {
            userLookups++;
            return Response.json({ code: 200, err: false, msg: 'SUCCESS', data: { email: 'proxy@example.test', balance: 1, referralBalance: 0 } });
        }
        assert.equal(url.pathname, '/api/v1/crawl/existing-proxy-fixture');
        crawlCalls++;
        return Response.json({ code: 200, err: false, msg: 'SUCCESS', data: { status: 'processing', pending: 1 } });
    } });
    const directory = await fs.mkdtemp(path.join(tmpdir(), 'remote-proxy-'));
    const keyFile = path.join(directory, 'key.pem'), certFile = path.join(directory, 'cert.pem');
    const { privateKey: gatewayKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    await fs.writeFile(keyFile, gatewayKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    execFileSync('openssl', ['req', '-x509', '-new', '-sha256', '-key', keyFile, '-out', certFile, '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { timeout: 5000, stdio: 'pipe' });
    const ca = await fs.readFile(certFile), backendPort = await port();
    gateway = https.createServer({ key: await fs.readFile(keyFile), cert: ca }, (incoming, outgoing) => {
        assert(incoming.socket.encrypted);
        const headers = { ...incoming.headers };
        for (const name of ['forwarded', 'x-forwarded-host', 'x-forwarded-port', 'x-forwarded-proto']) delete headers[name];
        headers['x-forwarded-proto'] = 'https';
        const proxied = http.request({ host: '127.0.0.1', port: backendPort, path: incoming.url, method: incoming.method, headers, agent: false }, response => {
            outgoing.writeHead(response.statusCode, response.headers); response.pipe(outgoing);
        });
        proxied.once('error', () => { if (!outgoing.headersSent) outgoing.writeHead(502); outgoing.end(); });
        incoming.pipe(proxied);
    });
    await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve));
    const origin = `https://127.0.0.1:${gateway.address().port}`, backend = `http://127.0.0.1:${backendPort}`;
    origins.push(backend, origin.replace('https:', 'http:'));
    t.after(async () => {
        await client?.close().catch(() => {}); await service?.close();
        gateway.closeAllConnections(); await new Promise(resolve => gateway.close(resolve));
        await fs.rm(directory, { recursive: true, force: true });
    });
    const options = config(backendPort, redis.socketPath);
    options.issuerUrl = origin; options.trustedProxyCidrs = ['127.0.0.1/32'];
    options.clients[0].redirectUris = [origin + '/callback'];
    service = await startRemoteService(options);
    const headers = { host: new URL(origin).host };
    for (const endpoint of ['/health/live', '/health/ready']) {
        assert.equal((await request(backend + endpoint)).status, 200, 'load balancer IP Host is accepted only for health');
        assert.equal((await request(backend + endpoint, { headers })).status, 200, 'kubelet fixed Host is accepted without proxy headers');
        assert.equal((await request(origin + endpoint, { ca })).status, 200, 'gateway health passes the normal proxy boundary');
    }
    for (const endpoint of ['/mcp', '/.well-known/openid-configuration', '/health/ready/extra']) {
        assert.equal((await request(backend + endpoint, { headers })).status, 400);
        assert.equal((await request(backend + endpoint)).status, 400);
    }
    for (const changed of [{}, { 'x-forwarded-proto': 'http' }, { 'x-forwarded-proto': 'https, http' },
        { 'x-forwarded-proto': 'https', forwarded: '' }, { 'x-forwarded-proto': 'https', 'x-forwarded-host': '' },
        { 'x-forwarded-proto': 'https', 'x-forwarded-port': '443' }]) {
        assert.equal((await request(backend + '/.well-known/openid-configuration', { headers: { ...headers, ...changed } })).status, 400);
    }
    const deniedPort = await port(), deniedOrigin = `http://127.0.0.1:${deniedPort}`;
    origins.push(deniedOrigin);
    const deniedService = await startRemoteService({ ...options, listen: { host: '127.0.0.1', port: deniedPort }, trustedProxyCidrs: ['192.0.2.1/32'] });
    try {
        assert.equal((await request(deniedOrigin + '/.well-known/openid-configuration', { headers: { ...headers, 'x-forwarded-proto': 'https' } })).status, 400);
    } finally { await deniedService.close(); }
    for (const duplicate of [['X-Forwarded-Proto', 'https'], ['Host', new URL(origin).host]]) {
        assert.equal((await request(backend + '/mcp', { headers: ['Host', new URL(origin).host, 'X-Forwarded-Proto', 'https', ...duplicate] })).status, 400);
    }
    const cookies = new Map(), secureCookies = [];
    async function browser(url, settings = {}) {
        const supplied = { ...(settings.headers ?? {}) };
        if (cookies.size) supplied.cookie = [...cookies].map(([name, value]) => `${name}=${value}`).join('; ');
        const response = await request(url, { ...settings, ca, headers: supplied });
        for (const item of response.headers['set-cookie'] ?? []) {
            assert(/; secure(?:;|$)/i.test(item), 'all OAuth cookies stay Secure on the external HTTPS origin');
            secureCookies.push(item);
            const pair = item.split(';')[0], split = pair.indexOf('=');
            if (/max-age=0(?:;|$)/i.test(item)) cookies.delete(pair.slice(0, split));
            else cookies.set(pair.slice(0, split), pair.slice(split + 1));
        }
        assert(!response.body.includes(syntheticKey) && !String(response.headers.location).includes(syntheticKey));
        return response;
    }
    const metadata = JSON.parse((await browser(origin + '/.well-known/openid-configuration')).body);
    assert.equal(metadata.issuer, origin);
    assert(Object.entries(metadata).filter(([name]) => name.endsWith('_endpoint')).every(([, value]) => value.startsWith(origin + '/')));
    const challenge = await browser(origin + '/mcp');
    assert.equal(challenge.status, 401); assert(challenge.headers['www-authenticate'].includes(origin));
    const verifier = randomBytes(32).toString('base64url'), resource = origin + '/mcp';
    let response = await browser(metadata.authorization_endpoint + '?' + new URLSearchParams({
        client_id: options.clients[0].clientId, redirect_uri: options.clients[0].redirectUris[0], response_type: 'code',
        scope: 'crawl:use', resource, state: 'proxy-fixture-state', code_challenge_method: 'S256',
        code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    }));
    assert.equal(response.status, 303);
    const interaction = new URL(response.headers.location, origin);
    assert.equal(interaction.origin, origin);
    response = await browser(interaction);
    assert.equal(response.status, 200);
    const csrf = /name="csrf" value="([^"]+)"/.exec(response.body)?.[1]; assert(csrf);
    response = await browser(interaction, { method: 'POST', headers: { origin, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ csrf, apiToken: syntheticKey, decision: 'allow' }).toString() });
    let code;
    for (let count = 0; count < 6; count++) {
        assert([302, 303].includes(response.status));
        const next = new URL(response.headers.location, origin); assert.equal(next.origin, origin);
        if (next.pathname === '/callback') { assert.equal(next.searchParams.get('state'), 'proxy-fixture-state'); code = next.searchParams.get('code'); break; }
        response = await browser(next);
    }
    assert(code && secureCookies.length > 1 && userLookups === 1);
    const authorization = 'Basic ' + Buffer.from(`${options.clients[0].clientId}:${options.clients[0].clientSecret}`).toString('base64');
    const exchange = async (endpoint, values) => {
        const result = await browser(endpoint, { method: 'POST', headers: { authorization, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(values).toString() });
        assert.equal(result.status, 200); return JSON.parse(result.body);
    };
    let token = await exchange(metadata.token_endpoint, { grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: options.clients[0].redirectUris[0], resource });
    assert(token.access_token && token.refresh_token);
    const previous = token.refresh_token;
    token = await exchange(metadata.token_endpoint, { grant_type: 'refresh_token', refresh_token: previous, resource });
    assert(token.refresh_token && token.refresh_token !== previous);
    const { Client, StreamableHTTPClientTransport } = await import('@modelcontextprotocol/client');
    client = new Client({ name: 'gateway-fixture', version: '1.0.0' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
    const gatewayFetch = async (input, init) => {
        const value = new Request(input, init); assert.equal(new URL(value.url).origin, origin);
        const result = await request(value.url, { ca, method: value.method, headers: Object.fromEntries(value.headers), body: value.body ? Buffer.from(await value.arrayBuffer()) : undefined });
        const resultHeaders = new Headers();
        for (const [name, contents] of Object.entries(result.headers)) for (const item of Array.isArray(contents) ? contents : [contents]) if (item !== undefined) resultHeaders.append(name, item);
        return new Response([204, 205, 304].includes(result.status) ? null : result.body, { status: result.status, headers: resultHeaders });
    };
    await client.connect(new StreamableHTTPClientTransport(new URL(resource), { fetch: gatewayFetch, requestInit: { headers: { authorization: `Bearer ${token.access_token}` } } }));
    assert.equal((await client.listTools()).tools.length, 6);
    const result = await client.callTool({ name: 'nstdata_crawl_status', arguments: { crawlId: 'existing-proxy-fixture' } });
    assert.equal(result.structuredContent?.pending, 1); assert.equal(crawlCalls, 1);
    const revoked = await browser(metadata.revocation_endpoint, { method: 'POST', headers: { authorization, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: token.access_token, token_type_hint: 'access_token' }).toString() });
    assert.equal(revoked.status, 200);
    assert.equal((await browser(resource, { headers: { authorization: `Bearer ${token.access_token}` } })).status, 401);
    assert.equal(crawlCalls, 1);
});
