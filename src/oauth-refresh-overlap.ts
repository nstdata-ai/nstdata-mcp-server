import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type Provider from 'oidc-provider';
import { createRedisKeys, RedisStoreError, type StoreOptions } from './redis/shared.js';

interface Options { provider: Provider; store: StoreOptions; cookieKeys: readonly string[]; seconds: number; leaseMs: number }
// Check state and lease ownership in the same Redis transaction as publishing/reading.
// References are generated locally; none are accepted from request fields or cache plaintext.
const live = `
local time=redis.call('TIME')
local now=tonumber(time[1])
local ms=now*1000+math.floor(tonumber(time[2])/1000)
local function payload(key)
 local raw=redis.call('HGET',key,'payload')
 if not raw or redis.call('HGET',key,'destroyed') or tonumber(redis.call('HGET',key,'expiresAt') or '0')<=now then return nil end
 local ok,p=pcall(cjson.decode,raw)
 if not ok or type(p)~='table' or type(p.exp)~='number' or p.exp<=now then return nil end
 return p
end
local old=payload(KEYS[2])
local next=payload(KEYS[3])
if not old or not next or not redis.call('HGET',KEYS[2],'consumed') or redis.call('HGET',KEYS[3],'consumed') then return nil end
if old.grantId~=ARGV[1] or next.grantId~=ARGV[1] or old.clientId~=ARGV[2] or next.clientId~=ARGV[2] or old.accountId~=next.accountId then return nil end
local remaining=tonumber(redis.call('HGET',KEYS[2],'consumedAtMs') or '0')+tonumber(ARGV[3])-ms
if remaining<=0 then return nil end
local access=payload(KEYS[7])
if not access or access.grantId~=ARGV[1] or access.clientId~=ARGV[2] or access.accountId~=old.accountId then return nil end
local parent=payload(KEYS[4])
if not parent or parent.clientId~=ARGV[2] or parent.accountId~=old.accountId or redis.call('EXISTS',KEYS[5])~=0 then return nil end
if redis.call('HGET',KEYS[4],'bindingId')~=old.accountId or redis.call('HGET',KEYS[4],'bindingKey')~=KEYS[6] then return nil end
if redis.call('HGET',KEYS[6],'active')~='1' or redis.call('HGET',KEYS[6],'version')~=redis.call('HGET',KEYS[4],'bindingVersion') then return nil end
`;
const read = live + `return {redis.call('GET',KEYS[1]),tostring(now)}`;
const publish = live + `
for i=8,#KEYS do if redis.call('GET',KEYS[i])~=ARGV[4] then return nil end end
redis.call('SET',KEYS[1],ARGV[5],'PX',remaining,'NX')
return 1
`;
const acquire = `for _,key in ipairs(KEYS) do if redis.call('EXISTS',key)~=0 then return 0 end end
for _,key in ipairs(KEYS) do redis.call('SET',key,ARGV[1],'PX',ARGV[2]) end
return 1`;
const release = `for _,key in ipairs(KEYS) do if redis.call('GET',key)==ARGV[1] then redis.call('DEL',key) end end return 1`;

