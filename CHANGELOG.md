# Changelog

## Unreleased

### Client distribution

- Pin Cursor, Codex and Claude Code plugins to the 1.0.3 stdio package.
- Add a Gemini CLI Crawl extension with client-managed sensitive configuration.

### Self-hosted Remote application

- Add a separate Remote MCP application and container build, keeping OAuth and Redis dependencies and runtime output outside the stdio npm package.
- Allow a configured Remote MCP endpoint such as `/crawl`, retaining `/mcp` as the default and binding OAuth discovery and tokens to the selected resource.
- Support a platform-managed HTTPS ingress with a private HTTP backend, without requiring application certificate files or proxy IP ranges; retain the existing direct TLS and IP-restricted modes.
- Align OAuth discovery with permitted Crawl scopes and advertise issuer identification for authorization responses.
- Fix browser consent submissions and provide a responsive authorization screen with clear error and recovery messages.
- Allow consent and account-switch forms to return to the registered client callback origin without broadening other browser permissions.
- Return to IPv6 callbacks through a browser navigation page; reject IPv6 `form_post` before consent instead of consuming an authorization that cannot return.
- Keep idle Redis connections active with bounded heartbeats and identify service failures without exposing connection details.

## 1.0.3

### Local stdio package

- Read bounded text chunks without allocating an array for the entire reference, preserving Unicode offsets and continuation.
- Document client-specific setup for Claude Code, VS Code, GitHub Copilot, Cline, Roo Code, Gemini CLI, Windsurf and OpenCode.

### Repository plugins

- Add Cursor marketplace installation with module selection and masked credential fields.
- Add Claude Code marketplace installation with client-managed module and credential configuration.
- Include standalone plugin setup guides and the MIT license in the installed plugin folder.

## 1.0.2

- Preserve bounded page summaries and storage references when a single crawl result row exceeds the output limit; separate continuation cursors from unread page results.
- Describe reference inputs, offset units, page bounds and cursor recovery in tool schemas.
- Default Proxy checks to `https://example.com/`, with an optional target override and no requests during startup.
- Add credential-free `--help` and `--version` commands; reject unsupported arguments without printing their values.

## 1.0.1

- Provide six Crawl tools and two HTTP/HTTPS Proxy tools in one local stdio server, with independently enabled modules.
- Support sync/async single-page scraping, bounded site submission, task status, cursor pages and Unicode/binary reference chunks.
- Prefer storage references over inline content; encode inline binary content explicitly and preserve service identifiers, empty content and truncation flags.
- Validate inputs before submission; bound deadlines, downloads and output, propagate cancellation and close active connections at shutdown.
- Reject dot-only task IDs in tool inputs and asynchronous submission acknowledgements.
- Refuse redirects and automatic retries; distinguish failed tasks from unknown submission outcomes and preserve bounded recovery identifiers.
- Filter configured credentials and withhold sensitive opaque/binary output; reject malformed UTF-8 text without changing binary bytes.
- Reuse Crawl SDK 2.0.0 and proxy-checker 1.2.0 transport with locked archive integrity; preserve the target Host header for HTTPS requests.
- Recognize successful Nstdata client-IP envelopes in Proxy checks without additional requests.
- Identify invalid environment settings by variable name without exposing their values; keep programmatic configuration errors keyed by field name.
- Include bilingual setup, tool/workflow references, executable client templates and installed CLI/type/behavior checks.
- Provide manually dispatched npm releases with environment approval, same-archive verification and public installation checks.
