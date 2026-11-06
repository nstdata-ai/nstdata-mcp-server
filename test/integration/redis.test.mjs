import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { cli } from '../helpers.mjs';
import { isolatedRedis } from './redis-fixture.mjs';

const { createRedisAdapterFactory } = await import(new URL('./redis/provider-adapter.js', pathToFileURL(cli)));
const { createRedisCredentialStore } = await import(new URL('./redis/credential-store.js', pathToFileURL(cli)));
const { createRedisKeys, RedisStoreError } = await import(new URL('./redis/shared.js', pathToFileURL(cli)));
// Only the error-factory seam is synthetic; every storage operation executes real Redis Lua.
class InvalidGrant extends Error {}

test('isolated real Redis preserves credential and provider authorization invariants', { timeout: 30_000 }, async t => {
    const { command, command2 } = await isolatedRedis(t);
    const namespace = `integration_${randomBytes(8).toString('hex')}`, keys = createRedisKeys(namespace);
    const policy = { namespace, maxTtlSeconds: 30 };
    const Adapter = createRedisAdapterFactory({ ...policy, command, invalidGrant: () => new InvalidGrant() });
    const Adapter2 = createRedisAdapterFactory({ ...policy, command: command2, invalidGrant: () => new InvalidGrant() });
    const grant = new Adapter('Grant'), access = new Adapter('AccessToken');
    const encryptionKeys = { first: randomBytes(32), second: randomBytes(32) }, fingerprintKey = randomBytes(32);
    const credentials = extra => createRedisCredentialStore({ ...policy, command, encryptionKeys, fingerprintKey, currentKeyId: 'first', ...extra });
    const store = credentials();
    const binding = await store.authorize('synthetic-upstream-A');
    const now = async () => Number((await command(['TIME']))[0]);
    const payload = async (id, seconds = 20) => ({ accountId: binding.id, clientId: 'fixture-client', exp: await now() + seconds, ...(id ? { grantId: id } : {}) });

    await t.test('credentials encrypt, rotate keys and reject authenticated-data tampering', async () => {
        assert.deepEqual(await store.authorize('synthetic-upstream-A'), binding);
        assert.equal((await store.resolve(binding.id, binding.version)).apiToken, 'synthetic-upstream-A');
        assert.equal(await store.resolve(binding.id, binding.version + 1), null);
        const sealedBefore = await command(['HGET', keys.binding(binding.id), 'sealed']);
        assert(!sealedBefore.includes('synthetic-upstream-A'));
        const rotated = credentials({ currentKeyId: 'second' });
        assert.deepEqual(await rotated.authorize('synthetic-upstream-A'), binding);
        const sealed = await command(['HGET', keys.binding(binding.id), 'sealed']);
        assert.equal(JSON.parse(sealed).keyId, 'second');
        assert.equal((await credentials({ encryptionKeys: { second: encryptionKeys.second }, currentKeyId: 'second' }).resolve(binding.id, binding.version)).apiToken, 'synthetic-upstream-A');
        await assert.rejects(credentials({ encryptionKeys: { first: encryptionKeys.first } }).resolve(binding.id, binding.version), RedisStoreError);
        const tampered = JSON.parse(sealed); tampered.tag = Buffer.alloc(16).toString('base64url');
        await command(['HSET', keys.binding(binding.id), 'sealed', JSON.stringify(tampered)]);
        await assert.rejects(rotated.resolve(binding.id, binding.version), RedisStoreError);
        await command(['HSET', keys.binding(binding.id), 'sealed', sealed]);
        await command(['HSET', keys.binding(binding.id), 'version', String(binding.version + 1)]);
        await assert.rejects(rotated.resolve(binding.id, binding.version + 1), RedisStoreError);
        await command(['HSET', keys.binding(binding.id), 'version', String(binding.version)]);
        assert.equal((await rotated.resolve(binding.id, binding.version)).subject, binding.id);
    });

    for (const model of ['AuthorizationCode', 'RefreshToken']) {
        await t.test(`${model} consumes once across independent clients and revokes its family`, async () => {
            const id = `race-${model}`, source = new Adapter(model), other = new Adapter2(model), p = await payload();
            await grant.upsert(id, p, 20);
            await source.upsert(id, { ...p, grantId: id, nested: { value: 'original' } }, 20);
            const snapshots = await Promise.all([source.find(id), other.find(id)]);
            assert(snapshots.every(value => value && !value.consumed));
            snapshots[0].nested.value = 'changed';
            assert.equal((await source.find(id)).nested.value, 'original');
            const outcomes = await Promise.allSettled([source.consume(id), other.consume(id)]);
            assert.equal(outcomes.filter(value => value.status === 'fulfilled').length, 1);
            assert(outcomes.some(value => value.status === 'rejected' && value.reason instanceof InvalidGrant));
            assert.equal(await grant.find(id), undefined);
            assert.equal(await source.find(id), undefined);
            await assert.rejects(grant.upsert(id, p, 20), InvalidGrant);
            await assert.rejects(access.upsert(`late-${id}`, { ...p, grantId: id }, 20), InvalidGrant);
            const ttl = await command(['TTL', keys.revoked(id)]); assert(ttl > 0 && ttl <= policy.maxTtlSeconds);
        });
        await t.test(`${model} retains consumed state through a shorter logical TTL`, async () => {
            const id = `short-${model}`, source = new Adapter(model), p = await payload();
            await grant.upsert(id, p, 20);
            const stale = { ...p, grantId: id };
            await source.upsert(id, stale, 3);
            await source.consume(id);
            await source.upsert(id, stale, 3);
            assert((await source.find(id)).consumed > 0);
            await delay(3100);
            assert.equal(await source.find(id), undefined);
            assert.equal(await command(['EXISTS', keys.record(model, id)]), 1);
            await assert.rejects(source.upsert(id, stale, 10), InvalidGrant);
            await assert.rejects(source.consume(id), InvalidGrant);
        });
    }

    await t.test('shrinking Grant expiry retains its version snapshot and denies stale revival', async () => {
        const p = { ...await payload(), accountId: 'shrinking-binding' };
        await command(['HSET', keys.binding(p.accountId), 'active', '1', 'version', '1']);
        await grant.upsert('shrinking', p, 20);
        await grant.upsert('shrinking', { ...p, exp: await now() + 3 }, 3);
        assert.equal(Number(await command(['HGET', keys.record('Grant', 'shrinking'), 'keepUntil'])), p.exp);
        await delay(3100);
        assert.equal(await grant.find('shrinking'), undefined);
        assert.equal(await command(['EXISTS', keys.record('Grant', 'shrinking')]), 1);
        await command(['HSET', keys.binding(p.accountId), 'version', '2']);
        await assert.rejects(grant.upsert('shrinking', p, 10), InvalidGrant);
        assert.equal(await command(['HGET', keys.record('Grant', 'shrinking'), 'bindingVersion']), '1');
    });

    for (const model of ['AccessToken', 'AuthorizationCode', 'RefreshToken']) {
        await t.test(`${model} destroy fences stale writes and a delayed first save`, async () => {
            const id = `destroy-${model}`, source = new Adapter(model), p = await payload();
            await grant.upsert(id, p, 20);
            const stale = { ...p, grantId: id };
            await source.upsert(id, stale, 20);
            await source.destroy(id);
            assert.equal(await source.find(id), undefined);
            await assert.rejects(source.upsert(id, stale, 10), InvalidGrant);
            await source.destroy(`missing-${id}`);
            await assert.rejects(source.upsert(`missing-${id}`, stale, 10), InvalidGrant);
        });
    }

    await t.test('Session destruction fences detached stale saves while new IDs and rolling updates work', async () => {
        const session = new Adapter('Session'), detached = new Adapter2('Session');
        const p = { uid: 'session-uid', accountId: 'original-account', exp: await now() + 20 };
        await session.upsert('session-old-id', p, 20);
        const stale = await detached.find('session-old-id');
        await session.destroy('session-old-id');
        assert.equal(await session.find('session-old-id'), undefined);
        assert.equal(await session.findByUid(p.uid), undefined);
        await assert.rejects(detached.upsert('session-old-id', stale, 20), InvalidGrant);
        await session.destroy('session-delayed-first-save');
        await assert.rejects(detached.upsert('session-delayed-first-save', p, 20), InvalidGrant);
        await session.upsert('session-new-id', p, 20);
        assert.equal((await session.findByUid(p.uid)).accountId, 'original-account');
        const updated = { ...p, uid: 'updated-session-uid', accountId: 'updated-account', exp: await now() + 25 };
        await session.upsert('session-new-id', updated, 25);
        assert.equal(await session.findByUid(p.uid), undefined);
        assert.equal((await session.findByUid(updated.uid)).accountId, 'updated-account');
    });

    await t.test('reauthorization changes binding ID and fences old Grants including their first save', async () => {
        const old = await store.authorize('synthetic-reauthorize');
        const p = { exp: await now() + 20, accountId: old.id, clientId: 'fixture-client' };
        await grant.upsert('old-binding', p, 20);
        await access.upsert('old-access', { ...p, grantId: 'old-binding' }, 20);
        assert.equal(await store.revoke(old.id, old.version), true);
        assert.equal(await grant.find('old-binding'), undefined);
        const fresh = await store.authorize('synthetic-reauthorize');
        assert.notEqual(fresh.id, old.id); assert.equal(fresh.version, old.version + 1);
        assert.equal(await store.resolve(old.id, old.version), null);
        await assert.rejects(grant.upsert('old-binding', p, 20), InvalidGrant);
        await assert.rejects(grant.upsert('delayed-first-save', p, 20), InvalidGrant);
        assert.equal(await access.find('old-access'), undefined);
        await grant.upsert('fresh-binding', { ...p, accountId: fresh.id }, 20);
        assert.deepEqual(await grant.getGrantBinding('fresh-binding'), { bindingId: fresh.id, version: fresh.version });
        assert.equal((await store.resolve(fresh.id, fresh.version)).apiToken, 'synthetic-reauthorize');
    });

    await t.test('expired or missing Grants deny tokens and indexes expire without touching other namespaces', async () => {
        const otherNamespace = createRedisKeys(`${namespace}_other`), sentinel = otherNamespace.record('Session', 'sentinel');
        await command(['SET', sentinel, 'preserved']);
        const p = await payload(undefined, 3);
        await grant.upsert('expiring', p, 3);
        await access.upsert('orphan-after-expiry', { ...p, exp: await now() + 20, grantId: 'expiring' }, 20);
        await assert.rejects(access.upsert('orphan', await payload('absent'), 20), InvalidGrant);
        const session = new Adapter('Session'), device = new Adapter('DeviceCode');
        await session.upsert('session', { uid: 'old' }, 20);
        await session.upsert('session', { uid: 'new' }, 20);
        assert.equal(await session.findByUid('old'), undefined);
        assert.equal((await session.findByUid('new')).uid, 'new');
        const exp = await now() + 20;
        await device.upsert('first', { userCode: 'shared', exp }, 20);
        await device.upsert('second', { userCode: 'shared', exp }, 20);
        await device.destroy('first');
        assert.equal((await device.findByUserCode('shared')).userCode, 'shared');
        await device.upsert('second', { userCode: 'replacement', exp }, 1);
        assert.equal(await device.findByUserCode('shared'), undefined);
        await delay(3100);
        assert.equal(await access.find('orphan-after-expiry'), undefined);
        await assert.rejects(grant.upsert('expiring', p, 1), InvalidGrant);
        assert.equal(await device.findByUserCode('replacement'), undefined);
        assert.equal(await command(['EXISTS', keys.index('DeviceCode', 'userCode', 'replacement')]), 0);
        await session.destroy('session');
        assert.equal(await session.findByUid('new'), undefined);
        assert.equal(await command(['GET', sentinel]), 'preserved');
    });
});
