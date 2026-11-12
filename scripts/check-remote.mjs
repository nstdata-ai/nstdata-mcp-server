import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const sources = ['api-key-auth', 'api-key-verifier', 'client-metadata', 'config', 'consent-page', 'http-handler', 'modules/crawl-result', 'modules/crawl-schema',
    'modules/crawl', 'modules/proxy', 'oauth-provider', 'oauth-resource', 'redis/credential-store',
    'redis/provider-adapter', 'redis/shared', 'remote-config', 'remote-handler', 'remote-request', 'remote-service', 'remote',
    'server', 'shared/errors', 'shared/output'];
const artifactFiles = ['package.json', 'package-lock.json', 'docs/remote.md', 'docs/remote_zh.md',
    ...sources.map(name => `dist/${name}.js`)].sort();
const privateContent = /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----|\bnpm_[a-zA-Z0-9]{30,}\b|\bgh[pousr]_[a-zA-Z0-9]{20,}\b|\/(?:Users|home)\/|_planning\//;

function filesIn(directory, omitDependencies = false) {
    const files = [];
    function visit(relative) {
        for (const entry of fs.readdirSync(path.join(directory, relative), { withFileTypes: true })) {
            if (!relative && omitDependencies && entry.name === 'node_modules') continue;
            const name = path.posix.join(relative, entry.name);
            assert(!entry.isSymbolicLink(), `Unexpected symbolic link: ${name}`);
            if (entry.isDirectory()) visit(name);
            else { assert(entry.isFile(), `Unexpected non-file: ${name}`); files.push(name); }
        }
    }
    visit('');
    return files.sort();
}

