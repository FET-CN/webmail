import { configFromEnv } from "./config.ts";
import { AppError, problemResponse, toProblem } from "./errors.ts";
import { decodeCursor, encodeCursor, listResponse } from "./pagination.ts";
import { MemorySessionStore, SessionService } from "./session.ts";
import { signToken, verifyToken } from "./jwt.ts";
import { event, MemoryEventHub } from "./events.ts";
import { MemoryDirectoryStore } from "./directory-store.ts";
import { localMessageId, MemoryLocalMessageStore } from "./local-messages.ts";
import { decryptJson, encryptJson } from "./crypto.ts";
import { createHandler } from "./app.ts";
import type { CredentialStore } from "./credential-store.ts";
import type {
  MailboxCredential,
  MailboxRecord,
  WebmailUser,
} from "./domain.ts";
import type { MigaduAdmin, MigaduMailbox } from "./migadu.ts";
import { MemoryProvisioningCoordinator } from "./provisioning-coordinator.ts";
import type { RuntimeAdapter } from "./runtime.ts";
import { provision } from "./mailbox-access.ts";
import { validateIdTokenClaims } from "./oidc.ts";
import {
  reconcileMailboxLifecycle,
  rotateMailboxCredential,
} from "./mailbox-lifecycle.ts";
import { isEmbeddedWebmailRequest } from "./embedded-webmail.ts";
import type { ByteDuplex } from "../protocol/transport.ts";

function assert(
  condition: unknown,
  message = "Assertion failed",
): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals<T>(actual: T, expected: T): void {
  if (actual !== expected) {
    throw new Error(`Expected ${String(expected)}, got ${String(actual)}`);
  }
}

async function assertRejects(
  action: () => Promise<unknown>,
  type: new (...args: any[]) => Error,
): Promise<void> {
  try {
    await action();
  } catch (error) {
    if (error instanceof type) return;
    throw error;
  }
  throw new Error("Expected action to reject");
}

const config = configFromEnv({
  JWT_SECRET: "test-secret-that-is-long-enough",
  CREDENTIAL_ENCRYPTION_KEY: "test-credential-key-that-is-long-enough",
  APP_ORIGIN: "http://localhost:3000",
});

class MemoryCredentialStore implements CredentialStore {
  private readonly values = new Map<string, MailboxCredential>();
  get(id: string): Promise<MailboxCredential | null> {
    return Promise.resolve(this.values.get(id) || null);
  }
  put(value: MailboxCredential): Promise<void> {
    this.values.set(value.id, value);
    return Promise.resolve();
  }
  delete(id: string): Promise<void> {
    this.values.delete(id);
    return Promise.resolve();
  }
}

class FakeMigaduAdmin implements MigaduAdmin {
  mailboxCreates = 0;
  identityCreates = 0;
  readonly deletedIdentities: string[] = [];
  readonly existingAddresses = new Set<string>();
  async createMailbox(
    localPart: string,
    domain: string,
    name: string,
    _password: string,
  ): Promise<MigaduMailbox> {
    this.mailboxCreates += 1;
    this.existingAddresses.add(`${localPart}@${domain}`.toLowerCase());
    return {
      address: `${localPart}@${domain}`,
      local_part: localPart,
      domain_name: domain,
      name,
    };
  }
  async createBackendIdentity(
    localPart: string,
    domain: string,
    _mailboxLocalPart: string,
    _name: string,
  ): Promise<{ address: string; password: string }> {
    this.identityCreates += 1;
    return {
      address: `${localPart}@${domain}`,
      password: `secret-${this.identityCreates}`,
    };
  }
  async deleteMailbox(): Promise<void> {}
  async deleteBackendIdentity(localPart: string): Promise<void> {
    this.deletedIdentities.push(localPart);
  }
  async getMailbox(
    localPart: string,
    domain: string,
  ): Promise<MigaduMailbox | null> {
    const address = `${localPart}@${domain}`.toLowerCase();
    if (!this.existingAddresses.has(address)) return null;
    return {
      address: `${localPart}@${domain}`,
      local_part: localPart,
      domain_name: domain,
    };
  }
}

function testConfig() {
  return configFromEnv({
    JWT_SECRET: "test-secret-that-is-long-enough",
    CREDENTIAL_ENCRYPTION_KEY: "test-credential-key-that-is-long-enough",
    APP_ORIGIN: "http://localhost:3000",
    MAIL_DOMAIN: "example.com",
    INTERNAL_MAIL_DOMAIN: "internal.example.com",
  });
}

