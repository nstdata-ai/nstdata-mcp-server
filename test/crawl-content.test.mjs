import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cli, harness, envelope, json } from './helpers.mjs';

const executable = process.env.NSTDATA_TEST_CLI ?? cli;

for (const era of ['legacy', 'modern']) {
    test(`${era} Crawl tools preserve inline binary content without hidden downloads`, { timeout: 10000 }, async t => {
        const h = await harness(t, (req, res) => {
            const data = { pdf: 'JVBERi0xLjQK', screenshot: 'AP+A', rawData: '<p>雪</p>' };
            json(res, envelope(req.url.split('?')[0].endsWith('/pages') ? { data: [{ data }] } : { success: true, data }));
        }, {}, era, executable);
        for (const request of [
            { name: 'nstdata_crawl_scrape', arguments: { url: 'https://example.com', formats: ['pdf', 'screenshot', 'rawData'] } },
            { name: 'nstdata_crawl_scrape_result', arguments: { taskId: 'task' } },
            { name: 'nstdata_crawl_pages', arguments: { crawlId: 'crawl' } },
        ]) {
            const result = await h.client.callTool(request);
            assert.notEqual(result.isError, true);
            assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
            const data = request.name === 'nstdata_crawl_pages' ? result.structuredContent.data[0].data : result.structuredContent.data;
            assert.deepEqual(data.pdf, { encoding: 'base64', base64: 'JVBERi0xLjQK' });
            assert.deepEqual(data.screenshot, { encoding: 'base64', base64: 'AP+A' });
            assert.deepEqual(data.rawData, { encoding: 'base64', base64: 'PHA+6ZuqPC9wPg==' });
        }
        assert.equal(h.requests.length, 3);
        assert.ok(h.requests.every(request => !request.url.includes('/storage/')));
        assert.equal(h.stderr(), '');
    });
}

test('Crawl tools retain service truncation flags and actual task identity', { timeout: 10000 }, async t => {
    let truncated;
    const h = await harness(t, (req, res) => {
        const result = { id: 'actual-task', success: true, data: { markdown: '# Fixture', truncated } };
        json(res, envelope(req.url.split('?')[0].endsWith('/pages') ? { data: [{ ...result, taskId: 'actual-page' }] } : result));
    }, {}, 'legacy', executable);
    for (const flag of [true, false, undefined, null]) {
        truncated = flag;
        const sync = await h.client.callTool({ name: 'nstdata_crawl_scrape', arguments: { url: 'https://example.com' } });
        assert.equal(sync.structuredContent.id, 'actual-task');
        const result = await h.client.callTool({ name: 'nstdata_crawl_scrape_result', arguments: { taskId: 'task' } });
        assert.equal(result.structuredContent.id, 'actual-task');
        assert.equal(result.structuredContent.taskId, 'task');
        const pages = await h.client.callTool({ name: 'nstdata_crawl_pages', arguments: { crawlId: 'crawl' } });
        assert.equal(pages.structuredContent.data[0].taskId, 'actual-page');
        for (const data of [sync.structuredContent.data, result.structuredContent.data, pages.structuredContent.data[0].data]) {
            assert.equal(data.truncated, flag === null ? undefined : flag);
        }
    }
    assert.equal(h.requests.length, 12);
});

test('Crawl inline binary credentials are withheld in all result paths', { timeout: 10000 }, async t => {
    let data;
    const h = await harness(t, (req, res) => json(res, envelope(
        req.url.split('?')[0].endsWith('/pages') ? { data: [{ data }] } : { success: true, data },
    )), {}, 'legacy', executable);
    for (const field of ['pdf', 'screenshot', 'rawData']) {
        data = { [field]: field === 'rawData' ? 'fixture-token' : 'Zml4dHVyZS10b2tlbg==' };
        for (const request of [
            { name: 'nstdata_crawl_scrape', arguments: { url: 'https://example.com', formats: [field] } },
            { name: 'nstdata_crawl_scrape_result', arguments: { taskId: 'task' } },
            { name: 'nstdata_crawl_pages', arguments: { crawlId: 'crawl' } },
        ]) {
            const result = await h.client.callTool(request);
            assert.equal(result.isError, true);
            assert.equal(result.structuredContent.error.code, 'SENSITIVE_OUTPUT');
            assert.doesNotMatch(JSON.stringify(result), /fixture-token|Zml4dHVyZS10b2tlbg==/);
        }
    }
    assert.equal(h.requests.length, 9);
});