/** Only identical public-client retries of the immediate predecessor can reuse a response. */
export function createRefreshOverlap({ provider, store, cookieKeys, seconds, leaseMs }: Options): Parameters<Provider['use']>[0] {
    const keys = createRedisKeys(store.namespace);
    const ring = cookieKeys.map(key => ({
        index: createHmac('sha256', key).update(`nstdata-refresh-index\0${store.namespace}`).digest(),
        cipher: createHmac('sha256', key).update(`nstdata-refresh-cipher\0${store.namespace}`).digest(),
    }));
    const digest = (key: Buffer, value: string) => createHmac('sha256', key).update(value).digest('hex');
    const execute = async (args: string[]) => { try { return await store.command(args); } catch { throw new RedisStoreError(); } };
    const evalScript = (script: string, refs: string[], args: string[]) => execute(['EVAL', script, String(refs.length), ...refs, ...args]);
    return async (ctx, next) => {
        if (!seconds || ctx.method !== 'POST' || ctx.path !== provider.pathFor('token') ||
            ctx.req.headers.authorization !== undefined || ctx.querystring || ctx.get('dpop') || ctx.get('oauth-client-attestation') ||
            !/^application\/x-www-form-urlencoded(?:\s*;\s*charset=utf-8)?$/i.test(ctx.get('content-type'))) return next();
        let form: URLSearchParams;
        try {
            const chunks: Buffer[] = []; let size = 0;
            for await (const chunk of ctx.req.iterator({ destroyOnReturn: false })) {
                size += Buffer.byteLength(chunk);
                if (size > 32_768) throw new Error();
                chunks.push(Buffer.from(chunk));
            }
            const body = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
            if (/%(?![a-fA-F0-9]{2})/.test(body)) throw new Error();
            // URLSearchParams replaces malformed escaped UTF-8; validate before that lossy conversion.
            for (const part of body.split('&')) for (const value of part.split('=')) decodeURIComponent(value.replaceAll('+', ' '));
            form = new URLSearchParams(body);
            const names = [...form.keys()];
            if (names.length > 64 || new Set(names).size !== names.length) throw new Error();
            (ctx.req as IncomingMessage & { body: unknown }).body = Object.fromEntries(form);
        } catch { ctx.status = 400; ctx.body = { error: 'invalid_request' }; return; }
        const raw = form.get('refresh_token'), clientId = form.get('client_id');
        if (form.get('grant_type') !== 'refresh_token' || !raw || !/^[A-Za-z0-9_-]{43}$/.test(raw) || !clientId ||
            form.has('client_secret') || form.has('client_assertion') || form.has('client_assertion_type')) return next();
        const client = await provider.Client.find(clientId);
        if (!client || client.tokenEndpointAuthMethod !== 'none') return next();
        const canonical = JSON.stringify([...form.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
        const candidates = ring.map(key => ({ ...key, cache: `${keys.prefix}refresh-response:${digest(key.index, raw)}`,
            lease: `${keys.prefix}refresh-lease:${digest(key.index, raw)}`, fingerprint: digest(key.index, canonical) }));
        const leases = [...new Set(candidates.map(key => key.lease))];
        const owner = randomBytes(32).toString('hex');
        const refs = (cache: string, old: { grantId?: string; accountId?: string }, successor: string, access: string) => [cache,
            keys.record('RefreshToken', raw), keys.record('RefreshToken', successor),
            keys.record('Grant', old.grantId!), keys.revoked(old.grantId!), keys.binding(old.accountId!), keys.record('AccessToken', access)];
        let cacheMismatch = false, exactCachePresent = false;
        async function cached(): Promise<Record<string, unknown> | undefined> {
            for (const candidate of candidates) {
                const sealed = await execute(['GET', candidate.cache]);
                if (sealed === null) continue;
                if (typeof sealed !== 'string' || sealed.length > 32_768) throw new RedisStoreError();
                let value;
                try {
                    const bytes = Buffer.from(sealed, 'base64url');
                    const decipher = createDecipheriv('aes-256-gcm', candidate.cipher, bytes.subarray(0, 12));
                    decipher.setAAD(Buffer.from(candidate.cache)); decipher.setAuthTag(bytes.subarray(12, 28));
                    value = JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString());
                } catch { throw new RedisStoreError(); }
                if (!value || value.fingerprint !== candidate.fingerprint) { cacheMismatch = true; continue; }
                exactCachePresent = true;
                if (typeof value.successor !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.successor) ||
                    typeof value.grantId !== 'string' || typeof value.accountId !== 'string' || !value.body || typeof value.body.access_token !== 'string' || typeof value.exp !== 'number') throw new RedisStoreError();
                const found = await evalScript(read, refs(candidate.cache, value, value.successor, value.body.access_token), [value.grantId, clientId!, String(seconds * 1000)]);
                if (!Array.isArray(found) || found[0] !== sealed || typeof found[1] !== 'string') continue;
                const expires = value.exp - Number(found[1]);
                if (expires <= 0) continue;
                return { ...value.body, expires_in: expires };
            }
            return undefined;
        }
        // Wait only for this predecessor's in-flight rotation, bounded below the lease.
        const deadline = Date.now() + 2000;
        let owned = false;
        while (!owned) {
            const hit = await cached();
            if (hit) { ctx.status = 200; ctx.set('Cache-Control', 'no-store'); ctx.body = hit; return; }
            if (cacheMismatch) { ctx.status = 400; ctx.body = { error: 'invalid_grant' }; return; }
            owned = await evalScript(acquire, leases, [owner, String(leaseMs)]) === 1;
            if (!owned) {
                if (Date.now() >= deadline) { ctx.status = 503; ctx.body = { error: 'temporarily_unavailable' }; return; }
                await new Promise(resolve => setTimeout(resolve, 20));
            }
        }
        try {
            const hit = await cached();
            if (hit) { ctx.status = 200; ctx.set('Cache-Control', 'no-store'); ctx.body = hit; return; }
            if (cacheMismatch) { ctx.status = 400; ctx.body = { error: 'invalid_grant' }; return; }
            const old = await provider.RefreshToken.find(raw, { ignoreExpiration: true });
            if (old?.consumed && old.clientId === clientId && !exactCachePresent) {
                // An interrupted first rotation must not be retried as a second rotation while its
                // response could still be publishing. After the window, normal reuse policy applies.
                const recent = await evalScript(`local t=redis.call('TIME'); local ms=tonumber(t[1])*1000+math.floor(tonumber(t[2])/1000)
return tonumber(redis.call('HGET',KEYS[1],'consumedAtMs') or '0')+tonumber(ARGV[1])>ms and 1 or 0`, [keys.record('RefreshToken', raw)], [String(seconds * 1000)]);
                if (recent === 1) { ctx.status = 503; ctx.body = { error: 'temporarily_unavailable' }; return; }
            }
            await next();
            const body = ctx.body as Record<string, unknown> | undefined;
            if (ctx.status !== 200 || !old || old.clientId !== clientId || !old.grantId || !old.accountId ||
                !body || typeof body.refresh_token !== 'string' || typeof body.access_token !== 'string') return;
            const token = await provider.AccessToken.find(body.access_token);
            if (!token?.exp) throw new RedisStoreError();
            const current = candidates[0];
            const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', current.cipher, iv);
            cipher.setAAD(Buffer.from(current.cache));
            const ciphertext = Buffer.concat([cipher.update(JSON.stringify({ fingerprint: current.fingerprint,
                successor: body.refresh_token, grantId: old.grantId, accountId: old.accountId, exp: token.exp, body })), cipher.final()]);
            const sealed = Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url');
            const saved = await evalScript(publish, [...refs(current.cache, old, body.refresh_token, body.access_token), ...leases],
                [old.grantId, clientId, String(seconds * 1000), owner, sealed]);
            if (saved !== 1) { ctx.status = 503; ctx.body = { error: 'temporarily_unavailable' }; }
        } finally { await evalScript(release, leases, [owner]); }
    };
}
