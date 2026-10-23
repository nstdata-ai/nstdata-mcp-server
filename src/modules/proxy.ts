import { type McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { isIP } from 'node:net';
import { isUtf8 } from 'node:buffer';
import { validateHeaderName, validateHeaderValue } from 'node:http';
import { type Config } from '../config.js';
import { guard, ToolFailure } from '../shared/errors.js';
import { createProxyTransport } from '@nstdata-ai/proxy-checker/transport';

const reservedHeaders = new Set(['host', 'connection', 'proxy-authorization', 'proxy-authenticate', 'proxy-connection', 'transfer-encoding', 'content-length', 'upgrade', 'te', 'trailer', 'keep-alive']);
const targetHeaders = z.record(z.string().min(1).max(256), z.string().max(8192)).refine(headers => {
    if (Object.keys(headers).length > 100) return false;
    try {
        for (const [key, value] of Object.entries(headers)) {
            if (reservedHeaders.has(key.toLowerCase())) return false;
            validateHeaderName(key); validateHeaderValue(key, value);
        }
        return true;
    } catch { return false; }
}, 'Invalid target headers or reserved connection/proxy header');

export function registerProxyTools(server: McpServer, config: Config): void {
    const transport = createProxyTransport({ proxyURL: config.proxyURL!, timeoutMs: config.httpTimeoutMs,
        maxResponseBytes: config.maxResponseBytes, caFile: config.proxyCAFile });
    server.registerTool('nstdata_proxy_fetch', {
        description: 'Read an HTTP(S) page through the configured proxy. Does not follow redirects or retry; may consume billable traffic.',
        inputSchema: z.strictObject({
            url: z.url().max(8192).refine(value => { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password; }),
            method: z.enum(['GET', 'HEAD']).default('GET'),
            format: z.enum(['text', 'base64']).default('text'),
            headers: targetHeaders.optional(),
        }),
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    }, async (args, ctx) => guard(ctx, config, async options => {
        const response = await transport.request(args, { signal: options.signal });
        if (args.format === 'text' && !isUtf8(response.body)) throw new ToolFailure('INVALID_RESPONSE', 'The response is not valid UTF-8. Use base64 to read binary content.');
        const output = { statusCode: response.statusCode, encoding: args.format === 'text' ? 'utf-8' : 'base64',
            body: response.body.toString(args.format === 'text' ? 'utf8' : 'base64'),
            headers: { 'content-type': response.headers['content-type'], location: response.headers.location, 'retry-after': response.headers['retry-after'] } };
        return { content: [{ type: 'text', text: JSON.stringify(output) }], structuredContent: output,
            isError: response.statusCode < 200 || response.statusCode >= 300 };
    }));
    server.registerTool('nstdata_proxy_check', {
        description: 'Check the operator-configured target through the proxy, once.',
        inputSchema: z.strictObject({}),
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    }, async (_args, ctx) => guard(ctx, config, async options => {
        const started = performance.now();
        const response = await transport.request({ url: config.proxyCheckURL!, method: 'GET' }, { signal: options.signal });
        const text = response.body.toString('utf8').trim();
        let address: unknown = text;
        try { address = (JSON.parse(text) as { ip?: unknown } | null)?.ip; } catch { /* Plain IP responses are also supported. */ }
        const output = { statusCode: response.statusCode, elapsedMs: performance.now() - started,
            observedIp: typeof address === 'string' && isIP(address) ? address : undefined };
        return { content: [{ type: 'text', text: JSON.stringify(output) }], structuredContent: output,
            isError: response.statusCode < 200 || response.statusCode >= 300 };
    }));
}
