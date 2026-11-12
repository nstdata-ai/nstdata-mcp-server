import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import { once } from 'node:events';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { remoteCli } from '../helpers.mjs';

const executable = pathToFileURL(remoteCli);
const docs = process.env.NSTDATA_REMOTE_TEST_CLI ? new URL('../docs/', executable) : new URL('../../docs/', import.meta.url);
const { loadRemoteConfig } = await import(new URL('./remote-config.js', executable));
const { createOAuthHttpHandler } = await import(new URL('./oauth-resource.js', executable));

test('operator guides generate protected configurations and validate default and custom MCP paths', async t => {
    const directory = fs.mkdtempSync(path.join(tmpdir(), 'mcp-remote-docs-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const pathExamples = [];
    const sources = ['remote.md', 'remote_zh.md'].map(name => {
        const text = fs.readFileSync(new URL(name, docs), 'utf8');
        const examples = [...text.matchAll(/```js\n([\s\S]*?)```/g)];
        assert.equal(examples.length, 1);
        const paths = [...text.matchAll(/```json\n([\s\S]*?)```/g)];
        assert.equal(paths.length, 1);
        pathExamples.push(JSON.parse(paths[0][1]));
        return examples[0][1];
    });
    assert.equal(sources[0], sources[1]);
    for (const example of pathExamples) assert.deepEqual(example, { mcpPath: '/crawl' });
    const script = path.join(directory, 'create-remote-config.mjs');
    fs.writeFileSync(script, sources[0]);
    const configs = [];
    for (const [index] of sources.entries()) {
        const filename = path.join(directory, `remote-${index}.json`);
        const run = () => spawnSync(process.execPath, [script, filename], { encoding: 'utf8', timeout: 10000,
            env: { NODE_OPTIONS: process.env.NODE_OPTIONS } });
        const result = run();
        assert.equal(result.status, 0, result.stderr); assert.equal(result.stderr, '');
        assert.equal(result.stdout, 'Remote configuration created.\n');
        const config = await loadRemoteConfig(filename);
        assert.equal(config.issuerUrl, 'https://mcp.example.com');
        assert.equal(config.mcpPath, '/mcp');
        assert.deepEqual(config.clients, [], 'operator example requires no static client or shared client secret');
        assert.equal(config.tlsTermination, 'ingress');
        assert.equal(config.trustedProxyCidrs, undefined);
        assert.equal(config.listen.tls, undefined);
        assert.equal(config.encryptionKeys['encryption-1'].byteLength, 32);
        assert.equal(config.fingerprintKey.byteLength, 32);
        if (process.platform !== 'win32') assert.equal(fs.statSync(filename).mode & 0o777, 0o600);
        const original = fs.readFileSync(filename);
        const ingressCheck = spawnSync(process.execPath, [fileURLToPath(new URL('./remote.js', executable)), '--config', filename, '--check'],
            { encoding: 'utf8', timeout: 5000, env: { NODE_OPTIONS: process.env.NODE_OPTIONS } });
        assert.equal(ingressCheck.status, 0, ingressCheck.stderr); assert.equal(ingressCheck.stderr, '');
        assert.match(ingressCheck.stdout, /No connection was attempted/);
        assert.deepEqual(fs.readFileSync(filename), original);
        const repeat = run();
        assert.notEqual(repeat.status, 0); assert.equal(repeat.stdout, '');
        assert.deepEqual(fs.readFileSync(filename), original);
        configs.push(JSON.parse(original.toString('utf8')));
        // The same generated configuration is checked by the real CLI in loopback development mode.
        for (const endpoint of [{}, pathExamples[index]]) {
            const local = { ...configs[index], ...endpoint, issuerUrl: 'http://127.0.0.1:45893',
                listen: { host: '127.0.0.1', port: 45893 },
                redis: { socketPath: path.join(directory, 'not-connected.sock'), namespace: 'docs_fixture' } };
            delete local.trustedProxyCidrs;
            delete local.tlsTermination;
            const candidate = Buffer.from(JSON.stringify(local));
            fs.writeFileSync(filename, candidate);
            const loaded = await loadRemoteConfig(filename);
            assert.equal(loaded.mcpPath, endpoint.mcpPath ?? '/mcp');
            const checked = spawnSync(process.execPath, [fileURLToPath(new URL('./remote.js', executable)), '--config', filename, '--check'],
                { encoding: 'utf8', timeout: 5000, env: { NODE_OPTIONS: process.env.NODE_OPTIONS } });
            assert.equal(checked.status, 0, checked.stderr); assert.equal(checked.stderr, '');
            assert.match(checked.stdout, /No connection was attempted/);
            assert.deepEqual(fs.readFileSync(filename), candidate);
        }
    }
    for (const field of ['cookieKeys', 'jwks', 'encryptionKeys', 'fingerprintKey']) assert.notDeepEqual(configs[0][field], configs[1][field]);
});


test('documented API-key discovery command runs unchanged apart from its loopback URL and lists six tools', { timeout: 15000 }, async t => {
    const examples = ['remote.md', 'remote_zh.md'].map(name => {
        const source = fs.readFileSync(new URL(name, docs), 'utf8');
        const blocks = [...source.matchAll(/```sh\n([\s\S]*?)```/g)].map(match => match[1]);
        const commands = blocks.filter(block => block.startsWith("NSTDATA_MCP_URL='"));
        assert.equal(commands.length, 1);
        return commands[0];
    });
    assert.equal(examples[0], examples[1]);
    assert.equal(examples[0].split('https://mcp.example.com/crawl').length, 2, 'replace the only network destination before executing');
    const directory = fs.mkdtempSync(path.join(tmpdir(), 'mcp-docs-curl-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    t.mock.method(globalThis, 'fetch', () => { throw new Error('Documented discovery must not access upstream services'); });
    let handler;
    let verified = 0;
    const server = http.createServer(async (request, response) => {
        try {
            const chunks = [];
            for await (const chunk of request) chunks.push(chunk);
            const result = await handler.fetch(new Request(resourceUrl, {
                method: request.method,
                headers: request.headers,
                body: Buffer.concat(chunks),
            }));
            response.writeHead(result.status, Object.fromEntries(result.headers));
            response.end(Buffer.from(await result.arrayBuffer()));
        } catch {
            response.writeHead(500);
            response.end('Fixture request failed');
        }
    });
    t.after(async () => {
        await handler?.close();
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const origin = `http://127.0.0.1:${server.address().port}`;
    const resourceUrl = `${origin}/crawl`;
    handler = createOAuthHttpHandler({
        resourceUrl, allowedOrigins: [],
        oauthMetadata: {
            issuer: origin, authorization_endpoint: `${origin}/auth`, token_endpoint: `${origin}/token`,
            response_types_supported: ['code'], code_challenge_methods_supported: ['S256'], scopes_supported: ['crawl:use'],
        },
        verifyCredential: async () => { throw new Error('API-key command must not attempt OAuth authentication'); },
        verifyApiKey: async key => {
            verified++;
            return key === 'synthetic-docs-key' ? { subject: 'docs-key-identity', apiToken: key } : null;
        },
    });
    const result = await new Promise((resolve, reject) => {
        const child = spawn('/bin/sh', ['-eu'], { env: {
            PATH: process.env.PATH, CURL_HOME: directory, NSTDATA_API_TOKEN: 'synthetic-docs-key',
        }, stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000, killSignal: 'SIGKILL' });
        let stdout = '', stderr = '';
        child.stdout.on('data', data => { stdout += data; });
        child.stderr.on('data', data => { stderr += data; });
        child.once('error', reject);
        child.once('close', status => resolve({ status, stdout, stderr }));
        child.stdin.end(examples[0].replace('https://mcp.example.com/crawl', resourceUrl));
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.doesNotMatch(result.stdout, /synthetic-docs-key/);
    const rpc = result.stdout.startsWith('event:') || result.stdout.startsWith('data:')
        ? JSON.parse(result.stdout.split('\n').find(line => line.startsWith('data: ')).slice(6))
        : JSON.parse(result.stdout);
    assert.deepEqual(rpc.result.tools.map(tool => tool.name).sort(), [
        'nstdata_crawl_pages', 'nstdata_crawl_read_result', 'nstdata_crawl_scrape',
        'nstdata_crawl_scrape_result', 'nstdata_crawl_start', 'nstdata_crawl_status',
    ]);
    assert.equal(verified, 1);
});
