import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { shellCommands, checkMarkdown, clientConfigurations } from '../scripts/documentation.mjs';
import { loadConfig } from '../dist/config.js';
import { parseEnv } from 'node:util';

const version = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

const documents = ['README.md', 'README_zh.md', 'CONTRIBUTING.md', 'CHANGELOG.md', 'SECURITY.md',
    'docs/mcp.md', 'docs/mcp_zh.md', 'docs/proxy.md', 'docs/proxy_zh.md', 'docs/remote.md', 'docs/remote_zh.md',
    'plugins/nstdata/README.md', 'plugins/nstdata/README_zh.md'];

test('the standalone plugin includes its own installation guide and MIT license', () => {
    const directory = new URL('../plugins/nstdata/', import.meta.url);
    const readme = fs.readFileSync(new URL('README.md', directory), 'utf8');
    const chinese = fs.readFileSync(new URL('README_zh.md', directory), 'utf8');
    const versions = ['.codex-plugin', '.cursor-plugin', '.claude-plugin'].map(name =>
        JSON.parse(fs.readFileSync(new URL(`${name}/plugin.json`, directory), 'utf8')).version);
    assert.deepEqual(versions, [version, version, version], 'Native plugins must select the current server release');
    for (const text of [readme, chinese]) assert.ok(text.includes(`@nstdata-ai/mcp-server@${versions[0]}`));
    assert.ok(readme.replace(/```[\s\S]*?```/g, '').trim().split(/\s+/).length >= 40);
    assert.match(readme, /\[中文\]\(README_zh\.md\)/);
    assert.match(readme, /\[MIT license\]\(LICENSE\)/);
    assert.match(chinese, /\[MIT 许可\]\(LICENSE\)/);
    assert.equal(fs.readFileSync(new URL('LICENSE', directory), 'utf8'),
        fs.readFileSync(new URL('../LICENSE', import.meta.url), 'utf8'));
});

