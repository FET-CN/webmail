# Mailecho Backend

This directory contains the REST API, raw IMAP/SMTP WebSocket bridge, and
runtime adapters for Cloudflare Workers and Deno.

## Configuration

Required values:

```text
JWT_SECRET=generate-a-long-random-secret
APP_ORIGIN=https://mail.example.com
PROBLEM_TYPE_BASE_URL=https://api.example.com/problems
```

Migadu endpoints default to `imap.migadu.com:993` and
`smtp.migadu.com:465`, but production values must be verified against the
current Migadu account configuration. `JWT_SECRET` and any deployment
credentials belong in the platform secret store, never in this repository.

Optional limits are `JWT_ACCESS_TTL_SECONDS` (900),
`JWT_REFRESH_TTL_SECONDS` (2592000), `SESSION_TTL_SECONDS` (2592000),
`MAX_MESSAGE_BYTES` (10485760), and `MAX_RECIPIENTS` (25).

## Endpoints

- REST API: `/v1/*`
- Raw IMAP WebSocket: `/v1/imap`
- Raw SMTP WebSocket: `/v1/smtp`
- Structured events WebSocket: `/v1/events`
- Problem documents: `/problems/{slug}`

Problem documents negotiate `application/json`, `text/markdown`, and
`text/html`. The raw protocol sockets keep IMAP/SMTP command bytes and CRLF
framing instead of wrapping them in JSON.

Raw protocol sockets intentionally preserve the browser client's plain
protocol flow: IMAP `LOGIN` and SMTP `AUTH PLAIN` authenticate the upstream
Migadu connection. REST and `/v1/events` require the mailecho access JWT. The
server requires the configured `Origin` for browser sockets; non-browser
clients must send that explicit origin header as well.

`expand[]` is accepted on message detail reads for `mailbox`, `headers`, and
`attachments`. Event delivery is session-scoped and best-effort; deployments
with multiple instances should replace the in-memory event hub with a shared
Durable Object or pub/sub adapter before relying on cross-instance realtime.

## Deno

From the repository root:

```sh
deno task --config backend/deno/deno.json check
deno task --config backend/deno/deno.json test
deno task --config backend/deno/deno.json start
```

The Deno runtime uses Deno KV for encrypted, TTL-bound session state. Set
`DENO_KV_PATH` for a self-hosted local KV file, or use the Deno Deploy KV
binding in deployment.

## Cloudflare Workers

Deploy `backend/cloudflare/worker.ts` with Wrangler. Bind a KV namespace as
`SESSION_KV`, configure the production `APP_ORIGIN`, and store `JWT_SECRET`
as a Wrangler secret. Do not commit the placeholder KV namespace ID in
`wrangler.toml` as a production configuration.
