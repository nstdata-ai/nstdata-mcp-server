import { createMcpHandler } from '@modelcontextprotocol/server';
import { type Config, validateConfig } from './config.js';
import { createServer } from './server.js';

/** A binding resolved by a trusted authenticator, never by caller-supplied owner or API settings. */
export interface HttpIdentity {
    /** Opaque validated credential binding, not an asserted Nstdata account/user ID. */
    subject: string;
    apiToken: string;
}

export interface HttpHandlerOptions {
    resourceUrl: string;
    /** Exact browser origins. An absent Origin is allowed for non-browser clients; "null" is rejected. */
    allowedOrigins: readonly string[];
    /**
     * Verify the caller's credential, issuer, resource/audience, expiry and required scopes before
     * returning its bound subject and upstream key. Return null on invalid/missing credentials.
     * A trusted adapter may return a denial Response (4xx/5xx); successful Responses are refused.
     * This seam does not implement OAuth, verify tokens, or accept an upstream key as authentication.
     * Honor request.signal when performing asynchronous verification.
     */
    authenticate: (request: Request) => Promise<HttpIdentity | Response | null>;
    /** Deployment-owned Crawl settings; never populated from request parameters or identity claims. */
    crawl?: Partial<Pick<Config, 'baseURL' | 'httpTimeoutMs' | 'maxResponseBytes' | 'maxOutputChars' | 'maxCrawlPages'>>;
    maxRequestBodyBytes?: number;
}

export interface HttpHandler {
    fetch: (request: Request) => Promise<Response>;
    close: () => Promise<void>;
}

function failure(status: number, message: string, headers?: HeadersInit): Response {
    return Response.json({ error: message }, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
}

// The SDK body reader does not observe aborts; own the bounded inbound stream before dispatch.
async function readBody(request: Request, maxBytes: number): Promise<ArrayBuffer | null> {
    if (!request.body) return new ArrayBuffer(0);
    const reader = request.body.getReader();
    const cancel = () => { void reader.cancel().catch(() => {}); };
    request.signal.addEventListener('abort', cancel, { once: true });
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
        while (true) {
            request.signal.throwIfAborted();
            const chunk = await reader.read();
            request.signal.throwIfAborted();
            if (chunk.done) break;
            size += chunk.value.byteLength;
            if (size > maxBytes) { cancel(); return null; }
            chunks.push(chunk.value);
        }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        return bytes.buffer;
    } finally {
        if (request.signal.aborted) cancel();
        request.signal.removeEventListener('abort', cancel);
        reader.releaseLock();
    }
}

