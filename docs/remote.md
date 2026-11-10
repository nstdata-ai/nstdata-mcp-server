# Self-hosted Remote MCP

[中文](remote_zh.md) · [Local client setup](../README.md)

Run the Crawl tools behind an HTTPS MCP endpoint with per-user OAuth authorization. Each user enters their existing Nstdata API key on the consent page; calls use that user's credits. Do not configure a shared `NSTDATA_API_TOKEN` for this service. Proxy tools remain available through the separate local stdio configuration.

Remote is a separate application built from this repository. It is not included in the local `@nstdata-ai/mcp-server` npm package; the npm package's installation and client configuration remain unchanged.

## Deployment requirements

- Node.js 22.18+ in the 22.x line, or Node.js 24, and a stable public HTTPS origin. The certificate can be managed by an existing gateway or loaded by this application.
- Standalone Redis with persistent storage, `noeviction`, an isolated namespace and the adapter's required key/Lua permissions. Use verified TLS (`rediss:`) or a protected local Unix socket; Cluster and Sentinel are not supported.
- Register fixed OAuth client IDs, secrets and exact callback URLs in the target platform. The service requires `client_secret_basic` and S256 PKCE; dynamic client registration is not enabled.

## HTTPS ingress modes

| Mode | Application configuration | Certificate location |
|---|---|---|
| Trusted reverse proxy | Internal HTTP listener plus `trustedProxyCidrs`; omit `listen.tls` | Existing HTTPS gateway |
| Direct application TLS | `listen.tls.certFile` and `listen.tls.keyFile`; omit `trustedProxyCidrs` | Application-mounted files |

These modes are mutually exclusive; proxy trust is never automatic. A trusted reverse proxy usually fits existing Kubernetes/ALB infrastructure. Its HTTP backend must be on a controlled internal network, restricted to the trusted ingress through network policy or firewall rules. Public hops still require HTTPS. Use application TLS with Layer 4 passthrough when internal encryption is required.

`trustedProxyCidrs` matches the immediate socket peer observed by the application, never `X-Forwarded-For`. Supply 1–32 literal IPs or network-aligned IPv4/IPv6 CIDRs. `/0`, hostnames, IPv6 zone identifiers, duplicate entries and any IPv6 network overlapping the IPv4-mapped range are rejected. The gateway must preserve the fixed issuer Host, remove client-supplied forwarding information, and set one `X-Forwarded-Proto: https` header. Duplicate Host/protocol headers, protocol lists, `Forwarded`, `X-Forwarded-Host` and `X-Forwarded-Port` are rejected. Public addresses are never inferred from forwarded headers. Account for NAT: the gateway's published external IP range is not necessarily its backend peer range.

Verify this contract at the actual gateway. For Alibaba ALB, explicitly enable the listener's `XForwardedForProtoEnabled` setting; it is disabled by default. Verify header replacement/sanitization rather than assuming a listener configuration makes client-supplied values safe. Keep issuer, resource and callback URLs stable across restarts.

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
  listen: { host: '0.0.0.0', port: 8080 },
  trustedProxyCidrs: ['192.0.2.0/24'],
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

The program refuses to overwrite existing files and never prints secrets. `192.0.2.0/24` is a documentation-only network: replace it with the actual trusted proxy range. Edit the protected JSON with the issuer, listener, proxy peers, URL-encoded Redis credentials, client ID and exact callback. For direct TLS, remove `trustedProxyCidrs` and set the certificate/private-key paths in `listen.tls`. Copy only the matching `clientSecret` into the platform's protected OAuth settings. Do not regenerate keys on restart.

