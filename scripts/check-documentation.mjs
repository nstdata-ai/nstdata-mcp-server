import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { shellCommands, clientConfigurations } from './documentation.mjs';
import { verifyStartup } from './check-startup.mjs';

const execute = promisify(execFile);
const crawlTools = ['nstdata_crawl_scrape', 'nstdata_crawl_scrape_result', 'nstdata_crawl_start',
    'nstdata_crawl_status', 'nstdata_crawl_pages', 'nstdata_crawl_read_result'];
const proxyTools = ['nstdata_proxy_fetch', 'nstdata_proxy_check'];

function ownFiles(directory) {
    return fs.readdirSync(directory, { recursive: true })
        .filter(file => file.split(path.sep)[0] !== 'node_modules' && fs.statSync(path.join(directory, file)).isFile()).sort();
}

export function verifyRuntimePackages(application, entries) {
    const verified = new Map(entries.map(entry => [`${entry.manifest.name}\0${entry.manifest.version}`, entry.source]));
    const installedLock = JSON.parse(fs.readFileSync(path.join(application, 'node_modules/.package-lock.json'), 'utf8'));
    // A fresh npm install may hoist valid versions differently from the source lock.
    for (const location of Object.keys(installedLock.packages)) {
        assert.ok(location.startsWith('node_modules/') && !location.split('/').includes('..'), 'Invalid installed package path');
        const module = path.join(application, location);
        const pkg = JSON.parse(fs.readFileSync(path.join(module, 'package.json'), 'utf8'));
        const source = verified.get(`${pkg.name}\0${pkg.version}`);
        assert.ok(source, `Unverified runtime package: ${pkg.name}@${pkg.version}`);
        const files = ownFiles(source);
        assert.deepEqual(ownFiles(module), files, `Unexpected package files: ${pkg.name}@${pkg.version}`);
        for (const file of files) assert.deepEqual(fs.readFileSync(path.join(module, file)), fs.readFileSync(path.join(source, file)),
            `Package bytes differ: ${pkg.name}@${pkg.version}/${file}`);
    }
}

