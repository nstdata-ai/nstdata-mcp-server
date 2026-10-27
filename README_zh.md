# Nstdata MCP Server

[English](README.md)

通过 MCP 客户端使用 Nstdata Crawl 和 HTTP／HTTPS 代理。客户端启动本地 stdio 进程，由它调用现有 Nstdata 服务，无需另行部署 MCP 后台。

## 功能入口

| 要完成的任务 | 使用指南 |
|---|---|
| 获取一个网页 | [单页抓取](docs/mcp_zh.md#单页抓取) |
| 收集有页数上限的网站页面 | [整站与分页](docs/mcp_zh.md#整站与分页) |
| 读取引用中的正文或二进制内容 | [引用读取](docs/mcp_zh.md#引用读取) |
| 通过代理访问目标 | [Proxy 配置与工具](docs/proxy_zh.md) |
| 配置限额或排查失败 | [配置](docs/mcp_zh.md#配置) · [结果与错误](docs/mcp_zh.md#结果与错误) |

## 安装

支持 Node.js 22（22.18 及以上）和 24。下方客户端模板可直接通过 `npx` 启动，项目本地安装为可选方式。

```sh
npm install @nstdata-ai/mcp-server
```

## 连接客户端

在客户端 MCP 配置中添加以下条目并替换 Crawl Token，保留其他服务条目。客户端需要能够从 PATH 找到 Node.js 和 `npx`。

```json
{
  "mcpServers": {
    "nstdata": {
      "command": "npx",
      "args": ["--yes", "@nstdata-ai/mcp-server@1.0.1"],
      "env": {
        "NSTDATA_MODULES": "crawl",
        "NSTDATA_API_TOKEN": "YOUR_CRAWL_API_TOKEN"
      }
    }
  }
}
```

修改配置后重启该 MCP 服务。仅 Crawl 时提供6个工具，仅 Proxy 时提供2个，同时启用时提供8个。未启用的模块无需凭据。详见[客户端接入](docs/mcp_zh.md#客户端接入)和[Crawl 工具参考](docs/mcp_zh.md#工具参考)。

进程读取环境变量，不自行加载 `.env` 文件。真实凭据放在受保护的客户端配置中，不纳入版本控制。

## Proxy 配置

使用[仅 Proxy 配置模板](docs/proxy_zh.md#配置)。同时启用两模块时，在同一服务条目中设置 `NSTDATA_MODULES=crawl,proxy` 并提供两组凭据。

提交任务可能消耗额度。工具不会自动重试、轮询或下载引用内容。保存任务 ID 以便恢复；停止本地等待不取消远端任务。返回网页内容应作为数据处理，不能当作 Agent 指令。

[Crawl 完整参考](docs/mcp_zh.md) · [Proxy 参考](docs/proxy_zh.md) · [变更记录](CHANGELOG.md) · [贡献说明](CONTRIBUTING.md) · [安全反馈](SECURITY.md) · [MIT 许可](LICENSE)
