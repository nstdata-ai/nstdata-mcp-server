import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { gzipSync, deflateSync, brotliCompressSync } from 'node:zlib';
import { harness, inMemoryClient } from './helpers.mjs';
import { listen } from './proxy-fixtures.mjs';

const settings = origin => ({ NSTDATA_MODULES: 'proxy', NSTDATA_API_TOKEN: '',
    NSTDATA_PROXY_URL: origin.replace('://', '://fixture-user:fixture-password@'),
    NSTDATA_PROXY_CHECK_URL: 'http://check.invalid/ip',
});

test('Proxy-only ignores disabled Crawl credentials and product settings', { timeout: 10000 }, async t => {
    const h = await harness(t, (_req, res) => res.end(), origin => ({ ...settings(origin),
        NSTDATA_API_BASE_URL: 'not-a-url', NSTDATA_MAX_CRAWL_PAGES: 'not-a-number' }));
    assert.equal((await h.client.listTools()).tools.length, 2);
});

test('HTTP protocol upgrades fail promptly instead of escaping the tool deadline', { timeout: 5000 }, async t => {
    let disconnected;
    const closed = new Promise(resolve => { disconnected = resolve; });
    const h = await harness(t, (_req, res) => {
        res.socket.on('close', disconnected);
        res.writeHead(101, { Connection: 'Upgrade', Upgrade: 'websocket' }); res.end();
    }, settings);
    const result = await h.client.callTool({ name: 'nstdata_proxy_fetch', arguments: { url: 'http://target.invalid' } }, { timeout: 1000 });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.error.code, 'UNSUPPORTED_RESPONSE');
    await closed;
    assert.equal((await h.client.listTools()).tools.length, 2);
});

test('credential filtering preserves binary bytes and encoding metadata, but refuses sensitive binary data', { timeout: 10000 }, async t => {
    for (const password of ['AA', 'base']) {
        const h = await harness(t, (_req, res) => res.end(Buffer.from([0, 0, 0])), origin => ({ ...settings(origin),
            NSTDATA_PROXY_URL: origin.replace('://', `://fixture-user:${password}@`) }));
        const result = await h.client.callTool({ name: 'nstdata_proxy_fetch', arguments: { url: 'http://target.invalid', format: 'base64' } });
        assert.equal(result.isError, false);
        assert.equal(result.structuredContent.encoding, 'base64');
        assert.equal(result.structuredContent.body, 'AAAA');
    }
    const h = await harness(t, (_req, res) => res.end('fixture-password'), settings);
    const result = await h.client.callTool({ name: 'nstdata_proxy_fetch', arguments: { url: 'http://target.invalid', format: 'base64' } });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.error.code, 'SENSITIVE_OUTPUT');
    assert.doesNotMatch(JSON.stringify(result), /fixture-password/);
});

test('deflate/br content decodes and invalid or unknown encodings fail explicitly', { timeout: 10000 }, async t => {
    const h = await harness(t, (req, res) => {
        const encoding = req.url.split('/').at(-1);
        res.writeHead(200, { 'Content-Encoding': encoding === 'invalid' ? 'gzip' : encoding });
        res.end(encoding === 'deflate' ? deflateSync('decoded fixture') : encoding === 'br' ? brotliCompressSync('decoded fixture') : 'bad bytes');
    }, settings);
    for (const encoding of ['deflate', 'br']) {
        const result = await h.client.callTool({ name: 'nstdata_proxy_fetch', arguments: { url: `http://target.invalid/${encoding}` } });
        assert.equal(result.structuredContent.body, 'decoded fixture');
    }
    for (const [encoding, code] of [['invalid', 'INVALID_RESPONSE'], ['unknown', 'UNSUPPORTED_ENCODING']]) {
        const result = await h.client.callTool({ name: 'nstdata_proxy_fetch', arguments: { url: `http://target.invalid/${encoding}` } });
        assert.equal(result.isError, true);
        assert.equal(result.structuredContent.error.code, code);
    }
});

