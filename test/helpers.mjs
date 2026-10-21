import http from 'node:http';
import { once } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

export const cli = process.env.NSTDATA_TEST_CLI ?? fileURLToPath(new URL('../dist/stdio.js', import.meta.url));
export const envelope = data => ({ code: 200, err: false, msg: 'SUCCESS', data });

export async function harness(t, handler, settings = {}, era = 'legacy', executable = cli) {
    const requests = [];
    const sockets = new Set();
    const api = http.createServer(async (req, res) => {
        let body = '';
        for await (const chunk of req) body += chunk;
        requests.push({ url: req.url, method: req.method, headers: req.headers, body: body ? JSON.parse(body) : undefined });
        try { await handler(req, res, requests); }
        catch { res.writeHead(500); res.end('fixture error'); }
    });
    api.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    api.listen(0, '127.0.0.1');
    await once(api, 'listening');
    const transport = new StdioClientTransport({
        command: process.execPath, args: [executable], stderr: 'pipe',
        env: { NSTDATA_API_TOKEN: 'fixture-token', NSTDATA_API_BASE_URL: `http://127.0.0.1:${api.address().port}`,
            ...(typeof settings === 'function' ? settings(`http://127.0.0.1:${api.address().port}`) : settings) },
    });
    let stderr = '';
    transport.stderr?.on('data', chunk => { stderr += chunk; });
    const client = new Client({ name: 'offline-acceptance', version: '1.0.0' }, {
        versionNegotiation: { mode: era === 'legacy' ? 'legacy' : { pin: '2026-07-28' } },
    });
    t.after(async () => {
        await client.close();
        const closed = new Promise(resolve => api.close(resolve));
        api.closeAllConnections();
        for (const socket of sockets) socket.destroy();
        await closed;
    });
    await client.connect(transport);
    return { client, requests, transport, stderr: () => stderr };
}

export function json(res, data, status = 200) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
}

export async function inMemoryClient(t, settings) {
    const { createServer, loadConfig } = await import(new URL('./server.js', pathToFileURL(cli)));
    const server = createServer(loadConfig(settings));
    const client = new Client({ name: 'offline-phase-regression', version: '1.0.0' }, { versionNegotiation: { mode: 'legacy' } });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    t.after(async () => { await client.close(); await server.close(); });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return client;
}
