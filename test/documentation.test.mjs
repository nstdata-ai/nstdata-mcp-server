import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { shellCommands, checkMarkdown } from '../scripts/documentation.mjs';
import { loadConfig } from '../dist/config.js';
import { parseEnv } from 'node:util';

const documents = ['README.md', 'README_zh.md', 'CONTRIBUTING.md', 'CHANGELOG.md', 'SECURITY.md',
    'docs/mcp.md', 'docs/mcp_zh.md', 'docs/proxy.md', 'docs/proxy_zh.md'];

test('Codex plugin starts the pinned package and forwards required and optional configuration', () => {
    const read = file => JSON.parse(fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8'));
    const market = read('.agents/plugins/marketplace.json');
    assert.equal(market.name, 'nstdata');
    assert.deepEqual(market.plugins.map(plugin => [plugin.name, plugin.source]),
        [['nstdata', { source: 'local', path: './plugins/nstdata' }]]);
    const plugin = read('plugins/nstdata/.codex-plugin/plugin.json');
    const { nstdata: server } = read('plugins/nstdata/.mcp.json').mcpServers;
    assert.equal(plugin.name, 'nstdata');
    assert.equal(plugin.mcpServers, './.mcp.json');
    assert.equal(server.type, 'stdio');
    assert.equal(server.command, 'npx');
    assert.deepEqual(server.args, ['--yes', `@nstdata-ai/mcp-server@${plugin.version}`]);
    assert.equal(server.env, undefined, 'The plugin must not embed credential values');
    assert.equal(new Set(server.env_vars).size, server.env_vars.length);
    const supplied = { NSTDATA_API_TOKEN: 'fixture-token', NSTDATA_MODULES: 'crawl,proxy',
        NSTDATA_PROXY_URL: 'http://fixture:fixture@127.0.0.1:9/', NSTDATA_PROXY_CHECK_URL: 'https://target.invalid/',
        NSTDATA_API_BASE_URL: 'https://api.invalid', NSTDATA_PROXY_CA_FILE: '/fixture/ca.pem',
        NSTDATA_HTTP_TIMEOUT_MS: '1000', NSTDATA_MAX_RESPONSE_BYTES: '4096',
        NSTDATA_MAX_OUTPUT_CHARS: '2048', NSTDATA_MAX_CRAWL_PAGES: '2' };
    const forwarded = Object.fromEntries(server.env_vars.map(name => {
        assert.ok(Object.hasOwn(supplied, name), `Undocumented forwarded variable: ${name}`);
        return [name, supplied[name]];
    }));
    assert.deepEqual(loadConfig(forwarded), loadConfig(supplied));
    assert.equal(loadConfig({ NSTDATA_API_TOKEN: 'fixture-token' }).modules, 'crawl');
});

test('bilingual Codex setup uses the same TOML, optional plugin credentials and update commands', () => {
    const readmes = ['README.md', 'README_zh.md'].map(file =>
        fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8'));
    const toml = text => [...text.matchAll(/```toml\n([\s\S]*?)```/g)].map(block => block[1]);
    assert.deepEqual(toml(readmes[0]), toml(readmes[1]));
    assert.equal(toml(readmes[0]).length, 1);
    const references = ['docs/mcp.md', 'docs/mcp_zh.md'].map(file =>
        fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8'));
    for (const text of references) {
        assert.deepEqual(shellCommands(text), [['codex', 'plugin', 'marketplace', 'upgrade', 'nstdata'],
            ['codex', 'plugin', 'add', 'nstdata@nstdata']]);
        const blocks = [...text.matchAll(/```dotenv\n([\s\S]*?)```/g)].map(block => parseEnv(block[1]));
        assert.deepEqual(blocks, [{ NSTDATA_API_TOKEN: 'your-api-key' }]);
        assert.equal(loadConfig(blocks[0]).modules, 'crawl');
    }
});

test('public Markdown renders emphasis and keeps all code examples readable', () => {
    for (const file of documents) checkMarkdown(fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8'), file);
});

test('documentation command parsing preserves literal arguments and standard continuations', () => {
    assert.deepEqual(shellCommands('```sh\nnpm install @nstdata-ai/mcp-server\n```'), [['npm', 'install', '@nstdata-ai/mcp-server']]);
    assert.deepEqual(shellCommands('> ```sh\n> npx --yes @nstdata-ai/mcp-server@1.0.1\n> ```'), [['npx', '--yes', '@nstdata-ai/mcp-server@1.0.1']]);
    assert.deepEqual(shellCommands('```sh\nnpx --yes \\\n  "@nstdata-ai/mcp-server@1.0.1"\n```'), [['npx', '--yes', '@nstdata-ai/mcp-server@1.0.1']]);
    for (const value of ['npm install $(command)', 'npm install `command`', 'npm install "${TOKEN}"',
        'npm install a; command', 'npm install a && command', 'npm install a | command',
        'npm install a > output', 'curl https://example.com/', 'npm install package \\',
        'npm install "open \\\nclosed"']) assert.throws(() => shellCommands('```sh\n' + value + '\n```'));
});

test('render checks reject broken emphasis and duplicate headings without rejecting valid nested bold', () => {
    assert.throws(() => checkMarkdown('**警示。**交给调用方', 'fixture.md'), /unrendered emphasis/);
    assert.throws(() => checkMarkdown('# Same\n\n# Same\n', 'fixture.md'), /duplicate heading/);
    assert.throws(() => checkMarkdown('```json\n' + 'x'.repeat(101) + '\n```', 'fixture.md'), /needs scrolling/);
    checkMarkdown('- **Important** text\n', 'fixture.md');
});
