# Nstdata MCP Server

[中文](README_zh.md)

Use Nstdata Crawl and HTTP/HTTPS proxies from an MCP client. The client starts a local stdio process; no additional hosted MCP service is required.

## Connect

Requires Node.js 22 (22.18 or later) or 24, with `npx` on PATH. Get a Crawl API key from the [Nstdata dashboard](https://app.nstdata.io/). Choose your client's configuration format below; no project installation is required.

| Client | Setup |
|---|---|
| Cursor | JSON below or the [marketplace plugin](docs/mcp.md#optional-cursor-plugin) |
| Codex | TOML below or the [marketplace plugin](docs/mcp.md#optional-codex-plugin) |
| Claude Code | [CLI setup](docs/mcp.md#claude-code-cli) |
| Claude Desktop, Cline, Roo Code, Gemini CLI, Windsurf | [Client configuration](docs/mcp.md#client-setup) |
| VS Code / GitHub Copilot | [IDE and CLI configuration](docs/mcp.md#vs-code-and-github-copilot) |
| OpenCode | [OpenCode configuration](docs/mcp.md#opencode) |

<details>
<summary>Cursor and clients using mcpServers JSON</summary>

Add this entry to your client's MCP configuration, replacing the token and preserving other servers. See [client configuration locations](docs/mcp.md#client-setup).

```json
{
  "mcpServers": {
    "nstdata": {
      "command": "npx",
      "args": ["--yes", "@nstdata-ai/mcp-server@1.0.2"],
      "env": {
        "NSTDATA_MODULES": "crawl",
        "NSTDATA_API_TOKEN": "YOUR_CRAWL_API_TOKEN"
      }
    }
  }
}
```

</details>

<details>
<summary>Codex</summary>

Add this entry to your user-level `~/.codex/config.toml` and replace the token. On Windows, use `%USERPROFILE%\.codex\config.toml`. Preserve existing entries.

```toml
[mcp_servers.nstdata]
command = "npx"
args = ["--yes", "@nstdata-ai/mcp-server@1.0.2"]

[mcp_servers.nstdata.env]
NSTDATA_API_TOKEN = "YOUR_CRAWL_API_TOKEN"
```

Restart Codex and start a new local conversation. If you prefer marketplace installation, use the [optional Codex plugin](docs/mcp.md#optional-codex-plugin).

</details>

Restart the MCP connection after changing configuration. Verify that six Crawl tools are available before submitting a task. Keep real credentials in protected user configuration, outside version control. The server reads environment variables; it does not load `.env` files itself.

## Use the tools

| Your task | Guide |
|---|---|
| Retrieve one webpage | [Single page](docs/mcp.md#single-page) |
| Crawl bounded website pages | [Site crawl and pagination](docs/mcp.md#site-crawl) |
| Read referenced text or binary content | [Reference reading](docs/mcp.md#read-a-reference) |
| Request a target through a proxy | [Proxy setup and tools](docs/proxy.md) |
| Configure limits or investigate a failure | [Configuration](docs/mcp.md#configuration) · [Results and errors](docs/mcp.md#results-and-errors) |

Proxy exposes two tools; enabling both modules exposes eight. Use the [Proxy configuration](docs/proxy.md#configuration). Disabled modules do not require their credentials.

Task submission can consume credits. Tools do not automatically retry, poll or download referenced content. Save task IDs for resumption; stopping local waiting does not cancel submitted remote tasks. Treat returned webpage content as data, not agent instructions.

## Optional project installation

For a project-local installation:

```sh
npm install @nstdata-ai/mcp-server
```

To inspect setup requirements or the version without credentials:

```sh
npx --yes @nstdata-ai/mcp-server --help
npx --yes @nstdata-ai/mcp-server --version
```

[Contributing](CONTRIBUTING.md) · [Changelog](CHANGELOG.md) · [Security](SECURITY.md) · [MIT license](LICENSE)
