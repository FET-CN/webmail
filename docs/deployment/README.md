# Mailecho 部署总览

本文是 IAM 邮件部署的共同部分。运行时差异见：

- [Cloudflare Workers](./cloudflare-workers.md)
- [Deno Deploy](./deno-deploy.md)
- [自托管 Deno](./self-hosted-deno.md)

## 1. 目标拓扑

推荐让一个公开站点同时承载网页和 API：

```text
浏览器
  │ https://mail.example.com
  ├── HTML（可选，由后端同源返回）
  └── /v1/*、/v1/events、/v1/imap、/v1/smtp
          │
          ▼
      Mailecho 后端
       │       │
       │       ├── Authentik OIDC（身份、MFA、组）
       │       └── Migadu Admin API（创建和删除邮箱）
       │
       ├── IMAP 993 / SMTP 465 ──► Migadu
       └── INTERNAL_MAIL_DOMAIN ──► 本地 KV 消息存储
```

同源部署时，`APP_ORIGIN`、`OIDC_REDIRECT_URI` 和浏览器地址必须互相匹配：

```text
APP_ORIGIN=https://mail.example.com
OIDC_REDIRECT_URI=https://mail.example.com/v1/session/callback
src/js/config.js: api_origin = ""
```

这样 cookie、OIDC 回调、REST 和 WebSocket 都属于同一来源。也可以使用
`api.example.com` 作为 API 子域名，但必须在构建前设置 `api_origin` 和 CSP，
且不能跨站点绕过现有 `SameSite=Lax` cookie 约束。除非有明确的代理需求，
不要选择分离站点。

## 2. Authentik 配置

以下操作在 Authentik 管理界面完成。界面名称随 Authentik 版本可能略有变化，
关键结果和 claim 必须保持不变。

### 2.1 创建组

创建两个组：

| 组 | 用途 |
| --- | --- |
| `webmail-users` | 可以登录 Webmail，并参与首次登录 mailbox provisioning |
| `webmail-admin` | 额外可以使用 `/v1/admin/*` 管理 mailbox 生命周期 |

把普通用户加入 `webmail-users`。管理员同时加入两个组。移出
`webmail-users` 后，用户不会在下一次请求立刻被踢出已有 access token；后端会在
`OIDC_REAUTH_SECONDS` 到期后强制重新验证身份，默认最长 15 分钟。

### 2.2 创建 OIDC Provider

在 Authentik 创建 OAuth2/OpenID Connect Provider，并为它创建一个 Application。
使用以下设置：

1. Client type 选择 **Confidential**。
2. Grant type 使用 Authorization Code；后端会发送 PKCE `S256`。
3. Signing key 使用 RSA，并确保签发的 ID Token 算法是 `RS256`。
4. Redirect URI 只加入精确的：
   `https://mail.example.com/v1/session/callback`。
5. 允许的 scope 至少包含 `openid`、`profile`、`email` 和 `groups`。
6. 给 Application 配置访问策略，只允许 `webmail-users`；不要只依赖前端隐藏
   登录入口。

把 Provider 的 issuer discovery 地址写入 `OIDC_ISSUER`。它必须与 discovery 文档
的 `issuer` claim 完全相同，例如：

```text
https://auth.example.com/application/o/webmail/
```

后端会访问：

```text
https://auth.example.com/application/o/webmail/.well-known/openid-configuration
```

### 2.3 配置 claim/property mapping

确保 `groups` 是 **ID Token 中的数组 claim**，而不是只在 UserInfo endpoint
返回。后端依赖以下 claim：

```json
{
  "iss": "https://auth.example.com/application/o/webmail/",
  "sub": "stable-authentik-subject",
  "aud": "the-webmail-client-id",
  "preferred_username": "alice",
  "email": "alice@example.com",
  "groups": ["webmail-users"]
}
```

`email` 可以缺省，但 `sub`、`preferred_username` 和 `groups` 必须存在。
不要把 email 当作稳定主键；后端以 `iss + sub` 找到用户，以首次成功登录时的
用户名生成 mailbox 地址。

部署后用一个测试用户完成一次登录，并在受控环境解码 ID Token，确认：

- `alg` 是 `RS256`；
- `iss` 与 `OIDC_ISSUER` 和 discovery 的 `issuer` 完全一致；
- `aud` 包含 client ID；
- `groups` 是数组且包含 `webmail-users`；
- 不要把 token 内容复制到 issue、日志或聊天中。