test('Cursor marketplace resolves its own plugin and credential configuration', () => {
    const read = file => JSON.parse(fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8'));
    const market = read('.cursor-plugin/marketplace.json');
    assert.equal(market.name, 'nstdata');
    assert.deepEqual(market.plugins.map(plugin => [plugin.name, plugin.source]),
        [['nstdata', './plugins/nstdata']]);
    const plugin = read('plugins/nstdata/.cursor-plugin/plugin.json');
    assert.equal(plugin.name, 'nstdata');
    assert.equal(plugin.mcpServers, './mcp.json');
    const { nstdata: server } = read('plugins/nstdata/mcp.json').mcpServers;
    assert.equal(server.command, 'npx');
    assert.deepEqual(server.args, ['--yes', `@nstdata-ai/mcp-server@${plugin.version}`]);
    assert.equal(server.env_vars, undefined, 'Cursor must not depend on Codex environment forwarding');
    assert.equal(server.env.NSTDATA_MODULES, '${NSTDATA_MODULES:-crawl}');
    for (const name of ['NSTDATA_API_TOKEN', 'NSTDATA_PROXY_URL']) {
        assert.equal(plugin.variables.properties[name].writeOnly, true);
        assert.equal(server.env[name], '${' + name + ':-}', 'Missing credentials must become empty, not literal placeholders');
    }
    assert.deepEqual(plugin.variables.properties.NSTDATA_MODULES.enum, ['crawl', 'proxy', 'crawl,proxy']);
    assert.equal(plugin.variables.properties.NSTDATA_MODULES.default, 'crawl');
});

test('Claude Code marketplace uses its own MCP file and module-dependent credentials', () => {
    const read = file => JSON.parse(fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8'));
    const market = read('.claude-plugin/marketplace.json');
    assert.equal(market.name, 'nstdata');
    assert.deepEqual(market.plugins.map(plugin => [plugin.name, plugin.source]),
        [['nstdata', './plugins/nstdata']]);
    const plugin = read('plugins/nstdata/.claude-plugin/plugin.json');
    assert.equal(plugin.name, 'nstdata');
    assert.equal(plugin.mcpServers, './claude.mcp.json');
    const { nstdata: server } = read('plugins/nstdata/claude.mcp.json').mcpServers;
    assert.equal(server.command, 'npx');
    assert.deepEqual(server.args, ['--yes', `@nstdata-ai/mcp-server@${plugin.version}`]);
    assert.equal(server.env_vars, undefined);
    assert.equal(plugin.userConfig.NSTDATA_MODULES.default, 'crawl');
    for (const name of ['NSTDATA_MODULES', 'NSTDATA_API_TOKEN', 'NSTDATA_PROXY_URL']) {
        assert.equal(server.env[name], '${user_config.' + name + '}');
        assert.notEqual(plugin.userConfig[name].required, true);
    }
    for (const name of ['NSTDATA_API_TOKEN', 'NSTDATA_PROXY_URL']) {
        assert.equal(plugin.userConfig[name].sensitive, true);
        assert.equal(plugin.userConfig[name].default, '');
    }
});

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

test('Gemini extension uses the published Crawl server and a client-managed sensitive setting', () => {
    const read = file => JSON.parse(fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8'));
    const extension = read('gemini-extension.json');
    const version = read('package.json').version;
    assert.equal(extension.name, 'nstdata');
    assert.equal(extension.version, version);
    assert.deepEqual(Object.keys(extension.mcpServers), ['nstdata']);
    const server = extension.mcpServers.nstdata;
    assert.equal(server.command, 'npx');
    assert.deepEqual(server.args, ['--yes', `@nstdata-ai/mcp-server@${version}`]);
    assert.deepEqual(server.env, { NSTDATA_MODULES: 'crawl', NSTDATA_API_TOKEN: '${NSTDATA_API_TOKEN:-}' });
    assert.equal(extension.settings.length, 1);
    assert.equal(extension.settings[0].envVar, 'NSTDATA_API_TOKEN');
    assert.equal(extension.settings[0].sensitive, true);
    assert.ok(extension.settings[0].name && extension.settings[0].description);
    assert.equal(loadConfig({ ...server.env, NSTDATA_API_TOKEN: 'fixture-token' }).modules, 'crawl');
    assert.throws(() => loadConfig({ ...server.env, NSTDATA_API_TOKEN: '' }));
});

test('bilingual client setup preserves the pinned command, credential mapping and registration commands', () => {
    const readmes = ['README.md', 'README_zh.md'].map(file =>
        fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8'));
    const toml = text => [...text.matchAll(/```toml\n([\s\S]*?)```/g)].map(block => block[1]);
    assert.deepEqual(toml(readmes[0]), toml(readmes[1]));
    assert.equal(toml(readmes[0]).length, 1);
    const references = ['docs/mcp.md', 'docs/mcp_zh.md'].map(file =>
        fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8'));
    assert.deepEqual(clientConfigurations(references[0]), clientConfigurations(references[1]));
    for (const text of references) {
        const clients = clientConfigurations(text);
        assert.equal(clients.length, 3);
        for (const config of clients) {
            assert.deepEqual(config, {
                command: 'npx', args: ['--yes', `@nstdata-ai/mcp-server@${version}`],
                env: { NSTDATA_MODULES: 'crawl', NSTDATA_API_TOKEN: 'YOUR_CRAWL_API_TOKEN' },
            });
            assert.equal(loadConfig(config.env).modules, 'crawl');
        }
        assert.deepEqual(shellCommands(text), [
            ['claude', 'mcp', 'add', '--scope', 'user', '--env', 'NSTDATA_API_TOKEN=${NSTDATA_API_TOKEN:-}',
                '--transport', 'stdio', 'nstdata', '--', 'npx', '--yes', `@nstdata-ai/mcp-server@${version}`],
            ['codex', 'plugin', 'marketplace', 'upgrade', 'nstdata'],
            ['codex', 'plugin', 'add', 'nstdata@nstdata'],
            ['claude', 'plugin', 'marketplace', 'add', 'nstdata-ai/nstdata-mcp-server'],
            ['claude', 'plugin', 'install', 'nstdata@nstdata'],
            ['claude', 'plugin', 'marketplace', 'update', 'nstdata'],
            ['claude', 'plugin', 'update', 'nstdata@nstdata'],
            ['gemini', 'extensions', 'install', 'https://github.com/nstdata-ai/nstdata-mcp-server'],
            ['gemini', 'extensions', 'config', 'nstdata', 'NSTDATA_API_TOKEN', '--scope', 'user'],
            ['gemini', 'extensions', 'list'],
            ['gemini', 'mcp', 'list'],
            ['gemini', 'extensions', 'update', 'nstdata'],
            ['gemini', 'extensions', 'uninstall', 'nstdata']]);
        const blocks = [...text.matchAll(/```dotenv\n([\s\S]*?)```/g)].map(block => ({ ...parseEnv(block[1]) }));
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
