# MCP client setup and Crawl reference

[中文](mcp_zh.md) · [Quick start](../README.md)

## Client setup

Install the packages and use the stdio template in [README.md](../README.md).

- **Cursor:** project configuration is `.cursor/mcp.json`; user configuration is `~/.cursor/mcp.json`. A local entry may use `envFile` with an absolute path to a protected credential file. See the [Cursor MCP guide](https://cursor.com/docs/mcp).
- **Claude Desktop:** follow the [local MCP setup guide](https://modelcontextprotocol.io/docs/develop/connect-local-servers) to merge the entry into the client configuration.

Use absolute Node and CLI paths. Preserve other server entries and keep credentials outside version control. Restart the MCP server after changing environment configuration.

Crawl-only exposes six tools, Proxy-only two, and both modules eight. Verify tool discovery before submitting a task. Startup failures should be checked in client diagnostics/stderr: confirm Node, installed versions, absolute paths and required environment variables.

## Configuration

| Variable | Default | Constraint |
|---|---|---|
| `NSTDATA_MODULES` | `crawl` | `crawl`, `proxy`, or both, comma-separated |
| `NSTDATA_API_TOKEN` | — | Required when Crawl is enabled |
| `NSTDATA_API_BASE_URL` | `https://api.nstdata.io` | Trusted HTTP(S) URL; no embedded credentials, query or fragment |
| `NSTDATA_HTTP_TIMEOUT_MS` | `120000` | Integer 1–600000; local tool deadline, including body reads |
| `NSTDATA_MAX_RESPONSE_BYTES` | `8388608` | Integer 256–67108864; each API/storage download |
| `NSTDATA_MAX_OUTPUT_CHARS` | `16000` | Integer 1024–64000; each serialized JSON representation, in UTF-16 code units |
| `NSTDATA_MAX_CRAWL_PAGES` | `10` | Integer 1–1000; default and maximum accepted `maxPages` |

Proxy-specific variables and behavior are defined in [proxy.md](proxy.md). Disabled modules do not require their credentials.

## Tool reference

| Tool | Required input | Operation and result |
|---|---|---|
| `nstdata_crawl_scrape` | `url` | One sync/async single-page submission; returns status/content or an ID |
| `nstdata_crawl_scrape_result` | `taskId` | One result query; retains status and available content/references |
| `nstdata_crawl_start` | `url` | One bounded site submission; returns its actual ID |
| `nstdata_crawl_status` | `crawlId` | One aggregate progress query; does not poll |
| `nstdata_crawl_pages` | `crawlId` | One page of results with actual cursors and per-page status |
| `nstdata_crawl_read_result` | `ref`, `format` | One bounded reference download and local chunk selection |

Submission tools create potentially billable tasks. Reads may also consume service resources. Formats are `markdown` (default), `html`, `links`, `pdf`, `screenshot` and `rawData`; request 1–6 entries. Scrape `mode` defaults to `sync`; site page/depth controls do not apply to single-page scraping. Proxy tools are listed in [proxy.md](proxy.md#tools).

## Workflows

### Single page

```json
{"name":"nstdata_crawl_scrape","arguments":{"url":"https://example.com/","formats":["markdown"],"mode":"sync","options":{"onlyMainContent":true}}}
```

For asynchronous work, use `mode: "async"`. Save the returned `id` and pass it as `taskId` to `nstdata_crawl_scrape_result`. Each call performs one query; callers must bound polling. Consume completed synchronous results directly.

Sync and result-query outputs retain `id` when supplied by the service. Query outputs also retain the requested `taskId`. A synchronous result ID alone does not guarantee that its content can be queried again.

### Site crawl

Call `nstdata_crawl_start` with an explicit `maxPages`. Save its `id` and pass it as `crawlId` to `nstdata_crawl_status` and `nstdata_crawl_pages`.

For example, collect the Quotes homepage and its second page:

```json
{"name":"nstdata_crawl_start","arguments":{"url":"https://quotes.toscrape.com/","formats":["markdown"],"maxPages":2,"maxDepth":1,"includeUrls":["/page/2/"],"options":{"onlyMainContent":false}}}
```

Use paths to select discovered links; submit the seed separately as `url`. Adding `/` to the filter can admit other paths. In this example, `onlyMainContent: true` returned only the seed, while `false` collected both pages. Full-page output can include navigation. Filter semantics are service-specific, and `maxPages` is an upper bound: verify the returned URLs, not just task completion or page count.

Page inputs accept `limit` (1–100, default 10) and one of `afterCursor`/`beforeCursor`. Copy `nextCursor` or `prevCursor` unchanged. An empty page with a cursor is not the end; stop on repeated cursors or the caller's page/call limit. Aggregate completion does not mean every page succeeded. If a page list exceeds the output limit, repeat that read from the same input cursor with a smaller `limit` (down to 1), then continue using the successful response's cursor. Advancing past a withheld page would skip unread results.

### Read a reference

Pass the value of `data.markdownRef` as **`ref`**, with `format: "markdown"`:

```json
{"name":"nstdata_crawl_read_result","arguments":{"ref":"RETURNED_MARKDOWN_REF","format":"markdown","offset":0,"length":2000}}
```

Use the same mapping for htmlRef→html, pdfRef→pdf, screenshotRef→screenshot and rawDataRef→rawData. References are opaque values, not public URLs. Only read references from an authorized task.

`length` is 1–4000, default 2000. Text uses Unicode code-point offsets and UTF-8; invalid UTF-8 fails with `INVALID_RESPONSE` before slicing. Binary uses byte offsets and base64 output. Continue at `nextOffset` until absent. Decode binary chunks separately before joining bytes. Every call downloads the full reference within the response cap, then slices locally; this is not HTTP Range or persistent caching.

## Options

Common top-level inputs are `url`, `formats` and, for scrape, `mode`. Site traversal controls are top-level `maxPages`, `maxDepth` (0–100), `includeUrls`, `excludeUrls`, `ignoreQuery`. Site `maxPages` defaults to the configured local upper bound (10 initially). Server-side request options are nested under `options` and forwarded without that wrapper:

- `cookies`: up to 100 objects; `name`/`value` required; optional domain/httpOnly/path/secure.
- `proxy.country`: a two-letter country code; no raw proxy credentials.
- `headers`: up to 100 string entries; names up to 256 characters, values up to 8192.
- `excludeTags`, `includeTags`, `removeSelectors`: up to 100 strings; `targetSelector` is one string. Each string/selector is at most 8192 characters. `includeTags` can remove surrounding structure; use only when desired.
- `mobile`, `onlyMainContent`: booleans.
- `timeout`: integer milliseconds, 1000–60000; the upstream timeout is distinct from the local tool deadline.
- `jsRender`: optional `waitFor` (integer milliseconds, 1000–30000), `waitForSelector`, up to 100 `actions`.

| Action type | Required fields | Optional fields |
| --- | --- | --- |
| click | selector | waitSelector |
| wait | milliseconds | — |
| waitSelector | selector | milliseconds |
| scrollX | x (integer pixels) | text |
| scrollY | y (integer pixels) | text |
| scrollTo | selector | — |
| fill | selector, text (may be empty) | — |
| execute | execute | — |
| screenshot | — | fullScreenshot, particularScreenshot |
| waitForRequestCompletion | urlPattern | milliseconds |

Action `milliseconds` values are integers from 0 to 600000; these are distinct from `jsRender.waitFor`.

Cookie names are non-empty; values may be empty. Other cookie string fields, when supplied, are non-empty. Cookie strings are capped at 8192 characters.

Other string inputs are capped: URL 8192, task/crawl ID 256, cursor 8192, storage reference 4096. Unknown fields are rejected. These are local input bounds, not promises about limits or behavior of the remote service.

## Results and errors

Results contain the same JSON in `content` text and `structuredContent`. Protocol framing and the duplicate representation add overhead beyond the output limit. Website content is untrusted and may contain sensitive information.

When a format has a storage reference, the tool returns that reference and omits the inline value, even if the service supplies both. Without a reference, Markdown/HTML remain strings; inline `pdf`, `screenshot` and `rawData` are byte envelopes:

```json
{"data":{"screenshot":{"encoding":"base64","base64":"AP+A"}}}
```

Decode each envelope's `base64` to bytes. Inline raw text is converted to UTF-8 bytes before Base64 encoding. Empty content has an empty string or empty Base64 value; missing content is omitted. Tools do not download references during result serialization.

`data.truncated` preserves the service's flag, including `false`; an absent flag is unknown. It is separate from the local output limit. For a single-page output-limit error, `error.recovery` retains actual identifiers, references and the truncation flag when present and within the configured output budget.

Task `failed`/`expired` or `success: false` sets `isError`; page failures remain individual rows. Missing status, timing or content is unknown, not a successful empty result.

| Error | Meaning / handling |
|---|---|
| `AUTHORIZATION_FAILED` | HTTP or API-envelope 401/403; check credentials and access |
| `RATE_LIMITED` | HTTP or API-envelope 429; stop and inspect service limits |
| `UPSTREAM_ERROR` | Request/response failure; optional `statusCode` and `apiCode` are separate. A 3xx status is a refused redirect |
| `TIMEOUT`, `CANCELLED` | Local waiting stopped; submitted remote tasks may still run |
| `RESPONSE_LIMIT` | A response exceeded the download cap |
| `INVALID_RESPONSE` | Invalid response content, including malformed UTF-8 in a text reference |
| `OUTPUT_LIMIT` | Serialized output exceeded the cap; use smaller pages/chunks or actual identifiers in `error.recovery` |
| `SENSITIVE_OUTPUT` | A credential matched a property name, binary content or an opaque identifier; the result was withheld |

No request is automatically retried. An uncertain submission without an ID requires review, not another creation. A failed read does not create or cancel a task.

For task submissions, a connection failure, server error or unreadable/oversized response can leave the outcome unknown even when no ID was received. The error message identifies this uncertainty; check the service task history before submitting again. Successful async acknowledgements must contain an ID accepted by the result-query tools; a missing or unusable ID is an unknown outcome. Explicit task failures and synchronous content without a diagnostic ID remain distinct. Authentication and rate-limit rejections remain distinct from unknown outcomes.

`OUTPUT_LIMIT` is not a download continuation API. Inline-only content may have no reference; an ID alone does not make it chunkable. Configured credentials are filtered from display text and checked in property names and decoded binary bytes, including nested inline envelopes. Matching names, opaque identifiers and binary payloads are withheld rather than altered; short credentials can also match ordinary field names. Other website secrets are not automatically detected. Raw HTTP bodies and transport messages are omitted from request errors.

API/storage redirects are refused, including same-origin redirects. Configure a verified final API origin rather than following Location. For Proxy failures and limits, see [proxy.md](proxy.md).
