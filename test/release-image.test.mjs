import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { imageReference, prepareImage, publishImage } from '../scripts/release-image.mjs';

const commit = 'a'.repeat(40), id = 'sha256:' + 'b'.repeat(64), digest = 'sha256:' + 'c'.repeat(64);
const repository = 'registry.invalid/team/remote';
const image = `${repository}:sha-${commit}-amd64`;
const environment = { can_admins_bypass: false,
    protection_rules: [{ type: 'required_reviewers', reviewers: [{ type: 'User' }] }],
    deployment_branch_policy: { custom_branch_policies: true, protected_branches: false } };
const policies = { total_count: 1, branch_policies: [{ name: 'main', type: 'branch' }] };

function fixture(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nstdata-image-release-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const env = { GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REPOSITORY: 'nstdata-ai/nstdata-mcp-server',
        GITHUB_REF: 'refs/heads/main', GITHUB_SHA: commit, IMAGE_RELEASE_COMMIT: commit,
        MCP_IMAGE_REPOSITORY: repository, GH_TOKEN: 'fixture-read-token',
        GITHUB_OUTPUT: path.join(directory, 'output'), GITHUB_STEP_SUMMARY: path.join(directory, 'summary') };
    const state = { commands: [], requests: [], checks: [], inspections: 0, pushed: false };
    const run = (program, args) => {
        state.commands.push([program, ...args]);
        if (program === 'git') return args[0] === 'rev-parse' ? (state.commit ?? commit) + '\n' : state.dirty ?? '';
        assert.equal(program, 'docker');
        if (args[0] === 'buildx') { if (state.buildError) throw new Error('build failed'); return ''; }
        if (args[0] === 'push') {
            assert.equal(state.pushed, false, 'Push must not be retried');
            state.pushed = true;
            if (state.pushError) throw new Error('push failed');
            return '';
        }
        assert.deepEqual(args, ['image', 'inspect', `${env.MCP_IMAGE_REPOSITORY}:sha-${env.GITHUB_SHA}-amd64`]);
        state.inspections++;
        return JSON.stringify([{ Id: state.changeAt === state.inspections ? 'sha256:' + 'd'.repeat(64) : id,
            Os: state.os ?? 'linux', Architecture: state.architecture ?? 'amd64',
            Config: { Labels: { 'org.opencontainers.image.revision': state.revision ?? commit } },
            RepoDigests: state.pushed ? state.digests ?? [repository + '@' + digest] : [] }]);
    };
    const fetchImpl = async (url, options) => {
        assert.equal(state.pushed, false, 'No requests are allowed after push');
        state.requests.push(url);
        assert.equal(options.headers.Authorization, 'Bearer fixture-read-token');
        assert.equal(options.redirect, 'error');
        assert.ok(options.signal instanceof AbortSignal);
        const base = 'https://api.github.com/repos/nstdata-ai/nstdata-mcp-server/environments/container-production';
        assert.ok(url === base || url === base + '/deployment-branch-policies?per_page=100');
        return { status: state.environmentStatus ?? 200, json: async () => url === base ? state.environment ?? environment : state.policies ?? policies };
    };
    const check = async reference => { state.checks.push(reference); if (state.checkError) throw new Error('container check failed'); };
    return { directory, env, state, dependencies: { run, fetchImpl, check } };
}

test('image publication accepts only a manual official main checkout at the reviewed full SHA', t => {
    const { env, state, dependencies } = fixture(t);
    assert.equal(imageReference(env, dependencies.run), image);
    for (const [name, value] of Object.entries({ GITHUB_EVENT_NAME: 'push', GITHUB_REPOSITORY: 'other/server',
        GITHUB_REF: 'refs/tags/v1.0.3', IMAGE_RELEASE_COMMIT: 'a'.repeat(7), GITHUB_SHA: 'b'.repeat(40) })) {
        assert.throws(() => imageReference({ ...env, [name]: value }, dependencies.run));
    }
    state.commit = 'b'.repeat(40);
    assert.throws(() => imageReference(env, dependencies.run), /Checkout differs/);
    state.commit = commit; state.dirty = ' M Dockerfile.remote\n';
    assert.throws(() => imageReference(env, dependencies.run), /Tracked source/);
    assert.equal(state.commands.some(call => call[0] === 'docker'), false);
});

