import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { localContext, verifyImageConfig, verifyInventory, writeFixtures } from '../../scripts/check-container.mjs';

const context = Host => [{ Name: 'fixture', Endpoints: { docker: { Host } } }];
const image = () => ({ Id: 'sha256:' + 'a'.repeat(64), Os: 'linux', Architecture: 'arm64', Config: { User: 'node:node', WorkingDir: '/app',
    Entrypoint: ['node', 'dist/remote.js'], Env: ['NODE_ENV=production'] } });

function inventory() {
    const manifest = { name: 'fixture', private: true, dependencies: { example: '1.0.0' } };
    const dependency = { version: '1.0.0', integrity: 'sha512-fixture' };
    const lock = { packages: { '': {}, 'node_modules/example': dependency } };
    const hashes = { LICENSE: 'license-hash', 'package.json': 'manifest-hash', 'dist/remote.js': 'application-hash' };
    const report = { uid: 1000, gid: 1000, top: ['LICENSE', 'dist', 'node_modules', 'package.json'], manifest,
        hashes: { 'dist/remote.js': hashes['dist/remote.js'], 'package.json': hashes['package.json'], LICENSE: hashes.LICENSE },
        installed: { 'node_modules/example': { ...dependency } }, files: ['LICENSE', 'package.json', 'dist/remote.js',
            'node_modules/.package-lock.json', 'node_modules/example/package.json'] };
    return { manifest, lock, hashes, report };
}

test('container checks require one local Unix Docker context and reject remote endpoints', () => {
    assert.equal(localContext(context('unix:///tmp/fixture-docker.sock')), 'fixture');
    for (const endpoint of ['tcp://127.0.0.1:2375', 'tcp://remote.invalid:2376', 'ssh://remote.invalid',
        'unix://remote.invalid/tmp/docker.sock', 'unix:///tmp/docker.sock?remote=true']) {
        assert.throws(() => localContext(context(endpoint)), /local Unix Docker endpoint/);
    }
    assert.throws(() => localContext([]), /one context/);
});

test('container checks reject root identity, alternate entrypoints and signal or credential overrides', () => {
    assert.equal(verifyImageConfig(image()), 'linux/arm64');
    assert.equal(verifyImageConfig({ ...image(), Architecture: 'amd64' }), 'linux/amd64');
    for (const change of [value => { value.Config.User = '0:0'; },
        value => { value.Config.Entrypoint = ['node', 'dist/stdio.js']; },
        value => { value.Config.StopSignal = 'SIGKILL'; },
        value => { value.Config.Env.push('NSTDATA_API_TOKEN=synthetic'); },
        value => { value.Os = 'windows'; }, value => { value.Architecture = 'unknown'; }]) {
        const value = image(); change(value); assert.throws(() => verifyImageConfig(value));
    }
});

test('container inventory checks bind app hashes and installed dependency closure to the expected artifact', () => {
    const verify = value => verifyInventory(value.report, value.manifest, value.lock, value.hashes);
    verify(inventory());
    for (const change of [value => { value.report.hashes['dist/remote.js'] = 'tampered'; },
        value => { delete value.report.installed['node_modules/example']; },
        value => { value.report.installed['node_modules/typescript'] = { version: '5.9.3' }; },
        value => { value.report.installed['node_modules/example'].version = '2.0.0'; },
        value => { value.report.installed['node_modules/example'].integrity = 'sha512-changed'; },
        value => { value.report.files.push('src/private.ts'); },
        value => { value.report.files.push('node_modules/untracked/index.js'); }]) {
        const value = inventory(); change(value); assert.throws(() => verify(value));
    }
});

test('container fixtures remain private synthetic loopback files and generated probes parse without Docker', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'container-fixture-test-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    writeFixtures(directory);
    for (const name of fs.readdirSync(directory)) {
        if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(directory, name)).mode & 0o777, 0o600);
    }
    const check = JSON.parse(fs.readFileSync(path.join(directory, 'check.json'), 'utf8'));
    const runtime = JSON.parse(fs.readFileSync(path.join(directory, 'runtime.json'), 'utf8'));
    assert.equal(check.issuerUrl, 'http://127.0.0.1:45891');
    assert.equal(check.redis.socketPath, '/review/absent.sock');
    assert.equal(runtime.redis.url, 'redis://127.0.0.1:45892/0');
    assert.equal(runtime.listen.host, '127.0.0.1');
    for (const name of ['probe.mjs', 'no-network.cjs', 'loopback.cjs']) {
        execFileSync(process.execPath, ['--check', path.join(directory, name)], { timeout: 5000,
            env: { PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'pipe'] });
    }
});
