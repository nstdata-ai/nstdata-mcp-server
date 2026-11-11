import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { constants as cryptoConstants, checkPrimeSync, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import type { JsonWebKey } from 'node:crypto';
import { isIP } from 'node:net';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import type { OAuthFixedClient, OAuthProviderOptions } from './oauth-provider.js';
import { mcpEndpointPath, trustedProxyPeers } from './remote-request.js';

export interface RemoteServiceConfig {
    issuerUrl: string;
    mcpPath?: string;
    listen: { host: string; port: number; tls?: { keyFile: string; certFile: string } };
    trustedProxyCidrs?: string[];
    redis: { url?: string; socketPath?: string; namespace: string };
    clients: OAuthFixedClient[];
    cookieKeys: string[];
    jwks: OAuthProviderOptions['jwks'];
    encryptionKeys: Record<string, Uint8Array>;
    currentKeyId: string;
    fingerprintKey: Uint8Array;
    allowedOrigins: string[];
}

export class RemoteConfigurationError extends Error {
    constructor() {
        super('Invalid Remote configuration. Check the protected configuration file.');
        this.name = 'RemoteConfigurationError';
    }
}

const MAX_FILE_BYTES = 1_048_576;
const keyId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
const secret = z.string().refine(value => Buffer.byteLength(value) >= 32 && Buffer.byteLength(value) <= 4096 &&
    !/[\s\u0000-\u001f\u007f]/u.test(value) && Buffer.from(value).toString() === value);
const absoluteFile = z.string().min(1).max(4096).refine(value => isAbsolute(value) && !/[\u0000-\u001f\u007f]/u.test(value));
const base64Key = z.string().regex(/^[A-Za-z0-9_-]{43}$/).refine(value => {
    const bytes = Buffer.from(value, 'base64url');
    return bytes.length === 32 && bytes.toString('base64url') === value;
});
const jwkField = z.string().min(1).max(16_384);
const jwk = z.strictObject({
    kty: z.enum(['RSA', 'EC', 'OKP']), kid: keyId, use: z.literal('sig'),
    alg: z.enum(['RS256', 'PS256', 'ES256', 'EdDSA', 'Ed25519']),
    key_ops: z.array(z.literal('sign')).length(1).optional(),
    n: jwkField.optional(), e: jwkField.optional(), d: jwkField,
    p: jwkField.optional(), q: jwkField.optional(), dp: jwkField.optional(), dq: jwkField.optional(), qi: jwkField.optional(),
    crv: jwkField.optional(), x: jwkField.optional(), y: jwkField.optional(),
});
const configuration = z.strictObject({
    issuerUrl: z.string().min(1).max(8192),
    mcpPath: z.string().default('/mcp'),
    listen: z.strictObject({ host: z.string().refine(value => isIP(value) !== 0), port: z.number().int().min(1).max(65535),
        tls: z.strictObject({ keyFile: absoluteFile, certFile: absoluteFile }).optional() }),
    trustedProxyCidrs: z.array(z.string()).min(1).max(32).optional(),
    redis: z.strictObject({ url: z.string().min(1).max(8192).optional(), socketPath: absoluteFile.optional(), namespace: keyId }),
    clients: z.array(z.strictObject({
        clientId: z.string().min(1).max(256).regex(/^[^\s\u0000-\u001f\u007f]+$/u), clientSecret: secret,
        redirectUris: z.array(z.string().min(1).max(8192)).min(1).max(16),
        name: z.string().min(1).max(100).refine(value => value.trim().length > 0 && !/[\u0000-\u001f\u007f]/u.test(value)).optional(),
    })).min(1).max(32),
    cookieKeys: z.array(secret).min(1).max(8),
    jwks: z.strictObject({ keys: z.array(jwk).min(1).max(8) }),
    encryptionKeys: z.record(keyId, base64Key).refine(value => Object.keys(value).length >= 1 && Object.keys(value).length <= 16),
    currentKeyId: keyId,
    fingerprintKey: base64Key,
    allowedOrigins: z.array(z.string().min(1).max(8192)).max(32).default([]),
});

function webUrl(value: string, originOnly: boolean): URL {
    const url = new URL(value);
    const loopback = ['127.0.0.1', '[::1]'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || url.username || url.password ||
        value.includes('#') || value.includes('*') || (url.href !== value && value !== url.origin) ||
        (originOnly && (url.pathname !== '/' || value.includes('?')))) throw new Error();
    return url;
}

function checkRsaParameters(value: z.infer<typeof jwk>): void {
    const fields = ['n', 'e', 'd', 'p', 'q', 'dp', 'dq', 'qi'] as const;
    const size = Buffer.from(value.n!, 'base64url').length;
    const values = fields.map(field => {
        const bytes = Buffer.from(value[field]!, 'base64url');
        if (!bytes.length || bytes.length > size || bytes[0] === 0) throw new Error();
        return BigInt('0x' + bytes.toString('hex'));
    });
    const [n, e, d, p, q, dp, dq, qi] = values;
    if (p <= 2n || q <= 2n || p === q || p * q !== n || e < 3n || e >= n || d < 1n || d >= n ||
        (p & 1n) === 0n || (q & 1n) === 0n || (e & 1n) === 0n) throw new Error();
    let a = p - 1n, b = q - 1n;
    while (b) { const remainder = a % b; a = b; b = remainder; }
    if ((e * d) % ((p - 1n) / a * (q - 1n)) !== 1n || dp !== d % (p - 1n) || dq !== d % (q - 1n) ||
        qi < 1n || qi >= p || (qi * q) % p !== 1n || !checkPrimeSync(p, { checks: 32 }) || !checkPrimeSync(q, { checks: 32 })) throw new Error();
}

function checkSigningKey(value: z.infer<typeof jwk>): void {
    for (const field of ['n', 'e', 'd', 'p', 'q', 'dp', 'dq', 'qi', 'x', 'y'] as const) {
        const data = value[field];
        if (data !== undefined && (!/^[A-Za-z0-9_-]+$/.test(data) || Buffer.from(data, 'base64url').toString('base64url') !== data)) throw new Error();
    }
    if ((value.kty === 'RSA' && !['RS256', 'PS256'].includes(value.alg)) ||
        (value.kty === 'EC' && (value.alg !== 'ES256' || value.crv !== 'P-256')) ||
        (value.kty === 'OKP' && (!['EdDSA', 'Ed25519'].includes(value.alg) || value.crv !== 'Ed25519'))) throw new Error();
    const unrelated = value.kty === 'RSA' ? ['crv', 'x', 'y'] : value.kty === 'EC' ? ['n', 'e', 'p', 'q', 'dp', 'dq', 'qi'] : ['n', 'e', 'p', 'q', 'dp', 'dq', 'qi', 'y'];
    if (unrelated.some(field => Object.hasOwn(value, field))) throw new Error();
    const key = createPrivateKey({ key: value as JsonWebKey, format: 'jwk' });
    if (value.kty === 'RSA' && (!key.asymmetricKeyDetails?.modulusLength ||
        key.asymmetricKeyDetails.modulusLength < 2048 || key.asymmetricKeyDetails.modulusLength > 8192)) throw new Error();
    // Native RSA signing can use CRT values without checking that d describes the same private key.
    if (value.kty === 'RSA') checkRsaParameters(value);
    const options = value.alg === 'PS256' ? { key, padding: cryptoConstants.RSA_PKCS1_PSS_PADDING, saltLength: 32 } : key;
    const publicKey = createPublicKey(key);
    const publicOptions = value.alg === 'PS256' ? { key: publicKey, padding: cryptoConstants.RSA_PKCS1_PSS_PADDING, saltLength: 32 } : publicKey;
    const algorithm = value.kty === 'OKP' ? null : 'sha256';
    const probe = Buffer.from('Nstdata OAuth signing-key validation');
    if (!verify(algorithm, probe, publicOptions, sign(algorithm, probe, options))) throw new Error();
}

/** Parse deployment-owned configuration without opening sockets or reading credential environment variables. */
export function parseRemoteConfig(value: unknown): RemoteServiceConfig {
    try {
        const parsed = configuration.parse(value);
        const issuer = webUrl(parsed.issuerUrl, true);
        mcpEndpointPath(parsed.mcpPath);
        trustedProxyPeers(parsed.trustedProxyCidrs);
        if (issuer.protocol === 'http:') {
            if (parsed.trustedProxyCidrs || parsed.listen.tls || parsed.listen.host !== issuer.hostname.replace(/^\[|\]$/g, '') ||
                parsed.listen.port !== Number(issuer.port || 80)) throw new Error();
        } else if (Boolean(parsed.listen.tls) === Boolean(parsed.trustedProxyCidrs)) throw new Error();
        if (Boolean(parsed.redis.url) === Boolean(parsed.redis.socketPath)) throw new Error();
        if (parsed.redis.url) {
            const redis = new URL(parsed.redis.url);
            if ((redis.protocol !== 'rediss:' && !(redis.protocol === 'redis:' && ['127.0.0.1', '[::1]'].includes(redis.hostname))) ||
                parsed.redis.url !== parsed.redis.url.trim() || /[\u0000-\u0020\u007f]/u.test(parsed.redis.url) ||
                !redis.hostname || parsed.redis.url.includes('?') || parsed.redis.url.includes('#') ||
                !/^\/(?:0|[1-9]\d*)?$/.test(redis.pathname || '/') ||
                (redis.pathname.length > 1 && !Number.isSafeInteger(Number(redis.pathname.slice(1))))) throw new Error();
            decodeURIComponent(redis.username); decodeURIComponent(redis.password);
        }
        const ids = new Set<string>();
        for (const client of parsed.clients) {
            if (ids.has(client.clientId) || new Set(client.redirectUris).size !== client.redirectUris.length) throw new Error();
            ids.add(client.clientId);
            for (const uri of client.redirectUris) webUrl(uri, false);
        }
        if (new Set(parsed.allowedOrigins).size !== parsed.allowedOrigins.length) throw new Error();
        for (const origin of parsed.allowedOrigins) if (webUrl(origin, true).origin !== origin) throw new Error();
        const signingIds = new Set<string>();
        for (const key of parsed.jwks.keys) {
            if (signingIds.has(key.kid)) throw new Error();
            signingIds.add(key.kid); checkSigningKey(key);
        }
        if (!Object.hasOwn(parsed.encryptionKeys, parsed.currentKeyId)) throw new Error();
        const fingerprintKey = Buffer.from(parsed.fingerprintKey, 'base64url');
        const encryptionKeys = Object.fromEntries(Object.entries(parsed.encryptionKeys).map(([id, encoded]) => {
            const bytes = Buffer.from(encoded, 'base64url');
            if (bytes.equals(fingerprintKey)) throw new Error();
            return [id, bytes];
        }));
        return { ...parsed, issuerUrl: issuer.origin, encryptionKeys, fingerprintKey };
    } catch { throw new RemoteConfigurationError(); }
}

/** Mounted symlink secrets are allowed; permissions and size are checked on the opened regular file. */
export async function loadRemoteConfig(filename: string): Promise<RemoteServiceConfig> {
    let file: Awaited<ReturnType<typeof open>> | undefined;
    try {
        if (typeof filename !== 'string' || !isAbsolute(filename) || filename.includes('\0') || filename.length > 4096) throw new Error();
        file = await open(filename, constants.O_RDONLY | constants.O_NONBLOCK);
        const info = await file.stat();
        if (!info.isFile() || info.size < 1 || info.size > MAX_FILE_BYTES || (process.platform !== 'win32' && (info.mode & 0o077) !== 0)) throw new Error();
        const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
        let used = 0;
        while (used < buffer.length) {
            const { bytesRead } = await file.read(buffer, used, buffer.length - used, null);
            if (!bytesRead) break;
            used += bytesRead;
        }
        if (used > MAX_FILE_BYTES) throw new Error();
        return parseRemoteConfig(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, used))));
    } catch { throw new RemoteConfigurationError(); }
    finally { await file?.close().catch(() => {}); }
}
