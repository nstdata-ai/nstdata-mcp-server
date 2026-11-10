import type { IncomingMessage } from 'node:http';
import { BlockList, isIP } from 'node:net';

/** Restrict trust to the direct proxy peer, never addresses claimed in forwarded headers. */
export function trustedProxyPeers(cidrs: readonly string[] | undefined): BlockList | undefined {
    if (cidrs === undefined) return undefined;
    if (!Array.isArray(cidrs) || cidrs.length < 1 || cidrs.length > 32 || new Set(cidrs).size !== cidrs.length) throw new Error();
    const peers = new BlockList();
    for (const entry of cidrs) {
        if (typeof entry !== 'string' || entry.length > 64 || entry.includes('%')) throw new Error();
        const [address, prefix, extra] = entry.split('/');
        const version = isIP(address);
        if (!version || extra !== undefined) throw new Error();
        const bits = version === 4 ? 32 : 128;
        const length = prefix === undefined ? bits : Number(prefix);
        if ((prefix !== undefined && !/^[1-9][0-9]*$/.test(prefix)) || length < 1 || length > bits) throw new Error();
        let number: bigint;
        if (version === 4) number = address.split('.').reduce((value, octet) => value * 256n + BigInt(octet), 0n);
        else {
            const normalized = new URL(`http://[${address}]/`).hostname.slice(1, -1);
            const [left, right] = normalized.split('::');
            const start = left ? left.split(':') : [], end = right ? right.split(':') : [];
            const groups = right === undefined ? start : [...start, ...Array(8 - start.length - end.length).fill('0'), ...end];
            number = BigInt('0x' + groups.map(group => group.padStart(4, '0')).join(''));
        }
        const hostBits = BigInt(bits - length);
        const hostMask = (1n << hostBits) - 1n;
        if (number & hostMask) throw new Error();
        // IPv6 rules covering the mapped range would also trust unrelated IPv4 peers.
        if (version === 6 && number <= (0xffffn << 32n) + 0xffffffffn && number + hostMask >= (0xffffn << 32n)) throw new Error();
        peers.addSubnet(address, length, version === 4 ? 'ipv4' : 'ipv6');
    }
    return peers;
}

export function createRemoteRequestPolicy(issuerUrl: string, cidrs?: readonly string[]): (request: IncomingMessage, health?: boolean) => boolean {
    const issuer = new URL(issuerUrl);
    const peers = trustedProxyPeers(cidrs);
    if (peers && issuer.protocol !== 'https:') throw new Error();
    return (request, health = false) => {
        const counts = new Map<string, number>();
        for (let index = 0; index < request.rawHeaders.length; index += 2) {
            const name = request.rawHeaders[index].toLowerCase();
            counts.set(name, (counts.get(name) ?? 0) + 1);
        }
        if (counts.get('host') !== 1 || ['forwarded', 'x-forwarded-host', 'x-forwarded-port'].some(name => counts.has(name))) return false;
        const host = request.headers.host?.toLowerCase();
        const exactHost = host === issuer.host.toLowerCase();
        if (health && !counts.has('x-forwarded-proto')) {
            // Load-balancer health probes may address the Pod IP instead of its public authority.
            const literal = /^(?:\[([^\]]+)\]|([^:]+))(?::([0-9]+))?$/.exec(host ?? '');
            return exactHost || !!literal && !!isIP(literal[1] ?? literal[2]) &&
                (literal[3] === undefined || /^[1-9][0-9]{0,4}$/.test(literal[3]) && Number(literal[3]) <= 65535);
        }
        if (!exactHost) return false;
        if (!peers) return !counts.has('x-forwarded-proto') &&
            (issuer.protocol !== 'https:' || (request.socket as { encrypted?: boolean }).encrypted === true);
        const address = request.socket.remoteAddress;
        const version = address && isIP(address);
        return !!version && peers.check(address!, version === 4 ? 'ipv4' : 'ipv6') &&
            counts.get('x-forwarded-proto') === 1 && request.headers['x-forwarded-proto'] === 'https';
    };
}
