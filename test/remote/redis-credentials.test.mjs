import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { remoteCli as cli } from '../helpers.mjs';

const { createRedisCredentialStore } = await import(new URL('./redis/credential-store.js', pathToFileURL(cli)));
const { createRedisKeys, RedisStoreError } = await import(new URL('./redis/shared.js', pathToFileURL(cli)));

// Offline crypto/command-contract fixtures. They never execute Lua or prove Redis atomicity.
function configuration(command, overrides = {}) {
    return { command, namespace: 'offline-credentials', maxTtlSeconds: 300,
        encryptionKeys: { initial: randomBytes(32) }, currentKeyId: 'initial', fingerprintKey: randomBytes(32), ...overrides };
}

function redacted(error, secret) {
    assert.ok(error instanceof RedisStoreError);
    assert.equal(error.message, 'Redis storage unavailable');
    assert.equal(Object.hasOwn(error, 'cause'), false);
    assert.equal(`${error.stack} ${JSON.stringify(error)}`.includes(secret), false);
    return true;
}

function written(args) {
    const values = args.slice(3 + Number(args[2]));
    return { id: values[11], fields: { active: values[7], version: values[8], sealed: values[9], fingerprint: values[10] } };
}

async function issueFixture() {
    const calls = [];
    const options = configuration(async args => {
        calls.push(args);
        if (args[0] === 'GET') return null;
        if (args[0] === 'EVAL') return 1;
        throw new Error('Unexpected fixture command');
    });
    const token = `test-only-${randomBytes(32).toString('hex')}`;
    const binding = await createRedisCredentialStore(options).authorize(token);
    const write = calls.find(args => args[0] === 'EVAL');
    const { fields } = written(write);
    const keys = createRedisKeys(options.namespace);
    const read = async args => {
        if (args[0] === 'HGETALL') return args[1] === keys.binding(binding.id) ? Object.entries(fields).flat() : [];
        if (args[0] === 'GET') return args[1] === keys.fingerprint(fields.fingerprint) ? binding.id : null;
        throw new Error('Unexpected fixture command');
    };
    return { options, token, binding, fields, calls, keys, read };
}

test('credential configuration rejects invalid crypto options eagerly and without input details', () => {
    let calls = 0;
    const options = configuration(async () => { calls++; return null; });
    const invalid = [
        { encryptionKeys: {} }, { currentKeyId: 'missing' }, { currentKeyId: 'bad key' },
        { encryptionKeys: { initial: randomBytes(31) } }, { encryptionKeys: { initial: 'private-test-key' } },
        { fingerprintKey: randomBytes(31) }, { fingerprintKey: options.encryptionKeys.initial },
        { namespace: 'invalid:namespace' }, { maxTtlSeconds: 0 }, { maxTtlSeconds: Infinity }, { command: undefined },
    ];
    for (const override of invalid) {
        assert.throws(() => createRedisCredentialStore({ ...options, ...override }), error => {
            assert.equal(error.message, 'Invalid Redis credential configuration');
            assert.equal(Object.hasOwn(error, 'cause'), false);
            return true;
        });
    }
    assert.equal(calls, 0);
});

