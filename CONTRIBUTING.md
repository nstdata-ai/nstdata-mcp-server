# Contributing

Use Node.js 22.18+ in the 22.x line, or Node.js 24. Proxy certificate tests also require `openssl` on PATH. Reuse the Crawl SDK for product API calls; reuse `@nstdata-ai/proxy-checker/transport` for Proxy requests. Keep MCP output filtering and tool schemas in this adapter.

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run typecheck
npm run typecheck:remote
npm test
npm run check:package
npm run build:remote
npm run check:remote
```

`npm test` runs both the local and Remote unit suites; use `npm run test:local` or `npm run test:remote:unit` to run one suite. `npm run build` produces only the local stdio package in `dist`. `npm run build:remote` compiles the same source into the private application's `remote/dist`; install its runtime dependencies with `npm --prefix remote ci --omit=dev --ignore-scripts`. OAuth and Redis are development dependencies of the root project and runtime dependencies of the private Remote application, not dependencies of the published stdio package. See the [Remote guide](https://github.com/nstdata-ai/nstdata-mcp-server/blob/main/docs/remote.md) for startup and configuration. `check:remote` verifies a production install in a temporary directory using the locked cache.

For offline development, cache the complete locked dependency graph before running `npm ci --offline`. `NSTDATA_SDK_TARBALL` and `NSTDATA_CHECKER_TARBALL` can supply local SDK and transport archives to package checks; their integrity must match the lock. These inputs do not replace source dependency installation. Tests use synthetic or loopback services, not paid endpoints.

## Redis storage tests

With `redis-server` on PATH, run the storage integration checks after building:

```sh
npm run build:remote
npm run test:redis
npm run test:remote
npm run test:remote-service
```

The checks start an isolated Redis process with TCP disabled and connect through its temporary Unix socket. They cover concurrent token consumption, revocation, delayed writes, credential encryption and expiry. Remote checks exercise the authorization form, PKCE, refresh rotation, MCP calls and service startup/shutdown against loopback and synthetic services. These suites remove their own processes and temporary files, use no real credentials, require Linux or macOS and run in CI.

## Remote container

With a running local Docker engine, build and check the image as a nonroot Linux/macOS user:

```sh
docker build --file Dockerfile.remote --tag nstdata-mcp-remote:local .
npm run check:container -- nstdata-mcp-remote:local
```

The check verifies the existing image's runtime files, dependencies and identity, then uses isolated containers with synthetic configuration to test startup and stopping the default entrypoint during an unfinished request. It removes only its own containers. The wire fixture does not validate Redis persistence; use the Redis integration tests above. This command does not publish an image or deploy a service.

Maintainers can publish a checked Linux AMD64 image with the manual `Publish Remote image` workflow. See [image publication](https://github.com/nstdata-ai/nstdata-mcp-server/blob/main/docs/remote.md#publish-an-image) for registry credentials, environment protection and digest-based deployment.

## Local package installation

After the checks pass, run `npm pack` to build `nstdata-ai-mcp-server-1.0.3.tgz`. Install it from a separate application directory:

```sh
npm install --ignore-scripts /path/to/nstdata-ai-mcp-server-1.0.3.tgz
```

Configure the installed package using the README template; do not point clients at source files.

Cover observable tool inputs/results, failure/empty content, deadlines, cancellation, output limits, reference continuation and process cleanup. Keep stdio stdout exclusively for MCP protocol traffic. Task creation must not gain automatic retries.

Update both READMEs and both language versions of the relevant reference document when public behavior changes. Keep credentials and raw private responses out of examples, fixtures and errors. Package checks install the locked graph outside the source tree, then install the tarball without modifying that lock, verify dependency versions/integrities and validate installed tools, types, configuration templates, packaged links and documented workflows. Runtime and protocol tests also run against the installed CLI, including lifecycle and interrupted-request cases. Release and documentation-check tests run in the source suite. Markdown is actually parsed, and documented npm installation and npx startup run through an isolated loopback registry. Startup checks only initialize and discover tools; they must make no business requests. Third-party registry fixtures are repacked from the already verified installed runtime graph; this does not establish public registry availability. Checks require the complete cache prepared by source installation.

Verify license ownership, dependency availability, compatibility and maintainer authorization before publishing.

## Client plugins

The repository marketplace is `.agents/plugins/marketplace.json`; its plugin lives in `plugins/nstdata`. Keep its pinned npm version aligned with the plugin version. Credentials belong in the user's Codex home `.env`, never in the plugin. Plugin changes require a real Codex install and fresh-conversation check; protocol tests alone do not cover client integration.

Cursor uses `.cursor-plugin/marketplace.json`, `plugins/nstdata/.cursor-plugin/plugin.json` and `plugins/nstdata/mcp.json`. Preserve the separate Codex `.mcp.json`; Cursor does not use Codex's `env_vars` field. Missing optional credentials must resolve to empty strings so enabled-module validation fails before connecting upstream. Validate native marketplace import, plugin configuration and tool discovery separately from direct MCP setup. Keep secrets out of manifests and do not infer credential storage guarantees from masked fields.

Claude Code uses `.claude-plugin/marketplace.json`, `plugins/nstdata/.claude-plugin/plugin.json` and `plugins/nstdata/claude.mcp.json`. Keep credentials in client-managed sensitive configuration. An explicit MCP file must override the same-named entry in the default `.mcp.json`. Adding a host-specific manifest requires checking that the other hosts still select their own manifests and configuration files.

## Releases

The `Publish npm` workflow runs only when manually dispatched from `main`, with the stable version in `package.json` and a full reviewed commit SHA. Checks produce one archive and its integrity manifest. The `npm-production` reviewer approves publication of those exact bytes. The workflow finishes when `npm publish` succeeds. Public availability may be delayed; registry integrity, installation and tool discovery are checked separately.

Crawl SDK and Proxy Checker dependencies must be publicly available with the lock's exact integrity before remote CI or release. Configure [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) for this repository, `release.yml` and `npm-production`, permitting `npm publish`. Require an environment reviewer, allow only `main` and disable administrator bypass. No npm token is needed.

A new npm package must exist before trusted publishing is configured. The scope owner publishes the first reviewed archive using their own npm login and two-factor authentication; use OIDC for subsequent real versions. Configure a new binding close to that release so its first-use deadline is met. Do not create placeholder packages.

If publication fails or the outcome is uncertain, inspect the registry version and integrity before taking further action. Do not retry blindly or modify a published version.
