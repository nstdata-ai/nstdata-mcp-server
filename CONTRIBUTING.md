# Contributing

Use Node.js 22.18+ in the 22.x line, or Node.js 24. Proxy certificate tests also require `openssl` on PATH. Reuse the Crawl SDK for product API calls; reuse `@nstdata-ai/proxy-checker/transport` for Proxy requests. Keep MCP output filtering and tool schemas in this adapter.

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run typecheck
npm test
npm run check:package
```

Before registry availability, add the approved SDK and checker tarballs matching their lock integrities to npm's cache with `npm cache add /PATH/nstdata-ai-crawl-2.0.0.tgz` and `npm cache add /PATH/nstdata-ai-proxy-checker-1.1.0.tgz`, then run the commands above. `NSTDATA_SDK_TARBALL` and `NSTDATA_CHECKER_TARBALL` optionally seed the same archives for package checks; it does not prepare source installation. Use `npm ci --offline` only after the full locked graph is cached. Tests must use synthetic or loopback services, not paid endpoints.

## Local package installation

After the checks pass, run `npm pack` to build `nstdata-ai-mcp-server-1.0.1.tgz`. In a separate application directory, install that archive together with the approved `nstdata-ai-crawl-2.0.0.tgz` and `nstdata-ai-proxy-checker-1.1.0.tgz` by passing all three local paths to `npm install --ignore-scripts`. This avoids resolving the unpublished dependencies from the registry. Configure the installed CLI using the README template; do not point clients at source files.

Cover observable tool inputs/results, failure/empty content, deadlines, cancellation, output limits, reference continuation and process cleanup. Keep stdout exclusively for MCP protocol traffic. Task creation must not gain automatic retries.

Update both READMEs and the relevant reference document when public behavior changes. Keep credentials and raw private responses out of examples, fixtures and errors. Package checks install the locked graph outside the source tree, then install the tarball without modifying that lock, verify dependency versions/integrities and validate installed tools, types and configuration templates. They require the complete cache prepared by source installation.

Verify license ownership, dependency availability, compatibility and maintainer authorization before publishing.
