# Remote MCP

[English](remote.md) · [本地客户端接入](https://github.com/nstdata-ai/nstdata-mcp-server/blob/main/README_zh.md)

通过 Streamable HTTP 入口使用六个 Nstdata Crawl 工具。每位用户提供自己的 Nstdata API Key，Crawl 调用使用该用户的权限和额度。Proxy 工具使用[本地 stdio 服务](https://github.com/nstdata-ai/nstdata-mcp-server/blob/main/README_zh.md)。

## 客户端接入

使用服务维护者提供的 HTTPS MCP 地址，例如 `https://mcp.example.com/crawl`。

| 认证方式 | 适用场景 | 配置 |
|---|---|---|
| OAuth | 支持浏览器授权的客户端 | 填写 MCP 地址，客户端自动发现并完成客户端注册 |
| API Key | 支持设置请求头的客户端或程序 | 填写同一 MCP 地址，并将自己的 Nstdata API Key 配置为 `X-API-Key` 请求头 |

使用 OAuth：

1. 将地址添加为 Streamable HTTP MCP 服务；若客户端询问认证方式，选择 OAuth。
2. 打开授权链接，核对请求授权的应用，输入从 [Nstdata 控制台](https://app.nstdata.io/)获取的 API Key。
3. 点击 **Authorize Crawl**，返回客户端，确认可以发现六个 `nstdata_crawl_*` 工具。

授权页校验 API Key 并征求同意，不执行 Nstdata 账户登录。应用可在授权到期或被撤销前续期访问。新增设备不需要修改服务器配置或重启服务。各客户端的界面和组织策略可能不同，需支持所选认证方式。

### API Key 接入

在客户端受保护的配置中设置一个 `X-API-Key` 请求头。`Authorization: Bearer` 仅用于 OAuth access token，不要在其中填写业务 API Key，也不要同时发送两种凭据。不要把凭据放在 URL 或日志中。

需要在 Linux／macOS 终端检查工具发现时，在本地环境中设置 `NSTDATA_API_TOKEN`，替换示例地址后执行：

```sh
NSTDATA_MCP_URL='https://mcp.example.com/crawl'
curl --fail-with-body --silent --show-error --max-time 15 \
  --request POST "$NSTDATA_MCP_URL" \
  --header "X-API-Key: ${NSTDATA_API_TOKEN:?Set NSTDATA_API_TOKEN}" \
  --header 'Content-Type: application/json' \
  --header 'Accept: application/json, text/event-stream' \
  --data '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

响应列出六个 Crawl 工具，不创建抓取任务。不要将 Key 写入 shell 历史，并关闭命令跟踪。凭据无效时返回 `401`，凭据冲突时返回 `400`；验证接口或存储不可用时返回 `503`，不会自动切换另一种认证方式。

API Key 请求逐次校验 Key，不创建 OAuth 授权。撤销 OAuth 授权不会撤销 Nstdata API Key；撤销业务 Key 后，上游会拒绝 Crawl 调用，但不会立即使所有已签发 OAuth token 失效。重新连接时保留任务 ID，不要重提提交状态未知的任务。

## 自托管条件

Remote 是从本仓库构建的独立应用，不包含在本地 `@nstdata-ai/mcp-server` npm 包中；本地安装和客户端配置保持不变。不要为此服务设置共享的 `NSTDATA_API_TOKEN`。

- Node.js 22 系列的 22.18+ 或 Node.js 24 LTS 系列的 24.11+，以及稳定的公网 HTTPS origin。证书可由现有网关统一管理，或由应用直接加载。
- 采用持久化、`noeviction`、独立命名空间的单机 Redis，并授予 adapter 所需的键／Lua 权限。使用验证证书的 TLS（`rediss:`）或受保护的本地 Unix socket；不支持 Cluster、Sentinel。
- 公共客户端使用 authorization code 和 S256 PKCE。服务支持 Client ID Metadata Documents（CIMD）及动态客户端注册（DCR），预登记 confidential 客户端为可选方式，不需要逐设备分发 client secret。

## HTTPS 入口方式

| 方式 | 应用配置 | 证书位置 |
|---|---|---|
| 托管 Ingress | 内部 HTTP 监听，加 `tlsTermination: 'ingress'` | 现有 Kubernetes Ingress 或 HTTPS 网关 |
| 按 IP 限制的反向代理 | 内部 HTTP 监听，加 `trustedProxyCidrs` | 现有 HTTPS 网关 |
| 应用直接 TLS | `listen.tls.certFile` 和 `listen.tls.keyFile` | 应用挂载目录 |

HTTPS issuer 必须选择其中一种方式。已有 Kubernetes／ALB 部署使用托管 Ingress：通过内部 `ClusterIP` Service 提供服务，由平台控制 HTTP 后端的访问，不必逐个填写网关 IP 或给应用挂载证书。该模式显式信任平台的入口边界；Host 和协议校验不能识别真实网关，也不能代替网络隔离。不要将内部 HTTP 端口直接暴露到公网。应用还需核对直接对端时使用 IP 限制；内部要求加密时使用应用 TLS 和四层透传。

两种代理方式均要求网关保留固定 issuer 的 Host，删除客户端传入的转发信息，再写入唯一的 `X-Forwarded-Proto: https`。服务拒绝重复 Host／协议头、协议列表及 `Forwarded`、`X-Forwarded-Host`、`X-Forwarded-Port`，不会用转发头推导公开地址。

可选的 IP 限制方式使用 `trustedProxyCidrs` 匹配实际直接对端，不匹配 `X-Forwarded-For`。配置 1–32 个字面量 IP 或网络地址对齐的 IPv4／IPv6 CIDR；不接受 `/0`、主机名、带 zone 的 IPv6、重复项或与 IPv4 映射范围重叠的 IPv6 网段。NAT 后的后端对端可能不同于网关公开地址。

在实际入口核对转发头契约。由阿里云 ALB 终止公网 TLS 时，通过监听器的 `XForwardedForProtoEnabled` 提供协议头；此服务不接受可选的转发 Host／端口头。若 TLS 在更前置网关终止，应保留该网关验证后的外部协议。修改共享监听器前需评估其他服务。重启时保持 issuer、resource 和 callback URL 稳定。

## 构建与配置

在仓库根目录执行：

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run build:remote
npm --prefix remote ci --omit=dev --ignore-scripts
```

构建将共享源码编译到 `remote/dist`；`remote/package.json` 及其锁文件单独安装该应用的运行依赖。根目录的 `npm run build` 只构建本地 stdio 包。Remote 清单中的 `private: true` 用于禁止 npm 发布，其源码仍保留在本仓库。

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
  listen: { host: '0.0.0.0', port: 8080 },
  tlsTermination: 'ingress',
  redis: {
    url: 'rediss://USER:PASSWORD@redis.example.com:6379/0',
    namespace: 'production'
  },
  clients: [],
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

程序拒绝覆盖现有文件，也不打印机密。编辑受保护的 JSON，填写实际 issuer、监听端口和已编码的 Redis 凭据。`clients` 为空时无需静态客户端凭据即可自动接入。只有平台明确要求预登记 confidential 客户端时，才一次性添加匹配的 client ID、机密和精确 callback URL。示例使用托管 Ingress；仅在部署需要其他入口方式时改用 `trustedProxyCidrs` 或应用 TLS。不要在每次重启时重新生成密钥。

| 字段 | 配置规则 |
|---|---|
| `issuerUrl` | 不含路径的 HTTPS origin；MCP resource 为该 origin 加 `mcpPath` |
| `mcpPath` | 可选的 MCP 端点路径；默认为 `/mcp`，设为 `/crawl` 可提供 Crawl 专用入口 |
| `listen` | 数字 IP 和 `1–65535` 端口；代理模式监听 HTTP，直 TLS 模式还需 `tls.certFile`、`tls.keyFile` |
| `tlsTermination` | 设为 `"ingress"`，信任平台托管的 HTTPS 入口和内部 HTTP 后端；与 `trustedProxyCidrs`、`listen.tls` 互斥 |
| `trustedProxyCidrs` | 可选的直接对端 IP／CIDR 限制方式；与 `tlsTermination`、`listen.tls` 互斥 |
| `redis` | `url` 或绝对 `socketPath` 二选一；不同环境使用独立 namespace |
| `clients` | 可选的预登记 confidential 客户端；自动接入使用 `[]`。静态项包含 ID、至少 32 字节的机密和精确 callback URL |
| `cookieKeys` | 至少 32 字节的稳定机密；当前密钥放在首位 |
| `jwks.keys` | 带唯一 `kid`、`use: "sig"` 及匹配算法的私有签名 JWK |
| `encryptionKeys`、`currentKeyId` | 带 ID 的 32 字节 base64url 加密密钥及当前密钥 ID |
| `fingerprintKey` | 独立、稳定的 32 字节 base64url 密钥；变更需新建 namespace |
| `allowedOrigins` | 可选的精确浏览器 origin，不支持通配符；非浏览器请求可不带 Origin |

### OAuth 客户端策略

自动接入不需要在 `clients` 中添加客户端，可省略此字段或设为 `[]`。CIMD 客户端通过公网 HTTPS URL 提供元数据，端口为 443，地址不含查询参数或 fragment。元数据请求拒绝私网地址和重定向，并限制时间、响应大小和并发。

使用 DCR 的客户端每个 Redis namespace 最多每分钟注册 30 次、保存 10,000 个客户端。注册记录在服务重启后保留；连续 30 天 5 分钟未被查询时到期，查询会续期，到期记录自动释放容量。开放大量客户端前，应监控注册失败和存储容量。既有静态客户端继续使用 `client_secret_basic` 和 S256 PKCE，公共客户端使用 `none` 和 S256 PKCE。

要使用 `https://mcp.example.com/crawl`，在现有配置中添加下列字段；这不是完整配置文件：

```json
{
  "mcpPath": "/crawl"
}
```

`mcpPath` 必须以 `/` 开头且只包含一个路径段，总长最多 128 个字符。路径段以小写 ASCII 字母开头，仅含小写字母、数字或连字符，以字母或数字结尾。`/auth`、`/oauth`、`/token` 等认证路径，以及健康检查和发现路径均为保留路径。

`issuerUrl` 保持为 `https://mcp.example.com`。资源发现地址为 `https://mcp.example.com/.well-known/oauth-protected-resource/crawl`，授权服务器发现地址仍为 `https://mcp.example.com/.well-known/oauth-authorization-server`。网关除转发 MCP 路径外，还需转发发现文档公布的认证相关端点；健康检查路径保持不变。

修改 `mcpPath` 会改变 OAuth 资源标识。客户端需更新地址并重新连接授权，不能跨路径复用原令牌。服务只提供一个配置的 MCP 路径，不自动添加 `/mcp` 别名或重定向。应用／镜像与配置需配套更新，旧版本会拒绝 `mcpPath` 字段。修改路径时保留已有密钥和 Redis namespace。

仅在本机开发时，HTTP issuer 可以使用字面量 `127.0.0.1` 或 `[::1]`，监听同一个回环地址和端口且不提供 `tlsTermination`、TLS 或可信代理配置。明文 `redis:` URL 也仅允许字面量回环地址。不要将该配置暴露到公网。

## 校验与启动

```sh
node remote/dist/remote.js --config /absolute/path/remote.json --check
node remote/dist/remote.js --config /absolute/path/remote.json
```

`--check` 检查配置；直 TLS 模式还检查TLS文件及证书／私钥匹配，不连接 Redis、不监听端口，也不调用 Nstdata。校验成功不证明 DNS、证书信任链、Redis ACL 或平台兼容性。

启动先连接 Redis 并确认 `PING` 成功，之后才监听。运行期间每隔 30 秒串行发送一次 `PING`，保持空闲连接活跃。完整连接过程上限 5 秒；命令（含心跳）上限 2 秒。Redis 故障或超时会停止服务，不自动重连或重放命令。故障日志包含 `REDIS_CONNECTION`、`REDIS_TIMEOUT` 等固定分类，不包含连接详情或凭据。超时写入可能已经执行；重试授权操作前需先排查实际状态。

每个进程最多接受256个并发连接、32个活动业务请求和64条在途Redis业务命令，心跳使用一个独立槽位。超额工作会被拒绝，不排队、不重试；达到这些容量上限不会停止服务。TLS握手和请求头期限为10秒，请求处理上限为130秒；开放公网访问前，按实际容量配置部署层流量限制。

| 入口 | 含义 |
|---|---|
| `GET /health/live` | 进程正在提供请求处理 |
| `GET /health/ready` | 启动已完成，Redis 客户端在本机处于 ready 状态 |
| `mcpPath`（默认 `/mcp`） | 需要认证的 Streamable HTTP MCP resource，提供六个 Crawl 工具 |

健康探测使用 issuer 对应的 Host 或字面量 IP Host；IP 例外仅适用于两个精确健康路径，不授权 OAuth／MCP 请求。直接探测不带转发头；经代理探测需通过所选入口模式的协议和对端检查。健康检查不会每次查询 Redis，也不证明持久化、Lua 权限、上游可用性或平台授权。未认证的 MCP 路径请求返回 OAuth challenge，不能将它作为 readiness 检查。

## 容器运行

在仓库根目录执行：

```sh
docker build --file Dockerfile.remote --tag nstdata-mcp-remote:local .
```

镜像使用 Node.js 24.22.2，默认以非 root 的 `node` 用户（UID 1000）运行，在 `/app` 启动 `node dist/remote.js`。镜像只包含编译后的 Remote 应用及其生产依赖。

在本地 Linux／macOS 运行时，将 `remote.json` 放入下方受保护目录；代理模式不需要证书文件。仅在应用 TLS 模式下额外挂载 `server.crt` 和 `server.key`，并将配置内路径设为 `/run/secrets/server.crt` 和 `/run/secrets/server.key`。使用拥有该目录及文件的非 root 宿主用户执行以下命令；UID 覆盖让该用户可通过只读挂载读取权限为 `0400` 或 `0600` 的文件。

```sh
REMOTE_CONFIG_DIR="$HOME/.config/nstdata-mcp-remote"
docker run --rm --user "$(id -u):$(id -g)" \
  --mount type=bind,src="$REMOTE_CONFIG_DIR",dst=/run/secrets,readonly \
  nstdata-mcp-remote:local --config /run/secrets/remote.json --check
docker run --rm --user "$(id -u):$(id -g)" --publish 127.0.0.1:8080:8080 \
  --mount type=bind,src="$REMOTE_CONFIG_DIR",dst=/run/secrets,readonly \
  nstdata-mcp-remote:local --config /run/secrets/remote.json
```

此托管 Ingress 示例监听 `0.0.0.0:8080`，仅将宿主回环端口暴露给本机网关；网关需提供 HTTPS 和规定的转发头，容器内需能访问 Redis。应用 TLS 模式应按配置调整端口映射。以 UID 1000 运行的 Linux 部署需通过其 Secret 挂载、CSI driver 或 init 步骤交付该 UID 可读的文件，同时保持配置和私钥权限为 `0400` 或 `0600`。

## 发布镜像

维护者可使用 `Publish Remote image`（`.github/workflows/release-image.yml`）将 Linux AMD64 镜像发布到已有镜像仓库。该流程独立于 npm 发布，不部署服务。

1. 创建镜像仓库，为专用凭据授予该 registry 支持的最小推送权限。[Docker Hub PAT 的权限](https://docs.docker.com/security/access-tokens/reference/#repository-permissions)覆盖该账号可访问的所有仓库。确认 GitHub 托管 runner 可以访问。若下载镜像需要认证，保持镜像仓库为私有。
2. 在 GitHub 仓库 **Settings → Environments** 配置 `container-production`：要求审核人、禁止管理员绕过，并在 **Selected branches and tags** 中仅允许 `main` 分支。若操作者同时负责批准，保持 **Prevent self-review** 关闭。
3. 在 **Settings → Secrets and variables → Actions → Variables** 添加下方仓库级 Variable；将两个 Secret 添加到 `container-production` 环境：

| 类型 | 名称 | 值 |
|---|---|---|
| Repository variable | `MCP_IMAGE_REPOSITORY` | 镜像仓库域名、命名空间及仓库名，不含 URL 协议、tag 或 digest |
| Environment secret | `MCP_REGISTRY_USERNAME` | 专用镜像仓库用户名 |
| Environment secret | `MCP_REGISTRY_PASSWORD` | 专用镜像仓库密码或推送 Token |

仓库地址、源码提交、tag 和 digest 可能出现在公开构建日志及摘要中，Variable 不用于保密。若镜像地址也必须保密，使用现有私有构建设施，不运行此公开工作流。运行配置、Nstdata API Key、Redis／OAuth 凭据及集群访问凭据不放入工作流或镜像。

4. 合并已审核源码、确认检查通过后，打开 **Actions → Publish Remote image → Run workflow**，选择 `main`，填写对应的完整 40 位审核提交 SHA。输入必须与工作流提交一致，否则停止发布。
5. 检查通过后批准 `container-production` job。批准发生在该 job 启动前。它构建并加载一份 AMD64 镜像，验证文件、依赖及生命周期后，才登录并推送同一份已检查镜像，推送只执行一次。登录 action 在 job 清理阶段退出登录。
6. 将摘要中的 `repository@sha256:…` 引用用于部署配置。`sha-<commit>-amd64` tag 标识源码；除非镜像仓库启用不可变策略，否则 tag 仍可被覆盖。本流程不写入 `latest`。公开可用性及生产部署单独验收。

推送失败或被中断时，先核对镜像仓库，再决定是否重新触发。推送成功但 digest 记录失败时，镜像可能已经发布，不要为补取 digest 重复发布。工作流不在验证后重新构建，不重试发布或轮询公开可见性；无需 npm Token、Kubernetes 凭据或部署权限。

## 服务运维

网关需转发 MCP resource 及发现文档公布的发现、授权、令牌和注册端点，客户端自动发现这些端点。开放普通用户访问前，在目标客户端验证授权、工具发现及一次有界调用。健康检查或发现文档成功不代表客户端授权已通过。

Redis 备份及签名、Cookie、加密、指纹机密由部署负责人保管。轮换时，保留旧签名／Cookie／加密密钥，直至依赖它们的会话、令牌或绑定过期。使用同一份 Redis 数据与密钥集合验证恢复；readiness 不替代备份／恢复测试。

在部署层配置入口和逐用户流量限制。放行所需 Redis、Nstdata API 连接，以及读取 CIMD 客户端元数据所需的 DNS 和公网 HTTPS 出站访问。基础设施日志需脱敏 `Authorization`、`X-API-Key`、Cookie、OAuth code 及请求正文。服务停止后，先检查故障与存储状态，再由进程管理器重启。

收到 `SIGINT` 或 `SIGTERM` 后，服务停止接收新工作、取消本地处理，并在 10 秒宽限期内关闭自己的连接。停止服务不取消已提交给 Nstdata 的 Crawl 任务。
