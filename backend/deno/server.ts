import { configFromEnv } from "../core/config.ts";
import { createHandler, type RuntimeAdapter } from "../core/app.ts";
import { authenticateRequest } from "../core/request-auth.ts";
import { authenticateProtocolRequest, requireMailboxAccess } from "../core/mailbox-access.ts";
import { EncryptedSessionStore, type KeyValueStore } from "../core/session-kv.ts";
import { MemoryEventHub } from "../core/events.ts";
import { SessionService } from "../core/session.ts";
import type { ByteDuplex } from "../protocol/transport.ts";
import { KvDirectoryStore } from "../core/directory-store.ts";
import { EncryptedCredentialStore } from "../core/credential-store.ts";
import { MigaduAdminClient } from "../core/migadu.ts";
import { KvLocalMessageStore } from "../core/local-messages.ts";
import { startRawWebSocketBridge } from "../cloudflare/websocket.ts";
import { DenoKvProvisioningCoordinator } from "./provisioning-coordinator.ts";
import { reconcileMailboxLifecycle } from "../core/mailbox-lifecycle.ts";
import { isEmbeddedWebmailRequest } from "../core/embedded-webmail.ts";

const env = Deno.env.toObject();
const config = configFromEnv(env);
const kv = await Deno.openKv(env.DENO_KV_PATH);

const storage: KeyValueStore = {
  async get(key) {
    return (await kv.get<string>(["mailecho", key])).value;
  },
  async put(key, value, ttlSeconds) {
    await kv.set(["mailecho", key], value, { expireIn: ttlSeconds * 1000 });
  },
  async delete(key) {
    await kv.delete(["mailecho", key]);
  },
  async list(prefix) {
    const keys: string[] = [];
    for await (const entry of kv.list({ prefix: ["mailecho", prefix] })) {
      const key = entry.key.at(-1);
      if (typeof key === "string") keys.push(key);
    }
    return keys;
  },
};

const events = new MemoryEventHub();

function connectTls(hostname: string, port: number): Promise<ByteDuplex> {
  return Deno.connectTls({ hostname, port }).then((connection) => ({
    readable: connection.readable,
    writable: connection.writable,
    close: () => connection.close(),
  }));
}

const runtime: RuntimeAdapter = {
  config,
  sessions: new EncryptedSessionStore(storage, config),
  directory: new KvDirectoryStore(storage),
  credentials: new EncryptedCredentialStore(storage, config),
  oidcStorage: storage,
  migaduAdmin: new MigaduAdminClient(config),
  localMessages: new KvLocalMessageStore(storage),
  provisioning: new DenoKvProvisioningCoordinator(kv),
  events,
  connectImap: () => connectTls(config.imapHost, config.imapPort),
  connectSmtp: () => connectTls(config.smtpHost, config.smtpPort),
};

const handler = createHandler(runtime);
const serveWebmail = env.SERVE_WEBMAIL === "true";
const webmailPath = new URL("../public/index.html", import.meta.url);
let webmailDocument: Promise<string> | undefined;

type DenoCron = (
  name: string,
  schedule: string,
  handler: () => void | Promise<void>,
) => void;

const denoCron = (Deno as unknown as { cron?: DenoCron }).cron;
const isDenoDeploy = Boolean(
  env.DENO_DEPLOYMENT_ID || env.DENO_DEPLOY === "true",
);

function reconcileLifecycle(): void {
  void reconcileMailboxLifecycle(runtime).catch(() => {
    console.error("Mailbox lifecycle reconciliation failed.");
  });
}

if (isDenoDeploy && denoCron) {
  // Deno Deploy discovers top-level cron declarations during deployment.
  denoCron("mailecho-mailbox-lifecycle", "*/5 * * * *", reconcileLifecycle);
} else {
  // Self-hosted Deno has a resident process, so an interval is appropriate.
  setInterval(reconcileLifecycle, config.lifecycleIntervalSeconds * 1000);
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
  const { socket, response } = Deno.upgradeWebSocket(request);
  startRawWebSocketBridge(
    socket,
    protocol === "imap" ? adapter.connectImap : adapter.connectSmtp,
    credentials,
  );
  return response;
}

async function eventWebSocket(request: Request): Promise<Response> {
  const identity = await authenticateRequest(
    request,
    new SessionService(runtime.sessions, config),
  );
  await requireMailboxAccess(identity, runtime);
  const { socket, response } = Deno.upgradeWebSocket(request);
  const identityTimer = setTimeout(
    () => socket.close(4001, "Identity session expired"),
    Math.max(
      0,
      identity.record.identityValidatedAt + config.oidcReauthSeconds * 1000 -
        Date.now(),
    ),
  );
  let mailbox: string | undefined;
  const unsubscribe = events.subscribe((event) => {
    if (event.data.session_id !== identity.claims.sid) return;
    if (mailbox && event.data.mailbox !== mailbox) return;
    if (socket.readyState === WebSocket.OPEN) {
      const { session_id: _sessionId, ...data } = event.data;
      socket.send(JSON.stringify({ ...event, data }));
    }
  });
  socket.onmessage = (message) => {
    if (typeof message.data !== "string") return;
    try {
      const value = JSON.parse(message.data) as {
        type?: string;
        mailbox?: string;
      };
      if (value.type === "subscribe" && value.mailbox) mailbox = value.mailbox;
      if (value.type === "ping") {
        socket.send(JSON.stringify({ object: "event", type: "pong" }));
      }
    } catch {
      socket.close(1003, "Invalid event message");
    }
  };
  socket.onclose = () => {
    clearTimeout(identityTimer);
    unsubscribe();
  };
  return response;
}

function originAllowed(request: Request): boolean {
  const origin = request.headers.get("origin");
  return origin === config.appOrigin;
}

async function embeddedWebmail(request: Request): Promise<Response | null> {
  if (!serveWebmail || !isEmbeddedWebmailRequest(request)) return null;
  try {
    webmailDocument ||= Deno.readTextFile(webmailPath);
    const document = await webmailDocument;
    return new Response(request.method === "HEAD" ? null : document, {
      headers: {
        "cache-control": "no-store",
        "content-type": "text/html; charset=utf-8",
      },
    });
  } catch {
    return new Response("Webmail static document is unavailable.", {
      status: 503,
    });
  }
}

async function requestHandler(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
    if (!originAllowed(request)) {
      return Promise.resolve(new Response("Forbidden", { status: 403 }));
    }
    if (url.pathname === "/v1/events") {
      return eventWebSocket(request).catch(() => new Response("Unauthorized", { status: 401 }));
    }
    if (url.pathname === "/v1/imap") {
      return rawWebSocket(request, runtime, "imap").catch(() =>
        new Response("Unauthorized", { status: 401 })
      );
    }
    if (url.pathname === "/v1/smtp") {
      return rawWebSocket(request, runtime, "smtp").catch(() =>
        new Response("Unauthorized", { status: 401 })
      );
    }
  }
  const page = await embeddedWebmail(request);
  if (page) return page;
  return handler(request);
}

console.log(`mailecho Deno backend listening on ${env.PORT || "8000"}`);
Deno.serve({ port: Number(env.PORT || 8000) }, requestHandler);
