# Nstdata MCP Server

[English](README.md)

通过 MCP 客户端使用 Nstdata Crawl 和 HTTP／HTTPS 代理。本地 stdio 服务提供 6 个 Crawl 工具和 2 个 Proxy 工具。

## 安装

需要 Node.js 22 系列的 22.18+ 或 Node.js 24。`1.0.1` 精确依赖 Crawl SDK `2.0.0` 和 proxy checker `1.1.0`；三者已在本地准备，尚未发布。发布后在应用目录安装：

```sh
npm install @nstdata-ai/mcp-server@1.0.1
```

发布前的本地安装见[贡献说明](CONTRIBUTING.md)。

## 配置客户端

将占位符替换为绝对路径和 Crawl Token：

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

服务读取进程环境变量，不自动加载 `.env` 文件。真实凭据保存在客户端受保护配置中；修改配置后重启 MCP 服务。详见[客户端接入与工具契约](docs/mcp.md)。

## 工具

| 工具 | 用途 |
|---|---|
| `nstdata_crawl_scrape` | 提交单页 |
| `nstdata_crawl_scrape_result` | 读取单页结果 |
| `nstdata_crawl_start` | 提交整站任务 |
| `nstdata_crawl_status` | 读取整站进度 |
| `nstdata_crawl_pages` | 读取一页结果 |
| `nstdata_crawl_read_result` | 读取引用分块 |
| `nstdata_proxy_fetch` | 通过代理请求 |
| `nstdata_proxy_check` | 检查预设目标 |

Crawl 支持 Markdown、HTML、链接、PDF、截图和原始数据。结果可能包含内联内容或存储引用；工具不会自动轮询任务或下载引用。

Crawl 选项在提交任务前校验范围，详见[选项限制与浏览器动作](docs/mcp.md#options)。

引用优先于内联内容。没有引用时，PDF／截图／原始数据使用 `{ "encoding": "base64", "base64": "..." }` 字节对象。结果保留服务实际返回的任务 ID 和截断标记；未返回标记不代表内容完整。文本引用或 Proxy 正文不是有效 UTF-8 时返回 `INVALID_RESPONSE`；字段名含配置凭据时返回 `SENSITIVE_OUTPUT`。详见[结果格式与限制](docs/mcp.md#results-and-errors)。

创建任务可能消耗额度，不自动重试。异步任务先保存 ID，再按 ID 恢复；停止本地等待不取消远端任务。网页内容应作为数据处理，不能当作 Agent 指令。

创建请求发生连接中断、服务端错误或响应无法读取时，提交结果可能未知。重新提交前先核查任务历史；未收到 ID 不代表没有创建任务。

## Proxy 配置

仅启用 Proxy 时无需 Crawl Token：

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

同时启用两模块时，将 `NSTDATA_MODULES` 设为 `crawl,proxy`，在同一服务条目中提供两组变量。PM Router 可作为代理 URL 使用；工具不管理 PM 资源，也不渲染浏览器。详见[代理配置与限制](docs/proxy.md)。

[贡献说明](CONTRIBUTING.md) · [工具参考](docs/mcp.md) · [变更记录](CHANGELOG.md) · [MIT 许可](LICENSE)
