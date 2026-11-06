import type { IncomingMessage, ServerResponse } from 'node:http';
import { AsyncLocalStorage } from 'node:async_hooks';
import Provider, { errors, interactionPolicy, type Configuration, type SigningAlgorithm } from 'oidc-provider';
import type { OAuthMetadata } from '@modelcontextprotocol/server';
import type { OAuthHttpHandlerOptions } from './oauth-resource.js';
import { createRedisAdapterFactory } from './redis/provider-adapter.js';
import { type CredentialBinding, type RedisCredentialStore } from './redis/credential-store.js';
import { RedisStoreError, type StoreOptions, validateStoreOptions } from './redis/shared.js';

export interface OAuthFixedClient {
    clientId: string;
    clientSecret: string;
    redirectUris: readonly string[];
    name?: string;
}

type Lifetime = 'AccessToken' | 'AuthorizationCode' | 'RefreshToken' | 'Grant' | 'Session' | 'Interaction';
export interface OAuthProviderOptions {
    issuerUrl: string;
    resourceUrl: string;
    clients: readonly OAuthFixedClient[];
    /** Deployment-owned signing keys, with the current key first. Never generate these at startup. */
    cookieKeys: readonly string[];
    jwks: NonNullable<Configuration['jwks']>;
    store: StoreOptions;
    credentials: RedisCredentialStore;
    ttl?: Partial<Record<Lifetime, number>>;
}

export interface OAuthProviderHost {
    provider: Provider;
    callback: (request: IncomingMessage, response: ServerResponse, signal?: AbortSignal) => Promise<void>;
    metadata: OAuthMetadata;
    verifyCredential: OAuthHttpHandlerOptions['verifyCredential'];
    /** Call only after upstream key validation and explicit consent. */
    createGrant: (binding: CredentialBinding, clientId: string, scopes: readonly string[], signal: AbortSignal) => Promise<string>;
}

const scopes = ['crawl:use', 'offline_access'];
const defaults: Record<Lifetime, number> = {
    AccessToken: 300, AuthorizationCode: 60, RefreshToken: 2_592_000,
    Grant: 2_592_000, Session: 2_592_000, Interaction: 300,
};

function configuredUrl(value: string, redirect = false): URL {
    const url = new URL(value);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
        url.username || url.password || url.hash || value.includes('#') || (!redirect && (url.search || value.includes('?'))) ||
        (url.href !== value && value !== url.origin) || value.includes('*')) throw new Error();
    return url;
}

function secret(value: unknown): value is string {
    return typeof value === 'string' && Buffer.byteLength(value) >= 32 && Buffer.byteLength(value) <= 4096 && !/[\x00-\x20\x7f]/.test(value);
}

function signingAlgorithm(jwks: NonNullable<Configuration['jwks']>): SigningAlgorithm {
    const supported: SigningAlgorithm[] = ['RS256', 'PS256', 'ES256', 'EdDSA', 'Ed25519'];
    for (const key of jwks.keys) {
        if (key.use !== undefined && key.use !== 'sig') continue;
        if (key.alg !== undefined) {
            const algorithm = supported.find(value => value === key.alg);
            if (algorithm) return algorithm;
        } else if (key.kty === 'RSA') return 'RS256';
        else if (key.kty === 'EC' && key.crv === 'P-256') return 'ES256';
        else if (key.kty === 'OKP' && key.crv === 'Ed25519') return 'Ed25519';
    }
    throw new Error();
}

