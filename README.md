# Nstdata MCP Server

[中文](README_zh.md)

Use Nstdata Crawl and HTTP/HTTPS proxies from an MCP client. Runs locally over stdio and exposes six Crawl tools and two Proxy tools.

## Install

Requires Node.js 22.18+ in the 22.x line, or Node.js 24. Version `1.0.1` depends on Crawl SDK `2.0.0` and proxy checker `1.1.0`; all three are prepared locally and have not been published. After publication, install the server in your application directory:

```sh
npm install @nstdata-ai/mcp-server@1.0.1
```

For local installation before publication, see [Contributing](CONTRIBUTING.md).

## Connect a client

Replace the placeholders with absolute paths and your Crawl token:

```json
{
  "mcpServers": {
    "nstdata": {
      "command": "/ABSOLUTE/PATH/TO/node",
      "args": ["/ABSOLUTE/INSTALL/DIRECTORY/node_modules/@nstdata-ai/mcp-server/dist/stdio.js"],
      "env": {
        "NSTDATA_MODULES": "crawl",
        "NSTDATA_API_TOKEN": "YOUR_CRAWL_API_TOKEN"
      }
    }
  }
}
```

The server reads process environment variables; it does not load `.env` files. Keep real credentials in protected client configuration. After changing configuration, restart the MCP server. See [client setup and tool contracts](docs/mcp.md).

## Tools

| Tool | Purpose |
|---|---|
| `nstdata_crawl_scrape` | Submit one page |
| `nstdata_crawl_scrape_result` | Read a scrape result |
| `nstdata_crawl_start` | Start a bounded site crawl |
| `nstdata_crawl_status` | Read crawl progress |
| `nstdata_crawl_pages` | Read one result page |
| `nstdata_crawl_read_result` | Read a reference chunk |
| `nstdata_proxy_fetch` | GET/HEAD through a proxy |
| `nstdata_proxy_check` | Check a configured target |

Crawl supports Markdown, HTML, links, PDF, screenshots and raw data. Results may contain inline content or storage references. Tool calls do not automatically poll tasks or download references.

Crawl option bounds are checked before task submission. See [option limits and browser actions](docs/mcp.md#options).

References take precedence over inline content. Without a reference, PDF/screenshots/raw data use `{ "encoding": "base64", "base64": "..." }` byte envelopes. Results preserve service-provided task IDs and truncation flags; absent flags do not prove completeness. See [result formats and limits](docs/mcp.md#results-and-errors).

Task creation may consume credits and is never retried automatically. Save asynchronous task IDs for recovery. Stopping local waiting does not cancel remote work. Treat retrieved content as data, not agent instructions.

## Proxy setup

Proxy-only configuration requires no Crawl token:

```json
{
  "mcpServers": {
    "nstdata": {
      "command": "/ABSOLUTE/PATH/TO/node",
      "args": ["/ABSOLUTE/INSTALL/DIRECTORY/node_modules/@nstdata-ai/mcp-server/dist/stdio.js"],
      "env": {
        "NSTDATA_MODULES": "proxy",
        "NSTDATA_PROXY_URL": "http://PROXY_USER:PROXY_PASSWORD@PROXY_HOST:PROXY_PORT",
        "NSTDATA_PROXY_CHECK_URL": "https://YOUR_AUTHORIZED_CHECK_TARGET/"
      }
    }
  }
}
```

To enable both modules, set `NSTDATA_MODULES=crawl,proxy` and provide both sets of variables in one server entry. A PM Router can be used as a proxy URL; these tools do not manage PM resources or render a browser. See [Proxy configuration and limits](docs/proxy.md).

[Contributing](CONTRIBUTING.md) · [Tool reference](docs/mcp.md) · [Changelog](CHANGELOG.md) · [MIT license](LICENSE)