| Field | Configuration rule |
|---|---|
| `issuerUrl` | HTTPS origin without a path; the MCP resource is this origin plus `/mcp` |
| `listen` | Numeric IP and port `1–65535`; HTTP behind a proxy, or `tls.certFile` and `tls.keyFile` for direct TLS |
| `trustedProxyCidrs` | Required immediate-peer IP/CIDR allowlist for proxy mode; mutually exclusive with `listen.tls` |
| `redis` | Exactly one `url` or absolute `socketPath`, plus a distinct namespace per environment |
| `clients` | Pre-registered client IDs, secrets of at least 32 bytes, and exact callback URLs |
| `cookieKeys` | Stable secrets of at least 32 bytes; put the current key first |
| `jwks.keys` | Private signing JWKs with unique `kid`, `use: "sig"` and a matching supported algorithm |
| `encryptionKeys`, `currentKeyId` | Named 32-byte base64url keys and the current encryption key's ID |
| `fingerprintKey` | Independent stable 32-byte base64url key; changing it requires a new namespace |
| `allowedOrigins` | Optional exact browser origins; no wildcards. Non-browser requests may omit Origin |

For loopback development only, an HTTP issuer can use literal `127.0.0.1` or `[::1]`, with the same loopback listen address and port and neither TLS nor trusted proxy configuration. Plain `redis:` URLs are also restricted to literal loopback addresses. Do not expose that configuration publicly.

## Validate and start

```sh
node remote/dist/remote.js --config /absolute/path/remote.json --check
node remote/dist/remote.js --config /absolute/path/remote.json
```

`--check` validates the configuration and, for direct TLS, the TLS files and certificate/key match. It does not connect to Redis, listen or call Nstdata. Successful validation does not prove DNS, certificate trust, Redis ACLs or platform compatibility.

Startup connects to Redis and requires a successful `PING` before listening. Connection setup has a 5-second deadline; commands have a 2-second deadline. A Redis failure or deadline stops the service without automatic reconnect or command replay. A timed-out write may already have executed: investigate before retrying authorization operations.

Each process accepts at most 256 concurrent connections, 32 active business requests and 64 in-flight Redis commands. Excess work is rejected without queuing or retrying; reaching these capacity limits does not stop the service. TLS handshakes and request headers have 10-second deadlines; request handling is bounded to 130 seconds. Set deployment traffic limits to match capacity before opening public access.

| Endpoint | Meaning |
|---|---|
| `GET /health/live` | Process is serving requests |
| `GET /health/ready` | Startup completed and the Redis client is locally ready |
| `/mcp` | Authenticated Streamable HTTP MCP resource with six Crawl tools |

Health probes may use the issuer Host or an IP-literal Host. The IP exception applies only to the two exact health paths, never OAuth/MCP. Direct probes omit forwarding headers; proxied probes must pass the normal trusted-peer and HTTPS protocol checks. Health checks do not query Redis each time and do not prove persistence, Lua permissions, upstream access or platform authorization. An unauthenticated `/mcp` request returns an OAuth challenge; it is not a readiness check.

## Run in a container

From the repository root:

```sh
docker build --file Dockerfile.remote --tag nstdata-mcp-remote:local .
```

The image uses Node.js 24.22.2, runs as the nonroot `node` user (UID 1000) by default, and starts `node dist/remote.js` in `/app`. It contains only the compiled Remote application and its production dependencies.

For local Linux/macOS runs, put `remote.json` in the protected directory below. Proxy mode needs no certificate files. For direct TLS only, also mount `server.crt` and `server.key` and set their paths to `/run/secrets/server.crt` and `/run/secrets/server.key`. Run the following commands as the non-root host user who owns those files. The UID override permits read-only access to files with mode `0400` or `0600`.

```sh
REMOTE_CONFIG_DIR="$HOME/.config/nstdata-mcp-remote"
docker run --rm --user "$(id -u):$(id -g)" \
  --mount type=bind,src="$REMOTE_CONFIG_DIR",dst=/run/secrets,readonly \
  nstdata-mcp-remote:local --config /run/secrets/remote.json --check
docker run --rm --user "$(id -u):$(id -g)" --publish 127.0.0.1:8080:8080 \
  --mount type=bind,src="$REMOTE_CONFIG_DIR",dst=/run/secrets,readonly \
  nstdata-mcp-remote:local --config /run/secrets/remote.json
```