function testRuntime(
  runtimeConfig = testConfig(),
  migadu: MigaduAdmin = new FakeMigaduAdmin(),
): RuntimeAdapter {
  return {
    config: runtimeConfig,
    sessions: new MemorySessionStore(),
    directory: new MemoryDirectoryStore(),
    credentials: new MemoryCredentialStore(),
    oidcStorage: {
      async get() {
        return null;
      },
      async put() {},
      async delete() {},
    },
    migaduAdmin: migadu,
    localMessages: new MemoryLocalMessageStore(),
    provisioning: new MemoryProvisioningCoordinator(),
    connectImap: async () => {
      throw new Error("IMAP not expected in this test");
    },
    connectSmtp: async () => {
      throw new Error("SMTP not expected in this test");
    },
  };
}

async function seedMailbox(
  runtime: RuntimeAdapter,
  user: WebmailUser,
  mailbox: MailboxRecord,
  credential: MailboxCredential,
): Promise<{ accessToken: string }> {
  await runtime.directory.putUser(user);
  await runtime.directory.putMailbox(mailbox);
  await runtime.directory.putGrant({
    userId: user.id,
    mailboxId: mailbox.id,
    role: "owner",
    createdAt: mailbox.createdAt,
    createdBy: user.id,
  });
  await runtime.credentials.put(credential);
  const session = await new SessionService(runtime.sessions, runtime.config)
    .create({
      userId: user.id,
      issuer: user.issuer,
      subject: user.subject,
      mailboxId: mailbox.id,
      credentialId: credential.id,
    });
  return { accessToken: session.accessToken };
}

function fixtureUser(groups = ["webmail-users"]): WebmailUser {
  const now = new Date().toISOString();
  return {
    id: "user-a",
    issuer: "https://auth.example",
    subject: "subject-a",
    preferredUsername: "alice",
    email: "alice@example.com",
    groups,
    enabled: true,
    createdAt: now,
    updatedAt: now,
  };
}

function fixtureMailbox(): MailboxRecord {
  const now = new Date().toISOString();
  return {
    id: "mailbox-a",
    address: "alice@example.com",
    internalAddress: "alice@internal.example.com",
    localPart: "alice",
    domain: "example.com",
    state: "active",
    ownerUserId: "user-a",
    localDeliveryEnabled: true,
    migaduLocalPart: "alice",
    credentialId: "credential-a",
    createdAt: now,
    updatedAt: now,
  };
}

function fixtureCredential(): MailboxCredential {
  return {
    id: "credential-a",
    mailboxId: "mailbox-a",
    username: "_webmail_backend@example.com",
    password: "server-secret",
    keyVersion: 1,
    createdAt: new Date().toISOString(),
  };
}

async function requestWithSession(
  runtime: RuntimeAdapter,
  path: string,
  accessToken: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${accessToken}`);
  return createHandler(runtime)(
    new Request(`http://localhost${path}`, {
      ...init,
      headers,
    }),
  );
}

Deno.test("access and refresh tokens rotate and reject reuse", async () => {
  const service = new SessionService(new MemorySessionStore(), config);
  const first = await service.create({
    userId: "user",
    issuer: "https://auth.example",
    subject: "user",
    mailboxId: "mailbox",
    credentialId: "credential",
  });
  const second = await service.refresh(first.refreshToken);
  assert(second.accessToken !== first.accessToken);
  await assertRejects(() => service.refresh(first.refreshToken), AppError);
});

Deno.test("concurrent refresh attempts consume a token once", async () => {
  const service = new SessionService(new MemorySessionStore(), config);
  const first = await service.create({
    userId: "race",
    issuer: "https://auth.example",
    subject: "race",
    mailboxId: "mailbox",
    credentialId: "credential",
  });
  const results = await Promise.allSettled([
    service.refresh(first.refreshToken),
    service.refresh(first.refreshToken),
  ]);
  assertEquals(
    results.filter((result) => result.status === "fulfilled").length,
    1,
  );
  assertEquals(
    results.filter((result) => result.status === "rejected").length,
    1,
  );
});

Deno.test("JWT rejects a token with the wrong type", async () => {
  const token = await signToken(
    "user",
    "session",
    "access",
    60,
    config.jwtSecret,
  );
  await assertRejects(
    () => verifyToken(token, "refresh", config.jwtSecret),
    AppError,
  );
});

Deno.test("OIDC ID tokens require a future integer expiration and authorized party", () => {
  const oidcConfig = {
    ...config,
    oidcIssuer: "https://auth.example",
    oidcClientId: "webmail-client",
  };
  const validClaims = {
    iss: oidcConfig.oidcIssuer,
    aud: oidcConfig.oidcClientId,
    exp: Math.floor(Date.now() / 1000) + 60,
  };
  validateIdTokenClaims(validClaims, oidcConfig.oidcIssuer, oidcConfig);

  for (const claims of [
    { ...validClaims, exp: undefined },
    {
      ...validClaims,
      aud: [oidcConfig.oidcClientId, "another-client"],
    },
  ]) {
    try {
      validateIdTokenClaims(claims, oidcConfig.oidcIssuer, oidcConfig);
      throw new Error("Expected invalid OIDC claims");
    } catch (error) {
      assert(error instanceof AppError);
    }
  }

  validateIdTokenClaims(
    {
      ...validClaims,
      aud: [oidcConfig.oidcClientId, "another-client"],
      azp: oidcConfig.oidcClientId,
    },
    oidcConfig.oidcIssuer,
    oidcConfig,
  );
});

