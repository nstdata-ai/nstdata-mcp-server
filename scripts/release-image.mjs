import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkContainer } from './check-container.mjs';
import { checkEnvironment } from './release.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const digestPattern = /^sha256:[a-f0-9]{64}$/;

function command(program, args, options = {}) {
    try {
        return execFileSync(program, args, { cwd: root, encoding: 'utf8', timeout: 120000,
            maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], ...options });
    } catch {
        throw Object.assign(new Error(`${program} ${args[0]} failed; inspect this stage before another dispatch`),
            { code: 'IMAGE_RELEASE_COMMAND_FAILED' });
    }
}

export function imageReference(env, run = command) {
    assert.equal(env.GITHUB_EVENT_NAME, 'workflow_dispatch', 'Manual dispatch required');
    assert.equal(env.GITHUB_REPOSITORY, 'nstdata-ai/nstdata-mcp-server', 'Wrong repository');
    assert.equal(env.GITHUB_REF, 'refs/heads/main', 'Image publication must use main');
    assert.match(env.IMAGE_RELEASE_COMMIT ?? '', /^[a-f0-9]{40}$/, 'Full reviewed commit required');
    assert.equal(env.IMAGE_RELEASE_COMMIT, env.GITHUB_SHA, 'Reviewed commit must match workflow commit');
    assert.equal(run('git', ['rev-parse', 'HEAD']).trim(), env.GITHUB_SHA, 'Checkout differs from reviewed commit');
    assert.equal(run('git', ['status', '--porcelain', '--untracked-files=no']).trim(), '', 'Tracked source must be clean');
    const repository = env.MCP_IMAGE_REPOSITORY ?? '';
    assert(repository.length <= 255 && /^[a-z0-9]+(?:[.-][a-z0-9]+)*(?::[1-9][0-9]{0,4})?\/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*$/.test(repository),
        'MCP_IMAGE_REPOSITORY must be a registry/repository without a scheme, tag or digest');
    const registry = repository.split('/')[0];
    const port = registry.split(':')[1];
    assert(registry.includes('.') || port || registry === 'localhost', 'Registry must be an explicit hostname, not a Docker Hub namespace');
    assert(!port || Number(port) <= 65535, 'Registry port is invalid');
    return `${repository}:sha-${env.GITHUB_SHA}-amd64`;
}

function inspect(image, run) {
    const records = JSON.parse(run('docker', ['image', 'inspect', image]));
    assert(Array.isArray(records) && records.length === 1, 'Expected one local image');
    const [record] = records;
    assert.match(record.Id ?? '', digestPattern, 'Invalid local image identity');
    assert.equal(`${record.Os}/${record.Architecture}`, 'linux/amd64', 'Expected Linux AMD64 image');
    return record;
}

function normalizedRepository(repository) {
    const name = repository.replace(/^(?:docker\.io|index\.docker\.io)\//, '');
    const first = name.split('/')[0];
    return first.includes('.') || first.includes(':') || first === 'localhost' ? name
        : 'docker.io/' + (name.includes('/') ? name : 'library/' + name);
}

export async function prepareImage(directory, env, { run = command, check = checkContainer, fetchImpl } = {}) {
    const image = imageReference(env, run);
    await checkEnvironment(env, fetchImpl, 'container-production');
    run('docker', ['buildx', 'build', '--platform', 'linux/amd64', '--load', '--file', 'Dockerfile.remote',
        '--tag', image, '--label', `org.opencontainers.image.revision=${env.GITHUB_SHA}`, '.'],
    { timeout: 900000, stdio: ['ignore', 'inherit', 'inherit'] });
    const built = inspect(image, run);
    assert.equal(built.Config?.Labels?.['org.opencontainers.image.revision'], env.GITHUB_SHA, 'Image revision differs');
    await check(image);
    assert.equal(inspect(image, run).Id, built.Id, 'Image changed during checks');
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(directory, 'image.json'), JSON.stringify({ image, id: built.Id, commit: env.GITHUB_SHA }) + '\n', { mode: 0o600 });
    fs.appendFileSync(env.GITHUB_OUTPUT, `registry=${env.MCP_IMAGE_REPOSITORY.split('/')[0]}\n`);
}

export async function publishImage(directory, env, { run = command, fetchImpl } = {}) {
    const image = imageReference(env, run);
    await checkEnvironment(env, fetchImpl, 'container-production');
    const checked = JSON.parse(fs.readFileSync(path.join(directory, 'image.json'), 'utf8'));
    assert.equal(checked.image, image, 'Prepared image reference differs');
    assert.equal(checked.commit, env.GITHUB_SHA, 'Prepared image commit differs');
    assert.equal(inspect(image, run).Id, checked.id, 'Image changed after checks');
    console.log('Pushing the checked image once. If interrupted, inspect the registry before another dispatch.');
    run('docker', ['push', image], { timeout: 600000 });
    console.log('Image push completed. Recording the local repository digest; publication will not be retried.');
    const pushed = inspect(image, run);
    assert.equal(pushed.Id, checked.id, 'Local image changed during publication');
    const digests = [...new Set((pushed.RepoDigests ?? []).flatMap(value => {
        if (typeof value !== 'string') return [];
        const [repository, digest, extra] = value.split('@');
        return extra === undefined && digestPattern.test(digest ?? '') &&
            normalizedRepository(repository) === normalizedRepository(env.MCP_IMAGE_REPOSITORY) ? [digest] : [];
    }))];
    assert.equal(digests.length, 1, 'Push completed but its digest is unavailable; inspect the registry before further action');
    const reference = `${env.MCP_IMAGE_REPOSITORY}@${digests[0]}`;
    fs.appendFileSync(env.GITHUB_OUTPUT, `image=${reference}\n`);
    fs.appendFileSync(env.GITHUB_STEP_SUMMARY, `## Remote image published\n\nSource: \`${env.GITHUB_SHA}\`\n\nPlatform: \`linux/amd64\`\n\nTag: \`${image}\`\n\nDeploy by digest: \`${reference}\`\n\nNo deployment was performed.\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        assert(process.argv.length === 4 && ['prepare', 'publish'].includes(process.argv[2]),
            'Usage: node scripts/release-image.mjs <prepare|publish> <directory>');
        const directory = path.resolve(process.argv[3]);
        await (process.argv[2] === 'prepare' ? prepareImage : publishImage)(directory, process.env);
    } catch (error) {
        console.error(['ERR_ASSERTION', 'IMAGE_RELEASE_COMMAND_FAILED'].includes(error.code) ? error.message : 'Image release failed at this stage.');
        console.error('Stopped without an automatic retry. Inspect the failed stage and registry before another dispatch.');
        process.exitCode = 1;
    }
}
