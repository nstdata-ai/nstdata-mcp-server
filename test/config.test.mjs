import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { cli } from './helpers.mjs';
const { loadConfig, createServer } = await import(new URL('./server.js', pathToFileURL(cli)));
const { validateConfig } = await import(new URL('./config.js', pathToFileURL(cli)));

const validEnv = {
    NSTDATA_MODULES: 'crawl,proxy', NSTDATA_API_TOKEN: 'fixture-private-token',
    NSTDATA_PROXY_URL: 'http://127.0.0.1:1', NSTDATA_PROXY_CHECK_URL: 'https://example.com',
};
const invalidFields = [
    ['NSTDATA_API_TOKEN', 'apiToken', '   '],
    ['NSTDATA_API_BASE_URL', 'baseURL', 'https://fixture-private-user:fixture-private-password@private.invalid/?secret=fixture-private-token'],
    ['NSTDATA_MODULES', 'modules', 'crawl,proxy,fixture-private-module'],
    ['NSTDATA_PROXY_URL', 'proxyURL', 'socks5://fixture-private-user:fixture-private-password@private.invalid'],
    ['NSTDATA_PROXY_CHECK_URL', 'proxyCheckURL', 'https://fixture-private-user:fixture-private-password@private.invalid/'],
    ['NSTDATA_PROXY_CA_FILE', 'proxyCAFile', 'fixture-private-ca.pem'],
    ['NSTDATA_HTTP_TIMEOUT_MS', 'httpTimeoutMs', 'fixture-private-limit'],
    ['NSTDATA_MAX_RESPONSE_BYTES', 'maxResponseBytes', 'fixture-private-limit'],
    ['NSTDATA_MAX_OUTPUT_CHARS', 'maxOutputChars', 'fixture-private-limit'],
    ['NSTDATA_MAX_CRAWL_PAGES', 'maxCrawlPages', 'fixture-private-limit'],
];

function rejected(fields) {
    return error => {
        assert.equal(error.message, `Invalid configuration: ${fields.join(', ')}`);
        assert.equal(Object.hasOwn(error, 'input'), false);
        assert.doesNotMatch(`${String(error)} ${JSON.stringify(error)}`, /fixture-private|private\.invalid|https?:\/\/|socks5:\/\//);
        return true;
    };
}

for (const [variable, , value] of invalidFields) {
    test(`environment configuration errors identify ${variable} without its input value`, () => {
        assert.throws(() => loadConfig({ ...validEnv, [variable]: value }), rejected([variable]));
    });
}

test('environment configuration errors identify every invalid variable together', () => {
    const invalidEnv = Object.fromEntries(invalidFields.map(([variable, , value]) => [variable, value]));
    assert.throws(() => loadConfig(invalidEnv), rejected(invalidFields.map(([variable]) => variable)));
});

test('Crawl requires a nonblank canonical token and Proxy-only configuration needs none', () => {
    for (const token of [undefined, '', '  \t  ']) {
        assert.throws(() => loadConfig({ NSTDATA_API_TOKEN: token }), rejected(['NSTDATA_API_TOKEN']));
    }
    const config = loadConfig({ NSTDATA_MODULES: 'proxy', NSTDATA_API_TOKEN: '',
        NSTDATA_PROXY_URL: validEnv.NSTDATA_PROXY_URL, NSTDATA_PROXY_CHECK_URL: validEnv.NSTDATA_PROXY_CHECK_URL });
    assert.equal(config.apiToken, undefined);
    assert.equal(config.modules, 'proxy');
});

test('programmatic configuration errors preserve internal field names without input values', () => {
    const config = loadConfig(validEnv);
    for (const [, field, value] of invalidFields) {
        assert.throws(() => validateConfig({ ...config, [field]: value }), rejected([field]));
        assert.throws(() => createServer({ ...config, [field]: value }), rejected([field]));
    }
});

test('CLI reports missing or invalid environment variables on stderr before MCP startup', { timeout: 15000 }, async t => {
    for (const [name, env, fields] of [
        ['missing token', {}, ['NSTDATA_API_TOKEN']],
        ['blank token', { NSTDATA_API_TOKEN: '   ' }, ['NSTDATA_API_TOKEN']],
        ['invalid URL', { NSTDATA_API_TOKEN: validEnv.NSTDATA_API_TOKEN, NSTDATA_API_BASE_URL: invalidFields[1][2] }, ['NSTDATA_API_BASE_URL']],
        ['combined invalid fields', Object.fromEntries(invalidFields.map(([variable, , value]) => [variable, value])), invalidFields.map(([variable]) => variable)],
    ]) {
        await t.test(name, () => {
            const result = spawnSync(process.execPath, [cli], { env, encoding: 'utf8', timeout: 5000 });
            assert.equal(result.error, undefined);
            assert.equal(result.status, 1);
            assert.equal(result.stdout, '');
            assert.equal(result.stderr, `Invalid configuration: ${fields.join(', ')}\n`);
            assert.doesNotMatch(result.stderr, /fixture-private|private\.invalid|https?:\/\/|socks5:\/\//);
        });
    }
});

test('CLI keeps unexpected startup exceptions generic without printing their messages', { timeout: 10000 }, () => {
    const preload = `process.once = new Proxy(process.once, { apply(target, receiver, args) {
        if (args[0] === 'SIGINT') throw new Error('fixture-private-exception https://user:password@private.invalid/');
        return Reflect.apply(target, receiver, args);
    } });`;
    const result = spawnSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(preload)}`, cli], {
        env: { NSTDATA_API_TOKEN: validEnv.NSTDATA_API_TOKEN }, encoding: 'utf8', timeout: 5000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'Unable to start Nstdata MCP. Check the documented environment configuration.\n');
});

test('CLI identifies unusable Proxy CA resources without changing programmatic transport errors', { timeout: 15000 }, async t => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'nstdata-fixture-private-ca-'));
    t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
    const invalidCA = path.join(folder, 'fixture-private-invalid.pem');
    fs.writeFileSync(invalidCA, 'fixture-private-invalid-certificate');
    for (const [name, caFile] of [
        ['missing file', path.join(folder, 'fixture-private-missing.pem')],
        ['directory', folder],
        ['invalid certificate', invalidCA],
    ]) {
        await t.test(name, () => {
            const env = { ...validEnv, NSTDATA_MODULES: 'proxy', NSTDATA_PROXY_CA_FILE: caFile };
            assert.throws(() => createServer(loadConfig(env)), error => {
                assert.equal(error.name, 'ProxyTransportError');
                assert.equal(error.code, 'INVALID_CONFIG');
                assert.equal(error.message, 'Invalid proxy transport configuration.');
                return true;
            });
            const result = spawnSync(process.execPath, [cli], { env, encoding: 'utf8', timeout: 5000 });
            assert.equal(result.error, undefined);
            assert.equal(result.status, 1);
            assert.equal(result.stdout, '');
            assert.equal(result.stderr, 'Invalid configuration: NSTDATA_PROXY_CA_FILE\n');
            assert.doesNotMatch(result.stderr, /fixture-private|private\.invalid|https?:\/\//);
        });
    }
});