test('registry references reject credentials, tags, digests, controls and invalid ports', t => {
    const { env, dependencies } = fixture(t);
    for (const value of ['', 'https://' + repository, 'user:password@' + repository, repository + ':latest',
        repository + '@' + digest, repository + '\nother=value', '-flag/team/image', 'registry.invalid/a/../image',
        'registry.invalid:65536/a', 'registry.invalid/a;echo', 'registry.invalid/UPPER', 'a'.repeat(256),
        'my-registry/remote', 'my-registry/team/remote']) {
        assert.throws(() => imageReference({ ...env, MCP_IMAGE_REPOSITORY: value }, dependencies.run), value);
    }
    for (const value of ['registry.invalid/image', 'registry.invalid:5000/team/image', 'registry.invalid/team/image__name', 'registry.invalid/team/image--name']) {
        assert.ok(imageReference({ ...env, MCP_IMAGE_REPOSITORY: value }, dependencies.run).startsWith(value + ':sha-'));
    }
});

test('prepare builds AMD64 once and checks that exact image before writing its identity', async t => {
    const { directory, env, state, dependencies } = fixture(t);
    await prepareImage(directory, env, dependencies);
    assert.deepEqual(state.commands.filter(call => call[0] === 'docker' && call[1] === 'buildx'),
        [['docker', 'buildx', 'build', '--platform', 'linux/amd64', '--load', '--file', 'Dockerfile.remote',
            '--tag', image, '--label', `org.opencontainers.image.revision=${commit}`, '.']]);
    assert.deepEqual(state.checks, [image]);
    assert.equal(state.pushed, false);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, 'image.json'))), { image, id, commit });
    assert.equal(fs.statSync(path.join(directory, 'image.json')).mode & 0o777, 0o600);
    assert.equal(fs.readFileSync(env.GITHUB_OUTPUT, 'utf8'), 'registry=registry.invalid\n');
});

test('image preparation and publication require the protected main-only container environment', async t => {
    for (const invalid of [{ environmentStatus: 404 }, { environment: { ...environment, can_admins_bypass: true } },
        { environment: { ...environment, protection_rules: [] } },
        { policies: { total_count: 1, branch_policies: [{ name: 'main', type: 'tag' }] } },
        { policies: { total_count: 2, branch_policies: policies.branch_policies } }]) {
        const { directory, env, state, dependencies } = fixture(t);
        Object.assign(state, invalid);
        await assert.rejects(prepareImage(directory, env, dependencies));
        await assert.rejects(publishImage(directory, env, dependencies));
        assert.equal(state.commands.some(call => call[0] === 'docker'), false);
    }
});

test('build, platform, revision, container and image-identity failures stop before publication', async t => {
    for (const invalid of [{ buildError: true }, { os: 'windows' }, { architecture: 'arm64' },
        { revision: 'b'.repeat(40) }, { checkError: true }, { changeAt: 2 }]) {
        const { directory, env, state, dependencies } = fixture(t);
        Object.assign(state, invalid);
        await assert.rejects(prepareImage(directory, env, dependencies));
        assert.equal(state.pushed, false);
        assert.equal(fs.existsSync(path.join(directory, 'image.json')), false);
    }
});

test('publication pushes the checked image once and reports only its matching repository digest', async t => {
    const { directory, env, state, dependencies } = fixture(t);
    await prepareImage(directory, env, dependencies);
    state.digests = ['other.invalid/team/image@' + digest, repository + '@' + digest];
    await publishImage(directory, env, dependencies);
    assert.deepEqual(state.commands.filter(call => call[0] === 'docker' && call[1] === 'push'), [['docker', 'push', image]]);
    assert.equal(state.commands.filter(call => call[1] === 'buildx').length, 1);
    assert.equal(state.requests.length, 4);
    assert.match(fs.readFileSync(env.GITHUB_OUTPUT, 'utf8'), new RegExp(`image=${repository}@${digest}\\n`));
    const summary = fs.readFileSync(env.GITHUB_STEP_SUMMARY, 'utf8');
    assert.ok(summary.includes(repository + '@' + digest) && summary.includes(commit));
    assert.ok(!summary.includes('fixture-read-token'));
});

