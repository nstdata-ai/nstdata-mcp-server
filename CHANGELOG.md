# Changelog

## 1.0.1 — Unreleased

- Identify unknown submission outcomes after connection failures, server errors and unreadable, oversized or unusable async acknowledgements; never retry automatically.
- Reuse proxy-checker 1.1.0's transport instead of maintaining a transport inside MCP.
- Preserve eight tool names, result schemas, configuration, credential filtering and output limits.
- Align Crawl input validation with the API: JS wait is 1000–30000 ms, upstream timeout is 1000–60000 ms, and scroll coordinates are integers. Reject invalid values before submitting tasks; action wait limits remain unchanged.
- Clean compiled output before building; verify installed Proxy/TLS behavior as well as Crawl workflows.

## 1.0.0 — Local snapshot, unpublished

- Add a local stdio server with six Crawl tools and two HTTP/HTTPS Proxy tools, independently configurable.
- Support sync/async scraping, bounded site submission, status/pages and Unicode/binary reference chunks.
- Return inline PDF/screenshots/raw data as explicit Base64 byte envelopes when no reference is available; preserve empty content and service truncation flags.
- Preserve service-provided sync/result IDs and bounded recovery metadata, including single-page truncation flags. IDs alone do not guarantee queryability or chunk recovery.
- Apply decoded-byte credential checks to nested inline binary content without corrupting Base64 or encoding labels.
- Add schema validation, cancellation, request/output limits, credential filtering and process cleanup.
- Add gateway Basic authentication, HTTPS CONNECT, optional CA trust, decoding and bounded GET/HEAD probes.
- Reject redirects and automatic task retries. Preserve partial outcomes and safe identifiers for recovery.
- Pin Crawl SDK `2.0.0`, including redirect refusal and API body-interruption error handling.
- Align the SDK archive integrity and verify installed packages against the locked dependency graph without relying on cached registry metadata.

### Compatibility

This is the first planned stable release of `@nstdata-ai/mcp-server`. It retains the tool names, inputs, result formats and module configuration of the local prerelease. MCP initialization reports this package version. The Crawl SDK is pinned to `2.0.0`; existing local installations of prerelease packages must be updated together. Public registry installation remains unavailable until the SDK and then this server are published.
