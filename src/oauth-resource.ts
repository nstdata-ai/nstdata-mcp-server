import {
    type AuthInfo, type OAuthMetadata, OAuthError, OAuthErrorCode,
    buildOAuthProtectedResourceMetadata, getOAuthProtectedResourceMetadataUrl,
    oauthMetadataResponse, requireBearerAuth,
} from '@modelcontextprotocol/server';
import { createHttpHandler, type HttpHandler, type HttpHandlerOptions, type HttpIdentity } from './http-handler.js';

export interface OAuthHttpHandlerOptions extends Omit<HttpHandlerOptions, 'authenticate'> {
    /** Trusted, deployment-owned Authorization Server discovery document, never fetched from a request. */
    oauthMetadata: OAuthMetadata;
    /**
     * Verify the AS-issued token AND the LIVE grant, client, account and credential binding/version
     * on every request. A token lookup or signature check alone does not prove a grant is active.
     * Return null for invalid/revoked credentials or bindings; throw on verifier/store failure.
     * Honor signal. AuthInfo must report the token's actual resource, expiry and scopes; never put
     * the upstream apiToken in AuthInfo, tokens, metadata or logs. No token issuance/storage here.
     */
    verifyCredential: (rawToken: string, signal: AbortSignal) => Promise<{ authInfo: AuthInfo; identity: HttpIdentity } | null>;
}

function publicUrl(value: string): URL {
    try {
        const url = new URL(value);
        const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
        if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
            url.username || url.password || url.href.includes('?') || url.href.includes('#')) throw new Error();
        return url;
    } catch { throw new Error('Invalid OAuth public URL configuration'); }
}

function reply(request: Request, response: Response): Response {
    if (request.body && !request.body.locked) void request.body.cancel().catch(() => {});
    response.headers.set('Cache-Control', 'no-store');
    return response;
}

function unavailable(): Response {
    return Response.json({ error: 'Service unavailable' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
}

/** Internal Resource Server adapter. A real AS and live credential verifier are supplied separately. */
export function createOAuthHttpHandler(options: OAuthHttpHandlerOptions): HttpHandler {
    const resource = publicUrl(options.resourceUrl);
    for (const origin of options.allowedOrigins) publicUrl(origin);
    if (typeof options.verifyCredential !== 'function') throw new Error('OAuth credential verification is required');
    const verifyCredential = options.verifyCredential;
    const oauthMetadata = structuredClone(options.oauthMetadata);
    const issuer = publicUrl(oauthMetadata.issuer);
    for (const [name, value] of Object.entries(oauthMetadata)) {
        if (name.endsWith('_endpoint') || name === 'jwks_uri') {
            if (typeof value !== 'string') throw new Error('Invalid OAuth endpoint configuration');
            publicUrl(value);
        }
    }
    const metadataOptions = { oauthMetadata, resourceServerUrl: resource, scopesSupported: ['crawl:use'],
        // publicUrl already limits HTTP to loopback; the SDK's default exception omits IPv6 loopback.
        dangerouslyAllowInsecureIssuerUrl: issuer.protocol === 'http:' };
    buildOAuthProtectedResourceMetadata(metadataOptions);
    const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(resource);
    const metadataUrls = new Set([resourceMetadataUrl, new URL('/.well-known/oauth-authorization-server', resource).href]);
    if (metadataUrls.has(resource.href)) throw new Error('OAuth resource conflicts with discovery route');
    let closed = false;
    const handler = createHttpHandler({
        ...options,
        resourceUrl: resource.href,
        authenticate: async request => {
            let identity: HttpIdentity | undefined;
            let verifierFailed = false;
            const gate = requireBearerAuth({
                expectedResource: resource,
                requiredScopes: ['crawl:use'],
                resourceMetadataUrl,
                verifier: {
                    verifyAccessToken: async rawToken => {
                        let verified;
                        try {
                            request.signal.throwIfAborted();
                            verified = await verifyCredential(rawToken, request.signal);
                        } catch {
                            verifierFailed = true;
                            throw new Error('Credential verification unavailable');
                        }
                        if (!verified || typeof verified.identity?.subject !== 'string' || !verified.identity.subject.trim() ||
                            typeof verified.identity.apiToken !== 'string' || !verified.identity.apiToken.trim()) {
                            throw new OAuthError(OAuthErrorCode.InvalidToken, 'Invalid access token');
                        }
                        identity = { subject: verified.identity.subject, apiToken: verified.identity.apiToken };
                        return verified.authInfo;
                    },
                },
            });
            const auth = await gate(request);
            if (request.signal.aborted || closed || verifierFailed || (auth instanceof Response && auth.status >= 500)) return unavailable();
            return auth instanceof Response ? auth : identity ?? null;
        },
    });
    return {
        fetch: async request => {
            if (closed) return reply(request, unavailable());
            const url = new URL(request.url);
            // The SDK discovery helper matches paths only; bind it to the configured URL authority/routes.
            if (url.origin !== resource.origin) return reply(request, Response.json({ error: 'Not found' }, { status: 404 }));
            const host = request.headers.get('host');
            if (host !== null && host.toLowerCase() !== resource.host.toLowerCase()) {
                return reply(request, Response.json({ error: 'Forbidden' }, { status: 403 }));
            }
            if (metadataUrls.has(url.href)) return reply(request, oauthMetadataResponse(request, metadataOptions)!);
            return handler.fetch(request);
        },
        close: async () => { closed = true; await handler.close(); },
    };
}
