# Self-hosted Remote MCP

[中文](remote_zh.md) · [Local client setup](../README.md)

Run the Crawl tools behind an HTTPS MCP endpoint with per-user OAuth authorization. Each user enters their existing Nstdata API key on the consent page; calls use that user's credits. Do not configure a shared `NSTDATA_API_TOKEN` for this service. Proxy tools remain available through the separate local stdio configuration.

Remote is a separate application built from this repository. It is not included in the published `@nstdata-ai/mcp-server@1.0.2` package; the npm package's installation and client configuration remain unchanged.

## Deployment requirements

- Node.js 22.18+ in the 22.x line, or Node.js 24; a stable HTTPS origin and its matching PEM certificate/private key.
- Standalone Redis with persistent storage, `noeviction`, an isolated namespace and the adapter's required key/Lua permissions. Use verified TLS (`rediss:`) or a protected local Unix socket. Cluster and Sentinel are not supported.
- Fixed OAuth client IDs, secrets and exact callback URLs registered with the target platform. The service requires `client_secret_basic` and S256 PKCE; dynamic registration is disabled.

TLS terminates in this Node process. A layer-4 passthrough load balancer can preserve that connection. HTTP forwarding after TLS termination and `Forwarded`/`X-Forwarded-*` authority headers are rejected. Keep the configured issuer, resource and callback URLs stable across restarts.

## Build and configure

From the repository root:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run build:remote
npm --prefix remote ci --omit=dev --ignore-scripts
```

The build compiles the shared source into `remote/dist`; `remote/package.json` and its lock install the application's runtime dependencies separately. The root `npm run build` builds only the local stdio package. The Remote manifest sets `private: true` to prevent npm publication; its source remains in this repository.

Store the configuration outside the repository. On Linux/macOS, its regular file and the TLS private-key file must have no group/other permission bits; use `0600` or `0400`. The configuration must be valid UTF-8 JSON, at most 1 MiB, and use an absolute filename. Mounted secret-file symlinks are supported.

To generate independent signing, cookie, encryption and fingerprint keys once, save this program as `create-remote-config.mjs` outside the repository:

```js
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';

