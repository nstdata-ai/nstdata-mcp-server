import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness, json } from './helpers.mjs';

const submissions = [
    { name: 'nstdata_crawl_scrape', arguments: { url: 'https://example.com/', mode: 'sync' } },
    { name: 'nstdata_crawl_scrape', arguments: { url: 'https://example.com/', mode: 'async' } },
    { name: 'nstdata_crawl_start', arguments: { url: 'https://example.com/', maxPages: 2 } },
];

for (const failure of ['disconnect', 'server-error', 'envelope-error', 'invalid-json', 'response-limit']) {
    test(`task submissions preserve unknown outcomes after ${failure}`, { timeout: 10000 }, async t => {
        const h = await harness(t, (req, res) => {
            if (failure === 'disconnect') req.socket.destroy();
            else if (failure === 'server-error') json(res, { message: 'service unavailable' }, 503);
            else if (failure === 'envelope-error') json(res, { code: 500, err: true, msg: 'service unavailable' });
            else if (failure === 'invalid-json') { res.writeHead(200); res.end('{'); }
            else json(res, { payload: 'x'.repeat(1024) });
        }, failure === 'response-limit' ? { NSTDATA_MAX_RESPONSE_BYTES: '512' } : {});
        for (const request of submissions) {
            const before = h.requests.length;
            const result = await h.client.callTool(request);
            assert.equal(result.isError, true);
            assert.equal(result.structuredContent.error.code, failure === 'response-limit' ? 'RESPONSE_LIMIT' : 'UPSTREAM_ERROR');
            assert.match(result.structuredContent.error.message, /submission outcome is unknown/i);
            assert.match(result.structuredContent.error.message, /before submitting again/i);
            assert.equal(h.requests.length, before + 1, 'a failed submission must not be retried');
        }
    });
}

test('read failures and rejected credentials do not claim an unknown submission', { timeout: 10000 }, async t => {
    const h = await harness(t, (req, res) => {
        if (req.method === 'POST') json(res, { message: 'unauthorized' }, 401);
        else req.socket.destroy();
    });
    const read = await h.client.callTool({ name: 'nstdata_crawl_status', arguments: { crawlId: 'existing-task' } });
    assert.equal(read.structuredContent.error.code, 'UPSTREAM_ERROR');
    assert.doesNotMatch(read.structuredContent.error.message, /submission outcome|remote task/i);
    const denied = await h.client.callTool(submissions[1]);
    assert.equal(denied.structuredContent.error.code, 'AUTHORIZATION_FAILED');
    assert.doesNotMatch(denied.structuredContent.error.message, /submission outcome|remote task/i);
    assert.equal(h.requests.length, 2);
});

test('async acknowledgements require a reusable ID while explicit failures and sync content remain valid', { timeout: 10000 }, async t => {
    let response;
    const h = await harness(t, (_req, res) => json(res, { code: 200, err: false, data: response }));
    for (const id of [undefined, null, '', '   ', ' padded ', 42, 'x'.repeat(257)]) {
        response = { id, status: 'processing' };
        for (const request of submissions.slice(1)) {
            const before = h.requests.length;
            const result = await h.client.callTool(request);
            assert.equal(result.isError, true);
            assert.equal(result.structuredContent.error.code, 'UPSTREAM_ERROR');
            assert.match(result.structuredContent.error.message, /submission outcome is unknown/i);
            assert.equal(h.requests.length, before + 1);
        }
    }
    for (const failure of [{ status: 'failed' }, { status: 'expired' }, { success: false }]) {
        response = failure;
        for (const request of submissions.slice(1)) {
            const result = await h.client.callTool(request);
            assert.equal(result.isError, true);
            assert.deepEqual(result.structuredContent, failure);
        }
    }
    response = { status: 'completed', success: true, data: { markdown: '# Completed without diagnostic ID' } };
    const sync = await h.client.callTool(submissions[0]);
    assert.notEqual(sync.isError, true);
    assert.equal(sync.structuredContent.data.markdown, response.data.markdown);
    response = { id: 'valid-task', status: 'processing' };
    for (const request of submissions.slice(1)) {
        const result = await h.client.callTool(request);
        assert.notEqual(result.isError, true);
        assert.equal(result.structuredContent.id, 'valid-task');
    }
});
