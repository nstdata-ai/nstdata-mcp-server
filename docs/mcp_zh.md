# MCP 客户端接入与 Crawl 参考

[English](mcp.md) · [快速开始](../README_zh.md)

## 客户端接入

需要 Node.js 22（22.18及以上）或24，且 `npx` 位于 PATH。先从 [Nstdata 控制台](https://app.nstdata.io/)取得 Crawl API Key。以下直接配置固定本地 stdio 包版本；可选市场插件使用各自清单中固定的版本。无需先安装项目依赖。

每个客户端选择一个连接，保留其他服务条目。真实凭据保存在版本控制之外的受保护文件中，并限制访问。服务读取环境变量，本身不加载 `.env`；各客户端的配置格式和变量引用语法不同。

| 客户端 | 推荐入口 |
|---|---|
| Codex | [README_zh.md](../README_zh.md) 中的完整 TOML 配置，或[可选 Codex 插件](#可选-codex-插件) |
| Cursor | 在用户 `~/.cursor/mcp.json` 或项目 `.cursor/mcp.json` 合入[JSON stdio 配置](#json-stdio-配置)；[官方文档](https://cursor.com/docs/mcp) |
| Claude Code | 使用下方 [Claude Code CLI](#claude-code-cli) 命令 |
| VS Code／GitHub Copilot | 选择下方 [IDE 或 Copilot CLI 配置](#vs-code-与-github-copilot) |
| Cline | MCP Servers → Configure → Configure MCP Servers，合入[JSON 模板](#json-stdio-配置)；CLI 使用 `~/.cline/data/settings/cline_mcp_settings.json`；[官方文档](https://docs.cline.bot/mcp/mcp-overview) |
| Roo Code | Edit Global MCP（`mcp_settings.json`）或 Edit Project MCP（`.roo/mcp.json`），合入[JSON 模板](#json-stdio-配置)；[官方文档](https://roocodeinc.github.io/Roo-Code/features/mcp/using-mcp-in-roo/) |
| Gemini CLI | 在用户 `~/.gemini/settings.json` 或项目 `.gemini/settings.json` 合入[JSON 模板](#json-stdio-配置)；[官方文档](https://geminicli.com/docs/tools/mcp-server/) |
| OpenCode | 使用下方 [OpenCode 配置](#opencode) |
| Windsurf | 在用户 `~/.codeium/windsurf/mcp_config.json` 合入[JSON 模板](#json-stdio-配置)，保存后刷新 MCP 连接或重启 Windsurf；[手动配置依据](https://github.com/github/github-mcp-server/blob/main/docs/installation-guides/install-windsurf.md#manual-configuration) |
| Claude Desktop | 按[本地 MCP 接入文档](https://modelcontextprotocol.io/docs/develop/connect-local-servers)合入 JSON 条目 |

### JSON stdio 配置

对以 `mcpServers` 为根字段的客户端，将下列对象合入上表中的相应配置文件。只在本机受保护配置中替换 Token 占位值；若使用项目文件，不要提交真实 Token。这是直接 MCP 配置，不是插件市场导入。

```json
{
  "mcpServers": {
    "nstdata": {
      "command": "npx",
      "args": ["--yes", "@nstdata-ai/mcp-server@1.0.3"],
      "env": {
        "NSTDATA_MODULES": "crawl",
        "NSTDATA_API_TOKEN": "YOUR_CRAWL_API_TOKEN"
      }
    }
  }
}
```

Cursor 的本地服务也可通过 `envFile` 加载受保护凭据文件；使用绝对路径，并在从文件读取 Token 时移除 `env` 中的 Token 占位值。Gemini CLI 会过滤继承自宿主的敏感变量，因此保留显式的 `env.NSTDATA_API_TOKEN` 映射，不能只依赖继承。Gemini 的其他设置与 `mcpServers` 并存，勿覆盖。

### Claude Code CLI

使用[官方 stdio CLI](https://code.claude.com/docs/en/mcp)注册用户级服务。下列单引号中的值是带空串默认值的变量引用，不是真实 Key：

```sh
claude mcp add --scope user --env 'NSTDATA_API_TOKEN=${NSTDATA_API_TOKEN:-}' \
  --transport stdio nstdata -- npx --yes @nstdata-ai/mcp-server@1.0.3
```

若当前终端已从受保护环境或凭据管理器取得 `NSTDATA_API_TOKEN`，从该终端启动 Claude Code；启动服务时会展开引用。若尚未配置环境变量，注册后、连接前打开用户 `~/.claude.json`，在这个受保护文件内将 `mcpServers.nstdata.env.NSTDATA_API_TOKEN` 改为真实 Key，保留现有命令及其他条目。这样不需要把真实 Key 写入终端历史。在 Claude Code 中用 `/mcp` 检查连接和工具；注册成功不等于启动或凭据验收通过。

### VS Code 与 GitHub Copilot

使用 VS Code 格式时，执行 **MCP: Open User Configuration**，将下列完整条目合入用户配置中的 `mcp.json`。工作区也可使用 `.vscode/mcp.json`，但真实凭据不能进入共享文件。该格式的根字段是 `servers`，不是 `mcpServers`：

```json
{
  "servers": {
    "nstdata": {
      "type": "stdio",
      "command": "npx",
      "args": ["--yes", "@nstdata-ai/mcp-server@1.0.3"],
      "env": {
        "NSTDATA_MODULES": "crawl",
        "NSTDATA_API_TOKEN": "YOUR_CRAWL_API_TOKEN"
      }
    }
  }
}
```

当前 VS Code 的 Copilot harness 或 GitHub Copilot CLI 使用上方 `mcpServers` 模板，放入 `~/.copilot/mcp-config.json`；设置了 `COPILOT_HOME` 时，使用该目录下的 `mcp-config.json`。IDE 中可进入 **Chat: Open Customizations → MCP Servers → Add Server**，选择 **Global > Copilot** 写入此位置；在受保护的用户文件内替换 Token。Portable 格式不支持 VS Code 的 `inputs` 或 `envFile`；需要交互输入的服务也不会转发给 Copilot harness。复制格式前参考[配置格式及 CLI 文档](https://code.visualstudio.com/docs/agents/reference/mcp-configuration)。为目标会话只启用一个 Nstdata 条目，不要为同一会话同时配置两种入口。

### OpenCode

在 `opencode.json` 或 `opencode.jsonc` 合入下列条目。OpenCode 使用 `mcp`、完整命令数组及 `environment`，与 `mcpServers`、分开的 `command`／`args` 和 `env` 不同。只在版本控制之外的受保护配置中替换 Token，见[官方 MCP 文档](https://opencode.ai/docs/mcp-servers/)。

```json
{
  "mcp": {
    "nstdata": {
      "type": "local",
      "command": ["npx", "--yes", "@nstdata-ai/mcp-server@1.0.3"],
      "environment": {
        "NSTDATA_MODULES": "crawl",
        "NSTDATA_API_TOKEN": "YOUR_CRAWL_API_TOKEN"
      },
      "enabled": true
    }
  }
}
```

修改配置后重启 MCP 连接。仅 Crawl 提供6个工具，仅 Proxy 提供2个，同时启用提供8个；提交任务前先确认工具发现成功。

启动失败时查看客户端诊断或 stderr，核对受支持的 Node 版本、`npx` 可用性和必填环境变量。图形客户端找不到 `npx` 时，使用它的绝对可执行路径，保留包名参数。在终端改变量不一定会更新已运行的图形客户端；修改凭据来源后重启应用。

### 可选 Cursor 插件

在 Cursor 的插件设置中选择 **Add Marketplace → Import from GitHub**，填写 `https://github.com/nstdata-ai/nstdata-mcp-server.git`。导入后，从该市场安装 **Nstdata**；仅导入市场不会自动安装插件。在插件的安装作用域菜单选择 **Add for Myself**，确认已建立 **Private** 用户级安装后再配置。

在 Cursor 3.24.18 中，仅按项目安装可能显示已安装，但保存配置时返回 `Plugin not installed` 或 `not_found`。需先添加用户级安装；更换 API Key 不能解决此安装记录错误。

保存此市场配置会将填写的值提交给 Cursor 服务；**Project** 控制插件在哪个项目启用，不代表凭据只存本机。表单对敏感字段掩码。如果需要把凭据文件保留在本机，可使用[直接配置](#json-stdio-配置)和受保护的本地 `envFile`，不在市场设置中填写密钥。

打开插件配置，保持 **Tool modules** 为 `crawl`，填写 **Nstdata API token**。只使用代理时选 `proxy` 并填写 HTTP(S) **Proxy URL**，无需 Crawl Token；同时使用时选 `crawl,proxy` 并提供两种凭据。重启连接，提交任务前分别确认6、2或8个工具。

Cursor 优先使用进程继承的环境值；其中旧的或空的 `NSTDATA_API_TOKEN`、`NSTDATA_MODULES`、`NSTDATA_PROXY_URL` 可能覆盖表单。需从原来源移除冲突值后重启 Cursor。高级选项见[配置](#配置)和 [Proxy 配置](proxy_zh.md#配置)。

通过 Cursor 的市场刷新／更新入口获取插件变更，再重启 MCP 连接。插件固定 npm 版本，仅更新 npm `latest` 不会更新插件。无需使用时，在插件设置中禁用或卸载 **Nstdata**。只保留一个 Nstdata 连接处于启用状态。若 GitHub 导入失败，可在排查导入错误期间使用直接 MCP 配置。

### 可选 Codex 插件

直接使用 [README 中的 MCP 配置](../README_zh.md)即可接入。需要通过 Codex 市场管理时，可选择此方式；它启动已发布的 stdio 包。

1. 在 Codex 用户目录 `~/.codex/.env` 中添加 Key，保留原有配置。Windows 为 `%USERPROFILE%\.codex\.env`；设置了 `CODEX_HOME` 时，使用该目录下的 `.env`：

   ```dotenv
   NSTDATA_API_TOKEN=your-api-key
   ```

2. 完全退出并重新打开 Codex。进入 **Settings → Plugins → Add → Add plugin marketplace**，**Source** 填 `https://github.com/nstdata-ai/nstdata-mcp-server`，**Git ref** 和 **Sparse paths** 留空。
3. 安装 **Nstdata** 后新开本地对话，提交任务前确认6个 Crawl 工具可用。若已有直接配置的 Nstdata 服务，只启用一个连接，避免工具重复。

凭据文件为本地明文，应放在版本控制之外并限制访问，例如 macOS／Linux 上执行 `chmod 600 ~/.codex/.env`。由 Codex 加载该文件，插件仅透传声明的 Nstdata 变量；服务进程本身不读取文件。该文件中的值优先于继承的环境变量，修改后需重启 Codex。Proxy 或其他设置使用下方参考中的变量，添加到同一个文件即可。

使用支持 `codex plugin` 的 CLI 更新：

```sh
codex plugin marketplace upgrade nstdata
codex plugin add nstdata@nstdata
```

若 CLI 不识别 `plugin`，先更新 CLI；桌面应用不会更新另行安装的 CLI。更新插件后新开对话。插件固定 MCP 版本，仅修改 npm 的 `latest` 不会改变它。禁用或卸载 **Nstdata** 会停止此连接并保留凭据文件；不再需要时，单独移除其中的 Nstdata 变量。

### 可选 Claude Code 插件

需要 Claude Code 2.1.237 或以上版本。此方式使用 Claude Code 的插件配置，启动已发布的 stdio 包：

```sh
claude plugin marketplace add nstdata-ai/nstdata-mcp-server
claude plugin install nstdata@nstdata
```

在 Claude Code 交互会话运行 `/plugin configure nstdata@nstdata`，保持 **Tool modules** 为 `crawl` 并填写 **Nstdata API token**。只使用代理时设置 `proxy` 并提供 HTTP(S) **Proxy URL**，无需 Crawl Token；同时使用时设置 `crawl,proxy` 并提供两种凭据。敏感配置由客户端管理，不把真实 Key 写入安装命令参数或 shell 历史。启用模块缺少凭据时，服务不会启动。

新开会话或按提示重载，然后用 `/mcp` 确认6、2或8个工具。只保留一个 Nstdata 连接处于启用状态。更新时运行：

```sh
claude plugin marketplace update nstdata
claude plugin update nstdata@nstdata
```

无需使用时，通过 `/plugin` 禁用或卸载。插件固定 MCP 版本，仅更新 npm `latest` 不会更新插件。详见 [Claude Code 插件命令](https://code.claude.com/docs/en/plugins/cli-reference#plugin-commands-in-a-session)。

## 配置

| 变量 | 默认值 | 约束 |
|---|---|---|
| `NSTDATA_MODULES` | `crawl` | `crawl`、`proxy`，或逗号分隔的两者 |
| `NSTDATA_API_TOKEN` | 无 | 启用 Crawl 时必填 |
| `NSTDATA_API_BASE_URL` | `https://api.nstdata.io` | 可信 HTTP(S) 地址，不含凭据、查询串或 fragment |
| `NSTDATA_HTTP_TIMEOUT_MS` | `120000` | 整数1–600000；本地工具期限，包含正文读取 |
| `NSTDATA_MAX_RESPONSE_BYTES` | `8388608` | 整数256–67108864；每次 API／存储下载上限 |
| `NSTDATA_MAX_OUTPUT_CHARS` | `16000` | 整数1024–64000；每份序列化 JSON 的 UTF-16 代码单元上限 |
| `NSTDATA_MAX_CRAWL_PAGES` | `10` | 整数1–1000；`maxPages` 的默认值和本地允许上限 |

Proxy 专用变量见 [proxy_zh.md](proxy_zh.md)。未启用的模块不要求其凭据。

## 工具参考

| 工具 | 必填输入 | 操作与结果 |
|---|---|---|
| `nstdata_crawl_scrape` | `url` | 一次同步／异步单页提交；返回状态和内容或任务 ID |
| `nstdata_crawl_scrape_result` | `taskId` | 一次结果查询；保留状态及可用内容／引用 |
| `nstdata_crawl_start` | `url` | 一次有页数上限的整站提交；返回实际任务 ID |
| `nstdata_crawl_status` | `crawlId` | 一次汇总进度查询，不自动轮询 |
| `nstdata_crawl_pages` | `crawlId` | 一页结果、实际游标及逐页状态 |
| `nstdata_crawl_read_result` | `ref`、`format` | 一次有体积上限的引用下载及本地分块 |

提交工具可能创建计费任务，读取也可能消耗服务资源。`formats` 支持 `markdown`（默认）、`html`、`links`、`pdf`、`screenshot`、`rawData`，每次1–6项。单页 `mode` 默认为 `sync`，不接受整站页数／深度选项。代理工具见 [Proxy 参考](proxy_zh.md#工具)。

## 使用流程

### 单页抓取

```json
{
  "name": "nstdata_crawl_scrape",
  "arguments": {
    "url": "https://example.com/",
    "formats": [
      "markdown"
    ],
    "mode": "sync",
    "options": {
      "onlyMainContent": true
    }
  }
}
```

异步使用 `mode: "async"`，保存返回的 `id`，作为 `taskId` 传给 `nstdata_crawl_scrape_result`。每次调用仅查询一次，调用方应限制轮询次数与总等待。同步结果已完成时直接消费，不为取得内容再创建任务。

同步及查询结果保留服务提供的 `id`；查询结果还保留输入的 `taskId`。同步结果包含 ID 不代表该内容一定可再次按 ID 查询。

### 整站与分页

调用 `nstdata_crawl_start` 时显式指定 `maxPages`，保存返回的 `id`，作为 `crawlId` 传给进度和分页工具。

例如收集 Quotes 首页及第二页：

```json
{
  "name": "nstdata_crawl_start",
  "arguments": {
    "url": "https://quotes.toscrape.com/",
    "formats": [
      "markdown"
    ],
    "maxPages": 2,
    "maxDepth": 1,
    "includeUrls": [
      "/page/2/"
    ],
    "options": {
      "onlyMainContent": false
    }
  }
}
```

使用路径选择被发现的链接，起始页单独放在 `url`。过滤条件加入 `/` 可能放行其他路径。上述示例中，`onlyMainContent: true` 仅返回起始页，`false` 才收集到两页；完整页面也可能包含导航。过滤语义由服务决定，`maxPages` 只是上限，应核对返回 URL，不能只看任务完成或数量。

分页输入接受 `limit`（1–100，默认10），以及 `afterCursor`／`beforeCursor` 两者之一。原样复制 `nextCursor`／`prevCursor`；带游标的空页不代表结束。遇到重复游标或达到调用方页数／调用上限时停止。汇总完成不代表每页成功。

列表触发 `OUTPUT_LIMIT` 时，保持相同输入游标，减小 `limit` 至最小1后重新读取该页，再使用成功结果中的游标继续。不能跳过被隐藏的页面结果。

若单条页面仍超限，`error.recovery.page` 会在输出预算允许时保留该行标识、状态及可用存储引用；它是摘要，不是完整页面结果。先读取所需引用，再用 `error.recovery.continuation.nextCursor` 或 `prevCursor` 移至该行之后或之前。多行超限或没有引用能放入预算时，不返回这些继续游标。摘要不能满足需求时，应停止并说明限制，不得跳过页面或重新提交整站任务。

### 引用读取

把 `data.markdownRef` 的原值传给 **`ref`**，不是把 `markdownRef` 当作输入字段名：

```json
{
  "name": "nstdata_crawl_read_result",
  "arguments": {
    "ref": "RETURNED_MARKDOWN_REF",
    "format": "markdown",
    "offset": 0,
    "length": 2000
  }
}
```

其余对应关系为 htmlRef→html、pdfRef→pdf、screenshotRef→screenshot、rawDataRef→rawData。引用是不可解释的值，不是公开 URL；只读取获准任务返回的引用。

`length` 为1–4000，默认2000。文本按 Unicode 码点偏移并以 UTF-8 返回，损坏 UTF-8 在切片前返回 `INVALID_RESPONSE`。二进制按字节偏移并以 Base64 返回。存在 `nextOffset` 时按其继续；分别解码二进制分块后再拼接字节。每次调用都会在体积上限内重新下载完整引用，再本地切片；不提供 HTTP Range 或持久缓存。

## 选项与浏览器动作

顶层通用输入为 `url`、`formats`，单页还有 `mode`。整站专用顶层输入为 `maxPages`、`maxDepth`（0–100）、`includeUrls`、`excludeUrls`、`ignoreQuery`。`maxPages` 默认为配置的本地上限，初始为10。

服务端请求选项放在 `options` 内，转发时移除这层包装：

| 选项 | 约束 |
|---|---|
| `cookies` | 最多100项；name／value 必填；可选 domain／httpOnly／path／secure |
| `proxy.country` | 两字母国家代码，不接收原始代理凭据 |
| `headers` | 最多100项；名称最多256字符，字符串值最多8192字符 |
| `excludeTags`、`includeTags`、`removeSelectors` | 最多100个非空字符串，每项最多8192字符 |
| `targetSelector` | 一个非空字符串，最多8192字符 |
| `mobile`、`onlyMainContent` | 布尔值 |
| `timeout` | 整数1000–60000毫秒；与本地工具期限独立 |
| `jsRender.waitFor` | 整数1000–30000毫秒 |
| `jsRender.waitForSelector` | 非空选择器，最多8192字符 |
| `jsRender.actions` | 最多100项，见下表 |

`includeTags` 可能移除周围结构，仅在确实需要时设置。Cookie 名称非空，值允许空串；Cookie其他可选字符串若提供则非空，最多8192字符。

| 动作 type | 必填字段 | 可选字段 |
|---|---|---|
| click | selector | waitSelector |
| wait | milliseconds | 无 |
| waitSelector | selector | milliseconds |
| scrollX | x（整数像素） | text |
| scrollY | y（整数像素） | text |
| scrollTo | selector | 无 |
| fill | selector、text（允许空串） | 无 |
| execute | execute | 无 |
| screenshot | 无 | fullScreenshot、particularScreenshot |
| waitForRequestCompletion | urlPattern | milliseconds |

动作 `milliseconds` 为0–600000整数，与 `jsRender.waitFor` 的范围不同。URL 最多8192字符，任务／整站 ID 最多256字符，游标最多8192字符，存储引用最多4096字符。未知字段会被拒绝。这些是本地输入约束，不代表服务端全部限制或行为保证。

## 结果与错误

`content` 文本与 `structuredContent` 包含同一份 JSON。协议封装和重复表示还会增加传输体积。网页内容不可信，也可能含敏感信息。

某格式存在引用时，只返回引用并省略同格式内联内容。没有引用时，Markdown／HTML 保持字符串，内联 PDF／截图／原始数据使用字节对象：

```json
{
  "data": {
    "screenshot": {
      "encoding": "base64",
      "base64": "AP+A"
    }
  }
}
```

解码 `base64` 得到字节；原始文本先转换为 UTF-8 字节再编码。空内容保留空字符串或空 Base64，缺失内容省略。结果序列化不会自动下载引用。

`data.truncated` 保留服务返回的标记，包括 false；缺失表示未知。它与本地输出上限独立。单页触发输出上限时，若可放入预算，`error.recovery` 保留实际 ID、引用和截断标记。

任务 failed／expired 或 success=false 时设置 `isError`；列表逐页保留失败。缺失状态、耗时或内容表示未知，不能当作成功空结果。

| 错误码 | 含义与处理 |
|---|---|
| `AUTHORIZATION_FAILED` | HTTP／业务码401或403；检查凭据与权限 |
| `RATE_LIMITED` | HTTP／业务码429；停止并核对服务限制 |
| `UPSTREAM_ERROR` | 请求／响应失败；statusCode 与 apiCode 独立；3xx 表示拒绝重定向 |
| `TIMEOUT`、`CANCELLED` | 本地等待停止，已提交任务可能仍在执行 |
| `RESPONSE_LIMIT` | 响应超过下载体积上限 |
| `INVALID_RESPONSE` | 响应不合法，包括损坏 UTF-8 文本引用 |
| `OUTPUT_LIMIT` | 序列化输出超限；减小页／分块，或使用实际 recovery 标识 |
| `SENSITIVE_OUTPUT` | 配置凭据命中字段名、二进制或不透明标识，结果被隐藏 |

所有请求均不自动重试。提交时发生连接失败、服务端错误或响应无法读取／超限，可能在没有收到 ID 时已创建任务。错误会说明结果未知；先查服务任务历史，不能直接重提。异步确认必须包含可供查询工具接受的 ID；缺失或不可用时也属于未知结果。明确任务失败、无诊断 ID 的同步内容及认证／限流拒绝分别处理。

`OUTPUT_LIMIT` 不提供通用续传。仅内联内容可能没有引用，ID 也不保证可分块恢复。配置凭据会从显示文本中过滤，并在字段名、解码后二进制（含嵌套字节对象）中检查；命中字段名、标识或二进制时隐藏而不改写。短凭据也可能命中普通字段名；其他网页秘密不会自动识别。请求错误不包含原始 HTTP 正文或传输消息。

API／存储重定向一律拒绝，包括同源重定向；应配置核实后的最终地址。Proxy 错误见 [proxy_zh.md](proxy_zh.md#错误与输出)。失败读取不会创建或取消任务。
