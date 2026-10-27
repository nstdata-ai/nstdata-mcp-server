import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
const __dirname = fileURLToPath(new URL('.', import.meta.url));
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { validateSource, checkEnvironment, verifyArtifact, checkPackage, checkRegistry, request, hash } from '../scripts/release.mjs';

const commit = 'a'.repeat(40);
const env = { GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REPOSITORY: 'nstdata-ai/nstdata-mcp-server', GITHUB_REF: 'refs/heads/main',
    GITHUB_SHA: commit, RELEASE_COMMIT: commit, RELEASE_VERSION: '1.0.1', GH_TOKEN: 'fixture-token' };
const pkg = { name: '@nstdata-ai/mcp-server', version: '1.0.1', repository: { url: 'git+https://github.com/nstdata-ai/nstdata-mcp-server.git' }, publishConfig: { access: 'public', registry: 'https://registry.npmjs.org' } };
const response = (data, status = 200) => ({ status, json: async () => data });
const environment = { can_admins_bypass: false,
    protection_rules: [{ type: 'required_reviewers', reviewers: [{ type: 'User' }] }],
    deployment_branch_policy: { custom_branch_policies: true, protected_branches: false } };
const policies = { total_count: 1, branch_policies: [{ name: 'main', type: 'branch' }] };

test('release identity requires a manually dispatched reviewed main commit and stable matching version', () => {
    validateSource(env, pkg);
    for (const [key, value] of Object.entries({ GITHUB_EVENT_NAME: 'push', GITHUB_REPOSITORY: 'other/nstdata-mcp-server', GITHUB_REF: 'refs/heads/feature',
        RELEASE_COMMIT: 'b'.repeat(40), RELEASE_VERSION: '1.0.1-rc.1' })) {
        assert.throws(() => validateSource({ ...env, [key]: value }, pkg));
    }
    assert.throws(() => validateSource({ ...env, RELEASE_COMMIT: 'aaaaaaa' }, pkg));
    assert.throws(() => validateSource(env, { ...pkg, version: '1.0.2' }));
    assert.throws(() => validateSource(env, { ...pkg, publishConfig: { access: 'restricted', registry: 'https://registry.npmjs.org' } }));
    assert.throws(() => validateSource(env, { ...pkg, publishConfig: { access: 'public', registry: 'https://other.invalid' } }));
    assert.throws(() => validateSource(env, { ...pkg, repository: { url: 'https://github.com/other/repo' } }));
});

test('release environment requires configured reviewers and only the main branch', async () => {
    const calls = [];
    await checkEnvironment(env, async (url, options) => {
        calls.push(url);
        assert.equal(options.headers.Authorization, 'Bearer fixture-token');
        assert.equal(options.redirect, 'error');
        assert.ok(options.signal instanceof AbortSignal);
        return response(calls.length === 1 ? environment : policies);
    });
    assert.equal(calls.length, 2);
    assert.ok(calls[1].endsWith('/deployment-branch-policies?per_page=100'));
    for (const invalid of [{}, { ...environment, can_admins_bypass: true },
        { ...environment, can_admins_bypass: undefined },
        { ...environment, protection_rules: [] }, { ...environment, protection_rules: [{ type: 'required_reviewers', reviewers: [] }] },
        { ...environment, deployment_branch_policy: { protected_branches: true } }]) {
        await assert.rejects(checkEnvironment(env, async url => response(
            url.includes('/deployment-branch-policies?') ? policies : invalid,
        )));
    }
    for (const invalid of [{ total_count: 2, branch_policies: policies.branch_policies },
        { total_count: 1, branch_policies: [{ name: '*', type: 'branch' }] },
        { total_count: 1, branch_policies: [{ name: 'main', type: 'tag' }] }]) {
        let count = 0;
        await assert.rejects(checkEnvironment(env, async () => response(++count === 1 ? environment : invalid)));
    }
    await assert.rejects(checkEnvironment(env, async () => response({}, 404)));
    await assert.rejects(checkEnvironment({ ...env, GH_TOKEN: '' }, async () => { throw new Error('must not request'); }));
});