test('bounded sync output retains actual identity, references and truncation without resubmitting', { timeout: 10000 }, async t => {
    let data;
    const h = await harness(t, (_req, res) => json(res, envelope({ id: 'known-sync-task', status: 'completed', success: true, data })),
        { NSTDATA_MAX_OUTPUT_CHARS: '1024' }, 'legacy', executable);
    for (const flag of [true, false]) {
        data = { screenshot: 'AP+A'.repeat(2000), markdownRef: 'safe-ref', truncated: flag };
        const result = await h.client.callTool({ name: 'nstdata_crawl_scrape', arguments: { url: 'https://example.com', formats: ['screenshot'] } });
        assert.equal(result.isError, true);
        assert.equal(result.structuredContent.error.code, 'OUTPUT_LIMIT');
        assert.deepEqual(result.structuredContent.error.recovery, { id: 'known-sync-task', markdownRef: 'safe-ref', truncated: flag });
        assert.ok(result.content[0].text.length <= 1024);
        assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
    }
    assert.equal(h.requests.length, 2);
    assert.ok(h.requests.every(request => request.method === 'POST' && request.url === '/api/v1/crawl/scrape'));
});

test('empty, absent and referenced inline content remain distinct without downloading references', { timeout: 10000 }, async t => {
    let data;
    const h = await harness(t, (_req, res) => json(res, envelope({ success: true, data })), {}, 'legacy', executable);
    for (const value of ['', null, undefined]) {
        data = { pdf: value, screenshot: value, rawData: value };
        const result = await h.client.callTool({ name: 'nstdata_crawl_scrape_result', arguments: { taskId: 'empty' } });
        assert.notEqual(result.isError, true);
        assert.deepEqual(result.structuredContent.data, value === '' ? {
            pdf: { encoding: 'base64', base64: '' }, screenshot: { encoding: 'base64', base64: '' }, rawData: { encoding: 'base64', base64: '' },
        } : {});
    }
    data = { pdf: 'AQID', screenshot: '', rawData: 'inline', pdfRef: 'pdf-ref', screenshotRef: 'image-ref', rawDataRef: 'raw-ref' };
    const result = await h.client.callTool({ name: 'nstdata_crawl_scrape_result', arguments: { taskId: 'referenced' } });
    assert.deepEqual(result.structuredContent.data, { pdfRef: 'pdf-ref', screenshotRef: 'image-ref', rawDataRef: 'raw-ref' });
    assert.equal(h.requests.length, 4);
    assert.ok(h.requests.every(request => !request.url.includes('/storage/')));
});

test('nested Base64 preserves encoding and bytes when credential characters overlap encoded text', { timeout: 10000 }, async t => {
    for (const token of ['base64', 'AQ']) {
        const h = await harness(t, (_req, res) => json(res, envelope({ success: true, data: {
            screenshot: 'AQID', metadata: { title: token },
        } })), { NSTDATA_API_TOKEN: token }, 'legacy', executable);
        const result = await h.client.callTool({ name: 'nstdata_crawl_scrape_result', arguments: { taskId: 'binary' } });
        assert.notEqual(result.isError, true);
        assert.deepEqual(result.structuredContent.data.screenshot, { encoding: 'base64', base64: 'AQID' });
        assert.equal(result.structuredContent.data.metadata.title, '<REDACTED>');
    }
});

test('malformed inline content fails without returning private values or creating another task', { timeout: 10000 }, async t => {
    const h = await harness(t, (_req, res) => json(res, envelope({ success: true, data: { pdf: 'private-response!' } })), {}, 'legacy', executable);
    const result = await h.client.callTool({ name: 'nstdata_crawl_scrape', arguments: { url: 'https://example.com', formats: ['pdf'] } });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.error.code, 'UPSTREAM_ERROR');
    assert.doesNotMatch(JSON.stringify(result), /private-response/);
    assert.equal(h.requests.length, 1);
});

test('untrusted encoding-shaped metadata cannot bypass configured credential filtering', { timeout: 10000 }, async t => {
    for (const token of ['AQID', 'QUJD', 'fixture-token']) {
        const h = await harness(t, (_req, res) => json(res, envelope({ success: true, data: {
            metadata: { encoding: 'base64', base64: token },
        } })), { NSTDATA_API_TOKEN: token }, 'legacy', executable);
        const result = await h.client.callTool({ name: 'nstdata_crawl_scrape_result', arguments: { taskId: 'metadata' } });
        assert.notEqual(result.isError, true);
        assert.equal(result.structuredContent.data.metadata.base64, '<REDACTED>');
        assert.ok(!JSON.stringify(result).includes(token));
    }
});