/** Internal real Authorization Server. The host owns HTTP/TLS, consent and connected Redis. */
export function createOAuthProvider(options: OAuthProviderOptions): OAuthProviderHost {
    let issuer: URL;
    let resource: URL;
    let clients: OAuthFixedClient[];
    let ttl: Record<Lifetime, number>;
    let jwks: NonNullable<Configuration['jwks']>;
    let issuerIdentifier: string;
    let cookieKeys: string[];
    let store: StoreOptions;
    let resolveCredential: RedisCredentialStore['resolve'];
    let clientSigningAlgorithm: SigningAlgorithm;
    try {
        store = { command: options.store.command, namespace: options.store.namespace, maxTtlSeconds: options.store.maxTtlSeconds };
        validateStoreOptions(store);
        issuerIdentifier = options.issuerUrl;
        issuer = configuredUrl(issuerIdentifier);
        resource = configuredUrl(options.resourceUrl);
        if (!Array.isArray(options.clients) || !options.clients.length || !Array.isArray(options.cookieKeys) ||
            !options.cookieKeys.length || !options.cookieKeys.every(secret) ||
            typeof options.credentials?.resolve !== 'function' || typeof options.credentials?.authorize !== 'function' ||
            typeof options.credentials?.revoke !== 'function') throw new Error();
        cookieKeys = [...options.cookieKeys];
        resolveCredential = options.credentials.resolve.bind(options.credentials);
        clients = structuredClone(options.clients) as OAuthFixedClient[];
        const ids = new Set<string>();
        for (const client of clients) {
            if (typeof client.clientId !== 'string' || !client.clientId.length || client.clientId.length > 256 ||
                /[\x00-\x20\x7f]/.test(client.clientId) || ids.has(client.clientId) || !secret(client.clientSecret) ||
                !Array.isArray(client.redirectUris) || !client.redirectUris.length ||
                new Set(client.redirectUris).size !== client.redirectUris.length) throw new Error();
            ids.add(client.clientId);
            if (client.name !== undefined && (typeof client.name !== 'string' || !client.name.trim() ||
                client.name.length > 100 || /[\x00-\x1f\x7f]/.test(client.name))) throw new Error();
            for (const uri of client.redirectUris) configuredUrl(uri, true);
        }
        ttl = { ...defaults };
        if (options.ttl && Object.keys(options.ttl).some(name => !Object.hasOwn(defaults, name))) throw new Error();
        for (const name of Object.keys(ttl) as Lifetime[]) {
            ttl[name] = options.ttl?.[name] ?? Math.min(defaults[name], store.maxTtlSeconds);
            if (!Number.isSafeInteger(ttl[name]) || ttl[name] < 1 || ttl[name] > store.maxTtlSeconds) throw new Error();
        }
        jwks = structuredClone(options.jwks);
        if (!jwks || !Array.isArray(jwks.keys) || !jwks.keys.length) throw new Error();
        clientSigningAlgorithm = signingAlgorithm(jwks);
    } catch { throw new Error('Invalid OAuth provider configuration'); }

    const clientIds = new Set(clients.map(client => client.clientId));
    const requestSignals = new AsyncLocalStorage<AbortSignal>();
    const checkRequest = () => { if (requestSignals.getStore()?.aborted) throw new RedisStoreError(); };
    const Adapter = createRedisAdapterFactory({ ...store, invalidGrant: () => new errors.InvalidGrant(), command: async args => {
        checkRequest();
        const result = await store.command(args);
        checkRequest();
        return result;
    } });
    const grantAdapter = new Adapter('Grant');
    const policy = interactionPolicy.base();
    policy.get('login')!.checks.add(new interactionPolicy.Check('missing_live_account',
        'Current Crawl authorization is required', 'login_required', ctx => !ctx.oidc.account));
    let provider: Provider;

    async function liveBinding(grantId: string, accountId: string, clientId: string, signal = requestSignals.getStore()) {
        try {
            signal?.throwIfAborted();
            const grant = await provider.Grant.find(grantId, { ignoreExpiration: true });
            signal?.throwIfAborted();
            if (!grant || grant.isExpired || grant.accountId !== accountId || grant.clientId !== clientId) return undefined;
            const binding = await grantAdapter.getGrantBinding(grantId);
            signal?.throwIfAborted();
            if (!binding || binding.bindingId !== accountId) return undefined;
            const identity = await resolveCredential(binding.bindingId, binding.version);
            signal?.throwIfAborted();
            if (!identity || identity.subject !== accountId || grant.isExpired) return undefined;
            return { grant, binding, identity };
        } catch { throw new RedisStoreError(); }
    }

    try {
        provider = new Provider(issuerIdentifier, {
            adapter: Adapter,
            // Static clients are validated lazily; the library's default RS256 requires an RSA signing key.
            clientDefaults: { id_token_signed_response_alg: clientSigningAlgorithm },
            clients: clients.map(client => ({
                client_id: client.clientId, client_name: client.name, client_secret: client.clientSecret, redirect_uris: [...client.redirectUris],
                grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
                token_endpoint_auth_method: 'client_secret_basic', scope: scopes.join(' '),
            })),
            cookies: {
                keys: cookieKeys,
                long: { httpOnly: true, sameSite: 'lax', secure: issuer.protocol === 'https:' },
                short: { httpOnly: true, sameSite: 'lax', secure: issuer.protocol === 'https:' },
            },
            jwks, ttl, scopes, responseTypes: ['code'], clientAuthMethods: ['client_secret_basic'],
            pkce: { required: () => true },
            rotateRefreshToken: true, expiresWithSession: () => false,
            // Explicit ongoing Crawl consent also covers OAuth clients that do not send OIDC prompt/offline_access.
            issueRefreshToken: (_ctx, client, source) => client.grantTypeAllowed('refresh_token') && source.scopes.has('crawl:use'),
            features: {
                devInteractions: { enabled: false }, registration: { enabled: false },
                registrationManagement: { enabled: false }, clientIdMetadataDocument: { enabled: false },
                userinfo: { enabled: false }, rpInitiatedLogout: { enabled: false },
                dPoP: { enabled: false }, pushedAuthorizationRequests: { enabled: false },
                introspection: { enabled: true, allowedPolicy: (_ctx, client, token) => client.clientId === token.clientId },
                revocation: { enabled: true, allowedPolicy: (_ctx, client, token) => client.clientId === token.clientId },
                resourceIndicators: {
                    enabled: true, defaultResource: () => resource.href, useGrantedResource: () => true,
                    getResourceServerInfo: (_ctx, identifier) => {
                        if (identifier !== resource.href) throw new errors.InvalidTarget();
                        return { scope: 'crawl:use', audience: resource.href, accessTokenFormat: 'opaque', accessTokenTTL: ttl.AccessToken };
                    },
                },
            },
            findAccount: async (ctx, accountId, source) => {
                const clientId = ctx.oidc.client?.clientId;
                const grantId = (source as { grantId?: string } | undefined)?.grantId
                    ?? ctx.oidc.result?.consent?.grantId ?? (clientId ? ctx.oidc.session?.grantIdFor(clientId) : undefined);
                if (!clientId || !clientIds.has(clientId) || !grantId || !await liveBinding(grantId, accountId, clientId)) return undefined;
                return { accountId, claims: async () => ({ sub: accountId }) };
            },
            interactions: { policy, url: (_ctx, interaction) => `/oauth/interaction/${interaction.uid}` },
            renderError: async (ctx, out) => {
                ctx.type = 'application/json';
                ctx.body = { error: out.error };
            },
        });
    } catch { throw new Error('Invalid OAuth provider configuration'); }
    provider.proxy = false;
    const callback = provider.callback();
    const metadata: OAuthMetadata = {
        issuer: provider.issuer, authorization_endpoint: provider.urlFor('authorization'), token_endpoint: provider.urlFor('token'),
        jwks_uri: provider.urlFor('jwks'), revocation_endpoint: provider.urlFor('revocation'), introspection_endpoint: provider.urlFor('introspection'),
        response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'],
        // The provider retains its OpenID internals; fixed client scope rejects openid requests.
        token_endpoint_auth_methods_supported: ['client_secret_basic'], code_challenge_methods_supported: ['S256'], scopes_supported: [...scopes, 'openid'],
    };

    return {
        provider, callback: async (request, response, signal) => {
            const handle = async () => { checkRequest(); await callback(request, response); checkRequest(); };
            if (signal) await requestSignals.run(signal, handle);
            else await handle();
        }, metadata,
        createGrant: (binding, clientId, grantedScopes, signal) => requestSignals.run(signal, async () => {
            try {
                signal.throwIfAborted();
                if (!clientIds.has(clientId) || !Array.isArray(grantedScopes) || !grantedScopes.includes('crawl:use') ||
                    grantedScopes.some(scope => !scopes.includes(scope))) throw new errors.InvalidGrant();
                const identity = await resolveCredential(binding.id, binding.version);
                signal.throwIfAborted();
                if (!identity || identity.subject !== binding.id) throw new errors.InvalidGrant();
                const grant = new provider.Grant({ accountId: binding.id, clientId });
                grant.addOIDCScope(grantedScopes.join(' '));
                grant.addResourceScope(resource.href, 'crawl:use');
                const grantId = await grant.save();
                signal.throwIfAborted();
                const current = await liveBinding(grantId, binding.id, clientId, signal);
                signal.throwIfAborted();
                if (!current || current.binding.version !== binding.version) throw new errors.InvalidGrant();
                return grantId;
            } catch (error) {
                if (error instanceof errors.InvalidGrant) throw error;
                throw new RedisStoreError();
            }
        }),
        verifyCredential: (rawToken, signal) => requestSignals.run(signal, async () => {
            try {
                signal.throwIfAborted();
                if (typeof rawToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(rawToken)) return null;
                const token = await provider.AccessToken.find(rawToken);
                const expiresAt = token?.exp;
                signal.throwIfAborted();
                if (!token?.isValid || token.tokenType !== 'Bearer' || typeof expiresAt !== 'number' || !Number.isSafeInteger(expiresAt) ||
                    expiresAt <= Date.now() / 1000 || token.aud !== resource.href || !token.accountId ||
                    !token.grantId || !token.clientId || !clientIds.has(token.clientId) || typeof token.scope !== 'string') return null;
                const client = await provider.Client.find(token.clientId);
                signal.throwIfAborted();
                if (!client || client.clientId !== token.clientId) return null;
                const current = await liveBinding(token.grantId, token.accountId, token.clientId, signal);
                signal.throwIfAborted();
                if (!current || expiresAt <= Date.now() / 1000) return null;
                const actualScopes = token.scope.split(' ').filter(Boolean);
                const granted = new Set(current.grant.getResourceScope(resource.href).split(' '));
                if (actualScopes.some(scope => scope !== 'crawl:use' || !granted.has(scope))) return null;
                return {
                    authInfo: { token: rawToken, clientId: token.clientId, scopes: actualScopes, expiresAt, resource: new URL(token.aud) },
                    identity: current.identity,
                };
            } catch { throw new RedisStoreError(); }
        }),
    };
}
