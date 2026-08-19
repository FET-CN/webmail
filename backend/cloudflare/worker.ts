import { connect } from "cloudflare:sockets";
import { configFromEnv } from "../core/config.ts";
import { createHandler, type RuntimeAdapter } from "../core/app.ts";
import { authenticateRequest } from "../core/request-auth.ts";
import {
  authenticateProtocolRequest,
  requireMailboxAccess,
} from "../core/mailbox-access.ts";
import {
  EncryptedSessionStore,
  type KeyValueStore,
} from "../core/session-kv.ts";
import { MemoryEventHub } from "../core/events.ts";
import { SessionService } from "../core/session.ts";
import type { ByteDuplex } from "../protocol/transport.ts";
import { startRawWebSocketBridge } from "./websocket.ts";
import { KvDirectoryStore } from "../core/directory-store.ts";
import { EncryptedCredentialStore } from "../core/credential-store.ts";
import { MigaduAdminClient } from "../core/migadu.ts";
import { KvLocalMessageStore } from "../core/local-messages.ts";
import {
  CloudflareProvisioningCoordinator,
  type DurableObjectNamespaceLike,
  ProvisioningLockObject,
} from "./provisioning-coordinator.ts";
import { reconcileMailboxLifecycle } from "../core/mailbox-lifecycle.ts";
import { isEmbeddedWebmailRequest } from "../core/embedded-webmail.ts";

export { ProvisioningLockObject };

export interface Env {
  ASSETS?: Fetcher;
  SESSION_KV: KVNamespace;
  PROVISIONING_LOCKS: DurableObjectNamespaceLike;
  JWT_SECRET: string;
  CREDENTIAL_ENCRYPTION_KEY: string;
  APP_ORIGIN: string;
  OIDC_ISSUER?: string;
  OIDC_CLIENT_ID?: string;
  OIDC_CLIENT_SECRET?: string;
  OIDC_REDIRECT_URI?: string;
  OIDC_WEBMAIL_GROUP?: string;
  OIDC_ADMIN_GROUP?: string;
  OIDC_REAUTH_SECONDS?: string;
  MAIL_DOMAIN?: string;
  INTERNAL_MAIL_DOMAIN?: string;
  MAILBOX_PROVISIONING_ENABLED?: string;
  MIGADU_API_BASE_URL?: string;
  MIGADU_API_USER?: string;
  MIGADU_API_KEY?: string;
  PROBLEM_TYPE_BASE_URL?: string;
  JWT_ACCESS_TTL_SECONDS?: string;
  JWT_REFRESH_TTL_SECONDS?: string;
  SESSION_TTL_SECONDS?: string;
  LIFECYCLE_RECONCILE_SECONDS?: string;
  MIGADU_IMAP_HOST?: string;
  MIGADU_IMAP_PORT?: string;
  MIGADU_SMTP_HOST?: string;
  MIGADU_SMTP_PORT?: string;
  MAX_MESSAGE_BYTES?: string;
  MAX_RECIPIENTS?: string;
  SERVE_WEBMAIL?: string;
}

const events = new MemoryEventHub();

function connectTls(hostname: string, port: number): Promise<ByteDuplex> {
  const socket = connect({ hostname, port }, { secureTransport: "on" });
  return Promise.resolve({
    readable: socket.readable,
    writable: socket.writable,
    close: () => socket.close(),
  });
}

async function rawWebSocket(
  request: Request,
  adapter: RuntimeAdapter,
  protocol: "imap" | "smtp",
): Promise<Response> {
  const credentials = await authenticateProtocolRequest(
    request,
    adapter,
    protocol,
  );
  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];
  server.accept();
  startRawWebSocketBridge(
    server,
    protocol === "imap" ? adapter.connectImap : adapter.connectSmtp,
    credentials,
  );
  return new Response(null, { status: 101, webSocket: client });
}

