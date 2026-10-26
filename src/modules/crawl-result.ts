import { NstDataApiError, type ScrapeDataDto, type RequestOptions } from '@nstdata-ai/crawl';
import { binaryContent } from '../shared/output.js';
import { identifier } from './crawl-schema.js';

export function taskFailed(result: { status?: string; success?: boolean }): boolean {
    return result.success === false || result.status === 'failed' || result.status === 'expired';
}

export function requireSubmissionId(result: { id?: string; status?: string; success?: boolean }): void {
    if (taskFailed(result)) return;
    const parsed = identifier.safeParse(result.id);
    if (!parsed.success || parsed.data !== result.id) throw new NstDataApiError('API error: unusable submission ID');
}

/** References stay lazy; only read_result downloads storage content. */
export async function serializeData(data: ScrapeDataDto | null | undefined, options: RequestOptions): Promise<Record<string, unknown> | undefined> {
    if (!data) return undefined;
    return {
        markdown: data.markdownRef ? undefined : await data.getMarkdown(options),
        html: data.htmlRef ? undefined : await data.getHtml(options),
        pdf: data.pdfRef ? undefined : binaryContent(await data.getPdf(options)),
        screenshot: data.screenshotRef ? undefined : binaryContent(await data.getScreenshot(options)),
        rawData: data.rawDataRef ? undefined : binaryContent(await data.getRawData(options)),
        links: data.links, metadata: data.metadata, truncated: data.truncated,
        markdownRef: data.markdownRef, htmlRef: data.htmlRef, pdfRef: data.pdfRef,
        screenshotRef: data.screenshotRef, rawDataRef: data.rawDataRef,
    };
}