test('release artifact binds the checked bytes to the workflow commit, version and manifest digest', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nstdata-release-test-'));
    try {
        const bytes = Buffer.from('fixture archive');
        const manifest = { name: pkg.name, version: pkg.version, commit, filename: 'nstdata-ai-mcp-server-1.0.1.tgz',
            sha256: hash(bytes), integrity: `sha512-${hash(bytes, 'sha512', 'base64')}` };
        const text = JSON.stringify(manifest);
        fs.writeFileSync(path.join(directory, 'manifest.json'), text);
        fs.writeFileSync(path.join(directory, manifest.filename), bytes);
        const settings = { ...env, RELEASE_MANIFEST_SHA256: hash(text) };
        assert.deepEqual(verifyArtifact(directory, settings).manifest, manifest);
        for (const changed of [{ ...settings, GITHUB_SHA: 'b'.repeat(40) }, { ...settings, RELEASE_VERSION: '1.0.2' },
            { ...settings, RELEASE_MANIFEST_SHA256: '0'.repeat(64) }]) assert.throws(() => verifyArtifact(directory, changed));
        fs.writeFileSync(path.join(directory, manifest.filename), 'modified');
        assert.throws(() => verifyArtifact(directory, settings), /Archive changed/);
        const unsafe = JSON.stringify({ ...manifest, filename: '../unexpected.tgz' });
        fs.writeFileSync(path.join(directory, 'manifest.json'), unsafe);
        assert.throws(() => verifyArtifact(directory, { ...settings, RELEASE_MANIFEST_SHA256: hash(unsafe) }));
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('registry checks distinguish an absent version from errors and require exact published integrity', async () => {
    const published = { name: pkg.name, version: pkg.version, dist: { integrity: 'sha512-fixture' } };
    await checkRegistry(pkg.version, undefined, async (url, options) => {
        assert.equal(url, 'https://registry.npmjs.org/%40nstdata-ai%2Fmcp-server/1.0.1');
        assert.deepEqual(options.headers, {});
        return response({}, 404);
    });
    await assert.rejects(checkRegistry(pkg.version, undefined, async () => response(published)), /already exists/);
    await checkRegistry(pkg.version, published.dist.integrity, async () => response(published));
    await assert.rejects(checkRegistry(pkg.version, 'wrong', async () => response(published)), /integrity differs/);
    await assert.rejects(checkRegistry(pkg.version, published.dist.integrity, async () => response({}, 404)), /not visible/);
    for (const status of [401, 403, 429, 500]) {
        let calls = 0;
        await assert.rejects(checkRegistry(pkg.version, undefined, async () => { calls++; return response({}, status); }));
        assert.equal(calls, 1);
    }
    await assert.rejects(request('https://fixture.invalid', undefined, async () => { throw new Error('network unavailable'); }));
    await assert.rejects(request('https://fixture.invalid', undefined, async () => ({ status: 200, json: async () => { throw new Error('invalid JSON'); } })));
});

test('publish CLI uses one checked archive without retries and preserves safe failure diagnostics', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nstdata-release-cli-'));
    try {
        const current = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
        const bytes = Buffer.from('fixture archive');
        const manifest = { name: current.name, version: current.version, commit, filename: `nstdata-ai-mcp-server-${current.version}.tgz`,
            sha256: hash(bytes), integrity: `sha512-${hash(bytes, 'sha512', 'base64')}` };
        const text = JSON.stringify(manifest);
        fs.writeFileSync(path.join(directory, 'manifest.json'), text);
        fs.writeFileSync(path.join(directory, manifest.filename), bytes);
        const log = path.join(directory, 'commands.jsonl');
        const bin = path.join(directory, 'bin');
        fs.mkdirSync(bin);
        fs.writeFileSync(path.join(bin, 'git'), `#!${process.execPath}\nconsole.log('${commit}');\n`, { mode: 0o755 });
        fs.writeFileSync(path.join(bin, 'npm'), `#!${process.execPath}
            const fs=require('node:fs'),path=require('node:path');
            const args=process.argv.slice(2);
            fs.appendFileSync(process.env.RELEASE_TEST_LOG,JSON.stringify(args)+'\\n');
            if(args[0]==='publish' && process.env.RELEASE_TEST_FAIL==='1') {
                console.error('npm error code E403\\nfixture-secret-must-not-appear');process.exit(1);
            }
            if(args[0]==='install') {
                const folder=path.join(process.cwd(),'node_modules/@nstdata-ai/mcp-server');fs.mkdirSync(folder,{recursive:true});
                fs.writeFileSync(path.join(folder,'package.json'),JSON.stringify({name:'${manifest.name}',version:process.env.RELEASE_TEST_STALE_LATEST==='1'?'0.0.0':'${manifest.version}',type:'module',exports:{'.':'./dist/server.js'}}));
                fs.mkdirSync(path.join(folder,'dist'),{recursive:true});
                fs.writeFileSync(path.join(folder,'dist/server.js'),'export function createServer(){};export function loadConfig(){};');
                fs.writeFileSync(path.join(folder,'dist/stdio.js'),${JSON.stringify('import(' + JSON.stringify(new URL('../dist/stdio.js', import.meta.url).href) + ');')});
            }
        `, { mode: 0o755 });
        const preload = path.join(directory, 'network.cjs');
        fs.writeFileSync(preload, `
            const fs=require('node:fs');
            globalThis.fetch=async url=>{
                let data,status=200;
                if(url.includes('/deployment-branch-policies?')) data=${JSON.stringify(policies)};
                else if(url==='https://api.github.com/repos/nstdata-ai/nstdata-mcp-server/environments/npm-production') data=${JSON.stringify(environment)};
                else if(url==='https://registry.npmjs.org/%40nstdata-ai%2Fmcp-server/${manifest.version}') {
                    const done=fs.existsSync(process.env.RELEASE_TEST_LOG);
                    status=done?200:404;data=${JSON.stringify({ name: manifest.name, version: manifest.version, dist: { integrity: manifest.integrity } })};
                } else throw new Error('Unexpected network request');
                return {status,json:async()=>data};
            };
        `);
        for (const [failure, staleLatest] of [[false, false], [true, false], [false, true]]) {
            fs.rmSync(log, { force: true });
            const result = spawnSync(process.execPath, ['--require', preload, path.resolve(__dirname, '../scripts/release.mjs'), 'publish', directory], {
                env: { ...process.env, ...env, RELEASE_VERSION: manifest.version, PATH: `${bin}${path.delimiter}${process.env.PATH}`, NODE_AUTH_TOKEN: '', NPM_TOKEN: '',
                    RELEASE_MANIFEST_SHA256: hash(text), RELEASE_TEST_LOG: log, RELEASE_TEST_FAIL: failure ? '1' : '0',
                    RELEASE_TEST_STALE_LATEST: staleLatest ? '1' : '0', GITHUB_STEP_SUMMARY: path.join(directory, 'summary.md') },
                encoding: 'utf8', timeout: 15000,
            });
            assert.equal(result.status, failure || staleLatest ? 1 : 0, result.stderr);
            const commands = fs.readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
            assert.deepEqual(commands[0], ['publish', path.join(directory, manifest.filename), '--access', 'public', '--registry',
                'https://registry.npmjs.org', '--ignore-scripts', '--provenance', '--tag', 'latest', '--fetch-retries=0']);
            assert.equal(commands.filter(args => args[0] === 'publish').length, 1);
            assert.equal(commands.length, failure ? 1 : 2);
            if (!failure) assert.equal(commands[1][1], current.name, 'Verify the documented default npm install, not only a pinned version');
            if (failure) {
                assert.match(result.stderr, /npm publish failed \(exit 1, E403\)/);
                assert.ok(!result.stderr.includes('fixture-secret-must-not-appear'));
            }
            if (staleLatest) assert.match(result.stderr, /0\.0\.0/);
        }
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});


test('trusted publishing refuses unavailable package metadata before the first automated release', async () => {
    await checkPackage(async (url, options) => {
        assert.equal(url, 'https://registry.npmjs.org/%40nstdata-ai%2Fmcp-server/latest');
        assert.deepEqual(options.headers, {});
        return response({ name: pkg.name });
    });
    await assert.rejects(checkPackage(async () => response({}, 404)), /first reviewed release/);
    await assert.rejects(checkPackage(async () => response({ name: 'other' })), /Unexpected package/);
    await assert.rejects(checkPackage(async () => response({}, 403)), /Unexpected HTTP status/);
});

test('invalid release commands and missing output directory fail before external work', () => {
    for (const args of [[], ['unexpected', '/tmp/unused-release'], ['prepare']]) {
        const result = spawnSync(process.execPath, [path.resolve(__dirname, '../scripts/release.mjs'), ...args], {
            encoding: 'utf8', timeout: 3000,
            env: { PATH: process.env.PATH },
        });
        assert.equal(result.status, 1);
        assert.match(result.stderr, /Use prepare or publish|Release directory required/);
    }
});

test('prepare checks the exact packed archive before writing its approval manifest', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nstdata-release-prepare-'));
    try {
        const current = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
        const filename = `nstdata-ai-mcp-server-${current.version}.tgz`;
        const bytes = Buffer.from('synthetic prepared archive');
        const bin = path.join(directory, 'bin');
        fs.mkdirSync(bin);
        fs.writeFileSync(path.join(bin, 'git'), `#!${process.execPath}\nconsole.log('${commit}');\n`, { mode: 0o755 });
        fs.writeFileSync(path.join(bin, 'npm'), `#!${process.execPath}
            const fs=require('node:fs'),path=require('node:path');
            const args=process.argv.slice(2);
            fs.appendFileSync(process.env.RELEASE_TEST_LOG,JSON.stringify(args)+'\\n');
            if(args[0]==='pack') {
                const output=args[args.indexOf('--pack-destination')+1];
                fs.writeFileSync(path.join(output,'${filename}'),${JSON.stringify(bytes.toString())});
                console.log(JSON.stringify([{name:'${current.name}',version:'${current.version}',filename:'${filename}',integrity:'sha512-${hash(bytes, 'sha512', 'base64')}'}]));
            } else if(args[0]==='run' && args[1]==='check:package' && fs.existsSync(args[3])) {
                if(process.env.RELEASE_TEST_FAIL==='1')process.exit(1);
            } else process.exit(2);
        `, { mode: 0o755 });
        const preload = path.join(directory, 'network.cjs');
        fs.writeFileSync(preload, `
            globalThis.fetch=async url=>{
                let status=200,data;
                if(url.includes('/deployment-branch-policies?'))data=${JSON.stringify(policies)};
                else if(url==='https://api.github.com/repos/nstdata-ai/nstdata-mcp-server/environments/npm-production')data=${JSON.stringify(environment)};
                else if(url==='https://registry.npmjs.org/%40nstdata-ai%2Fmcp-server/latest') {
                    status=process.env.RELEASE_TEST_UNAVAILABLE==='1'?404:200;data={name:'${current.name}'};
                } else if(url==='https://registry.npmjs.org/%40nstdata-ai%2Fmcp-server/${current.version}')status=404;
                else throw new Error('Unexpected request');
                return {status,json:async()=>data};
            };
        `);
        for (const mode of ['success', 'check-failed', 'unavailable']) {
            const output = path.join(directory, mode);
            fs.mkdirSync(output);
            const log = path.join(output, 'commands.jsonl');
            const settings = { ...process.env, ...env, RELEASE_VERSION: current.version,
                PATH: `${bin}${path.delimiter}${process.env.PATH}`, RELEASE_TEST_LOG: log,
                RELEASE_TEST_FAIL: mode === 'check-failed' ? '1' : '0', RELEASE_TEST_UNAVAILABLE: mode === 'unavailable' ? '1' : '0',
                GITHUB_OUTPUT: path.join(output, 'outputs'), GITHUB_STEP_SUMMARY: path.join(output, 'summary') };
            const result = spawnSync(process.execPath, ['--require', preload, path.resolve(__dirname, '../scripts/release.mjs'), 'prepare', output], {
                env: settings, encoding: 'utf8', timeout: 10000,
            });
            assert.equal(result.status, mode === 'success' ? 0 : 1, result.stderr);
            if (mode === 'unavailable') {
                assert.ok(!fs.existsSync(log));
                assert.match(result.stderr, /first reviewed release/);
            } else {
                const commands = fs.readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
                assert.deepEqual(commands, [
                    ['pack', '--ignore-scripts', '--json', '--pack-destination', output],
                    ['run', 'check:package', '--', path.join(output, filename)],
                ]);
            }
            assert.equal(fs.existsSync(path.join(output, 'manifest.json')), mode === 'success');
            if (mode === 'success') {
                const manifest = fs.readFileSync(path.join(output, 'manifest.json'));
                assert.equal(fs.readFileSync(settings.GITHUB_OUTPUT, 'utf8'), `manifest_sha256=${hash(manifest)}\n`);
                assert.equal(verifyArtifact(output, { ...settings, RELEASE_MANIFEST_SHA256: hash(manifest) }).manifest.integrity,
                    `sha512-${hash(bytes, 'sha512', 'base64')}`);
                assert.match(fs.readFileSync(settings.GITHUB_STEP_SUMMARY, 'utf8'), /Package ready for approval/);
            } else assert.ok(!fs.existsSync(settings.GITHUB_OUTPUT));
        }
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
