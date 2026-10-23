# Proxy 工具

[English](proxy.md) · [快速开始](../README_zh.md)

## 配置

仅 Proxy 无需 Crawl Token。在客户端条目中替换绝对路径及平台生成的代理连接：

```json
{
  "mcpServers": {
    "nstdata": {
      "command": "/ABSOLUTE/PATH/TO/node",
      "args": ["/ABSOLUTE/INSTALL/DIRECTORY/node_modules/@nstdata-ai/mcp-server/dist/stdio.js"],
      "env": {
        "NSTDATA_MODULES": "proxy",
        "NSTDATA_PROXY_URL": "http://PROXY_USER:PROXY_PASSWORD@PROXY_HOST:PROXY_PORT",
        "NSTDATA_PROXY_CHECK_URL": "https://api.nstdata.io/api/v2/public/utility/client-ip"
      }
    }
  }
}

```

同时启用两模块时，在同一条目设置 `NSTDATA_MODULES=crawl,proxy` 并补充 `NSTDATA_API_TOKEN`。检测地址由操作者选择；上述 Nstdata 回显接口返回该次请求被观测到的 IP。

| 变量 | 用途 |
|---|---|
| `NSTDATA_PROXY_URL` | 必填HTTP／HTTPS网关URL；需要时包含编码后的用户名密码 |
| `NSTDATA_PROXY_CHECK_URL` | `nstdata_proxy_check` 的必填HTTP／HTTPS目标 |
| `NSTDATA_PROXY_CA_FILE` | 可选PEM CA文件绝对路径，仅用于Proxy TLS |

使用完整的平台或PM Router连接，保留通道／地域／会话／任务的用户名语法。网关和目标各自可为HTTP或HTTPS；HTTPS目标使用CONNECT。不支持SOCKS代理。

CA文件必须为普通文件、最多1 MiB，并包含可解析证书。信任追加到Node默认CA，网关／目标主机名校验保持开启，不改变Crawl信任设置。

## 工具

| 工具 | 输入 | 结果 |
|---|---|---|
| `nstdata_proxy_fetch` | url；可选method（GET／HEAD）、目标headers、format（text／base64） | statusCode、正文、编码及选定响应头 |
| `nstdata_proxy_check` | 空对象 | statusCode、elapsedMs及可用时的observedIp |

检测只访问配置目标一次。有效纯IP、JSON `ip` 或成功Nstdata包装（code=200、err=false、data.ip）可产生 `observedIp`，无效或缺失时省略。不为检测另发探测或信息查询。

`elapsedMs` 包含请求至完整正文解码完成，不是TCP延迟、TTFB或带宽。回显只说明该接口观测到的出口；轮换代理对另一目标或另一次请求可能使用不同出口。

工具转发请求，不渲染浏览器、不管理PM资源，也不验证出口地域或匿名性。调用可能消耗代理流量。

## 请求行为

每次调用使用一次连接生命周期，不跟随重定向、不自动重试、不协商其他认证方式、不回退直连，也不保留连接池。本地期限覆盖DNS、TCP、CONNECT、TLS、响应头和正文。取消、EOF及SIGTERM会关闭活动连接。

代理Basic凭据仅发送给网关。目标请求头可含Authorization／Cookie，只发送到可信目标。保留的host／连接／消息分帧／代理认证头及无效名称／值会被拒绝。上限为100个头、每名称256字符、每值8192字符、每URL8192字符。

响应头（含CONNECT）最多16 KiB；下载和解压后的正文分别受 `NSTDATA_MAX_RESPONSE_BYTES` 限制。支持gzip／deflate／br解码，无效或不支持的编码失败。text要求有效UTF-8，否则返回 `INVALID_RESPONSE`；base64保留解码后的字节。体积上限不包含网络／TLS／分帧开销。

输出遵循[MCP通用上限](mcp_zh.md#配置)。超大Proxy响应没有存储引用或本地续传；应减少源响应、使用目标支持的Range请求，或配置合适的输出上限。

## 错误与输出

| 结果 | 含义 |
|---|---|
| 目标非2xx（含3xx） | isError及实际目标状态 |
| `PROXY_AUTHORIZATION_FAILED` | 网关认证失败，含407 |
| `PROXY_CONNECT_FAILED` | CONNECT建立失败 |
| `TLS_ERROR` | 网关或目标TLS失败 |
| `UNSUPPORTED_ENCODING`、`INVALID_RESPONSE` | 编码或协议错误 |
| `UNSUPPORTED_RESPONSE` | 不支持HTTP 101升级 |
| `TIMEOUT`、`CANCELLED` | 本地请求停止，无自动重试 |

错误可能没有状态／耗时，应保留未知。检测失败不能直接认定为额度、计费或地域问题。

仅返回选定响应头。配置凭据从显示文本中过滤；敏感二进制／不透明值被隐藏并返回 `SENSITIVE_OUTPUT`。不保证任意目标内容不含其他秘密。拦截TLS的网关可能观察到目标请求头；不要用生产凭据打开调试日志。

[代理产品](https://docs.nstdata.io/docs/proxy) · [PM Router](https://docs.nstdata.io/docs/proxy-manager)

传输来自 `@nstdata-ai/proxy-checker/transport`；MCP负责工具校验、凭据过滤及输出上限，不启动Checker CLI或额外托管服务。