test('credential-bearing property names withhold results without renaming keys', { timeout: 10000 }, async t => {
    const h = await harness(t, (req, res) => {
        const data = { metadata: { nested: [{ 'prefix-fixture-token-suffix': { count: 1 } }] } };
        json(res, envelope(req.url.split('?')[0].endsWith('/pages') ? { data: [{ data }] } : { success: true, data }));
    }, {}, 'legacy', executable);
    for (const request of [
        { name: 'nstdata_crawl_scrape', arguments: { url: 'https://example.com' } },
        { name: 'nstdata_crawl_scrape_result', arguments: { taskId: 'existing' } },
        { name: 'nstdata_crawl_pages', arguments: { crawlId: 'existing' } },
    ]) {
        const result = await h.client.callTool(request);
        assert.equal(result.isError, true);
        assert.equal(result.structuredContent.error.code, 'SENSITIVE_OUTPUT');
        assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
        assert.doesNotMatch(JSON.stringify(result), /fixture-token|count/);
    }
    assert.equal(h.requests.length, 3);
});

test('invalid UTF-8 references fail as text and remain lossless as binary', { timeout: 10000 }, async t => {
    const bytes = Buffer.from([0x61, 0xff, 0x62]);
    const h = await harness(t, (_req, res) => res.end(bytes), {}, 'legacy', executable);
    for (const format of ['markdown', 'html']) {
        const result = await h.client.callTool({ name: 'nstdata_crawl_read_result', arguments: { ref: 'existing', format, length: 1 } });
        assert.equal(result.isError, true);
        assert.equal(result.structuredContent.error.code, 'INVALID_RESPONSE');
        assert.doesNotMatch(JSON.stringify(result), /�/);
    }
    const binary = await h.client.callTool({ name: 'nstdata_crawl_read_result', arguments: { ref: 'existing', format: 'rawData' } });
    assert.notEqual(binary.isError, true);
    assert.deepEqual(Buffer.from(binary.structuredContent.base64, 'base64'), bytes);
    assert.equal(binary.structuredContent.total, bytes.length);
    assert.equal(h.requests.length, 3);
    assert.ok(h.requests.every(request => request.method === 'GET' && request.url.includes('/storage/read')));
});

test('an oversized page-list read can resume from the same position with smaller pages', { timeout: 10000 }, async t => {
    const rows = ['https://example.com/', 'https://example.com/page/2/'].map((url, index) => ({
        url, taskId: `page-${index}`, status: 'completed', success: true,
        data: { markdownRef: `reference-${index}`, links: Array(70).fill('https://example.com/link') },
    }));
    const h = await harness(t, (req, res) => {
        const url = new URL(req.url, 'http://localhost');
        const start = url.searchParams.get('after_cursor') === 'second-row' ? 1 : 0;
        const limit = Number(url.searchParams.get('limit'));
        json(res, envelope({ total: 2, data: rows.slice(start, start + limit),
            ...(start + limit < rows.length ? { nextCursor: 'second-row' } : {}) }));
    }, { NSTDATA_MAX_OUTPUT_CHARS: '4000' });
    const large = await h.client.callTool({ name: 'nstdata_crawl_pages', arguments: { crawlId: 'existing', limit: 2 } });
    assert.equal(large.structuredContent.error.code, 'OUTPUT_LIMIT');
    assert.equal(large.structuredContent.error.recovery.crawlId, 'existing');
    const first = await h.client.callTool({ name: 'nstdata_crawl_pages', arguments: { crawlId: 'existing', limit: 1 } });
    assert.notEqual(first.isError, true);
    assert.ok(first.content[0].text.length <= 4000);
    assert.equal(first.structuredContent.data[0].url, rows[0].url);
    const second = await h.client.callTool({ name: 'nstdata_crawl_pages', arguments: {
        crawlId: 'existing', limit: 1, afterCursor: first.structuredContent.nextCursor,
    } });
    assert.notEqual(second.isError, true);
    assert.ok(second.content[0].text.length <= 4000);
    assert.equal(second.structuredContent.data[0].url, rows[1].url);
    assert.equal(second.structuredContent.nextCursor, undefined);
    assert.equal(h.requests.length, 3);
    assert.ok(h.requests.every(request => request.method === 'GET' && !request.url.includes('/storage/')));
});
