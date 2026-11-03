#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { ProxyTransportError } from '@nstdata-ai/proxy-checker/transport';
import { createServer, loadConfig } from './server.js';
import { EnvironmentConfigError } from './config.js';

try {
    const config = loadConfig();
    // Validate module resources before the lazy stdio negotiation receives input.
    let initialServer: ReturnType<typeof createServer> | undefined;
    try {
        initialServer = createServer(config);
    } catch (error) {
        if (config.proxyCAFile && error instanceof ProxyTransportError && error.code === 'INVALID_CONFIG') {
            throw new EnvironmentConfigError(['proxyCAFile']);
        }
        throw error;
    }
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
} catch (error) {
    console.error(error instanceof EnvironmentConfigError
        ? error.message
        : 'Unable to start Nstdata MCP. Check the documented environment configuration.');
    process.exitCode = 1;
}
