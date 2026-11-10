import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

export function localContext(records) {
    assert(Array.isArray(records) && records.length === 1, 'Docker context inspection must return one context');
    const endpoint = new URL(records[0].Endpoints?.docker?.Host ?? 'invalid:');
    assert(endpoint.protocol === 'unix:' && !endpoint.hostname && endpoint.pathname.startsWith('/') &&
        !endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash,
    'Container checks require a local Unix Docker endpoint; remote contexts are forbidden');
    return records[0].Name;
}

export function verifyImageConfig(image) {
    assert(/^sha256:[a-f0-9]{64}$/.test(image.Id), 'Invalid local image identity');
    assert(image.Config?.User === 'node:node', 'Remote image must declare USER node:node');
    assert(image.Config.WorkingDir === '/app', 'Remote image must use /app');
    assert(JSON.stringify(image.Config.Entrypoint) === JSON.stringify(['node', 'dist/remote.js']), 'Unexpected Remote image entrypoint');
    assert(!image.Config.StopSignal || image.Config.StopSignal === 'SIGTERM', 'Remote image must stop with SIGTERM');
    assert(!image.Config.Env?.some(value => /^(?:NSTDATA_|NODE_OPTIONS=)/.test(value)), 'Unexpected credential or Node override in image environment');
    const platform = `${image.Os}/${image.Architecture}`;
    assert(/^linux\/(?:amd64|arm64)$/.test(platform), 'Container checks require a supported Linux image platform');
    return platform;
}

// These functions run inside the existing image, without checkout files or host dependencies.
async function imageInventory() {
    const assert = (await import('node:assert/strict')).default;
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { createHash } = await import('node:crypto');
    assert(process.getuid() === 1000 && process.getgid() === 1000, 'Image must actually run as UID/GID 1000');
    assert(process.cwd() === '/app' && process.env.NODE_ENV === 'production', 'Unexpected image runtime environment');
    const files = [], hashes = {};
    function visit(relative = '') {
        for (const entry of fs.readdirSync(path.join('/app', relative), { withFileTypes: true })) {
            const name = path.posix.join(relative, entry.name), filename = path.join('/app', name);
            if (entry.isDirectory()) visit(name);
            else {
                assert(entry.isFile() || entry.isSymbolicLink(), 'Unexpected application file type');
                if (entry.isSymbolicLink()) assert(name.startsWith('node_modules/') &&
                    fs.realpathSync(filename).startsWith('/app/node_modules/'), 'Application symlink escaped runtime dependencies');
                files.push(name);
                if (!name.startsWith('node_modules/')) {
                    assert(entry.isFile(), 'Application outputs must be regular files');
                    hashes[name] = createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
                }
            }
        }
    }
    visit();
    const installed = JSON.parse(fs.readFileSync('/app/node_modules/.package-lock.json', 'utf8')).packages;
    for (const [location, entry] of Object.entries(installed)) {
        assert(!entry.dev && !entry.link, 'Development or linked runtime dependency');
        const manifest = JSON.parse(fs.readFileSync(path.join('/app', location, 'package.json'), 'utf8'));
        assert(manifest.version === entry.version, 'Installed dependency version differs from its lock');
    }
    console.log(JSON.stringify({ uid: process.getuid(), gid: process.getgid(),
        top: fs.readdirSync('/app').sort(), files: files.sort(), hashes,
        manifest: JSON.parse(fs.readFileSync('/app/package.json', 'utf8')), installed }));
}

export function verifyInventory(report, manifest, lock, expectedHashes) {
    assert(report.uid === 1000 && report.gid === 1000, 'Image did not run as the declared non-root identity');
    assert(JSON.stringify(report.top) === JSON.stringify(['LICENSE', 'dist', 'node_modules', 'package.json']), 'Unexpected /app contents');
    assert(JSON.stringify(report.manifest) === JSON.stringify(manifest), 'Image manifest differs from remote/package.json');
    assert.deepEqual(report.hashes, expectedHashes, 'Image application hashes differ from the local Remote build');
    const locations = Object.keys(lock.packages).filter(Boolean).sort();
    assert(JSON.stringify(Object.keys(report.installed).sort()) === JSON.stringify(locations), 'Image runtime dependency closure differs from Remote lock');
    for (const location of locations) {
        assert(!/(?:^|\/)(?:typescript|@types|test|tests|src)(?:\/|$)/.test(location) &&
            location !== 'node_modules/@modelcontextprotocol/client', 'Development tooling in runtime dependencies');
        assert(report.installed[location].version === lock.packages[location].version &&
            report.installed[location].integrity === lock.packages[location].integrity, 'Image runtime package differs from Remote lock');
    }
    for (const name of report.files) {
        if (!name.startsWith('node_modules/')) { assert(Object.hasOwn(expectedHashes, name), 'Unexpected application source, test or configuration file'); continue; }
        if (name === 'node_modules/.package-lock.json' || name.startsWith('node_modules/.bin/')) continue;
        const owner = locations.filter(location => name.startsWith(location + '/')).sort((a, b) => b.length - a.length)[0];
        assert(owner && !name.slice(owner.length + 1).split('/').includes('node_modules'), 'Untracked runtime dependency files');
    }
}

