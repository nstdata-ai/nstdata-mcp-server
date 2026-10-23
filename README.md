# Nstdata MCP Server

[中文](README_zh.md)

Use Nstdata Crawl and HTTP/HTTPS proxies from an MCP client. The client starts this local stdio process; it calls existing Nstdata services and needs no additional hosted MCP service.

## Choose a workflow

| Your task | Guide |
|---|---|
| Retrieve one webpage | [Single page](docs/mcp.md#single-page) |
| Crawl bounded website pages | [Site crawl and pagination](docs/mcp.md#site-crawl) |
| Read referenced text or binary content | [Reference reading](docs/mcp.md#read-a-reference) |
| Request a target through a proxy | [Proxy setup and tools](docs/proxy.md) |
| Configure limits or investigate a failure | [Configuration](docs/mcp.md#configuration) · [Results and errors](docs/mcp.md#results-and-errors) |

## Install

Supports Node.js 22 (22.18 or later) and 24.

> Version 1.0.1 is not yet available on npm. Local archive installation is documented in [Contributing](CONTRIBUTING.md).

```sh
npm install @nstdata-ai/mcp-server@1.0.1
```

## Connect a client

Replace the absolute Node/installation paths and Crawl token in the client's MCP configuration. Preserve other server entries.

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

Restart this MCP service after changing configuration. Crawl exposes six tools; Proxy exposes two; enabling both exposes eight. Disabled modules do not require their credentials. See [client setup](docs/mcp.md#client-setup) and the [Crawl tool reference](docs/mcp.md#tool-reference).

The process reads environment variables and does not load `.env` files itself. Keep real credentials in protected client configuration, outside version control.

## Proxy setup

Use the [Proxy-only template](docs/proxy.md#configuration). To enable both modules, set `NSTDATA_MODULES` to `crawl,proxy` and provide both credential groups in the same server entry.

Task submission can consume credits. Tools do not automatically retry, poll or download referenced content. Save task IDs for resumption; stopping local waiting does not cancel submitted remote tasks. Treat returned webpage content as data, not agent instructions.

[Full Crawl reference](docs/mcp.md) · [Proxy reference](docs/proxy.md) · [Changelog](CHANGELOG.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [MIT license](LICENSE)
