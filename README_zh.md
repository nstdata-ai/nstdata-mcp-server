<p align="center">
  <img src="https://raw.githubusercontent.com/nstdata-ai/nstdata-mcp-server/main/docs/assets/mcp-banner.png" alt="Nstdata — Power AI Agent with Internet Data" width="960">
</p>

<h1 align="center">Nstdata MCP Server</h1>

<p align="center">
让 AI 助手通过 Nstdata Crawl 读取网页、收集网站页面，并将结果用于摘要、研究和数据工作流。
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@nstdata-ai/mcp-server"><img src="https://img.shields.io/npm/v/%40nstdata-ai%2Fmcp-server?logo=npm" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/@nstdata-ai/mcp-server"><img src="https://img.shields.io/npm/dm/%40nstdata-ai%2Fmcp-server?logo=npm" alt="npm downloads"></a>
  <a href="https://github.com/nstdata-ai/nstdata-mcp-server/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT License"></a>
  <a href="https://github.com/nstdata-ai/nstdata-mcp-server/stargazers"><img src="https://img.shields.io/github/stars/nstdata-ai/nstdata-mcp-server?style=social" alt="GitHub stars"></a>
</p>

<p align="center">
  <a href="https://app.nstdata.io/?utm_source=github&amp;utm_medium=social&amp;utm_campaign=mcp&amp;utm_content=readme"><img src="https://img.shields.io/badge/Dashboard-4F46E5?style=for-the-badge&amp;logo=googlechrome&amp;logoColor=white" alt="控制台"></a>
  <a href="https://docs.nstdata.io/zh-CN/docs/crawl/?utm_source=github&amp;utm_medium=social&amp;utm_campaign=mcp&amp;utm_content=readme"><img src="https://img.shields.io/badge/Crawl_API_Docs-2563EB?style=for-the-badge&amp;logo=readthedocs&amp;logoColor=white" alt="Crawl API 文档"></a>
  <a href="https://discord.gg/sMsfTzCpe7"><img src="https://img.shields.io/badge/Join_our_Discord-5865F2?style=for-the-badge&amp;logo=discord&amp;logoColor=white" alt="加入 Discord"></a>
  <a href="https://x.com/nstdata"><img src="https://img.shields.io/badge/Follow_on_X-000000?style=for-the-badge&amp;logo=x&amp;logoColor=white" alt="关注 X"></a>
</p>

[English](README.md) · [简体中文](README_zh.md)

---

**推荐从托管 MCP 开始：** 连接 `https://mcp.nstdata.io/crawl` 并完成授权，无需安装 Node.js 或下载 MCP 包。需要 HTTP／HTTPS Proxy 工具，或希望在本机运行 MCP 适配程序时，再选择本地模式。

## 主要能力

- **适合 AI 使用的内容：** 按需返回 Markdown、HTML、链接、PDF、截图或原始数据。
- **单页和整站抓取：** 提交网页或有范围限制的网站任务，查询进度并读取结果。
- **页面提取控制：** 支持正文提取、请求头、Cookie、选择器和 JavaScript 渲染选项。
- **托管与本地接入：** 通过 Streamable HTTP 或本地 stdio 使用六个 Crawl 工具。
- **本地代理工具：** 检测已配置的代理，或通过代理请求网页。

从已知 URL 开始使用；本服务不提供搜索引擎工具。请求使用你的 Nstdata 权限、可用额度或代理资源。

## 快速开始 使用托管 MCP

**Prompt · 一句话接入。** 把下面这段话粘贴到你正在使用的 Agent：

```text
请按下面的说明在当前客户端接入 Nstdata Crawl MCP：
https://raw.githubusercontent.com/nstdata-ai/nstdata-skills/main/nstdata-mcp-onboarding/SKILL.md
```

