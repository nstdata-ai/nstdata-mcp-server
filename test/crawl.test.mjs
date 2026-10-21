import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { listen } from './proxy-fixtures.mjs';
import { harness, envelope, json, inMemoryClient } from './helpers.mjs';

test('a failed submission status is a tool failure for both task-creating flows', { timeout: 10000 }, async t => {
    const h = await harness(t, (_req, res) => json(res, envelope({ id: 'failed-submission', status: 'failed' })));
    for (const request of [
        { name: 'nstdata_crawl_scrape', arguments: { url: 'https://example.com', mode: 'async' } },
        { name: 'nstdata_crawl_start', arguments: { url: 'https://example.com' } },
    ]) {
        const result = await h.client.callTool(request);
        assert.equal(result.isError, true);
        assert.equal(result.structuredContent.id, 'failed-submission');
    }
});

test('status queries preserve the input crawl ID even when the service omits it', { timeout: 10000 }, async t => {
    const h = await harness(t, (_req, res) => json(res, envelope({ status: 'processing', pending: 3 })));
    const result = await h.client.callTool({ name: 'nstdata_crawl_status', arguments: { crawlId: 'resume-crawl' } });
    assert.equal(result.structuredContent.crawlId, 'resume-crawl');
});

test('HTTP 200 envelope failures preserve the API code and classify authorization or rate limiting', { timeout: 10000 }, async t => {
    const h = await harness(t, (_req, res, requests) => json(res, { code: requests.length === 1 ? 403 : 429, err: true, msg: 'fixture-token' }));
    for (const [code, apiCode] of [['AUTHORIZATION_FAILED', 403], ['RATE_LIMITED', 429]]) {
        const result = await h.client.callTool({ name: 'nstdata_crawl_scrape_result', arguments: { taskId: 'envelope' } });
        assert.equal(result.structuredContent.error.code, code);
        assert.equal(result.structuredContent.error.apiCode, apiCode);
        assert.equal(result.structuredContent.error.statusCode, 200);
        assert.doesNotMatch(JSON.stringify(result), /fixture-token/);
    }
});

test('sync task failure preserves the service code and message with token redaction', { timeout: 10000 }, async t => {
    const h = await harness(t, (_req, res) => json(res, envelope({ status: 'failed', success: false, errorCode: 'DENIED', errorMessage: 'Denied fixture-token' })));
    const result = await h.client.callTool({ name: 'nstdata_crawl_scrape', arguments: { url: 'https://example.com' } });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.errorCode, 'DENIED');
    assert.equal(result.structuredContent.errorMessage, 'Denied <REDACTED>');
});

test('pending, expired and empty results remain distinguishable and cursors are opaque', { timeout: 10000 }, async t => {
    const h = await harness(t, (req, res) => {
        if (req.url.split('?')[0].endsWith('/pages')) return json(res, envelope({ data: [], prevCursor: 'a/b +?' }));
        if (req.url.includes('expired')) return json(res, envelope({ status: 'expired' }));
        if (req.url.includes('empty')) return json(res, envelope({ status: 'completed', success: true, data: { markdown: '' } }));
        return json(res, envelope({ status: 'processing' }));
    });
    const call = taskId => h.client.callTool({ name: 'nstdata_crawl_scrape_result', arguments: { taskId } });
    assert.equal((await call('pending')).structuredContent.status, 'processing');
    assert.equal((await call('expired')).isError, true);
    assert.equal((await call('empty')).structuredContent.data.markdown, '');
    const pages = await h.client.callTool({ name: 'nstdata_crawl_pages', arguments: { crawlId: 'crawl/one', beforeCursor: 'a/b +?', limit: 1 } });
    assert.deepEqual(pages.structuredContent.data, []);
    assert.equal(pages.structuredContent.prevCursor, 'a/b +?');
    assert.equal(h.requests.at(-1).url, '/api/v1/crawl/crawl%2Fone/pages?before_cursor=a%2Fb+%2B%3F&limit=1');
    const invalid = await h.client.callTool({ name: 'nstdata_crawl_pages', arguments: { crawlId: 'x', afterCursor: 'a', beforeCursor: 'b' } });
    assert.equal(invalid.isError, true);
    assert.equal(h.requests.length, 4);
});

