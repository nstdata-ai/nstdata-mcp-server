# Contributing

Use Node.js 22.18+ in the 22.x line, or Node.js 24. Proxy certificate tests also require `openssl` on PATH. Reuse the Crawl SDK for product API calls; reuse `@nstdata-ai/proxy-checker/transport` for Proxy requests. Keep MCP output filtering and tool schemas in this adapter.

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run typecheck
npm test
npm run check:package
```

For offline development, cache the complete locked dependency graph before running `npm ci --offline`. `NSTDATA_SDK_TARBALL` and `NSTDATA_CHECKER_TARBALL` can supply local SDK and transport archives to package checks; their integrity must match the lock. These inputs do not replace source dependency installation. Tests use synthetic or loopback services, not paid endpoints.

## Local package installation

After the checks pass, run `npm pack` to build `nstdata-ai-mcp-server-1.0.1.tgz`. In a separate application directory, install that archive together with the approved `nstdata-ai-crawl-2.0.0.tgz` and `nstdata-ai-proxy-checker-1.1.0.tgz` by passing all three local paths to `npm install --ignore-scripts`. Use the same package versions and integrity values as the lock. Configure the installed package using the README template; do not point clients at source files.

Cover observable tool inputs/results, failure/empty content, deadlines, cancellation, output limits, reference continuation and process cleanup. Keep stdout exclusively for MCP protocol traffic. Task creation must not gain automatic retries.

Update both READMEs and both language versions of the relevant reference document when public behavior changes. Keep credentials and raw private responses out of examples, fixtures and errors. Package checks install the locked graph outside the source tree, then install the tarball without modifying that lock, verify dependency versions/integrities and validate installed tools, types, configuration templates, packaged links and documented workflows. Runtime and protocol tests also run against the installed CLI, including lifecycle and interrupted-request cases. Release and documentation-check tests run in the source suite. Markdown is actually parsed, and documented npm installation and npx startup run through an isolated loopback registry. Startup checks only initialize and discover tools; they must make no business requests. Third-party registry fixtures are repacked from the already verified installed runtime graph; this does not establish public registry availability. Checks require the complete cache prepared by source installation.

Verify license ownership, dependency availability, compatibility and maintainer authorization before publishing.

## Releases

The `Publish npm` workflow runs only when manually dispatched from `main`, with the stable version in `package.json` and a full reviewed commit SHA. Checks produce one archive and its integrity manifest. The `npm-production` reviewer approves publication of those exact bytes. Published integrity, default installation and tool discovery must pass afterward.

Crawl SDK and Proxy Checker dependencies must be publicly available with the lock's exact integrity before remote CI or release. Configure [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) for this repository, `release.yml` and `npm-production`, permitting `npm publish`. Require an environment reviewer, allow only `main` and disable administrator bypass. No npm token is needed.

A new npm package must exist before trusted publishing is configured. The scope owner publishes the first reviewed archive using their own npm login and two-factor authentication; use OIDC for subsequent real versions. Configure a new binding close to that release so its first-use deadline is met. Do not create placeholder packages.

If publication fails or the outcome is uncertain, inspect the registry version and integrity before taking further action. Do not retry blindly or modify a published version.
