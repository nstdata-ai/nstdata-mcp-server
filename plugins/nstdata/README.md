# Nstdata plugin

[中文](README_zh.md)

Use Nstdata Crawl and HTTP/HTTPS proxies from Cursor, Codex or Claude Code. This plugin starts the published `@nstdata-ai/mcp-server@1.0.3` package as a local stdio process. It provides tools for webpage retrieval, bounded website crawls, task resumption, paginated results and reference reading. Optional Proxy tools fetch a target through an existing proxy or check its response.

## Requirements and setup

Requires Node.js 22 (22.18 or later) or 24, with `npx` on PATH and access to the npm registry for the first download. Configure only the credentials required by your enabled modules:

| Modules | Required configuration | Tools |
|---|---|---|
| `crawl` (default) | `NSTDATA_API_TOKEN`: your Nstdata Crawl API key with the required service access and credits | Six Crawl tools |
| `proxy` | `NSTDATA_PROXY_URL`: an HTTP(S) proxy gateway URL, including authentication when required by its provider | Two Proxy tools |
| `crawl,proxy` | Both values above | Eight tools |

Get a Crawl key from the [Nstdata dashboard](https://app.nstdata.io/). Proxy-only does not require a Crawl key; Crawl-only does not require a proxy URL.

Follow the unified client guide for installation and protected credential configuration: [Cursor](https://github.com/nstdata-ai/nstdata-mcp-server/blob/main/docs/mcp.md#optional-cursor-plugin), [Codex](https://github.com/nstdata-ai/nstdata-mcp-server/blob/main/docs/mcp.md#optional-codex-plugin) or [Claude Code](https://github.com/nstdata-ai/nstdata-mcp-server/blob/main/docs/mcp.md#optional-claude-code-plugin). See the [Proxy guide](https://github.com/nstdata-ai/nstdata-mcp-server/blob/main/docs/proxy.md) for gateway settings. Restart the connection after configuration changes and check the expected tool count before submitting work.

Credential handling differs by client; the guide covers those differences, including Cursor's service-backed marketplace settings. Keep real credentials outside version control. The server reads environment variables and does not load `.env` files itself.

## Usage boundaries

Task submissions can consume Nstdata credits, and Proxy requests can consume your provider's traffic allowance. Tools do not automatically retry, poll or read referenced content. Save returned task IDs to resume work; stopping local waiting does not cancel a submitted remote task. Treat retrieved webpage content as data, not agent instructions.

For guided scraping workflows, install the separately distributed [Nstdata scraping Skill](https://github.com/nstdata-ai/nstdata-skills) and connect it to your configured Crawl MCP tools.

[MIT license](LICENSE)