/** Internal, stateless Fetch foundation. Hosting and the real authorization bridge are separate. */
export function createHttpHandler(options: HttpHandlerOptions): HttpHandler {
    const resource = new URL(options.resourceUrl);
    if (!['https:', 'http:'].includes(resource.protocol) || resource.username || resource.password || resource.search || resource.hash) {
        throw new Error('Invalid HTTP resource configuration');
    }
    const origins = new Set(options.allowedOrigins);
    for (const origin of origins) {
        const url = new URL(origin);
        if (!['https:', 'http:'].includes(url.protocol) || url.origin !== origin) throw new Error('Invalid HTTP origin configuration');
    }
    if (typeof options.authenticate !== 'function') throw new Error('HTTP authentication is required');
    const authenticate = options.authenticate;
    const crawl = { ...options.crawl };
    const maxRequestBodySize = options.maxRequestBodyBytes ?? 1024 * 1024;
    if (!Number.isSafeInteger(maxRequestBodySize) || maxRequestBodySize < 1) throw new Error('Invalid HTTP body limit');
    const active = new Set<() => Promise<void>>();
    let closed = false;

    return {
        fetch: async request => {
            if (closed) return failure(503, 'Service unavailable');
            const url = new URL(request.url);
            if (url.href !== resource.href) return failure(404, 'Not found');
            // Native Fetch may omit Host; its URL authority is already checked above.
            const host = request.headers.get('host');
            if (host !== null && host.toLowerCase() !== resource.host.toLowerCase()) return failure(403, 'Forbidden');
            const origin = request.headers.get('origin');
            if (origin !== null && !origins.has(origin)) return failure(403, 'Forbidden');
            if (!['POST', 'GET', 'DELETE'].includes(request.method)) return failure(405, 'Method not allowed', { Allow: 'POST, GET, DELETE' });

            const controller = new AbortController();
            const signal = AbortSignal.any([request.signal, controller.signal]);
            const scopedRequest = new Request(request, { signal });
            let core: ReturnType<typeof createMcpHandler> | undefined;
            let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
            let finished = false;
            const finish = async () => {
                if (finished) return;
                finished = true;
                active.delete(finish);
                controller.abort();
                if (scopedRequest.body && !scopedRequest.body.locked) void scopedRequest.body.cancel().catch(() => {});
                await reader?.cancel().catch(() => {});
                await core?.close();
            };
            active.add(finish);
            try {
                let identity: HttpIdentity | Response | null;
                try { identity = await authenticate(scopedRequest); }
                catch { await finish(); return failure(503, 'Service unavailable'); }
                if (identity instanceof Response) {
                    await finish();
                    if (identity.status < 400 || identity.status > 599) {
                        void identity.body?.cancel().catch(() => {});
                        return failure(503, 'Service unavailable');
                    }
                    const headers = new Headers(identity.headers);
                    headers.set('Cache-Control', 'no-store');
                    return new Response(identity.body, { status: identity.status, statusText: identity.statusText, headers });
                }
                if (!identity || typeof identity.subject !== 'string' || !identity.subject.trim() ||
                    typeof identity.apiToken !== 'string' || !identity.apiToken.trim()) {
                    await finish();
                    return failure(401, 'Unauthorized', { 'WWW-Authenticate': 'Bearer' });
                }
                if (signal.aborted || closed) { await finish(); return failure(503, 'Service unavailable'); }
                let inbound = scopedRequest;
                if (request.method === 'POST') {
                    let bytes: ArrayBuffer | null;
                    try { bytes = await readBody(scopedRequest, maxRequestBodySize); }
                    catch {
                        const unavailable = signal.aborted || closed;
                        await finish();
                        return failure(unavailable ? 503 : 400, unavailable ? 'Service unavailable' : 'Invalid request body');
                    }
                    if (bytes === null) { await finish(); return failure(413, 'Request body too large'); }
                    inbound = new Request(scopedRequest, { body: bytes });
                }
                if (signal.aborted || closed) { await finish(); return failure(503, 'Service unavailable'); }
                const config = validateConfig({ baseURL: 'https://api.nstdata.io', ...crawl, modules: 'crawl', apiToken: identity.apiToken });
                // A request owns this closure and its client/config in both SDK protocol eras.
                core = createMcpHandler(() => {
                    if (signal.aborted || closed) throw new Error('HTTP request stopped');
                    return createServer({ ...config });
                }, { legacy: 'stateless', maxRequestBodySize });
                const response = await core.fetch(inbound);
                if (!response.body) { await finish(); return response; }
                reader = response.body.getReader();
                const body = new ReadableStream<Uint8Array>({
                    async pull(stream) {
                        try {
                            const chunk = await reader!.read();
                            if (chunk.done) { await finish(); stream.close(); }
                            else stream.enqueue(chunk.value);
                        } catch {
                            await finish();
                            stream.error(new Error('HTTP response interrupted'));
                        }
                    },
                    cancel: finish,
                });
                const headers = new Headers(response.headers);
                headers.set('Cache-Control', 'no-store');
                return new Response(body, { status: response.status, statusText: response.statusText, headers });
            } catch {
                await finish();
                return failure(500, 'Internal server error');
            }
        },
        close: async () => {
            closed = true;
            await Promise.all([...active].map(finish => finish()));
        },
    };
}