test('changed prepared source, reference or image stops before push', async t => {
    for (const invalid of [{ commit: 'b'.repeat(40) }, { image: 'other.invalid/team/remote:sha' }, { id: 'sha256:' + 'e'.repeat(64) }]) {
        const { directory, env, state, dependencies } = fixture(t);
        await prepareImage(directory, env, dependencies);
        fs.writeFileSync(path.join(directory, 'image.json'), JSON.stringify({ image, id, commit, ...invalid }));
        await assert.rejects(publishImage(directory, env, dependencies));
        assert.equal(state.pushed, false);
    }
});

test('Docker Hub familiar names and aliases retain the correct immutable digest', async t => {
    for (const [configured, returned] of [
        ['docker.io/team/remote', 'team/remote'], ['index.docker.io/team/remote', 'docker.io/team/remote'],
        ['docker.io/remote', 'remote'], ['docker.io/library/remote', 'library/remote'],
    ]) {
        const { directory, env, state, dependencies } = fixture(t);
        env.MCP_IMAGE_REPOSITORY = configured;
        await prepareImage(directory, env, dependencies);
        state.digests = [returned + '@' + digest, 'other.invalid/team/remote@sha256:' + 'e'.repeat(64)];
        await publishImage(directory, env, dependencies);
        assert.match(fs.readFileSync(env.GITHUB_OUTPUT, 'utf8'), new RegExp(`image=${configured}@${digest}\\n`));
        assert.equal(state.commands.filter(call => call[1] === 'push').length, 1);
    }
});

test('failed push and missing, conflicting or malformed digest stop without retry or build', async t => {
    for (const invalid of [{ pushError: true }, { digests: [] }, { digests: [repository + '@sha256:invalid'] },
        { digests: ['other.invalid/team/remote@' + digest] },
        { digests: [repository + '@' + digest, repository + '@sha256:' + 'e'.repeat(64)] }, { changeAt: 4 }]) {
        const { directory, env, state, dependencies } = fixture(t);
        await prepareImage(directory, env, dependencies);
        Object.assign(state, invalid);
        await assert.rejects(publishImage(directory, env, dependencies));
        assert.equal(state.commands.filter(call => call[1] === 'push').length, 1);
        assert.equal(state.commands.filter(call => call[1] === 'buildx').length, 1);
        assert.equal(fs.existsSync(env.GITHUB_STEP_SUMMARY), false);
    }
});