const filename = process.argv[2];
if (!filename || !isAbsolute(filename)) throw new Error('Use an absolute output filename.');
const secret = () => randomBytes(32).toString('base64url');
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const config = {
  issuerUrl: 'https://mcp.example.com',
  listen: {
    host: '0.0.0.0', port: 8443,
    tls: { certFile: '/absolute/path/server.crt', keyFile: '/absolute/path/server.key' }
  },
  redis: {
    url: 'rediss://USER:PASSWORD@redis.example.com:6379/0',
    namespace: 'production'
  },
  clients: [{
    clientId: 'platform-client', clientSecret: secret(), name: 'Configured platform',
    redirectUris: ['https://client.example.com/oauth/callback']
  }],
  cookieKeys: [secret()],
  jwks: { keys: [{
    ...privateKey.export({ format: 'jwk' }), kid: 'signing-1', use: 'sig', alg: 'RS256'
  }] },
  encryptionKeys: { 'encryption-1': secret() },
  currentKeyId: 'encryption-1', fingerprintKey: secret(), allowedOrigins: []
};
writeFileSync(filename, JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log('Remote configuration created.');
```

Run it once, using an existing protected directory:

```sh
node create-remote-config.mjs /absolute/path/remote.json
```

The program refuses to overwrite an existing file and does not print secrets. Edit the protected JSON to supply the real issuer, listen port, certificate paths, encoded Redis credentials, client ID and exact callbacks. Copy the corresponding `clientSecret` only into the platform's protected OAuth configuration. Do not regenerate keys on restart.

| Field | Configuration rule |
|---|---|
| `issuerUrl` | HTTPS origin without a path; the MCP resource is this origin plus `/mcp` |
| `listen` | Numeric IP and port `1–65535`; HTTPS requires `tls.certFile` and `tls.keyFile` |
| `redis` | Exactly one `url` or absolute `socketPath`, plus a distinct namespace per environment |
| `clients` | Pre-registered client IDs, secrets of at least 32 bytes, and exact callback URLs |
| `cookieKeys` | Stable secrets of at least 32 bytes; put the current key first |
| `jwks.keys` | Private signing JWKs with unique `kid`, `use: "sig"` and a matching supported algorithm |
| `encryptionKeys`, `currentKeyId` | Named 32-byte base64url keys and the current encryption key's ID |
| `fingerprintKey` | Independent stable 32-byte base64url key; changing it requires a new namespace |
| `allowedOrigins` | Optional exact browser origins; no wildcards. Non-browser requests may omit Origin |

For loopback development only, an HTTP issuer can use literal `127.0.0.1` or `[::1]`, with the same loopback listen address and port and no TLS configuration. Plain `redis:` URLs are also restricted to literal loopback addresses. Do not expose that configuration publicly.

## Validate and start

```sh
node remote/dist/remote.js --config /absolute/path/remote.json --check
node remote/dist/remote.js --config /absolute/path/remote.json
```

`--check` validates the configuration, TLS files and certificate/key match without connecting to Redis, listening or calling Nstdata. Successful validation does not prove DNS, certificate trust, Redis ACLs or platform compatibility.

Startup connects to Redis and requires a successful `PING` before listening. Connection setup has a 5-second deadline; commands have a 2-second deadline. A Redis failure or deadline stops the service without automatic reconnect or command replay. A timed-out write may already have executed: investigate before retrying authorization operations.

Each process accepts at most 256 concurrent connections, 32 active business requests and 64 in-flight Redis commands. Excess work is rejected without queuing or retrying; reaching these capacity limits does not stop the service. TLS handshakes and request headers have 10-second deadlines; request handling is bounded to 130 seconds. Set deployment traffic limits to match capacity before opening public access.

| Endpoint | Meaning |
|---|---|
| `GET /health/live` | Process is serving requests |
| `GET /health/ready` | Startup completed and the Redis client is locally ready |
| `/mcp` | Authenticated Streamable HTTP MCP resource with six Crawl tools |

Use the issuer's Host when probing. Health checks do not query Redis each time and do not prove persistence, Lua permissions, upstream access or platform authorization. An unauthenticated `/mcp` request returns an OAuth challenge; it is not a readiness check.

## Run in a container

From the repository root:

```sh
docker build --file Dockerfile.remote --tag nstdata-mcp-remote:local .
```

The image uses Node.js 24.22.0, runs as the nonroot `node` user (UID 1000) by default, and starts `node dist/remote.js` in `/app`. It contains only the compiled Remote application and its production dependencies.

For a local Linux/macOS run, place `remote.json`, `server.crt` and `server.key` in the protected directory below. Set the configuration's TLS paths to `/run/secrets/server.crt` and `/run/secrets/server.key`. Run these commands as the nonroot host user who owns the directory and files; the UID override lets that user read files with mode `0400` or `0600` through the read-only mount.

```sh
REMOTE_CONFIG_DIR="$HOME/.config/nstdata-mcp-remote"
docker run --rm --user "$(id -u):$(id -g)" \
  --mount type=bind,src="$REMOTE_CONFIG_DIR",dst=/run/secrets,readonly \
  nstdata-mcp-remote:local --config /run/secrets/remote.json --check
docker run --rm --user "$(id -u):$(id -g)" --publish 8443:8443 \
  --mount type=bind,src="$REMOTE_CONFIG_DIR",dst=/run/secrets,readonly \
  nstdata-mcp-remote:local --config /run/secrets/remote.json
```

The configuration must listen on `0.0.0.0:8443` for this port mapping, and Redis must be reachable from the container. TLS still terminates in Node. Linux deployments using UID 1000 must deliver secret files readable by that UID through their secret mount, CSI driver or init step, while preserving mode `0400` or `0600` for the configuration and private key.

## Connect and operate

Configure the target platform with the deployed `/mcp` URL and its matching fixed client credentials. Use advertised OAuth discovery metadata rather than inventing authorization/token paths. Request `crawl:use`; access renewal remains subject to the granted authorization. Verify the actual platform's authorization, tool discovery and a bounded request before opening general access.

Keep Redis backups and all signing, cookie, encryption and fingerprint secrets under the deployment owner's control. During rotation, retain previous signing/cookie/encryption keys until their dependent sessions, tokens or bindings have expired. Test recovery from the same Redis data and key set. Readiness alone is not a backup or recovery test.

Apply ingress and per-user traffic limits at the deployment layer, and allow only the required Redis and Nstdata API egress. Redact authorization headers, cookies, OAuth codes, user API keys and request bodies from infrastructure logs. Use a supervisor to restart a stopped service only after checking the failure and storage state.

`SIGINT` or `SIGTERM` stops new work, aborts local handling and closes owned connections within a 10-second grace period. Stopping the service does not cancel Crawl tasks already submitted to Nstdata.
