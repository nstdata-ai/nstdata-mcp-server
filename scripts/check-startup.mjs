import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

export async function verifyStartup({ command, args, cwd, env, version, toolNames, timeoutMs = 10000 }) {
    assert.ok(Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 60000, 'Invalid startup deadline');
    const transport = new StdioClientTransport({ command, args, cwd, env, stderr: 'pipe' });
    const client = new Client({ name: 'installation-check', version: '1.0.0' }, {
        versionNegotiation: { mode: 'legacy' },
    });
    let stderrSeen = false, timer, result, failed = false;
    transport.stderr.on('data', chunk => { stderrSeen ||= chunk.length > 0; });
    try {
        const checked = (async () => {
            await client.connect(transport);
            assert.equal(client.getServerVersion()?.version, version);
            const tools = (await client.listTools()).tools.map(tool => tool.name).sort();
            assert.deepEqual(tools, [...toolNames].sort());
            assert.equal(stderrSeen, false);
            return { version, toolNames: tools };
        })();
        result = await Promise.race([checked, new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('Startup deadline exceeded')), timeoutMs);
        })]);
    } catch {
        failed = true;
    } finally {
        clearTimeout(timer);
        try { await client.close(); } catch { failed = true; }
    }
    if (failed || stderrSeen) throw Object.assign(new Error('MCP startup verification failed. Check package version, configuration and client diagnostics.'), { code: 'MCP_STARTUP_FAILED' });
    return result;
}