export function verifyRemoteManifest(manifest, lock, local) {
    assert.equal(manifest.name, '@nstdata-ai/mcp-server-remote');
    assert.equal(manifest.private, true, 'Remote must remain private and unpublishable');
    assert.equal(manifest.version, local.version);
    assert.equal(manifest.type, 'module');
    assert.deepEqual(manifest.engines, { node: '^22.18.0 || ^24.11.0' });
    assert.deepEqual(Object.keys(manifest).filter(key => !['name', 'version', 'private', 'description', 'type', 'license', 'engines', 'dependencies'].includes(key)), [], 'Unexpected Remote manifest fields');
    assert.deepEqual(manifest.dependencies, { ...local.dependencies, '@redis/client': '6.3.1', 'oidc-provider': '9.13.3' });
    assert.equal(lock.lockfileVersion, 3);
    assert.equal(lock.name, manifest.name); assert.equal(lock.version, manifest.version);
    assert.equal(lock.packages[''].name, manifest.name); assert.equal(lock.packages[''].version, manifest.version);
    assert.deepEqual(lock.packages[''].dependencies, manifest.dependencies);
    assert.deepEqual(lock.packages[''].engines, manifest.engines);
    assert(!lock.packages[''].devDependencies && !lock.packages[''].workspaces);
    for (const [name, version] of Object.entries(manifest.dependencies)) {
        assert.equal(lock.packages[`node_modules/${name}`]?.version, version, `Direct dependency version differs: ${name}`);
    }
    for (const [location, entry] of Object.entries(lock.packages)) {
        if (!location) continue;
        assert(/^node_modules\/(?:@[^/]+\/)?[^/]+(?:\/node_modules\/(?:@[^/]+\/)?[^/]+)*$/.test(location) &&
            !location.split('/').some(part => part === '.' || part === '..') && !location.includes('\\'), 'Invalid locked package path');
        assert(!entry.dev && !entry.link && !entry.inBundle, `Non-runtime dependency: ${location}`);
        assert(/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(entry.version), `Unpinned dependency: ${location}`);
        assert(/^sha512-[A-Za-z0-9+/]{86}==$/.test(entry.integrity), `Missing SHA512 integrity: ${location}`);
        const url = new URL(entry.resolved);
        assert(url.protocol === 'https:' && url.hostname === 'registry.npmjs.org' && !url.port &&
            !url.username && !url.password && !url.search && !url.hash, `Non-registry dependency: ${location}`);
    }
    assert.doesNotMatch(JSON.stringify(manifest) + JSON.stringify(lock), /file:|link:|_planning\//);
}

export function verifyRemoteFiles(directory, expected) {
    assert.deepEqual(filesIn(directory, true), [...expected.keys()].sort(), 'Unexpected Remote artifact files');
    for (const [name, bytes] of expected) {
        const actual = fs.readFileSync(path.join(directory, name));
        assert.deepEqual(actual, bytes, `Artifact bytes differ: ${name}`);
        assert.doesNotMatch(actual.toString('utf8'), privateContent, `Private material in artifact: ${name}`);
    }
}

export function verifyInstalledDependency(application, location, entry, archive, extraction) {
    assert.equal('sha512-' + createHash('sha512').update(fs.readFileSync(archive)).digest('base64'), entry.integrity,
        `Cached archive integrity differs: ${location}`);
    const names = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8', timeout: 10000 }).trim().split('\n');
    const types = execFileSync('tar', ['-tvzf', archive], { encoding: 'utf8', timeout: 10000 }).trim().split('\n');
    assert(types.every(line => line.startsWith('-') || line.startsWith('d')), `Non-regular archive entry: ${location}`);
    assert(names.every(name => /^package(?:\/[^/\r\n\\]+)*\/?$/.test(name) &&
        !name.split('/').some(part => part === '.' || part === '..' || part === 'node_modules')), `Unsafe dependency archive: ${location}`);
    fs.mkdirSync(extraction, { recursive: true });
    execFileSync('tar', ['-xzf', archive, '-C', extraction], { timeout: 10000 });
    const source = path.join(extraction, 'package'), installed = path.join(application, location);
    assert(fs.lstatSync(installed).isDirectory(), `Dependency must be an owned directory: ${location}`);
    assert(fs.realpathSync(installed).startsWith(fs.realpathSync(application) + path.sep + 'node_modules' + path.sep),
        `Dependency escaped the independent artifact: ${location}`);
    const pkg = JSON.parse(fs.readFileSync(path.join(installed, 'package.json'), 'utf8'));
    assert.equal(pkg.version, entry.version, `Dependency version differs: ${location}`);
    assert.equal(pkg.name, location.split('node_modules/').at(-1), `Dependency name differs: ${location}`);
    const expected = filesIn(source);
    assert.deepEqual(filesIn(installed, true), expected, `Unexpected dependency files: ${location}`);
    for (const name of expected) assert.deepEqual(fs.readFileSync(path.join(installed, name)), fs.readFileSync(path.join(source, name)),
        `Dependency bytes differ: ${location}/${name}`);
}

// A process group also owns Redis grandchildren if a bounded test run fails or times out.
async function execute(command, args, options, label, timeout = 60000) {
    return await new Promise((resolve, reject) => {
        const child = spawn(command, args, { ...options, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
        let output = '', errors = '', failure;
        const stop = signal => {
            try { process.platform === 'win32' ? child.kill(signal) : process.kill(-child.pid, signal); }
            catch (error) { if (error.code !== 'ESRCH') failure ??= error; }
        };
        const timer = setTimeout(() => { failure = new Error(`${label} timed out`); stop('SIGKILL'); }, timeout);
        child.on('error', error => { failure = error; });
        for (const [stream, isError] of [[child.stdout, false], [child.stderr, true]]) stream.on('data', bytes => {
            if (isError) errors += bytes; else output += bytes;
            if (output.length + errors.length > 16 * 1024 * 1024) { failure = new Error(`${label} exceeded its output limit`); stop('SIGKILL'); }
        });
        child.once('close', code => {
            clearTimeout(timer); stop('SIGKILL');
            if (failure || code !== 0) reject(new Error(`${label} failed${failure ? `: ${failure.message}` : ` (exit ${code})`}\n${output}\n${errors}`));
            else resolve({ stdout: output, stderr: errors });
        });
    });
}

export async function checkRemote() {
    const npmCli = process.env.npm_execpath;
    assert(npmCli && path.isAbsolute(npmCli), 'Run through npm run check:remote');
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-r-'));
    try {
        const application = path.join(temp, 'application'); fs.mkdirSync(application);
        assert(path.relative(root, application).startsWith('..'), 'Artifact must run outside the source checkout');
        const environment = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot', 'WINDIR']
            .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
        const testTemp = path.join(temp, 't'); fs.mkdirSync(testTemp);
        for (const name of ['user', 'global']) fs.writeFileSync(path.join(temp, `${name}.npmrc`), '');
        Object.assign(environment, { TMPDIR: testTemp, TEMP: testTemp, TMP: testTemp,
            npm_config_userconfig: path.join(temp, 'user.npmrc'),
            npm_config_globalconfig: path.join(temp, 'global.npmrc'), npm_config_offline: 'true',
            npm_config_ignore_scripts: 'true', npm_config_audit: 'false', npm_config_fund: 'false',
            npm_config_fetch_retries: '0', npm_config_update_notifier: 'false' });
        const options = { cwd: application, env: environment };
        const npm = args => execute(process.execPath, [npmCli, ...args], options, 'Offline npm');
        const remote = path.join(root, 'remote');
        const manifest = JSON.parse(fs.readFileSync(path.join(remote, 'package.json'), 'utf8'));
        const lock = JSON.parse(fs.readFileSync(path.join(remote, 'package-lock.json'), 'utf8'));
        verifyRemoteManifest(manifest, lock, JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')));
        assert.deepEqual(filesIn(path.join(remote, 'dist')).map(name => `dist/${name}`), artifactFiles.filter(name => name.startsWith('dist/')), 'Unexpected Remote build files; run build:remote');
        const expected = new Map(artifactFiles.map(name => [name, fs.readFileSync(path.join(name.startsWith('docs/') ? root : remote, name))]));
        for (const [name, bytes] of expected) {
            const target = path.join(application, name); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, bytes);
        }
        verifyRemoteFiles(application, expected);
        const cache = (await npm(['config', 'get', 'cache'])).stdout.trim();
        assert(path.isAbsolute(cache), 'npm cache must be absolute');
        await npm(['ci', '--offline', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund']);
        const installed = JSON.parse(fs.readFileSync(path.join(application, 'node_modules/.package-lock.json'), 'utf8'));
        const dependencies = Object.entries(lock.packages).filter(([name]) => name);
        assert.deepEqual(Object.keys(installed.packages).sort(), dependencies.map(([name]) => name).sort(), 'Installed dependency closure differs from Remote lock');
        for (const [index, [location, entry]] of dependencies.entries()) {
            assert.equal(installed.packages[location].integrity, entry.integrity, `Installed integrity differs: ${location}`);
            assert.equal(installed.packages[location].resolved, entry.resolved, `Installed origin differs: ${location}`);
            const digest = Buffer.from(entry.integrity.slice(7), 'base64').toString('hex');
            const archive = path.join(cache, '_cacache/content-v2/sha512', digest.slice(0, 2), digest.slice(2, 4), digest.slice(4));
            verifyInstalledDependency(application, location, entry, archive, path.join(temp, `archive-${index}`));
        }
        verifyRemoteFiles(application, expected);
        const cli = path.join(application, 'dist/remote.js');
        const guard = path.join(temp, 'no-network.cjs');
        fs.writeFileSync(guard, "require('node:net').Socket.prototype.connect=function(){throw new Error('Artifact CLI checks prohibit network connections')};globalThis.fetch=async()=>{throw new Error('Artifact CLI checks prohibit fetch')};\n");
        const cliOptions = { ...options, env: { ...environment, NODE_OPTIONS: `--require=${JSON.stringify(guard)}` } };
        const help = await execute(process.execPath, [cli, '--help'], cliOptions, 'Remote help', 10000);
        assert.equal(help.stderr, ''); assert.match(help.stdout, /--config <absolute-path>/);
        const key = () => randomBytes(32).toString('base64url');
        const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
        const config = { issuerUrl: 'http://127.0.0.1:45891', listen: { host: '127.0.0.1', port: 45891 },
            redis: { socketPath: path.join(temp, 'absent.sock'), namespace: 'artifact_fixture' },
            clients: [{ clientId: 'fixture', clientSecret: key(), redirectUris: ['http://127.0.0.1:45892/callback'] }],
            cookieKeys: [key()], jwks: { keys: [{ ...privateKey.export({ format: 'jwk' }), kid: 'fixture', use: 'sig', alg: 'ES256' }] },
            encryptionKeys: { fixture: key() }, currentKeyId: 'fixture', fingerprintKey: key() };
        const filename = path.join(temp, 'remote.json'); fs.writeFileSync(filename, JSON.stringify(config), { mode: 0o600 });
        const checked = await execute(process.execPath, [cli, '--config', filename, '--check'], cliOptions, 'Remote configuration check', 10000);
        assert.equal(checked.stderr, ''); assert.match(checked.stdout, /No connection was attempted/);
        assert.equal(fs.existsSync(config.redis.socketPath), false);
        const unitTests = fs.readdirSync(path.join(root, 'test/remote')).filter(name => name.endsWith('.test.mjs')).sort()
            .map(name => path.join(root, 'test/remote', name));
        assert(unitTests.length >= 10, 'Remote unit suites are missing');
        const testOptions = { ...options, env: { ...environment, NSTDATA_REMOTE_TEST_CLI: cli } };
        const unitResult = await execute(process.execPath, ['--test', ...unitTests], testOptions, 'Installed Remote unit tests');
        process.stdout.write(unitResult.stdout); process.stderr.write(unitResult.stderr);
        const integrations = ['redis', 'remote', 'remote-service', 'automatic-onboarding', 'client-registration'].map(name => path.join(root, `test/integration/${name}.test.mjs`));
        const integrationResult = await execute(process.execPath, ['--test', ...integrations], testOptions, 'Installed Remote isolated Redis integration tests');
        process.stdout.write(integrationResult.stdout); process.stderr.write(integrationResult.stderr);
        verifyRemoteFiles(application, expected);
        console.log(`PASS: ${manifest.name}@${manifest.version}; private independent artifact, ${artifactFiles.length} allowlisted files, ${dependencies.length} SHA512-verified offline runtime packages with exact file bytes; help/check without network; ${unitTests.length} Remote unit suites and all ${integrations.length} isolated Redis/loopback integration suites`);
    } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await checkRemote();
