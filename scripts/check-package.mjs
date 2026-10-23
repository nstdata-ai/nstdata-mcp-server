import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { harness, envelope, json } from '../test/helpers.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nstdata-mcp-package-'));
const npmCli = process.env.npm_execpath;
assert.ok(npmCli, 'Run through npm run check:package');
const npm = (args, cwd) => execFileSync(process.execPath, [npmCli, ...args], { cwd, encoding: 'utf8', timeout: 60000 });
const cleanup = [];
try {
    npm(['run', 'build'], root);
    const [packed] = JSON.parse(npm(['pack', '--ignore-scripts', '--json', '--pack-destination', temp], root));
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
    assert.equal(packed.name, '@nstdata-ai/mcp-server');
    assert.equal(packed.version, manifest.version);
    assert.equal(lock.version, manifest.version);
    assert.equal(lock.packages[''].version, manifest.version);
    assert.equal(manifest.dependencies['@nstdata-ai/crawl'], '2.0.0');
    assert.equal(manifest.dependencies['@nstdata-ai/proxy-checker'], '1.1.0');
    assert.deepEqual(lock.packages['node_modules/@nstdata-ai/proxy-checker'].dependencies ?? {}, {});
    assert.equal(lock.packages['node_modules/@nstdata-ai/crawl'].version, manifest.dependencies['@nstdata-ai/crawl']);
    for (const file of ['README.md', 'README_zh.md']) {
        assert.ok(fs.readFileSync(path.join(root, file), 'utf8').includes(`npm install ${manifest.name}@${manifest.version}`), `Missing versioned installation command in ${file}`);
    }
    assert.ok(fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8').includes(`## ${manifest.version} —`), 'Missing version in changelog');
    assert.doesNotMatch(JSON.stringify(manifest) + JSON.stringify(lock), /file:|_planning/);
    const required = ['package.json', 'README.md', 'README_zh.md', 'LICENSE', 'CHANGELOG.md', 'CONTRIBUTING.md', 'docs/mcp.md', 'docs/proxy.md'];
    for (const source of ['config', 'server', 'stdio', 'modules/crawl', 'modules/crawl-schema', 'modules/crawl-result', 'shared/errors', 'shared/output', 'modules/proxy']) {
        required.push(`dist/${source}.js`, `dist/${source}.d.ts`);
    }
    assert.deepEqual(packed.files.map(file => file.path).sort(), required.sort());
    for (const file of packed.files) {
        const content = fs.readFileSync(path.join(root, file.path), 'utf8');
        assert.doesNotMatch(content, /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----|\bnpm_[a-zA-Z0-9]{30,}\b|\bgh[pousr]_[a-zA-Z0-9]{20,}\b|\/Users\/|_planning\//);
    }
    const configs = ['README.md', 'README_zh.md'].map(name => {
        const match = fs.readFileSync(path.join(root, name), 'utf8').match(/```json\n([\s\S]*?)```/);
        assert.ok(match, `Missing client JSON template in ${name}`);
        const all = [...fs.readFileSync(path.join(root, name), 'utf8').matchAll(/```json\n([\s\S]*?)```/g)].map(block => JSON.parse(block[1]));
        assert.equal(all.length, 2);
        assert.equal(all[1].mcpServers.nstdata.env.NSTDATA_MODULES, 'proxy');
        return all;
    });
    assert.deepEqual(configs[0], configs[1]);
    assert.ok(configs[0][0].mcpServers.nstdata.args[0].endsWith(manifest.bin['nstdata-mcp-server']));
    const dependencies = { dependencies: manifest.dependencies, devDependencies: manifest.devDependencies };
    assert.deepEqual(lock.packages[''].dependencies, manifest.dependencies);
    assert.deepEqual(lock.packages[''].devDependencies, manifest.devDependencies);
    fs.writeFileSync(path.join(temp, 'package.json'), JSON.stringify({ private: true, type: 'module', ...dependencies }));
    const installationLock = { ...lock, packages: { ...lock.packages, '': dependencies } };
    delete installationLock.name; delete installationLock.version;
    fs.writeFileSync(path.join(temp, 'package-lock.json'), JSON.stringify(installationLock));
    for (const [name, variable] of [['crawl', 'NSTDATA_SDK_TARBALL'], ['proxy-checker', 'NSTDATA_CHECKER_TARBALL']]) {
        if (!process.env[variable]) continue;
        const archive = path.resolve(process.env[variable]);
        assert.equal('sha512-' + createHash('sha512').update(fs.readFileSync(archive)).digest('base64'),
            lock.packages[`node_modules/@nstdata-ai/${name}`].integrity, `Paired ${name} archive differs from lock`);
        npm(['cache', 'add', archive, '--offline', '--ignore-scripts'], temp);
    }
    npm(['ci', '--offline', '--ignore-scripts', '--no-audit', '--no-fund'], temp);
    npm(['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--no-save', path.join(temp, packed.filename)], temp);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(temp, 'package-lock.json'), 'utf8')), installationLock);
    const installedLock = JSON.parse(fs.readFileSync(path.join(temp, 'node_modules/.package-lock.json'), 'utf8'));
    assert.deepEqual(Object.keys(installedLock.packages).filter(name => name && name !== 'node_modules/@nstdata-ai/mcp-server').sort(), Object.keys(lock.packages).filter(Boolean).sort());
    for (const [name, entry] of Object.entries(lock.packages)) if (name) {
        assert.equal(JSON.parse(fs.readFileSync(path.join(temp, name, 'package.json'), 'utf8')).version, entry.version, name);
        assert.equal(installedLock.packages[name].integrity, entry.integrity, name);
    }
    fs.writeFileSync(path.join(temp, 'check.mjs'), `
        import assert from 'node:assert/strict';
        import { createServer, loadConfig } from '@nstdata-ai/mcp-server';
        const config = loadConfig({ NSTDATA_API_TOKEN: 'fixture-token' });
        assert.equal(config.modules, 'crawl');
        const server = createServer(config);
        await server.close();
    `);
    execFileSync(process.execPath, ['check.mjs'], { cwd: temp, timeout: 10000 });
    fs.writeFileSync(path.join(temp, 'check.mts'), `
        import { createServer, loadConfig, type Config } from '@nstdata-ai/mcp-server';
        const config: Config = loadConfig({ NSTDATA_API_TOKEN: 'fixture-token' });
        const server = createServer(config);
        void server.close();
    `);
    execFileSync(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc'), '--noEmit', '--strict', '--module', 'NodeNext', '--target', 'ES2022', '--types', 'node', '--typeRoots', path.join(root, 'node_modules/@types'), 'check.mts'], { cwd: temp, timeout: 30000 });
    const installedCli = path.join(temp, 'node_modules/@nstdata-ai/mcp-server', manifest.bin['nstdata-mcp-server']);
    assert.ok(fs.existsSync(path.join(temp, 'node_modules/.bin/nstdata-mcp-server')));
    for (const era of ['legacy', 'modern']) {
        const h = await harness({ after: fn => cleanup.push(fn) }, (_req, res) => json(res, envelope({ status: 'completed', success: true, data: { markdown: '# Installed fixture' } })), {}, era, installedCli);
        assert.equal(h.client.getServerVersion()?.version, manifest.version);
        assert.equal((await h.client.listTools()).tools.length, 6);
        const result = await h.client.callTool({ name: 'nstdata_crawl_scrape', arguments: { url: 'https://example.com' } });
        assert.equal(result.isError, false);
        assert.match(JSON.stringify(result), /# Installed fixture/);
        assert.equal(h.requests[0].url, '/api/v1/crawl/scrape');
        assert.equal(h.stderr(), '');
    }
    for (const era of ['legacy', 'modern']) {
        const h = await harness({ after: fn => cleanup.push(fn) }, (_req, res) => res.end('203.0.113.9'), origin => ({
            NSTDATA_MODULES: 'proxy', NSTDATA_API_TOKEN: '', NSTDATA_PROXY_URL: origin,
            NSTDATA_PROXY_CHECK_URL: 'http://check.invalid/ip',
        }), era, installedCli);
        assert.equal(h.client.getServerVersion()?.version, manifest.version);
        assert.equal((await h.client.listTools()).tools.length, 2);
        const result = await h.client.callTool({ name: 'nstdata_proxy_check', arguments: {} });
        assert.equal(result.isError, false);
        assert.equal(result.structuredContent.observedIp, '203.0.113.9');
        assert.equal(h.stderr(), '');
    }
    const redirectChecks = execFileSync(process.execPath, ['--test', '--test-reporter=tap',
        path.join(root, 'test/crawl-redirect.test.mjs')], {
        cwd: root, encoding: 'utf8', timeout: 30000,
        env: { ...process.env, NSTDATA_TEST_CLI: installedCli },
    });
    assert.match(redirectChecks, /# pass 2\b/);
    assert.match(redirectChecks, /# fail 0\b/);
    const optionChecks = execFileSync(process.execPath, ['--test', '--test-reporter=tap',
        path.join(root, 'test/crawl-options.test.mjs')], {
        cwd: root, encoding: 'utf8', timeout: 30000,
        env: { ...process.env, NSTDATA_TEST_CLI: installedCli },
    });
    assert.match(optionChecks, /# pass 6\b/);
    assert.match(optionChecks, /# fail 0\b/);
    const bodyChecks = execFileSync(process.execPath, ['--test', '--test-reporter=tap',
        path.join(root, 'test/crawl-body-error.test.mjs')], {
        cwd: root, encoding: 'utf8', timeout: 15000,
        env: { ...process.env, NSTDATA_TEST_CLI: installedCli },
    });
    assert.match(bodyChecks, /# pass 1\b/);
    assert.match(bodyChecks, /# fail 0\b/);
    const submissionChecks = execFileSync(process.execPath, ['--test', '--test-reporter=tap',
        path.join(root, 'test/submission-outcome.test.mjs')], {
        cwd: root, encoding: 'utf8', timeout: 15000,
        env: { ...process.env, NSTDATA_TEST_CLI: installedCli },
    });
    assert.match(submissionChecks, /# pass 7\b/);
    assert.match(submissionChecks, /# fail 0\b/);
    const contentChecks = execFileSync(process.execPath, ['--test', '--test-reporter=tap',
        path.join(root, 'test/crawl-content.test.mjs')], {
        cwd: root, encoding: 'utf8', timeout: 30000,
        env: { ...process.env, NSTDATA_TEST_CLI: installedCli },
    });
    assert.match(contentChecks, /# pass 12\b/);
    assert.match(contentChecks, /# fail 0\b/);
    const interruptionChecks = execFileSync(process.execPath, ['--test', '--test-reporter=tap',
        path.join(root, 'test/interruption.test.mjs')], {
        cwd: root, encoding: 'utf8', timeout: 15000,
        env: { ...process.env, NSTDATA_TEST_CLI: installedCli },
    });
    assert.match(interruptionChecks, /# pass 2\b/);
    assert.match(interruptionChecks, /# fail 0\b/);
    const deadlineChecks = execFileSync(process.execPath, ['--test', '--test-reporter=tap',
        '--test-name-pattern=a local deadline', path.join(root, 'test/crawl.test.mjs')], {
        cwd: root, encoding: 'utf8', timeout: 15000,
        env: { ...process.env, NSTDATA_TEST_CLI: installedCli },
    });
    assert.match(deadlineChecks, /# pass 1\b/);
    assert.match(deadlineChecks, /# fail 0\b/);
    execFileSync(process.execPath, ['--test', path.join(root, 'test/proxy.test.mjs'), path.join(root, 'test/proxy-tls.test.mjs')], { cwd: temp, env: { ...process.env, NSTDATA_TEST_CLI: installedCli }, timeout: 30000, stdio: 'inherit' });
    console.log(`PASS: ${packed.name}@${packed.version}; ${packed.files.length} files; allowlist/basic secret scan, paired offline install, ESM/public types, bilingual JSON templates, installed CLI Crawl+Proxy legacy/modern success; installed deadline phases, Crawl redirect/body-error and inline/truncation/identity/output-limit/credential checks`);
} finally {
    for (const close of cleanup.reverse()) await close();
    fs.rmSync(temp, { recursive: true, force: true });
}