Deno.test("cursor pagination round-trips and binds to a mailbox", async () => {
  const cursor = encodeCursor({
    version: 1,
    mailbox: "INBOX",
    date: "2026-08-19T00:00:00Z",
    uid: 42,
    page: 2,
  });
  assertEquals(decodeCursor(cursor, "INBOX").uid, 42);
  await assertRejects(
    () => Promise.resolve(decodeCursor(cursor, "Archive")),
    AppError,
  );
  assert(listResponse([{ id: 1 }], 2, 25, cursor).has_more);
});

Deno.test("problem details include RFC 9457 fields and extensions", () => {
  const problem = toProblem(
    new AppError("RATE_LIMITED", "Try later."),
    "/v1/messages/send",
    "req_test",
    "https://api.example/problems",
  );
  assertEquals(problem.type, "https://api.example/problems/rate-limited");
  assertEquals(problem.object, "error");
  assertEquals(problem.retryable, true);
});

Deno.test("problem details negotiate HTML and Markdown without leaking stack traces", async () => {
  const request = new Request("https://mail.example/v1/messages/send", {
    headers: { accept: "text/html" },
  });
  const html = await problemResponse(
    new AppError("INVALID_PARAMS", "Fix the request."),
    request,
    config.problemTypeBaseUrl,
  ).text();
  assert(html.includes("mailecho"));
  assert(!html.includes("Error: "));
  const markdownRequest = new Request(request, {
    headers: { accept: "text/markdown" },
  });
  const markdown = await problemResponse(
    new AppError("INVALID_PARAMS", "Fix the request."),
    markdownRequest,
    config.problemTypeBaseUrl,
  ).text();
  assert(markdown.startsWith("# Invalid parameters"));
});

Deno.test("embedded webmail never captures API, problem, or upgrade requests", () => {
  assert(isEmbeddedWebmailRequest(new Request("https://mail.example/")));
  assert(isEmbeddedWebmailRequest(new Request("https://mail.example/inbox")));
  assert(
    !isEmbeddedWebmailRequest(
      new Request("https://mail.example/v1/session/start"),
    ),
  );
  assert(
    !isEmbeddedWebmailRequest(
      new Request("https://mail.example/problems/auth-required"),
    ),
  );
  assert(
    !isEmbeddedWebmailRequest(
      new Request("https://mail.example/", {
        headers: { upgrade: "websocket" },
      }),
    ),
  );
  assert(
    !isEmbeddedWebmailRequest(
      new Request("https://mail.example/", { method: "POST" }),
    ),
  );
});

Deno.test("event hub publishes and unsubscribes listeners", () => {
  const hub = new MemoryEventHub();
  const events: string[] = [];
  const unsubscribe = hub.subscribe((value) => events.push(value.type));
  hub.publish(event("message.updated", { mailbox: "INBOX" }));
  unsubscribe();
  hub.publish(event("message.deleted", { mailbox: "INBOX" }));
  assertEquals(events.join(","), "message.updated");
});

