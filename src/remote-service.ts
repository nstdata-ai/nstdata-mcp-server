import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { createPrivateKey, X509Certificate } from 'node:crypto';
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer, type ServerOptions } from 'node:https';
import { isIP, type AddressInfo, type Socket } from 'node:net';
import { isAbsolute } from 'node:path';
import { createSecureContext } from 'node:tls';
import { createClient } from '@redis/client';
import type { RemoteServiceConfig } from './remote-config.js';
import { createApiKeyVerifier } from './api-key-verifier.js';
import { createRemoteHandler, type RemoteHandler } from './remote-handler.js';
import { createRedisCredentialStore } from './redis/credential-store.js';
import { RedisStoreError } from './redis/shared.js';

export interface RemoteService {
    address: AddressInfo;
    close(): Promise<void>;
    closed: Promise<void>;
}

const startupTimeoutMs = 5_000;
const commandTimeoutMs = 2_000;
const shutdownTimeoutMs = 10_000;
const serviceError = () => new Error('Remote service unavailable. Check deployment configuration and Redis.');

async function boundedFile(filename: string, privateFile: boolean): Promise<Buffer> {
    let file: Awaited<ReturnType<typeof open>> | undefined;
    try {
        if (typeof filename !== 'string' || !isAbsolute(filename) || filename.length > 4096 || filename.includes('\0')) throw new Error();
        file = await open(filename, constants.O_RDONLY | constants.O_NONBLOCK);
        const info = await file.stat();
        const maximum = 1_048_576;
        if (!info.isFile() || info.size < 1 || info.size > maximum ||
            (privateFile && process.platform !== 'win32' && (info.mode & 0o077) !== 0)) throw new Error();
        const bytes = Buffer.alloc(maximum + 1);
        let used = 0;
        while (used < bytes.length) {
            const { bytesRead } = await file.read(bytes, used, bytes.length - used, null);
            if (!bytesRead) break;
            used += bytesRead;
        }
        if (used > maximum) throw new Error();
        return bytes.subarray(0, used);
    } finally { await file?.close().catch(() => {}); }
}

/** Validate mounted TLS material before opening Redis or listener sockets. */
export async function loadRemoteTls(tls: RemoteServiceConfig['listen']['tls'], issuerUrl?: string): Promise<ServerOptions | undefined> {
    if (tls === undefined) return undefined;
    try {
        const [key, cert] = await Promise.all([boundedFile(tls.keyFile, true), boundedFile(tls.certFile, false)]);
        const leaf = new X509Certificate(cert);
        if (!leaf.checkPrivateKey(createPrivateKey(key))) throw new Error();
        const now = Date.now();
        if (Date.parse(leaf.validFrom) > now || Date.parse(leaf.validTo) <= now) throw new Error();
        if (issuerUrl) {
            const hostname = new URL(issuerUrl).hostname.replace(/^\[|\]$/g, '');
            if (!(isIP(hostname) ? leaf.checkIP(hostname) : leaf.checkHost(hostname))) throw new Error();
        }
        const options: ServerOptions = { key, cert, minVersion: 'TLSv1.2' };
        createSecureContext(options);
        return options;
    } catch { throw new Error('Invalid Remote TLS configuration. Check the certificate and protected private key.'); }
}

function health(response: ServerResponse, status: number): void {
    response.statusCode = status;
    response.setHeader('Content-Type', 'application/json');
    response.setHeader('Cache-Control', 'no-store');
    response.end(JSON.stringify({ status: status === 200 ? 'ok' : 'unavailable' }));
}

