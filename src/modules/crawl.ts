import { McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import { NstDataClient } from '@nstdata-ai/crawl';
import { z } from 'zod';
import { isUtf8 } from 'node:buffer';
import { guard, ToolFailure } from '../shared/errors.js';
import { type Config } from '../config.js';
import { httpURL, identifier, formats, scrapeOptions } from './crawl-schema.js';
import { serializeData, taskFailed, requireSubmissionId } from './crawl-result.js';
import { boundResult, configuredSecrets } from '../shared/output.js';

const workspaceMismatch = 'CRAWL_WORKSPACE_MISMATCH';

async function isWorkspaceMismatch(response: Response, limit: number, readTimeoutMs: number): Promise<boolean> {
    if (!response.body || response.body.locked ||
        response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json' ||
        Number(response.headers.get('content-length')) > limit) return false;

    const reader = response.body.getReader();
    const deadline = AbortSignal.timeout(readTimeoutMs);
    const cancel = () => { void reader.cancel().catch(() => {}); };
    deadline.addEventListener('abort', cancel, { once: true });
    const bytes = new Uint8Array(limit);
    let used = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value.byteLength > limit - used) return false;
            bytes.set(value, used);
            used += value.byteLength;
        }
        if (deadline.aborted) return false;
        const json: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, used)));
        return json !== null && typeof json === 'object' && 'err' in json && json.err === true &&
            'code' in json && json.code === workspaceMismatch;
    } catch {
        return false;
    } finally {
        deadline.removeEventListener('abort', cancel);
        if (!deadline.aborted) cancel();
        reader.releaseLock();
    }
}

function createCrawlFetch({ maxResponseBytes, baseURL, httpTimeoutMs }: Config): typeof globalThis.fetch {
    const limit = Math.min(4096, maxResponseBytes);
    // Leave time for the SDK to report the HTTP status when the error body stalls.
    const readTimeoutMs = Math.max(1, Math.min(100, Math.floor(httpTimeoutMs / 4)));
    const billing = new URL(baseURL).origin === 'https://api.nstdata.io'
        ? 'https://app.nstdata.io/billing/add-credits'
        : 'the Console for this environment';
    return async (input, init) => {
        const response = await globalThis.fetch(input, init);
        if (response.status === 402) {
            void response.body?.cancel().catch(() => {});
            throw new ToolFailure('UPSTREAM_ERROR',
                `The Crawl workspace has insufficient credits. Select that workspace in ${billing} and add credits, or contact its administrator for help.`,
                { statusCode: 402 });
        }
        // The Crawl SDK discards non-2xx bodies, including storage errors.
        if (response.status === 409 && await isWorkspaceMismatch(response, limit, readTimeoutMs)) {
            throw new ToolFailure(workspaceMismatch,
                'The API key does not match the active Crawl workspace. Use an API key for the intended workspace. For OAuth, reconnect using that key. No automatic retry was performed.',
                { statusCode: 409 });
        }
        return response;
    };
}

