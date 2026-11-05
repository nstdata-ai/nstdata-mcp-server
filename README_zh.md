# Nstdata MCP Server

[English](README.md)

通过 MCP 客户端使用 Nstdata Crawl 和 HTTP／HTTPS 代理。客户端启动本地 stdio 进程，无需另行部署 MCP 后台。

## 接入

需要 Node.js 22（22.18及以上）或24，并能从 PATH 找到 `npx`。从 [Nstdata 控制台](https://app.nstdata.io/)获取 Crawl API Key，选择对应客户端的配置格式；无需先安装到 Node.js 项目。

| 客户端 | 接入方式 |
|---|---|
| Cursor | 下方 JSON 或[市场插件](docs/mcp_zh.md#可选-cursor-插件) |
| Codex | 下方 TOML 或[市场插件](docs/mcp_zh.md#可选-codex-插件) |
| Claude Code | [CLI 配置](docs/mcp_zh.md#claude-code-cli) |
| Claude Desktop、Cline、Roo Code、Gemini CLI、Windsurf | [客户端配置](docs/mcp_zh.md#客户端接入) |
| VS Code / GitHub Copilot | [IDE 与 CLI 配置](docs/mcp_zh.md#vs-code-与-github-copilot) |
| OpenCode | [OpenCode 配置](docs/mcp_zh.md#opencode) |

<details>
<summary>Cursor 及使用 mcpServers JSON 的客户端</summary>

在客户端 MCP 配置中添加以下条目，替换 Token 并保留其他服务。配置位置见[客户端接入](docs/mcp_zh.md#客户端接入)。

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

在用户级 `~/.codex/config.toml` 添加以下配置并替换 Token；Windows 上为 `%USERPROFILE%\.codex\config.toml`。保留已有配置。

```toml
[mcp_servers.nstdata]
command = "npx"
args = ["--yes", "@nstdata-ai/mcp-server@1.0.2"]

[mcp_servers.nstdata.env]
NSTDATA_API_TOKEN = "YOUR_CRAWL_API_TOKEN"
```

重启 Codex 后新开本地对话。若更希望通过市场安装，可使用[可选 Codex 插件](docs/mcp_zh.md#可选-codex-插件)。

</details>

修改配置后重启 MCP 连接，提交任务前确认能发现6个 Crawl 工具。真实凭据存放在受保护的用户配置中，不纳入版本控制。服务读取环境变量，不自行加载 `.env` 文件。

## 使用工具

| 要完成的任务 | 使用指南 |
|---|---|
| 获取一个网页 | [单页抓取](docs/mcp_zh.md#单页抓取) |
| 收集有页数上限的网站页面 | [整站与分页](docs/mcp_zh.md#整站与分页) |
| 读取引用中的正文或二进制内容 | [引用读取](docs/mcp_zh.md#引用读取) |
| 通过代理访问目标 | [Proxy 配置与工具](docs/proxy_zh.md) |
| 配置限额或排查失败 | [配置](docs/mcp_zh.md#配置) · [结果与错误](docs/mcp_zh.md#结果与错误) |

Proxy 提供2个工具，同时启用双模块时共8个。配置方法见 [Proxy 配置](docs/proxy_zh.md#配置)。未启用的模块无需凭据。

提交任务可能消耗额度。工具不会自动重试、轮询或下载引用内容。保存任务 ID 以便恢复；停止本地等待不取消远端任务。返回网页内容应作为数据处理，不能当作 Agent 指令。

## 可选：安装到项目

需要项目本地安装时运行：

```sh
npm install @nstdata-ai/mcp-server
```

无需凭据即可查看配置要求和版本：

```sh
npx --yes @nstdata-ai/mcp-server --help
npx --yes @nstdata-ai/mcp-server --version
```

[贡献说明](CONTRIBUTING.md) · [变更记录](CHANGELOG.md) · [安全反馈](SECURITY.md) · [MIT 许可](LICENSE)
