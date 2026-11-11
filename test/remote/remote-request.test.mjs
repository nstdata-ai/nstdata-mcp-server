import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { remoteCli } from '../helpers.mjs';
const { createRemoteRequestPolicy } = await import(new URL('./remote-request.js', pathToFileURL(remoteCli)));
const issuer = 'https://mcp.example.test';
function request({ host = 'mcp.example.test', peer = '127.0.0.1', encrypted = false, headers = [], raw = [] } = {}) {
    const pairs = [['Host', host], ...headers];
    return { headers: Object.fromEntries(pairs.map(([name, value]) => [name.toLowerCase(), value])),
        rawHeaders: [...pairs.flat(), ...raw], socket: { remoteAddress: peer, encrypted } };
}
test('trusted proxy uses the direct peer and a single exact HTTPS protocol header', () => {
    const allowed = createRemoteRequestPolicy(issuer, ['127.0.0.1/32', '2001:db8::/64']);
    for (const peer of ['127.0.0.1', '::ffff:127.0.0.1', '::ffff:7f00:1', '2001:db8::19']) {
        assert(allowed(request({ peer, headers: [['X-Forwarded-Proto', 'https']] })));
    }
    for (const peer of ['127.0.0.2', '198.51.100.1', '::1', undefined]) {
        const value = request({ headers: [['X-Forwarded-Proto', 'https'], ['X-Forwarded-For', '127.0.0.1']] });
        value.socket.remoteAddress = peer; assert.equal(allowed(value), false);
    }
    for (const headers of [[], [['X-Forwarded-Proto', 'http']], [['X-Forwarded-Proto', 'HTTPS']], [['X-Forwarded-Proto', 'https,http']],
        [['X-Forwarded-Proto', 'https, https']], [['X-Forwarded-Proto', ' https']],
        ...['Forwarded', 'X-Forwarded-Host', 'X-Forwarded-Port'].map(name => [['X-Forwarded-Proto', 'https'], [name, '']])]) {
        assert.equal(allowed(request({ headers })), false);
    }
    assert.equal(allowed(request({ headers: [['X-Forwarded-Proto', 'https']], raw: ['x-forwarded-proto', 'https'] })), false);
    assert.equal(allowed(request({ headers: [['X-Forwarded-Proto', 'https']], raw: ['host', 'mcp.example.test'] })), false);
    assert.equal(allowed(request({ host: 'attacker.invalid', headers: [['X-Forwarded-Proto', 'https']] })), false);
    for (const cidr of ['::/1', '::/80', '::fffe:0:0/95', '::ffff:0:0/96']) {
        assert.throws(() => createRemoteRequestPolicy(issuer, [cidr]), 'mapped IPv4 peers must not bypass the IPv4 allowlist');
    }
});
test('health-only authority exceptions never authorize business requests', () => {
    const allowed = createRemoteRequestPolicy(issuer, ['127.0.0.1']);
    for (const host of ['mcp.example.test', '10.2.3.4', '10.2.3.4:8080', '[2001:db8::1]:8080']) {
        const probe = request({ host, peer: '192.0.2.1' });
        assert(allowed(probe, true)); assert.equal(allowed(probe), false);
    }
    for (const host of ['attacker.invalid', '10.2.3.4:0', '10.2.3.4:65536', 'user@10.2.3.4', '10.2.3.4/path']) {
        assert.equal(allowed(request({ host }), true), false);
    }
    assert.equal(allowed(request({ raw: ['Host', '10.2.3.4'] }), true), false);
    assert.equal(allowed(request({ headers: [['X-Forwarded-Proto', 'https']], peer: '192.0.2.1' }), true), false);
    assert(allowed(request({ headers: [['X-Forwarded-Proto', 'https']] }), true));
});
test('direct TLS and loopback retain their original no-forwarded-header boundary', () => {
    const direct = createRemoteRequestPolicy(issuer);
    assert(direct(request({ encrypted: true })));
    assert.equal(direct(request()), false);
    assert.equal(direct(request({ encrypted: true, headers: [['X-Forwarded-Proto', 'https']] })), false);
    assert(createRemoteRequestPolicy('http://127.0.0.1:8080')(request({ host: '127.0.0.1:8080' })));
    assert.throws(() => createRemoteRequestPolicy('http://127.0.0.1:8080', ['127.0.0.1']));
});

test('ingress TLS termination requires an exact authority and one HTTPS protocol header without peer CIDRs', () => {
    const allowed = createRemoteRequestPolicy(issuer, undefined, 'ingress');
    for (const peer of ['127.0.0.1', '10.1.2.3', '192.0.2.1', '2001:db8::19']) {
        assert(allowed(request({ peer, headers: [['X-Forwarded-Proto', 'https']] })));
    }
    assert(allowed(request({ host: 'MCP.EXAMPLE.TEST', headers: [['X-Forwarded-Proto', 'https']] })));
    for (const headers of [[], [['X-Forwarded-Proto', 'http']], [['X-Forwarded-Proto', 'HTTPS']],
        [['X-Forwarded-Proto', 'https,http']], [['X-Forwarded-Proto', 'https, https']], [['X-Forwarded-Proto', ' https']],
        ...['Forwarded', 'X-Forwarded-Host', 'X-Forwarded-Port'].map(name => [['X-Forwarded-Proto', 'https'], [name, '']])]) {
        assert.equal(allowed(request({ headers })), false);
    }
    for (const raw of [['x-forwarded-proto', 'https'], ['host', 'mcp.example.test']]) {
        assert.equal(allowed(request({ headers: [['X-Forwarded-Proto', 'https']], raw })), false);
    }
    for (const host of ['attacker.invalid', 'mcp.example.test:443']) {
        assert.equal(allowed(request({ host, headers: [['X-Forwarded-Proto', 'https']] })), false);
    }
    assert.equal(allowed(request({ encrypted: true })), false);
    assert.throws(() => createRemoteRequestPolicy('http://127.0.0.1:8080', undefined, 'ingress'));
    assert.throws(() => createRemoteRequestPolicy(issuer, ['127.0.0.1/32'], 'ingress'));
});