test('Proxy fetch rejects invalid UTF-8 text without corrupting binary bytes', { timeout: 10000 }, async t => {
    const bytes = Buffer.from([0x61, 0xff, 0x62]);
    const h = await harness(t, (_req, res) => res.end(bytes), settings);
    const text = await h.client.callTool({ name: 'nstdata_proxy_fetch', arguments: { url: 'http://target.invalid' } });
    assert.equal(text.isError, true);
    assert.equal(text.structuredContent.error.code, 'INVALID_RESPONSE');
    assert.doesNotMatch(JSON.stringify(text), /�/);
    const binary = await h.client.callTool({ name: 'nstdata_proxy_fetch', arguments: { url: 'http://target.invalid', format: 'base64' } });
    assert.notEqual(binary.isError, true);
    assert.deepEqual(Buffer.from(binary.structuredContent.body, 'base64'), bytes);
    assert.equal(h.requests.length, 2);
});

test('Crawl-only ignores disabled Proxy credentials, including an invalid CA path', { timeout: 10000 }, async t => {
    const h = await harness(t, (_req, res) => res.end(), { NSTDATA_PROXY_URL: 'not-a-url', NSTDATA_PROXY_CA_FILE: '/nonexistent/fixture-password' });
    assert.equal((await h.client.listTools()).tools.length, 6);
});

test('Crawl and Proxy coexist without sending the Crawl key to the proxy and redact configured credentials', { timeout: 10000 }, async t => {
    const h = await harness(t, (req, res) => {
        if (req.url.startsWith('/api/')) return res.end(JSON.stringify({ code: 200, err: false, data: { status: 'completed', success: true, data: { markdown: 'crawl result' } } }));
        res.end(JSON.stringify({ echo: ['fixture-token', 'fixture-user', 'fixture-password', req.headers['proxy-authorization']] }));
    }, origin => ({ ...settings(origin), NSTDATA_MODULES: 'crawl,proxy', NSTDATA_API_TOKEN: 'fixture-token' }));
    assert.equal((await h.client.listTools()).tools.length, 8);
    const crawl = await h.client.callTool({ name: 'nstdata_crawl_scrape', arguments: { url: 'https://example.com' } });
    assert.equal(crawl.isError, false);
    const proxy = await h.client.callTool({ name: 'nstdata_proxy_fetch', arguments: { url: 'http://target.invalid' } });
    assert.equal(proxy.isError, false);
    assert.equal(h.requests[1].headers['x-api-key'], undefined);
    assert.doesNotMatch(JSON.stringify(proxy), /fixture-token|fixture-user|fixture-password|Zml4dHVyZS11c2VyOmZpeHR1cmUtcGFzc3dvcmQ=/);
});

test('oversized proxy output is bounded and target HTTP failures retain their real status', { timeout: 10000 }, async t => {
    const h = await harness(t, (req, res) => {
        res.writeHead(req.url.endsWith('/missing') ? 404 : 200); res.end(req.url.endsWith('/missing') ? 'not found' : 'x'.repeat(4000));
    }, origin => ({ ...settings(origin), NSTDATA_MAX_OUTPUT_CHARS: '1024' }));
    const large = await h.client.callTool({ name: 'nstdata_proxy_fetch', arguments: { url: 'http://target.invalid/large' } });
    assert.equal(large.isError, true);
    assert.equal(large.structuredContent.error.code, 'OUTPUT_LIMIT');
    assert.ok(large.content[0].text.length <= 1024);
    const missing = await h.client.callTool({ name: 'nstdata_proxy_fetch', arguments: { url: 'http://target.invalid/missing' } });
    assert.equal(missing.isError, true);
    assert.equal(missing.structuredContent.statusCode, 404);
    assert.equal(missing.structuredContent.body, 'not found');
});

