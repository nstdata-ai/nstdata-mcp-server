import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { isolatedRedis } from './redis-fixture.mjs';

const executable = pathToFileURL(process.env.NSTDATA_TEST_CLI ?? fileURLToPath(new URL('../../dist/stdio.js', import.meta.url)));
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
        const incoming = transport.request(parsed, { ...options, agent: false }, response => {
            const chunks = [];
            response.on('data', data => chunks.push(data));
            response.once('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }));
        });
        incoming.once('error', reject); incoming.end();
    });
}

test('Remote service starts only after Redis readiness and serves health and OAuth discovery', async t => {
    const origins = [];
    const redis = await isolatedRedis(t, { allowedOrigins: () => origins });
    const options = config(await port(), redis.socketPath); origins.push(options.issuerUrl);
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
    const denied = await request(options.issuerUrl + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
    assert.equal(denied.status, 401); assert.match(denied.headers['www-authenticate'], /Bearer/);
    await service.close(); await service.close(); await service.closed;
    await assert.rejects(request(options.issuerUrl + '/health/live'));
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
