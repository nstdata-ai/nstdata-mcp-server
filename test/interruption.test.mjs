import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { inMemoryClient } from './helpers.mjs';
const calls = [
    ['nstdata_proxy_fetch', { url: 'http://target.invalid/page' }, false],
    ['nstdata_proxy_check', {}, false],
    ['nstdata_crawl_scrape', { url: 'https://example.com', mode: 'sync' }, true],
    ['nstdata_crawl_scrape', { url: 'https://example.com', mode: 'async' }, true],
    ['nstdata_crawl_start', { url: 'https://example.com' }, true],
    ['nstdata_crawl_scrape_result', { taskId: 'existing-task' }, false],
    ['nstdata_crawl_status', { crawlId: 'existing-crawl' }, false],
    ['nstdata_crawl_pages', { crawlId: 'existing-crawl' }, false],
    ['nstdata_crawl_read_result', { ref: 'existing-ref', format: 'markdown' }, false],
];
function timeoutResult(result, createsTask) {
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.error.code, 'TIMEOUT');
    assert.equal(/remote task may still run/.test(result.structuredContent.error.message), createsTask);
    assert.match(result.structuredContent.error.message, /Local request stopped/);
    assert.match(result.structuredContent.error.message, /No automatic retry/);
    assert.equal(result.structuredContent.error.statusCode, undefined);
}

test('header/body timeouts make one transport attempt, close it and preserve task uncertainty', { timeout: 10000 }, async t => {
    const originalFetch = globalThis.fetch, originalRequest = http.request, requests = [], fetches = [];
    let phase;
    const api = http.createServer((_req, res) => {
        if (phase === 'body') { res.writeHead(200); res.write('{'); }
    });
    api.listen(0, '127.0.0.1'); await once(api, 'listening');
    t.after(() => { api.closeAllConnections(); api.close(); globalThis.fetch = originalFetch; });
    // Count transport attempts: a deadline may expire before any server sees bytes.
    t.mock.method(http, 'request', function (...args) {
        const request = Reflect.apply(originalRequest, this, args);
        requests.push({ request, closed: new Promise(resolve => request.once('close', resolve)) });
        return request;
    });
    globalThis.fetch = async (_url, init) => {
        assert.equal(init.signal.aborted, false);
        assert.equal(init.redirect, 'manual');
        const record = { signal: init.signal, aborted: false }; fetches.push(record);
        if (phase === 'headers') return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => {
            record.aborted = true; reject(init.signal.reason);
        }, { once: true }));
        return new Response(new ReadableStream({ start(controller) {
            controller.enqueue(new TextEncoder().encode('{'));
            init.signal.addEventListener('abort', () => { record.aborted = true; controller.error(init.signal.reason); }, { once: true });
        } }));
    };
    const origin = `http://127.0.0.1:${api.address().port}`;
    const client = await inMemoryClient(t, { NSTDATA_MODULES: 'crawl,proxy', NSTDATA_API_TOKEN: 'fixture-token',
        NSTDATA_API_BASE_URL: origin, NSTDATA_PROXY_URL: origin, NSTDATA_PROXY_CHECK_URL: 'http://target.invalid/check', NSTDATA_HTTP_TIMEOUT_MS: '100' });
    for (phase of ['headers', 'body']) for (const [name, args, createsTask] of calls) {
        const beforeRequests = requests.length, beforeFetches = fetches.length;
        timeoutResult(await client.callTool({ name, arguments: args }), createsTask);
        const proxy = name.startsWith('nstdata_proxy_');
        assert.equal(requests.length, beforeRequests + (proxy ? 1 : 0), name);
        assert.equal(fetches.length, beforeFetches + (proxy ? 0 : 1), name);
        if (proxy) {
            await requests.at(-1).closed;
            assert.equal(requests.at(-1).request.destroyed, true);
        } else {
            assert.equal(fetches.at(-1).aborted, true);
            assert.equal(fetches.at(-1).signal.reason.name, 'TimeoutError');
        }
    }
    assert.equal((await client.listTools()).tools.length, 8);
});

test('a deadline before native fetch dispatch returns TIMEOUT with no server request or retry', { timeout: 10000 }, async t => {
    const originalFetch = globalThis.fetch;
    let attempts = 0, received = 0, delegatedAfterAbort = false;
    const api = http.createServer((_req, res) => { received++; res.end('unexpected'); });
    api.listen(0, '127.0.0.1'); await once(api, 'listening');
    t.after(() => { api.closeAllConnections(); api.close(); globalThis.fetch = originalFetch; });
    globalThis.fetch = async (url, init) => {
        attempts++;
        await once(init.signal, 'abort');
        delegatedAfterAbort = init.signal.aborted;
        return originalFetch(url, init);
    };
    const client = await inMemoryClient(t, { NSTDATA_API_TOKEN: 'fixture-token',
        NSTDATA_API_BASE_URL: `http://127.0.0.1:${api.address().port}`, NSTDATA_HTTP_TIMEOUT_MS: '100' });
    timeoutResult(await client.callTool({ name: 'nstdata_crawl_scrape', arguments: { url: 'https://example.com', mode: 'sync' } }), true);
    assert.equal(attempts, 1);
    assert.equal(delegatedAfterAbort, true);
    assert.equal(received, 0);
    assert.equal((await client.listTools()).tools.length, 6);
});