function runtime(env: Env): RuntimeAdapter {
  const config = configFromEnv(
    env as unknown as Record<string, string | undefined>,
  );
  const storage: KeyValueStore = {
    get: (key) => env.SESSION_KV.get(key),
    put: (key, value, ttlSeconds) =>
      env.SESSION_KV.put(key, value, { expirationTtl: ttlSeconds }),
    delete: (key) => env.SESSION_KV.delete(key),
    async list(prefix) {
      const keys: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await env.SESSION_KV.list({ prefix, cursor });
        keys.push(...page.keys.map((key) => key.name));
        cursor = page.list_complete ? undefined : page.cursor;
      } while (cursor);
      return keys;
    },
  };
  return {
    config,
    sessions: new EncryptedSessionStore(storage, config),
    directory: new KvDirectoryStore(storage),
    credentials: new EncryptedCredentialStore(storage, config),
    oidcStorage: storage,
    migaduAdmin: new MigaduAdminClient(config),
    localMessages: new KvLocalMessageStore(storage),
    provisioning: new CloudflareProvisioningCoordinator(env.PROVISIONING_LOCKS),
    events,
    connectImap: () => connectTls(config.imapHost, config.imapPort),
    connectSmtp: () => connectTls(config.smtpHost, config.smtpPort),
  };
}

async function eventWebSocket(
  request: Request,
  adapter: RuntimeAdapter,
): Promise<Response> {
  const identity = await authenticateRequest(
    request,
    new SessionService(adapter.sessions, adapter.config),
  );
  await requireMailboxAccess(identity, adapter);
  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];
  server.accept();
  const identityTimer = setTimeout(
    () => server.close(4001, "Identity session expired"),
    Math.max(
      0,
      identity.record.identityValidatedAt +
        adapter.config.oidcReauthSeconds * 1000 - Date.now(),
    ),
  );
  let mailbox: string | undefined;
  const unsubscribe = events.subscribe((event) => {
    if (event.data.session_id !== identity.claims.sid) return;
    if (mailbox && event.data.mailbox !== mailbox) return;
    if (server.readyState === WebSocket.OPEN) {
      const { session_id: _sessionId, ...data } = event.data;
      server.send(JSON.stringify({ ...event, data }));
    }
  });
  server.addEventListener("close", () => {
    clearTimeout(identityTimer);
    unsubscribe();
  });
  server.addEventListener("message", (message) => {
    if (typeof message.data !== "string") return;
    try {
      const value = JSON.parse(message.data) as {
        type?: string;
        mailbox?: string;
      };
      if (value.type === "subscribe" && value.mailbox) mailbox = value.mailbox;
      if (value.type === "ping") {
        server.send(JSON.stringify({ object: "event", type: "pong" }));
      }
    } catch {
      server.close(1003, "Invalid event message");
    }
  });
  return new Response(null, { status: 101, webSocket: client });
}

function embeddedWebmail(
  request: Request,
  env: Env,
): Promise<Response> | null {
  if (
    env.SERVE_WEBMAIL !== "true" || !env.ASSETS ||
    !isEmbeddedWebmailRequest(request)
  ) {
    return null;
  }
  return env.ASSETS.fetch(
    new Request(new URL("/index.html", request.url), request),
  );
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const adapter = runtime(env);
    if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
      const origin = request.headers.get("origin");
      if (origin !== adapter.config.appOrigin) {
        return new Response("Forbidden", { status: 403 });
      }
      if (url.pathname === "/v1/events") {
        return eventWebSocket(request, adapter).catch(() =>
          new Response("Unauthorized", { status: 401 })
        );
      }
      if (url.pathname === "/v1/imap") {
        return rawWebSocket(request, adapter, "imap").catch(() =>
          new Response("Unauthorized", { status: 401 })
        );
      }
      if (url.pathname === "/v1/smtp") {
        return rawWebSocket(request, adapter, "smtp").catch(() =>
          new Response("Unauthorized", { status: 401 })
        );
      }
    }
    const page = embeddedWebmail(request, env);
    if (page) return page;
    return createHandler(adapter)(request);
  },
  scheduled(
    _controller: ScheduledController,
    env: Env,
    context: ExecutionContext,
  ): void {
    context.waitUntil(reconcileMailboxLifecycle(runtime(env)));
  },
};
