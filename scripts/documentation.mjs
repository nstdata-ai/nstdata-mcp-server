import assert from 'node:assert/strict';
import { marked } from 'marked';

function literalWords(line) {
    const words = [];
    let remaining = line.trim();
    while (remaining) {
        const token = /^(?:"([^"\\$`\r\n]*)"|'([^'\r\n]*)'|([^\s"'\\$`;&|<>]+))(?=\s|$)/.exec(remaining);
        assert.ok(token, 'Documentation commands must use literal arguments without shell expansion or operators');
        words.push(token[1] ?? token[2] ?? token[3]);
        remaining = remaining.slice(token[0].length).trimStart();
    }
    assert.ok(words.length, 'Empty documentation command');
    return words;
}

function codeBlocks(text) {
    const blocks = [];
    marked.walkTokens(marked.lexer(text), token => { if (token.type === 'code') blocks.push(token); });
    return blocks;
}

export function shellCommands(text) {
    const commands = [];
    for (const block of codeBlocks(text).filter(token => token.lang === 'sh')) {
        let words = [];
        for (const line of block.text.trim().split('\n')) {
            const continued = line.trimEnd().endsWith('\\');
            if (continued) assert.match(line, /\s\\$/, 'Line continuation must follow a complete argument');
            words.push(...literalWords(continued ? line.trimEnd().slice(0, -1) : line));
            if (continued) continue;
            assert.ok(['npm', 'npx', 'node'].includes(words[0]), 'Unsupported documentation executable');
            commands.push(words);
            words = [];
        }
        assert.equal(words.length, 0, 'Unfinished documentation command continuation');
    }
    return commands;
}

export function checkMarkdown(text, filename) {
    const headings = new Set();
    marked.walkTokens(marked.lexer(text), token => {
        if (token.type === 'text' && !token.tokens) assert.doesNotMatch(token.text, /\*\*/, `${filename}: unrendered emphasis`);
        if (token.type === 'code' && ['sh', 'js', 'json'].includes(token.lang)) {
            for (const line of token.text.split('\n')) assert.ok(line.length <= 100,
                `${filename}: ${line.length}-character ${token.lang} line needs scrolling`);
        }
        if (token.type === 'heading') {
            const id = token.text.toLowerCase().replace(/[^\p{L}\p{N}_ -]/gu, '').replace(/ /g, '-');
            assert.ok(!headings.has(id), `${filename}: duplicate heading ${id}`);
            headings.add(id);
        }
    });
}
