# Changelog

## Unreleased

- Add Cursor marketplace installation with module selection and masked credential fields.
- Document client-specific setup for Claude Code, VS Code, GitHub Copilot, Cline, Roo Code, Gemini CLI, Windsurf and OpenCode.

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