async function loopbackProbe() {
    const assert = (await import('node:assert/strict')).default;
    const fs = await import('node:fs');
    const http = await import('node:http');
    const net = await import('node:net');
    const { setTimeout: delay } = await import('node:timers/promises');
    assert(process.getuid() > 0, 'Lifecycle probe must run without root');
    const info = fs.statSync('/review/runtime.json');
    assert((info.mode & 0o777) === 0o600 && info.uid === process.getuid(), 'Fixture ownership or private mode differs');
    const config = JSON.parse(fs.readFileSync('/review/runtime.json', 'utf8'));
    const sockets = new Set();
    let pending, fixtureFailure, pings = 0, evaluations = 0;
    const bounded = async (promise, milliseconds, label) => {
        let timer;
        try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label)), milliseconds); })]); }
        finally { clearTimeout(timer); }
    };
    // This is a wire fixture, not a Redis/Lua or persistence implementation.
    const redis = net.createServer(socket => {
        sockets.add(socket); socket.once('close', () => sockets.delete(socket));
        let buffer = Buffer.alloc(0);
        socket.on('error', () => {});
        socket.on('data', bytes => {
            try {
                buffer = Buffer.concat([buffer, bytes]);
                assert(buffer.length <= 1_048_576, 'RESP fixture input exceeded its bound');
                while (buffer.length) {
                    const end = buffer.indexOf('\r\n'); if (end < 0) return;
                    assert(buffer[0] === 42, 'RESP fixture requires an array');
                    const count = Number(buffer.toString('utf8', 1, end)), args = [];
                    assert(Number.isSafeInteger(count) && count > 0 && count <= 1024, 'Invalid RESP argument count');
                    let offset = end + 2;
                    for (let index = 0; index < count; index++) {
                        const next = buffer.indexOf('\r\n', offset); if (next < 0) return;
                        assert(buffer[offset] === 36, 'RESP fixture requires bulk strings');
                        const size = Number(buffer.toString('utf8', offset + 1, next));
                        assert(Number.isSafeInteger(size) && size >= 0 && size <= 1_048_576, 'Invalid RESP bulk size');
                        if (buffer.length < next + size + 4) return;
                        assert(buffer.toString('utf8', next + size + 2, next + size + 4) === '\r\n', 'Invalid RESP delimiter');
                        args.push(buffer.toString('utf8', next + 2, next + size + 2)); offset = next + size + 4;
                    }
                    buffer = buffer.subarray(offset);
                    if (args[0] === 'PING' && args.length === 1) { pings++; socket.write('+PONG\r\n'); }
                    else if (args[0] === 'EVAL') { evaluations++; socket.write('$-1\r\n'); }
                    else throw new Error('Unexpected command in minimal RESP fixture');
                }
            } catch (error) { fixtureFailure = error; socket.destroy(); }
        });
    });
    const request = (pathname, options = {}, body) => new Promise((resolve, reject) => {
        const req = http.request(config.issuerUrl + pathname, { ...options, agent: false }, response => {
            let text = '';
            response.on('data', bytes => { text += bytes; if (text.length > 65536) req.destroy(new Error('HTTP probe response exceeded its bound')); });
            response.once('error', reject);
            response.once('end', () => resolve({ status: response.statusCode, headers: response.headers, body: text }));
        });
        req.setTimeout(1500, () => req.destroy(new Error('HTTP probe timed out')));
        req.once('error', reject); req.end(body);
    });
    try {
        await bounded(new Promise((resolve, reject) => { redis.once('error', reject); redis.listen(45892, '127.0.0.1', resolve); }), 2000, 'RESP fixture listen timed out');
        console.log('fixture-ready');
        const startupDeadline = Date.now() + 12000;
        let ready = false;
        while (Date.now() < startupDeadline && !ready) {
            assert(!fixtureFailure, 'RESP fixture rejected an unexpected command');
            try { ready = (await request('/health/ready')).status === 200; } catch {}
            if (!ready) await delay(50);
        }
        assert(ready, 'Default-entrypoint Remote startup timed out');
        for (const route of ['/health/live', '/health/ready']) {
            const response = await request(route);
            assert(response.status === 200 && response.body === '{"status":"ok"}' && response.headers['cache-control'] === 'no-store', 'Actual CLI health probe failed');
        }
        const discovery = await request('/.well-known/openid-configuration');
        assert(discovery.status === 200 && JSON.parse(discovery.body).issuer === config.issuerUrl, 'Actual CLI OAuth discovery failed');
        const denied = await request('/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json' } }, '{}');
        assert(denied.status === 401 && /^Bearer\b/.test(denied.headers['www-authenticate']), 'Actual CLI did not preserve the unauthenticated MCP challenge');
        let finished = false;
        pending = http.request(config.issuerUrl + '/token', { method: 'POST', agent: false, headers: {
            'Content-Type': 'application/x-www-form-urlencoded', 'Transfer-Encoding': 'chunked', Expect: '100-continue',
        } });
        const pendingClosed = new Promise(resolve => { pending.once('error', resolve); pending.once('close', resolve); });
        pending.once('response', response => { finished = true; response.resume(); });
        const continued = new Promise(resolve => pending.once('continue', resolve));
        pending.flushHeaders(); await bounded(continued, 1500, 'Incomplete OAuth request was not admitted');
        await new Promise((resolve, reject) => pending.write('grant_type=refresh_token&', error => error ? reject(error) : resolve()));
        await delay(75);
        assert(!finished && !pending.destroyed, 'OAuth request completed before the shutdown probe');
        console.log('shutdown-ready');
        await bounded(pendingClosed, 15000, 'Docker stop did not close the incomplete OAuth request');
        assert(pings === 1 && !fixtureFailure, 'Unexpected Redis startup traffic');
        console.log(JSON.stringify({ health: true, discovery: true, unauthenticatedMcp: 401, inFlightDockerStop: true,
            redisFixture: 'PING/EVAL-nil only; no Lua or persistence verification', pings, evaluations }));
    } finally {
        pending?.destroy();
        for (const socket of sockets) socket.destroy();
        await bounded(new Promise(resolve => redis.close(resolve)), 2000, 'Owned RESP fixture cleanup timed out');
    }
}