for (const era of ['legacy', 'modern']) {
    test(`${era} cancellation closes a pending proxy body and leaves the process usable`, { timeout: 10000 }, async t => {
        let started, disconnected;
        const receiving = new Promise(resolve => { started = resolve; });
        const closed = new Promise(resolve => { disconnected = resolve; });
        const h = await harness(t, (_req, res) => { res.writeHead(200); res.write('pending'); res.on('close', disconnected); started(); }, settings, era);
        const controller = new AbortController();
        const pending = h.client.callTool({ name: 'nstdata_proxy_fetch', arguments: { url: 'http://target.invalid' } }, { signal: controller.signal });
        const rejected = assert.rejects(pending);
        await receiving;
        controller.abort();
        await rejected;
        await closed;
        assert.equal((await h.client.listTools()).tools.length, 2);
    });
}

for (const phase of ['headers', 'body']) {
    test(`proxy deadline covers stalled ${phase} and closes the connection`, { timeout: 10000 }, async t => {
        let disconnected, receiving;
        const closed = new Promise(resolve => { disconnected = resolve; });
        const started = new Promise(resolve => { receiving = resolve; });
        let attempts = 0;
        const originalRequest = http.request;
        t.mock.method(http, 'request', function (...args) {
            attempts++;
            const request = Reflect.apply(originalRequest, this, args);
            if (phase === 'body') request.once('response', response => response.once('data', receiving));
            return request;
        });
        const api = http.createServer((_req, res) => {
            res.on('close', disconnected);
            if (phase === 'body') { res.writeHead(200); res.write('pending'); }
            else receiving();
        });
        const port = await listen(t, api);
        const client = await inMemoryClient(t, { ...settings(`http://127.0.0.1:${port}`), NSTDATA_HTTP_TIMEOUT_MS: '100' });
        t.mock.timers.enable({ apis: ['setTimeout'] });
        const pending = client.callTool({ name: 'nstdata_proxy_fetch', arguments: { url: 'http://target.invalid' } });
        await started;
        t.mock.timers.tick(100);
        const result = await pending;
        assert.equal(result.isError, true);
        assert.equal(result.structuredContent.error.code, 'TIMEOUT');
        assert.equal(attempts, 1);
        await closed;
    });
}

test('proxy authentication failure is classified without retries or raw response details', { timeout: 10000 }, async t => {
    const h = await harness(t, (_req, res) => { res.writeHead(407); res.end('fixture-password private diagnostic'); }, settings);
    const result = await h.client.callTool({ name: 'nstdata_proxy_fetch', arguments: { url: 'http://target.invalid' } });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.error.code, 'PROXY_AUTHORIZATION_FAILED');
    assert.equal(result.structuredContent.error.statusCode, 407);
    assert.doesNotMatch(JSON.stringify(result), /fixture-password|private diagnostic/);
    assert.equal(h.requests.length, 1);
});

test('compressed content is decoded and both downloaded and expanded bodies obey the byte cap', { timeout: 10000 }, async t => {
    const h = await harness(t, (req, res) => {
        if (req.url.endsWith('/wire')) { res.writeHead(200); res.write('x'.repeat(600)); return res.end(); }
        res.writeHead(200, { 'Content-Encoding': 'gzip' });
        res.end(gzipSync(req.url.endsWith('/expanded') ? 'x'.repeat(4000) : 'Hello 中文'));
    }, origin => ({ ...settings(origin), NSTDATA_MAX_RESPONSE_BYTES: '512' }));
    const good = await h.client.callTool({ name: 'nstdata_proxy_fetch', arguments: { url: 'http://target.invalid/small' } });
    assert.equal(good.structuredContent.body, 'Hello 中文');
    for (const suffix of ['/wire', '/expanded']) {
        const result = await h.client.callTool({ name: 'nstdata_proxy_fetch', arguments: { url: `http://target.invalid${suffix}` } });
        assert.equal(result.isError, true);
        assert.equal(result.structuredContent.error.code, 'RESPONSE_LIMIT');
    }
});