for (const era of ['legacy', 'modern']) {
    test(`${era} stdio negotiates tools and cancellation disconnects an active request`, { timeout: 10000 }, async t => {
        let started, disconnected;
        const receiving = new Promise(resolve => { started = resolve; });
        const closed = new Promise(resolve => { disconnected = resolve; });
        const h = await harness(t, (_req, res) => {
            res.writeHead(200); res.write('{'); res.on('close', disconnected); started();
        }, {}, era);
        const { tools } = await h.client.listTools();
        assert.equal(tools.length, 6);
        const controller = new AbortController();
        const pending = h.client.callTool({ name: 'nstdata_crawl_scrape_result', arguments: { taskId: 'cancelled' } }, { signal: controller.signal });
        const rejected = assert.rejects(pending);
        await receiving;
        controller.abort();
        await rejected;
        await closed;
        assert.equal((await h.client.listTools()).tools.length, 6);
    });
}

test('API and chunked storage downloads stop at the configured byte limit', { timeout: 10000 }, async t => {
    const h = await harness(t, (_req, res) => {
        res.writeHead(200); res.write('x'.repeat(600)); res.end();
    }, { NSTDATA_MAX_RESPONSE_BYTES: '512' });
    for (const request of [
        { name: 'nstdata_crawl_scrape_result', arguments: { taskId: 'large' } },
        { name: 'nstdata_crawl_read_result', arguments: { ref: 'large', format: 'rawData' } },
    ]) {
        const result = await h.client.callTool(request);
        assert.equal(result.isError, true);
        assert.equal(result.structuredContent.error.code, 'RESPONSE_LIMIT');
    }
});

test('large results return a bounded error with recovery references and redact the configured token', { timeout: 10000 }, async t => {
    const h = await harness(t, (_req, res) => json(res, envelope({ status: 'completed', success: true, data: {
        html: 'x'.repeat(10000), markdownRef: 'safe-ref', metadata: { title: 'fixture-token' },
    } })), { NSTDATA_MAX_OUTPUT_CHARS: '1024' });
    const result = await h.client.callTool({ name: 'nstdata_crawl_scrape_result', arguments: { taskId: 'large-task' } });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.error.code, 'OUTPUT_LIMIT');
    assert.equal(result.structuredContent.error.recovery.taskId, 'large-task');
    assert.equal(result.structuredContent.error.recovery.markdownRef, 'safe-ref');
    assert.ok(result.content[0].text.length <= 1024);
    assert.doesNotMatch(JSON.stringify(result), /fixture-token/);
});

test('results retain requested formats, empty text and references without hidden storage downloads', { timeout: 10000 }, async t => {
    const h = await harness(t, (_req, res) => json(res, envelope({ status: 'completed', success: true, data: {
        markdown: '', html: '<h1>Title</h1>', links: ['https://example.com/a'], pdfRef: 'pdf-one', screenshotRef: 'screen-one', rawDataRef: 'raw-one',
    } })));
    const result = await h.client.callTool({ name: 'nstdata_crawl_scrape', arguments: { url: 'https://example.com', formats: ['markdown', 'html', 'links', 'pdf', 'screenshot', 'rawData'] } });
    assert.equal(result.structuredContent.data.markdown, '');
    assert.equal(result.structuredContent.data.html, '<h1>Title</h1>');
    assert.deepEqual(result.structuredContent.data.links, ['https://example.com/a']);
    assert.equal(result.structuredContent.data.pdfRef, 'pdf-one');
    assert.equal(result.structuredContent.data.screenshotRef, 'screen-one');
    assert.equal(result.structuredContent.data.rawDataRef, 'raw-one');
    assert.equal(h.requests.length, 1);
});

