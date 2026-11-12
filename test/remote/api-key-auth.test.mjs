import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { remoteCli } from '../helpers.mjs';

const { createApiKeyAuthenticator } = await import(new URL('./api-key-auth.js', pathToFileURL(remoteCli)));

test('direct keys have stable opaque, domain-separated identities without persistent authorization', async () => {
    const identityKey = new Uint8Array(32).fill(7);
    const expectedKey = Buffer.from(identityKey);
    let calls = 0;
    const authenticate = createApiKeyAuthenticator(async (key, signal) => {
        assert(signal instanceof AbortSignal);
        calls++;
        return key.startsWith('fixture-');
    }, identityKey);
    identityKey.fill(0);
    const signal = AbortSignal.timeout(5000);
    const a = await authenticate('fixture-A', signal);
    const again = await authenticate('fixture-A', signal);
    const b = await authenticate('fixture-B', signal);
    assert.deepEqual(a, again);
    assert.notEqual(a.subject, b.subject);
    assert.equal(a.subject, 'api-key:' + createHmac('sha256', expectedKey).update('nstdata-mcp-api-key\0fixture-A').digest('base64url'));
    assert.match(a.subject, /^api-key:[A-Za-z0-9_-]{43}$/);
    assert.doesNotMatch(a.subject, /fixture/);
    assert.equal(a.apiToken, 'fixture-A');
    assert.equal(calls, 3, 'each request must validate; no positive authentication cache');
    assert.equal(await authenticate('revoked-fixture', signal), null);
});

test('malformed keys and invalid construction cannot reach the upstream verifier', async () => {
    let calls = 0;
    const verify = async () => { calls++; return true; };
    const authenticate = createApiKeyAuthenticator(verify, new Uint8Array(32).fill(5));
    for (const key of ['', 'has space', 'has\nnewline', 'a,b', 'a'.repeat(16385), '\ud800', null]) {
        assert.equal(await authenticate(key, AbortSignal.timeout(5000)), null);
    }
    assert.equal(calls, 0);
    for (const key of [undefined, new Uint8Array(31), new Uint8Array(33), 'private']) {
        assert.throws(() => createApiKeyAuthenticator(verify, key), /Invalid API key authentication configuration/);
    }
    assert.throws(() => createApiKeyAuthenticator(undefined, new Uint8Array(32)), /Invalid/);
});

test('cancellation and verification failures cannot create a late authenticated identity or disclose a key', async () => {
    const controller = new AbortController();
    const authenticate = createApiKeyAuthenticator(async () => {
        controller.abort();
        return true;
    }, new Uint8Array(32).fill(9));
    await assert.rejects(authenticate('fixture-private', controller.signal), /^Error: API key authentication unavailable$/);
    const failed = createApiKeyAuthenticator(async () => { throw new Error('fixture-private upstream response'); }, new Uint8Array(32));
    await assert.rejects(failed('fixture-private', AbortSignal.timeout(5000)), error =>
        error.message === 'API key authentication unavailable' && !error.cause);
    const stopped = new AbortController(); stopped.abort();
    const never = createApiKeyAuthenticator(async () => assert.fail('cancelled verifier reached'), new Uint8Array(32));
    await assert.rejects(never('fixture-private', stopped.signal), /unavailable/);
});
