# 自托管 Remote MCP

[English](remote.md) · [本地客户端接入](../README_zh.md)

通过 HTTPS MCP 入口提供 Crawl 工具，并使用逐用户 OAuth 授权。用户在同意页输入自己的现有 Nstdata API Key，调用消耗该用户额度；不要为此服务配置共享的 `NSTDATA_API_TOKEN`。Proxy 工具继续使用独立的本地 stdio 配置。

## 部署条件

- Node.js 22 系列的 22.18+ 或 Node.js 24；稳定的 HTTPS origin，以及与之匹配的 PEM 证书和私钥。
- 采用持久化、`noeviction`、独立命名空间的单机 Redis，并授予 adapter 所需的键／Lua 权限。使用验证证书的 TLS（`rediss:`）或受保护的本地 Unix socket；不支持 Cluster、Sentinel。
- 在目标平台配置固定 OAuth client ID、机密和精确 callback URL。服务要求 `client_secret_basic` 和 S256 PKCE，不开放动态客户端注册。

TLS 在此 Node 进程终止。四层透传负载均衡可保留这条连接；不支持在其他位置终止 TLS 后转发 HTTP，且拒绝 `Forwarded`／`X-Forwarded-*` 权威信息头。重启时保持 issuer、resource 和 callback URL 稳定。

## 构建与配置

在仓库根目录执行：

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run build
```

配置存放在仓库外。Linux／macOS 下，配置普通文件和 TLS 私钥文件不得具有组／其他用户权限，使用 `0600` 或 `0400`。配置需为有效 UTF-8 JSON，大小不超过 1 MiB，并使用绝对文件路径；支持以符号链接挂载的 Secret 文件。

需要一次性生成彼此独立的签名、Cookie、加密和指纹密钥时，将以下程序在仓库外保存为 `create-remote-config.mjs`：

```js
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';

const filename = process.argv[2];
if (!filename || !isAbsolute(filename)) throw new Error('Use an absolute output filename.');
const secret = () => randomBytes(32).toString('base64url');
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const config = {
  issuerUrl: 'https://mcp.example.com',
  listen: {
    host: '0.0.0.0', port: 8443,
    tls: { certFile: '/absolute/path/server.crt', keyFile: '/absolute/path/server.key' }
  },
  redis: {
    url: 'rediss://USER:PASSWORD@redis.example.com:6379/0',
    namespace: 'production'
  },
  clients: [{
    clientId: 'platform-client', clientSecret: secret(), name: 'Configured platform',
    redirectUris: ['https://client.example.com/oauth/callback']
  }],
  cookieKeys: [secret()],
  jwks: { keys: [{
    ...privateKey.export({ format: 'jwk' }), kid: 'signing-1', use: 'sig', alg: 'RS256'
  }] },
  encryptionKeys: { 'encryption-1': secret() },
  currentKeyId: 'encryption-1', fingerprintKey: secret(), allowedOrigins: []
};
writeFileSync(filename, JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log('Remote configuration created.');
```

使用已存在的受保护目录，仅执行一次：

```sh
node create-remote-config.mjs /absolute/path/remote.json
```

程序拒绝覆盖现有文件，也不打印机密。编辑受保护的 JSON，填写实际 issuer、监听端口、证书路径、已编码的 Redis 凭据、client ID 和精确 callback。只将对应的 `clientSecret` 复制到平台受保护的 OAuth 配置中，不要在每次重启时重新生成密钥。

| 字段 | 配置规则 |
|---|---|
| `issuerUrl` | 不含路径的 HTTPS origin；MCP resource 为该 origin 加 `/mcp` |
| `listen` | 数字 IP 和 `1–65535` 端口；HTTPS 必须提供 `tls.certFile`、`tls.keyFile` |
| `redis` | `url` 或绝对 `socketPath` 二选一；不同环境使用独立 namespace |
| `clients` | 已注册 client ID、至少 32 字节的机密和精确 callback URL |
| `cookieKeys` | 至少 32 字节的稳定机密；当前密钥放在首位 |
| `jwks.keys` | 带唯一 `kid`、`use: "sig"` 及匹配算法的私有签名 JWK |
| `encryptionKeys`、`currentKeyId` | 带 ID 的 32 字节 base64url 加密密钥及当前密钥 ID |
| `fingerprintKey` | 独立、稳定的 32 字节 base64url 密钥；变更需新建 namespace |
| `allowedOrigins` | 可选的精确浏览器 origin，不支持通配符；非浏览器请求可不带 Origin |

仅在本机开发时，HTTP issuer 可以使用字面量 `127.0.0.1` 或 `[::1]`，监听同一个回环地址和端口且不提供 TLS 配置。明文 `redis:` URL 也仅允许字面量回环地址。不要将该配置暴露到公网。

## 校验与启动

```sh
node dist/remote.js --config /absolute/path/remote.json --check
node dist/remote.js --config /absolute/path/remote.json
```

`--check` 检查配置、TLS 文件及证书／私钥匹配，不连接 Redis、不监听端口，也不调用 Nstdata。校验成功不证明 DNS、证书信任链、Redis ACL 或平台兼容性。

启动先连接 Redis 并确认 `PING` 成功，之后才监听。完整连接过程上限 5 秒，命令上限 2 秒。Redis 故障或超时会停止服务，不自动重连或重放命令。超时写入可能已经执行；重试授权操作前需先排查实际状态。

每个进程最多接受256个并发连接。TLS握手和请求头期限为10秒，请求处理上限为130秒；开放公网访问前，按实际容量配置部署层流量限制。

| 入口 | 含义 |
|---|---|
| `GET /health/live` | 进程正在提供请求处理 |
| `GET /health/ready` | 启动已完成，Redis 客户端在本机处于 ready 状态 |
| `/mcp` | 需要认证的 Streamable HTTP MCP resource，提供六个 Crawl 工具 |

探测时使用 issuer 对应的 Host。健康检查不会每次查询 Redis，也不证明持久化、Lua 权限、上游可用性或平台授权。未认证的 `/mcp` 请求返回 OAuth challenge，不能将它作为 readiness 检查。

## 平台接入与运维

在目标平台填写部署后的 `/mcp` URL 及匹配的固定客户端凭据。使用服务公布的 OAuth discovery metadata，不猜测授权／令牌路径。请求 `crawl:use`，访问续期受已授予的授权约束。开放普通用户访问前，需在实际平台验证授权、工具发现及一次有界调用。

Redis 备份及签名、Cookie、加密、指纹机密由部署负责人保管。轮换时，保留旧签名／Cookie／加密密钥，直至依赖它们的会话、令牌或绑定过期。使用同一份 Redis 数据与密钥集合验证恢复；readiness 不替代备份／恢复测试。

在部署层配置入口和逐用户流量限制，只开放所需 Redis 与 Nstdata API 出站连接。基础设施日志需脱敏 Authorization、Cookie、OAuth code、用户 API Key 及请求正文。服务停止后，先检查故障与存储状态，再由进程管理器重启。

收到 `SIGINT` 或 `SIGTERM` 后，服务停止接收新工作、取消本地处理，并在 10 秒宽限期内关闭自己的连接。停止服务不取消已提交给 Nstdata 的 Crawl 任务。