export async function checkDocumentedSetup({ root, temp, archive, manifest, lock, files, configs, environment, npm }) {
    const fixtures = path.join(temp, 'registry-fixtures'); fs.mkdirSync(fixtures);
    const entries = [{ manifest, archive, filename: 'mcp.tgz', source: path.join(temp, 'node_modules', manifest.name) }];
    for (const [name, entry] of Object.entries(lock.packages)) {
        if (!name || entry.dev) continue;
        const installed = path.join(temp, name);
        const pkg = JSON.parse(fs.readFileSync(path.join(installed, 'package.json'), 'utf8'));
        const variable = pkg.name === '@nstdata-ai/crawl' ? 'NSTDATA_SDK_TARBALL'
            : pkg.name === '@nstdata-ai/proxy-checker' ? 'NSTDATA_CHECKER_TARBALL' : undefined;
        let dependencyArchive = variable && process.env[variable] ? path.resolve(process.env[variable]) : undefined;
        if (!dependencyArchive) {
            const staging = path.join(fixtures, `package-${entries.length}`);
            for (const file of ownFiles(installed)) {
                const target = path.join(staging, 'package', file);
                fs.mkdirSync(path.dirname(target), { recursive: true });
                fs.copyFileSync(path.join(installed, file), target);
                fs.chmodSync(target, fs.statSync(path.join(installed, file)).mode & 0o777);
            }
            dependencyArchive = path.join(fixtures, `dependency-${entries.length}.tgz`);
            execFileSync('tar', ['-czf', dependencyArchive, '-C', staging, 'package'], { timeout: 10000 });
        }
        entries.push({ manifest: pkg, archive: dependencyArchive, filename: `dependency-${entries.length}.tgz`, source: installed });
    }
    const registryRequests = [];
    const registry = http.createServer((req, res) => {
        const pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
        registryRequests.push({ method: req.method, pathname, authorization: Boolean(req.headers.authorization) });
        if (req.method !== 'GET' || req.headers.authorization) { res.writeHead(403); res.end(); return; }
        const metadata = entries.filter(entry => pathname === '/' + entry.manifest.name);
        const tarball = entries.find(entry => pathname === '/' + entry.filename);
        if (metadata.length) {
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ name: metadata[0].manifest.name,
                'dist-tags': { latest: metadata.at(-1).manifest.version }, versions: Object.fromEntries(metadata.map(entry => [entry.manifest.version, {
                    ...entry.manifest, dist: {
                        integrity: 'sha512-' + createHash('sha512').update(fs.readFileSync(entry.archive)).digest('base64'),
                        tarball: `http://127.0.0.1:${registry.address().port}/${entry.filename}`,
                    },
                }])) }));
        } else if (tarball) { res.setHeader('Content-Type', 'application/octet-stream'); res.end(fs.readFileSync(tarball.archive)); }
        else { res.writeHead(404); res.end(); }
    });
    const freshApplications = [];
    let businessRequests = 0;
    const api = http.createServer((_req, res) => { businessRequests++; res.writeHead(500); res.end(); });
    registry.listen(0, '127.0.0.1'); api.listen(0, '127.0.0.1');
    try {
        await Promise.all([once(registry, 'listening'), once(api, 'listening')]);
        const guard = path.join(temp, 'loopback-only.cjs');
        fs.writeFileSync(guard, `const net=require('node:net');
const connect=net.Socket.prototype.connect;
net.Socket.prototype.connect=function(...args){
 const options=Array.isArray(args[0])?args[0][0]:args[0];
 const host=typeof options==='object'?options.host:args[1];
 if(host!=='127.0.0.1')throw Object.assign(new Error('Only loopback is allowed during installation checks'),{code:'DOCS_NETWORK_BLOCKED'});
 return Reflect.apply(connect,this,args);
};\n`);
        const env = { ...environment, npm_config_offline: 'false',
            npm_config_registry: `http://127.0.0.1:${registry.address().port}`, NODE_OPTIONS: `--require=${JSON.stringify(guard)}` };
        await execute(process.execPath, ['-e', "require('node:assert/strict').throws(()=>require('node:net').connect({host:'198.51.100.1',port:80}),{code:'DOCS_NETWORK_BLOCKED'})"], { env, timeout: 10000 });
        const origin = `http://127.0.0.1:${api.address().port}`;
        for (const [index, readme] of ['README.md', 'README_zh.md'].entries()) {
            const application = path.join(temp, 'documented-install-' + index); fs.mkdirSync(application);
            fs.writeFileSync(path.join(application, 'package.json'), '{"private":true,"type":"module"}');
            const localEnv = { ...env, npm_config_cache: path.join(application, 'cache') };
            const commands = shellCommands(fs.readFileSync(path.join(root, readme), 'utf8'));
            assert.deepEqual(commands, [['npm', 'install', manifest.name],
                ['npx', '--yes', manifest.name, '--help'], ['npx', '--yes', manifest.name, '--version']]);
            await execute(process.execPath, [process.env.npm_execpath, ...commands[0].slice(1)], { cwd: application, env: localEnv, timeout: 60000 });
            for (const command of commands.slice(1)) {
                const { stdout, stderr } = await execute(command[0], command.slice(1), { cwd: application, env: localEnv, timeout: 10000 });
                assert.equal(stderr, '');
                if (command.at(-1) === '--version') assert.equal(stdout, `${manifest.version}\n`);
                else assert.match(stdout, /Usage: nstdata-mcp-server/);
                assert.equal(businessRequests, 0, 'CLI information must not call a business API');
            }
            const installed = path.join(application, 'node_modules', manifest.name);
            for (const file of files) assert.deepEqual(fs.readFileSync(path.join(installed, file)), fs.readFileSync(path.join(temp, 'node_modules', manifest.name, file)));
            verifyRuntimePackages(application, entries);
            assert.equal(fs.existsSync(path.join(application, 'node_modules/@nstdata-ai/ip-lookup')), false);
            const [crawl, proxy] = configs[index].map(value => value.mcpServers.nstdata);
            const combined = { ...crawl, env: { ...crawl.env, ...proxy.env, NSTDATA_MODULES: 'crawl,proxy' } };
            for (const config of [crawl, proxy, combined]) {
                assert.equal(config.command, 'npx');
                assert.deepEqual(config.args, ['--yes', `${manifest.name}@${manifest.version}`]);
                const before = registryRequests.length;
                await verifyStartup({ command: config.command, args: config.args, cwd: application,
                    env: { ...localEnv, ...config.env, NSTDATA_API_TOKEN: config.env.NSTDATA_MODULES.includes('crawl') ? 'fixture-token' : '',
                        NSTDATA_API_BASE_URL: origin, NSTDATA_PROXY_URL: origin, NSTDATA_PROXY_CHECK_URL: origin },
                    version: manifest.version, toolNames: config.env.NSTDATA_MODULES.split(',').flatMap(module => module === 'crawl' ? crawlTools : proxyTools) });
                assert.equal(registryRequests.length, before, 'Installed npx must not resolve another package');
                assert.equal(businessRequests, 0, 'Startup/discovery must not call a business API');
            }
            const reference = fs.readFileSync(path.join(root, index ? 'docs/mcp_zh.md' : 'docs/mcp.md'), 'utf8');
            const clients = clientConfigurations(reference);
            assert.equal(clients.length, 3);
            for (const config of clients) {
                assert.equal(config.command, 'npx');
                assert.deepEqual(config.args, ['--yes', `${manifest.name}@${manifest.version}`]);
                assert.equal(config.env.NSTDATA_API_TOKEN, 'YOUR_CRAWL_API_TOKEN');
                const before = registryRequests.length;
                await verifyStartup({ command: config.command, args: config.args, cwd: application,
                    env: { ...localEnv, ...config.env, NSTDATA_API_TOKEN: 'fixture-token',
                        NSTDATA_API_BASE_URL: origin }, version: manifest.version, toolNames: crawlTools });
                assert.equal(registryRequests.length, before, 'Documented client configuration must use the installed package');
                assert.equal(businessRequests, 0, 'Client configuration discovery must not call a business API');
            }
            const fresh = fs.mkdtempSync(path.join(tmpdir(), 'nstdata-mcp-first-use-'));
            freshApplications.push(fresh);
            assert.deepEqual(fs.readdirSync(fresh), [], 'First-use npx starts outside the installed project');
            const freshEnvironment = { ...env, ...crawl.env, npm_config_cache: path.join(fresh, 'cache'),
                NSTDATA_API_TOKEN: 'fixture-token', NSTDATA_API_BASE_URL: origin };
            const beforeFirstUse = registryRequests.length;
            await verifyStartup({ command: crawl.command, args: crawl.args, cwd: fresh,
                env: freshEnvironment, version: manifest.version, toolNames: crawlTools, timeoutMs: 30000 });
            assert.ok(registryRequests.slice(beforeFirstUse).some(request => request.pathname === '/mcp.tgz'),
                'First-use npx must install the checked package into its empty cache');
            assert.equal(fs.existsSync(path.join(fresh, 'node_modules')), false,
                'First-use npx must not require project installation');
            assert.equal(businessRequests, 0, 'First-use npx discovery must not call a business API');
        }
        for (const request of registryRequests) {
            assert.equal(request.method, 'GET'); assert.equal(request.authorization, false);
            assert.ok(request.pathname === '/@nstdata-ai/ip-lookup' || entries.some(entry =>
                ['/' + entry.manifest.name, '/' + entry.filename].includes(request.pathname)), 'Unexpected registry request');
        }
        assert.ok(registryRequests.some(request => request.pathname === '/mcp.tgz'));
    } finally {
        await Promise.all([registry, api].map(server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); })));
        for (const application of freshApplications) fs.rmSync(application, { recursive: true, force: true });
    }
}
