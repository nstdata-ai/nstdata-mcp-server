import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { remoteCli as cli } from '../helpers.mjs';

const { createRedisKeys, validateStoreOptions, RedisStoreError, limitRedisCommands } =
    await import(new URL('./redis/shared.js', pathToFileURL(cli)));

test('Redis namespace and identifiers cannot escape or alias their key space', () => {
    const keys = createRedisKeys('deployment_A-1');
    assert.equal(keys.prefix, 'nstdata:mcp:{deployment_A-1}:');
    assert.notEqual(keys.record('A:B', 'C'), keys.record('A', 'B:C'));
    assert.notEqual(keys.binding('same'), keys.record('Grant', 'same'));
    assert.notEqual(keys.binding('same'), createRedisKeys('other').binding('same'));
    assert.notEqual(keys.index('Session', 'uid', 'same'), keys.index('Session', 'userCode', 'same'));
    for (const namespace of ['', '{other}', 'a:b', 'a b', 'a'.repeat(65), null]) {
        assert.throws(() => createRedisKeys(namespace), /Invalid Redis storage namespace/);
    }
    for (const identifier of ['', '\ud800', '\ud801', 'x'.repeat(1025), null]) {
        assert.throws(() => keys.binding(identifier), /Invalid Redis storage identifier/);
    }
});

test('Redis policy is finite and unavailable errors retain no client cause', () => {
    validateStoreOptions({ command: async () => null, namespace: 'test', maxTtlSeconds: 1 });
    for (const maxTtlSeconds of [0, -1, 1.5, NaN, Infinity, 31_536_001]) {
        assert.throws(() => validateStoreOptions({ command: async () => null, namespace: 'test', maxTtlSeconds }));
    }
    const error = new RedisStoreError();
    assert.equal(error.message, 'Redis storage unavailable');
    assert.equal(error.cause, undefined);
});

test('Redis command admission rejects excess work without queuing and retains unsettled slots', async t => {
    const pending = [];
    const command = limitRedisCommands(args => new Promise(resolve => pending.push({ args, resolve })));
    const active = Array.from({ length: 64 }, (_, index) => command([String(index)]));
    t.after(() => { for (const entry of pending) entry.resolve('cleanup'); });
    assert.equal(pending.length, 64);
    const independent = limitRedisCommands(async () => 'independent');
    assert.equal(await independent([]), 'independent', 'separate Redis clients do not share capacity');
    await assert.rejects(command(['excess']), RedisStoreError);
    assert.equal(pending.length, 64, 'rejected work never reaches the connected client');

    assert.equal(await Promise.race([active[0], Promise.resolve('caller stopped waiting')]), 'caller stopped waiting');
    await assert.rejects(command(['still full']), RedisStoreError);
    pending[0].resolve('first');
    assert.equal(await active[0], 'first');
    const replacement = command(['replacement']);
    assert.equal(pending.length, 65);
    assert.deepEqual(pending.at(-1).args, ['replacement']);
    await assert.rejects(command(['full again']), RedisStoreError);

    for (const entry of pending.slice(1)) entry.resolve('done');
    assert.deepEqual(await Promise.all(active), ['first', ...Array(63).fill('done')]);
    assert.equal(await replacement, 'done');
    await Promise.resolve();
    assert.equal(pending.length, 65, 'rejected commands are not replayed when capacity returns');
});

test('Redis command admission releases rejected work and preserves delegated failures', async t => {
    const failure = new RedisStoreError();
    const pending = [];
    let outcome = 'throw';
    const command = limitRedisCommands(() => {
        if (outcome === 'throw') throw failure;
        if (outcome === 'reject') return Promise.reject(failure);
        return new Promise(resolve => pending.push(resolve));
    });
    await assert.rejects(command([]), error => error === failure);
    outcome = 'reject';
    await assert.rejects(command([]), error => error === failure);
    outcome = 'pending';
    const active = Array.from({ length: 64 }, () => command([]));
    t.after(() => { for (const resolve of pending) resolve(); });
    assert.equal(pending.length, 64, 'both failure paths release their slots');
    await assert.rejects(command([]), RedisStoreError);
    for (const resolve of pending) resolve();
    await Promise.all(active);
});
