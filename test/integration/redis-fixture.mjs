import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export async function isolatedRedis(t, { allowedOrigins = () => [], virtualFetch } = {}) {
    const directory = await mkdtemp(join(tmpdir(), 'mcp-redis-'));
    const socketPath = join(directory, 'redis.sock');
    const clients = [];
    let child, exited, startupError, output = '';
    const connect = net.Socket.prototype.connect, fetch = globalThis.fetch;
    net.Socket.prototype.connect = function (...args) {
        const first = Array.isArray(args[0]) ? args[0][0] : args[0];
        const path = typeof first === 'object' ? first.path : first;
        if (path === socketPath) return connect.apply(this, args);
        const host = typeof first === 'object' ? first.host : args[1];
        const port = typeof first === 'object' ? first.port : first;
        if (host === '127.0.0.1' && allowedOrigins().some(origin => {
            const url = new URL(origin);
            return url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.origin === origin && Number(url.port) === Number(port);
        })) return connect.apply(this, args);
        throw new Error('Redis test blocked an unexpected socket');
    };
    globalThis.fetch = async (input, init) => {
        const request = new Request(input, init), url = new URL(request.url);
        const response = await virtualFetch?.(request, url);
        if (response !== undefined) {
            if (!(response instanceof Response)) throw new Error('Invalid virtual fetch fixture');
            return response;
        }
        if (url.protocol === 'http:' && url.hostname === '127.0.0.1' && allowedOrigins().includes(url.origin)) return fetch(request);
        throw new Error('Redis test blocked an unexpected fetch');
    };
    t.after(async () => {
        try {
            for (const client of clients) if (client.isOpen) client.destroy();
            if (child?.pid && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
            if (exited) {
                const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
                try { await exited; } finally { clearTimeout(timer); }
            }
        } finally {
            net.Socket.prototype.connect = connect; globalThis.fetch = fetch;
            await rm(directory, { recursive: true, force: true });
        }
    });
    assert(Buffer.byteLength(socketPath) < 104, 'Temporary directory path is too long for a Redis Unix socket');
    child = spawn('redis-server', ['--port', '0', '--unixsocket', socketPath, '--unixsocketperm', '700',
        '--dir', directory, '--appendonly', 'yes', '--appendfsync', 'always', '--save', '',
        '--maxmemory-policy', 'noeviction', '--daemonize', 'no'], { stdio: ['ignore', 'pipe', 'pipe'] });
    exited = new Promise(resolve => child.once('close', resolve));
    child.on('error', error => { startupError = error; });
    for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { output = (output + data).slice(-8000); });
    const deadline = Date.now() + 5000;
    while (!output.includes('Ready to accept connections')) {
        if (startupError?.code === 'ENOENT') throw new Error('Redis integration tests require redis-server on PATH; install it before running test:redis');
        if (startupError || child.exitCode !== null || Date.now() > deadline) throw new Error(`Owned Redis failed to start: ${startupError?.code ?? output}`);
        await delay(20);
    }
    const { createClient } = await import('@redis/client');
    async function client() {
        const value = createClient({ RESP: 2, disableOfflineQueue: true, disableClientInfo: true,
            commandsQueueMaxLength: 100, socket: { path: socketPath, connectTimeout: 1500, reconnectStrategy: false } });
        value.on('error', () => {}); // Operations still reject; prevent a secondary unhandled EventEmitter error.
        clients.push(value);
        await value.connect();
        // Bound operations without timing out idle sockets during expiry assertions.
        return args => value.sendCommand(args, { abortSignal: AbortSignal.timeout(1800) });
    }
    const command = await client(), command2 = await client();
    assert.equal(await command(['PING']), 'PONG');
    assert.throws(() => new net.Socket().connect({ host: 'example.invalid', port: 443 }), /blocked/);
    await assert.rejects(globalThis.fetch('https://example.invalid'), /blocked/);
    return { command, command2, async stop() {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
        await exited;
    } };
}
