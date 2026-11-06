import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { HttpIdentity } from '../http-handler.js';
import { createRedisKeys, RedisStoreError, type StoreOptions, validateStoreOptions } from './shared.js';

export interface RedisCredentialStoreOptions extends StoreOptions {
    /** Retain previous keys until every binding encrypted with them has expired. Keys are copied. */
    encryptionKeys: Readonly<Record<string, Uint8Array>>;
    currentKeyId: string;
    /** Independent, stable 32-byte HMAC key; changing it requires a new namespace. */
    fingerprintKey: Uint8Array;
}

export interface CredentialBinding {
    id: string;
    version: number;
}

export interface RedisCredentialStore {
    /** Call only after upstream validation and consent. A revoked binding is replaced by a new ID. */
    authorize(apiToken: string): Promise<CredentialBinding>;
    resolve(id: string, version: number): Promise<HttpIdentity | null>;
    revoke(id: string, expectedVersion?: number): Promise<boolean>;
}

interface Snapshot {
    active: string;
    version: string;
    sealed: string;
    fingerprint: string;
}

const MAX_TOKEN_BYTES = 16_384;
const ID = /^[A-Za-z0-9_-]{43}$/;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const FINGERPRINT = /^[a-f0-9]{64}$/;
// A revoked ID stays inactive, including for old consent flows that have not saved their Grant yet.
const CAS = `
local pointer = redis.call('GET', KEYS[2])
if ARGV[3] == 'new' then
    if pointer or redis.call('EXISTS', KEYS[1]) ~= 0 then return 0 end
else
    if pointer ~= ARGV[1] or redis.call('HLEN', KEYS[1]) ~= 4 then return 0 end
    local previous = redis.call('HMGET', KEYS[1], 'active', 'version', 'sealed', 'fingerprint')
    for i = 1, 4 do if previous[i] ~= ARGV[i + 3] then return 0 end end
end
if KEYS[3] ~= KEYS[1] and redis.call('EXISTS', KEYS[3]) ~= 0 then return 0 end
redis.call('HSET', KEYS[3], 'active', ARGV[8], 'version', ARGV[9], 'sealed', ARGV[10], 'fingerprint', ARGV[11])
redis.call('EXPIRE', KEYS[3], ARGV[2])
redis.call('SET', KEYS[2], ARGV[12], 'EX', ARGV[2])
return 1
`;

function tokenIsValid(value: unknown): value is string {
    return typeof value === 'string' && value.trim().length > 0 && Buffer.byteLength(value, 'utf8') <= MAX_TOKEN_BYTES &&
        Buffer.from(value, 'utf8').toString('utf8') === value;
}

function versionIsValid(value: number): boolean {
    return Number.isSafeInteger(value) && value >= 1;
}

