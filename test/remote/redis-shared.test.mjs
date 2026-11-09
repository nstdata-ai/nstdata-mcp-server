import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { remoteCli as cli } from '../helpers.mjs';

const { createRedisKeys, validateStoreOptions, RedisStoreError } =
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