Deno.test("directory grants and local messages remain mailbox scoped", async () => {
  const directory = new MemoryDirectoryStore();
  const mailbox = {
    id: "mailbox-a",
    address: "alice@example.com",
    localPart: "alice",
    domain: "example.com",
    state: "active" as const,
    ownerUserId: "user-a",
    localDeliveryEnabled: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await directory.putMailbox(mailbox);
  await directory.putGrant({
    userId: "user-a",
    mailboxId: mailbox.id,
    role: "owner",
    createdAt: mailbox.createdAt,
    createdBy: "user-a",
  });
  assert((await directory.getGrant("user-a", mailbox.id))?.role === "owner");
  const messages = new MemoryLocalMessageStore();
  await messages.put({
    id: localMessageId(),
    mailboxId: mailbox.id,
    folder: "INBOX",
    raw: "cmF3",
    flags: [],
    createdAt: mailbox.createdAt,
    from: "bob@example.com",
    recipients: [mailbox.address],
  });
  assertEquals((await messages.list(mailbox.id, "INBOX")).length, 1);
  assertEquals((await messages.list("other-mailbox")).length, 0);
});

Deno.test("mailbox credentials are encrypted at rest", async () => {
  const key = "credential-encryption-key-for-tests";
  const encrypted = await encryptJson({
    username: "backend",
    password: "secret",
  }, key);
  assert(!encrypted.includes("secret"));
  assertEquals(
    (await decryptJson<{ password: string }>(encrypted, key)).password,
    "secret",
  );
});

Deno.test("admin routes reject a non-admin identity", async () => {
  const runtime = testRuntime();
  const user = fixtureUser();
  const mailbox = fixtureMailbox();
  const { accessToken } = await seedMailbox(
    runtime,
    user,
    mailbox,
    fixtureCredential(),
  );
  const response = await requestWithSession(
    runtime,
    "/v1/admin/mailboxes",
    accessToken,
  );
  assertEquals(response.status, 403);
  assertEquals((await response.json()).code, "FORBIDDEN");
});

Deno.test("cookie-authenticated mutations require the application origin", async () => {
  const runtime = testRuntime();
  const user = fixtureUser();
  const mailbox = fixtureMailbox();
  const { accessToken } = await seedMailbox(
    runtime,
    user,
    mailbox,
    fixtureCredential(),
  );
  const request = (origin?: string) => {
    const headers = new Headers({
      "content-type": "application/json",
      cookie: `mailecho_access=${encodeURIComponent(accessToken)}`,
    });
    if (origin) headers.set("origin", origin);
    return createHandler(runtime)(
      new Request("http://localhost/v1/session/select", {
        method: "POST",
        headers,
        body: JSON.stringify({ mailbox_id: mailbox.id }),
      }),
    );
  };
  assertEquals((await request()).status, 403);
  assertEquals((await request(runtime.config.appOrigin)).status, 200);
});

Deno.test("configuration rejects an internal domain equal to the public domain", () => {
  try {
    configFromEnv({
      JWT_SECRET: "test-secret-that-is-long-enough",
      CREDENTIAL_ENCRYPTION_KEY: "test-credential-key-that-is-long-enough",
      APP_ORIGIN: "http://localhost:3000",
      MAIL_DOMAIN: "example.com",
      INTERNAL_MAIL_DOMAIN: "EXAMPLE.COM",
    });
    throw new Error("Expected invalid internal domain configuration");
  } catch (error) {
    assert(String(error).includes("INTERNAL_MAIL_DOMAIN"));
  }
});

Deno.test("internal delivery is local and unknown internal recipients fail closed", async () => {
  const runtime = testRuntime();
  const sender = fixtureUser();
  const senderMailbox = fixtureMailbox();
  const recipient = {
    ...fixtureMailbox(),
    id: "mailbox-b",
    address: "bob@example.com",
    internalAddress: "bob@internal.example.com",
    ownerUserId: "user-b",
    credentialId: "credential-b",
  };
  await seedMailbox(runtime, sender, senderMailbox, fixtureCredential());
  await runtime.directory.putMailbox(recipient);
  const raw = btoa(
    "From: alice@example.com\r\nTo: bob@internal.example.com\r\n\r\nHello",
  );
  const session = await new SessionService(runtime.sessions, runtime.config)
    .create({
      userId: sender.id,
      issuer: sender.issuer,
      subject: sender.subject,
      mailboxId: senderMailbox.id,
      credentialId: "credential-a",
    });
  const response = await requestWithSession(
    runtime,
    "/v1/messages/send",
    session.accessToken,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        from: senderMailbox.address,
        recipients: [recipient.internalAddress],
        raw,
      }),
    },
  );
  assertEquals(response.status, 202);
  assertEquals((await response.json()).routes.local, 1);
  assertEquals(
    (await runtime.localMessages.list(recipient.id, "INBOX")).length,
    1,
  );
  assertEquals(
    (await runtime.localMessages.list(senderMailbox.id, "Sent")).length,
    1,
  );

  const missing = await requestWithSession(
    runtime,
    "/v1/messages/send",
    session.accessToken,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        from: senderMailbox.address,
        recipients: ["missing@internal.example.com"],
        raw,
      }),
    },
  );
  assertEquals(missing.status, 404);
  assertEquals((await missing.json()).code, "MAILBOX_NOT_FOUND");
});

Deno.test("mixed internal and external delivery fails before either route", async () => {
  const runtime = testRuntime();
  const sender = fixtureUser();
  const senderMailbox = fixtureMailbox();
  const recipient = {
    ...fixtureMailbox(),
    id: "mailbox-b",
    address: "bob@example.com",
    internalAddress: "bob@internal.example.com",
    ownerUserId: "user-b",
    credentialId: "credential-b",
  };
  await seedMailbox(runtime, sender, senderMailbox, fixtureCredential());
  await runtime.directory.putMailbox(recipient);
  const session = await new SessionService(runtime.sessions, runtime.config)
    .create({
      userId: sender.id,
      issuer: sender.issuer,
      subject: sender.subject,
      mailboxId: senderMailbox.id,
      credentialId: "credential-a",
    });
  const response = await requestWithSession(
    runtime,
    "/v1/messages/send",
    session.accessToken,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        from: senderMailbox.address,
        recipients: [recipient.internalAddress, "outside@example.net"],
        raw: btoa(
          "From: alice@example.com\r\nTo: bob@internal.example.com\r\n\r\nHello",
        ),
      }),
    },
  );
  assertEquals(response.status, 400);
  assertEquals((await response.json()).code, "INVALID_PARAMS");
  assertEquals(
    (await runtime.localMessages.list(recipient.id, "INBOX")).length,
    0,
  );
  assertEquals(
    (await runtime.localMessages.list(senderMailbox.id, "Sent")).length,
    0,
  );
});

