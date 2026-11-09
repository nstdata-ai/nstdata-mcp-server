import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { errors } from 'oidc-provider';
import { createOAuthProvider, type OAuthProviderOptions } from './oauth-provider.js';
import { createOAuthHttpHandler } from './oauth-resource.js';
import type { HttpHandlerOptions } from './http-handler.js';
import { createRedisAdapterFactory } from './redis/provider-adapter.js';
import { createRemoteRequestPolicy } from './remote-request.js';

export interface RemoteHandlerOptions extends OAuthProviderOptions {
    trustedProxyCidrs?: readonly string[];
    verifyApiKey: (apiToken: string, signal: AbortSignal) => Promise<boolean>;
    allowedOrigins?: readonly string[];
    crawl?: HttpHandlerOptions['crawl'];
    maxRequestBodyBytes?: number;
    maxFormBodyBytes?: number;
    requestTimeoutMs?: number;
}

export interface RemoteHandler {
    handle(request: IncomingMessage, response: ServerResponse): Promise<void>;
    close(): Promise<void>;
}

const css = `body{font:16px/1.5 system-ui,sans-serif;margin:2rem;color:#17212b}
main{max-width:34rem;margin:4rem auto}
label{display:block;margin:1rem 0 .4rem}
input[type=password]{box-sizing:border-box;width:100%;padding:.75rem;font:inherit}
button{margin:1rem .5rem 0 0;padding:.6rem 1rem;font:inherit}
p[role=alert]{color:#a12b22}`;
const csp = `default-src 'none'; style-src 'sha256-${createHash('sha256').update(css).digest('base64')}'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`;
const cookieName = 'nstdata_oauth_csrf';
const escape = (value: string) => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
const same = (a: string, b: string) => {
    const x = Buffer.from(a), y = Buffer.from(b);
    return x.length === y.length && timingSafeEqual(x, y);
};

function reply(response: ServerResponse, status: number, message: string): void {
    if (response.destroyed || response.writableEnded) return;
    if (!response.headersSent) {
        response.statusCode = status;
        response.setHeader('Content-Type', 'application/json');
    }
    response.end(JSON.stringify({ error: message }));
}

function limit(value: number, maximum: number): number {
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error('Invalid Remote configuration');
    return value;
}

async function bodyBytes(request: IncomingMessage, signal: AbortSignal, maxBytes: number): Promise<Uint8Array<ArrayBuffer>> {
    const chunks: Buffer[] = [];
    let size = 0;
    const stop = () => request.destroy();
    signal.addEventListener('abort', stop, { once: true });
    try {
        for await (const chunk of request) {
            signal.throwIfAborted();
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            size += bytes.length;
            if (size > maxBytes) throw new RangeError();
            chunks.push(bytes);
        }
        signal.throwIfAborted();
        return new Uint8Array(Buffer.concat(chunks, size));
    } finally { signal.removeEventListener('abort', stop); }
}

/** Node HTTP assembly with direct TLS or an explicitly restricted reverse proxy. */
export function createRemoteHandler(options: RemoteHandlerOptions): RemoteHandler {
    try { return configureRemoteHandler(options); }
    catch { throw new Error('Invalid Remote configuration'); }
}