### 2.4 获取客户端凭据

把 client ID 放入普通配置，把 client secret 放入平台 secret store：

```text
OIDC_CLIENT_ID=from-authentik-application
OIDC_CLIENT_SECRET=from-authentik-provider-secret
OIDC_WEBMAIL_GROUP=webmail-users
OIDC_ADMIN_GROUP=webmail-admin
```

不要把 client secret 放进 `wrangler.toml`、Git、浏览器脚本或生成的
`index.html`。

## 3. Migadu 配置

1. 在 Migadu 中准备已经验证的邮件域名。`MAIL_DOMAIN` 必须是该域名。
2. 创建一个只给后端使用的 Migadu API 凭据，确认它有创建、删除 mailbox 和
   mailbox identity 的权限。
3. 把 API 用户名和 key 写入 secret store：

   ```text
   MIGADU_API_USER=from-migadu-api-settings
   MIGADU_API_KEY=from-migadu-api-settings
   ```

4. 确认运行时可以访问 `imap.migadu.com:993`、`smtp.migadu.com:465`，并按
   Migadu 当前账户配置修正 `MIGADU_IMAP_*` 和 `MIGADU_SMTP_*`。

用户不会看到或输入 Migadu 密码。首次 OIDC 回调会：

1. 以 `iss + sub` 查找或创建内部用户；
2. 按 `preferred_username` 创建一个 Migadu mailbox；
3. 创建一个 `_webmail_*` 的独立 Migadu identity；
4. 只把该 identity 的凭据加密保存在后端 KV；
5. 浏览器只获得 Mailecho session cookie。

因此不要把 Authentik 用户密码同步成 Migadu 密码，也不要在前端保存邮箱密码。

## 4. 内部邮件后缀

设置一个与公开域名不同的后缀，例如：

```text
MAIL_DOMAIN=example.com
INTERNAL_MAIL_DOMAIN=internal.example.com
```

该后缀是 Mailecho 的本地目录命名空间，不是 Migadu 域名：

- `alice@internal.example.com` 映射到本地 mailbox；
- 全部收件人都是内部地址时，MIME 只写入本地消息存储，不连接 Migadu；
- 未知的内部地址直接失败，绝不退回外部 SMTP；
- 内部和外部收件人混合时请求被拒绝，客户端必须拆成两封邮件；
- 内部后缀不需要 Migadu mailbox、MX 或外部 DNS 投递配置。

当前本地消息只覆盖列表、详情和 flags；移动、复制、删除等 mutation 在 UI 中
禁用。它是一个内部通信增量能力，不应被误解为完整的第二个 IMAP 服务。

## 5. 配置清单

### 必填或生产环境必须显式设置

| 变量 | 说明 |
| --- | --- |
| `JWT_SECRET` | Mailecho access/refresh JWT 签名密钥，随机生成，绝不提交 |
| `CREDENTIAL_ENCRYPTION_KEY` | 加密 Migadu backend identity，必须与 JWT 密钥分开 |
| `APP_ORIGIN` | 浏览器公开 origin，例如 `https://mail.example.com` |
| `PROBLEM_TYPE_BASE_URL` | RFC 9457 problem 文档公开 base URL |
| `OIDC_ISSUER` | Authentik discovery issuer，必须精确匹配 |
| `OIDC_CLIENT_ID` | Authentik OIDC client ID |
| `OIDC_CLIENT_SECRET` | Authentik OIDC client secret |
| `OIDC_REDIRECT_URI` | 精确回调地址 |
| `MAIL_DOMAIN` | Migadu 已验证的公开邮件域名 |
| `INTERNAL_MAIL_DOMAIN` | 与 `MAIL_DOMAIN` 不同的本地内部后缀 |
| `MIGADU_API_USER` | Migadu API 用户名 |
| `MIGADU_API_KEY` | Migadu API key |

生成两个独立密钥的示例：

```sh
openssl rand -base64 32  # JWT_SECRET
openssl rand -base64 32  # CREDENTIAL_ENCRYPTION_KEY
```

### 有默认值的运行参数

