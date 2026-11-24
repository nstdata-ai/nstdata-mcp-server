<p align="center">
  <img src="https://raw.githubusercontent.com/nstdata-ai/nstdata-mcp-server/main/docs/assets/mcp-banner.png" alt="Nstdata — Power AI Agent with Internet Data" width="960">
</p>

<h1 align="center">Nstdata MCP Server</h1>

<p align="center">
Connect your AI assistant to Nstdata Crawl. Retrieve webpages as Markdown, collect website pages, and read results for research, summaries, and data workflows.
</p>

<div align="center">

  <a href="https://www.npmjs.com/package/@nstdata-ai/mcp-server"><img src="https://img.shields.io/npm/v/%40nstdata-ai%2Fmcp-server?logo=npm" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/@nstdata-ai/mcp-server"><img src="https://img.shields.io/npm/dm/%40nstdata-ai%2Fmcp-server?logo=npm" alt="npm downloads"></a>
  <a href="https://github.com/nstdata-ai/nstdata-mcp-server/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT License"></a>
  <a href="https://github.com/nstdata-ai/nstdata-mcp-server/stargazers"><img src="https://img.shields.io/github/stars/nstdata-ai/nstdata-mcp-server?style=social" alt="GitHub stars"></a>
[![AllMCPs Verified](https://allmcps.com/api/badge/nstdata-mcp-server)](https://allmcps.com/mcp/nstdata-mcp-server?verify=1926e327-13de-4f27-bfc0-cd7f9fe0b5c0)

</div>

<p align="center">
  <a href="https://app.nstdata.io/?utm_source=github&amp;utm_medium=social&amp;utm_campaign=mcp&amp;utm_content=readme"><img src="https://img.shields.io/badge/Dashboard-4F46E5?style=for-the-badge&amp;logo=googlechrome&amp;logoColor=white" alt="Dashboard"></a>
  <a href="https://docs.nstdata.io/docs/crawl/?utm_source=github&amp;utm_medium=social&amp;utm_campaign=mcp&amp;utm_content=readme"><img src="https://img.shields.io/badge/Crawl_API_Docs-2563EB?style=for-the-badge&amp;logo=readthedocs&amp;logoColor=white" alt="Crawl API documentation"></a>
  <a href="https://discord.gg/sMsfTzCpe7"><img src="https://img.shields.io/badge/Join_our_Discord-5865F2?style=for-the-badge&amp;logo=discord&amp;logoColor=white" alt="Join our Discord"></a>
  <a href="https://x.com/nstdata"><img src="https://img.shields.io/badge/Follow_on_X-000000?style=for-the-badge&amp;logo=x&amp;logoColor=white" alt="Follow on X"></a>
</p>

[English](README.md) · [简体中文](README_zh.md)

---

**Start with hosted MCP:** connect to `https://mcp.nstdata.io/crawl` and authorize. No local Node.js or package installation is required. Run the local server when you need HTTP/HTTPS Proxy tools or prefer a local MCP process.

## Features

- **Content for AI workflows:** Markdown, HTML, links, PDF, screenshots, and raw data, depending on the requested output.
- **Single-page and website crawling:** Submit a page or a bounded site crawl, check its status, and retrieve results.
- **Extraction controls:** Main-content extraction, headers, cookies, selectors, and JavaScript rendering options.
- **Hosted or local access:** Six Crawl tools over hosted Streamable HTTP or local stdio.
- **Local Proxy tools:** Check a configured proxy or fetch a URL through it.

Start with a known URL. This server does not provide web search. Requests use your Nstdata permissions and available credits or proxy resources.

## Quick Start — Hosted MCP

**Prompt.** Paste this into your agent to add the hosted connection in your current client:

```text
Connect Nstdata Crawl MCP in this client using the instructions at
https://raw.githubusercontent.com/nstdata-ai/nstdata-skills/main/nstdata-mcp-onboarding/SKILL.md
```

The agent can register the connection where supported. When prompted, complete OAuth in your browser with your Nstdata API Key. [View the onboarding skill](https://github.com/nstdata-ai/nstdata-skills/blob/main/nstdata-mcp-onboarding/SKILL.md).

**cURL.** Run this in a terminal to read the same Skill. The command prints the setup instructions. To start setup, paste the Prompt above into your agent.

```sh
curl -fsSL https://github.com/nstdata-ai/nstdata-skills/raw/main/nstdata-mcp-onboarding/SKILL.md
```

### 1. Prepare your account

Get your **Nstdata API Key** from the [Nstdata dashboard](https://app.nstdata.io/?utm_source=github&utm_medium=social&utm_campaign=mcp&utm_content=readme) to connect to MCP and call the Crawl API. When connecting to hosted MCP, enter the same API key on the authorization page. Make sure your account has available credits.

### 2. Choose your client

Use this **Streamable HTTP** MCP endpoint:

```text
https://mcp.nstdata.io/crawl
```

| Client | Setup |
| --- | --- |
| Codex desktop | Add a Streamable HTTP server in MCP settings. No CLI required. |
| Codex CLI | Add the server in a terminal, then authorize. |
| Claude Code | Add the server in a terminal, then authorize through `/mcp`. |
| Cursor | Install the [hosted Crawl plugin](https://github.com/nstdata-ai/nstdata-mcp-server/blob/main/plugins/nstdata-crawl/README.md) or use the remote JSON below. |
| Claude web / desktop | Add a custom remote connector with the endpoint above. |
| Other clients | Add a Streamable HTTP connection with OAuth or an `X-API-Key` header. Configuration fields vary by client. |

Commands run in a terminal. JSON and TOML belong in configuration files. Natural-language requests go in the agent conversation. Choose one Nstdata Crawl connection for the session to avoid duplicate tools.

<details>
<summary><strong>Codex desktop</strong></summary>

1. Open MCP settings, or **Plugins → Add → Add MCP server**, depending on your app version.
2. Set the name to `nstdata`, select **Streamable HTTP**, and enter `https://mcp.nstdata.io/crawl`.
3. Save and restart the connection if prompted. Select **Authenticate** or the equivalent authorization action.
4. Enter your Nstdata API key on the authorization page and select **Authorize**. Return to Codex and start a new conversation.

For OAuth, leave manual bearer-token fields and authentication headers empty. Installing Codex CLI is not required.

</details>

<details>
<summary><strong>Codex CLI</strong></summary>

In a terminal with Codex CLI installed:

```sh
codex mcp add nstdata --url https://mcp.nstdata.io/crawl
```

Complete browser authorization. If it does not start automatically, run:

```sh
codex mcp login nstdata
```

Use `/mcp` inside Codex CLI to inspect the connection. Codex desktop and CLI share MCP configuration on the same Codex host; adding the connection through one entry point is sufficient.

</details>

<details>
<summary><strong>Claude Code</strong></summary>

In a terminal with Claude Code installed:

```sh
claude mcp add --transport http --scope user nstdata https://mcp.nstdata.io/crawl
```

Start Claude Code, enter `/mcp`, select `nstdata`, and follow the authorization flow. Enter your Nstdata API key on the Nstdata authorization page. Return to Claude Code and confirm the tools are available.

The terminal command adds the server; it does not by itself complete authorization.

</details>

<details>
<summary><strong>Cursor</strong></summary>

To install the hosted plugin, open **Add Marketplace → Import from GitHub** in Cursor’s plugin settings and enter `https://github.com/nstdata-ai/nstdata-mcp-server.git`. Choose **nstdata-crawl → Add for Myself**, connect its **crawl** server in MCP settings, and complete authorization in your browser. The **nstdata** plugin in the same repository runs locally and also supports Proxy.

**Manual setup.** Merge this into your user `~/.cursor/mcp.json` or project `.cursor/mcp.json`, preserving existing servers:

```json
{
  "mcpServers": {
    "nstdata": {
      "url": "https://mcp.nstdata.io/crawl"
    }
  }
}
```

Save, open Cursor's MCP settings, and connect or authenticate `nstdata`. Enter your Nstdata API key on the authorization page, then return to an Agent conversation. Do not add authentication headers to this OAuth configuration.

</details>

<details>
<summary><strong>Claude web / desktop and other remote clients</strong></summary>

In Claude, open **Customize → Connectors** or **Settings → Connectors**, depending on your version. Add a custom connector named `Nstdata` with `https://mcp.nstdata.io/crawl` as its remote URL, complete authorization, and enable it for your conversation. Availability can depend on your account and organization settings.

For another client, select Streamable HTTP, enter the same URL, and authorize using its MCP connection controls. A client that only supports local stdio or legacy SSE cannot use this configuration directly. The endpoint is not a webpage to open for login; the client starts authorization.

</details>

### 3. Try a page

Confirm that six `nstdata_crawl_*` tools are available, then send this in your agent conversation:

> Use Nstdata to retrieve https://example.com/ as Markdown and summarize it. Submit the scrape only once. If it returns an asynchronous task, query that task; if it returns a content reference, read it before summarizing. On failure, report the step and error without submitting another scrape.

A successful first run retrieves the page body, not just its title or description. One scrape may require several follow-up tool calls to query or read results.

## Connect with an API key

Hosted MCP also supports direct API-key authentication through `X-API-Key`. It uses the **same MCP endpoint** and does not require browser OAuth. Choose one authentication method per connection.

<details>
<summary><strong>Cursor and clients supporting url / headers JSON</strong></summary>

Merge into the client's MCP configuration and replace the placeholder:

```json
{
  "mcpServers": {
    "nstdata-key": {
      "url": "https://mcp.nstdata.io/crawl",
      "headers": {
        "X-API-Key": "YOUR_NSTDATA_API_KEY"
      }
    }
  }
}
```

</details>

<details>
<summary><strong>Codex desktop or CLI</strong></summary>

Merge into `~/.codex/config.toml` (`%USERPROFILE%\.codex\config.toml` on Windows):

```toml
[mcp_servers.nstdata-key]
url = "https://mcp.nstdata.io/crawl"
http_headers = { "X-API-Key" = "YOUR_NSTDATA_API_KEY" }
```

Alternatively, if the Codex process can read `NSTDATA_API_TOKEN`, replace `http_headers` with:

```toml
# Environment variable name, not the key value.
env_http_headers = { "X-API-Key" = "NSTDATA_API_TOKEN" }
```

A desktop app does not necessarily inherit variables exported in a separate terminal. The configuration-file option does not require CLI installation.

</details>

<details>
<summary><strong>Claude Code</strong></summary>

First set `NSTDATA_API_TOKEN` in the same terminal. Choose your shell:

macOS zsh:

```zsh
read -r -s "NSTDATA_API_TOKEN?Nstdata API Key: "
export NSTDATA_API_TOKEN
```

Linux Bash:

```bash
read -r -s -p "Nstdata API Key: " NSTDATA_API_TOKEN
export NSTDATA_API_TOKEN
```

Then, for either shell:

```bash
claude mcp add --header "X-API-Key: ${NSTDATA_API_TOKEN:?Set NSTDATA_API_TOKEN}" --transport http --scope user nstdata-key https://mcp.nstdata.io/crawl
```

Windows PowerShell:

```powershell
$nstdataSecret = Read-Host "Nstdata API Key" -AsSecureString
$env:NSTDATA_API_TOKEN = [System.Net.NetworkCredential]::new("", $nstdataSecret).Password
if ([string]::IsNullOrWhiteSpace($env:NSTDATA_API_TOKEN)) { throw "API Key is empty" }
claude mcp add --header "X-API-Key: $env:NSTDATA_API_TOKEN" --transport http --scope user nstdata-key https://mcp.nstdata.io/crawl
```

Keep `--header` before `--transport` and `--scope` to avoid ambiguity with variadic option parsing. These commands save the expanded key in the client configuration; update it when rotating the key. Enter `/mcp` in Claude Code to inspect the connection.

</details>

Keep populated configurations private and outside version control. Disable the duplicate OAuth entry before using the API-key connection. Do not put your business API key in a bearer-token field or URL: `Authorization: Bearer` is for OAuth access tokens here.

## Run locally

Use local stdio for Proxy tools or when you want the MCP adapter to run in your client environment. **Local Crawl still calls Nstdata's cloud API**; it is not an offline crawler.

Requirements: Node.js **22.18+ on the 22.x release line, or 24.x**, and `npx` on the client's PATH. The following examples pin package **1.0.5**. No Node.js project or separate `npm install` is required.

<details>
<summary><strong>Cursor / Claude Desktop / mcpServers clients</strong></summary>

For Cursor, use `~/.cursor/mcp.json` or `.cursor/mcp.json`. For Claude Desktop, use **Settings → Developer → Edit Config**. Merge the entry and replace the key:

```json
{
  "mcpServers": {
    "nstdata-local": {
      "command": "npx",
      "args": ["--yes", "@nstdata-ai/mcp-server@1.0.5"],
      "env": {
        "NSTDATA_MODULES": "crawl",
        "NSTDATA_API_TOKEN": "YOUR_NSTDATA_API_KEY"
      }
    }
  }
}
```

</details>

<details>
<summary><strong>Codex desktop or CLI</strong></summary>

Merge into your user `config.toml`:

```toml
[mcp_servers.nstdata-local]
command = "npx"
args = ["--yes", "@nstdata-ai/mcp-server@1.0.5"]

[mcp_servers.nstdata-local.env]
NSTDATA_MODULES = "crawl"
NSTDATA_API_TOKEN = "YOUR_NSTDATA_API_KEY"
```

In the desktop app, you can instead add a **STDIO** server and enter the same command, arguments, and environment variables.

</details>

For native Windows clients that cannot launch `npx` directly, use command `cmd` and arguments `["/c", "npx", "--yes", "@nstdata-ai/mcp-server@1.0.5"]`. For WSL, configure Node.js and the service inside WSL. If a desktop app cannot find `npx`, use its actual absolute path.

Save and restart the connection. The client starts and manages the process. Confirm six Crawl tools, then try the same page prompt above. The server reads environment variables and does not load `.env` files itself; credential-file support depends on the client.

### Local plugins and more clients

The repository also provides **local stdio plugins**. Installing one does not connect to hosted MCP and still requires Node.js and credentials. Use either a plugin or a manual configuration for the same connection.

| Client | Detailed setup |
| --- | --- |
| Codex | [Local plugin and credential file](https://github.com/nstdata-ai/nstdata-mcp-server/blob/main/docs/mcp.md#optional-codex-plugin) |
| Cursor | [Local plugin and API-key form](https://github.com/nstdata-ai/nstdata-mcp-server/blob/main/docs/mcp.md#optional-cursor-plugin) |
| Claude Code | [Local CLI](https://github.com/nstdata-ai/nstdata-mcp-server/blob/main/docs/mcp.md#claude-code-cli) · [Local plugin](https://github.com/nstdata-ai/nstdata-mcp-server/blob/main/docs/mcp.md#optional-claude-code-plugin) |
| Gemini CLI | [Extension](https://github.com/nstdata-ai/nstdata-mcp-server/blob/main/docs/mcp.md#gemini-cli-extension) |
| VS Code / GitHub Copilot | [Client configuration](https://github.com/nstdata-ai/nstdata-mcp-server/blob/main/docs/mcp.md#vs-code-and-github-copilot) |
| Cline, Windsurf, OpenCode and others | [Client guide](https://github.com/nstdata-ai/nstdata-mcp-server/blob/main/docs/mcp.md) |

Plugin runtime versions are defined by their manifests; updating npm `latest` alone does not update an installed plugin.

### Local Proxy tools

Create a channel and generate an HTTP/HTTPS proxy connection in the [Nstdata dashboard](https://app.nstdata.io/?utm_source=github&utm_medium=social&utm_campaign=mcp&utm_content=readme). Copy the **complete proxy URL** from the generated cURL example: the value after `--proxy`, not the whole command. Keep the full generated username, including routing/session parameters; a channel ID alone may not be sufficient. These tools do not create channels.

<details>
<summary><strong>Proxy configuration</strong></summary>

Merge this as a separate local entry; replace the complete URL placeholder:

```json
{
  "mcpServers": {
    "nstdata-proxy": {
      "command": "npx",
      "args": ["--yes", "@nstdata-ai/mcp-server@1.0.5"],
      "env": {
        "NSTDATA_MODULES": "proxy",
        "NSTDATA_PROXY_URL": "YOUR_COMPLETE_PROXY_URL",
        "NSTDATA_PROXY_CHECK_URL": "https://api.nstdata.io/api/v2/public/utility/client-ip"
      }
    }
  }
}
```

A fictional URL illustrating the shape is:

```text
http://DEMOCHANNEL001-residential_lite-country_AU-r_10m-s_demo01:DEMO_PASSWORD@gate.nstproxy.io:24125
```

Use your dashboard-generated value rather than constructing credentials from this example. The Windows command adjustment above also applies. In Codex, use the same variables under the service's TOML `env` table.

</details>

Proxy-only mode exposes two tools and does not require a Nstdata API Key. Set `NSTDATA_MODULES=crawl,proxy` and supply both credentials to enable eight tools in one local process. SOCKS proxies are not supported.

Try: “Call `nstdata_proxy_check` once. Report its result; if it fails, report the error without retrying.” The configured target above can return an exit IP; the default `https://example.com/` only checks connectivity. See the [Proxy guide](https://github.com/nstdata-ai/nstdata-mcp-server/blob/main/docs/proxy.md).

## Choose a tool

| Tool | Use it to |
| --- | --- |
| `nstdata_crawl_scrape` | Submit one page; input `url`. |
| `nstdata_crawl_scrape_result` | Query an asynchronous single-page task with `taskId`. |
| `nstdata_crawl_start` | Start a website crawl with explicit page/depth limits. |
| `nstdata_crawl_status` | Check an existing `crawlId` once. |
| `nstdata_crawl_pages` | Retrieve pages and their statuses, with cursor pagination. |
| `nstdata_crawl_read_result` | Read a returned reference using `ref` and matching `format`. |
| `nstdata_proxy_check` | Check the configured proxy target; local only. |
| `nstdata_proxy_fetch` | Make a GET or HEAD request through the proxy; local only. |

For `markdownRef`, pass its value as `ref` with `format: "markdown"`. Continue with the returned `nextOffset` when present. For async scrape submissions, use the returned `id` as `taskId`; for website crawls, use it as `crawlId`. A synchronous response ID alone does not guarantee a queryable asynchronous task.

Tools do not automatically retry, poll, or read references. The agent can make follow-up calls. Preserve existing task IDs and references; a timeout does not cancel a submitted job.

## Example requests

- **Summarize an article:** “Read this URL with Nstdata, retrieve its complete Markdown, and summarize the key points with the source URL.”
- **Compare pages:** “Read these two product URLs and compare their published features. Mark information missing from the retrieved pages.”
- **Read a small site:** “Crawl this documentation URL with `maxPages=2`. Query the existing crawl and retrieve the pages before summarizing. Report any failed pages.”

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| Added or authorized, but no tools in the conversation | Reload the connection and start a new conversation. Inspect MCP startup errors; saved configuration is not proof of a working connection. |
| OAuth link expired | Start a fresh authorization from the client rather than reusing the old browser link. |
| OAuth refresh fails / `invalid_scope` | Reauthorize; if it persists, report the client version and sanitized error. Where supported, test X-API-Key separately. Preserve existing task references. |
| Crawl reports insufficient credits | Add credits to the workspace associated with your API key, or contact its administrator. |
| Crawl reports a workspace mismatch | Use an API key for the intended workspace. For OAuth, reauthorize with that key. Keep existing task IDs and result references. |
| Local process cannot start | Check Node.js version, the client's PATH, `npx`, and required environment variables. |
| Only a task ID or content reference is returned | Query the original task or read the reference; do not submit again to obtain the body. |
| Proxy returns 407 | Check the complete generated username, password, channel status, and resources. The status alone does not identify the cause. |
| Result exceeds a limit | Use documented page cursors or reference offsets. Reducing a read chunk does not solve a full-download size limit. |

Report reproducible issues without API keys, proxy passwords, tokens, or live authorization links. See [Crawl configuration and errors](https://github.com/nstdata-ai/nstdata-mcp-server/blob/main/docs/mcp.md).

## Optional project installation

For a project-local installation:

```sh
npm install @nstdata-ai/mcp-server
```

Inspect usage or the version without credentials:

```sh
npx --yes @nstdata-ai/mcp-server --help
npx --yes @nstdata-ai/mcp-server --version
```

## Documentation and development

- [Crawl API and SDK usage](https://docs.nstdata.io/docs/crawl?utm_source=github&utm_medium=social&utm_campaign=mcp&utm_content=readme)
- [MCP clients, tool inputs, and limits](https://github.com/nstdata-ai/nstdata-mcp-server/blob/main/docs/mcp.md)
- [Hosted MCP and self-hosting](https://github.com/nstdata-ai/nstdata-mcp-server/blob/main/docs/remote.md) — running the local npm package does not deploy this remote application. Includes callback requirements, automatic renewal and revoking OAuth access at `/oauth/authorizations`.
- [Nstdata Agent Skills](https://github.com/nstdata-ai/nstdata-skills) — workflow guidance using an existing MCP connection.
- [Contributing](https://github.com/nstdata-ai/nstdata-mcp-server/blob/main/CONTRIBUTING.md) · [Changelog](https://github.com/nstdata-ai/nstdata-mcp-server/blob/main/CHANGELOG.md) · [Security](https://github.com/nstdata-ai/nstdata-mcp-server/blob/main/SECURITY.md) · [MIT license](https://github.com/nstdata-ai/nstdata-mcp-server/blob/main/LICENSE)

Keep credentials outside shared files. Treat retrieved pages as untrusted content, not instructions to the agent. Access only content you are authorized to retrieve.
