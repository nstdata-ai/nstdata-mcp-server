import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { remoteCli } from '../helpers.mjs';

const executable = pathToFileURL(remoteCli);
const docs = process.env.NSTDATA_REMOTE_TEST_CLI ? new URL('../docs/', executable) : new URL('../../docs/', import.meta.url);
const { loadRemoteConfig } = await import(new URL('./remote-config.js', executable));

test('both operator guides generate a valid protected configuration without overwriting secrets', async t => {
    const directory = fs.mkdtempSync(path.join(tmpdir(), 'mcp-remote-docs-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const sources = ['remote.md', 'remote_zh.md'].map(name => {
        const text = fs.readFileSync(new URL(name, docs), 'utf8');
        const examples = [...text.matchAll(/```js\n([\s\S]*?)```/g)];
        assert.equal(examples.length, 1);
        return examples[0][1];
    });
    assert.equal(sources[0], sources[1]);
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
        assert.deepEqual(config.trustedProxyCidrs, ['192.0.2.0/24']);
        assert.equal(config.listen.tls, undefined);
        assert.equal(config.encryptionKeys['encryption-1'].byteLength, 32);
        assert.equal(config.fingerprintKey.byteLength, 32);
        if (process.platform !== 'win32') assert.equal(fs.statSync(filename).mode & 0o777, 0o600);
        const original = fs.readFileSync(filename);
        const repeat = run();
        assert.notEqual(repeat.status, 0); assert.equal(repeat.stdout, '');
        assert.deepEqual(fs.readFileSync(filename), original);
        configs.push(JSON.parse(original.toString('utf8')));
        // The same generated configuration is checked by the real CLI in loopback development mode.
        const local = { ...configs[index], issuerUrl: 'http://127.0.0.1:45893',
            listen: { host: '127.0.0.1', port: 45893 },
            redis: { socketPath: path.join(directory, 'not-connected.sock'), namespace: 'docs_fixture' } };
        delete local.trustedProxyCidrs;
        fs.writeFileSync(filename, JSON.stringify(local));
        const checked = spawnSync(process.execPath, [fileURLToPath(new URL('./remote.js', executable)), '--config', filename, '--check'],
            { encoding: 'utf8', timeout: 5000, env: { NODE_OPTIONS: process.env.NODE_OPTIONS } });
        assert.equal(checked.status, 0, checked.stderr); assert.equal(checked.stderr, '');
        assert.match(checked.stdout, /No connection was attempted/);
    }
    for (const field of ['cookieKeys', 'jwks', 'encryptionKeys', 'fingerprintKey']) assert.notDeepEqual(configs[0][field], configs[1][field]);
});
