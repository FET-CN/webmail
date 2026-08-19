# Mailecho Backend

This directory contains the REST API, raw IMAP/SMTP WebSocket bridge, and
runtime adapters for Cloudflare Workers and Deno.

The canonical deployment guides are in
[`docs/deployment/README.md`](../docs/deployment/README.md), with separate
guides for [Cloudflare Workers](../docs/deployment/cloudflare-workers.md),
[Deno Deploy](../docs/deployment/deno-deploy.md), and
[self-hosted Deno](../docs/deployment/self-hosted-deno.md). The sections below
remain the API and runtime reference; keep operational changes synchronized
with those guides.

## Configuration

Required values:

```text
JWT_SECRET=generate-a-long-random-secret
CREDENTIAL_ENCRYPTION_KEY=generate-a-separate-32-byte-secret
APP_ORIGIN=https://mail.example.com
PROBLEM_TYPE_BASE_URL=https://api.example.com/problems
OIDC_ISSUER=https://auth.example.com/application/o/webmail/
OIDC_CLIENT_ID=from-authentik-application
OIDC_CLIENT_SECRET=from-secret-manager
OIDC_REDIRECT_URI=https://mail.example.com/v1/session/callback
MAIL_DOMAIN=mail.example.com
INTERNAL_MAIL_DOMAIN=internal.example.com
MIGADU_API_USER=from-migadu-account
MIGADU_API_KEY=from-migadu-api-settings
```

`OIDC_ISSUER`, client credentials, and redirect URI come from the Authentik
OAuth2/OpenID provider. Add the `webmail-users` group to the application policy
and use `webmail-admin` for mailbox administration. The callback must be
registered exactly as `OIDC_REDIRECT_URI`.

## Browser and API topology

The supported production topology is same-origin: serve the generated
`index.html` at `https://mail.example.com`, and route its `/v1/*` requests to
the Worker or Deno backend. Keep `src/js/config.js` `api_origin` empty,
`APP_ORIGIN=https://mail.example.com`, and register
`https://mail.example.com/v1/session/callback` at Authentik. This keeps the
session cookies, OIDC callback, REST requests, and raw WebSocket endpoints on
one origin.

A same-site API subdomain such as `https://api.example.com` is supported when
the browser application remains at `https://mail.example.com`. Set
`api_origin` in `src/js/config.js` to the API origin before building; the
browser derives `/v1/imap`, `/v1/smtp`, and `/v1/events` from it. Update
`src/document.html` `connect-src` to allow both `https://api.example.com` and
`wss://api.example.com`, set `APP_ORIGIN` to the browser origin, and register
the API-hosted OIDC callback (for example,
`https://api.example.com/v1/session/callback`). The backend permits CORS only
from `APP_ORIGIN` and validates that same value for WebSocket `Origin`.
Cookie-authenticated POST, PATCH, and DELETE requests must also carry that exact
browser `Origin`; explicit Bearer API clients are not subject to this browser
CSRF check.

Unrelated cross-site hosts are intentionally unsupported: the session cookies
use `SameSite=Lax`, so this deployment does not weaken cookie policy merely to
make a browser call a third-party API domain.

`CREDENTIAL_ENCRYPTION_KEY` is separate from `JWT_SECRET`: it encrypts the
server-only Migadu identity credential in KV. Both values are secrets and must
be supplied by the local `.env` or deployment secret store.

Migadu endpoints default to `imap.migadu.com:993` and `smtp.migadu.com:465`, but
production values must be verified against the current Migadu account
configuration. `JWT_SECRET` and any deployment credentials belong in the
platform secret store, never in this repository.

Optional limits are `JWT_ACCESS_TTL_SECONDS` (900), `JWT_REFRESH_TTL_SECONDS`
(2592000), `SESSION_TTL_SECONDS` (2592000), `OIDC_REAUTH_SECONDS` (900),
`LIFECYCLE_RECONCILE_SECONDS` (300), `MAILBOX_PROVISIONING_ENABLED` (true),
`MAX_MESSAGE_BYTES` (10485760), and `MAX_RECIPIENTS` (25).
`INTERNAL_MAIL_DOMAIN` must be a distinct suffix from `MAIL_DOMAIN`; it is used
only for the local directory and is never sent to Migadu.

## Endpoints

- REST API: `/v1/*`
- Raw IMAP WebSocket: `/v1/imap`
- Raw SMTP WebSocket: `/v1/smtp`
- Structured events WebSocket: `/v1/events`
- Problem documents: `/problems/{slug}`

Problem documents negotiate `application/json`, `text/markdown`, and
`text/html`. The raw protocol sockets keep IMAP/SMTP command bytes and CRLF
framing instead of wrapping them in JSON.

Raw protocol sockets are session-bound. The browser sends a placeholder IMAP
`LOGIN` or SMTP `AUTH PLAIN`; the server authenticates the access cookie, checks
the current Authentik group and mailbox grant, and replaces the placeholder with
the encrypted server-only Migadu identity. An unauthenticated or suspended
session cannot open a protocol socket. REST and `/v1/events` also require the
mailecho access JWT.

