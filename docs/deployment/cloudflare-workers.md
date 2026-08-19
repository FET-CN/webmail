# Cloudflare Workers 部署

本指南假定使用 `backend/wrangler.toml`，并从仓库根目录生成前端。Wrangler
的工作根必须是 `backend`，因为 Worker 会导入同目录外的 `core`、`contract`
和 `protocol` 模块。

## 前置条件

- Cloudflare 账号和一个可绑定自定义域名的 zone；
- Node.js、npm/npx；
- Wrangler 4；
- 已完成 [共同 Authentik/Migadu 配置](./README.md)；
- 已决定生产站点，例如 `https://mail.example.com`。

## 1. 生成 Worker 资产

从仓库根目录执行：

```sh
node scripts/build.mjs
node scripts/check-generated.mjs
```

这会生成 `backend/public/index.html`。该文件由 Cloudflare Assets 上传，只有
`SERVE_WEBMAIL=true` 时才由 Worker 返回。

## 2. 创建 KV 和首次部署

```sh
cd backend
npx wrangler@4.124.0 login
npx wrangler@4.124.0 kv namespace create SESSION_KV
```

把命令输出的生产 namespace ID 写入 `backend/wrangler.toml` 的
`[[kv_namespaces]] id`。不要提交示例值
`replace-with-production-kv-id`。`PROVISIONING_LOCKS` Durable Object 和它的
`v1` migration 已在同一个配置中声明，首次 deploy 会创建它。

先做不发布的打包检查：

```sh
npx wrangler@4.124.0 deploy --dry-run
```

## 3. 设置变量和 secrets

`wrangler.toml` 中的非敏感变量必须替换示例域名：

```toml
APP_ORIGIN = "https://mail.example.com"
PROBLEM_TYPE_BASE_URL = "https://mail.example.com/problems"
OIDC_ISSUER = "https://auth.example.com/application/o/webmail/"
OIDC_CLIENT_ID = "from-authentik-application"
OIDC_REDIRECT_URI = "https://mail.example.com/v1/session/callback"
MAIL_DOMAIN = "example.com"
INTERNAL_MAIL_DOMAIN = "internal.example.com"
SERVE_WEBMAIL = "true"
```

`OIDC_CLIENT_SECRET`、Migadu API 凭据和加密密钥只能用 Wrangler secret：

```sh
npx wrangler@4.124.0 secret put JWT_SECRET
npx wrangler@4.124.0 secret put CREDENTIAL_ENCRYPTION_KEY
npx wrangler@4.124.0 secret put OIDC_CLIENT_SECRET
npx wrangler@4.124.0 secret put MIGADU_API_USER
npx wrangler@4.124.0 secret put MIGADU_API_KEY
```

每条命令会交互式读取值。生产环境不要把 secrets 写进 toml、shell history、
issue 或日志。其余可选变量可以继续写入 `[vars]`，但应把默认的
`api.example.com`、`auth.example.com` 和示例 mail domain 全部替换。

## 4. 发布和绑定域名

```sh
npx wrangler@4.124.0 deploy
```

将 Worker 绑定到 `mail.example.com`。如果使用 Cloudflare Dashboard 的 Deploy
按钮，仍然要检查部署根是 `backend`，创建 `SESSION_KV`，填写 Durable Object
migration 所需配置，并完成上述 secret 步骤。按钮是辅助初始化，不是免配置生产
部署：

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/FET-CN/webmail/tree/main/backend)

`[assets]` 已设置 `run_worker_first = true`，因此 Worker 会先处理 API、问题文档
和 WebSocket；普通文档请求在 `SERVE_WEBMAIL=true` 时才回退到
`backend/public/index.html`。

## 5. 线上检查

```sh
curl -i https://mail.example.com/
curl -i https://mail.example.com/v1/me
curl -i -H 'Accept: application/json' \
  https://mail.example.com/problems/auth-required
```

应看到 `/` 的 HTML、`/v1/me` 的 `401` 和 problem JSON。然后用测试用户完成
OIDC 登录，检查 Worker 日志和 Migadu：

- 只创建一个稳定 mailbox 和一个 `_webmail_*` identity；
- session cookie 来自 `mail.example.com`；
- IMAP/SMTP WebSocket 的 `Origin` 必须是该站点；
- `*/5 * * * *` 的 scheduled invocation 在 Cloudflare 日志中出现；
- 内部收件人不会生成 Migadu SMTP 连接。

不要把 dry-run 或 unauthenticated `401` 当作真实邮件链路已验证。必须使用测试
mailbox 验证一次收信、发外部邮件和纯内部邮件。

## 6. 运维注意事项

- `SESSION_KV` 同时保存 session、directory、加密 credential 和本地消息；不要
  把同一个 namespace 给无关 Worker。
- `PROVISIONING_LOCKS` 只负责首次 provisioning 的并发锁；它不是消息队列。
- 多 Worker isolate 的实时事件仍使用进程内 `MemoryEventHub`，横向扩容前请按
  总览文档中的后续方案替换。
- 修改 `wrangler.toml` 中的非敏感变量后重新 deploy；修改 secret 后也需要按
  Cloudflare 的部署机制确认新版本已经成为 production revision。
