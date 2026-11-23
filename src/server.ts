import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/server';
import { type Config, validateConfig } from './config.js';
import { registerCrawlTools } from './modules/crawl.js';
import { registerProxyTools } from './modules/proxy.js';

const { version } = createRequire(import.meta.url)('../package.json') as { version: string };

export function createServer(config: Config): McpServer {
    config = validateConfig(config);
    const server = new McpServer({ name: 'nstdata', version });
    if (config.modules.includes('crawl')) registerCrawlTools(server, config);
    if (config.modules.includes('proxy')) registerProxyTools(server, config);
    return server;
}

export { loadConfig, type Config } from './config.js';
