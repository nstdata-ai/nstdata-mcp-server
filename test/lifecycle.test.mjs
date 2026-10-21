import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { cli } from './helpers.mjs';

function launch(t, env) {
    const child = spawn(process.execPath, [cli], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
    const exited = once(child, 'exit');
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    return { child, exited, stdout: () => stdout, stderr: () => stderr };
}

test('invalid configuration exits without writing secrets or nonprotocol stdout', { timeout: 10000 }, async t => {
    for (const override of [{ NSTDATA_API_TOKEN: '' }, { NSTDATA_MODULES: 'proxy' }, { NSTDATA_HTTP_TIMEOUT_MS: 'NaN' }, { NSTDATA_API_BASE_URL: 'https://fixture-token@example.com' }]) {
        const p = launch(t, { NSTDATA_API_TOKEN: 'fixture-token', ...override });
        const [code] = await p.exited;
        assert.equal(code, 1);
        assert.equal(p.stdout(), '');
        assert.match(p.stderr(), /configuration/);
        assert.doesNotMatch(p.stderr(), /fixture-token/);
    }
});

test('invalid Proxy configuration fails startup with sanitized diagnostics', { timeout: 10000 }, async t => {
    for (const override of [
        { NSTDATA_PROXY_URL: 'socks5://fixture-password@127.0.0.1:1080' },
        { NSTDATA_PROXY_URL: 'http://fixture-password@127.0.0.1:80/unexpected' },
        { NSTDATA_PROXY_CHECK_URL: 'file:///etc/passwd' },
        { NSTDATA_PROXY_CA_FILE: '/nonexistent/fixture-password.pem' },
        { NSTDATA_MODULES: 'crawl,proxy' },
    ]) {
        const p = launch(t, { NSTDATA_MODULES: 'proxy', NSTDATA_PROXY_URL: 'http://127.0.0.1:80', NSTDATA_PROXY_CHECK_URL: 'https://example.com', ...override });
        assert.equal((await p.exited)[0], 1);
        assert.equal(p.stdout(), '');
        assert.doesNotMatch(p.stderr(), /fixture-password|nonexistent/);
    }
});

for (const module of ['crawl', 'proxy']) for (const exitMode of ['EOF', 'SIGTERM']) {
    test(`${module} ${exitMode} closes an in-flight HTTP request and exits promptly`, { timeout: 10000 }, async t => {
        let started, disconnected;
        const receiving = new Promise(resolve => { started = resolve; });
        const closed = new Promise(resolve => { disconnected = resolve; });
        const api = http.createServer((_req, res) => {
            res.writeHead(200); res.write('{'); res.on('close', disconnected); started();
        });
        api.listen(0, '127.0.0.1');
        await once(api, 'listening');
        t.after(() => { api.closeAllConnections(); api.close(); });
        const origin = `http://127.0.0.1:${api.address().port}`;
        const p = launch(t, { NSTDATA_MODULES: module, NSTDATA_API_TOKEN: 'fixture-token', NSTDATA_API_BASE_URL: origin,
            NSTDATA_PROXY_URL: origin, NSTDATA_PROXY_CHECK_URL: 'http://target.invalid' });
        const lines = createInterface({ input: p.child.stdout });
        const initialized = once(lines, 'line');
        const send = value => p.child.stdin.write(`${JSON.stringify(value)}\n`);
        send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'lifecycle', version: '1' } } });
        await initialized;
        send({ jsonrpc: '2.0', method: 'notifications/initialized' });
        send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: module === 'crawl' ? { name: 'nstdata_crawl_scrape_result', arguments: { taskId: 'slow' } } : { name: 'nstdata_proxy_fetch', arguments: { url: 'http://target.invalid' } } });
        await receiving;
        if (exitMode === 'EOF') p.child.stdin.end();
        else p.child.kill('SIGTERM');
        await closed;
        const [code] = await p.exited;
        assert.equal(code, 0);
        assert.equal(p.stderr(), '');
        lines.close();
    });
}
