import { z } from 'zod';

const text = z.string().min(1).max(8192);
const selector = text;
const milliseconds = z.number().int().min(0).max(600000);
export const httpURL = z.url().max(8192).refine(value => {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
}, 'Use an HTTP(S) URL without embedded credentials');
export const identifier = z.string().trim().min(1).max(256)
    .refine(value => value !== '.' && value !== '..', 'Task IDs must not be . or ..');
export const formats = z.array(z.enum(['markdown', 'html', 'links', 'pdf', 'screenshot', 'rawData'])).min(1).max(6).default(['markdown']);

const action = z.discriminatedUnion('type', [
    z.strictObject({ type: z.literal('click'), selector, waitSelector: selector.optional() }),
    z.strictObject({ type: z.literal('wait'), milliseconds }),
    z.strictObject({ type: z.literal('waitSelector'), selector, milliseconds: milliseconds.optional() }),
    z.strictObject({ type: z.literal('scrollX'), x: z.number().int(), text: text.optional() }),
    z.strictObject({ type: z.literal('scrollY'), y: z.number().int(), text: text.optional() }),
    z.strictObject({ type: z.literal('scrollTo'), selector }),
    z.strictObject({ type: z.literal('fill'), selector, text: z.string().max(8192) }),
    z.strictObject({ type: z.literal('execute'), execute: text }),
    z.strictObject({ type: z.literal('screenshot'), fullScreenshot: z.boolean().optional(), particularScreenshot: selector.optional() }),
    z.strictObject({ type: z.literal('waitForRequestCompletion'), urlPattern: text, milliseconds: milliseconds.optional() }),
]);

export const scrapeOptions = z.strictObject({
    cookies: z.array(z.strictObject({ domain: text.optional(), httpOnly: z.boolean().optional(), name: text,
        path: text.optional(), secure: z.boolean().optional(), value: z.string().max(8192) })).max(100).optional(),
    proxy: z.strictObject({ country: z.string().regex(/^[a-zA-Z]{2}$/) }).optional(),
    headers: z.record(z.string().min(1).max(256), z.string().max(8192)).refine(value => Object.keys(value).length <= 100).optional(),
    excludeTags: z.array(text).max(100).optional(),
    includeTags: z.array(text).max(100).optional(),
    jsRender: z.strictObject({ actions: z.array(action).max(100).optional(), waitFor: z.number().int().min(1000).max(30000).optional(), waitForSelector: selector.optional() }).optional(),
    mobile: z.boolean().optional(),
    onlyMainContent: z.boolean().optional(),
    removeSelectors: z.array(selector).max(100).optional(),
    targetSelector: selector.optional(),
    timeout: z.number().int().min(1000).max(60000).optional(),
}).default({});
