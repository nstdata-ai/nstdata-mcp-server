import { NstDataApiError, type RequestOptions } from '@nstdata-ai/crawl';
import { type CallToolResult, type ServerContext } from '@modelcontextprotocol/server';
import { type Config } from '../config.js';
import { ProxyTransportError } from '@nstdata-ai/proxy-checker/transport';
import { boundResult } from './output.js';

export class ToolFailure extends Error {
    constructor(readonly code: string, message: string, readonly details: Record<string, unknown> = {}) {
        super(message);
        this.name = 'ToolFailure';
    }
}

export function toolError(code: string, message: string, details: Record<string, unknown> = {}): CallToolResult {
    const output = { error: { code, message, ...details } };
    return { isError: true, content: [{ type: 'text', text: JSON.stringify(output) }], structuredContent: output };
}

export async function guard(ctx: ServerContext, config: Config, operation: (options: RequestOptions) => Promise<CallToolResult>, operationKind: 'request' | 'task' = 'request'): Promise<CallToolResult> {
    const unknownSubmission = operationKind === 'task'
        ? ' The submission outcome is unknown; a remote task may still exist. Review it before submitting again.' : '';
    const controller = new AbortController();
    const abort = () => controller.abort(new DOMException('Local request cancelled', 'AbortError'));
    if (ctx.mcpReq.signal.aborted) abort();
    else ctx.mcpReq.signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(new DOMException('Tool deadline exceeded', 'TimeoutError')), config.httpTimeoutMs);
    try { return boundResult(await operation({ signal: controller.signal, timeoutMs: config.httpTimeoutMs, maxResponseBytes: config.maxResponseBytes }), config); }
    catch (error) {
        if (error instanceof ToolFailure) return toolError(error.code, error.message, error.details);
        if (error instanceof NstDataApiError && error.message === 'Response exceeds configured maxResponseBytes') {
            return toolError('RESPONSE_LIMIT', 'The response exceeds the configured byte limit. No automatic retry was performed.' + unknownSubmission);
        }
        if (controller.signal.aborted || (error instanceof Error && error.name === 'TimeoutError') ||
            (error instanceof ProxyTransportError && ['TIMEOUT', 'CANCELLED'].includes(error.code))) {
            const message = 'Local request stopped. No automatic retry was performed.'
                + (operationKind === 'task' ? ' Any submitted remote task may still run; check its status before submitting again.' : '');
            return toolError(error instanceof ProxyTransportError ? error.code : controller.signal.reason?.name === 'AbortError' ? 'CANCELLED' : 'TIMEOUT', message);
        }
        if (error instanceof ProxyTransportError) return toolError(error.code, error.message, error.details);
        const statusCode = error instanceof NstDataApiError ? error.statusCode : undefined;
        const apiCode = error instanceof NstDataApiError ? error.code : undefined;
        const classification = statusCode !== undefined && statusCode >= 400 ? statusCode : apiCode;
        const code = classification === 401 || classification === 403 ? 'AUTHORIZATION_FAILED'
            : classification === 429 ? 'RATE_LIMITED' : 'UPSTREAM_ERROR';
        const message = 'The request failed. No automatic retry was performed.'
            + (code === 'UPSTREAM_ERROR' && !(classification !== undefined && classification >= 400 && classification < 500) ? unknownSubmission : '');
        return toolError(code, message, { statusCode, apiCode });
    } finally {
        clearTimeout(timer);
        ctx.mcpReq.signal.removeEventListener('abort', abort);
    }
}
