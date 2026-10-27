import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyStartup } from './check-startup.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const repository = 'nstdata-ai/nstdata-mcp-server';
const name = '@nstdata-ai/mcp-server';
const registry = 'https://registry.npmjs.org';
const hash = (bytes, algorithm = 'sha256', encoding = 'hex') => createHash(algorithm).update(bytes).digest(encoding);
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));

function validateSource(env, pkg) {
    assert.equal(env.GITHUB_EVENT_NAME, 'workflow_dispatch', 'Manual dispatch required');
    assert.equal(env.GITHUB_REPOSITORY, repository, 'Wrong repository');
    assert.equal(env.GITHUB_REF, 'refs/heads/main', 'Release must use main');
    assert.match(env.RELEASE_COMMIT ?? '', /^[a-f0-9]{40}$/, 'Full reviewed commit required');
    assert.equal(env.RELEASE_COMMIT, env.GITHUB_SHA, 'Reviewed commit must match workflow commit');
    assert.match(env.RELEASE_VERSION ?? '', /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, 'Stable version required');
    assert.equal(pkg.version, env.RELEASE_VERSION, 'Version must match package.json');
    assert.equal(pkg.name, name);
    assert.equal(pkg.publishConfig?.access, 'public');
    assert.equal(pkg.publishConfig?.registry, registry);
    assert.equal(pkg.repository?.url, `git+https://github.com/${repository}.git`);
}