/** Own the listener and one bounded, non-replaying Redis connection. */
export async function startRemoteService(input: RemoteServiceConfig): Promise<RemoteService> {
    let client: ReturnType<typeof createClient> | undefined;
    let server: ReturnType<typeof createHttpServer> | undefined;
    let handler: RemoteHandler | undefined;
    const sockets = new Set<Socket>();
    let started = false, closing = false;
    let failure: Error | undefined, closePromise: Promise<void> | undefined;
    let resolveClosed!: () => void, rejectClosed!: (error: Error) => void;
    const closed = new Promise<void>((resolve, reject) => { resolveClosed = resolve; rejectClosed = reject; });
    // Startup failures may precede the caller receiving this promise.
    void closed.catch(() => {});

    const destroyRedis = () => { client?.destroy(); };
    const fail = () => {
        failure ??= serviceError();
        destroyRedis();
        if (started) void close();
    };
    async function deadline<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => { fail(); reject(serviceError()); }, timeoutMs);
            })]);
        } finally { clearTimeout(timer); }
    }
    function close(): Promise<void> {
        if (closePromise) return closePromise;
        closing = true;
        closePromise = (async () => {
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
                const stopped = server ? new Promise<void>(resolve => server!.close(() => resolve())) : Promise.resolve();
                server?.closeIdleConnections();
                const stoppedHandler = handler?.close().catch(() => { failure ??= serviceError(); });
                destroyRedis();
                await Promise.race([Promise.all([stopped, stoppedHandler]), new Promise<void>(resolve => {
                    timer = setTimeout(() => { for (const socket of sockets) socket.destroy(); resolve(); }, shutdownTimeoutMs);
                })]);
            } finally {
                clearTimeout(timer);
                for (const socket of sockets) socket.destroy();
                destroyRedis();
                if (failure) rejectClosed(failure); else resolveClosed();
            }
        })();
        return closePromise;
    }

    try {
        const config = structuredClone(input);
        const issuer = new URL(config.issuerUrl);
        if (config.issuerUrl !== issuer.origin || !isIP(config.listen.host) ||
            !Number.isSafeInteger(config.listen.port) || config.listen.port < 1 || config.listen.port > 65535 ||
            Boolean(config.redis.url) === Boolean(config.redis.socketPath)) throw new Error();
        if (issuer.protocol === 'https:') {
            if (!config.listen.tls) throw new Error();
        } else if (issuer.protocol !== 'http:' || config.listen.tls || Number(issuer.port || 80) !== config.listen.port || !['127.0.0.1', '[::1]'].includes(issuer.hostname) ||
            config.listen.host !== issuer.hostname.replace(/^\[|\]$/g, '')) throw new Error();
        if (config.redis.socketPath && !isAbsolute(config.redis.socketPath)) throw new Error();
        const redis = config.redis.url ? new URL(config.redis.url) : undefined;
        if (redis && redis.protocol !== 'rediss:' && !(redis.protocol === 'redis:' && ['127.0.0.1', '[::1]'].includes(redis.hostname))) throw new Error();
        const tls = await loadRemoteTls(config.listen.tls, config.issuerUrl);
        client = createClient({
            ...(config.redis.url ? { url: config.redis.url } : {}),
            RESP: 2, disableOfflineQueue: true, disableClientInfo: true, commandsQueueMaxLength: 100, maintNotifications: 'disabled',
            socket: { ...(config.redis.socketPath ? { path: config.redis.socketPath, tls: false as const } : {}),
                // tls.connect does not infer SNI from the connection host.
                ...(redis?.protocol === 'rediss:' && !isIP(redis.hostname.replace(/^\[|\]$/g, '')) ? { servername: redis.hostname } : {}),
                connectTimeout: startupTimeoutMs, reconnectStrategy: false },
        });
        client.on('error', fail);
        const command = async (args: string[]): Promise<unknown> => {
            if (closing || !client?.isReady) throw new RedisStoreError();
            try { return await deadline(client.sendCommand(args), commandTimeoutMs); }
            catch { fail(); throw new RedisStoreError(); }
        };
        const store = { command, namespace: config.redis.namespace, maxTtlSeconds: 2_592_000 };
        const credentials = createRedisCredentialStore({ ...store, encryptionKeys: config.encryptionKeys,
            currentKeyId: config.currentKeyId, fingerprintKey: config.fingerprintKey });
        handler = createRemoteHandler({ issuerUrl: config.issuerUrl, resourceUrl: new URL('/mcp', issuer).href,
            clients: config.clients, cookieKeys: config.cookieKeys, jwks: config.jwks, store, credentials,
            verifyApiKey: createApiKeyVerifier(), allowedOrigins: config.allowedOrigins });
        await deadline((async () => {
            await client!.connect();
            if (await command(['PING']) !== 'PONG') throw new RedisStoreError();
        })(), startupTimeoutMs);
        if (failure) throw failure;
        const onRequest = (request: IncomingMessage, response: ServerResponse) => {
            if (request.url === '/health/live' || request.url === '/health/ready') {
                if (request.headers.host?.toLowerCase() !== issuer.host.toLowerCase() ||
                    ['forwarded', 'x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-port'].some(name => request.headers[name] !== undefined)) {
                    health(response, 400); return;
                }
                if (request.method !== 'GET') { response.setHeader('Allow', 'GET'); health(response, 405); return; }
                health(response, started && !closing && !failure && (request.url === '/health/live' || client!.isReady) ? 200 : 503);
                return;
            }
            void handler!.handle(request, response).catch(() => {
                if (!response.destroyed && !response.writableEnded) {
                    if (response.headersSent) response.destroy();
                    else health(response, 503);
                }
            });
        };
        server = tls ? createHttpsServer({ ...tls, handshakeTimeout: 10_000 }, onRequest) : createHttpServer(onRequest);
        server.maxConnections = 256;
        server.headersTimeout = 10_000;
        server.requestTimeout = 130_000;
        server.keepAliveTimeout = 5_000;
        server.maxRequestsPerSocket = 100;
        server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
        server.on('error', fail);
        await new Promise<void>((resolve, reject) => {
            const failed = () => { server!.off('listening', listening); reject(serviceError()); };
            const listening = () => { server!.off('error', failed); resolve(); };
            server!.once('error', failed); server!.once('listening', listening);
            server!.listen(config.listen.port, config.listen.host);
        });
        if (failure || closing || !client.isReady) throw serviceError();
        const address = server.address();
        if (!address || typeof address === 'string') throw serviceError();
        started = true;
        return { address, close, closed };
    } catch {
        failure ??= serviceError();
        await close();
        throw serviceError();
    }
}
