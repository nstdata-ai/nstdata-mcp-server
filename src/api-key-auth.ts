import { createHmac } from 'node:crypto';
import { validApiKey } from './api-key-verifier.js';
import type { HttpIdentity } from './http-handler.js';

/** Direct keys have request-local identities and never create or reactivate OAuth grants. */
export function createApiKeyAuthenticator(
    verify: (apiToken: string, signal: AbortSignal) => Promise<boolean>,
    identityKey: Uint8Array,
): (apiToken: string, signal: AbortSignal) => Promise<HttpIdentity | null> {
    if (typeof verify !== 'function' || !(identityKey instanceof Uint8Array) || identityKey.byteLength !== 32) {
        throw new Error('Invalid API key authentication configuration');
    }
    const key = Buffer.from(identityKey);
    return async (apiToken, signal) => {
        try {
            signal.throwIfAborted();
            if (!validApiKey(apiToken) || apiToken.includes(',')) return null;
            const accepted = await verify(apiToken, signal);
            signal.throwIfAborted();
            if (accepted !== true) return null;
            const digest = createHmac('sha256', key).update('nstdata-mcp-api-key\0').update(apiToken).digest('base64url');
            return { subject: `api-key:${digest}`, apiToken };
        } catch { throw new Error('API key authentication unavailable'); }
    };
}