test('binary responses are lossless base64 and HEAD/redirect responses do not trigger extra requests', { timeout: 10000 }, async t => {
    const h = await harness(t, (req, res) => {
        if (req.url.includes('/redirect')) { res.writeHead(302, { Location: 'http://elsewhere.invalid/' }); return res.end(); }
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); res.end(Buffer.from([0, 255, 128, 1]));
    }, settings);
    const binary = await h.client.callTool({ name: 'nstdata_proxy_fetch', arguments: { url: 'http://target.invalid/binary', format: 'base64' } });
    assert.equal(binary.isError, false);
    assert.equal(binary.structuredContent.body, 'AP+AAQ==');
    assert.equal(binary.structuredContent.encoding, 'base64');
    const head = await h.client.callTool({ name: 'nstdata_proxy_fetch', arguments: { url: 'http://target.invalid/binary', method: 'HEAD' } });
    assert.equal(head.structuredContent.body, '');
    const redirect = await h.client.callTool({ name: 'nstdata_proxy_fetch', arguments: { url: 'http://target.invalid/redirect' } });
    assert.equal(redirect.isError, true);
    assert.equal(redirect.structuredContent.statusCode, 302);
    assert.equal(redirect.structuredContent.headers.location, 'http://elsewhere.invalid/');
    assert.equal(h.requests.length, 3);
});

test('invalid destinations, mutation methods and connection/auth overrides are rejected before proxy traffic', { timeout: 10000 }, async t => {
    const h = await harness(t, (_req, res) => res.end('unexpected'), settings);
    for (const args of [
        { url: 'file:///etc/passwd' }, { url: 'http://user:pass@target.invalid' },
        { url: 'http://target.invalid', method: 'POST' },
        { url: 'http://target.invalid', headers: { Host: 'other.invalid' } },
        { url: 'http://target.invalid', headers: { 'Proxy-Authorization': 'Basic arbitrary' } },
        { url: 'http://target.invalid', headers: { Connection: 'keep-alive' } },
        { url: 'http://target.invalid', headers: { 'x-test': 'bad\r\nheader: x' } },
    ]) {
        const result = await h.client.callTool({ name: 'nstdata_proxy_fetch', arguments: args });
        assert.equal(result.isError, true);
    }
    assert.equal(h.requests.length, 0);
});

test('check uses only its configured target and reports measured time and an explicitly returned IP', { timeout: 10000 }, async t => {
    const h = await harness(t, (_req, res) => res.end('{"ip":"203.0.113.7"}'), settings);
    const result = await h.client.callTool({ name: 'nstdata_proxy_check', arguments: {} });
    assert.equal(result.isError, false);
    assert.equal(result.structuredContent.observedIp, '203.0.113.7');
    assert.ok(Number.isFinite(result.structuredContent.elapsedMs) && result.structuredContent.elapsedMs >= 0);
    assert.equal(h.requests[0].url, 'http://check.invalid/ip');
    const invalid = await h.client.callTool({ name: 'nstdata_proxy_check', arguments: { url: 'http://other.invalid' } });
    assert.equal(invalid.isError, true);
    assert.equal(h.requests.length, 1);
});

test('proxy-only discovers two tools and forwards a GET with gateway-only Basic authentication', { timeout: 10000 }, async t => {
    const h = await harness(t, (_req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<h1>Proxy fixture</h1>'); }, settings);
    const { tools } = await h.client.listTools();
    assert.deepEqual(tools.map(tool => tool.name).sort(), ['nstdata_proxy_check', 'nstdata_proxy_fetch']);
    const result = await h.client.callTool({ name: 'nstdata_proxy_fetch', arguments: { url: 'http://target.invalid/page', headers: { 'Accept-Language': 'en' } } });
    assert.equal(result.isError, false);
    assert.equal(result.structuredContent.body, '<h1>Proxy fixture</h1>');
    assert.equal(result.structuredContent.statusCode, 200);
    assert.equal(h.requests[0].url, 'http://target.invalid/page');
    assert.equal(h.requests[0].headers.host, 'target.invalid');
    assert.equal(h.requests[0].headers['proxy-authorization'], `Basic ${Buffer.from('fixture-user:fixture-password').toString('base64')}`);
    assert.equal(h.requests[0].headers['accept-language'], 'en');
    assert.equal(h.requests[0].headers['x-api-key'], undefined);
    assert.equal(h.stderr(), '');
});