test('documented nested options pass through while invalid inputs create no tasks', { timeout: 10000 }, async t => {
    const h = await harness(t, (_req, res) => json(res, envelope({ id: 'options-task', status: 'processing' })), { NSTDATA_MAX_CRAWL_PAGES: '20' });
    const options = { headers: { 'Accept-Language': 'en' }, onlyMainContent: true, jsRender: { actions: [{ type: 'click', selector: '#open' }, { type: 'wait', milliseconds: 50 }] } };
    const result = await h.client.callTool({ name: 'nstdata_crawl_start', arguments: { url: 'https://example.com', maxPages: 15, maxDepth: 2, includeUrls: ['/docs'], options } });
    assert.notEqual(result.isError, true);
    assert.equal(h.requests[0].body.maxPages, 15);
    assert.deepEqual(h.requests[0].body.jsRender, options.jsRender);
    assert.deepEqual(h.requests[0].body.headers, options.headers);
    assert.equal(h.requests[0].body.options, undefined);
    for (const args of [
        { url: 'file:///etc/passwd' }, { url: 'https://example.com', unexpected: true },
        { url: 'https://example.com', maxPages: 21 },
        { url: 'https://example.com', options: { jsRender: { actions: [{ type: 'fill', selector: '#input' }] } } },
    ]) {
        const invalid = await h.client.callTool({ name: 'nstdata_crawl_start', arguments: args });
        assert.equal(invalid.isError, true);
    }
    assert.equal(h.requests.length, 1);
});

test('a local deadline aborts an unfinished response body and leaves the server usable', { timeout: 10000 }, async t => {
    let disconnected, receiving, requests = 0;
    const closed = new Promise(resolve => { disconnected = resolve; });
    const started = new Promise(resolve => { receiving = resolve; });
    const api = http.createServer((_req, res) => {
        if (++requests > 1) return json(res, envelope({ status: 'processing' }));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.write('{');
        res.on('close', disconnected);
    });
    const port = await listen(t, api), originalFetch = globalThis.fetch;
    t.mock.method(globalThis, 'fetch', async (...args) => {
        const response = await originalFetch(...args);
        if (requests === 1) {
            const reader = response.body.getReader(), read = reader.read.bind(reader);
            t.mock.method(reader, 'read', async () => {
                const chunk = await read();
                if (!chunk.done) receiving();
                return chunk;
            });
            t.mock.method(response.body, 'getReader', () => reader);
        }
        return response;
    });
    const client = await inMemoryClient(t, { NSTDATA_API_TOKEN: 'fixture-token',
        NSTDATA_API_BASE_URL: `http://127.0.0.1:${port}`, NSTDATA_HTTP_TIMEOUT_MS: '60' });
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const pending = client.callTool({ name: 'nstdata_crawl_scrape_result', arguments: { taskId: 'slow' } });
    await started;
    t.mock.timers.tick(60);
    const result = await pending;
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.error.code, 'TIMEOUT');
    await closed;
    assert.equal(requests, 1);
    const next = await client.callTool({ name: 'nstdata_crawl_scrape_result', arguments: { taskId: 'next' } });
    assert.notEqual(next.isError, true);
    assert.equal(requests, 2);
});

test('HTTP errors are classified without exposing upstream bodies or the API token', { timeout: 10000 }, async t => {
    const h = await harness(t, (_req, res) => { res.writeHead(429); res.end('fixture-token private upstream body'); });
    const result = await h.client.callTool({ name: 'nstdata_crawl_scrape', arguments: { url: 'https://example.com' } });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.error.code, 'RATE_LIMITED');
    assert.equal(result.structuredContent.error.statusCode, 429);
    assert.doesNotMatch(JSON.stringify(result), /fixture-token|private upstream body/);
    assert.equal(h.requests.length, 1, 'task creation must not be automatically retried');
});

test('storage references support Unicode text continuation and lossless binary chunks', { timeout: 10000 }, async t => {
    const h = await harness(t, (req, res) => {
        res.writeHead(200);
        res.end(req.url.includes('binary') ? Buffer.from([0, 255, 128, 1]) : 'A😀中文B');
    });
    const text = await h.client.callTool({ name: 'nstdata_crawl_read_result', arguments: { ref: 'text/ref', format: 'markdown', offset: 1, length: 2 } });
    assert.deepEqual(text.structuredContent, { format: 'markdown', encoding: 'utf-8', unit: 'codePoints', offset: 1, text: '😀中', total: 5, nextOffset: 3 });
    const binary = await h.client.callTool({ name: 'nstdata_crawl_read_result', arguments: { ref: 'binary', format: 'pdf', offset: 1, length: 2 } });
    assert.equal(binary.structuredContent.base64, '/4A=');
    assert.equal(binary.structuredContent.nextOffset, 3);
    assert.equal(binary.structuredContent.unit, 'bytes');
    assert.equal(h.requests[0].url, '/api/v1/crawl/storage/read?st=text%2Fref');
});