async function request(url, token, fetchImpl = globalThis.fetch) {
    const response = await fetchImpl(url, {
        headers: token ? { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10' } : {},
        redirect: 'error', signal: AbortSignal.timeout(20000),
    });
    if (response.status === 404) return { status: 404 };
    assert.equal(response.status, 200, `Unexpected HTTP status ${response.status}`);
    return { status: 200, data: await response.json() };
}

async function checkEnvironment(env, fetchImpl) {
    assert.ok(env.GH_TOKEN, 'GitHub read token required');
    const url = `https://api.github.com/repos/${repository}/environments/npm-production`;
    const result = await request(url, env.GH_TOKEN, fetchImpl);
    assert.equal(result.status, 200, 'Configure npm-production before dispatch');
    const environment = result.data;
    assert.equal(environment.can_admins_bypass, false, 'Disable administrator bypass on npm-production');
    assert.ok(environment.protection_rules?.some(rule => rule.type === 'required_reviewers' && rule.reviewers?.length > 0), 'Required reviewers must be configured');
    assert.equal(environment.deployment_branch_policy?.custom_branch_policies, true, 'Use selected deployment branches');
    assert.equal(environment.deployment_branch_policy?.protected_branches, false);
    const policies = await request(`${url}/deployment-branch-policies?per_page=100`, env.GH_TOKEN, fetchImpl);
    assert.equal(policies.status, 200);
    assert.equal(policies.data.total_count, 1, 'Allow only main deployments');
    assert.equal(policies.data.branch_policies?.length, 1);
    const [policy] = policies.data.branch_policies;
    assert.equal(policy.name, 'main');
    assert.equal(policy.type, 'branch', 'Allow the main branch, not a tag');
}

function verifyArtifact(directory, env) {
    const manifestBytes = fs.readFileSync(path.join(directory, 'manifest.json'));
    assert.equal(hash(manifestBytes), env.RELEASE_MANIFEST_SHA256, 'Manifest changed after checks');
    const manifest = JSON.parse(manifestBytes);
    assert.equal(manifest.commit, env.GITHUB_SHA);
    assert.equal(manifest.version, env.RELEASE_VERSION);
    assert.equal(manifest.name, name);
    assert.equal(manifest.filename, `nstdata-ai-mcp-server-${env.RELEASE_VERSION}.tgz`);
    const archive = path.join(directory, manifest.filename);
    const bytes = fs.readFileSync(archive);
    assert.equal(hash(bytes), manifest.sha256, 'Archive changed after checks');
    assert.equal(`sha512-${hash(bytes, 'sha512', 'base64')}`, manifest.integrity);
    return { manifest, archive };
}

async function checkPackage(fetchImpl) {
    const result = await request(`${registry}/${encodeURIComponent(name)}/latest`, undefined, fetchImpl);
    assert.equal(result.status, 200, 'Package is not publicly available; arrange its first reviewed release before trusted publishing');
    assert.equal(result.data.name, name, 'Unexpected package metadata');
}

async function checkRegistry(version, integrity, fetchImpl) {
    const result = await request(`${registry}/${encodeURIComponent(name)}/${version}`, undefined, fetchImpl);
    if (integrity === undefined) assert.equal(result.status, 404, 'Version already exists; do not republish');
    else {
        assert.equal(result.status, 200, 'Published version not visible; inspect registry before another dispatch');
        assert.equal(result.data.name, name);
        assert.equal(result.data.version, version);
        assert.equal(result.data.dist?.integrity, integrity, 'Published integrity differs');
    }
}

function npm(args, cwd = root) {
    const operation = `npm ${args[0]}${args[0] === 'run' ? ` ${args[1]}` : ''}`;
    console.log(`Running ${operation}`);
    try {
        return execFileSync('npm', args, { cwd, encoding: 'utf8', timeout: 180000, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
        const code = String(error.stderr ?? '').match(/^npm error code ([A-Z][A-Z0-9_]{1,40})\s*$/m)?.[1];
        throw Object.assign(new Error(`${operation} failed (exit ${error.status ?? 'unavailable'}${code ? `, ${code}` : ''}). Inspect this stage before another dispatch.`), { code: 'RELEASE_COMMAND_FAILED' });
    }
}

async function main(mode, directory, env = process.env) {
    assert.ok(['prepare', 'publish'].includes(mode), 'Use prepare or publish');
    assert.ok(typeof directory === 'string' && path.isAbsolute(directory), 'Release directory required');
    validateSource(env, readJson(path.join(root, 'package.json')));
    assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), env.GITHUB_SHA);
    await checkEnvironment(env);
    if (mode === 'prepare') {
        await checkPackage();
        await checkRegistry(env.RELEASE_VERSION);
        fs.mkdirSync(directory, { recursive: true });
        const [packed] = JSON.parse(npm(['pack', '--ignore-scripts', '--json', '--pack-destination', directory]));
        assert.equal(packed.name, name);
        assert.equal(packed.version, env.RELEASE_VERSION);
        assert.equal(packed.filename, `nstdata-ai-mcp-server-${env.RELEASE_VERSION}.tgz`);
        const archive = path.join(directory, packed.filename);
        npm(['run', 'check:package', '--', archive]);
        const bytes = fs.readFileSync(archive);
        const manifest = { name, version: packed.version, commit: env.GITHUB_SHA, filename: packed.filename,
            sha256: hash(bytes), integrity: `sha512-${hash(bytes, 'sha512', 'base64')}` };
        assert.equal(manifest.integrity, packed.integrity);
        const text = JSON.stringify(manifest, null, 2) + '\n';
        fs.writeFileSync(path.join(directory, 'manifest.json'), text);
        fs.appendFileSync(env.GITHUB_OUTPUT, `manifest_sha256=${hash(text)}\n`);
        fs.appendFileSync(env.GITHUB_STEP_SUMMARY, `## Package ready for approval\n\nCommit: \`${manifest.commit}\`\n\nVersion: \`${manifest.version}\`\n\nArchive SHA256: \`${manifest.sha256}\`\n`);
    } else {
        assert.ok(!env.NODE_AUTH_TOKEN && !env.NPM_TOKEN, 'Use trusted publishing without npm tokens');
        const { manifest, archive } = verifyArtifact(directory, env);
        await checkRegistry(manifest.version);
        console.log('Publishing once. If this step fails, inspect npm before another dispatch.');
        npm(['publish', archive, '--access', 'public', '--registry', registry, '--ignore-scripts', '--provenance', '--tag', 'latest', '--fetch-retries=0']);
        await checkRegistry(manifest.version, manifest.integrity);
        const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nstdata-public-install-'));
        try {
            fs.writeFileSync(path.join(temp, 'package.json'), '{"private":true}');
            npm(['install', name, '--registry', registry, '--ignore-scripts', '--no-audit', '--no-fund', '--cache', path.join(temp, 'cache')], temp);
            assert.equal(readJson(path.join(temp, 'node_modules', name, 'package.json')).version, manifest.version);
            execFileSync(process.execPath, ['--input-type=module', '-e', `import assert from 'node:assert/strict';import {createServer,loadConfig} from '${name}';for(const fn of [createServer,loadConfig])assert.equal(typeof fn,'function');`], { cwd: temp, timeout: 10000 });
            await verifyStartup({ command: process.execPath,
                args: [path.join(temp, 'node_modules', name, 'dist/stdio.js')], cwd: temp,
                env: { NSTDATA_MODULES: 'crawl,proxy', NSTDATA_API_TOKEN: 'release-check-token',
                    NSTDATA_API_BASE_URL: 'http://127.0.0.1:1', NSTDATA_PROXY_URL: 'http://127.0.0.1:1',
                    NSTDATA_PROXY_CHECK_URL: 'http://127.0.0.1:1' }, version: manifest.version,
                toolNames: ['nstdata_crawl_scrape', 'nstdata_crawl_scrape_result', 'nstdata_crawl_start',
                    'nstdata_crawl_status', 'nstdata_crawl_pages', 'nstdata_crawl_read_result',
                    'nstdata_proxy_fetch', 'nstdata_proxy_check'] });
        } finally { fs.rmSync(temp, { recursive: true, force: true }); }
        fs.appendFileSync(env.GITHUB_STEP_SUMMARY, `\nPublished \`${name}@${manifest.version}\`; registry integrity and clean public installation passed.\n`);
    }
}

export { validateSource, checkEnvironment, verifyArtifact, checkPackage, checkRegistry, request, hash };
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main(process.argv[2], process.argv[3] && path.resolve(process.argv[3])).catch(error => {
        console.error(['ERR_ASSERTION', 'RELEASE_COMMAND_FAILED'].includes(error.code) ? error.message : `Release operation failed (${error.code ?? error.status ?? 'transport error'}).`);
        console.error('Release stopped. Do not blindly rerun: inspect the failed step and registry version first.');
        process.exitCode = 1;
    });
}
