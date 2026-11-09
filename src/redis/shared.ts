/** A connected Redis client's command method. Disable queued or automatic command replay. */
export type RedisCommand = (args: string[]) => Promise<unknown>;

export interface StoreOptions {
    command: RedisCommand;
    namespace: string;
    /** Maximum lifetime of any stored authorization object, in seconds. */
    maxTtlSeconds: number;
}

export class RedisStoreError extends Error {
    constructor() {
        super('Redis storage unavailable');
        this.name = 'RedisStoreError';
    }
}

/** Bound commands before the client queue; rejected work is never dispatched or replayed. */
export function limitRedisCommands(command: RedisCommand): RedisCommand {
    let active = 0;
    return async args => {
        if (active >= 64) throw new RedisStoreError();
        active++;
        try { return await command(args); }
        finally { active--; }
    };
}

function segment(value: string): string {
    if (typeof value !== 'string' || !value.length || Buffer.byteLength(value, 'utf8') > 1024) {
        throw new Error('Invalid Redis storage identifier');
    }
    const bytes = Buffer.from(value, 'utf8');
    if (bytes.toString('utf8') !== value) throw new Error('Invalid Redis storage identifier');
    return bytes.toString('base64url');
}

export function createRedisKeys(namespace: string) {
    if (typeof namespace !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(namespace)) {
        throw new Error('Invalid Redis storage namespace');
    }
    const prefix = `nstdata:mcp:{${namespace}}:`;
    return Object.freeze({
        prefix,
        record: (model: string, id: string) => `${prefix}record:${segment(model)}:${segment(id)}`,
        binding: (id: string) => `${prefix}binding:${segment(id)}`,
        fingerprint: (fingerprint: string) => `${prefix}fingerprint:${segment(fingerprint)}`,
        revoked: (grantId: string) => `${prefix}revoked:${segment(grantId)}`,
        index: (model: string, field: string, value: string) => `${prefix}index:${segment(model)}:${segment(field)}:${segment(value)}`,
    });
}

export function validateStoreOptions(options: StoreOptions): void {
    if (!options || typeof options.command !== 'function' || !Number.isSafeInteger(options.maxTtlSeconds) ||
        options.maxTtlSeconds < 1 || options.maxTtlSeconds > 31_536_000) {
        throw new Error('Invalid Redis storage configuration');
    }
    createRedisKeys(options.namespace);
}