```text
OIDC_WEBMAIL_GROUP=webmail-users
OIDC_ADMIN_GROUP=webmail-admin
OIDC_REAUTH_SECONDS=900
MAILBOX_PROVISIONING_ENABLED=true
MIGADU_API_BASE_URL=https://api.migadu.com/v1
MIGADU_IMAP_HOST=imap.migadu.com
MIGADU_IMAP_PORT=993
MIGADU_SMTP_HOST=smtp.migadu.com
MIGADU_SMTP_PORT=465
JWT_ACCESS_TTL_SECONDS=900
JWT_REFRESH_TTL_SECONDS=2592000
SESSION_TTL_SECONDS=2592000
LIFECYCLE_RECONCILE_SECONDS=300
MAX_MESSAGE_BYTES=10485760
MAX_RECIPIENTS=25
SERVE_WEBMAIL=false
```

所有平台都可以把 `SERVE_WEBMAIL` 改为 `true`。这会让后端对普通 `GET`/`HEAD`
文档请求返回生成的单文件 HTML；`/v1/*`、`/problems/*` 和 WebSocket 升级仍由
API/protocol handler 处理。启用前先执行：

```sh
node scripts/build.mjs
node scripts/check-generated.mjs
```

生成文件是根目录 `index.html` 和 `backend/public/index.html`。同源部署启用该
开关后，不需要单独部署静态文件站点。

## 6. 首次上线流程

1. 在 Authentik 完成 Provider、Application、组和 claim mapping。
2. 在 Migadu 创建 API 凭据并确认域名、IMAP/SMTP 出口。
3. 选择一个运行时，按对应指南创建 KV、注入 secret 并部署。
4. 先以 `SERVE_WEBMAIL=false` 验证 API，再打开同源 HTML；或者在部署前直接
   生成并设置为 `true`。
5. 用一个非生产 Authentik 测试用户登录，确认首次登录只创建一个 mailbox 和
   一个 `_webmail_*` identity。
6. 验证外部邮件、纯内部邮件、未知内部地址和混合收件人四种路径。
7. 验证管理员 suspend、restore、rotate credential 和 schedule-delete；删除
   只在 30 天 retention 到期后由 lifecycle job 执行。

## 7. 验收清单

```sh
curl -i https://mail.example.com/
curl -i https://mail.example.com/v1/me
curl -i -H 'Accept: application/json' \
  https://mail.example.com/problems/auth-required
```

预期结果：

- HTML 开关开启时 `/` 返回 `200` 和 `text/html`；
- 未登录 `/v1/me` 返回 `401` 的 RFC 9457 problem；
- `/problems/auth-required` 能返回 JSON、Markdown 或 HTML 表示；
- OIDC 回调后设置 `mailecho_access` 和 `mailecho_refresh`，且 cookie 为
  `HttpOnly`、生产 HTTPS 下为 `Secure`；
- 浏览器 Network/IndexedDB 中没有 Migadu 密码；
- WebSocket 只接受 `Origin == APP_ORIGIN`，且没有 Mailecho session 时不能连接；
- lifecycle 在平台的 cron/日志中可见，且不会把内部后缀地址发送到 Migadu。

## 8. 已知限制与后续

这些是当前实现的已知边界，不能在部署文档中省略：

- `KvLocalMessageStore` 把原始 MIME 放在 KV，TTL 一年，列表时扫描 mailbox 的
  key。它适合小规模增量部署；生产后续应迁移到 R2/对象存储，并建立
  mailbox-scoped 元数据索引、保留期和删除策略。
- `Idempotency-Key` 只在请求完成后写回 `SessionRecord`。多个 Worker isolate
  同时处理同一个 key 时不是严格 exactly-once；需要 Durable Object lease 或
  跨实例 operation store 才能升级保证。
- 本地内部邮件目前没有完整的本地消息 mutation API；UI 会禁用标记以外的移动、
  复制和删除操作。
- `MemoryEventHub` 是进程内 best effort。多实例部署前，应换成共享 Durable
  Object/pub-sub，否则实时事件可能只到达同一实例的连接。
- `backend/core/app.ts` 仍然偏大，Deno 和 Worker 的 WebSocket 适配也有重复。
  这是架构后续，不要在部署时顺带重构。
- Deno Deploy 的 lifecycle 是固定每 5 分钟的 `Deno.cron`；自托管 Deno 使用
  `LIFECYCLE_RECONCILE_SECONDS` 的常驻进程间隔；Cloudflare 使用
  `wrangler.toml` 中的 `*/5 * * * *`。
- 本文只描述部署和集成验证，没有执行真实 Authentik、Migadu、Cloudflare 或
  Deno Deploy 调用，也没有替用户发布生产环境。
