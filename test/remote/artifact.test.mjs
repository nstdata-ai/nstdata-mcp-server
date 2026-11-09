import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { verifyRemoteManifest, verifyRemoteFiles, verifyInstalledDependency } from '../../scripts/check-remote.mjs';

const local = { version: '1.0.2', engines: { node: '^22.18.0 || ^24.0.0' }, dependencies: { fixture: '1.0.0' } };
function manifests() {
    const manifest = { name: '@nstdata-ai/mcp-server-remote', version: local.version, private: true, type: 'module',
        engines: local.engines, dependencies: { ...local.dependencies, '@redis/client': '6.3.1', 'oidc-provider': '9.13.3' } };
    const lock = { name: manifest.name, version: manifest.version, lockfileVersion: 3, packages: { '': {
        name: manifest.name, version: manifest.version, engines: manifest.engines, dependencies: manifest.dependencies,
    }, ...Object.fromEntries(Object.entries(manifest.dependencies).map(([name, version]) => [`node_modules/${name}`, {
        version, resolved: `https://registry.npmjs.org/${name}/-/fixture.tgz`, integrity: 'sha512-' + Buffer.alloc(64).toString('base64'),
    }])) } };
    return { manifest, lock };
}

test('Remote artifact checks reject publishability, unpinned or externally linked dependencies', () => {
    const { manifest, lock } = manifests();
    verifyRemoteManifest(manifest, lock, local);
    for (const change of [value => { value.manifest.private = false; },
        value => { value.manifest.scripts = { postinstall: 'unexpected' }; },
        value => { value.lock.packages['node_modules/fixture'].integrity = 'sha1-unverified'; },
        value => { value.lock.packages['node_modules/fixture'].resolved = 'file:../fixture'; },
        value => { value.lock.packages['node_modules/fixture'].link = true; },
        value => { value.lock.packages['node_modules/fixture'].version = '2.0.0'; }]) {
        const value = structuredClone({ manifest, lock }); change(value);
        assert.throws(() => verifyRemoteManifest(value.manifest, value.lock, local));
    }
});

test('Remote artifact checks enforce its allowlist, exact bytes and basic private-material scan', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-artifact-check-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const filename = path.join(directory, 'package.json'), bytes = Buffer.from('{"private":true}');
    const expected = new Map([['package.json', bytes]]);
    fs.writeFileSync(filename, bytes); verifyRemoteFiles(directory, expected);
    fs.writeFileSync(path.join(directory, 'local.env'), 'fixture');
    assert.throws(() => verifyRemoteFiles(directory, expected), /Unexpected Remote artifact files/);
    fs.unlinkSync(path.join(directory, 'local.env'));
    fs.writeFileSync(filename, 'changed');
    assert.throws(() => verifyRemoteFiles(directory, expected), /Artifact bytes differ/);
    const privateBytes = Buffer.from('/Users/fixture/private'); fs.writeFileSync(filename, privateBytes);
    assert.throws(() => verifyRemoteFiles(directory, new Map([['package.json', privateBytes]])), /Private material in artifact/);
    fs.unlinkSync(filename); fs.symlinkSync('elsewhere', filename);
    assert.throws(() => verifyRemoteFiles(directory, expected), /Unexpected symbolic link/);
});

test('Remote runtime dependency bytes must match the lock-authenticated archive', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-dependency-check-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const source = path.join(directory, 'source/package'), application = path.join(directory, 'application');
    const installed = path.join(application, 'node_modules/fixture');
    fs.mkdirSync(source, { recursive: true }); fs.mkdirSync(installed, { recursive: true });
    for (const [name, content] of Object.entries({ 'package.json': '{"name":"fixture","version":"1.0.0"}', 'index.js': 'export default 1;' })) {
        fs.writeFileSync(path.join(source, name), content); fs.writeFileSync(path.join(installed, name), content);
    }
    const archive = path.join(directory, 'fixture.tgz');
    execFileSync('tar', ['-czf', archive, '-C', path.dirname(source), 'package'], { timeout: 10000 });
    const entry = { version: '1.0.0', integrity: 'sha512-' + createHash('sha512').update(fs.readFileSync(archive)).digest('base64') };
    const verify = index => verifyInstalledDependency(application, 'node_modules/fixture', entry, archive, path.join(directory, `extracted-${index}`));
    verify(0);
    fs.writeFileSync(path.join(installed, 'index.js'), 'changed');
    assert.throws(() => verify(1), /Dependency bytes differ/);
    fs.writeFileSync(path.join(installed, 'index.js'), 'export default 1;');
    fs.writeFileSync(path.join(installed, 'extra.js'), 'extra');
    assert.throws(() => verify(2), /Unexpected dependency files/);
    fs.appendFileSync(archive, 'changed');
    assert.throws(() => verify(3), /Cached archive integrity differs/);
});