export function registerCrawlTools(server: McpServer, config: Config): void {
    const client = new NstDataClient(config.apiToken!, {
        baseURL: config.baseURL,
        fetch: createCrawlFetch(config),
    });
    server.registerTool('nstdata_crawl_read_result', {
        title: 'Read stored content',
        description: 'Read a Crawl storage reference. Returns a chunk that fits the output budget, at most 16000 units. Continue with the actual nextOffset until absent or the authorized budget is reached. Text offsets count Unicode code points; binary offsets count bytes. Each call downloads the reference once, within the response byte limit.',
        inputSchema: z.strictObject({
            ref: z.string().min(1).max(4096).describe('Copy the actual value of markdownRef, htmlRef, pdfRef, screenshotRef or rawDataRef into ref; do not use the output field name as an input key.'),
            format: z.enum(['markdown', 'html', 'pdf', 'screenshot', 'rawData']).describe('Must match the reference field: markdownRef uses markdown, htmlRef uses html, and so on.'),
            offset: z.number().int().min(0).default(0).describe('Start position: Unicode code points for markdown/html, bytes for binary formats. Use the preceding read result\'s nextOffset to continue.'),
            length: z.number().int().min(1).default(8000).describe('Requested positive safe-integer chunk length (default 8000): Unicode code points for markdown/html, or bytes for binary formats. Larger requests are capped at 16000 and may be shortened to fit the output budget. Use the returned nextOffset to continue.'),
        }),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    }, async (args, ctx) => guard(ctx, config, async options => {
        const bytes = Buffer.from(await client.readStorage(args.ref, options));
        const isText = args.format === 'markdown' || args.format === 'html';
        if (isText && !isUtf8(bytes)) throw new ToolFailure('INVALID_RESPONSE', 'The reference is not valid UTF-8. No text was returned.');
        const source = isText ? bytes.toString('utf8') : '';
        const maximum = Math.min(args.length, 16000);
        let total = bytes.length, text = '', start = args.offset;
        if (isText) {
            total = 0; start = source.length;
            let position = 0;
            for (const point of source) {
                if (total === args.offset) start = position;
                if (total >= args.offset && total < args.offset + maximum) text += point;
                total++;
                position += point.length;
            }
        }
        const points = [...text]; // Keep only the bounded window, not a code-point array of the whole reference.
        const secrets = configuredSecrets(config);
        const splitCredentialAt = (boundary: number) => {
            let first: number | undefined;
            for (const secret of secrets) {
                const size = isText ? secret.length : Buffer.byteLength(secret);
                const from = Math.max(0, boundary - size + 1);
                const found = isText ? source.slice(from, boundary + size - 1).indexOf(secret)
                    : bytes.subarray(from, boundary + size - 1).indexOf(secret, 0, 'utf8');
                if (found >= 0 && from + found < boundary) first = Math.min(first ?? boundary, from + found);
            }
            return first;
        };
        const sensitive = () => new ToolFailure('SENSITIVE_OUTPUT', 'A chunk boundary would expose part of configured credentials. No content was returned.');
        if (splitCredentialAt(start) !== undefined) throw sensitive();
        const available = Math.min(maximum, Math.max(0, total - args.offset));
        function chunk(length: number): CallToolResult {
            const end = Math.min(args.offset + length, total);
            const output = { format: args.format, encoding: isText ? 'utf-8' : 'base64', unit: isText ? 'codePoints' : 'bytes', offset: args.offset,
                ...(isText ? { text: points.slice(0, length).join('') } : { base64: bytes.subarray(args.offset, end).toString('base64') }),
                total, nextOffset: end < total ? end : undefined };
            return { content: [{ type: 'text', text: JSON.stringify(output) }], structuredContent: output };
        }
        const errorCode = (result: CallToolResult) => (result.structuredContent as { error?: { code?: string } } | undefined)?.error?.code;
        const boundary = (length: number) => isText ? start + points.slice(0, length).join('').length : args.offset + length;
        const safeLength = (length: number) => {
            let position = boundary(length);
            let split: number | undefined;
            while ((split = splitCredentialAt(position)) !== undefined) {
                if (!isText) { length = split - args.offset; position = split; }
                else {
                    while (length > 0 && position > split) position -= points[--length].length;
                }
            }
            return length;
        };
        const initial = chunk(available);
        const initialCode = errorCode(boundResult(initial, config));
        if (initialCode === 'SENSITIVE_OUTPUT') return initial;
        const maximumSafe = safeLength(available);
        if (available > 0 && maximumSafe === 0) throw sensitive();
        const safeInitial = maximumSafe === available ? initial : chunk(maximumSafe);
        if (errorCode(boundResult(safeInitial, config)) !== 'OUTPUT_LIMIT') return safeInitial;
        let low = 1, high = maximumSafe - 1, selected: CallToolResult | undefined;
        while (low <= high) {
            const midpoint = Math.floor((low + high) / 2);
            const length = safeLength(midpoint);
            if (length === 0) { low = midpoint + 1; continue; }
            const candidate = chunk(length);
            const code = errorCode(boundResult(candidate, config));
            if (code === 'SENSITIVE_OUTPUT') return candidate;
            if (code === 'OUTPUT_LIMIT') high = length - 1;
            else { selected = candidate; low = midpoint + 1; }
        }
        // Return raw data so the outer guard performs the actual redaction exactly once.
        if (selected) return selected;
        return safeInitial;
    }));
    server.registerTool('nstdata_crawl_start', {
        title: 'Start a website crawl',
        description: 'Start a bounded site crawl and return its task ID immediately.',
        inputSchema: z.strictObject({
            url: httpURL, formats, options: scrapeOptions,
            maxPages: z.number().int().min(1).max(config.maxCrawlPages).default(config.maxCrawlPages).describe('Page-count upper bound, not a guarantee of that many pages. Check actual returned URLs and per-page results.'),
            maxDepth: z.number().int().min(0).max(100).optional().describe('Optional service-side link-discovery depth limit; depth counting follows the Crawl service.'),
            includeUrls: z.array(z.string().max(8192)).max(100).optional().describe('Optional service-side include filters for discovered links. These are not extra seed URLs or a batch scrape list.'),
            excludeUrls: z.array(z.string().max(8192)).max(100).optional().describe('Optional service-side exclude filters for discovered links.'),
            ignoreQuery: z.boolean().optional().describe('Optional service-side query-string handling setting.'),
        }),
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    }, async (args, ctx) => guard(ctx, config, async options => {
        const { options: advanced, ...request } = args;
        const output = await client.submitCrawlTask({ ...request, ...advanced }, options);
        requireSubmissionId(output);
        return { content: [{ type: 'text', text: JSON.stringify(output) }], structuredContent: { ...output }, isError: taskFailed(output) };
    }, 'task'));
    server.registerTool('nstdata_crawl_status', {
        title: 'Check crawl progress',
        description: 'Read aggregate crawl progress without polling.',
        inputSchema: z.strictObject({ crawlId: identifier.describe('Actual id returned by nstdata_crawl_start; reuse the existing task instead of submitting another crawl.') }),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    }, async (args, ctx) => guard(ctx, config, async options => {
        const output = { ...await client.getCrawlStatus(args.crawlId, options), crawlId: args.crawlId };
        return { content: [{ type: 'text', text: JSON.stringify(output) }], structuredContent: { ...output }, isError: taskFailed(output) };
    }));
    server.registerTool('nstdata_crawl_pages', {
        title: 'List crawl pages',
        description: 'Read one page of crawl results without downloading referenced files. On OUTPUT_LIMIT, retry the same input cursor with a smaller limit. A single-row error may retain recovery.page references; handle that page before using recovery.continuation.',
        inputSchema: z.strictObject({
            crawlId: identifier.describe('Actual id of the existing site crawl.'),
            afterCursor: z.string().min(1).max(8192).optional().describe('Copy nextCursor from a successful page read. On OUTPUT_LIMIT, keep the original input cursor. Only use recovery.continuation.nextCursor after handling recovery.page. Mutually exclusive with beforeCursor.'),
            beforeCursor: z.string().min(1).max(8192).optional().describe('Copy prevCursor from a successful read, or recovery.continuation.prevCursor after handling recovery.page. On OUTPUT_LIMIT keep the original input cursor; do not combine with afterCursor.'),
            limit: z.number().int().min(1).max(100).default(10).describe('Maximum rows in this response. Reduce down to 1 on OUTPUT_LIMIT; a single row may still exceed the output cap.'),
        }).refine(args => !(args.afterCursor && args.beforeCursor)),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    }, async ({ crawlId, ...pageOptions }, ctx) => guard(ctx, config, async options => {
        const result = await client.listCrawlPages(crawlId, pageOptions, options);
        const output = { ...result, crawlId, data: result.data && await Promise.all(result.data.map(async page => ({
            ...page, data: await serializeData(page.data, options),
        }))) };
        return { content: [{ type: 'text', text: JSON.stringify(output) }], structuredContent: output };
    }));
    server.registerTool('nstdata_crawl_scrape', {
        title: 'Scrape a webpage',
        description: 'Retrieve a webpage through Nstdata Crawl. Creates a potentially billable scrape task.',
        inputSchema: z.strictObject({
            url: httpURL, formats, options: scrapeOptions,
            mode: z.enum(['sync', 'async']).default('sync').describe('sync waits for the single-page response; async returns a task id to resume with nstdata_crawl_scrape_result. Neither mode retries submission.'),
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
        title: 'Read a scrape result',
        description: 'Resume a submitted single-page task. Processing is not completion; a failed or expired task is reported explicitly.',
        inputSchema: z.strictObject({ taskId: identifier.describe('Actual id returned by an existing single-page submission; not a site crawl id or a storage reference.') }),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
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