Deno.test("external delivery rejects internal addresses in raw MIME headers", async () => {
  const runtime = testRuntime();
  const sender = fixtureUser();
  const senderMailbox = fixtureMailbox();
  await seedMailbox(runtime, sender, senderMailbox, fixtureCredential());
  const session = await new SessionService(runtime.sessions, runtime.config)
    .create({
      userId: sender.id,
      issuer: sender.issuer,
      subject: sender.subject,
      mailboxId: senderMailbox.id,
      credentialId: "credential-a",
    });
  const response = await requestWithSession(
    runtime,
    "/v1/messages/send",
    session.accessToken,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        from: senderMailbox.address,
        recipients: ["outside@example.net"],
        raw: btoa(
          "From: Alice <alice@example.com>\r\n" +
            "To: bob@internal.example.com\r\n\r\nHello",
        ),
      }),
    },
  );
  assertEquals(response.status, 400);
  assertEquals((await response.json()).code, "INVALID_PARAMS");
});

Deno.test("delivery copies remove Bcc while Sent keeps the sender's original", async () => {
  const runtime = testRuntime();
  const sender = fixtureUser();
  const senderMailbox = fixtureMailbox();
  const recipient = {
    ...fixtureMailbox(),
    id: "mailbox-b",
    address: "bob@example.com",
    internalAddress: "bob@internal.example.com",
    ownerUserId: "user-b",
    credentialId: "credential-b",
  };
  await seedMailbox(runtime, sender, senderMailbox, fixtureCredential());
  await runtime.directory.putMailbox(recipient);
  const session = await new SessionService(runtime.sessions, runtime.config)
    .create({
      userId: sender.id,
      issuer: sender.issuer,
      subject: sender.subject,
      mailboxId: senderMailbox.id,
      credentialId: "credential-a",
    });
  const response = await requestWithSession(
    runtime,
    "/v1/messages/send",
    session.accessToken,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        from: senderMailbox.address,
        recipients: [recipient.internalAddress],
        raw: btoa(
          "From: Alice <alice@example.com>\r\n" +
            "To: bob@internal.example.com\r\n" +
            "Bcc: hidden@internal.example.com\r\n\r\nHello",
        ),
      }),
    },
  );
  assertEquals(response.status, 202);
  const delivered = await runtime.localMessages.list(recipient.id, "INBOX");
  const sent = await runtime.localMessages.list(senderMailbox.id, "Sent");
  assertEquals(atob(delivered[0].raw).includes("Bcc:"), false);
  assertEquals(atob(sent[0].raw).includes("Bcc:"), true);
});

Deno.test("raw From must match the selected mailbox sender", async () => {
  const runtime = testRuntime();
  const sender = fixtureUser();
  const senderMailbox = fixtureMailbox();
  await seedMailbox(runtime, sender, senderMailbox, fixtureCredential());
  const session = await new SessionService(runtime.sessions, runtime.config)
    .create({
      userId: sender.id,
      issuer: sender.issuer,
      subject: sender.subject,
      mailboxId: senderMailbox.id,
      credentialId: "credential-a",
    });
  const response = await requestWithSession(
    runtime,
    "/v1/messages/send",
    session.accessToken,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        from: senderMailbox.address,
        recipients: [senderMailbox.internalAddress],
        raw: btoa(
          "From: someone@example.net\r\n" +
            "To: alice@internal.example.com\r\n\r\nHello",
        ),
      }),
    },
  );
  assertEquals(response.status, 400);
  assertEquals((await response.json()).code, "INVALID_PARAMS");
});

Deno.test("internal sender cannot use Migadu for external delivery", async () => {
  const runtime = testRuntime();
  const sender = fixtureUser();
  const senderMailbox = fixtureMailbox();
  await seedMailbox(runtime, sender, senderMailbox, fixtureCredential());
  const session = await new SessionService(runtime.sessions, runtime.config)
    .create({
      userId: sender.id,
      issuer: sender.issuer,
      subject: sender.subject,
      mailboxId: senderMailbox.id,
      credentialId: "credential-a",
    });
  const response = await requestWithSession(
    runtime,
    "/v1/messages/send",
    session.accessToken,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        from: senderMailbox.internalAddress,
        recipients: ["outside@example.net"],
        raw: btoa(
          "From: alice@internal.example.com\r\nTo: outside@example.net\r\n\r\nHello",
        ),
      }),
    },
  );
  assertEquals(response.status, 403);
  assertEquals((await response.json()).code, "FORBIDDEN");
});

