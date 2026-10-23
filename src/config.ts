import { z } from 'zod';
import { isAbsolute } from 'node:path';

const configuration = z.strictObject({
    apiToken: z.string().trim().min(1).optional(),
    baseURL: z.url().refine(value => {
        try {
            const url = new URL(value);
            return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
        } catch { return false; }
    }),
    modules: z.enum(['crawl', 'proxy', 'crawl,proxy', 'proxy,crawl']),
    proxyURL: z.url().max(8192).refine(value => {
        try {
            const url = new URL(value);
            decodeURIComponent(url.username); decodeURIComponent(url.password);
            return ['http:', 'https:'].includes(url.protocol) && url.pathname === '/' && !url.search && !url.hash;
        } catch { return false; }
    }).optional(),
    proxyCheckURL: z.url().max(8192).refine(value => {
        try {
            const url = new URL(value);
            return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
        } catch { return false; }
    }).optional(),
    proxyCAFile: z.string().min(1).max(4096).refine(isAbsolute).optional(),
    httpTimeoutMs: z.coerce.number().int().min(1).max(600000).default(120000),
    maxResponseBytes: z.coerce.number().int().min(256).max(67108864).default(8388608),
    maxOutputChars: z.coerce.number().int().min(1024).max(64000).default(16000),
    maxCrawlPages: z.coerce.number().int().min(1).max(1000).default(10),
}).superRefine((config, ctx) => {
    if (config.modules.includes('crawl') && !config.apiToken) ctx.addIssue({ code: 'custom', path: ['apiToken'], message: 'Required for crawl' });
    if (config.modules.includes('proxy')) {
        if (!config.proxyURL) ctx.addIssue({ code: 'custom', path: ['proxyURL'], message: 'Required for proxy' });
        if (!config.proxyCheckURL) ctx.addIssue({ code: 'custom', path: ['proxyCheckURL'], message: 'Required for proxy' });
    }
});

export type Config = z.infer<typeof configuration>;

export function validateConfig(input: unknown): Config {
    const result = configuration.safeParse(input);
    if (!result.success) {
        throw new Error(`Invalid configuration: ${[...new Set(result.error.issues.map(issue => issue.path.join('.')))].join(', ')}`);
    }
    return result.data;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
    const modules = env.NSTDATA_MODULES ?? 'crawl';
    return validateConfig({
        apiToken: modules.includes('crawl') ? env.NSTDATA_API_TOKEN : undefined,
        baseURL: modules.includes('crawl') ? env.NSTDATA_API_BASE_URL ?? 'https://api.nstdata.io' : 'https://api.nstdata.io',
        modules,
        proxyURL: modules.includes('proxy') ? env.NSTDATA_PROXY_URL : undefined,
        proxyCheckURL: modules.includes('proxy') ? env.NSTDATA_PROXY_CHECK_URL : undefined,
        proxyCAFile: modules.includes('proxy') ? env.NSTDATA_PROXY_CA_FILE : undefined,
        httpTimeoutMs: env.NSTDATA_HTTP_TIMEOUT_MS,
        maxResponseBytes: env.NSTDATA_MAX_RESPONSE_BYTES,
        maxOutputChars: env.NSTDATA_MAX_OUTPUT_CHARS,
        maxCrawlPages: modules.includes('crawl') ? env.NSTDATA_MAX_CRAWL_PAGES : undefined,
    });
}
