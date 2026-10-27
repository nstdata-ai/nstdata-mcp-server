# Changelog

## 1.0.1

- Provide six Crawl tools and two HTTP/HTTPS Proxy tools in one local stdio server, with independently enabled modules.
- Support sync/async single-page scraping, bounded site submission, task status, cursor pages and Unicode/binary reference chunks.
- Prefer storage references over inline content; encode inline binary content explicitly and preserve service identifiers, empty content and truncation flags.
- Validate inputs before submission; bound deadlines, downloads and output, propagate cancellation and close active connections at shutdown.
- Refuse redirects and automatic retries; distinguish failed tasks from unknown submission outcomes and preserve bounded recovery identifiers.
- Filter configured credentials and withhold sensitive opaque/binary output; reject malformed UTF-8 text without changing binary bytes.
- Reuse Crawl SDK 2.0.0 and proxy-checker 1.1.0 transport with locked archive integrity.
- Recognize successful Nstdata client-IP envelopes in Proxy checks without additional requests.
- Report invalid configuration URLs by field name without retaining the raw input in a native URL error.
- Include bilingual setup, tool/workflow references, executable client templates and installed CLI/type/behavior checks.
- Provide manually dispatched npm releases with environment approval, same-archive verification and public installation checks.