export function writeFixtures(directory) {
    const key = () => randomBytes(32).toString('base64url');
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const config = { issuerUrl: 'http://127.0.0.1:45891', listen: { host: '127.0.0.1', port: 45891 },
        redis: { socketPath: '/review/absent.sock', namespace: 'container_fixture' },
        clients: [{ clientId: 'fixture', clientSecret: key(), redirectUris: ['http://127.0.0.1:45893/callback'] }],
        cookieKeys: [key()], jwks: { keys: [{ ...privateKey.export({ format: 'jwk' }), kid: 'fixture', use: 'sig', alg: 'ES256' }] },
        encryptionKeys: { fixture: key() }, currentKeyId: 'fixture', fingerprintKey: key() };
    const write = (name, text) => fs.writeFileSync(path.join(directory, name), text, { mode: 0o600 });
    write('check.json', JSON.stringify(config));
    write('runtime.json', JSON.stringify({ ...config, redis: { url: 'redis://127.0.0.1:45892/0', namespace: 'container_fixture' } }));
    write('probe.mjs', `await (${loopbackProbe.toString()})();\n`);
    write('no-network.cjs', "require('node:net').Socket.prototype.connect=function(){throw new Error('Configuration check attempted a connection')};globalThis.fetch=async()=>{throw new Error('Configuration check attempted fetch')};\n");
    write('loopback.cjs', `const net=require('node:net');const connect=net.Socket.prototype.connect;net.Socket.prototype.connect=function(...args){const value=Array.isArray(args[0])?args[0][0]:args[0];if(value&&typeof value==='object'&&value.host==='127.0.0.1'&&[45891,45892].includes(Number(value.port)))return connect.apply(this,args);throw new Error('Container probe blocked a non-loopback connection')};const original=globalThis.fetch;globalThis.fetch=(input,init)=>{const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||![45891,45892].includes(Number(url.port)))throw new Error('Container probe blocked a non-loopback fetch');return original(input,init)};\n`);
}

