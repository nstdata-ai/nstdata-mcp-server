import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { remoteCli as executable } from '../helpers.mjs';
import test from 'node:test';

const run = args => spawnSync(process.execPath, [executable, ...args], { encoding: 'utf8', timeout: 5000,
    env: { PATH: process.env.PATH, NODE_OPTIONS: process.env.NODE_OPTIONS, NSTDATA_API_TOKEN: 'unused-fixture-token' } });

test('Remote help and invalid arguments never need configuration or a network', () => {
    const help = run(['--help']);
    assert.equal(help.status, 0); assert.equal(help.stderr, '');
    assert.match(help.stdout, /--config <absolute-path>/);
    for (const args of [[], ['--check'], ['--help', '--check'], ['--config', '/unused', '--check', '--check'], ['secret-argument']]) {
        const result = run(args);
        assert.equal(result.status, 2); assert.equal(result.stdout, '');
        assert.equal(result.stderr, 'Unsupported arguments. Use --help for usage.\n');
    }
});

test('Remote check validates a protected config without contacting its Redis socket', t => {
    const directory = fs.mkdtempSync(path.join(tmpdir(), 'mcp-remote-cli-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const key = () => randomBytes(32).toString('base64url');
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const config = { issuerUrl: 'http://127.0.0.1:45891', listen: { host: '127.0.0.1', port: 45891 },
        redis: { socketPath: path.join(directory, 'absent.sock'), namespace: 'cli_fixture' },
        clients: [{ clientId: 'fixture', clientSecret: key(), redirectUris: ['http://127.0.0.1:45892/callback'] }],
        cookieKeys: [key()], jwks: { keys: [{ ...privateKey.export({ format: 'jwk' }), kid: 'fixture', use: 'sig', alg: 'ES256' }] },
        encryptionKeys: { fixture: key() }, currentKeyId: 'fixture', fingerprintKey: key() };
    const filename = path.join(directory, 'remote.json');
    fs.writeFileSync(filename, JSON.stringify(config), { mode: 0o600 });
    const checked = run(['--config', filename, '--check']);
    assert.equal(checked.status, 0, checked.stderr);
    assert.equal(checked.stderr, ''); assert.match(checked.stdout, /No connection was attempted/);
    const failed = run(['--config', filename]);
    assert.equal(failed.status, 1); assert.equal(failed.stdout, '');
    assert.equal(failed.stderr, 'Remote service unavailable. Check the protected configuration, TLS files and Redis availability.\n');
    assert.equal(fs.existsSync(config.redis.socketPath), false);
    fs.writeFileSync(filename, '{"token":"secret-fixture-value",');
    const invalid = run(['--config', filename, '--check']);
    assert.equal(invalid.status, 1); assert.doesNotMatch(invalid.stderr, /secret-fixture-value|token|remote\.json/);
});