test('a client discovers the single-page tool and obtains Markdown through the installed SDK', { timeout: 10000 }, async t => {
    const h = await harness(t, (_req, res) => json(res, envelope({
        status: 'completed', success: true, data: { markdown: '# Fixture page', metadata: { title: 'Fixture' } },
    })));
    const { tools } = await h.client.listTools();
    assert.ok(tools.some(tool => tool.name === 'nstdata_crawl_scrape'));
    assert.ok(tools.every(tool => !tool.name.includes('proxy') && !tool.name.includes('browser')));
    const result = await h.client.callTool({ name: 'nstdata_crawl_scrape', arguments: { url: 'https://example.com' } });
    assert.notEqual(result.isError, true);
    assert.match(JSON.stringify(result), /# Fixture page/);
    assert.equal(h.requests[0].url, '/api/v1/crawl/scrape');
    assert.equal(h.requests[0].headers['x-api-key'], 'fixture-token');
    assert.deepEqual(h.requests[0].body.formats, ['markdown']);
    assert.equal(h.stderr(), '');
});

test('site crawling returns a task, progress and one bounded page with reusable references', { timeout: 10000 }, async t => {
    const h = await harness(t, (req, res) => {
        if (req.method === 'POST') return json(res, envelope({ id: 'crawl-one', status: 'processing' }));
        if (req.url === '/api/v1/crawl/crawl-one') return json(res, envelope({ id: 'crawl-one', status: 'completed', total: 2, completed: 2 }));
        return json(res, envelope({ total: 2, nextCursor: 'cursor-two', data: [
            { taskId: 'page-one', url: 'https://example.com/a', status: 'completed', success: true,
                data: { markdownRef: 'markdown-one', metadata: { title: 'Page one' } } },
        ] }));
    });
    const start = await h.client.callTool({ name: 'nstdata_crawl_start', arguments: { url: 'https://example.com' } });
    assert.notEqual(start.isError, true);
    assert.match(JSON.stringify(start), /crawl-one/);
    assert.equal(h.requests[0].body.maxPages, 10);
    const status = await h.client.callTool({ name: 'nstdata_crawl_status', arguments: { crawlId: 'crawl-one' } });
    assert.match(JSON.stringify(status), /completed/);
    const pages = await h.client.callTool({ name: 'nstdata_crawl_pages', arguments: { crawlId: 'crawl-one', afterCursor: 'cursor-one', limit: 1 } });
    assert.notEqual(pages.isError, true);
    assert.match(JSON.stringify(pages), /markdown-one/);
    assert.match(JSON.stringify(pages), /cursor-two/);
    assert.equal(h.requests.length, 3, 'listing references must not automatically download every page');
    assert.equal(h.requests[2].url, '/api/v1/crawl/crawl-one/pages?after_cursor=cursor-one&limit=1');
});

test('an async scrape can be resumed and a failed task is reported as a tool failure', { timeout: 10000 }, async t => {
    const h = await harness(t, (req, res) => {
        if (req.method === 'POST') return json(res, envelope({ id: 'task-one', status: 'processing' }));
        return json(res, envelope({ status: 'failed', success: false, errorCode: 'FIXTURE_BLOCKED', errorMessage: 'Blocked' }));
    });
    const pending = await h.client.callTool({ name: 'nstdata_crawl_scrape', arguments: { url: 'https://example.com', mode: 'async' } });
    assert.notEqual(pending.isError, true);
    assert.match(JSON.stringify(pending), /task-one/);
    const failed = await h.client.callTool({ name: 'nstdata_crawl_scrape_result', arguments: { taskId: 'task-one' } });
    assert.equal(failed.isError, true);
    assert.match(JSON.stringify(failed), /FIXTURE_BLOCKED/);
    assert.equal(h.requests.length, 2);
    assert.equal(h.requests[0].url, '/api/v1/crawl/scrape?async=true');
    assert.equal(h.requests[1].url, '/api/v1/crawl/scrape/task-one');
});