async function execute(args, label, { timeout = 15000, allowFailure = false, until } = {}) {
    return await new Promise((resolve, reject) => {
        const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
        let stdout = '', stderr = '', failure, matched = false;
        const kill = () => {
            try { process.platform === 'win32' ? child.kill('SIGKILL') : process.kill(-child.pid, 'SIGKILL'); }
            catch (error) { if (error.code !== 'ESRCH') failure ??= error; }
        };
        const interrupt = signal => { failure = new Error(`${label} interrupted by ${signal}`); kill(); };
        const onInterrupt = () => interrupt('SIGINT'), onTerminate = () => interrupt('SIGTERM');
        process.once('SIGINT', onInterrupt); process.once('SIGTERM', onTerminate);
        const timer = setTimeout(() => { failure = new Error(`${label} timed out`); kill(); }, timeout);
        child.once('error', () => { failure = new Error(`${label} could not start`); });
        for (const [stream, isError] of [[child.stdout, false], [child.stderr, true]]) stream.on('data', bytes => {
            if (isError) stderr += bytes; else stdout += bytes;
            if (until && stdout.includes(until)) { matched = true; kill(); }
            if (stdout.length + stderr.length > 4 * 1024 * 1024) { failure = new Error(`${label} exceeded its output bound`); kill(); }
        });
        child.once('close', code => {
            clearTimeout(timer);
            process.off('SIGINT', onInterrupt); process.off('SIGTERM', onTerminate);
            if (failure || (until ? !matched : !allowFailure && code !== 0)) reject(failure ?? new Error(`${label} failed (exit ${code}); no image build, pull or deployment was attempted`));
            else resolve({ code, stdout, stderr });
        });
    });
}

