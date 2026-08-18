import type { BackendConfig } from "./config.ts";
import { AppError, json, problemResponse, readBearer } from "./errors.ts";
import { expandQuery } from "./expand.ts";
import { problemDocument } from "./problem-docs.ts";
import { decodeCursor, encodeCursor, listResponse } from "./pagination.ts";
import { SessionService, type SessionStore } from "./session.ts";
import { ImapClient } from "../protocol/imap.ts";
import { SmtpClient } from "../protocol/smtp.ts";
import type { ByteDuplex } from "../protocol/transport.ts";
import { PROBLEM_DEFINITIONS, type ProblemCode } from "../contract/problems.ts";
import type { MessageResource } from "../contract/api.ts";
import type { EventHub } from "./events.ts";

export interface RuntimeAdapter {
  config: BackendConfig;
  sessions: SessionStore;
  events?: EventHub;
  connectImap(): Promise<ByteDuplex>;
  connectSmtp(): Promise<ByteDuplex>;
}

function cookie(request: Request, name: string): string | null {
  const value = request.headers.get("cookie")?.split(";").map((item) => item.trim())
    .find((item) => item.startsWith(`${name}=`));
  return value ? decodeURIComponent(value.slice(name.length + 1)) : null;
}

function authCookie(name: string, value: string, maxAge: number): string {
  return `${name}=${encodeURIComponent(value)}; Max-Age=${maxAge}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

function setSessionCookies(headers: Headers, accessToken: string, refreshToken: string, config: BackendConfig): void {
  headers.append("set-cookie", authCookie("mailecho_access", accessToken, config.accessTtlSeconds));
  headers.append("set-cookie", authCookie("mailecho_refresh", refreshToken, config.refreshTtlSeconds));
}

export async function authenticateRequest(request: Request, service: SessionService) {
  const token = readBearer(request) || cookie(request, "mailecho_access");
  if (!token) throw new AppError("AUTH_REQUIRED", "Authentication is required.");
  return service.access(token);
}

async function body(request: Request): Promise<Record<string, unknown>> {
  try {
    const value = await request.json();
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new AppError("INVALID_PARAMS", "The request body must be a JSON object.");
  }
}

function base64Bytes(value: string): Uint8Array {
  try {
    return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
  } catch {
    throw new AppError("INVALID_PARAMS", "The raw message must be valid base64.", "raw");
  }
}

function base64Text(value: string | Uint8Array): string {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function messageHeaders(raw: Uint8Array): Record<string, string> {
  const text = new TextDecoder().decode(raw);
  const headerBlock = text.split(/\r?\n\r?\n/, 1)[0] || "";
  const result: Record<string, string> = {};
  for (const line of headerBlock.split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    result[line.slice(0, separator).toLowerCase()] = line.slice(separator + 1).trim();
  }
  return result;
}

function messageAttachments(raw: Uint8Array): Array<{ filename?: string; content_type?: string; size?: number }> {
  const headers = messageHeaders(raw);
  const contentType = headers["content-type"] || "";
  const disposition = headers["content-disposition"] || "";
  if (!/multipart\//i.test(contentType) && !/attachment/i.test(disposition)) return [];
  const filename = disposition.match(/filename\s*=\s*"?([^";]+)"?/i)?.[1];
  return [{ ...(filename ? { filename } : {}), content_type: contentType.split(";", 1)[0] || undefined, size: raw.byteLength }];
}

async function withImap<T>(runtime: RuntimeAdapter, username: string, password: string, action: (imap: ImapClient) => Promise<T>): Promise<T> {
  const transport = await runtime.connectImap();
  const imap = new ImapClient(transport);
  try {
    await imap.start();
    await imap.login(username, password);
    return await action(imap);
  } finally {
    await imap.logout().catch(() => transport.close());
  }
}

function corsHeaders(request: Request, origin: string): Headers {
  const headers = new Headers();
  if (request.headers.get("origin") === origin) {
    headers.set("access-control-allow-origin", origin);
    headers.set("access-control-allow-credentials", "true");
    headers.set("vary", "Origin");
  }
  return headers;
}

function validMailbox(value: string): string {
  if (!value || value.length > 255 || /[\r\n\0]/.test(value)) {
    throw new AppError("INVALID_PARAMS", "The mailbox name is invalid.", "mailbox");
  }
  return value;
}

function validUid(value: string): number {
  const uid = Number(value);
  if (!Number.isSafeInteger(uid) || uid < 1) throw new AppError("INVALID_PARAMS", "The message UID is invalid.", "uid");
  return uid;
}

function validAddress(value: string, param: string): string {
  if (!/^[^@\s<>\r\n]+@[^@\s<>\r\n]+$/.test(value)) {
    throw new AppError("INVALID_PARAMS", "The email address is invalid.", param);
  }
  return value;
}

function validCredential(value: string, param: string): string {
  if (!value || /[\r\n\0]/.test(value)) {
    throw new AppError("INVALID_PARAMS", "The credential contains an invalid control character.", param);
  }
  return value;
}

export function createHandler(runtime: RuntimeAdapter): (request: Request) => Promise<Response> {
  const sessions = new SessionService(runtime.sessions, runtime.config);
  return async (request) => {
    const url = new URL(request.url);
    try {
      if (request.method === "OPTIONS") {
        const headers = corsHeaders(request, runtime.config.appOrigin);
        headers.set("access-control-allow-methods", "GET,POST,PATCH,DELETE,OPTIONS");
        headers.set("access-control-allow-headers", "Authorization,Content-Type,Idempotency-Key,X-Request-Id");
        headers.set("access-control-max-age", "600");
        return new Response(null, { status: 204, headers });
      }
      if (url.pathname.startsWith("/problems/")) {
        const slug = url.pathname.slice("/problems/".length);
        const code = Object.keys(PROBLEM_DEFINITIONS).find((key) => PROBLEM_DEFINITIONS[key as ProblemCode].slug === slug) as ProblemCode | undefined;
        if (!code) throw new AppError("PROBLEM_TYPE_NOT_FOUND", "Problem type not found.");
        const accept = request.headers.get("accept") || "text/html";
        const format = accept.includes("text/markdown") ? "markdown" : accept.includes("application/json") ? "json" : "html";
        return problemDocument(code, runtime.config.problemTypeBaseUrl, format);
      }
      if (url.pathname === "/v1/session/login" && request.method === "POST") {
        const input = await body(request);
        const username = validCredential(String(input.username || "").trim(), "username");
        const password = validCredential(String(input.password || ""), "password");
        if (!username || !password) throw new AppError("INVALID_PARAMS", "Username and password are required.");
        await withImap(runtime, username, password, async () => undefined);
        const result = await sessions.create({ username, password });
        const headers = corsHeaders(request, runtime.config.appOrigin);
        setSessionCookies(headers, result.accessToken, result.refreshToken, runtime.config);
        return json({ object: "session", user: { object: "user", id: username }, expires_at: new Date(result.record.expiresAt).toISOString() }, 201, headers);
      }
      if (url.pathname === "/v1/session/refresh" && request.method === "POST") {
        const token = cookie(request, "mailecho_refresh");
        if (!token) throw new AppError("AUTH_REQUIRED", "A refresh token is required.");
        const result = await sessions.refresh(token);
        const headers = corsHeaders(request, runtime.config.appOrigin);
        setSessionCookies(headers, result.accessToken, result.refreshToken, runtime.config);
        return json({ object: "session", refreshed: true }, 200, headers);
      }
      if (url.pathname === "/v1/session/logout" && request.method === "POST") {
        const identity = await authenticateRequest(request, sessions);
        await sessions.logout(identity.claims.sid);
        const headers = corsHeaders(request, runtime.config.appOrigin);
        headers.append("set-cookie", authCookie("mailecho_access", "", 0));
        headers.append("set-cookie", authCookie("mailecho_refresh", "", 0));
        return json({ object: "session", logged_out: true }, 200, headers);
      }

      const identity = await authenticateRequest(request, sessions);
      const username = identity.record.credentials.username;
      const password = identity.record.credentials.password;
      const headers = corsHeaders(request, runtime.config.appOrigin);

      if (url.pathname === "/v1/mailboxes" && request.method === "GET") {
        const mailboxes = await withImap(runtime, username, password, (imap) => imap.listMailboxes());
        return json({ ...listResponse(mailboxes, 1, mailboxes.length, null) }, 200, headers);
      }
      const mailboxMatch = url.pathname.match(/^\/v1\/mailboxes\/([^/]+)\/messages$/);
      if (mailboxMatch && request.method === "GET") {
        const mailbox = validMailbox(decodeURIComponent(mailboxMatch[1]));
        const requestedLimit = Number(url.searchParams.get("limit") || 25);
        if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 100) {
          throw new AppError("INVALID_PARAMS", "limit must be an integer between 1 and 100.", "limit");
        }
        const limit = requestedLimit;
        const cursor = url.searchParams.get("after");
        const cursorPayload = cursor ? decodeCursor(cursor, mailbox) : null;
        const messages = await withImap(runtime, username, password, (imap) => imap.fetchSummaries(mailbox, limit + 1, cursorPayload?.uid));
        const filtered = cursorPayload ? messages.filter((message) => message.uid < cursorPayload.uid) : messages;
        const data = filtered.slice(0, limit);
        const last = data.at(-1);
        const nextCursor = filtered.length > limit && last ? encodeCursor({ version: 1, mailbox, date: last.date || "1970-01-01T00:00:00.000Z", uid: last.uid, page: (cursorPayload?.page || 0) + 1 }) : null;
        return json({ ...listResponse(data, (cursorPayload?.page || 0) + 1, limit, nextCursor), ...(expandQuery(url).length ? { expand: expandQuery(url) } : {}) }, 200, headers);
      }
      const messageMatch = url.pathname.match(/^\/v1\/mailboxes\/([^/]+)\/messages\/(\d+)$/);
      if (messageMatch && request.method === "GET") {
        const mailbox = validMailbox(decodeURIComponent(messageMatch[1]));
        const uid = validUid(messageMatch[2]);
        const message = await withImap(runtime, username, password, (imap) => imap.fetchMessage(mailbox, uid));
        const expansions = expandQuery(url);
        const resource: MessageResource = { ...message, object: "message", raw: base64Text(message.raw) };
        if (expansions.includes("headers")) resource.headers = messageHeaders(message.raw);
        if (expansions.includes("attachments")) resource.attachments = messageAttachments(message.raw);
        if (expansions.includes("mailbox")) {
          const mailboxes = await withImap(runtime, username, password, (imap) => imap.listMailboxes());
          const mailboxResource = mailboxes.find((item) => item.name === mailbox);
          if (mailboxResource) resource.mailbox = mailboxResource;
        }
        return json(resource, 200, headers);
      }
      const flagMatch = url.pathname.match(/^\/v1\/mailboxes\/([^/]+)\/messages\/(\d+)\/flags$/);
      if (flagMatch && request.method === "PATCH") {
        const mailbox = validMailbox(decodeURIComponent(flagMatch[1]));
        const uid = validUid(flagMatch[2]);
        const input = await body(request);
        const flags = Array.isArray(input.flags) ? input.flags.map(String) : null;
        if (!flags) throw new AppError("INVALID_PARAMS", "flags must be an array.", "flags");
        await withImap(runtime, username, password, (imap) => imap.storeFlags(mailbox, uid, flags));
        runtime.events?.publish({ object: "event", id: `evt_${crypto.randomUUID().replaceAll("-", "")}`, type: "message.updated", created_at: new Date().toISOString(), data: { session_id: identity.claims.sid, mailbox, uid, flags } });
        return json({ object: "message", id: `${mailbox}:${uid}`, mailbox, uid, flags }, 200, headers);
      }
      const actionMatch = url.pathname.match(/^\/v1\/mailboxes\/([^/]+)\/messages\/(\d+)\/(move|copy)$/);
      if (actionMatch && request.method === "POST") {
        const mailbox = validMailbox(decodeURIComponent(actionMatch[1]));
        const uid = validUid(actionMatch[2]);
        const input = await body(request);
        const destination = validMailbox(String(input.destination || ""));
        await withImap(runtime, username, password, (imap) => actionMatch[3] === "move" ? imap.move(mailbox, uid, destination) : imap.copy(mailbox, uid, destination));
        return json({ object: "message_action", action: actionMatch[3], mailbox, uid, destination }, 202, headers);
      }
      if (url.pathname === "/v1/messages/send" && request.method === "POST") {
        const idempotencyKey = request.headers.get("idempotency-key")?.trim() || null;
        if (idempotencyKey && (idempotencyKey.length > 255 || /[\r\n]/.test(idempotencyKey))) {
          throw new AppError("INVALID_PARAMS", "Idempotency-Key is invalid.", "Idempotency-Key");
        }
        const cached = idempotencyKey ? identity.record.idempotency?.[idempotencyKey] : undefined;
        if (cached && cached.expiresAt > Date.now()) return json(cached.body, cached.status, headers);
        const input = await body(request);
        const from = validAddress(String(input.from || username), "from");
        const recipients = Array.isArray(input.recipients)
          ? input.recipients.map(String).filter(Boolean).map((value) => validAddress(value, "recipients"))
          : [];
        if (!recipients.length) throw new AppError("INVALID_PARAMS", "At least one recipient is required.", "recipients");
        if (recipients.length > runtime.config.maxRecipients) throw new AppError("TOO_MANY_RECIPIENTS", "The recipient limit was exceeded.", "recipients");
        const raw = String(input.raw || "");
        if (!raw) throw new AppError("INVALID_PARAMS", "raw is required.", "raw");
        const message = base64Bytes(raw);
        if (message.byteLength > runtime.config.maxMessageBytes) throw new AppError("MESSAGE_TOO_LARGE", "The message exceeds the configured size limit.", "raw");
        const transport = await runtime.connectSmtp();
        try {
          await new SmtpClient(transport).start(username, password, from, recipients, message);
        } finally {
          await Promise.resolve(transport.close()).catch(() => undefined);
        }
        const result = { object: "message", sent: true } as const;
        if (idempotencyKey) {
          const entries = Object.entries(identity.record.idempotency || {})
            .filter(([, value]) => value.expiresAt > Date.now())
            .slice(-99);
          identity.record.idempotency = Object.fromEntries(entries);
          identity.record.idempotency[idempotencyKey] = { status: 202, body: result, expiresAt: Date.now() + 24 * 60 * 60 * 1000 };
          await runtime.sessions.put(identity.record);
        }
        return json(result, 202, headers);
      }
      throw new AppError("INVALID_PARAMS", "The requested endpoint does not exist.");
    } catch (error) {
      const response = problemResponse(error, request, runtime.config.problemTypeBaseUrl);
      const cors = corsHeaders(request, runtime.config.appOrigin);
      for (const [key, value] of cors) response.headers.set(key, value);
      return response;
    }
  };
}
