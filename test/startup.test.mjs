import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { verifyStartup } from '../scripts/check-startup.mjs';

const cli = process.env.NSTDATA_TEST_CLI ?? fileURLToPath(new URL('../dist/stdio.js', import.meta.url));
const version = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const toolNames = ['nstdata_crawl_scrape', 'nstdata_crawl_scrape_result', 'nstdata_crawl_start',
    'nstdata_crawl_status', 'nstdata_crawl_pages', 'nstdata_crawl_read_result'];

test('startup verification discovers the installed server without a business request', async t => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'nstdata-discovery-'));
    t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
    const guard = path.join(folder, 'deny-network.cjs');
    fs.writeFileSync(guard, "require('node:net').Socket.prototype.connect=function(){throw new Error('Discovery must not open a network socket');};");
    const result = await verifyStartup({ command: process.execPath, args: [cli], env: {
        NSTDATA_MODULES: 'crawl', NSTDATA_API_TOKEN: 'fixture-token', NODE_OPTIONS: `--require=${JSON.stringify(guard)}`,
    }, version, toolNames });
    assert.deepEqual(result, { version, toolNames: [...toolNames].sort() });
});

test('startup failures omit process diagnostics and deadlines stop unresponsive children', { timeout: 10000 }, async t => {
    await assert.rejects(verifyStartup({ command: process.execPath,
        args: ['-e', "console.error('fixture-private-diagnostic');process.exit(1);"], version, toolNames }), error => {
        assert.equal(error.code, 'MCP_STARTUP_FAILED');
        assert.doesNotMatch(String(error), /fixture-private-diagnostic/);
        return true;
    });
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'nstdata-discovery-timeout-'));
    t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
    const pidFile = path.join(folder, 'pid');
    const started = performance.now();
    await assert.rejects(verifyStartup({ command: process.execPath,
        args: ['-e', "require('node:fs').writeFileSync(process.env.FIXTURE_PID,String(process.pid));setInterval(()=>{},1000);"],
        env: { FIXTURE_PID: pidFile }, version, toolNames, timeoutMs: 100 }), { code: 'MCP_STARTUP_FAILED' });
    assert.ok(performance.now() - started < 6000, 'Deadline plus SDK process cleanup must stay bounded');
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});
