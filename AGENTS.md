## Agent skills

### Issue tracker

Issues and specs for this repo live in GitHub Issues; use `gh`. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the canonical labels `needs-triage`, `needs-info`, `ready-for-agent`,
`ready-for-human`, and `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Use the single-context layout with root `CONTEXT.md` and `docs/adr/`. See `docs/agents/domain.md`.

## Cloudflare Worker Deployment

- Wrangler's deployment root is `backend/`, using `backend/wrangler.toml`.
- Run `npx wrangler deploy` or `npx wrangler deploy --dry-run` from `backend/`; deploying from `backend/cloudflare/` breaks imports of shared `../core/*.ts` modules.
- The Worker entrypoint is `cloudflare/worker.ts`.
- `APP_ORIGIN` must exactly match the browser's frontend Origin. Production uses `https://mail.flowecho.org`; other origins are rejected for WebSockets.
- Before production deployment, replace the `SESSION_KV` placeholder with the real Cloudflare KV namespace ID.