test('actual CLI records success or stops without retry and redacts Docker failure output', t => {
    const { directory, env } = fixture(t);
    fs.writeFileSync(path.join(directory, 'image.json'), JSON.stringify({ image, id, commit }));
    const bin = path.join(directory, 'bin'); fs.mkdirSync(bin);
    const log = path.join(directory, 'commands.jsonl');
    fs.writeFileSync(path.join(bin, 'git'), `#!${process.execPath}\nif(process.argv[2]==='rev-parse') console.log('${commit}');\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'docker'), `#!${process.execPath}
        const fs=require('node:fs');
        const args=process.argv.slice(2); fs.appendFileSync(process.env.IMAGE_TEST_LOG,JSON.stringify(args)+'\\n');
        if(args[0]==='push') {
            if(process.env.IMAGE_TEST_FAILURE) {console.error('fixture-registry-password-must-not-appear');process.exit(1);}
            process.exit(0);
        }
        if(args[0]!=='image') throw new Error('Unexpected Docker operation');
        const pushed=fs.readFileSync(process.env.IMAGE_TEST_LOG,'utf8').includes('["push"');
        console.log(JSON.stringify([{Id:'${id}',Os:'linux',Architecture:'amd64',
            RepoDigests:pushed&&!process.env.IMAGE_TEST_MISSING_DIGEST?['${repository}@${digest}']:[]} ]));
    `, { mode: 0o755 });
    const preload = path.join(directory, 'network.cjs');
    fs.writeFileSync(preload, `globalThis.fetch=async url=>{
        if(!url.startsWith('https://api.github.com/repos/nstdata-ai/nstdata-mcp-server/environments/container-production')) throw new Error('Unexpected network');
        return {status:200,json:async()=>url.includes('/deployment-branch-policies?')?${JSON.stringify(policies)}:${JSON.stringify(environment)}};
    };`);
    for (const scenario of ['accepted', 'failed', 'missing-digest']) {
        for (const file of [log, env.GITHUB_OUTPUT, env.GITHUB_STEP_SUMMARY]) fs.rmSync(file, { force: true });
        const result = spawnSync(process.execPath, ['--require', preload,
            fileURLToPath(new URL('../scripts/release-image.mjs', import.meta.url)), 'publish', directory], {
            env: { ...process.env, ...env, PATH: bin + path.delimiter + process.env.PATH, IMAGE_TEST_LOG: log,
                IMAGE_TEST_FAILURE: scenario === 'failed' ? '1' : '', IMAGE_TEST_MISSING_DIGEST: scenario === 'missing-digest' ? '1' : '' },
            encoding: 'utf8', timeout: 15000,
        });
        assert.equal(result.status, scenario === 'accepted' ? 0 : 1, result.stderr);
        assert.ok(!result.stderr.includes('fixture-registry-password-must-not-appear'));
        const commands = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
        assert.deepEqual(commands, [['image', 'inspect', image], ['push', image],
            ...(scenario === 'failed' ? [] : [['image', 'inspect', image]])]);
        if (scenario === 'accepted') assert.ok(fs.readFileSync(env.GITHUB_STEP_SUMMARY, 'utf8').includes(repository + '@' + digest));
        else {
            assert.match(result.stderr, /without an automatic retry/);
            assert.match(result.stderr, scenario === 'failed' ? /docker push failed/ : /Push completed but its digest is unavailable/);
            assert.equal(fs.existsSync(env.GITHUB_STEP_SUMMARY), false);
        }
    }
});

test('workflow uses main checks, exact checkout and approval with credentials only in the login action', () => {
    const workflow = fs.readFileSync(new URL('../.github/workflows/release-image.yml', import.meta.url), 'utf8');
    assert.match(workflow, /workflow_dispatch:/);
    assert.ok(!/^  (?:push|pull_request|schedule|workflow_call):/m.test(workflow));
    assert.match(workflow, /github\.repository == 'nstdata-ai\/nstdata-mcp-server' && github\.ref == 'refs\/heads\/main'/);
    assert.match(workflow, /uses: \.\/\.github\/workflows\/check\.yml/);
    assert.match(workflow, /needs: checks/);
    assert.match(workflow, /environment: container-production/);
    assert.match(workflow, /cancel-in-progress: false/);
    assert.match(workflow, /ref: \$\{\{ github\.sha \}\}/);
    assert.match(workflow, /persist-credentials: false/);
    assert.deepEqual([...workflow.matchAll(/^  ([\w-]+): (read|write)$/gm)].map(match => match.slice(1)), [['contents', 'read']]);
    assert.deepEqual([...workflow.matchAll(/secrets\.([A-Z_]+)/g)].map(match => match[1]), ['MCP_REGISTRY_USERNAME', 'MCP_REGISTRY_PASSWORD']);
    assert.equal(workflow.indexOf(' prepare ') < workflow.indexOf('docker/login-action@'), true);
    assert.equal(workflow.indexOf('docker/login-action@') < workflow.indexOf(' publish '), true);
    for (const match of workflow.matchAll(/uses: ([^\n]+)/g)) {
        assert.ok(match[1].startsWith('./') || /@[a-f0-9]{40}(?: |$)/.test(match[1]), 'Actions must be pinned');
    }
    assert.match(workflow, /logout: true/);
    assert.ok(!/kubectl|docker push|--push|npm publish|packages: write|id-token: write/.test(workflow));
});
