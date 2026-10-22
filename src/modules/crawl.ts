import { McpServer } from '@modelcontextprotocol/server';
import { NstDataClient } from '@nstdata-ai/crawl';
import { z } from 'zod';
import { guard } from '../shared/errors.js';
import { type Config } from '../config.js';
import { httpURL, identifier, formats, scrapeOptions } from './crawl-schema.js';
import { serializeData, taskFailed, requireSubmissionId } from './crawl-result.js';

export function registerCrawlTools(server: McpServer, client: NstDataClient, config: Config): void {
    server.registerTool('nstdata_crawl_read_result', {
        description: 'Read a bounded chunk of a Crawl storage reference. Text offsets count Unicode code points; binary offsets count bytes. Each call downloads the reference again, within the response byte limit.',
        inputSchema: z.strictObject({ ref: z.string().min(1).max(4096), format: z.enum(['markdown', 'html', 'pdf', 'screenshot', 'rawData']), offset: z.number().int().min(0).default(0), length: z.number().int().min(1).max(4000).default(2000) }),
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    }, async (args, ctx) => guard(ctx, config, async options => {
        const bytes = Buffer.from(await client.readStorage(args.ref, options));
        const isText = args.format === 'markdown' || args.format === 'html';
        const points = isText ? Array.from(bytes.toString('utf8')) : undefined;
        const total = points?.length ?? bytes.length;
        const end = Math.min(args.offset + args.length, total);
        const output = { format: args.format, encoding: isText ? 'utf-8' : 'base64', unit: isText ? 'codePoints' : 'bytes', offset: args.offset,
            ...(points ? { text: points.slice(args.offset, end).join('') } : { base64: bytes.subarray(args.offset, end).toString('base64') }),
            total, nextOffset: end < total ? end : undefined };
        return { content: [{ type: 'text', text: JSON.stringify(output) }], structuredContent: output };
    }));
    server.registerTool('nstdata_crawl_start', {
        description: 'Start a bounded site crawl and return its task ID immediately.',
        inputSchema: z.strictObject({ url: httpURL, formats, options: scrapeOptions, maxPages: z.number().int().min(1).max(config.maxCrawlPages).default(config.maxCrawlPages), maxDepth: z.number().int().min(0).max(100).optional(), includeUrls: z.array(z.string().max(8192)).max(100).optional(), excludeUrls: z.array(z.string().max(8192)).max(100).optional(), ignoreQuery: z.boolean().optional() }),
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    }, async (args, ctx) => guard(ctx, config, async options => {
        const { options: advanced, ...request } = args;
        const output = await client.submitCrawlTask({ ...request, ...advanced }, options);
        requireSubmissionId(output);
        return { content: [{ type: 'text', text: JSON.stringify(output) }], structuredContent: { ...output }, isError: taskFailed(output) };
    }, 'task'));
    server.registerTool('nstdata_crawl_status', {
        description: 'Read aggregate crawl progress without polling.',
        inputSchema: z.strictObject({ crawlId: identifier }),
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    }, async (args, ctx) => guard(ctx, config, async options => {
        const output = { ...await client.getCrawlStatus(args.crawlId, options), crawlId: args.crawlId };
        return { content: [{ type: 'text', text: JSON.stringify(output) }], structuredContent: { ...output }, isError: taskFailed(output) };
    }));
    server.registerTool('nstdata_crawl_pages', {
        description: 'Read one page of crawl results and return actual cursors and storage references. Does not download referenced files.',
        inputSchema: z.strictObject({ crawlId: identifier, afterCursor: z.string().min(1).max(8192).optional(), beforeCursor: z.string().min(1).max(8192).optional(), limit: z.number().int().min(1).max(100).default(10) }).refine(args => !(args.afterCursor && args.beforeCursor)),
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    }, async ({ crawlId, ...pageOptions }, ctx) => guard(ctx, config, async options => {
        const result = await client.listCrawlPages(crawlId, pageOptions, options);
        const output = { ...result, crawlId, data: result.data && await Promise.all(result.data.map(async page => ({
            ...page, data: await serializeData(page.data, options),
        }))) };
        return { content: [{ type: 'text', text: JSON.stringify(output) }], structuredContent: output };
    }));
    server.registerTool('nstdata_crawl_scrape', {
        description: 'Retrieve a webpage through Nstdata Crawl. Creates a potentially billable scrape task.',
        inputSchema: z.strictObject({
            url: httpURL, formats, options: scrapeOptions,
            mode: z.enum(['sync', 'async']).default('sync'),
        }),
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    }, async (args, ctx) => guard(ctx, config, async options => {
        const { mode, options: advanced, ...common } = args;
        const request = { ...common, ...advanced };
        if (mode === 'async') {
            const submitted = await client.submitScrapeTask(request, options);
            requireSubmissionId(submitted);
            return { content: [{ type: 'text', text: JSON.stringify(submitted) }], structuredContent: { ...submitted }, isError: taskFailed(submitted) };
        }
        const result = await client.submitScrapeTaskSync(request, options);
        const output = { id: result.id, status: result.status, success: result.success, errorCode: result.errorCode, errorMessage: result.errorMessage, data: await serializeData(result.data, options) };
        return { content: [{ type: 'text', text: JSON.stringify(output) }], structuredContent: output, isError: taskFailed(result) };
    }, 'task'));
    server.registerTool('nstdata_crawl_scrape_result', {
        description: 'Resume a submitted single-page task. Processing is not completion; a failed or expired task is reported explicitly.',
        inputSchema: z.strictObject({ taskId: identifier }),
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    }, async (args, ctx) => guard(ctx, config, async options => {
        const result = await client.getScrapeTaskResult(args.taskId, options);
        const output = { id: result.id, taskId: args.taskId, status: result.status, success: result.success,
            errorCode: result.errorCode, errorMessage: result.errorMessage,
            data: await serializeData(result.data, options),
        };
        return { content: [{ type: 'text', text: JSON.stringify(output) }], structuredContent: output,
            isError: taskFailed(result) };
    }));
}
