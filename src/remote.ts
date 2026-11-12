#!/usr/bin/env node
import { loadRemoteConfig, RemoteConfigurationError } from './remote-config.js';
import { loadRemoteTls, startRemoteService, RemoteServiceError } from './remote-service.js';

const usage = `Usage: node <remote.js> --config <absolute-path> [--check]

Start a self-hosted Crawl MCP service with OAuth and Redis.
--check validates the protected configuration and TLS files without connecting or listening.
Configuration reference: docs/remote.md
`;

async function main(args: string[]): Promise<void> {
    if (args.length === 1 && args[0] === '--help') { console.log(usage); return; }
    const check = args.includes('--check');
    const configArgs = args.filter(value => value !== '--check');
    if (configArgs.length !== 2 || configArgs[0] !== '--config' ||
        args.filter(value => value === '--check').length > 1) {
        console.error('Unsupported arguments. Use --help for usage.');
        process.exitCode = 2;
        return;
    }
    const config = await loadRemoteConfig(configArgs[1]);
    if (check) {
        await loadRemoteTls(config.listen.tls, config.issuerUrl);
        console.log('Remote configuration and TLS files are valid. No connection was attempted.');
        return;
    }
    const service = await startRemoteService(config);
    console.log('Nstdata Remote service started.');
    const shutdown = () => { void service.close().catch(() => { process.exitCode = 1; }); };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    try { await service.closed; }
    finally { process.off('SIGINT', shutdown); process.off('SIGTERM', shutdown); }
}

try { await main(process.argv.slice(2)); }
catch (error) {
    console.error(error instanceof RemoteConfigurationError ? error.message
        : `Remote service unavailable. Check the protected configuration, TLS files and Redis availability.${error instanceof RemoteServiceError ? ` [${error.code}]` : ''}`);
    process.exitCode = 1;
}
