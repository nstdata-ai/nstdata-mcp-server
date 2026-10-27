import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { harness, envelope, json } from '../test/helpers.mjs';
import { checkMarkdown, shellCommands } from './documentation.mjs';
import { checkDocumentedSetup } from './check-documentation.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nstdata-mcp-package-'));
const npmCli = process.env.npm_execpath;
assert.ok(npmCli, 'Run through npm run check:package');
const cleanEnvironment = { ...process.env };
for (const key of Object.keys(cleanEnvironment)) if (/^npm_config_|^NSTDATA_/i.test(key)) delete cleanEnvironment[key];
fs.writeFileSync(path.join(temp, 'user.npmrc'), '');
fs.writeFileSync(path.join(temp, 'global.npmrc'), '');
Object.assign(cleanEnvironment, { npm_config_userconfig: path.join(temp, 'user.npmrc'),
    npm_config_globalconfig: path.join(temp, 'global.npmrc'), npm_config_offline: 'true',
    npm_config_ignore_scripts: 'true', npm_config_audit: 'false', npm_config_fund: 'false',
    npm_config_fetch_retries: '0', npm_config_update_notifier: 'false' });
const npm = (args, cwd) => execFileSync(process.execPath, [npmCli, ...args], { cwd, env: cleanEnvironment, encoding: 'utf8', timeout: 60000 });
const cleanup = [];
try {
    let packed, archive;
    if (process.argv[2]) {
        archive = path.resolve(process.argv[2]);
        const paths = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8', timeout: 10000 }).trim().split('\n');
        const types = execFileSync('tar', ['-tvzf', archive], { encoding: 'utf8', timeout: 10000 }).trim().split('\n');
        assert.ok(types.every(line => line.startsWith('-')), 'Archive must contain only regular files');
        assert.ok(paths.every(name => name.startsWith('package/')), 'Unexpected archive prefix');
        packed = { name: '@nstdata-ai/mcp-server', filename: path.basename(archive), files: paths.map(name => ({ path: name.slice(8) })) };
    } else {
        npm(['run', 'build'], root);
        [packed] = JSON.parse(npm(['pack', '--ignore-scripts', '--json', '--pack-destination', temp], root));
        archive = path.join(temp, packed.filename);
    }
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
    assert.equal(packed.name, '@nstdata-ai/mcp-server');
    if (packed.version !== undefined) assert.equal(packed.version, manifest.version);
    assert.equal(lock.version, manifest.version);
    assert.equal(lock.packages[''].version, manifest.version);
    assert.equal(manifest.dependencies['@nstdata-ai/crawl'], '2.0.0');
    assert.equal(manifest.dependencies['@nstdata-ai/proxy-checker'], '1.1.0');
    assert.deepEqual(lock.packages['node_modules/@nstdata-ai/proxy-checker'].dependencies ?? {}, {});
    assert.deepEqual(lock.packages['node_modules/@nstdata-ai/proxy-checker'].peerDependenciesMeta,
        { '@nstdata-ai/ip-lookup': { optional: true } });
    assert.equal(lock.packages['node_modules/@nstdata-ai/ip-lookup'], undefined);
    assert.equal(lock.packages['node_modules/@nstdata-ai/crawl'].version, manifest.dependencies['@nstdata-ai/crawl']);
    for (const file of ['README.md', 'README_zh.md']) {
        assert.deepEqual(shellCommands(fs.readFileSync(path.join(root, file), 'utf8'))[0], ['npm', 'install', manifest.name]);
    }
    assert.ok(fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8').split('\n').includes(`## ${manifest.version}`), 'Missing version in changelog');
    assert.doesNotMatch(JSON.stringify(manifest) + JSON.stringify(lock), /file:|_planning/);
    const required = ['package.json', 'README.md', 'README_zh.md', 'LICENSE', 'CHANGELOG.md', 'CONTRIBUTING.md', 'SECURITY.md',
        'docs/mcp.md', 'docs/mcp_zh.md', 'docs/proxy.md', 'docs/proxy_zh.md'];
    for (const source of ['config', 'server', 'stdio', 'modules/crawl', 'modules/crawl-schema', 'modules/crawl-result', 'shared/errors', 'shared/output', 'modules/proxy']) {
        required.push(`dist/${source}.js`, `dist/${source}.d.ts`);
    }
    assert.deepEqual(packed.files.map(file => file.path).sort(), required.sort());
    for (const file of packed.files) {
        assert.deepEqual(execFileSync('tar', ['-xOzf', archive, `package/${file.path}`], { timeout: 10000 }), fs.readFileSync(path.join(root, file.path)), `Archive differs from checkout: ${file.path}`);
        const content = fs.readFileSync(path.join(root, file.path), 'utf8');
        assert.doesNotMatch(content, /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----|\bnpm_[a-zA-Z0-9]{30,}\b|\bgh[pousr]_[a-zA-Z0-9]{20,}\b|\/Users\/|_planning\//);
        if (!file.path.endsWith('.md')) continue;
        checkMarkdown(content, file.path);
        for (const match of content.matchAll(/\[[^\]\n]+\]\(([^)\n]+)\)/g)) {
            if (/^[a-z]+:/i.test(match[1])) continue;
            const [relative, anchor] = match[1].split('#');
            const linked = path.posix.normalize(path.posix.join(path.posix.dirname(file.path), relative || path.posix.basename(file.path)));
            assert.ok(required.includes(linked), `Unpackaged documentation link: ${file.path} -> ${match[1]}`);
            if (anchor) {
                const headings = [...fs.readFileSync(path.join(root, linked), 'utf8').matchAll(/^#+ (.+)$/gm)]
                    .map(value => value[1].toLowerCase().replace(/[^\p{L}\p{N}_ -]/gu, '').replace(/ /g, '-'));
                assert.ok(headings.includes(decodeURIComponent(anchor)), `Missing anchor: ${match[1]}`);
            }
        }
    }
    const jsonBlocks = name => [...fs.readFileSync(path.join(root, name), 'utf8').matchAll(/```json\n([\s\S]*?)```/g)].map(block => JSON.parse(block[1]));
    const configs = [['README.md', 'docs/proxy.md'], ['README_zh.md', 'docs/proxy_zh.md']].map(names => {
        const all = names.flatMap(jsonBlocks).filter(value => value.mcpServers);
        assert.equal(all.length, 2);
        assert.equal(all[1].mcpServers.nstdata.env.NSTDATA_MODULES, 'proxy');
        return all;
    });
    assert.deepEqual(configs[0], configs[1]);
    const examples = ['docs/mcp.md', 'docs/mcp_zh.md'].map(name => jsonBlocks(name).filter(value => value.name));
    assert.deepEqual(examples[0], examples[1]);
    assert.equal(examples[0].length, 3);
    assert.deepEqual(['README.md', 'docs/proxy.md'].flatMap(name => [...fs.readFileSync(path.join(root, name), 'utf8').matchAll(/```sh\n([\s\S]*?)```/g)].map(value => value[1])),
        ['README_zh.md', 'docs/proxy_zh.md'].flatMap(name => [...fs.readFileSync(path.join(root, name), 'utf8').matchAll(/```sh\n([\s\S]*?)```/g)].map(value => value[1])));
    for (const language of configs) for (const representation of language) {
        assert.equal(representation.mcpServers.nstdata.command, 'npx');
        assert.deepEqual(representation.mcpServers.nstdata.args, ['--yes', `${manifest.name}@${manifest.version}`]);
    }
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
    npm(['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--no-save', archive], temp);
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
    await checkDocumentedSetup({ root, temp, archive, manifest, lock, files: required, configs, environment: cleanEnvironment, npm });
    for (const requests of examples) for (const era of ['legacy', 'modern']) {
        const h = await harness({ after: fn => cleanup.push(fn) }, (req, res) => {
            if (req.url.startsWith('/api/v1/crawl/storage/read')) { res.end('# Documented fixture'); return; }
            if (req.url === '/api/v1/crawl/scrape') return json(res, envelope({ status: 'completed', success: true, data: { markdownRef: 'documented-ref' } }));
            if (req.method === 'POST' && req.url === '/api/v1/crawl') return json(res, envelope({ id: 'documented-site', status: 'processing' }));
            if (req.url.includes('/pages')) return json(res, envelope({ data: [{ url: 'https://quotes.toscrape.com/', status: 'completed', data: { markdown: '# Page' } }] }));
            return json(res, envelope({ status: 'completed', completed: 1, total: 1, failed: 0, pending: 0 }));
        }, {}, era, installedCli);
        const [scrape, start, read] = requests;
        const single = await h.client.callTool(scrape);
        assert.equal(single.isError, false);
        assert.equal(single.structuredContent.data.markdownRef, 'documented-ref');
        assert.equal(h.requests.length, 1, 'Serialization must not download the reference');
        const content = await h.client.callTool({ ...read, arguments: { ...read.arguments, ref: single.structuredContent.data.markdownRef } });
        assert.notEqual(content.isError, true);
        assert.equal(content.structuredContent.text, '# Documented fixture');
        assert.equal(content.structuredContent.nextOffset, undefined);
        assert.equal(h.requests[1].url, '/api/v1/crawl/storage/read?st=documented-ref');
        const site = await h.client.callTool(start);
        assert.notEqual(site.isError, true);
        const crawlId = site.structuredContent.id;
        const status = await h.client.callTool({ name: 'nstdata_crawl_status', arguments: { crawlId } });
        assert.equal(status.structuredContent.status, 'completed');
        const page = await h.client.callTool({ name: 'nstdata_crawl_pages', arguments: { crawlId, limit: 1 } });
        assert.equal(page.structuredContent.data[0].url, 'https://quotes.toscrape.com/');
        assert.equal(h.requests.length, 5);
        assert.equal(h.stderr(), '');
    }
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
    const installedTests = fs.readdirSync(path.join(root, 'test')).filter(name => name.endsWith('.test.mjs') && !['documentation.test.mjs', 'release.test.mjs', 'startup.test.mjs'].includes(name)).sort()
        .map(name => path.join(root, 'test', name));
    execFileSync(process.execPath, ['--test', ...installedTests], { cwd: temp,
        env: { ...cleanEnvironment, NSTDATA_TEST_CLI: installedCli }, timeout: 60000, stdio: 'inherit' });
    console.log(`PASS: ${manifest.name}@${manifest.version}; ${packed.files.length} files; allowlist/basic secret scan, paired offline install, ESM/public types, bilingual actual npm/npx startup templates with zero business requests, installed CLI Crawl+Proxy legacy/modern success; all installed tests, bilingual documented workflows and packaged links`);
} finally {
    for (const close of cleanup.reverse()) await close();
    fs.rmSync(temp, { recursive: true, force: true });
}