Agent 会在客户端支持的情况下帮你添加连接。在浏览器中用 Nstdata 账号完成授权即可。[查看接入 Skill](https://github.com/nstdata-ai/nstdata-skills/blob/main/nstdata-mcp-onboarding/SKILL.md)。

**cURL · 查看接入说明。** 在终端运行下面的命令，会显示同一份 Skill。要开始接入，请把上面的 Prompt 发给 Agent。

```sh
curl -fsSL https://github.com/nstdata-ai/nstdata-skills/raw/main/nstdata-mcp-onboarding/SKILL.md
```

### 第一步 准备账号

准备一个有 Crawl 权限的 Nstdata 账号。客户端打开授权页后，按提示登录，核对申请访问的应用和 **Billing workspace**（计费工作区），再点击 **Authorize and return** 返回客户端。抓取使用所选工作区的额度，账号授权全程无需填写 API Key。

也可以选择 **Use an existing API Key**，在 Nstdata 授权页填写已有的 Crawl API Key，再点击 **Authorize**。 可在 [Nstdata 控制台](https://app.nstdata.io/?utm_source=github&utm_medium=social&utm_campaign=mcp&utm_content=readme) 获取 Key。

### 第二步 选择客户端

通用 **Streamable HTTP** MCP 地址：

```text
https://mcp.nstdata.io/crawl
```

| 客户端 | 接入入口 |
| --- | --- |
| Codex 桌面版 | 在 MCP 设置添加流式 HTTP 服务，按下方步骤授权，无需安装 CLI。 |
| Codex CLI | 执行 `codex mcp add nstdata --url https://mcp.nstdata.io/crawl`，然后授权。 |
| Claude Code | 执行 `claude mcp add --transport http --scope user nstdata https://mcp.nstdata.io/crawl`，然后通过 `/mcp` 授权。 |
| Cursor | 安装[托管 Crawl 插件](https://github.com/nstdata-ai/nstdata-mcp-server/blob/main/plugins/nstdata-crawl/README.md)，或使用下方远程 JSON 配置。 |
| Claude 网页／桌面端 | 添加自定义远程连接器，填写上述地址。 |
| Hermes Agent | [添加托管服务、通过浏览器授权并抓取第一个网页](#hermes-agent)。 |
| 其他客户端 | 添加 Streamable HTTP 服务，使用 OAuth 或 X-API-Key；配置字段以客户端要求为准。 |

终端命令在系统终端执行；JSON／TOML 写入配置文件；抓取请求发送到 Agent 对话框。同一会话选择一个 Nstdata Crawl 连接，避免工具重复。

<details>
<summary><strong>Codex 桌面版</strong></summary>

1. 打开 MCP 设置，或进入「插件 → 添加 → 添加 MCP 服务器」，具体名称随版本变化。
2. 名称填 `nstdata`，类型选「流式 HTTP／Streamable HTTP」，地址填 `https://mcp.nstdata.io/crawl`。
3. 保存，按提示重启连接，点击 Authenticate／授权。
4. 在浏览器中按提示登录 Nstdata，确认计费工作区，点击 **Authorize and return**。返回 Codex 并新开对话。

OAuth 模式下，手动 Bearer Token 和认证请求头留空。只安装桌面应用即可操作。

</details>

<details>
<summary><strong>Codex CLI</strong></summary>

需要已安装 Codex CLI，在终端执行：

```sh
codex mcp add nstdata --url https://mcp.nstdata.io/crawl
```

按提示完成浏览器授权。若没有自动发起授权，再执行：

```sh
codex mcp login nstdata
```

在 Codex CLI 会话中输入 `/mcp` 查看连接。同一 Codex 主机上的桌面版与 CLI 共用 MCP 配置，选择一种入口添加即可。

</details>

<details>
<summary><strong>Claude Code</strong></summary>

需要已安装 Claude Code，在终端执行：

```sh
claude mcp add --transport http --scope user nstdata https://mcp.nstdata.io/crawl
```

启动 Claude Code，在会话中输入 `/mcp`，选择 `nstdata` 并发起授权。在浏览器中按提示登录 Nstdata，确认计费工作区，点击 **Authorize and return**。返回 Claude Code，确认工具可用。

添加命令只保存连接配置，不代表已经完成授权。

</details>

<a name="hermes-agent"></a>
<details>
<summary><strong>Hermes Agent</strong></summary>

1. 在安装 Hermes 的设备上运行 `hermes mcp list`。如果已有指向本托管地址的 `nstdata-crawl`，直接到第 3 步。首次接入在终端运行：

   ```sh
   hermes mcp add nstdata-crawl --url https://mcp.nstdata.io/crawl --auth oauth
   ```

2. 打开 Hermes 终端给出的授权链接。在浏览器中按提示登录 Nstdata，确认计费工作区，点击 **Authorize and return**。回到终端，在工具选择提示处按回车，启用发现的工具并保存。
3. 运行 `hermes mcp test nstdata-crawl`。看到 `Connected` 和 `Tools discovered: 6` 后，运行 `hermes chat` 开启新对话。
4. 在对话中发送：

   > 用 nstdata-crawl 抓取 https://example.org/ ，只提交一次。返回页面标题、来源网址和 Markdown 正文。若任务在处理，查询已有任务；若返回 markdownRef，继续读取，直到正文完整。失败时说明停在哪一步。

   成功时应能看到 **Example Domain** 和网页正文。若授权过期，运行 `hermes mcp login nstdata-crawl` 完成授权，再用已有任务 ID 或正文引用继续。

</details>

<details>
<summary><strong>Cursor</strong></summary>

打开 Cursor 插件设置，选择 **Add Marketplace → Import from GitHub**，输入 `https://github.com/nstdata-ai/nstdata-mcp-server.git`。选择 **nstdata-crawl → Add for Myself**，在 MCP 设置中连接插件的 **crawl** 服务，按浏览器提示完成授权，即可在 Agent 对话中抓取网页。同仓库的 **nstdata** 插件在本地运行，也支持 Proxy。

**手动配置。** 将以下内容合入用户 `~/.cursor/mcp.json` 或项目 `.cursor/mcp.json`，保留已有服务：

```json
{
  "mcpServers": {
    "nstdata": {
      "url": "https://mcp.nstdata.io/crawl"
    }
  }
}
```

保存后进入 Cursor 的 MCP 设置，找到 `nstdata` 并发起连接。在浏览器中按提示登录 Nstdata，确认计费工作区，点击 **Authorize and return**。返回 Agent 对话。OAuth 配置中的认证请求头留空。

</details>

<details>
<summary><strong>Claude 网页／桌面端及其他远程客户端</strong></summary>

在 Claude 中进入 **Customize → Connectors** 或 **Settings → Connectors**，添加自定义连接器，名称填 `Nstdata`，远程地址填 `https://mcp.nstdata.io/crawl`。完成授权后，在对话中启用连接器。入口和可用性受客户端版本、账号及组织设置影响。

其他客户端选择 Streamable HTTP，填入同一地址，通过客户端的 MCP 连接入口发起授权。只支持本地 stdio 或旧 SSE 的客户端不能直接套用此配置。这个地址不是用于直接打开登录的网页，授权由客户端发起。

</details>

### 第三步 试一次抓取

确认发现六个 `nstdata_crawl_*` 工具后，在 Agent 对话中发送：

> 使用 Nstdata 抓取 https://example.com/，返回 Markdown 并用中文总结。只提交一次抓取；如果返回异步任务，请查询原任务；如果返回正文引用，请先读取引用。失败时告诉我失败步骤和错误，不要重新提交抓取。

首次成功应取得网页正文，而不只是标题或描述。一次抓取可能包含多次后续查询和正文读取调用。

## 使用 API Key 直接连接

托管 MCP 同时支持通过 `X-API-Key` 请求头直接认证，使用**同一个 MCP 地址**，无需浏览器 OAuth。每条连接选择一种认证方式。

<details>
<summary><strong>Cursor 及支持 url／headers JSON 的客户端</strong></summary>

合入客户端 MCP 配置，替换 Key 占位值：

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
<summary><strong>Codex 桌面版或 CLI</strong></summary>

合入 `~/.codex/config.toml`；Windows 为 `%USERPROFILE%\.codex\config.toml`：

```toml
[mcp_servers.nstdata-key]
url = "https://mcp.nstdata.io/crawl"
http_headers = { "X-API-Key" = "YOUR_NSTDATA_API_KEY" }
```

若 Codex 启动环境已提供 `NSTDATA_API_TOKEN`，也可将上面的 `http_headers` 替换为：

```toml
# Environment variable name, not the key value.
env_http_headers = { "X-API-Key" = "NSTDATA_API_TOKEN" }
```

桌面应用不一定继承其他终端中 export 的变量。编辑配置文件不要求安装 CLI。

</details>

<details>
<summary><strong>Claude Code</strong></summary>

在同一个终端中设置 `NSTDATA_API_TOKEN`，按所用系统选择：

macOS zsh：

```zsh
read -r -s "NSTDATA_API_TOKEN?Nstdata API Key: "
export NSTDATA_API_TOKEN
```

Linux Bash：

```bash
read -r -s -p "Nstdata API Key: " NSTDATA_API_TOKEN
export NSTDATA_API_TOKEN
```

以上两种 shell 设置完成后，执行：

```bash
claude mcp add --header "X-API-Key: ${NSTDATA_API_TOKEN:?Set NSTDATA_API_TOKEN}" --transport http --scope user nstdata-key https://mcp.nstdata.io/crawl
```

Windows PowerShell：

```powershell
$nstdataSecret = Read-Host "Nstdata API Key" -AsSecureString
$env:NSTDATA_API_TOKEN = [System.Net.NetworkCredential]::new("", $nstdataSecret).Password
if ([string]::IsNullOrWhiteSpace($env:NSTDATA_API_TOKEN)) { throw "API Key is empty" }
claude mcp add --header "X-API-Key: $env:NSTDATA_API_TOKEN" --transport http --scope user nstdata-key https://mcp.nstdata.io/crawl
```

将 `--header` 放在 `--transport` 和 `--scope` 前，避免可变参数解析歧义。命令会把展开后的真实 Key 保存到客户端配置，更换 Key 时需更新配置。在 Claude Code 对话中输入 `/mcp` 检查连接。

</details>

填写真实凭据后的配置应保持私密，不提交 Git。使用 API Key 连接前停用重复的 OAuth 条目。不要将业务 API Key 放进 Bearer Token 字段或 URL；这里的 `Authorization: Bearer` 用于 OAuth access token。

## 在本地运行

需要 Proxy 工具或希望在客户端环境运行 MCP 适配程序时，使用本地 stdio。**本地 Crawl 仍调用 Nstdata 云端 API**，并不是离线爬虫。

需要 Node.js **22.18+（22.x）或 24.x**，客户端能从 PATH 找到 `npx`。以下示例固定使用 **1.0.5**，无需创建 Node.js 项目或另外执行 `npm install`。

<details>
<summary><strong>Cursor／Claude Desktop／mcpServers 客户端</strong></summary>

Cursor 使用 `~/.cursor/mcp.json` 或 `.cursor/mcp.json`；Claude Desktop 从 **Settings → Developer → Edit Config** 打开配置。合入条目并替换 Key：

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
<summary><strong>Codex 桌面版或 CLI</strong></summary>

合入用户 `config.toml`：

```toml
[mcp_servers.nstdata-local]
command = "npx"
args = ["--yes", "@nstdata-ai/mcp-server@1.0.5"]

[mcp_servers.nstdata-local.env]
NSTDATA_MODULES = "crawl"
NSTDATA_API_TOKEN = "YOUR_NSTDATA_API_KEY"
```

也可在桌面端添加 **STDIO** 服务，填写相同的启动命令、参数和环境变量。

</details>

Windows 原生客户端不能直接启动 `npx` 时，将 command 改为 `cmd`，args 改为 `["/c", "npx", "--yes", "@nstdata-ai/mcp-server@1.0.5"]`。使用 WSL 时，在 WSL 中安装 Node.js 并配置服务。桌面应用找不到 `npx` 时，可填写本机真实的绝对路径。

保存并重启连接，客户端会启动和管理进程。确认六个 Crawl 工具后，发送上面的抓取示例。服务读取环境变量，本身不自动加载 `.env`；独立凭据文件是否可用取决于客户端。

### 本地插件和更多客户端

仓库还提供**本地 stdio 插件**。安装它们不会连接托管 MCP，仍然需要 Node.js 和相应凭据。同一连接选择插件或手动配置其中一种。

| 客户端 | 详细接入 |
| --- | --- |
| Codex | [本地插件及凭据文件](https://github.com/nstdata-ai/nstdata-mcp-server/blob/main/docs/mcp_zh.md#可选-codex-插件) |
| Cursor | [本地插件及 Key 表单](https://github.com/nstdata-ai/nstdata-mcp-server/blob/main/docs/mcp_zh.md#可选-cursor-插件) |
| Claude Code | [本地 CLI](https://github.com/nstdata-ai/nstdata-mcp-server/blob/main/docs/mcp_zh.md#claude-code-cli) · [本地插件](https://github.com/nstdata-ai/nstdata-mcp-server/blob/main/docs/mcp_zh.md#可选-claude-code-插件) |
| Gemini CLI | [扩展安装](https://github.com/nstdata-ai/nstdata-mcp-server/blob/main/docs/mcp_zh.md#gemini-cli-扩展) |
| VS Code／GitHub Copilot | [客户端配置](https://github.com/nstdata-ai/nstdata-mcp-server/blob/main/docs/mcp_zh.md#vs-code-与-github-copilot) |
| Cline、Windsurf、OpenCode 等 | [客户端指南](https://github.com/nstdata-ai/nstdata-mcp-server/blob/main/docs/mcp_zh.md) |

插件运行版本由自身清单决定，仅更新 npm 的 latest 不会更新已安装插件。

### 使用本地 Proxy

先在 [Nstdata 控制台](https://app.nstdata.io/?utm_source=github&utm_medium=social&utm_campaign=mcp&utm_content=readme)创建通道并生成 HTTP／HTTPS 代理连接。从生成的 cURL 示例中复制 **`--proxy` 后面的完整代理 URL**，不要复制整个命令。保留完整用户名，包括路由和会话参数；只填通道 ID 可能无法认证。这两个工具不负责创建通道。

<details>
<summary><strong>Proxy 配置</strong></summary>

作为独立本地条目合入配置，整体替换 URL 占位值：

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

以下是展示格式的虚构示例：

```text
http://DEMOCHANNEL001-residential_lite-country_AU-r_10m-s_demo01:DEMO_PASSWORD@gate.nstproxy.io:24125
```

使用面板生成的真实完整值，不按此示例自行拼接凭据。Windows 启动命令调整同上；Codex 将相同变量填写在对应服务的 TOML `env` 子表中。

</details>

仅 Proxy 模式提供两个工具，无需 Nstdata API Key。同时使用时设置 `NSTDATA_MODULES=crawl,proxy`，并提供两种凭据，一个本地进程共提供八个工具。不支持 SOCKS 代理。

试一试：“只调用一次 `nstdata_proxy_check`，返回检测结果；失败时报告错误，不重试。”上例的检测目标可回显出口 IP；默认 `https://example.com/` 只检查连通性。详见 [Proxy 指南](https://github.com/nstdata-ai/nstdata-mcp-server/blob/main/docs/proxy_zh.md)。

## 工具选择

| 工具 | 用途 |
| --- | --- |
| `nstdata_crawl_scrape` | 提交单页抓取，输入 `url`。 |
| `nstdata_crawl_scrape_result` | 用 `taskId` 查询异步单页任务。 |
| `nstdata_crawl_start` | 发起网站抓取，明确设置页数／深度限制。 |
| `nstdata_crawl_status` | 用已有 `crawlId` 查询一次状态。 |
| `nstdata_crawl_pages` | 分页读取页面及各自状态。 |
| `nstdata_crawl_read_result` | 用 `ref` 和对应 `format` 读取结果引用。 |
| `nstdata_proxy_check` | 检测配置的代理目标，仅本地提供。 |
| `nstdata_proxy_fetch` | 通过代理执行 GET／HEAD 请求，仅本地提供。 |

返回 `markdownRef` 时，将其值传给 `ref`，格式选 `markdown`；存在 `nextOffset` 时按返回值继续读取。异步单页提交返回的 `id` 用作 `taskId`，整站提交返回的 `id` 用作 `crawlId`。同步响应里存在 ID，不代表一定可以按异步任务查询。

工具不会自动重试、轮询或读取引用，Agent 可继续调用对应工具。保留已有任务 ID 和引用；超时不代表已经提交的远端任务被取消。

## 使用示例

- **总结文章：**“用 Nstdata 读取这个 URL，取得完整 Markdown 后总结要点，并附来源地址。”
- **比较页面：**“读取这两个产品 URL，比较页面公布的功能；未取得的信息请标明。”
- **收集少量文档：**“抓取这个文档站点，设置 maxPages=2。查询原任务并读取页面后总结，报告失败页面。”

## 常见问题

| 现象 | 处理方式 |
| --- | --- |
| 已添加或已授权，但对话没有工具 | 重新加载连接并新开对话，检查 MCP 启动错误；保存配置不代表连接成功。 |
| OAuth 链接失效 | 从客户端重新发起授权，不复用旧浏览器链接。 |
| 刷新失败或 invalid_scope | 重新授权；仍失败时反馈客户端版本及脱敏错误。支持请求头时可单独测试 API Key，保留已有任务引用。 |
| Crawl 提示额度不足 | 检查账号授权时选择的工作区或 API Key 所属工作区的余额。 |
| Crawl 提示工作区不匹配 | 重新授权时选择任务所属的工作区，或使用该工作区的 Key。保留已有任务 ID 和结果引用。 |
| 本地进程无法启动 | 检查 Node.js 版本、客户端 PATH、npx 和必填环境变量。 |
| 只返回任务 ID 或正文引用 | 查询原任务或读取引用，不为取得正文重新提交。 |
| Proxy 返回 407 | 核对完整用户名、密码、通道状态及资源；状态码本身不能确定具体原因。 |
| 结果超过限制 | 按文档使用分页游标或引用偏移；减小读取分块不能解决完整下载体积超限。 |

反馈问题时，不附 API Key、代理密码、令牌或有效授权链接。更多说明见 [Crawl 配置与错误](https://github.com/nstdata-ai/nstdata-mcp-server/blob/main/docs/mcp_zh.md)。

## 可选：安装到项目

如需将服务安装到项目中：

```sh
npm install @nstdata-ai/mcp-server
```

无需凭据即可查看帮助或版本：

```sh
npx --yes @nstdata-ai/mcp-server --help
npx --yes @nstdata-ai/mcp-server --version
```

## 文档与开发

- [Crawl API 与 SDK 使用](https://docs.nstdata.io/zh-CN/docs/crawl?utm_source=github&utm_medium=social&utm_campaign=mcp&utm_content=readme)
- [MCP 客户端、工具参数与限制](https://github.com/nstdata-ai/nstdata-mcp-server/blob/main/docs/mcp_zh.md)
- [托管 MCP 与自行部署](https://github.com/nstdata-ai/nstdata-mcp-server/blob/main/docs/remote_zh.md)：运行本地 npm 包并不会部署这个远程应用。包括回调要求、自动续期与 `/oauth/authorizations` 的授权撤销操作。
- [贡献说明](https://github.com/nstdata-ai/nstdata-mcp-server/blob/main/CONTRIBUTING.md) · [变更记录](https://github.com/nstdata-ai/nstdata-mcp-server/blob/main/CHANGELOG.md) · [安全反馈](https://github.com/nstdata-ai/nstdata-mcp-server/blob/main/SECURITY.md) · [MIT 许可](https://github.com/nstdata-ai/nstdata-mcp-server/blob/main/LICENSE)

凭据不放入共享文件；网页内容作为不可信数据处理，不作为 Agent 指令。仅访问你有权获取的内容。

## 用 Product Scout 跟踪黑五商品价格

[Nstdata Skills 仓库](https://github.com/nstdata-ai/nstdata-skills) 收录了接入 Crawl MCP 后可以直接使用的 Agent 工作流。其中的 [Product Scout 商品查价 Skill](https://github.com/nstdata-ai/nstdata-skills/tree/main/nstdata-product-scout) 可以比较同一商品在不同市场的版本和售价，生成带当地币种和来源链接的交互式 HTML 报告。[黑五查价中文教程](https://github.com/nstdata-ai/nstdata-skills/blob/main/nstdata-product-scout/README_zh.md) 以 GTA VI 为例，演示如何对比价格，以及如何在支持定时任务的客户端设置复查。