`/v1/messages/send` performs recipient classification against the active mailbox
directory. Internal recipients whose domain exactly matches
`INTERNAL_MAIL_DOMAIN` are written to the local message store and never sent to
Migadu. An unknown address on that suffix fails closed. Other recipients use
Migadu SMTP. Mixed internal/external recipient lists are rejected because one
raw MIME document cannot safely hide internal headers from external recipients;
send them as separate messages. An internal sender is allowed only for an
all-internal message. The sender must be either the public mailbox address or
its internal address, and the raw `From` must match that selection. Recipient
copies omit `Bcc`, while the sender's Sent copy retains the original. A Sent
copy is stored after every successful send. The current KV local-message store
is an incremental deployment adapter; production should move raw MIME to R2 or a
persistent object store while retaining mailbox-scoped metadata.

The webmail browser never receives or stores a Migadu password. Existing browser
account-password records are deleted when the IndexedDB schema is upgraded to
version 3.

The first Authentik callback provisions one stable mailbox for the
`issuer + subject` identity. Provisioning is serialized per identity (Deno KV
lease or the Cloudflare `PROVISIONING_LOCKS` Durable Object), and failed partial
operations run compensating cleanup. A later Authentik username change does not
change the stored primary mailbox mapping.

Sessions contain only the selected mailbox and a credential reference. The
credential is encrypted server-side and is used only by the backend IMAP/SMTP
bridge. `OIDC_REAUTH_SECONDS` bounds the time an existing HTTP or WebSocket
session can continue without a fresh Authentik login; refresh cannot extend that
bound. Removing a user from the Authentik webmail group takes effect at the next
bounded reauthentication, while mailbox suspension and grant removal are checked
on every request.

Mailbox administration is Authentik-group gated. Suspend blocks access without
deleting mail. Schedule-delete marks a mailbox for a 30-day retention period;
the Deno interval and Cloudflare cron reconcile retired identities, delete the
Migadu mailbox, remove grants, and retry safely after transient failures.
Credential rotation stores and switches the replacement identity before retiring
the old one.

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

The Deno runtime uses Deno KV for encrypted, TTL-bound sessions, directory
records, credentials, local-message metadata, and the per-identity provisioning
lease. Set `DENO_KV_PATH` for a self-hosted local KV file, or use the Deno
Deploy KV binding in deployment. Deno Deploy registers a fixed `*/5 * * * *`
`Deno.cron` job; self-hosted Deno uses a resident interval controlled by
`LIFECYCLE_RECONCILE_SECONDS` (300 seconds by default).

## Cloudflare Workers

### One-click setup

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/FET-CN/webmail/tree/main/backend)

The button imports the Worker configuration from `backend/wrangler.toml` into
Cloudflare. The full `backend` directory is the deployment root because the
Worker imports the shared `core`, `contract`, and `protocol` modules. It is an
assisted setup, not a credential-free production deploy: complete the binding
and secret steps below before serving real mail traffic.

### Manual deployment

Run these commands from the repository root:

```sh
cd backend
npx wrangler login
npx wrangler kv namespace create SESSION_KV
# Replace the placeholder SESSION_KV id in wrangler.toml with the returned id.
npx wrangler secret put JWT_SECRET
npx wrangler secret put CREDENTIAL_ENCRYPTION_KEY
npx wrangler secret put OIDC_CLIENT_SECRET
npx wrangler secret put MIGADU_API_USER
npx wrangler secret put MIGADU_API_KEY
npx wrangler deploy
```

`JWT_SECRET` must be a long random value and must never be committed. Set the
production values for `APP_ORIGIN` and `PROBLEM_TYPE_BASE_URL` in Wrangler
variables. The latter is the public base URL for RFC 9457 problem type
documents, for example `https://api.example.com/problems`; do not leave the
example value in a production deployment.

The Worker also needs network access to the configured Migadu endpoints. The
default hosts are `imap.migadu.com:993` and `smtp.migadu.com:465`; verify them
against the Migadu account before deploying. The `SESSION_KV` namespace is used
for encrypted, TTL-bound session records, refresh-family revocation, directory
records, credentials, and local-message metadata. The `PROVISIONING_LOCKS`
Durable Object serializes first-login provisioning by stable Authentik identity,
and the configured cron invokes lifecycle reconciliation.

Before deploying, validate the bundle without publishing it:

```sh
npx wrangler deploy --dry-run
```

After deployment, verify the Worker URL with an unauthenticated request and
confirm that it returns an RFC 9457 `AUTH_REQUIRED` response. Then test the
login flow with a non-production Migadu mailbox before pointing the frontend at
the Worker URL. Do not commit the placeholder KV namespace ID in `wrangler.toml`
as a production configuration.
