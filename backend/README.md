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

The Cloudflare Worker starts the raw bridge immediately after
`WebSocketPair.server.accept()`. An accepted server socket is already usable;
waiting for an `open` event would leave the 101 connection without an upstream
bridge or protocol greeting.

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

### One-click setup

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/FET-CN/webmail/tree/main/backend)

The button imports the Worker configuration from
`backend/wrangler.toml` into Cloudflare. The full `backend` directory is the
deployment root because the Worker imports the shared `core`, `contract`, and
`protocol` modules. It is an assisted setup, not a credential-free production
deploy: complete the binding and secret steps below before serving real mail
traffic.

### Manual deployment

Run these commands from the repository root:

```sh
cd backend
npx wrangler login
npx wrangler kv namespace create SESSION_KV
# Replace the placeholder SESSION_KV id in wrangler.toml with the returned id.
npx wrangler secret put JWT_SECRET
npx wrangler deploy
```

`JWT_SECRET` must be a long random value and must never be committed. Set the
production values for `APP_ORIGIN` and `PROBLEM_TYPE_BASE_URL` in Wrangler
variables. The latter is the public base URL for RFC 9457 problem type
documents, for example `https://api.example.com/problems`; do not leave the
example value in a production deployment.

The Worker also needs network access to the configured Migadu endpoints. The
default hosts are `imap.migadu.com:993` and `smtp.migadu.com:465`; verify them
against the Migadu account before deploying. The `SESSION_KV` namespace is
used for encrypted, TTL-bound session records and refresh-family revocation.

Before deploying, validate the bundle without publishing it:

```sh
npx wrangler deploy --dry-run
```

After deployment, verify the Worker URL with an unauthenticated request and
confirm that it returns an RFC 9457 `AUTH_REQUIRED` response. Then test the
login flow with a non-production Migadu mailbox before pointing the frontend
at the Worker URL. Do not commit the placeholder KV namespace ID in
`wrangler.toml` as a production configuration.