/** Client-neutral encrypted binding storage. This factory does not validate upstream credentials. */
export function createRedisCredentialStore(options: RedisCredentialStoreOptions): RedisCredentialStore {
    let encryptionKeys: Map<string, Buffer>;
    let fingerprintKey: Buffer;
    try {
        validateStoreOptions(options);
        if (!KEY_ID.test(options.currentKeyId) || typeof options.currentKeyId !== 'string' ||
            !options.encryptionKeys || typeof options.encryptionKeys !== 'object' || Array.isArray(options.encryptionKeys) ||
            !(options.fingerprintKey instanceof Uint8Array) || options.fingerprintKey.byteLength !== 32) throw new Error();
        encryptionKeys = new Map();
        fingerprintKey = Buffer.from(options.fingerprintKey);
        for (const [keyId, value] of Object.entries(options.encryptionKeys)) {
            if (!KEY_ID.test(keyId) || !(value instanceof Uint8Array) || value.byteLength !== 32 ||
                timingSafeEqual(value, fingerprintKey)) throw new Error();
            encryptionKeys.set(keyId, Buffer.from(value));
        }
        if (!encryptionKeys.has(options.currentKeyId)) throw new Error();
    } catch {
        throw new Error('Invalid Redis credential configuration');
    }
    const { command, namespace, maxTtlSeconds, currentKeyId } = options;
    const keys = createRedisKeys(namespace);
    const fingerprint = (apiToken: string) => createHmac('sha256', fingerprintKey).update('nstdata-mcp-api-token\0').update(apiToken).digest('hex');
    const aad = (id: string, version: number, active: string, fp: string) => Buffer.from(JSON.stringify([1, namespace, id, version, active, fp]));

    function seal(apiToken: string, id: string, version: number, active: string, fp: string): string {
        const iv = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', encryptionKeys.get(currentKeyId)!, iv);
        cipher.setAAD(aad(id, version, active, fp));
        const ciphertext = Buffer.concat([cipher.update(JSON.stringify({ apiToken }), 'utf8'), cipher.final()]);
        return JSON.stringify({ v: 1, keyId: currentKeyId, iv: iv.toString('base64url'),
            tag: cipher.getAuthTag().toString('base64url'), ciphertext: ciphertext.toString('base64url') });
    }

    function decode(value: unknown, bytes?: number): Buffer {
        if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw new RedisStoreError();
        const result = Buffer.from(value, 'base64url');
        if (result.toString('base64url') !== value || (bytes !== undefined && result.length !== bytes)) throw new RedisStoreError();
        return result;
    }

    function open(snapshot: Snapshot, id: string): string {
        const envelope = JSON.parse(snapshot.sealed);
        if (!envelope || envelope.v !== 1 || typeof envelope.keyId !== 'string' ||
            !encryptionKeys.has(envelope.keyId) || Object.keys(envelope).sort().join(',') !== 'ciphertext,iv,keyId,tag,v') throw new RedisStoreError();
        const decipher = createDecipheriv('aes-256-gcm', encryptionKeys.get(envelope.keyId)!, decode(envelope.iv, 12));
        decipher.setAAD(aad(id, Number(snapshot.version), snapshot.active, snapshot.fingerprint));
        decipher.setAuthTag(decode(envelope.tag, 16));
        const plaintext = Buffer.concat([decipher.update(decode(envelope.ciphertext)), decipher.final()]).toString('utf8');
        const value = JSON.parse(plaintext);
        if (!value || Object.keys(value).join(',') !== 'apiToken' || !tokenIsValid(value.apiToken) ||
            fingerprint(value.apiToken) !== snapshot.fingerprint) throw new RedisStoreError();
        return value.apiToken;
    }

    async function read(id: string): Promise<Snapshot | undefined> {
        const values = await command(['HGETALL', keys.binding(id)]);
        if (!Array.isArray(values) || values.some(value => typeof value !== 'string')) throw new RedisStoreError();
        if (values.length === 0) return undefined;
        const fields = Object.fromEntries(Array.from({ length: values.length / 2 }, (_, index) => [values[index * 2], values[index * 2 + 1]]));
        if (values.length !== 8 || Object.keys(fields).sort().join(',') !== 'active,fingerprint,sealed,version' ||
            !['0', '1'].includes(fields.active) || !/^[1-9][0-9]*$/.test(fields.version) ||
            !versionIsValid(Number(fields.version)) || !FINGERPRINT.test(fields.fingerprint) ||
            typeof fields.sealed !== 'string' || fields.sealed.length > MAX_TOKEN_BYTES * 10) throw new RedisStoreError();
        return fields as unknown as Snapshot;
    }

    async function write(id: string, previous: Snapshot | undefined, next: Snapshot, destinationId = id): Promise<boolean> {
        const reply = await command(['EVAL', CAS, '3', keys.binding(id), keys.fingerprint(next.fingerprint), keys.binding(destinationId),
            id, String(maxTtlSeconds), previous ? 'replace' : 'new',
            previous?.active ?? '', previous?.version ?? '', previous?.sealed ?? '', previous?.fingerprint ?? '',
            next.active, next.version, next.sealed, next.fingerprint, destinationId]);
        if (reply !== 0 && reply !== 1) throw new RedisStoreError();
        return reply === 1;
    }

    return {
        async authorize(apiToken) {
            try {
                if (!tokenIsValid(apiToken)) throw new RedisStoreError();
                const fp = fingerprint(apiToken);
                for (let attempt = 0; attempt < 8; attempt++) {
                    const pointer = await command(['GET', keys.fingerprint(fp)]);
                    if (pointer !== null && (typeof pointer !== 'string' || !ID.test(pointer))) throw new RedisStoreError();
                    const previousId = pointer ?? randomBytes(32).toString('base64url');
                    const previous = pointer === null ? undefined : await read(previousId);
                    if (pointer !== null && (!previous || previous.fingerprint !== fp || open(previous, previousId) !== apiToken)) throw new RedisStoreError();
                    const version = previous ? Number(previous.version) + (previous.active === '0' ? 1 : 0) : 1;
                    if (!versionIsValid(version)) throw new RedisStoreError();
                    const id = previous?.active === '0' ? randomBytes(32).toString('base64url') : previousId;
                    const next = { active: '1', version: String(version), sealed: seal(apiToken, id, version, '1', fp), fingerprint: fp };
                    if (await write(previousId, previous, next, id)) return { id, version };
                }
                throw new RedisStoreError();
            } catch { throw new RedisStoreError(); }
        },
        async resolve(id, version) {
            try {
                if (typeof id !== 'string' || !ID.test(id) || !versionIsValid(version)) throw new RedisStoreError();
                const snapshot = await read(id);
                if (!snapshot || snapshot.active !== '1' || Number(snapshot.version) !== version) return null;
                const apiToken = open(snapshot, id);
                const pointer = await command(['GET', keys.fingerprint(snapshot.fingerprint)]);
                if (pointer !== null && pointer !== id) throw new RedisStoreError();
                return pointer === null ? null : { subject: id, apiToken };
            } catch { throw new RedisStoreError(); }
        },
        async revoke(id, expectedVersion) {
            try {
                if (typeof id !== 'string' || !ID.test(id) || (expectedVersion !== undefined && !versionIsValid(expectedVersion))) throw new RedisStoreError();
                for (let attempt = 0; attempt < 8; attempt++) {
                    const previous = await read(id);
                    if (!previous || previous.active !== '1' || (expectedVersion !== undefined && Number(previous.version) !== expectedVersion)) return false;
                    const apiToken = open(previous, id);
                    const next = { ...previous, active: '0', sealed: seal(apiToken, id, Number(previous.version), '0', previous.fingerprint) };
                    if (await write(id, previous, next)) return true;
                }
                throw new RedisStoreError();
            } catch { throw new RedisStoreError(); }
        },
    };
}
