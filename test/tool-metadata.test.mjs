import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Socket } from 'node:net';
import { inMemoryClient } from './helpers.mjs';

test('tool discovery provides readable titles and explicit safety hints without network traffic', async t => {
    const connect = Socket.prototype.connect;
    Socket.prototype.connect = function () { throw new Error('Tool discovery must not open a network socket'); };
    t.after(() => { Socket.prototype.connect = connect; });
    const client = await inMemoryClient(t, {
        NSTDATA_MODULES: 'crawl,proxy', NSTDATA_API_TOKEN: 'fixture-token',
        NSTDATA_PROXY_URL: 'http://fixture-user:fixture-password@127.0.0.1:1',
    });
    const expected = {
        nstdata_crawl_scrape: ['Scrape a webpage', false],
        nstdata_crawl_scrape_result: ['Read a scrape result', true],
        nstdata_crawl_start: ['Start a website crawl', false],
        nstdata_crawl_status: ['Check crawl progress', true],
        nstdata_crawl_pages: ['List crawl pages', true],
        nstdata_crawl_read_result: ['Read stored content', true],
        nstdata_proxy_fetch: ['Fetch through a proxy', true],
        nstdata_proxy_check: ['Check a proxy connection', true],
    };
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(tool => tool.name).sort(), Object.keys(expected).sort());
    for (const tool of tools) {
        const [title, readOnly] = expected[tool.name];
        assert.equal(tool.title, title, tool.name);
        assert.equal(tool.annotations.readOnlyHint, readOnly, tool.name);
        assert.equal(tool.annotations.destructiveHint, !readOnly, tool.name);
        assert.equal(tool.annotations.idempotentHint, readOnly, tool.name);
        assert.equal(tool.annotations.openWorldHint, true, tool.name);
    }
});
