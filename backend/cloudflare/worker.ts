import { connect } from "cloudflare:sockets";
import { configFromEnv } from "../core/config.ts";
import { authenticateRequest, createHandler, type RuntimeAdapter } from "../core/app.ts";
import { EncryptedSessionStore, type KeyValueStore } from "../core/session-kv.ts";
import { MemoryEventHub } from "../core/events.ts";
import { SessionService } from "../core/session.ts";
import type { ByteDuplex } from "../protocol/transport.ts";
import { startRawWebSocketBridge } from "./websocket.ts";

export interface Env {
  SESSION_KV: KVNamespace;
  JWT_SECRET: string;
  APP_ORIGIN: string;
  PROBLEM_TYPE_BASE_URL?: string;
  JWT_ACCESS_TTL_SECONDS?: string;
  JWT_REFRESH_TTL_SECONDS?: string;
  SESSION_TTL_SECONDS?: string;
  MIGADU_IMAP_HOST?: string;
  MIGADU_IMAP_PORT?: string;
  MIGADU_SMTP_HOST?: string;
  MIGADU_SMTP_PORT?: string;
  MAX_MESSAGE_BYTES?: string;
  MAX_RECIPIENTS?: string;
}

const events = new MemoryEventHub();

function connectTls(hostname: string, port: number): Promise<ByteDuplex> {
  const socket = connect({ hostname, port }, { secureTransport: "on" });
  return Promise.resolve({ readable: socket.readable, writable: socket.writable, close: () => socket.close() });
}

function rawWebSocket(request: Request, connectUpstream: () => Promise<ByteDuplex>): Response {
  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];
  server.accept();
  startRawWebSocketBridge(server, connectUpstream);
  return new Response(null, { status: 101, webSocket: client });
}

function runtime(env: Env): RuntimeAdapter {
  const config = configFromEnv(env as unknown as Record<string, string | undefined>);
  const storage: KeyValueStore = {
    get: (key) => env.SESSION_KV.get(key),
    put: (key, value, ttlSeconds) => env.SESSION_KV.put(key, value, { expirationTtl: ttlSeconds }),
    delete: (key) => env.SESSION_KV.delete(key),
  };
  return {
    config,
    sessions: new EncryptedSessionStore(storage, config),
    events,
    connectImap: () => connectTls(config.imapHost, config.imapPort),
    connectSmtp: () => connectTls(config.smtpHost, config.smtpPort),
  };
}

async function eventWebSocket(request: Request, adapter: RuntimeAdapter): Promise<Response> {
  const identity = await authenticateRequest(request, new SessionService(adapter.sessions, adapter.config));
  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];
  server.accept();
  let mailbox: string | undefined;
  const unsubscribe = events.subscribe((event) => {
    if (event.data.session_id !== identity.claims.sid) return;
    if (mailbox && event.data.mailbox !== mailbox) return;
    if (server.readyState === WebSocket.OPEN) {
      const { session_id: _sessionId, ...data } = event.data;
      server.send(JSON.stringify({ ...event, data }));
    }
  });
  server.addEventListener("close", unsubscribe);
  server.addEventListener("message", (message) => {
    if (typeof message.data !== "string") return;
    try {
      const value = JSON.parse(message.data) as { type?: string; mailbox?: string };
      if (value.type === "subscribe" && value.mailbox) mailbox = value.mailbox;
      if (value.type === "ping") server.send(JSON.stringify({ object: "event", type: "pong" }));
    } catch {
      server.close(1003, "Invalid event message");
    }
  });
  return new Response(null, { status: 101, webSocket: client });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const adapter = runtime(env);
    if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
      const origin = request.headers.get("origin");
      if (origin !== adapter.config.appOrigin) return new Response("Forbidden", { status: 403 });
      if (url.pathname === "/v1/events") return eventWebSocket(request, adapter).catch(() => new Response("Unauthorized", { status: 401 }));
      if (url.pathname === "/v1/imap") return rawWebSocket(request, adapter.connectImap);
      if (url.pathname === "/v1/smtp") return rawWebSocket(request, adapter.connectSmtp);
    }
    return createHandler(adapter)(request);
  },
};
