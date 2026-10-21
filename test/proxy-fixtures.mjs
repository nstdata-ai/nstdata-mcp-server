import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function tlsMaterial(t, { san = 'DNS:localhost,IP:127.0.0.1', commonName = 'localhost' } = {}) {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'nstdata-proxy-tls-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const keyFile = path.join(dir, 'key.pem'), certFile = path.join(dir, 'cert.pem');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyFile, '-out', certFile,
        '-days', '1', '-subj', `/CN=${commonName}`, '-addext', `subjectAltName=${san}`,
        '-addext', 'basicConstraints=critical,CA:TRUE'], { stdio: 'pipe', timeout: 10000 });
    return { key: readFileSync(keyFile), cert: readFileSync(certFile), certFile };
}

export async function listen(t, server) {
    const sockets = new Set();
    server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(async () => {
        const closed = new Promise(resolve => server.close(resolve));
        for (const socket of sockets) socket.destroy();
        await closed;
    });
    return server.address().port;
}

export async function proxyFixture(t, options = {}) {
    const requests = [], connections = [];
    const handler = (req, res) => {
        requests.push({ url: req.url, headers: req.headers });
        const url = new URL(req.url);
        const headers = { ...req.headers }; delete headers['proxy-authorization']; delete headers['proxy-connection'];
        const upstream = http.request(url, { headers }, response => { res.writeHead(response.statusCode, response.headers); response.pipe(res); });
        upstream.on('error', () => { res.writeHead(502); res.end(); });
        req.pipe(upstream);
    };
    const proxy = options.tls ? https.createServer(options.tls, handler) : http.createServer(handler);
    proxy.on('connect', (req, client, head) => {
        let closed;
        const connection = { authority: req.url, headers: req.headers, closed: new Promise(resolve => { closed = resolve; }) };
        connections.push(connection);
        client.on('close', closed);
        options.onConnect?.(connection);
        if (options.largeConnectHeaders) {
            client.write(`HTTP/1.1 200 OK\r\nX-Oversized: ${'x'.repeat(20000)}`);
            client.on('end', () => client.end()); client.resume(); return;
        }
        if (options.hangConnect) { client.on('end', () => client.end()); client.resume(); return; }
        if (options.connectStatus) { client.end(`HTTP/1.1 ${options.connectStatus} Denied\r\nContent-Length: 0\r\n\r\n`); return; }
        const port = Number(req.url.slice(req.url.lastIndexOf(':') + 1));
        const upstream = net.connect(port, '127.0.0.1', () => {
            client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            if (head.length) upstream.write(head);
            upstream.pipe(client); client.pipe(upstream);
        });
        upstream.on('error', () => client.destroy());
        client.on('error', () => upstream.destroy());
        client.on('close', () => upstream.destroy());
        upstream.on('close', () => client.destroy());
    });
    const port = await listen(t, proxy);
    return { url: `${options.tls ? 'https' : 'http'}://fixture-user:fixture-password@127.0.0.1:${port}`, requests, connections };
}
