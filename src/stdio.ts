#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { ProxyTransportError } from '@nstdata-ai/proxy-checker/transport';
import { createRequire } from 'node:module';
import { createServer, loadConfig } from './server.js';
import { DEFAULT_PROXY_CHECK_URL, EnvironmentConfigError } from './config.js';

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--help') {
    console.log(`Usage: nstdata-mcp-server [--help | --version]

With no arguments, start a local stdio MCP server.
Set environment variables in your MCP client configuration:
  NSTDATA_MODULES          crawl (default), proxy, or crawl,proxy
  NSTDATA_API_TOKEN        Required when Crawl is enabled
  NSTDATA_PROXY_URL        Required when Proxy is enabled; HTTP(S) gateway URL
  NSTDATA_PROXY_CHECK_URL  Optional check target; default ${DEFAULT_PROXY_CHECK_URL}

Startup does not submit tasks or check the proxy. Calls may consume credits or traffic.
Configuration reference: https://github.com/nstdata-ai/nstdata-mcp-server#readme`);
} else if (args.length === 1 && args[0] === '--version') {
    const { version } = createRequire(import.meta.url)('../package.json') as { version: string };
    console.log(version);
} else if (args.length) {
    console.error('Unsupported arguments. Use --help for usage.');
    process.exitCode = 1;
} else try {
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
