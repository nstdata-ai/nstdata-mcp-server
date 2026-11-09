import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { remoteCli as cli } from '../helpers.mjs';

const { createRedisAdapterFactory } = await import(new URL('./redis/provider-adapter.js', pathToFileURL(cli)));
const { RedisStoreError, createRedisKeys } = await import(new URL('./redis/shared.js', pathToFileURL(cli)));

// These tests cover validation and the caller-owned client seam. They do not
// emulate Redis or establish Lua atomicity; isolated real-server evidence does.
const configuration = (command, extra = {}) => ({ command, namespace: 'provider_unit', maxTtlSeconds: 3600,
    invalidGrant: () => new Error('fixture-invalid-grant'), ...extra });
const grantPayload = () => ({ accountId: 'binding', clientId: 'client', exp: Math.floor(Date.now() / 1000) + 300 });

test('provider adapter validates required policy before invoking any client', () => {
    let calls = 0;
    const command = async () => { calls++; return null; };
    for (const extra of [{ maxTtlSeconds: 0 }, { maxTtlSeconds: 31_536_001 }, { maxTtlSeconds: Infinity },
        { namespace: 'bad:key' }, { namespace: '' }, { invalidGrant: null }, { command: null }]) {
        assert.throws(() => createRedisAdapterFactory(configuration(command, extra)));
    }
    const Adapter = createRedisAdapterFactory(configuration(command));
    assert.throws(() => new Adapter(''));
    assert.equal(calls, 0);
});

test('payload and TTL validation reject before the client boundary', async () => {
    const commands = [];
    const Adapter = createRedisAdapterFactory(configuration(async args => { commands.push(args); return 1; }));
    const grant = new Adapter('Grant');
    const token = new Adapter('AccessToken');
    const circular = {}; circular.circular = circular;
    for (const payload of [null, [], circular, { ...grantPayload(), exp: NaN },
        { ...grantPayload(), consumed: 0 }, { ...grantPayload(), accountId: '' },
        { ...grantPayload(), data: 'x'.repeat(65_536) }]) {
        await assert.rejects(grant.upsert('id', payload, 300));
    }
    for (const ttl of [0, -1, 1.5, 3601, undefined, Infinity]) await assert.rejects(grant.upsert('id', grantPayload(), ttl));
    await assert.rejects(grant.upsert('', grantPayload(), 300));
    await assert.rejects(grant.upsert('x'.repeat(1025), grantPayload(), 300));
    await assert.rejects(token.upsert('id', grantPayload(), 300));
    assert.equal(commands.length, 0);
});

test('all security models require absolute expiry, including unbound sources', async () => {
    let calls = 0;
    const Adapter = createRedisAdapterFactory(configuration(async () => { calls++; return 1; }));
    for (const model of ['Grant', 'AccessToken', 'AuthorizationCode', 'RefreshToken', 'DeviceCode', 'BackchannelAuthenticationRequest', 'PreAuthorizedCode']) {
        await assert.rejects(new Adapter(model).upsert('id', { accountId: 'binding', clientId: 'client' }, 300), /absolute expiry/);
    }
    assert.equal(calls, 0);
    await new Adapter('DeviceCode').upsert('id', grantPayload(), 300);
    assert.equal(calls, 1);
});

test('each mutation uses one server transaction and caller-supplied InvalidGrant', async () => {
    const commands = [];
    const invalid = new Error('real-provider-error-would-be-supplied-here');
    let result = 1;
    const Adapter = createRedisAdapterFactory(configuration(async args => { commands.push(args); return result; }, { invalidGrant: () => invalid }));
    const grant = new Adapter('Grant');
    const code = new Adapter('AuthorizationCode');
    await grant.upsert('id', grantPayload(), 300);
    await code.upsert('source', { ...grantPayload(), grantId: 'id' }, 300);
    await code.consume('source');
    await code.destroy('source');
    await code.revokeByGrantId('id');
    await grant.destroy('id');
    assert.equal(commands.length, 6);
    assert(commands.every(args => args[0] === 'EVAL'));
    result = 0;
    await assert.rejects(code.consume('source'), error => error === invalid);
    await assert.rejects(grant.upsert('id', grantPayload(), 300), error => error === invalid);
});

