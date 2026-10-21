import { type ScrapeDataDto, type RequestOptions } from '@nstdata-ai/crawl';
import { binaryContent } from '../shared/output.js';

export function taskFailed(result: { status?: string; success?: boolean }): boolean {
    return result.success === false || result.status === 'failed' || result.status === 'expired';
}

/** References stay lazy; only read_result downloads storage content. */
export async function serializeData(data: ScrapeDataDto | undefined, options: RequestOptions): Promise<Record<string, unknown> | undefined> {
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
