# Proxy tools

## Configuration

Use the Proxy-only template in [README.md](../README.md#proxy-setup), or set `NSTDATA_MODULES=crawl,proxy` in the same server entry.

| Variable | Purpose |
|---|---|
| `NSTDATA_PROXY_URL` | Required HTTP/HTTPS gateway URL, including encoded username/password when needed |
| `NSTDATA_PROXY_CHECK_URL` | Required HTTP/HTTPS target for `nstdata_proxy_check` |
| `NSTDATA_PROXY_CA_FILE` | Optional absolute path to a PEM CA bundle for Proxy TLS only |

Use the full generated Nstdata or PM Router URL. Preserve channel/region/session/task username syntax. Gateway and target can each be HTTP or HTTPS; HTTPS targets use CONNECT. SOCKS5 and HAProxy are outside the supported protocols.

CA files must be regular files, at most 1 MiB, containing parseable certificates. Trust is added to Node's default CA set; gateway/target hostname verification stays enabled. Crawl trust settings are unchanged.

## Tools

- `nstdata_proxy_fetch`: `url`, optional `method` (GET/HEAD), target `headers`, and `format` (`text` or `base64`).
- `nstdata_proxy_check`: no arguments; checks only the configured target and returns status and elapsed milliseconds. `observedIp` is included only when the response supplies a valid plain IP or JSON `ip` string.

These tools forward requests; they do not render browsers, manage PM resources or verify exit region/anonymity. Calls may consume proxy traffic.

## Request behavior

Each call uses one connection lifetime. There is no redirect following, automatic retry, authentication negotiation, direct-network fallback or persistent connection pool. The local deadline covers DNS, TCP, CONNECT, TLS, headers and body. Cancellation, EOF and SIGTERM close active connections.

Proxy Basic credentials are sent only to the gateway. Target headers may include Authorization/Cookie; send them only to trusted targets. Reserved host/connection/framing/proxy-auth headers and invalid header names/values are rejected. Limits are 100 headers, 256 characters per name, 8192 per value and 8192 per URL.

Response headers, including CONNECT, are capped at 16 KiB. Transferred and decompressed bodies each obey `NSTDATA_MAX_RESPONSE_BYTES`. Gzip/deflate/br are decoded; invalid or unsupported encodings fail. Text is UTF-8, and base64 represents decoded body bytes. Network/TLS/framing overhead is not included in the body limit.

Output follows [shared MCP limits](mcp.md#configuration). An oversized Proxy response has no storage reference or local continuation. Use a smaller source response, a target-supported Range request, or an appropriate output limit.

## Errors and output

| Result | Meaning |
|---|---|
| Target non-2xx, including 3xx | `isError` with actual target status |
| `PROXY_AUTHORIZATION_FAILED` | Gateway authentication failed, including 407 |
| `PROXY_CONNECT_FAILED` | CONNECT establishment failed |
| `TLS_ERROR` | Gateway or target TLS failed |
| `UNSUPPORTED_ENCODING`, `INVALID_RESPONSE` | Response decoding or protocol failure |
| `UNSUPPORTED_RESPONSE` | HTTP 101 upgrades are not supported |
| `TIMEOUT`, `CANCELLED` | Local request stopped; no automatic retry |

Errors may omit status or timing; keep missing values unknown. A failed check does not establish a quota, billing or region problem.

Only selected response headers are returned. Configured credentials are filtered from display text; sensitive binary/opaque values are withheld with `SENSITIVE_OUTPUT`. Arbitrary target content is not guaranteed secret-free. Gateways that inspect TLS may observe target headers. Avoid debug logging with production credentials.

[Proxy products](https://docs.nstdata.io/docs/proxy) · [PM Router](https://docs.nstdata.io/docs/proxy-manager)

Transport is provided by `@nstdata-ai/proxy-checker/transport`. MCP retains tool validation, credential filtering and output limits; no checker CLI process or additional hosted service is started.