test('reads detach JSON snapshots and keep binding metadata outside provider payload', async () => {
    const raw = JSON.stringify({ ...grantPayload(), resources: { resource: 'crawl:use' } });
    const Adapter = createRedisAdapterFactory(configuration(async () => [raw, '17', 'binding', '4']));
    const grant = new Adapter('Grant');
    const first = await grant.find('id');
    first.resources.resource = 'changed';
    const second = await grant.find('id');
    assert.equal(second.resources.resource, 'crawl:use');
    assert.equal(second.consumed, 17);
    assert.equal(second.bindingVersion, undefined);
    assert.deepEqual(await grant.getGrantBinding('id'), { bindingId: 'binding', version: 4 });
});

test('client failure is redacted with no retry, fallback or success after ambiguity', async () => {
    let calls = 0;
    const secret = 'redis://private-user:private-password@private-host/key';
    const Adapter = createRedisAdapterFactory(configuration(async () => { calls++; throw new Error(secret); }));
    const grant = new Adapter('Grant');
    for (const operation of [() => grant.upsert('id', grantPayload(), 300), () => grant.find('id'),
        () => grant.consume('id'), () => grant.destroy('id'), () => grant.findByUid('uid')]) {
        const before = calls;
        await assert.rejects(operation(), error => error instanceof RedisStoreError && error.message === 'Redis storage unavailable' && !JSON.stringify(error).includes('private') && error.cause === undefined);
        assert.equal(calls, before + 1);
    }
});

test('malformed responses and corrupt snapshots fail closed', async () => {
    for (const response of [undefined, true, {}, [], ['null', '', '', ''], ['{}', 'bad', '', ''], ['{}', '', '', '']]) {
        const Adapter = createRedisAdapterFactory(configuration(async () => response));
        const grant = new Adapter('Grant');
        if (Array.isArray(response) && response.length === 4 && response[0] === '{}' && response[1] === '') {
            await assert.rejects(grant.getGrantBinding('id'), RedisStoreError);
        } else await assert.rejects(grant.find('id'), RedisStoreError);
    }
    const Adapter = createRedisAdapterFactory(configuration(async () => null));
    assert.equal(await new Adapter('Grant').find('missing'), undefined);
});

test('secondary lookup validates the record still owns the requested index', async () => {
    const commands = [];
    const Adapter = createRedisAdapterFactory(configuration(async args => {
        commands.push(args);
        return args[0] === 'GET' ? 'session-id' : [JSON.stringify({ uid: 'new-uid' }), '', '', ''];
    }));
    assert.equal(await new Adapter('Session').findByUid('old-uid'), undefined);
    assert.equal(commands[0][1], createRedisKeys('provider_unit').index('Session', 'uid', 'old-uid'));
    assert.equal(commands.length, 2);
});

test('a pending save uses one detached payload snapshot for keys and stored JSON', async () => {
    let release, sent;
    const pending = new Promise(resolve => { release = resolve; });
    const Adapter = createRedisAdapterFactory(configuration(async args => { sent = args; return pending; }));
    const payload = { ...grantPayload(), nested: { value: 'original' } };
    const save = new Adapter('Grant').upsert('id', payload, 300);
    payload.accountId = 'changed'; payload.nested.value = 'changed';
    const raw = JSON.parse(sent[Number(sent[2]) + 4]);
    assert.equal(raw.accountId, 'binding');
    assert.equal(raw.nested.value, 'original');
    assert.equal(sent[4], createRedisKeys('provider_unit').binding('binding'));
    release(1);
    await save;
});