Deno.test("admin patch cannot create an unscheduled pending deletion", async () => {
  const runtime = testRuntime();
  const user = fixtureUser(["webmail-users", "webmail-admin"]);
  const mailbox = fixtureMailbox();
  const { accessToken } = await seedMailbox(
    runtime,
    user,
    mailbox,
    fixtureCredential(),
  );
  const response = await requestWithSession(
    runtime,
    `/v1/admin/mailboxes/${mailbox.id}`,
    accessToken,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ state: "pending_delete" }),
    },
  );
  assertEquals(response.status, 400);
  assertEquals((await response.json()).code, "INVALID_PARAMS");
  assertEquals(
    (await runtime.directory.getMailbox(mailbox.id))?.state,
    "active",
  );
});

Deno.test("mailbox lifecycle actions preserve the deletion state machine", async () => {
  const runtime = testRuntime();
  const user = fixtureUser(["webmail-users", "webmail-admin"]);
  const mailbox = fixtureMailbox();
  const { accessToken } = await seedMailbox(
    runtime,
    user,
    mailbox,
    fixtureCredential(),
  );
  const schedule = await requestWithSession(
    runtime,
    `/v1/admin/mailboxes/${mailbox.id}/schedule-delete`,
    accessToken,
    { method: "POST" },
  );
  assertEquals(schedule.status, 200);
  const pending = await runtime.directory.getMailbox(mailbox.id);
  assertEquals(pending?.state, "pending_delete");
  assert(Boolean(pending?.deleteAfter));

  const blocked = await requestWithSession(
    runtime,
    `/v1/admin/mailboxes/${mailbox.id}/suspend`,
    accessToken,
    { method: "POST" },
  );
  assertEquals(blocked.status, 400);
  assertEquals((await blocked.json()).code, "INVALID_PARAMS");

  const canceled = await requestWithSession(
    runtime,
    `/v1/admin/mailboxes/${mailbox.id}/cancel-delete`,
    accessToken,
    { method: "POST" },
  );
  assertEquals(canceled.status, 200);
  const restored = await runtime.directory.getMailbox(mailbox.id);
  assertEquals(restored?.state, "active");
  assertEquals(restored?.deleteAfter, undefined);

  restored!.state = "pending_delete";
  restored!.deleteAfter = new Date(Date.now() + 60_000).toISOString();
  restored!.deletionIdentityRemoved = true;
  await runtime.directory.putMailbox(restored!);
  const tooLate = await requestWithSession(
    runtime,
    `/v1/admin/mailboxes/${mailbox.id}/cancel-delete`,
    accessToken,
    { method: "POST" },
  );
  assertEquals(tooLate.status, 400);
  assertEquals((await tooLate.json()).code, "INVALID_PARAMS");

  restored!.state = "deleted";
  await runtime.directory.putMailbox(restored!);
  const terminal = await requestWithSession(
    runtime,
    `/v1/admin/mailboxes/${mailbox.id}/restore`,
    accessToken,
    { method: "POST" },
  );
  assertEquals(terminal.status, 400);
  assertEquals((await terminal.json()).code, "INVALID_PARAMS");
});

Deno.test("sender selection accepts the mailbox internal address only", async () => {
  const runtime = testRuntime();
  const user = fixtureUser();
  const mailbox = fixtureMailbox();
  const { accessToken } = await seedMailbox(
    runtime,
    user,
    mailbox,
    fixtureCredential(),
  );
  const raw = btoa(
    "From: alice@internal.example.com\r\nTo: bob@internal.example.com\r\n\r\nHello",
  );
  const response = await requestWithSession(
    runtime,
    "/v1/messages/send",
    accessToken,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        from: "other@internal.example.com",
        recipients: [mailbox.internalAddress],
        raw,
      }),
    },
  );
  assertEquals(response.status, 403);
  assertEquals((await response.json()).code, "FORBIDDEN");
});

Deno.test("JIT provisioning keeps a stable mailbox under concurrent login", async () => {
  const runtime = testRuntime();
  const migadu = new FakeMigaduAdmin();
  runtime.migaduAdmin = migadu;
  const identity = {
    issuer: "https://auth.example",
    subject: "subject-jit",
    preferredUsername: "jit-user",
    email: "jit-user@example.com",
    groups: ["webmail-users"],
  };
  const results = await Promise.all([
    provision(identity, runtime),
    provision(identity, runtime),
  ]);
  const first = results[0];
  const second = results[1];
  assert(!("needsMailboxSelection" in first), "Expected a provisioned mailbox");
  assert(!("needsMailboxSelection" in second), "Expected a provisioned mailbox");
  assertEquals(first.mailbox.id, second.mailbox.id);
  assertEquals(migadu.mailboxCreates, 1);
  assertEquals(migadu.identityCreates, 1);
});

