import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { cli } from './helpers.mjs';

const { createServer, loadConfig } = await import(new URL('./server.js', pathToFileURL(process.env.NSTDATA_TEST_CLI ?? cli)));

test('body transport failures have no invented HTTP error status; JSON errors stay distinct', { timeout: 10000 }, async t => {
    const originalFetch = globalThis.fetch;
    const server = createServer(loadConfig({ NSTDATA_API_TOKEN: 'fixture-token' }));
    const client = new Client({ name: 'body-error-regression', version: '1.0.0' }, { versionNegotiation: { mode: 'legacy' } });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    t.after(async () => { await client.close(); await server.close(); globalThis.fetch = originalFetch; });
    let calls = 0, mode = 'interrupted';
    globalThis.fetch = async (input, init) => {
        calls++;
        assert.equal(new URL(input).origin, 'https://api.nstdata.io');
        assert.equal(init.redirect, 'manual');
        assert.ok(init.signal instanceof AbortSignal);
        if (mode === 'json') return new Response('private-body fixture-token');
        if (mode === 'valid') return Response.json({ code: 200, err: false, data: { status: 'processing' } });
        let chunks = 0;
        return new Response(new ReadableStream({ pull(controller) {
            if (chunks++ === 0) controller.enqueue(new TextEncoder().encode('{"code":'));
            else controller.error(new TypeError('private-body fixture-token'));
        } }));
    };
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    for (const request of [
        { name: 'nstdata_crawl_scrape', arguments: { url: 'https://target.invalid/', mode: 'sync' } },
        { name: 'nstdata_crawl_status', arguments: { crawlId: 'existing' } },
    ]) {
        const before = calls;
        const result = await client.callTool(request);
        assert.equal(result.isError, true);
        assert.equal(result.structuredContent.error.code, 'UPSTREAM_ERROR');
        assert.equal(result.structuredContent.error.statusCode, undefined);
        assert.doesNotMatch(JSON.stringify(result), /private-body|fixture-token|JSON/);
        assert.equal(calls, before + 1);
    }
    mode = 'json';
    const invalid = await client.callTool({ name: 'nstdata_crawl_status', arguments: { crawlId: 'existing' } });
    assert.equal(invalid.isError, true);
    assert.equal(invalid.structuredContent.error.code, 'UPSTREAM_ERROR');
    assert.equal(invalid.structuredContent.error.statusCode, 200);
    assert.doesNotMatch(JSON.stringify(invalid), /private-body|fixture-token/);
    mode = 'valid';
    const next = await client.callTool({ name: 'nstdata_crawl_status', arguments: { crawlId: 'existing' } });
    assert.equal(next.isError, false);
    assert.equal(next.structuredContent.status, 'processing');
    assert.equal(calls, 4);
    assert.equal((await client.listTools()).tools.length, 6);
});
