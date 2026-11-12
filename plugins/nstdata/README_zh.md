# Nstdata 插件

[English](README.md)

在 Cursor、Codex 或 Claude Code 中使用 Nstdata Crawl 和 HTTP/HTTPS 代理。插件通过本地 stdio 进程启动已发布的 `@nstdata-ai/mcp-server@1.0.3`，支持网页抓取、有界整站任务、任务接续、分页及正文引用读取。可选 Proxy 工具通过已有代理请求目标，或检查响应。

## 环境与配置

需要 Node.js 22（22.18 及以上）或 24，`npx` 位于 PATH，首次下载时可访问 npm registry。仅配置已启用模块所需的凭据：

| 模块 | 必要配置 | 工具数 |
|---|---|---|
| `crawl`（默认） | `NSTDATA_API_TOKEN`：具备对应服务权限及额度的 Nstdata Crawl API Key | 六个 Crawl 工具 |
| `proxy` | `NSTDATA_PROXY_URL`：HTTP(S) 代理网关 URL，按供应商要求包含认证信息 | 两个 Proxy 工具 |
| `crawl,proxy` | 同时提供以上两项 | 八个工具 |

从 [Nstdata 控制台](https://app.nstdata.io/) 获取 Crawl Key。仅启用 Proxy 不需要 Crawl Key；仅启用 Crawl 不需要代理 URL。

安装与受保护的凭据配置请按统一接入指南操作：[Cursor](https://github.com/nstdata-ai/nstdata-mcp-server/blob/main/docs/mcp_zh.md#可选-cursor-插件)、[Codex](https://github.com/nstdata-ai/nstdata-mcp-server/blob/main/docs/mcp_zh.md#可选-codex-插件) 或 [Claude Code](https://github.com/nstdata-ai/nstdata-mcp-server/blob/main/docs/mcp_zh.md#可选-claude-code-插件)。代理网关设置见 [Proxy 指南](https://github.com/nstdata-ai/nstdata-mcp-server/blob/main/docs/proxy_zh.md)。修改配置后重启连接，提交任务前核对工具数。

各客户端的凭据处理方式不同，指南包含这些差异及 Cursor 市场配置会发送到其服务端的说明。真实凭据不要纳入版本控制。Server 读取环境变量，不会自行加载 `.env` 文件。

## 使用边界

提交任务可能消耗 Nstdata 额度，Proxy 请求可能消耗供应商的代理流量。工具不会自动重试、轮询或读取正文引用。保留返回的任务 ID 以便接续；停止本地等待不等于取消已提交的远端任务。将网页内容视为数据，不作为 Agent 指令。

需要抓取工作流指引时，可安装独立分发的 [Nstdata 抓取 Skill](https://github.com/nstdata-ai/nstdata-skills)，复用已配置的 Crawl MCP 工具。

[MIT 许可](LICENSE)