test('authorize emits only encrypted credential data and a keyed fingerprint', async () => {
    const { calls, token, fields, binding } = await issueFixture();
    assert.equal(JSON.stringify(calls).includes(token), false);
    assert.match(binding.id, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(binding.version, 1);
    assert.equal(fields.active, '1');
    assert.match(fields.fingerprint, /^[a-f0-9]{64}$/);
    const envelope = JSON.parse(fields.sealed);
    assert.equal(envelope.v, 1);
    assert.equal(envelope.keyId, 'initial');
    assert.equal(Buffer.from(envelope.iv, 'base64url').length, 12);
    assert.equal(Buffer.from(envelope.tag, 'base64url').length, 16);
});

test('resolve decrypts only the active exact generation and its matching fingerprint index', async () => {
    const f = await issueFixture();
    const store = createRedisCredentialStore({ ...f.options, command: f.read });
    assert.deepEqual(await store.resolve(f.binding.id, f.binding.version), { subject: f.binding.id, apiToken: f.token });
    assert.equal(await store.resolve(f.binding.id, f.binding.version + 1), null);
    assert.equal(await store.resolve(randomBytes(32).toString('base64url'), 1), null);
    assert.equal(await createRedisCredentialStore({ ...f.options, command: async args => args[0] === 'GET' ? null : f.read(args) })
        .resolve(f.binding.id, 1), null);
});

test('key rotation retains decryption and reauthorization seals with the current key', async () => {
    const f = await issueFixture();
    const encryptionKeys = { ...f.options.encryptionKeys, rotated: randomBytes(32) };
    let rewritten;
    const rotated = createRedisCredentialStore({ ...f.options, encryptionKeys, currentKeyId: 'rotated', command: async args => {
        if (args[0] === 'EVAL') { rewritten = args; return 1; }
        return f.read(args);
    } });
    assert.equal((await rotated.resolve(f.binding.id, 1)).apiToken, f.token);
    assert.deepEqual(await rotated.authorize(f.token), f.binding);
    assert.equal(JSON.parse(written(rewritten).fields.sealed).keyId, 'rotated');
    const missing = createRedisCredentialStore({ ...f.options, encryptionKeys: { rotated: encryptionKeys.rotated }, currentKeyId: 'rotated', command: f.read });
    await assert.rejects(missing.resolve(f.binding.id, 1), error => redacted(error, f.token));
});

test('creation snapshots caller key bytes, keyring and options', async () => {
    const f = await issueFixture();
    const mutable = { ...f.options, encryptionKeys: { initial: Buffer.from(f.options.encryptionKeys.initial) },
        fingerprintKey: Buffer.from(f.options.fingerprintKey), command: f.read };
    const store = createRedisCredentialStore(mutable);
    mutable.encryptionKeys.initial.fill(0);
    mutable.fingerprintKey.fill(0);
    mutable.encryptionKeys = {};
    mutable.currentKeyId = 'missing';
    mutable.namespace = 'other';
    mutable.command = async () => { throw new Error(f.token); };
    assert.equal((await store.resolve(f.binding.id, 1)).apiToken, f.token);
});

test('ciphertext, binding ID, version, namespace and fingerprint tampering fail closed', async () => {
    for (const field of ['ciphertext', 'tag', 'iv', 'keyId', 'version', 'fingerprint']) {
        const f = await issueFixture();
        if (field === 'version') f.fields.version = '2';
        else if (field === 'fingerprint') f.fields.fingerprint = '0'.repeat(64);
        else {
            const envelope = JSON.parse(f.fields.sealed);
            envelope[field] = field === 'keyId' ? 'unknown' : `${envelope[field][0] === 'A' ? 'B' : 'A'}${envelope[field].slice(1)}`;
            f.fields.sealed = JSON.stringify(envelope);
        }
        const store = createRedisCredentialStore({ ...f.options, command: f.read });
        await assert.rejects(store.resolve(f.binding.id, Number(f.fields.version)), error => redacted(error, f.token));
    }
    for (const target of ['id', 'namespace']) {
        const f = await issueFixture();
        const wrongId = target === 'id' ? randomBytes(32).toString('base64url') : f.binding.id;
        const store = createRedisCredentialStore({ ...f.options, namespace: target === 'namespace' ? 'other' : f.options.namespace,
            command: async args => args[0] === 'HGETALL' ? Object.entries(f.fields).flat() : wrongId });
        await assert.rejects(store.resolve(wrongId, 1), error => redacted(error, f.token));
    }
});

test('revocation preserves the inactive ID and explicit reauthorization mints a new binding', async () => {
    const f = await issueFixture();
    const writes = [];
    const hashes = new Map([[f.keys.binding(f.binding.id), f.fields]]);
    let pointer = f.binding.id;
    const command = async args => {
        if (args[0] === 'HGETALL') return Object.entries(hashes.get(args[1]) ?? {}).flat();
        if (args[0] === 'GET') return pointer;
        assert.equal(args[0], 'EVAL');
        writes.push(args);
        assert.equal(args[2], '3');
        const next = written(args);
        hashes.set(args[5], next.fields);
        pointer = next.id;
        return 1;
    };
    const store = createRedisCredentialStore({ ...f.options, command });
    assert.equal(await store.revoke(f.binding.id, 2), false);
    assert.equal(await store.revoke(f.binding.id, 1), true);
    assert.equal(await store.resolve(f.binding.id, 1), null);
    assert.equal(await store.revoke(f.binding.id, 1), false);
    const renewed = await store.authorize(f.token);
    assert.notEqual(renewed.id, f.binding.id);
    assert.equal(renewed.version, 2);
    assert.equal(hashes.get(f.keys.binding(f.binding.id)).active, '0');
    assert.equal(writes[1][3], f.keys.binding(f.binding.id));
    assert.equal(writes[1][5], f.keys.binding(renewed.id));
    assert.equal(await store.resolve(f.binding.id, 1), null);
    assert.equal(await store.resolve(f.binding.id, 2), null);
    assert.equal((await store.resolve(renewed.id, 2)).apiToken, f.token);
    assert.equal(written(writes[0]).fields.sealed.includes(f.token), false);
    hashes.get(f.keys.binding(renewed.id)).active = '0';
    await assert.rejects(store.authorize(f.token), error => redacted(error, f.token));
});

test('only definite CAS conflicts are retried with a finite bound', async () => {
    const token = `test-only-${randomBytes(32).toString('hex')}`;
    let writes = 0;
    const store = createRedisCredentialStore(configuration(async args => {
        if (args[0] === 'GET') return null;
        writes++;
        return 0;
    }));
    await assert.rejects(store.authorize(token), error => redacted(error, token));
    assert.equal(writes, 8);
    for (const phase of ['GET', 'EVAL']) {
        let failed = 0;
        const unavailable = createRedisCredentialStore(configuration(async args => {
            if (args[0] === phase) { failed++; throw new Error(token, { cause: token }); }
            return null;
        }));
        await assert.rejects(unavailable.authorize(token), error => redacted(error, token));
        assert.equal(failed, 1);
    }
});

test('malformed stored hashes and invalid credentials fail with redacted errors', async () => {
    const f = await issueFixture();
    const malformed = [undefined, {}, ['active'], ['active', '1'], [...Object.entries(f.fields).flat(), 'extra', f.token]];
    for (const value of malformed) {
        const store = createRedisCredentialStore({ ...f.options, command: async () => value });
        await assert.rejects(store.resolve(f.binding.id, 1), error => redacted(error, f.token));
    }
    const store = createRedisCredentialStore(f.options);
    for (const token of ['', '  ', undefined, 42, 'x'.repeat(16_385), '\ud800', '\udfff']) {
        await assert.rejects(store.authorize(token), error => redacted(error, f.token));
    }
});
