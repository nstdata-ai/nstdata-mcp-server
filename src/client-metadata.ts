import { lookup } from 'node:dns';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';
import type { Configuration } from 'oidc-provider';

const excluded = new BlockList();
for (const [ip, bits] of [
    ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
    ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
    ['192.31.196.0', 24], ['192.52.193.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
    ['192.175.48.0', 24], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3],
] as const) excluded.addSubnet(ip, bits, 'ipv4');
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
for (const [ip, bits] of [
    ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['2620:4f:8000::', 48], ['3fff::', 20],
] as const) excluded.addSubnet(ip, bits, 'ipv6');

/** Only globally routable metadata destinations; mapped and transition addresses are excluded. */
export function isPublicMetadataAddress(address: string): boolean {
    const family = isIP(address);
    return family === 4 ? !excluded.check(address, 'ipv4')
        : family === 6 && globalV6.check(address, 'ipv6') && !excluded.check(address, 'ipv6');
}

export function metadataUrl(value: string): URL {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search ||
        (url.port && url.port !== '443') || url.href !== value || value.length > 2048) throw new Error('Invalid client metadata URL');
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (isIP(host) && !isPublicMetadataAddress(host)) throw new Error('Invalid client metadata URL');
    return url;
}

/** Own the socket lookup rather than relying on the provider's optional fetch dispatcher. */
export function createClientMetadataFetch(): NonNullable<Configuration['fetch']> {
    let active = 0;
    return async (input, init) => {
        const url = metadataUrl(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
        if (active >= 8 || (init?.method && init.method !== 'GET')) throw new Error('Client metadata unavailable');
        const signal = AbortSignal.any([AbortSignal.timeout(2500), ...(init?.signal ? [init.signal] : [])]);
        signal.throwIfAborted();
        active++;
        try {
            return await new Promise<Response>((resolve, reject) => {
                const fail = () => reject(new Error('Client metadata unavailable'));
                const req = httpsRequest(url, {
                    method: 'GET', agent: false, signal, headers: { Accept: 'application/json', 'Accept-Encoding': 'identity' },
                    lookup(hostname, options, callback) {
                        lookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
                            if (error || !addresses.length || addresses.some(value => !isPublicMetadataAddress(value.address))) {
                                callback(new Error('Client metadata unavailable'), []); return;
                            }
                            // DNS results are supplied directly to this connection, not checked and resolved again.
                            if (options.all) callback(null, addresses);
                            else callback(null, addresses[0].address, addresses[0].family);
                        });
                    },
                }, response => {
                    const chunks: Buffer[] = [];
                    let size = 0;
                    if (response.statusCode !== 200 || (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') ||
                        Number(response.headers['content-length'] ?? 0) > 32_768) {
                        response.destroy(); req.destroy(); fail(); return;
                    }
                    response.on('data', (chunk: Buffer) => {
                        size += chunk.length;
                        if (size > 32_768) { response.destroy(); req.destroy(); fail(); }
                        else chunks.push(chunk);
                    });
                    response.on('error', fail);
                    response.on('end', () => {
                        if (signal.aborted || !response.complete) { fail(); return; }
                        const headers = new Headers();
                        for (const name of ['content-type', 'cache-control', 'expires']) {
                            const value = response.headers[name];
                            if (typeof value === 'string') headers.set(name, value);
                        }
                        resolve(new Response(Buffer.concat(chunks), { status: 200, headers }));
                    });
                });
                req.on('socket', socket => socket.once('connect', () => {
                    if (!socket.remoteAddress || !isPublicMetadataAddress(socket.remoteAddress)) req.destroy(new Error('Client metadata unavailable'));
                }));
                req.on('error', fail);
                req.end();
            });
        } finally { active--; }
    };
}