export async function checkContainer(imageName = 'nstdata-mcp-remote:local') {
    assert(typeof process.getuid === 'function' && process.getuid() > 0, 'Run this check as a non-root Unix user so 0600 bind-mounted fixtures keep their real owner');
    assert(imageName && !imageName.startsWith('-') && !/[\s\u0000-\u001f\u007f]/.test(imageName), 'Provide exactly one local image reference');
    const context = (await execute(['context', 'show'], 'Docker context selection')).stdout.trim();
    const records = JSON.parse((await execute(['context', 'inspect', context], 'Docker context inspection')).stdout);
    assert(localContext(records) === context, 'Docker context changed during inspection');
    const docker = (args, label, options) => execute(['--context', context, ...args], label, options);
    const [image] = JSON.parse((await docker(['image', 'inspect', imageName], 'Existing local image inspection')).stdout);
    const platform = verifyImageConfig(image);
    const remote = path.join(root, 'remote');
    const manifest = JSON.parse(fs.readFileSync(path.join(remote, 'package.json'), 'utf8'));
    const lock = JSON.parse(fs.readFileSync(path.join(remote, 'package-lock.json'), 'utf8'));
    const expectedHashes = { LICENSE: digest(fs.readFileSync(path.join(root, 'LICENSE'))),
        'package.json': digest(fs.readFileSync(path.join(remote, 'package.json'))) };
    function expected(relative = '') {
        for (const entry of fs.readdirSync(path.join(remote, 'dist', relative), { withFileTypes: true })) {
            const name = path.posix.join(relative, entry.name);
            if (entry.isDirectory()) expected(name);
            else { assert(entry.isFile() && name.endsWith('.js') && name !== 'stdio.js', 'Build Remote with JavaScript-only output before checking the image');
                expectedHashes['dist/' + name] = digest(fs.readFileSync(path.join(remote, 'dist', name))); }
        }
    }
    expected();
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-container-'));
    fs.chmodSync(directory, 0o700);
    const owned = [];
    const run = async (args, label, { detached = false, network = 'none', ...options } = {}) => {
        const name = 'nstdata-mcp-check-' + randomBytes(10).toString('hex'); owned.push(name);
        const result = await docker(['run', '--platform', platform, '--pull=never', detached ? '--detach' : '--rm', '--name', name,
            '--network', network, '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', ...args], label, options);
        return { ...result, name };
    };
    try {
        const inventory = await run(['--entrypoint', 'node', image.Id, '--input-type=module', '--eval', `await (${imageInventory.toString()})();`], 'Final image inventory', { timeout: 20000 });
        verifyInventory(JSON.parse(inventory.stdout), manifest, lock, expectedHashes);
        const help = await run([image.Id, '--help'], 'Actual image CLI help');
        assert(help.stderr === '' && help.stdout.includes('--config <absolute-path>'), 'Actual image CLI help failed');
        writeFixtures(directory);
        assert(!directory.includes(','), 'Fixture mount path cannot contain a comma');
        const mount = ['--user', `${process.getuid()}:${process.getgid()}`, '--mount', `type=bind,src=${directory},dst=/review,readonly`];
        const check = await run([...mount, '--env', 'NODE_OPTIONS=--require=/review/no-network.cjs', image.Id,
            '--config', '/review/check.json', '--check'], 'Actual image CLI protected configuration check');
        assert(check.stderr === '' && check.stdout.includes('No connection was attempted'), 'Actual image CLI configuration check failed');
        const guarded = [...mount, '--env', 'NODE_OPTIONS=--require=/review/loopback.cjs'];
        const fixture = await run([...guarded, '--entrypoint', 'node', image.Id, '/review/probe.mjs'],
            'Owned loopback fixture start', { detached: true });
        await docker(['logs', '--follow', fixture.name], 'Loopback RESP readiness', { timeout: 5000, until: 'fixture-ready\n' });
        const app = await run([...guarded, '--init=false', image.Id, '--config', '/review/runtime.json'],
            'Default-entrypoint Remote start', { detached: true, network: `container:${fixture.name}` });
        await docker(['logs', '--follow', fixture.name], 'In-flight OAuth shutdown readiness', { timeout: 15000, until: 'shutdown-ready\n' });
        const [running] = JSON.parse((await docker(['container', 'inspect', app.name], 'Running Remote inspection')).stdout);
        assert(running.State.Running && running.State.Pid > 0, 'Remote must still be running before docker stop');
        await docker(['stop', '--timeout', '12', app.name], 'Default-entrypoint PID1 SIGTERM', { timeout: 16000 });
        const [stopped] = JSON.parse((await docker(['container', 'inspect', app.name], 'Stopped Remote inspection')).stdout);
        assert(stopped.HostConfig.Init === false && stopped.Path === 'node' && JSON.stringify(stopped.Args) === JSON.stringify(['dist/remote.js', '--config', '/review/runtime.json']),
            'Lifecycle check did not run the default Remote entrypoint as PID1');
        assert(!stopped.State.Running && stopped.State.ExitCode === 0 && stopped.State.OOMKilled === false, 'Default-entrypoint Remote did not stop cleanly');
        const waited = await docker(['wait', fixture.name], 'Loopback fixture shutdown observation', { timeout: 18000 });
        assert(waited.stdout.trim() === '0', 'Loopback fixture failed to observe in-flight request closure');
        const [finished] = JSON.parse((await docker(['container', 'inspect', fixture.name], 'Finished fixture inspection')).stdout);
        assert(finished.State.ExitCode === 0 && finished.State.OOMKilled === false, 'Loopback fixture did not exit cleanly');
        const logs = await docker(['logs', fixture.name], 'Loopback lifecycle result');
        const result = JSON.parse(logs.stdout.trim().split('\n').at(-1));
        assert(result.health && result.discovery && result.unauthenticatedMcp === 401 && result.inFlightDockerStop, 'Incomplete lifecycle probe result');
        console.log(`PASS: existing local image ${image.Id}; non-root identity, exact application bytes and production dependency closure, help/check, health/discovery/MCP 401, default-entrypoint PID1 docker stop during an in-flight OAuth request. Shared namespace has no external network; minimal RESP fixture does not verify Redis Lua or persistence.`);
    } finally {
        let cleanupFailure;
        for (const name of owned.reverse()) {
            try {
                const result = await docker(['container', 'rm', '--force', name], 'Owned container cleanup', { timeout: 8000, allowFailure: true });
                if (result.code !== 0 && !result.stderr.includes('No such container')) cleanupFailure ??= new Error(`Unable to remove owned check container ${name}`);
            } catch { cleanupFailure ??= new Error(`Unable to remove owned check container ${name}`); }
        }
        fs.rmSync(directory, { recursive: true, force: true });
        if (cleanupFailure) throw cleanupFailure;
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        assert(process.argv.length <= 3, 'Usage: node scripts/check-container.mjs [existing-local-image]');
        await checkContainer(process.argv[2]);
    } catch (error) { console.error(`FAIL: ${error.message}`); process.exitCode = 1; }
}