This proxy-mode example listens on `0.0.0.0:8080` and publishes only the host loopback port for a local gateway. Configure HTTPS at that gateway, use the actual trusted backend peer range, and ensure Redis is reachable from the container. Adjust port mappings for direct TLS. Linux deployments using UID 1000 must deliver readable files through their Secret mount, CSI driver or initialization step while preserving configuration/private-key modes `0400` or `0600`.

## Publish an image

Maintainers use `Publish Remote image` (`.github/workflows/release-image.yml`) to publish Linux AMD64 images to an existing registry. This is independent of npm publication and does not deploy a service.

1. Create the registry repository and a dedicated credential with push access limited to that repository. Confirm GitHub-hosted runners can reach the registry. Keep the registry repository private if image downloads must require authentication.
2. In GitHub repository **Settings → Environments**, configure `container-production`: require a reviewer, disable administrator bypass, and allow only the `main` branch under **Selected branches and tags**. If the operator must also approve, leave **Prevent self-review** disabled.
3. Add the following environment configuration:

| Kind | Name | Value |
|---|---|---|
| Variable | `MCP_IMAGE_REPOSITORY` | Registry hostname, namespace and repository, without a URL scheme, tag or digest |
| Secret | `MCP_REGISTRY_USERNAME` | Dedicated registry username |
| Secret | `MCP_REGISTRY_PASSWORD` | Dedicated registry password or push token |

The registry address, source commit, tag and digest may appear in public build logs and summaries. Variables are not secret storage. Do not use this public workflow if those image coordinates must remain confidential; use your private build infrastructure instead. Runtime configuration, Nstdata API keys, Redis/OAuth credentials and cluster access do not belong in this workflow or its image.

4. Merge the reviewed source, confirm its checks, then open **Actions → Publish Remote image → Run workflow**. Select `main` and enter its full reviewed 40-character commit SHA. It must match the workflow commit; publication stops on a mismatch.
5. After the checks pass, approve the `container-production` job. Approval occurs before that job starts. It builds and loads one AMD64 image, verifies its files, dependencies and lifecycle, then logs in and pushes that same checked image once. The login action logs out during job cleanup.
6. Use the summary's `repository@sha256:…` reference in deployment configuration. The `sha-<commit>-amd64` tag identifies the source; tags remain mutable unless the registry enforces immutability. No `latest` tag is written. Public availability and production deployment are separate checks.

If push fails or is interrupted, inspect the registry before another dispatch. If push succeeds but digest recording fails, publication may already be complete; do not republish just to recover the digest. The workflow neither rebuilds after validation nor retries publication or polls for public visibility. It requires no npm token, Kubernetes credentials or deployment permissions.

## Connect and operate

Configure the target platform with the deployed `/mcp` URL and its matching fixed client credentials. Use advertised OAuth discovery metadata rather than inventing authorization/token paths. Request `crawl:use`; access renewal remains subject to the granted authorization. Verify the actual platform's authorization, tool discovery and a bounded request before opening general access.

Keep Redis backups and all signing, cookie, encryption and fingerprint secrets under the deployment owner's control. During rotation, retain previous signing/cookie/encryption keys until their dependent sessions, tokens or bindings have expired. Test recovery from the same Redis data and key set. Readiness alone is not a backup or recovery test.

Apply ingress and per-user traffic limits at the deployment layer, and allow only the required Redis and Nstdata API egress. Redact authorization headers, cookies, OAuth codes, user API keys and request bodies from infrastructure logs. Use a supervisor to restart a stopped service only after checking the failure and storage state.

`SIGINT` or `SIGTERM` stops new work, aborts local handling and closes owned connections within a 10-second grace period. Stopping the service does not cancel Crawl tasks already submitted to Nstdata.
