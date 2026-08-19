# 自托管 Deno 部署

该路径适合一台有固定公网入口的主机。当前实现按单进程设计：Deno KV 使用本地
文件，事件 hub 在进程内，不能把多个主机直接放在负载均衡器后面而不增加共享
存储和实时总线。

## 前置条件

- Deno 2.x；
- Node.js，用于生成单文件前端；
- 能访问 Migadu API、IMAP 993 和 SMTP 465 的主机出口；
- Caddy、Nginx 或其他能终止 HTTPS 并转发 WebSocket 的反向代理；
- 已完成 [共同 Authentik/Migadu 配置](./README.md)。

## 1. 构建和本地 KV

在仓库根目录执行：

```sh
node scripts/build.mjs
node scripts/check-generated.mjs
deno task --config backend/deno/deno.json check
deno task --config backend/deno/deno.json test
```

为 KV 准备一个只允许服务用户读写的目录。`DENO_KV_PATH` 是自托管专用的本地
持久化文件，不要把它放在 Git 工作树：

```sh
mkdir -p var
chmod 700 var
export DENO_KV_PATH="$PWD/var/mailecho.sqlite"
```

## 2. 注入环境变量

使用部署平台的 secret store 或 root-only `.env`。至少设置：

```text
JWT_SECRET=from-secret-manager
CREDENTIAL_ENCRYPTION_KEY=from-secret-manager
APP_ORIGIN=https://mail.example.com
PROBLEM_TYPE_BASE_URL=https://mail.example.com/problems
OIDC_ISSUER=https://auth.example.com/application/o/webmail/
OIDC_CLIENT_ID=from-authentik-application
OIDC_CLIENT_SECRET=from-secret-manager
OIDC_REDIRECT_URI=https://mail.example.com/v1/session/callback
OIDC_WEBMAIL_GROUP=webmail-users
OIDC_ADMIN_GROUP=webmail-admin
MAIL_DOMAIN=example.com
INTERNAL_MAIL_DOMAIN=internal.example.com
MIGADU_API_USER=from-secret-manager
MIGADU_API_KEY=from-secret-manager
SERVE_WEBMAIL=true
PORT=8000
```

`.env` 必须加入 `.gitignore`，并限制为服务用户可读。不要把真实值放入本文档、
systemd unit、shell history 或 Caddy 配置。

## 3. 启动服务

从仓库根目录运行现有 task：

```sh
deno task --config backend/deno/deno.json start
```

该 task 已包含 `--allow-env --allow-net --allow-read`，所以能读取环境变量、连接
OIDC/Migadu、读取 `backend/public/index.html` 和打开 `DENO_KV_PATH`。自托管进程
使用 `LIFECYCLE_RECONCILE_SECONDS` 的常驻 interval，默认 300 秒；保持进程常驻，
不要用一次性命令启动后立即退出。

生产环境建议用 systemd、容器编排或等价的 supervisor 管理进程，要求：

- `WorkingDirectory` 是仓库根；
- 服务用户拥有 `var/mailecho.sqlite` 和 `backend/public/index.html` 的读取权限；
- 自动重启，但不要同时启动两个共享同一 KV 文件的实例；
- 日志中只记录 request id、状态和错误类型，不记录 token、密码或完整 MIME。

## 4. 反向代理

Caddy 示例：

```caddyfile
mail.example.com {
    reverse_proxy 127.0.0.1:8000
}
```

Caddy 会转发 HTTP、WebSocket 和 HTTPS。将 `mail.example.com` 的证书、DNS 和
防火墙配置完成后，确保 Authentik 的 Redirect URI 使用同一个公开地址。不要把
后端直接暴露在公网而跳过 TLS；`APP_ORIGIN` 在生产环境必须是 `https://`。

## 5. 同源 HTML 开关

`SERVE_WEBMAIL=true` 时，Deno 入口缓存读取 `backend/public/index.html`：

```sh
node scripts/build.mjs
export SERVE_WEBMAIL=true
deno task --config backend/deno/deno.json start
```

它只处理普通 `GET`/`HEAD` 文档请求。`/v1/*`、`/problems/*` 和 WebSocket
upgrade 仍由后端处理；如果 HTML 文件丢失，文档请求返回 `503`，而不是伪造一个
成功页面。这样可以把静态文件和 API 放在一个反向代理 origin 下。

## 6. 备份、升级和检查

停止服务或使用一致性备份方式后备份 `DENO_KV_PATH`。它包含 session、directory、
加密 Migadu identity、audit 和本地内部邮件，备份文件也必须按 secret/个人数据
处理。升级步骤：

1. 运行生成文件检查、Deno check 和 test；
2. 停止旧进程，备份 KV 文件；
3. 更新代码并重新运行 `node scripts/build.mjs`；
4. 启动单个新进程；
5. 检查根页面、`/v1/me`、problem 文档和 Authentik 登录。

验收命令：

```sh
curl -i https://mail.example.com/
curl -i https://mail.example.com/v1/me
curl -i -H 'Accept: application/json' \
  https://mail.example.com/problems/auth-required
```

## 7. 自托管限制

- 本地 Deno KV 是单主机文件，不支持多个实例同时写入；扩容前迁移到共享的
  Deno KV/数据库并实现对应 adapter。
- `MemoryEventHub` 只在当前进程内广播；多进程或多主机无法保证实时事件到达。
- lifecycle interval 依赖进程存活。若进程长期停止，恢复后会从持久 mailbox 状态
  继续执行，但不会在停机期间运行删除任务。
- KV 中原始 MIME 保留一年且按 mailbox 扫描；用户量增大前应迁移对象存储和索引。
