export interface ApiKeyVerifierOptions {
    /** Trusted deployment configuration; HTTP is allowed only for loopback fixtures. */
    baseURL?: string;
    fetch?: typeof globalThis.fetch;
    timeoutMs?: number;
    maxResponseBytes?: number;
}

const MAX_TOKEN_BYTES = 16_384;
const unavailable = () => new Error('API key verification unavailable');

function validToken(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0 && !/[\s\u0000-\u001f\u007f]/u.test(value) &&
        Buffer.byteLength(value, 'utf8') <= MAX_TOKEN_BYTES && Buffer.from(value, 'utf8').toString('utf8') === value;
}

/** Checks only whether the user-info endpoint accepts this key now; it supplies no identity or Crawl entitlement. */
export function createApiKeyVerifier(options: ApiKeyVerifierOptions = {}): (apiToken: string, signal: AbortSignal) => Promise<boolean> {
    let endpoint: string;
    let fetcher: typeof globalThis.fetch;
    let timeoutMs: number;
    let maxResponseBytes: number;
    try {
        if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error();
        const baseURL = options.baseURL === undefined ? 'https://api.nstdata.io' : options.baseURL;
        if (typeof baseURL !== 'string' || baseURL !== baseURL.trim()) throw new Error();
        const url = new URL(baseURL);
        const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
        if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || url.username || url.password ||
            url.pathname !== '/' || url.href.includes('?') || url.href.includes('#')) throw new Error();
        endpoint = new URL('/api/v1/api/user/info', url).href;
        fetcher = options.fetch === undefined ? globalThis.fetch : options.fetch;
        timeoutMs = options.timeoutMs === undefined ? 5_000 : options.timeoutMs;
        maxResponseBytes = options.maxResponseBytes === undefined ? 16_384 : options.maxResponseBytes;
        if (typeof fetcher !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647 ||
            !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1) throw new Error();
    } catch { throw new Error('Invalid API key verifier configuration'); }

    return async (apiToken, signal) => {
        if (!(signal instanceof AbortSignal) || signal.aborted) throw unavailable();
        if (!validToken(apiToken)) return false;
        const controller = new AbortController();
        const deadline = performance.now() + timeoutMs;
        let response: Response | undefined;
        let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
        const cancelBody = () => {
            if (reader) void reader.cancel().catch(() => {});
            else if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {});
        };
        let rejectStopped: (reason: Error) => void;
        const stopped = new Promise<never>((_resolve, reject) => { rejectStopped = reject; });
        const stop = () => {
            controller.abort();
            cancelBody();
            rejectStopped(unavailable());
        };
        const check = () => {
            if (signal.aborted || controller.signal.aborted || performance.now() >= deadline) throw unavailable();
        };
        signal.addEventListener('abort', stop, { once: true });
        const timer = setTimeout(stop, timeoutMs);
        try {
            const result = await Promise.race([stopped, (async () => {
                try {
                    check();
                    response = await fetcher(endpoint, { method: 'GET', headers: { 'x-api-key': apiToken },
                        redirect: 'error', signal: controller.signal });
                    check();
                    if (!(response instanceof Response) || response.redirected || (response.url && response.url !== endpoint)) throw unavailable();
                    // These reject this attempt only: the backend can also use 401 for transient database errors.
                    if ([401, 403, 470].includes(response.status)) return false;
                    if (response.status !== 200 || !response.body) throw unavailable();
                    const length = response.headers.get('content-length');
                    if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxResponseBytes)) throw unavailable();
                    reader = response.body.getReader();
                    const chunks: Uint8Array[] = [];
                    let bytes = 0;
                    while (true) {
                        const chunk = await reader.read();
                        check();
                        if (chunk.done) break;
                        if (!(chunk.value instanceof Uint8Array)) throw unavailable();
                        bytes += chunk.value.byteLength;
                        if (bytes > maxResponseBytes) throw unavailable();
                        chunks.push(chunk.value);
                    }
                    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes)));
                    check();
                    const data = value?.data;
                    if (!value || typeof value !== 'object' || Array.isArray(value) || value.err !== false || value.code !== 200 ||
                        value.msg !== 'SUCCESS' || !data || typeof data !== 'object' || Array.isArray(data) ||
                        typeof data.email !== 'string' || !data.email.trim() ||
                        typeof data.balance !== 'number' || !Number.isFinite(data.balance) ||
                        typeof data.referralBalance !== 'number' || !Number.isFinite(data.referralBalance)) throw unavailable();
                    return true;
                } finally { cancelBody(); }
            })()]);
            check();
            return result;
        } catch { throw unavailable(); }
        finally {
            clearTimeout(timer);
            signal.removeEventListener('abort', stop);
            controller.abort();
            cancelBody();
        }
    };
}
