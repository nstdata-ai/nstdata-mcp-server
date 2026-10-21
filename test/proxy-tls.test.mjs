import { test } from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import http from 'node:http';
import net from 'node:net';
import { harness, inMemoryClient } from './helpers.mjs';
import { tlsMaterial, listen, proxyFixture } from './proxy-fixtures.mjs';

test('an IP-only certificate succeeds for its matching target without localhost identity', { timeout: 15000 }, async t => {
    const material = tlsMaterial(t, { san: 'IP:127.0.0.1', commonName: 'ip-fixture.invalid' });
    const target = https.createServer(material, (_req, res) => res.end('matched IP'));
    const port = await listen(t, target);
    const proxy = await proxyFixture(t);
    const h = await harness(t, (_req, res) => res.end(), { NSTDATA_MODULES: 'proxy', NSTDATA_API_TOKEN: '',
        NSTDATA_PROXY_URL: proxy.url, NSTDATA_PROXY_CHECK_URL: `https://127.0.0.1:${port}`, NSTDATA_PROXY_CA_FILE: material.certFile });
    const result = await h.client.callTool({ name: 'nstdata_proxy_fetch', arguments: { url: `https://127.0.0.1:${port}` } });
    assert.equal(result.isError, false);
    assert.equal(result.structuredContent.body, 'matched IP');
});

test('IP targets verify the actual IP rather than falling back to localhost', { timeout: 15000 }, async t => {
    const material = tlsMaterial(t);
    const target = https.createServer(material, (_req, res) => res.end('IP target'));
    const port = await listen(t, target);
    const proxy = await proxyFixture(t);
    const h = await harness(t, (_req, res) => res.end(), { NSTDATA_MODULES: 'proxy', NSTDATA_API_TOKEN: '',
        NSTDATA_PROXY_URL: proxy.url, NSTDATA_PROXY_CHECK_URL: `https://127.0.0.1:${port}`, NSTDATA_PROXY_CA_FILE: material.certFile });
    const mismatch = await h.client.callTool({ name: 'nstdata_proxy_fetch', arguments: { url: `https://127.0.0.2:${port}` } });
    assert.equal(mismatch.isError, true);
    assert.equal(mismatch.structuredContent.error.code, 'TLS_ERROR');
});

test('deadline also covers a stalled target TLS handshake after CONNECT succeeds', { timeout: 10000 }, async t => {
    let handshaking;
    const started = new Promise(resolve => { handshaking = resolve; });
    const target = net.createServer(socket => { socket.once('data', handshaking); socket.on('end', () => socket.end()); socket.resume(); });
    const port = await listen(t, target);
    const proxy = await proxyFixture(t);
    const client = await inMemoryClient(t, { NSTDATA_MODULES: 'proxy', NSTDATA_API_TOKEN: '',
        NSTDATA_PROXY_URL: proxy.url, NSTDATA_PROXY_CHECK_URL: `https://localhost:${port}`, NSTDATA_HTTP_TIMEOUT_MS: '100' });
    // Advance the deadline only after the target receives the TLS ClientHello.
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const pending = client.callTool({ name: 'nstdata_proxy_fetch', arguments: { url: `https://localhost:${port}` } });
    await started;
    t.mock.timers.tick(100);
    const result = await pending;
    assert.equal(result.structuredContent.error.code, 'TIMEOUT');
    assert.equal(proxy.connections.length, 1);
    await proxy.connections[0].closed;
});

test('oversized CONNECT headers are rejected before completing the handshake', { timeout: 10000 }, async t => {
    const proxy = await proxyFixture(t, { largeConnectHeaders: true });
    const h = await harness(t, (_req, res) => res.end(), { NSTDATA_MODULES: 'proxy', NSTDATA_API_TOKEN: '',
        NSTDATA_PROXY_URL: proxy.url, NSTDATA_PROXY_CHECK_URL: 'https://target.invalid' });
    const result = await h.client.callTool({ name: 'nstdata_proxy_fetch', arguments: { url: 'https://target.invalid' } });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.error.code, 'RESPONSE_LIMIT');
    await proxy.connections[0].closed;
});

test('deadline during CONNECT negotiation destroys the pending gateway socket', { timeout: 10000 }, async t => {
    let connecting;
    const started = new Promise(resolve => { connecting = resolve; });
    const proxy = await proxyFixture(t, { hangConnect: true, onConnect: connecting });
    const client = await inMemoryClient(t, { NSTDATA_MODULES: 'proxy', NSTDATA_API_TOKEN: '',
        NSTDATA_PROXY_URL: proxy.url, NSTDATA_PROXY_CHECK_URL: 'https://target.invalid', NSTDATA_HTTP_TIMEOUT_MS: '100' });
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const pending = client.callTool({ name: 'nstdata_proxy_fetch', arguments: { url: 'https://target.invalid' } });
    await started;
    t.mock.timers.tick(100);
    const result = await pending;
    assert.equal(result.structuredContent.error.code, 'TIMEOUT');
    assert.equal(proxy.connections.length, 1);
    await proxy.connections[0].closed;
});

test('CONNECT authentication failure preserves status and is not retried', { timeout: 10000 }, async t => {
    const proxy = await proxyFixture(t, { connectStatus: 407 });
    const h = await harness(t, (_req, res) => res.end(), { NSTDATA_MODULES: 'proxy', NSTDATA_API_TOKEN: '',
        NSTDATA_PROXY_URL: proxy.url, NSTDATA_PROXY_CHECK_URL: 'https://target.invalid' });
    const result = await h.client.callTool({ name: 'nstdata_proxy_fetch', arguments: { url: 'https://target.invalid' } });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.error.code, 'PROXY_AUTHORIZATION_FAILED');
    assert.equal(result.structuredContent.error.statusCode, 407);
    assert.equal(proxy.connections.length, 1);
});

