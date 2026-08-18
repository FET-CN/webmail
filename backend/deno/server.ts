import { configFromEnv } from "../core/config.ts";
import { authenticateRequest, createHandler, type RuntimeAdapter } from "../core/app.ts";
import { EncryptedSessionStore, type KeyValueStore } from "../core/session-kv.ts";
import { MemoryEventHub } from "../core/events.ts";
import { SessionService } from "../core/session.ts";
import type { ByteDuplex } from "../protocol/transport.ts";

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
  events,
  connectImap: () => connectTls(config.imapHost, config.imapPort),
  connectSmtp: () => connectTls(config.smtpHost, config.smtpPort),
};

const handler = createHandler(runtime);

function rawWebSocket(request: Request, connect: () => Promise<ByteDuplex>): Response {
  const { socket, response } = Deno.upgradeWebSocket(request);
  socket.binaryType = "arraybuffer";
  socket.onopen = async () => {
    try {
      const upstream = await connect();
      const writer = upstream.writable.getWriter();
      socket.onmessage = async (event) => {
        const data = typeof event.data === "string" ? new TextEncoder().encode(event.data) : new Uint8Array(event.data);
        await writer.write(data);
      };
      socket.onclose = async () => {
        writer.releaseLock();
        await upstream.close();
      };
      await upstream.readable.pipeTo(new WritableStream({ write: (chunk) => socket.send(chunk) }));
    } catch {
      socket.close(1011, "Upstream unavailable");
    }
  };
  return response;
}

async function eventWebSocket(request: Request): Promise<Response> {
  const identity = await authenticateRequest(request, new SessionService(runtime.sessions, config));
  const { socket, response } = Deno.upgradeWebSocket(request);
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
      const value = JSON.parse(message.data) as { type?: string; mailbox?: string };
      if (value.type === "subscribe" && value.mailbox) mailbox = value.mailbox;
      if (value.type === "ping") socket.send(JSON.stringify({ object: "event", type: "pong" }));
    } catch {
      socket.close(1003, "Invalid event message");
    }
  };
  socket.onclose = unsubscribe;
  return response;
}

function originAllowed(request: Request): boolean {
  const origin = request.headers.get("origin");
  return origin === config.appOrigin;
}

function requestHandler(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
    if (!originAllowed(request)) return Promise.resolve(new Response("Forbidden", { status: 403 }));
    if (url.pathname === "/v1/events") return eventWebSocket(request).catch(() => new Response("Unauthorized", { status: 401 }));
    if (url.pathname === "/v1/imap") return Promise.resolve(rawWebSocket(request, runtime.connectImap));
    if (url.pathname === "/v1/smtp") return Promise.resolve(rawWebSocket(request, runtime.connectSmtp));
  }
  return handler(request);
}

console.log(`mailecho Deno backend listening on ${env.PORT || "8000"}`);
Deno.serve({ port: Number(env.PORT || 8000) }, requestHandler);
