import assert from 'node:assert/strict';
import { test } from 'node:test';
import { envelope, harness, inMemoryClient, json } from './helpers.mjs';

const mismatch = { err: true, code: 'CRAWL_WORKSPACE_MISMATCH', msg: 'private upstream message fixture-token' };
const resultRequest = { name: 'nstdata_crawl_scrape_result', arguments: { taskId: 'fixture-task' } };

test('the default Crawl API retains the production recharge link', async t => {
    const fetch = t.mock.method(globalThis, 'fetch', async input => {
        assert.equal(new URL(input).origin, 'https://api.nstdata.io');
        return Response.json(mismatch, { status: 402 });
    });
    const client = await inMemoryClient(t, { NSTDATA_API_TOKEN: 'fixture-token' });
    const result = await client.callTool(resultRequest);
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.error.statusCode, 402);
    assert.match(result.structuredContent.error.message, /https:\/\/app\.nstdata\.io\/billing\/add-credits/);
    assert.equal(fetch.mock.callCount(), 1);
});

test('all Crawl stdio tools report the workspace mismatch without retrying or exposing upstream content', { timeout: 10000 }, async t => {
    const { client, requests } = await harness(t, (_req, res) => json(res, mismatch, 409));
    const requestsByTool = [
        ['nstdata_crawl_scrape', { url: 'https://target.invalid/', mode: 'sync' }, 'POST', '/api/v1/crawl/scrape'],
        ['nstdata_crawl_scrape', { url: 'https://target.invalid/', mode: 'async' }, 'POST', '/api/v1/crawl/scrape'],
        ['nstdata_crawl_start', { url: 'https://target.invalid/' }, 'POST', '/api/v1/crawl'],
        ['nstdata_crawl_status', { crawlId: 'fixture-crawl' }, 'GET', '/api/v1/crawl/fixture-crawl'],
        ['nstdata_crawl_pages', { crawlId: 'fixture-crawl' }, 'GET', '/api/v1/crawl/fixture-crawl/pages'],
        ['nstdata_crawl_scrape_result', resultRequest.arguments, 'GET', '/api/v1/crawl/scrape/fixture-task'],
        ['nstdata_crawl_read_result', { ref: 'fixture-ref', format: 'markdown' }, 'GET', '/api/v1/crawl/storage/read'],
    ];
    for (const [name, args, method, path] of requestsByTool) {
        const before = requests.length;
        const result = await client.callTool({ name, arguments: args });
        assert.equal(result.isError, true);
        assert.equal(result.structuredContent.error.code, mismatch.code);
        assert.equal(result.structuredContent.error.statusCode, 409);
        assert.match(result.structuredContent.error.message, /workspace.*reconnect/i);
        assert.match(result.structuredContent.error.message, /No automatic retry/);
        assert.doesNotMatch(JSON.stringify(result), /private upstream|fixture-token|outcome is unknown/);
        assert.equal(requests.length, before + 1);
        assert.equal(requests.at(-1).method, method);
        assert.equal(new URL(requests.at(-1).url, 'http://localhost').pathname, path);
    }
});

test('only a bounded HTTP 409 error envelope matches and the connection stays usable', { timeout: 10000 }, async t => {
    let respond;
    const { client, requests } = await harness(t, (req, res) => respond(req, res), { NSTDATA_MAX_RESPONSE_BYTES: '256' });
    for (const [status, code, send] of [
        [409, 'UPSTREAM_ERROR', (_req, res) => json(res, { ...mismatch, code: 'OTHER_CONFLICT' }, 409)],
        [409, 'UPSTREAM_ERROR', (_req, res) => json(res, { ...mismatch, err: false }, 409)],
        [409, 'UPSTREAM_ERROR', (_req, res) => { res.writeHead(409, { 'Content-Type': 'application/json' }); res.end('{"code":'); }],
        [409, 'UPSTREAM_ERROR', (_req, res) => { res.writeHead(409); res.end(JSON.stringify(mismatch)); }],
        [409, 'UPSTREAM_ERROR', (_req, res) => { res.writeHead(409, { 'Content-Type': 'application/json' }); res.write(' '.repeat(300)); res.end(JSON.stringify(mismatch)); }],
        [401, 'AUTHORIZATION_FAILED', (_req, res) => json(res, mismatch, 401)],
        [403, 'AUTHORIZATION_FAILED', (_req, res) => json(res, mismatch, 403)],
        [402, 'UPSTREAM_ERROR', (_req, res) => json(res, mismatch, 402)],
    ]) {
        respond = send;
        const before = requests.length;
        const result = await client.callTool(resultRequest);
        assert.equal(result.isError, true);
        assert.equal(result.structuredContent.error.statusCode, status);
        assert.equal(result.structuredContent.error.code, code);
        if (status === 402) {
            assert.match(result.structuredContent.error.message, /insufficient credits.*the Console for this environment/);
            assert.doesNotMatch(result.structuredContent.error.message, /app\.nstdata\.io/);
        }
        assert.doesNotMatch(JSON.stringify(result), /private upstream|fixture-token|reconnect/);
        assert.equal(requests.length, before + 1);
    }
    respond = (_req, res) => json(res, envelope({ id: 'fixture-task', status: 'completed', success: true }));
    const result = await client.callTool(resultRequest);
    assert.equal(result.isError, false);
    assert.equal(result.structuredContent.id, 'fixture-task');
    assert.equal(requests.length, 9);
});

test('a stalled 409 body still returns the generic conflict and keeps the connection usable', { timeout: 10000 }, async t => {
    const { client, requests } = await harness(t, (_req, res) => {
        if (requests.length === 1) {
            res.writeHead(409, { 'Content-Type': 'application/json' });
            res.write('{');
            return;
        }
        json(res, envelope({ id: 'fixture-task', status: 'completed', success: true }));
    }, { NSTDATA_HTTP_TIMEOUT_MS: '1500' });

    const conflict = await client.callTool(resultRequest);
    assert.equal(conflict.isError, true);
    assert.equal(conflict.structuredContent.error.code, 'UPSTREAM_ERROR');
    assert.equal(conflict.structuredContent.error.statusCode, 409);
    assert.equal(requests.length, 1);

    const result = await client.callTool(resultRequest);
    assert.equal(result.isError, false);
    assert.equal(result.structuredContent.id, 'fixture-task');
    assert.equal(requests.length, 2);
});
