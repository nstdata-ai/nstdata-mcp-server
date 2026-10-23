import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { cli } from './helpers.mjs';
const { loadConfig, createServer } = await import(new URL('./server.js', pathToFileURL(cli)));

test('public configuration errors reject malformed URLs without retaining their input', () => {
    const input = 'sensitive-invalid-url';
    const rejected = field => error => {
        assert.equal(error.message, `Invalid configuration: ${field}`);
        assert.equal(Object.hasOwn(error, 'input'), false);
        assert.doesNotMatch(JSON.stringify(error), /sensitive-invalid-url/);
        return true;
    };
    assert.throws(() => loadConfig({ NSTDATA_API_TOKEN: 'fixture-token', NSTDATA_API_BASE_URL: input }), rejected('baseURL'));
    assert.throws(() => loadConfig({ NSTDATA_MODULES: 'proxy', NSTDATA_PROXY_URL: 'http://127.0.0.1:1', NSTDATA_PROXY_CHECK_URL: input }), rejected('proxyCheckURL'));
    const config = loadConfig({ NSTDATA_API_TOKEN: 'fixture-token' });
    assert.throws(() => createServer({ ...config, baseURL: input }), rejected('baseURL'));
});
