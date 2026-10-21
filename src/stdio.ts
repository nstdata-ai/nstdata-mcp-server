#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createServer, loadConfig } from './server.js';

try {
    const config = loadConfig();
    // Validate module resources before the lazy stdio negotiation receives input.
    let initialServer: ReturnType<typeof createServer> | undefined = createServer(config);
    const handle = serveStdio(() => {
        const server = initialServer ?? createServer(config);
        initialServer = undefined;
        return server;
    }, {
        onerror: () => { console.error('MCP protocol error.'); },
    });
    const shutdown = () => { void handle.close().catch(() => { process.exitCode = 1; }); };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
} catch {
    console.error('Unable to start Nstdata MCP. Check the documented environment configuration.');
    process.exitCode = 1;
}
