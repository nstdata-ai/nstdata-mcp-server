# MCP 客户端接入与 Crawl 参考

[English](mcp.md) · [快速开始](../README_zh.md)

## 客户端接入

安装后使用 [README_zh.md](../README_zh.md) 中的 stdio 配置。

- **Cursor：**项目配置为 `.cursor/mcp.json`，用户配置为 `~/.cursor/mcp.json`。本地服务条目也可使用 `envFile` 指向受保护凭据文件的绝对路径，见 [Cursor MCP 文档](https://cursor.com/docs/mcp)。
- **Claude Desktop：**按[本地 MCP 接入文档](https://modelcontextprotocol.io/docs/develop/connect-local-servers)将条目合入客户端配置。

使用 Node 和已安装 CLI 的绝对路径，保留其他服务条目。凭据不纳入版本控制。修改环境配置后重启该 MCP 服务。

仅 Crawl 提供6个工具，仅 Proxy 提供2个，同时启用提供8个。提交任务前先确认工具发现成功。启动失败时查看客户端诊断或 stderr，依次核对 Node、安装版本、绝对路径和必填环境变量。

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
{"name":"nstdata_crawl_scrape","arguments":{"url":"https://example.com/","formats":["markdown"],"mode":"sync","options":{"onlyMainContent":true}}}
```

异步使用 `mode: "async"`，保存返回的 `id`，作为 `taskId` 传给 `nstdata_crawl_scrape_result`。每次调用仅查询一次，调用方应限制轮询次数与总等待。同步结果已完成时直接消费，不为取得内容再创建任务。

同步及查询结果保留服务提供的 `id`；查询结果还保留输入的 `taskId`。同步结果包含 ID 不代表该内容一定可再次按 ID 查询。

### 整站与分页

调用 `nstdata_crawl_start` 时显式指定 `maxPages`，保存返回的 `id`，作为 `crawlId` 传给进度和分页工具。

例如收集 Quotes 首页及第二页：

```json
{"name":"nstdata_crawl_start","arguments":{"url":"https://quotes.toscrape.com/","formats":["markdown"],"maxPages":2,"maxDepth":1,"includeUrls":["/page/2/"],"options":{"onlyMainContent":false}}}
```

使用路径选择被发现的链接，起始页单独放在 `url`。过滤条件加入 `/` 可能放行其他路径。上述示例中，`onlyMainContent: true` 仅返回起始页，`false` 才收集到两页；完整页面也可能包含导航。过滤语义由服务决定，`maxPages` 只是上限，应核对返回 URL，不能只看任务完成或数量。

分页输入接受 `limit`（1–100，默认10），以及 `afterCursor`／`beforeCursor` 两者之一。原样复制 `nextCursor`／`prevCursor`；带游标的空页不代表结束。遇到重复游标或达到调用方页数／调用上限时停止。汇总完成不代表每页成功。

列表触发 `OUTPUT_LIMIT` 时，保持相同输入游标，减小 `limit` 至最小1后重新读取该页，再使用成功结果中的游标继续。不能跳过被隐藏的页面结果。

### 引用读取

把 `data.markdownRef` 的原值传给 **`ref`**，不是把 `markdownRef` 当作输入字段名：

```json
{"name":"nstdata_crawl_read_result","arguments":{"ref":"RETURNED_MARKDOWN_REF","format":"markdown","offset":0,"length":2000}}
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
{"data":{"screenshot":{"encoding":"base64","base64":"AP+A"}}}
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
