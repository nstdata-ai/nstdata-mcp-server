import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { remoteCli } from '../helpers.mjs';

const { isPublicMetadataAddress, metadataUrl, createClientMetadataFetch } = await import(new URL('./client-metadata.js', pathToFileURL(remoteCli)));

test('CIMD destinations exclude private, mapped, transition, multicast and special-use IP ranges', () => {
    for (const address of ['0.1.2.3', '10.0.0.1', '100.64.0.1', '127.0.0.1', '169.254.169.254', '172.31.1.1',
        '192.0.0.1', '192.0.2.1', '192.31.196.1', '192.52.193.1', '192.88.99.1', '192.168.1.1', '192.175.48.1',
        '198.18.1.1', '198.51.100.1', '203.0.113.1', '224.0.0.1', '239.1.1.1', '240.0.0.1', '255.255.255.255',
        '::', '::1', '::ffff:127.0.0.1', '::ffff:8.8.8.8', '64:ff9b::a00:1', '100::1', '2001::1', '2001:db8::1',
        '2002:7f00:1::1', '2620:4f:8000::1', '3fff::1', 'fc00::1', 'fe80::1', 'ff02::1', 'not-an-ip']) {
        assert.equal(isPublicMetadataAddress(address), false, address);
    }
    for (const address of ['1.1.1.1', '8.8.8.8', '93.184.216.34', '2001:4860:4860::8888', '2606:4700:4700::1111']) {
        assert.equal(isPublicMetadataAddress(address), true, address);
    }
});

test('CIMD rejects malformed URLs and unsafe literal destinations before DNS or HTTP', async () => {
    const fetch = createClientMetadataFetch();
    for (const url of ['http://example.com/client', 'https://user:password@example.com/client', 'https://example.com/client#x',
        'https://127.0.0.1/client', 'https://[::1]/client', 'https://[::ffff:127.0.0.1]/client',
        'https://169.254.169.254/client', 'https://example.com:8443/client', 'https://0x7f000001/client']) {
        assert.throws(() => metadataUrl(url));
        await assert.rejects(fetch(url));
    }
    assert.equal(metadataUrl('https://example.com/client.json').hostname, 'example.com');
});

test('native CIMD HTTPS fetch rejects DNS-resolved loopback and cancelled requests without a fallback', async () => {
    const fetch = createClientMetadataFetch();
    await assert.rejects(fetch('https://localhost/client.json'), /^Error: Client metadata unavailable$/);
    await assert.rejects(fetch('https://example.com/client.json', { signal: AbortSignal.abort() }));
    await assert.rejects(fetch('https://example.com/client.json', { method: 'POST' }));
});

// Synthetic HTTPS responses exercise the production fetch composition without external sockets.
// The separate localhost test above uses the native HTTPS/DNS implementation.
const { createRequire, syncBuiltinESMExports } = await import('node:module');
const { EventEmitter } = await import('node:events');
const { PassThrough } = await import('node:stream');
const require = createRequire(import.meta.url);
const https = require('node:https');
async function withTransport(implementation, work) {
    const original = https.request;
    https.request = implementation; syncBuiltinESMExports();
    try { await work(); }
    finally { https.request = original; syncBuiltinESMExports(); }
}
function transport(respond, observations = []) {
    return (url, options, onResponse) => {
        const request = new EventEmitter();
        request.destroyed = false;
        request.destroy = () => {
            if (!request.destroyed) { request.destroyed = true; queueMicrotask(() => request.emit('error', new Error('synthetic closed'))); }
            return request;
        };
        options.signal.addEventListener('abort', () => request.destroy(), { once: true });
        request.end = () => {
            observations.push({ url: String(url), options, request });
            queueMicrotask(() => {
                const socket = new EventEmitter(); socket.remoteAddress = '93.184.216.34';
                request.emit('socket', socket); socket.emit('connect');
                const response = new PassThrough(); response.statusCode = 200; response.headers = {}; response.complete = true;
                if (!request.destroyed) respond(response, () => onResponse(response), options, request);
            });
        };
        return request;
    };
}

