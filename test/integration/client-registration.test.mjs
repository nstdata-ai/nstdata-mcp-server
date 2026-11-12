import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { remoteCli } from '../helpers.mjs';
import { isolatedRedis } from './redis-fixture.mjs';

const { createRedisAdapterFactory } = await import(new URL('./redis/provider-adapter.js', pathToFileURL(remoteCli)));
const { createRedisKeys, RedisStoreError } = await import(new URL('./redis/shared.js', pathToFileURL(remoteCli)));

test('real Redis bounds inactive Client lifetime and atomically recovers registration capacity', { timeout: 10000 }, async t => {
    const { command, command2 } = await isolatedRedis(t);
    const namespace = `client_${randomBytes(8).toString('hex')}`;
    const keys = createRedisKeys(namespace), index = `${keys.prefix}clients`;
    const options = { namespace, maxTtlSeconds: 60, invalidGrant: () => new Error('fixture-invalid-grant') };
    const Client = createRedisAdapterFactory({ ...options, command });
    const Client2 = createRedisAdapterFactory({ ...options, command: command2 });
    const first = new Client('Client'), second = new Client2('Client');
    const payload = id => ({ client_id: id, token_endpoint_auth_method: 'none', redirect_uris: ['http://127.0.0.1/callback'] });

    await t.test('registrations persist across adapter instances and outlive maximum grants', async () => {
        await first.upsert('active', payload('active'));
        assert.deepEqual(await second.find('active'), payload('active'));
        assert(await command(['TTL', keys.record('Client', 'active')]) >= 359);
        await command(['EXPIRE', keys.record('Client', 'active'), '1']);
        await second.find('active');
        assert(await command(['TTL', keys.record('Client', 'active')]) >= 359, 'active lookup renews the inactivity window');
        assert.equal(await command(['ZCARD', index]), 1);
    });

    await t.test('simultaneous registration cannot exceed the shared capacity', async () => {
        // Seed only the admission index to reach the exact boundary without 9998 network round-trips.
        await command(['EVAL', `local now=tonumber(redis.call('TIME')[1]); for i=1,9998 do redis.call('ZADD',KEYS[1],now+600,'fixture-'..i) end; return 1`, '1', index]);
        const attempts = await Promise.allSettled([first.upsert('race-a', payload('race-a')), second.upsert('race-b', payload('race-b'))]);
        assert.equal(attempts.filter(value => value.status === 'fulfilled').length, 1);
        const rejected = attempts.find(value => value.status === 'rejected');
        assert(rejected.reason instanceof RedisStoreError);
        assert.equal(await command(['ZCARD', index]), 10000);
    });

    await t.test('expired inactive entries release slots and explicit deletion removes its index', async () => {
        await command(['EVAL', `local now=tonumber(redis.call('TIME')[1]); for i=1,9998 do redis.call('ZADD',KEYS[1],now-1,'fixture-'..i) end; return 1`, '1', index]);
        await first.upsert('after-expiry', payload('after-expiry'));
        assert.equal(await command(['ZCARD', index]), 3);
        assert.deepEqual(await second.find('active'), payload('active'));
        await second.destroy('after-expiry');
        assert.equal(await first.find('after-expiry'), undefined);
        assert.equal(await command(['ZCARD', index]), 2);
        const staleKey = keys.record('Client', 'stale');
        await command(['SET', staleKey, JSON.stringify(payload('stale')), 'PX', '1']);
        await command(['ZADD', index, '1', staleKey]);
        await command(['DEL', staleKey]);
        assert.equal(await second.find('stale'), undefined);
        assert.equal(await command(['ZSCORE', index, staleKey]), null);
    });
});