Deno.test("JIT provisioning guides a second identity whose name is already bound", async () => {
  const migadu = new FakeMigaduAdmin();
  const runtime = testRuntime(testConfig(), migadu);
  const identity = {
    issuer: "https://auth.example",
    preferredUsername: "shared-name",
    email: "shared@example.com",
    groups: ["webmail-users"],
  };
  const results = await Promise.all([
    provision({ ...identity, subject: "subject-one" }, runtime),
    provision({ ...identity, subject: "subject-two" }, runtime),
  ]);
  const [first, second] = results;
  assert(
    !("needsMailboxSelection" in first),
    "Expected the first identity to receive a mailbox",
  );
  assert(
    "needsMailboxSelection" in second,
    "Expected the second identity to be guided",
  );
  assertEquals(migadu.mailboxCreates, 1);
  assert(second.suggestedAddress.startsWith("shared-name-"));
});

Deno.test("credential rotation switches the stored identity before retiring the old one", async () => {
  const runtime = testRuntime();
  const migadu = runtime.migaduAdmin as FakeMigaduAdmin;
  const mailbox = fixtureMailbox();
  await runtime.directory.putMailbox(mailbox);
  await runtime.credentials.put(fixtureCredential());
  await rotateMailboxCredential(runtime, mailbox);
  const updated = await runtime.directory.getMailbox(mailbox.id);
  assert(updated?.credentialId !== "credential-a");
  assertEquals(
    (await runtime.credentials.get(updated!.credentialId!))?.password,
    "secret-1",
  );
  assertEquals(migadu.deletedIdentities.length, 1);
  assertEquals(await runtime.credentials.get("credential-a"), null);
});

Deno.test("scheduled mailbox deletion is retry-safe and removes local access", async () => {
  const runtime = testRuntime();
  const migadu = runtime.migaduAdmin as FakeMigaduAdmin;
  const user = fixtureUser();
  const mailbox = {
    ...fixtureMailbox(),
    state: "pending_delete" as const,
    deleteAfter: "2026-08-18T00:00:00.000Z",
  };
  await runtime.directory.putUser(user);
  await runtime.directory.putMailbox(mailbox);
  await runtime.directory.putGrant({
    userId: user.id,
    mailboxId: mailbox.id,
    role: "owner",
    createdAt: mailbox.createdAt,
    createdBy: user.id,
  });
  await runtime.credentials.put(fixtureCredential());
  await reconcileMailboxLifecycle(
    runtime,
    "system:test",
    Date.parse("2026-08-19T00:00:00.000Z"),
  );
  const deleted = await runtime.directory.getMailbox(mailbox.id);
  assertEquals(deleted?.state, "deleted");
  assertEquals(await runtime.directory.getGrant(user.id, mailbox.id), null);
  assertEquals(migadu.deletedIdentities.length, 1);
});

function smtpCapture(): { transport: ByteDuplex; writes: string[] } {
  const encoder = new TextEncoder();
  const writes: string[] = [];
  const responses = [
    "220 smtp.example.test ready\r\n",
    "250-smtp.example.test\r\n250 AUTH PLAIN\r\n",
    "235 Authentication successful\r\n",
    "250 Sender accepted\r\n",
    "250 Recipient accepted\r\n",
    "354 Send message content\r\n",
    "250 Message queued\r\n",
    "221 Bye\r\n",
  ];
  const transport: ByteDuplex = {
    readable: new ReadableStream<Uint8Array>({
      pull(controller) {
        const next = responses.shift();
        if (next === undefined) controller.close();
        else controller.enqueue(encoder.encode(next));
      },
    }),
    writable: new WritableStream<Uint8Array>({
      write(chunk) {
        writes.push(new TextDecoder().decode(chunk));
      },
    }),
    close() {},
  };
  return { transport, writes };
}

function extractVerificationCode(writes: string[]): string {
  const match = writes.join("").match(
    /Your mailecho verification code is: ([a-z0-9]{8})/,
  );
  if (!match) throw new Error("Verification code not found in SMTP output");
  return match[1];
}

function adminFixture(): {
  user: WebmailUser;
  mailbox: MailboxRecord;
  credential: MailboxCredential;
} {
  const user = fixtureUser(["webmail-users", "webmail-admin"]);
  user.id = "user-admin";
  user.subject = "subject-admin";
  const mailbox: MailboxRecord = {
    ...fixtureMailbox(),
    id: "mailbox-admin",
    address: "admin@example.com",
    internalAddress: "admin@internal.example.com",
    localPart: "admin",
    ownerUserId: "user-admin",
    credentialId: "credential-admin",
  };
  const credential: MailboxCredential = {
    ...fixtureCredential(),
    id: "credential-admin",
    mailboxId: "mailbox-admin",
  };
  return { user, mailbox, credential };
}

