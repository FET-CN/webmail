# mailecho Webmail

The deployable `index.html` is generated from the files under `src/`.
The generated document deliberately keeps each CSS and JavaScript source in
its own readable inline block, annotated with `data-source`.

Build the single-file application with:

```sh
node scripts/build.mjs
```

Check that the generated file is current and that all JavaScript source files
parse successfully with:

```sh
node scripts/check-generated.mjs
```

Do not edit the generated `index.html` directly. The classic script order in
`scripts/build.mjs` is intentional and is part of the application runtime
contract.

Run the browser IMAP client's protocol regression tests without a mail server:

```sh
node --test scripts/imap-client.test.mjs
```

These tests replay binary WebSocket frames through the actual client, including
every split point in SELECT response codes and a message FETCH. The raw Deno
and Worker bridges preserve TCP chunk boundaries, which can fall anywhere in
an IMAP response. Incomplete responses must remain buffered without rejecting
the response queue; complete responses must consume byte offsets, not decoded
character offsets. Processing failures and disconnects must reject pending
commands so the interface can leave its loading state.

The suite also exercises the real mailbox and message objects: metadata-only
FETCH responses for unknown UIDs queue a header fetch after SELECT completes,
while flag updates preserve already parsed content. Metadata alone must not
be passed to the MIME loader or saved as a complete message in the local cache.

Opening a mailbox preserves the server's SELECT error without automatically
creating a folder. Failed session setup closes the WebSocket directly; it must
not send IMAP CLOSE, which requires authentication and can expunge messages.
Regression tests cover both paths so secondary errors cannot hide the cause.

## Deployment

The IAM, Authentik, Migadu, internal-mail suffix, and runtime deployment
guides are in [docs/deployment](docs/deployment/README.md). They cover
Cloudflare Workers, the new Deno Deploy platform, and self-hosted Deno.
All three runtimes can serve `backend/public/index.html` from the API origin
when `SERVE_WEBMAIL=true`.

社区准则见 [docs/community-guidelines.md](docs/community-guidelines.md)。
