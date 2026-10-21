import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { harness, envelope, json } from './helpers.mjs';

for (const era of ['legacy', 'modern']) {
    test(`${era} Crawl tools refuse API/storage redirects without forwarding credentials or retrying`, { timeout: 20000 }, async t => {
        let destinationCalls = 0, sameOriginCalls = 0, redirectStatus = 301, sameOrigin = false;
        const destination = http.createServer((_req, res) => {
            destinationCalls++;
            json(res, envelope({ status: 'completed', success: true, data: { markdown: 'redirected' } }));
        });
        destination.listen(0, '127.0.0.1');
        await once(destination, 'listening');
        t.after(async () => {
            const closed = new Promise(resolve => destination.close(resolve));
            destination.closeAllConnections();
            await closed;
        });
        const h = await harness(t, (req, res) => {
            if (req.url.startsWith('/redirected')) {
                sameOriginCalls++;
                return json(res, envelope({ status: 'completed', success: true, data: { markdown: 'redirected' } }));
            }
            res.writeHead(redirectStatus, { Location: sameOrigin ? '/redirected?fixture-token'
                : `http://127.0.0.1:${destination.address().port}/redirected?fixture-token` });
            res.end('upstream-private fixture-token');
        }, {}, era, process.env.NSTDATA_TEST_CLI);
        const calls = [
            ['nstdata_crawl_scrape', { url: 'https://target.invalid/', mode: 'sync' }],
            ['nstdata_crawl_scrape', { url: 'https://target.invalid/', mode: 'async' }],
            ['nstdata_crawl_start', { url: 'https://target.invalid/' }],
            ['nstdata_crawl_scrape_result', { taskId: 'known-task' }],
            ['nstdata_crawl_status', { crawlId: 'known-crawl' }],
            ['nstdata_crawl_pages', { crawlId: 'known-crawl' }],
            ['nstdata_crawl_read_result', { ref: 'opaque-ref', format: 'markdown' }],
        ];
        assert.equal((await h.client.listTools()).tools.length, 6);
        for (redirectStatus of [301, 302, 303, 307, 308]) {
            for (sameOrigin of [false, true]) {
                for (const [name, args] of calls) {
                    const before = h.requests.length;
                    const result = await h.client.callTool({ name, arguments: args });
                    assert.equal(result.isError, true, name);
                    assert.equal(result.structuredContent.error.code, 'UPSTREAM_ERROR', name);
                    assert.equal(result.structuredContent.error.statusCode, redirectStatus, name);
                    assert.match(result.structuredContent.error.message, /No automatic retry/);
                    assert.doesNotMatch(JSON.stringify(result), /fixture-token|upstream-private|redirected|127\.0\.0\.1/);
                    assert.equal(h.requests.length, before + 1, name);
                    assert.equal(destinationCalls, 0);
                    assert.equal(sameOriginCalls, 0);
                }
            }
        }
        assert.equal(h.requests.length, 70);
        assert.equal((await h.client.listTools()).tools.length, 6);
        assert.equal(h.stderr(), '');
    });
}