test('HTTPS gateway connections retain certificate validation for both HTTP and HTTPS targets', { timeout: 15000 }, async t => {
    const material = tlsMaterial(t);
    const plain = http.createServer((_req, res) => res.end('http target'));
    const secure = https.createServer(material, (_req, res) => res.end('https target'));
    const plainPort = await listen(t, plain), securePort = await listen(t, secure);
    const proxy = await proxyFixture(t, { tls: material });
    const config = { NSTDATA_MODULES: 'proxy', NSTDATA_API_TOKEN: '', NSTDATA_PROXY_URL: proxy.url,
        NSTDATA_PROXY_CHECK_URL: `http://127.0.0.1:${plainPort}`, NSTDATA_PROXY_CA_FILE: material.certFile };
    const h = await harness(t, (_req, res) => res.end(), config);
    for (const url of [`http://127.0.0.1:${plainPort}`, `https://localhost:${securePort}`]) {
        const result = await h.client.callTool({ name: 'nstdata_proxy_fetch', arguments: { url } });
        assert.equal(result.isError, false);
        assert.match(result.structuredContent.body, /target/);
    }
    const { NSTDATA_PROXY_CA_FILE: _omitted, ...withoutCA } = config;
    const untrusted = await harness(t, (_req, res) => res.end(), withoutCA);
    const rejected = await untrusted.client.callTool({ name: 'nstdata_proxy_fetch', arguments: { url: `http://127.0.0.1:${plainPort}` } });
    assert.equal(rejected.isError, true);
    assert.equal(rejected.structuredContent.error.code, 'TLS_ERROR');
});

test('HTTPS through CONNECT trusts the explicit CA, verifies hostnames and keeps proxy authentication outside the tunnel', { timeout: 15000 }, async t => {
    const material = tlsMaterial(t);
    const received = [];
    const target = https.createServer(material, (req, res) => { received.push(req.headers); res.end('trusted target'); });
    const port = await listen(t, target);
    const proxy = await proxyFixture(t);
    const config = { NSTDATA_MODULES: 'proxy', NSTDATA_API_TOKEN: '', NSTDATA_PROXY_URL: proxy.url,
        NSTDATA_PROXY_CHECK_URL: `https://localhost:${port}/`, NSTDATA_PROXY_CA_FILE: material.certFile };
    const h = await harness(t, (_req, res) => res.end(), config);
    const good = await h.client.callTool({ name: 'nstdata_proxy_fetch', arguments: { url: `https://localhost:${port}/` } });
    assert.equal(good.isError, false);
    assert.equal(good.structuredContent.body, 'trusted target');
    assert.equal(proxy.connections[0].authority, `localhost:${port}`);
    assert.match(proxy.connections[0].headers['proxy-authorization'], /^Basic /);
    assert.equal(received[0]['proxy-authorization'], undefined);
    assert.equal(received[0]['x-api-key'], undefined);
    const mismatch = await h.client.callTool({ name: 'nstdata_proxy_fetch', arguments: { url: `https://wrong.invalid:${port}/` } });
    assert.equal(mismatch.isError, true);
    assert.equal(received.length, 1);
    const { NSTDATA_PROXY_CA_FILE: _omittedCA, ...withoutCA } = config;
    const untrusted = await harness(t, (_req, res) => res.end(), withoutCA);
    const rejected = await untrusted.client.callTool({ name: 'nstdata_proxy_fetch', arguments: { url: `https://localhost:${port}/` } });
    assert.equal(rejected.isError, true);
    assert.equal(received.length, 1);
});

test('HTTPS target 407 remains a target response in fetch and check tools', { timeout: 10000 }, async t => {
    const material = tlsMaterial(t);
    let received = 0;
    const target = https.createServer(material, (req, res) => {
        received++;
        assert.equal(req.headers['proxy-authorization'], undefined);
        res.writeHead(407); res.end('target diagnostic');
    });
    const port = await listen(t, target), proxy = await proxyFixture(t);
    const url = `https://localhost:${port}/`;
    const h = await harness(t, (_req, res) => res.end(), { NSTDATA_MODULES: 'proxy', NSTDATA_API_TOKEN: '',
        NSTDATA_PROXY_URL: proxy.url, NSTDATA_PROXY_CHECK_URL: url, NSTDATA_PROXY_CA_FILE: material.certFile });
    const fetched = await h.client.callTool({ name: 'nstdata_proxy_fetch', arguments: { url } });
    assert.equal(fetched.isError, true);
    assert.equal(fetched.structuredContent.statusCode, 407);
    assert.equal(fetched.structuredContent.body, 'target diagnostic');
    assert.equal(fetched.structuredContent.error, undefined);
    const checked = await h.client.callTool({ name: 'nstdata_proxy_check', arguments: {} });
    assert.equal(checked.isError, true);
    assert.equal(checked.structuredContent.statusCode, 407);
    assert.ok(checked.structuredContent.elapsedMs >= 0);
    assert.equal(checked.structuredContent.error, undefined);
    assert.equal(received, 2);
    assert.equal(proxy.connections.length, 2);
});
