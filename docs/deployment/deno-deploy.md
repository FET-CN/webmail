# Deno Deploy 部署

本文针对 2026 年的新版 Deno Deploy。不要使用已经在 2026-07-20 下线的
Deno Deploy Classic。

## 前置条件

- Deno Deploy 账号和 organization；
- GitHub 仓库访问权，或本地 `deno deploy` CLI；
- 已完成 [共同 Authentik/Migadu 配置](./README.md)；
- 公开 HTTPS 域名，例如 `https://mail.example.com`。

## 1. 应用配置

新版 Deno Deploy 的应用根是仓库根目录，而不是 `backend` 子目录。这样既能在
构建阶段执行 Node 构建脚本，又能把 `backend/public/index.html` 和动态入口一起
上传。

在 Create App 的 Dynamic 配置中填写：

| 项目 | 值 |
| --- | --- |
| Working directory | 仓库根目录 |
| Runtime mode | Dynamic |
| Dynamic entrypoint | `backend/deno/server.ts` |
| Build command | `node scripts/build.mjs` |
| Install command | 留空 |
| Static directory | 留空 |

如果从 GitHub 创建，选择仓库根作为 source。若使用本地 CLI，可以在仓库根执行：

```sh
node scripts/build.mjs
deno deploy create . \
  --source local \
  --org YOUR_DENO_ORG \
  --app mailecho \
  --runtime-mode dynamic \
  --entrypoint backend/deno/server.ts \
  --build-command 'node scripts/build.mjs'
```

命令中的 organization、app 名称和 token 由你的 Deno Deploy 账号决定，不要把
token 写入仓库。CI 使用 `DENO_DEPLOY_TOKEN` secret，并为非交互命令显式传入
`--non-interactive`，参见当前 CLI 帮助。

## 2. Deno KV

在 Deno Deploy Console 为该 App 分配一个 Deno KV 数据库，并确认生产 timeline
使用同一数据库。运行时代码调用 `Deno.openKv()`；部署环境不要设置本地文件形式
的 `DENO_KV_PATH`。该 KV 保存：

- 加密 session、refresh family 和 OIDC state；
- directory、mailbox grant 和 audit；
- 加密的 Migadu backend identity；
- 本地内部消息；
- 首次 provisioning lease。

Deno Deploy 的 Deno KV 是托管存储；预览和生产环境要分别确认数据库绑定，避免
测试用户写入生产 mailbox。

## 3. 环境变量

在 App Settings 的 Environment Variables 中加入总览文档的全部生产变量。把
以下值按实际域名填写：

```text
APP_ORIGIN=https://mail.example.com
PROBLEM_TYPE_BASE_URL=https://mail.example.com/problems
OIDC_ISSUER=https://auth.example.com/application/o/webmail/
OIDC_CLIENT_ID=from-authentik-application
OIDC_REDIRECT_URI=https://mail.example.com/v1/session/callback
MAIL_DOMAIN=example.com
INTERNAL_MAIL_DOMAIN=internal.example.com
SERVE_WEBMAIL=true
```

`JWT_SECRET`、`CREDENTIAL_ENCRYPTION_KEY`、`OIDC_CLIENT_SECRET`、
`MIGADU_API_USER` 和 `MIGADU_API_KEY` 必须标记为 Secret。不要把这些值放在
GitHub 变量、build log 或 `index.html` 中。Deploy 的自动变量
`DENO_DEPLOYMENT_ID` 不需要手工设置。

## 4. 生命周期和同源 HTML

入口在模块顶层检测 Deno Deploy 的 deployment 环境，并注册：

```text
Deno.cron("mailecho-mailbox-lifecycle", "*/5 * * * *", ...)
```

Deno Deploy 会在部署时发现该声明并在 dashboard 的 Cron 页面显示。它每 5 分钟
执行一次 mailbox lifecycle reconciliation；`LIFECYCLE_RECONCILE_SECONDS` 不会
改变托管 cron 的固定五分钟周期。

`SERVE_WEBMAIL=true` 时，`backend/deno/server.ts` 从部署包读取
`backend/public/index.html` 并同源返回。API、problem documents 和 WebSocket
升级不会被 HTML 回退覆盖。重新部署前始终运行：

```sh
node scripts/build.mjs
node scripts/check-generated.mjs
```

## 5. 发布和验收

部署完成后绑定自定义域名，并把该域名填回 Authentik Redirect URI。用以下请求
确认最小边界：

```sh
curl -i https://mail.example.com/
curl -i https://mail.example.com/v1/me
curl -i -H 'Accept: application/json' \
  https://mail.example.com/problems/auth-required
```

在 Deploy Logs 中确认：

- 动态入口启动成功且没有 `Deno.openKv()` 错误；
- Cron job 已注册并有成功执行；
- OIDC callback 没有 discovery、JWKS 或 redirect mismatch；
- 首次测试登录只建立一个 mailbox；
- 外部和内部邮件分别走正确的 Migadu/本地路径。

Deno Deploy 的每个 revision 是不可变的。修改环境变量、cron 声明或生成的 HTML
后要创建新 revision，并检查 production timeline 当前指向它。

## 6. 已知托管边界

新版 Deploy 的 cron 适合 mailbox lifecycle，但当前事件仍由进程内
`MemoryEventHub` 发送；多实例实时一致性仍需共享 pub/sub。KV 中保存原始 MIME
也只适合当前增量规模，正式扩大用户量前按总览文档迁移对象存储和索引。