Deno.test("registration request flows to approval and creates a mailbox", async () => {
  const migadu = new FakeMigaduAdmin();
  const runtime = testRuntime(testConfig(), migadu);
  const user = fixtureUser();
  const { accessToken } = await seedMailbox(
    runtime,
    user,
    fixtureMailbox(),
    fixtureCredential(),
  );

  const createResponse = await requestWithSession(
    runtime,
    "/v1/mailbox-registrations",
    accessToken,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ local_part: "new-address" }),
    },
  );
  assertEquals(createResponse.status, 201);
  const created = await createResponse.json();
  assertEquals(created.state, "pending");

  const admin = adminFixture();
  const { accessToken: adminToken } = await seedMailbox(
    runtime,
    admin.user,
    admin.mailbox,
    admin.credential,
  );

  const approveResponse = await requestWithSession(
    runtime,
    `/v1/admin/mailbox-registrations/${created.id}/approve`,
    adminToken,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    },
  );
  assertEquals(approveResponse.status, 200);
  assertEquals(migadu.mailboxCreates, 1);
  const approved = await approveResponse.json();
  assertEquals(approved.state, "approved");
  assertEquals(approved.mailbox.ownerUserId, user.id);
});

Deno.test("registration approval is admin-only", async () => {
  const runtime = testRuntime();
  const user = fixtureUser();
  const { accessToken } = await seedMailbox(
    runtime,
    user,
    fixtureMailbox(),
    fixtureCredential(),
  );
  await runtime.directory.putRegistrationRequest({
    id: "reg-1",
    userId: user.id,
    localPart: "pending",
    domain: "example.com",
    address: "pending@example.com",
    state: "pending",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  const response = await requestWithSession(
    runtime,
    "/v1/admin/mailbox-registrations/reg-1/approve",
    accessToken,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) },
  );
  assertEquals(response.status, 403);
});

Deno.test("claim flow sends verification mail and attaches on the correct code", async () => {
  const migadu = new FakeMigaduAdmin();
  migadu.existingAddresses.add("claimed@example.com");
  const runtime = testRuntime(testConfig(), migadu);
  const user = fixtureUser();
  const { accessToken } = await seedMailbox(
    runtime,
    user,
    fixtureMailbox(),
    fixtureCredential(),
  );
  const capture = smtpCapture();
  runtime.connectSmtp = async () => capture.transport;

  const claimResponse = await requestWithSession(
    runtime,
    "/v1/mailbox-claims",
    accessToken,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address: "claimed@example.com" }),
    },
  );
  assertEquals(claimResponse.status, 201);
  const claim = await claimResponse.json();
  assertEquals(claim.state, "pending_verification");
  const code = extractVerificationCode(capture.writes);

  const verifyResponse = await requestWithSession(
    runtime,
    `/v1/mailbox-claims/${claim.id}/verify`,
    accessToken,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    },
  );
  assertEquals(verifyResponse.status, 200);
  const verified = await verifyResponse.json();
  assertEquals(verified.state, "verified");
  assertEquals(migadu.identityCreates, 1);
  assertEquals(migadu.mailboxCreates, 0);
  assertEquals(verified.mailbox.address, "claimed@example.com");
});

Deno.test("claim rejects an address that does not exist at the provider", async () => {
  const migadu = new FakeMigaduAdmin();
  const runtime = testRuntime(testConfig(), migadu);
  const user = fixtureUser();
  const { accessToken } = await seedMailbox(
    runtime,
    user,
    fixtureMailbox(),
    fixtureCredential(),
  );
  const response = await requestWithSession(
    runtime,
    "/v1/mailbox-claims",
    accessToken,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address: "missing@example.com" }),
    },
  );
  assertEquals(response.status, 409);
  assertEquals((await response.json()).code, "ADDRESS_UNAVAILABLE");
});

Deno.test("webmail-user endpoints reject a disabled identity", async () => {
  const runtime = testRuntime();
  const user = fixtureUser();
  user.enabled = false;
  const { accessToken } = await seedMailbox(
    runtime,
    user,
    fixtureMailbox(),
    fixtureCredential(),
  );
  const response = await requestWithSession(
    runtime,
    "/v1/mailbox-registrations",
    accessToken,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ local_part: "x" }),
    },
  );
  assertEquals(response.status, 403);
});

Deno.test("me reports mailbox selection and pending counts", async () => {
  const runtime = testRuntime();
  const user = fixtureUser();
  const { accessToken } = await seedMailbox(
    runtime,
    user,
    fixtureMailbox(),
    fixtureCredential(),
  );
  await runtime.directory.putRegistrationRequest({
    id: "reg-2",
    userId: user.id,
    localPart: "pending",
    domain: "example.com",
    address: "pending@example.com",
    state: "pending",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  const response = await requestWithSession(runtime, "/v1/me", accessToken);
  assertEquals(response.status, 200);
  const me = await response.json();
  assertEquals(me.pending_registration_count, 1);
  assertEquals(me.needs_mailbox_selection, false);
});
