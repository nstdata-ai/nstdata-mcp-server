import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { shellCommands, checkMarkdown } from '../scripts/documentation.mjs';

const documents = ['README.md', 'README_zh.md', 'CONTRIBUTING.md', 'CHANGELOG.md', 'SECURITY.md',
    'docs/mcp.md', 'docs/mcp_zh.md', 'docs/proxy.md', 'docs/proxy_zh.md'];

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