function configureRemoteHandler(options: RemoteHandlerOptions): RemoteHandler {
    const issuer = new URL(options.issuerUrl);
    const resource = new URL(options.resourceUrl);
    if (issuer.pathname !== '/' || issuer.origin !== resource.origin || resource.pathname !== '/mcp' ||
        typeof options.verifyApiKey !== 'function') throw new Error('Invalid Remote configuration');
    const maxBody = limit(options.maxRequestBodyBytes ?? 1_048_576, 16_777_216);
    const maxForm = limit(options.maxFormBodyBytes ?? 32_768, maxBody);
    const timeout = limit(options.requestTimeoutMs ?? 130_000, 2_147_483_647);
    const allowedOrigins = new Set(options.allowedOrigins ?? []);
    const cookieKeys = [...options.cookieKeys];
    const verifyApiKey = options.verifyApiKey;
    const authorizeCredential = options.credentials.authorize.bind(options.credentials);
    const clients = new Map(options.clients.map(client => [client.clientId, client.name ?? client.clientId]));
    const callbackOrigins = [...new Set(options.clients.flatMap(client => client.redirectUris.map(uri => new URL(uri).origin)))];
    const providerCsp = `default-src 'none'; script-src 'self'; form-action 'self' ${callbackOrigins.join(' ')}; frame-ancestors 'none'; base-uri 'none'`;
    const requestAllowed = createRemoteRequestPolicy(options.issuerUrl, options.trustedProxyCidrs);
    const oauth = createOAuthProvider(options);
    // Koa may trust the protocol only after this handler validates the direct peer and headers.
    oauth.provider.proxy = options.trustedProxyCidrs !== undefined;
    const mcp = createOAuthHttpHandler({ resourceUrl: resource.href, allowedOrigins: [...allowedOrigins],
        oauthMetadata: oauth.metadata, verifyCredential: oauth.verifyCredential, crawl: options.crawl,
        maxRequestBodyBytes: maxBody });
    const Adapter = createRedisAdapterFactory({ ...options.store, invalidGrant: () => new errors.InvalidGrant() });
    const csrfStore = new Adapter('InteractionCsrf');
    const csrfLifetime = Math.min(300, options.store.maxTtlSeconds);
    const active = new Set<AbortController>();
    let closed = false;

    const mac = (key: string, uid: string, payload: string) => createHmac('sha256', key)
        .update('nstdata-oauth-csrf\0').update(uid).update('\0').update(payload).digest('base64url');
    const cookie = (response: ServerResponse, path: string, value: string, maxAge: number) => {
        const current = response.getHeader('Set-Cookie');
        const values = current === undefined ? [] : Array.isArray(current) ? current.map(String) : [String(current)];
        response.setHeader('Set-Cookie', [...values, `${cookieName}=${value}; Path=${path}; Max-Age=${maxAge}; HttpOnly; SameSite=Strict${issuer.protocol === 'https:' ? '; Secure' : ''}`]);
    };
    async function page(response: ServerResponse, uid: string, clientId: string, status = 200, error = '') {
        const nonce = randomBytes(32).toString('base64url');
        const payload = `${nonce}.${Math.floor(Date.now() / 1000) + csrfLifetime}`;
        const token = `${payload}.${mac(cookieKeys[0], uid, payload)}`;
        await csrfStore.upsert(`${uid}.${nonce}`, { uid }, csrfLifetime);
        if (response.destroyed || response.writableEnded) return;
        cookie(response, `/oauth/interaction/${uid}`, token, csrfLifetime);
        response.statusCode = status;
        response.setHeader('Content-Security-Policy', csp);
        response.setHeader('Content-Type', 'text/html; charset=utf-8');
        response.end(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect Nstdata</title>
<style>${css}</style>
</head>
<body><main>
<h1>Connect Nstdata</h1>
<p>Allow <strong>${escape(clients.get(clientId)!)}</strong> to use Nstdata Crawl with your API key. Calls use your Nstdata credits.</p>
<p>The application can renew access until this authorization expires or is revoked. Your key is stored encrypted. Only authorize an application you trust.</p>
${error ? `<p role="alert">${escape(error)}</p>` : ''}
<form method="post" action="/oauth/interaction/${uid}">
<input type="hidden" name="csrf" value="${token}">
<label for="api-token">Nstdata API key</label>
<input id="api-token" name="apiToken" type="password" autocomplete="off" spellcheck="false">
<button name="decision" value="allow" type="submit">Authorize Crawl</button>
<button name="decision" value="deny" type="submit">Cancel</button>
</form>
</main></body>
</html>`);
    }
    async function consumeCsrf(request: IncomingMessage, uid: string, token: string) {
        const cookies = (request.headers.cookie ?? '').split(';').map(value => value.trim()).filter(value => value.startsWith(`${cookieName}=`));
        if (cookies.length !== 1 || !same(cookies[0].slice(cookieName.length + 1), token)) return false;
        const match = /^([A-Za-z0-9_-]{43})\.([0-9]{1,12})\.([A-Za-z0-9_-]{43})$/.exec(token);
        if (!match || Number(match[2]) <= Math.floor(Date.now() / 1000) ||
            Number(match[2]) > Math.floor(Date.now() / 1000) + csrfLifetime) return false;
        const payload = `${match[1]}.${match[2]}`;
        if (!cookieKeys.some(key => same(mac(key, uid, payload), match[3]))) return false;
        try { await csrfStore.consume(`${uid}.${match[1]}`); return true; }
        catch (error) { if (error instanceof errors.InvalidGrant) return false; throw error; }
    }

    return {
        async handle(request, response) {
            response.setHeader('Cache-Control', 'no-store');
            response.setHeader('Referrer-Policy', 'no-referrer');
            response.setHeader('X-Content-Type-Options', 'nosniff');
            response.setHeader('Content-Security-Policy', providerCsp);
            if (closed) { reply(response, 503, 'Service unavailable'); return; }
            const controller = new AbortController();
            active.add(controller);
            const onClose = () => { if (!response.writableEnded) controller.abort(); };
            const onAbort = () => controller.abort();
            response.once('close', onClose);
            request.once('aborted', onAbort);
            const timer = setTimeout(() => { reply(response, 503, 'Service unavailable'); controller.abort(); }, timeout);
            let restoreNative: (() => void) | undefined;
            try {
                const rawUrl = request.url ?? '';
                if (!rawUrl.startsWith('/') || rawUrl.startsWith('//') || !requestAllowed(request)) {
                    reply(response, 400, 'Invalid request'); return;
                }
                const url = new URL(rawUrl, issuer.origin);
                const origin = request.headers.origin;
                const isMcp = url.pathname === resource.pathname || url.pathname.startsWith('/.well-known/oauth-');
                const interaction = /^\/oauth\/interaction\/([A-Za-z0-9_-]{16,256})$/.exec(url.pathname);
                const length = request.headers['content-length'];
                if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > (interaction ? maxForm : maxBody))) {
                    reply(response, 413, 'Request too large'); return;
                }
                if (isMcp) {
                    const headers = new Headers();
                    for (const [name, value] of Object.entries(request.headers)) {
                        if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
                    }
                    const hasBody = !['GET', 'HEAD'].includes(request.method ?? 'GET');
                    // A Fetch body cancellation must not destroy the Node request and replace a denial with 503.
                    let body: Uint8Array<ArrayBuffer> | undefined;
                    if (hasBody) {
                        try { body = await bodyBytes(request, AbortSignal.any([controller.signal, AbortSignal.timeout(Math.min(timeout, 10_000))]), maxBody); }
                        catch (error) { reply(response, error instanceof RangeError ? 413 : 400, 'Invalid request body'); return; }
                    }
                    const incoming = new Request(url, { method: request.method, headers, signal: controller.signal,
                        ...(hasBody ? { body } : {}) });
                    const result = await mcp.fetch(incoming);
                    controller.signal.throwIfAborted();
                    response.statusCode = result.status;
                    result.headers.forEach((value, name) => response.setHeader(name, value));
                    if (result.body) {
                        const reader = result.body.getReader();
                        const cancel = () => { void reader.cancel().catch(() => {}); };
                        controller.signal.addEventListener('abort', cancel, { once: true });
                        try {
                            while (true) {
                                const part = await reader.read();
                                controller.signal.throwIfAborted();
                                if (part.done) break;
                                if (!response.write(part.value)) await new Promise<void>((resolve, reject) => {
                                    const stopped = () => { cleanup(); reject(new Error()); };
                                    const drained = () => { cleanup(); resolve(); };
                                    const cleanup = () => { response.off('drain', drained); controller.signal.removeEventListener('abort', stopped); };
                                    response.once('drain', drained); controller.signal.addEventListener('abort', stopped, { once: true });
                                    if (controller.signal.aborted) stopped();
                                });
                            }
                        } finally { controller.signal.removeEventListener('abort', cancel); await reader.cancel().catch(() => {}); reader.releaseLock(); }
                    }
                    response.end(); return;
                }
                if (origin !== undefined && origin !== issuer.origin && !allowedOrigins.has(origin)) {
                    reply(response, 403, 'Forbidden'); return;
                }
                if (interaction) {
                    if (url.search || !['GET', 'POST'].includes(request.method ?? '')) { reply(response, 400, 'Invalid request'); return; }
                    let details;
                    try { details = await oauth.provider.interactionDetails(request, response); }
                    catch { reply(response, 400, 'Authorization request expired'); return; }
                    const uid = interaction[1], clientId = details.params.client_id;
                    const requestedScopes = typeof details.params.scope === 'string' ? details.params.scope.split(' ').filter(Boolean) : [];
                    if (details.uid !== uid || typeof clientId !== 'string' || !clients.has(clientId) || !requestedScopes.includes('crawl:use') ||
                        requestedScopes.some(scope => !['crawl:use', 'offline_access'].includes(scope))) { reply(response, 400, 'Invalid authorization request'); return; }
                    controller.signal.throwIfAborted();
                    if (request.method === 'GET') { await page(response, uid, clientId); return; }
                    if (origin !== issuer.origin || !/^application\/x-www-form-urlencoded(?:\s*;\s*charset=utf-8)?$/i.test(request.headers['content-type'] ?? '')) {
                        reply(response, 403, 'Forbidden'); return;
                    }
                    let form;
                    try {
                        const bytes = await bodyBytes(request, AbortSignal.any([controller.signal, AbortSignal.timeout(Math.min(timeout, 10_000))]), maxForm);
                        form = new URLSearchParams(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
                    }
                    catch (error) { reply(response, error instanceof RangeError ? 413 : 400, 'Invalid form'); return; }
                    const fields = [...form.keys()];
                    if (new Set(fields).size !== fields.length || fields.some(name => !['csrf', 'apiToken', 'decision'].includes(name)) ||
                        !['allow', 'deny'].includes(form.get('decision') ?? '') || !await consumeCsrf(request, uid, form.get('csrf') ?? '')) {
                        reply(response, 403, 'Forbidden'); return;
                    }
                    cookie(response, url.pathname, '', 0);
                    controller.signal.throwIfAborted();
                    if (form.get('decision') === 'deny') {
                        await oauth.provider.interactionFinished(request, response, { error: 'access_denied' }, { mergeWithLastSubmission: false }); return;
                    }
                    const apiToken = form.get('apiToken') ?? '';
                    let accepted;
                    try { accepted = await verifyApiKey(apiToken, controller.signal); }
                    catch { if (!controller.signal.aborted) await page(response, uid, clientId, 503, 'Key verification is temporarily unavailable.'); return; }
                    controller.signal.throwIfAborted();
                    if (accepted !== true) { await page(response, uid, clientId, 401, 'The API key was not accepted.'); return; }
                    const binding = await authorizeCredential(apiToken);
                    controller.signal.throwIfAborted();
                    const grantId = await oauth.createGrant(binding, clientId, requestedScopes, controller.signal);
                    controller.signal.throwIfAborted();
                    await oauth.provider.interactionFinished(request, response,
                        { login: { accountId: binding.id }, consent: { grantId } }, { mergeWithLastSubmission: false });
                    return;
                }
                // Native provider parsers use IncomingMessage.iterator(); retain their parsing and enforce our limits.
                const originalIterator = request.iterator;
                request.iterator = function (iteratorOptions) {
                    const input = originalIterator.call(this, iteratorOptions);
                    return (async function* () {
                        let size = 0;
                        for await (const chunk of input) {
                            controller.signal.throwIfAborted();
                            size += Buffer.byteLength(chunk);
                            if (size > maxBody) throw new RangeError('Request too large');
                            yield chunk;
                        }
                        controller.signal.throwIfAborted();
                    })();
                };
                const stopNative = () => { if (!request.complete) request.destroy(); };
                controller.signal.addEventListener('abort', stopNative, { once: true });
                restoreNative = () => { request.iterator = originalIterator; controller.signal.removeEventListener('abort', stopNative); };
                controller.signal.throwIfAborted();
                await oauth.callback(request, response, controller.signal);
            } catch { reply(response, 503, 'Service unavailable'); }
            finally {
                clearTimeout(timer); active.delete(controller);
                restoreNative?.();
                response.off('close', onClose); request.off('aborted', onAbort);
            }
        },
        async close() { closed = true; for (const controller of active) controller.abort(); await mcp.close(); },
    };
}