test('CIMD fetch buffers one bounded HTTPS response and preserves only metadata cache headers', async () => {
    const requests = [];
    await withTransport(transport((response, ready) => {
        response.headers = { 'content-type': 'application/json', 'cache-control': 'max-age=120', 'set-cookie': 'not-forwarded' };
        ready(); response.end('{"client_id":"https://example.com/client.json"}');
    }, requests), async () => {
        const response = await createClientMetadataFetch()('https://example.com/client.json');
        assert.equal(response.status, 200);
        assert.equal((await response.json()).client_id, 'https://example.com/client.json');
        assert.equal(response.headers.get('cache-control'), 'max-age=120');
        assert.equal(response.headers.get('set-cookie'), null);
        assert.equal(requests.length, 1);
        assert.equal(requests[0].options.agent, false);
        assert.deepEqual(requests[0].options.headers, { Accept: 'application/json', 'Accept-Encoding': 'identity' });
    });
});

test('CIMD fetch rejects redirects, advertised and streamed oversize bodies, and encoded responses', async () => {
    for (const behavior of ['redirect', 'length', 'stream', 'encoding', 'incomplete']) {
        const requests = [];
        await withTransport(transport((response, ready) => {
            if (behavior === 'redirect') { response.statusCode = 302; response.headers.location = 'https://127.0.0.1/private'; }
            if (behavior === 'length') response.headers['content-length'] = '32769';
            if (behavior === 'encoding') response.headers['content-encoding'] = 'gzip';
            if (behavior === 'incomplete') response.complete = false;
            ready();
            if (!response.destroyed) response.end(behavior === 'stream' ? Buffer.alloc(32769) : '{}');
        }, requests), async () => {
            await assert.rejects(createClientMetadataFetch()('https://example.com/client.json'), /^Error: Client metadata unavailable$/);
            assert.equal(requests.length, 1, behavior);
        });
    }
});

test('CIMD actual-socket check rejects a private destination even after nominally public lookup', async () => {
    let request;
    await withTransport((url, options, onResponse) => {
        request = new EventEmitter(); request.destroy = () => { queueMicrotask(() => request.emit('error', new Error('private socket'))); return request; };
        request.end = () => queueMicrotask(() => {
            const socket = new EventEmitter(); socket.remoteAddress = '10.0.0.5';
            request.emit('socket', socket); socket.emit('connect');
        });
        return request;
    }, async () => {
        await assert.rejects(createClientMetadataFetch()('https://example.com/client.json'), /^Error: Client metadata unavailable$/);
    });
});

test('CIMD fetch cancellation and response failure reject without a subsequent success', async () => {
    const requests = [];
    await withTransport(transport((response, ready, options, request) => {
        ready(); response.write('{');
        options.signal.addEventListener('abort', () => response.destroy(new Error('synthetic abort')), { once: true });
    }, requests), async () => {
        const controller = new AbortController();
        const result = createClientMetadataFetch()('https://example.com/client.json', { signal: controller.signal });
        await new Promise(resolve => setImmediate(resolve));
        controller.abort();
        await assert.rejects(result, /^Error: Client metadata unavailable$/);
        assert.equal(requests.length, 1);
        assert.equal(requests[0].request.destroyed, true);
    });
});

test('CIMD native deadline stops a pending response and concurrent work is bounded', { timeout: 5000 }, async () => {
    const requests = [];
    await withTransport(transport(() => {}, requests), async () => {
        const fetch = createClientMetadataFetch();
        const controller = new AbortController();
        const pending = Array.from({ length: 8 }, () => fetch('https://example.com/client.json', { signal: controller.signal }));
        const all = Promise.allSettled(pending);
        await new Promise(resolve => setImmediate(resolve));
        await assert.rejects(fetch('https://example.com/client.json'), /^Error: Client metadata unavailable$/);
        assert.equal(requests.length, 8);
        controller.abort();
        assert((await all).every(value => value.status === 'rejected'));
        const deadline = fetch('https://example.com/client.json');
        // Keep this isolated test alive while the native AbortSignal deadline is pending.
        const hold = setTimeout(() => {}, 3000);
        try { await assert.rejects(deadline, /^Error: Client metadata unavailable$/); }
        finally { clearTimeout(hold); }
        assert.equal(requests.length, 9);
    });
});
