import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, envelope, json } from './helpers.mjs';

const cases = [
    {
        name: 'JS rendering wait',
        invalid: [0, 999, 30001, 600000, 1000.5].map(waitFor => ({ jsRender: { waitFor } })),
        valid: [{}, { jsRender: { waitFor: 1000, actions: [{ type: 'wait', milliseconds: 0 },
            { type: 'waitSelector', selector: 'main', milliseconds: 600000 }] } }, { jsRender: { waitFor: 30000 } }],
    },
    {
        name: 'upstream timeout',
        invalid: [0, 1, 999, 60001, 600000, 1000.5].map(timeout => ({ timeout })),
        valid: [{ timeout: 1000 }, { timeout: 60000 }],
    },
    {
        name: 'scroll coordinates',
        invalid: [{ type: 'scrollX', x: 0.5 }, { type: 'scrollY', y: -1.5 }]
            .map(action => ({ jsRender: { actions: [action] } })),
        valid: [{ jsRender: { actions: [{ type: 'scrollX', x: 0 }, { type: 'scrollY', y: -100 },
            { type: 'scrollX', x: 100 }] } }],
    },
];

for (const era of ['legacy', 'modern']) {
    for (const { name, invalid, valid } of cases) {
        test(`${era} ${name} rejects invalid options before submission and forwards valid boundaries`, { timeout: 10000 }, async t => {
            const h = await harness(t, (_req, res) => json(res, envelope({ id: 'options-task', status: 'completed',
                success: true, data: { markdown: '# Valid fixture' } })), {}, era);
            for (const tool of ['nstdata_crawl_scrape', 'nstdata_crawl_start']) {
                const before = h.requests.length;
                for (const options of invalid) {
                    const result = await h.client.callTool({ name: tool, arguments: { url: 'https://example.com/', options } });
                    assert.equal(result.isError, true, `${tool} must reject ${JSON.stringify(options)}`);
                    assert.equal(h.requests.length, before, 'Invalid options must not create a task');
                }
                for (const options of valid) {
                    const result = await h.client.callTool({ name: tool, arguments: { url: 'https://example.com/', options } });
                    assert.notEqual(result.isError, true, `${tool} must accept ${JSON.stringify(options)}`);
                    const expected = { url: 'https://example.com/', formats: ['markdown'], ...options,
                        ...(tool === 'nstdata_crawl_start' ? { maxPages: 10 } : {}) };
                    assert.deepEqual(h.requests.at(-1).body, expected);
                }
                assert.equal(h.requests.length, before + valid.length, 'Valid options must submit exactly once');
            }
        });
    }
}
