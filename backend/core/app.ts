import { type BackendConfig, isSecureOrigin } from "./config.ts";
import { AppError, json, problemResponse, readBearer } from "./errors.ts";
import { expandQuery } from "./expand.ts";
import { problemDocument } from "./problem-docs.ts";
import { decodeCursor, encodeCursor, listResponse } from "./pagination.ts";
import { SessionService } from "./session.ts";
import { ImapClient } from "../protocol/imap.ts";
import { PROBLEM_DEFINITIONS, type ProblemCode } from "../contract/problems.ts";
import type { MessageResource } from "../contract/api.ts";
import { OidcService } from "./oidc.ts";
import type { MailboxGrant, MailboxRecord } from "./domain.ts";
import type { LocalMessageRecord } from "./local-messages.ts";
import type { RuntimeAdapter } from "./runtime.ts";
import { authenticateRequest, refreshCookie } from "./request-auth.ts";
import { generatedLocalPart } from "./migadu.ts";
import {
  applyMailboxLifecycleAction,
  audit,
  type MailboxLifecycleAction,
  reconcileMailboxLifecycle,
  rotateMailboxCredential,
  setMailboxOperationalState,
} from "./mailbox-lifecycle.ts";
import { createManagedMailbox } from "./mailbox-access.ts";
import { allowedSender, deliverMessage } from "./message-delivery.ts";
import {
  provision,
  requireAdmin,
  requireMailboxAccess,
} from "./mailbox-access.ts";

export type { RuntimeAdapter } from "./runtime.ts";

function authCookie(
  name: string,
  value: string,
  maxAge: number,
  secure: boolean,
): string {
  return `${name}=${
    encodeURIComponent(value)
  }; Max-Age=${maxAge}; Path=/; HttpOnly;${
    secure ? " Secure;" : ""
  } SameSite=Lax`;
}

function setSessionCookies(
  headers: Headers,
  accessToken: string,
  refreshToken: string,
  config: BackendConfig,
): void {
  const secure = isSecureOrigin(config.appOrigin);
  headers.append(
    "set-cookie",
    authCookie("mailecho_access", accessToken, config.accessTtlSeconds, secure),
  );
  headers.append(
    "set-cookie",
    authCookie(
      "mailecho_refresh",
      refreshToken,
      config.refreshTtlSeconds,
      secure,
    ),
  );
}

export { authenticateRequest } from "./request-auth.ts";

async function body(request: Request): Promise<Record<string, unknown>> {
  try {
    const value = await request.json();
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error();
    }
    return value as Record<string, unknown>;
  } catch {
    throw new AppError(
      "INVALID_PARAMS",
      "The request body must be a JSON object.",
    );
  }
}

function base64Bytes(value: string): Uint8Array {
  try {
    return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
  } catch {
    throw new AppError(
      "INVALID_PARAMS",
      "The raw message must be valid base64.",
      "raw",
    );
  }
}

function base64Text(value: string | Uint8Array): string {
  const bytes = typeof value === "string"
    ? new TextEncoder().encode(value)
    : value;
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
    result[line.slice(0, separator).toLowerCase()] = line.slice(separator + 1)
      .trim();
  }
  return result;
}

function localMessageFromRecord(message: LocalMessageRecord): MessageResource {
  const raw = Uint8Array.from(
    atob(message.raw),
    (character) => character.charCodeAt(0),
  );
  const headers = messageHeaders(raw);
  const addressList = (value: string | undefined): string[] =>
    value ? value.split(",").map((item) => item.trim()).filter(Boolean) : [];
  return {
    object: "message",
    id: message.id,
    mailbox: message.folder,
    uid: 0,
    subject: headers.subject,
    from: addressList(headers.from),
    to: addressList(headers.to),
    date: headers.date || message.createdAt,
    flags: message.flags,
    size: raw.byteLength,
    raw: message.raw,
  };
}

function messageAttachments(
  raw: Uint8Array,
): Array<{ filename?: string; content_type?: string; size?: number }> {
  const headers = messageHeaders(raw);
  const contentType = headers["content-type"] || "";
  const disposition = headers["content-disposition"] || "";
  if (!/multipart\//i.test(contentType) && !/attachment/i.test(disposition)) {
    return [];
  }
  const filename = disposition.match(/filename\s*=\s*"?([^";]+)"?/i)?.[1];
  return [{
    ...(filename ? { filename } : {}),
    content_type: contentType.split(";", 1)[0] || undefined,
    size: raw.byteLength,
  }];
}

async function withImap<T>(
  runtime: RuntimeAdapter,
  username: string,
  password: string,
  action: (imap: ImapClient) => Promise<T>,
): Promise<T> {
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

function requireCookieMutationOrigin(request: Request, origin: string): void {
  if (
    !["POST", "PATCH", "DELETE"].includes(request.method) ||
    readBearer(request)
  ) {
    return;
  }
  if (request.headers.get("origin") !== origin) {
    throw new AppError(
      "FORBIDDEN",
      "Cookie-authenticated mutations must originate from the webmail app.",
    );
  }
}

function validMailbox(value: string): string {
  if (!value || value.length > 255 || /[\r\n\0]/.test(value)) {
    throw new AppError(
      "INVALID_PARAMS",
      "The mailbox name is invalid.",
      "mailbox",
    );
  }
  return value;
}

function validUid(value: string): number {
  const uid = Number(value);
  if (!Number.isSafeInteger(uid) || uid < 1) {
    throw new AppError("INVALID_PARAMS", "The message UID is invalid.", "uid");
  }
  return uid;
}

function validAddress(value: string, param: string): string {
  if (!/^[^@\s<>\r\n]+@[^@\s<>\r\n]+$/.test(value)) {
    throw new AppError(
      "INVALID_PARAMS",
      "The email address is invalid.",
      param,
    );
  }
  return value;
}

function validCredential(value: string, param: string): string {
  if (!value || /[\r\n\0]/.test(value)) {
    throw new AppError(
      "INVALID_PARAMS",
      "The credential contains an invalid control character.",
      param,
    );
  }
  return value;
}

export function createHandler(
  runtime: RuntimeAdapter,
): (request: Request) => Promise<Response> {
  const sessions = new SessionService(runtime.sessions, runtime.config);
  return async (request) => {
    const url = new URL(request.url);
    try {
      if (request.method === "OPTIONS") {
        const headers = corsHeaders(request, runtime.config.appOrigin);
        headers.set(
          "access-control-allow-methods",
          "GET,POST,PATCH,DELETE,OPTIONS",
        );
        headers.set(
          "access-control-allow-headers",
          "Authorization,Content-Type,Idempotency-Key,X-Request-Id",
        );
        headers.set("access-control-max-age", "600");
        return new Response(null, { status: 204, headers });
      }
      requireCookieMutationOrigin(request, runtime.config.appOrigin);
      if (url.pathname.startsWith("/problems/")) {
        const slug = url.pathname.slice("/problems/".length);
        const code = Object.keys(PROBLEM_DEFINITIONS).find((key) =>
          PROBLEM_DEFINITIONS[key as ProblemCode].slug === slug
        ) as ProblemCode | undefined;
        if (!code) {
          throw new AppError(
            "PROBLEM_TYPE_NOT_FOUND",
            "Problem type not found.",
          );
        }
        const accept = request.headers.get("accept") || "text/html";
        const format = accept.includes("text/markdown")
          ? "markdown"
          : accept.includes("application/json")
          ? "json"
          : "html";
        return problemDocument(code, runtime.config.problemTypeBaseUrl, format);
      }
      if (url.pathname === "/v1/session/start" && request.method === "GET") {
        const location = await new OidcService(
          runtime.config,
          runtime.oidcStorage,
        ).start();
        return new Response(null, {
          status: 302,
          headers: { location, "cache-control": "no-store" },
        });
      }
      if (url.pathname === "/v1/session/callback" && request.method === "GET") {
        const code = url.searchParams.get("code") || "";
        const state = url.searchParams.get("state") || "";
        if (!code || !state) {
          throw new AppError(
            "AUTH_INVALID",
            "The identity provider callback is incomplete.",
          );
        }
        const oidcIdentity = await new OidcService(
          runtime.config,
          runtime.oidcStorage,
        ).callback(code, state);
        const provisioned = await provision(oidcIdentity, runtime);
        const result = await sessions.create({
          userId: provisioned.user.id,
          issuer: provisioned.user.issuer,
          subject: provisioned.user.subject,
          mailboxId: provisioned.mailbox.id,
          credentialId: provisioned.credential.id,
          identityValidatedAt: Date.now(),
        });
        const headers = corsHeaders(request, runtime.config.appOrigin);
        setSessionCookies(
          headers,
          result.accessToken,
          result.refreshToken,
          runtime.config,
        );
        headers.set("location", runtime.config.appOrigin);
        return new Response(null, { status: 302, headers });
      }
      if (url.pathname === "/v1/session/refresh" && request.method === "POST") {
        const token = refreshCookie(request);
        if (!token) {
          throw new AppError("AUTH_REQUIRED", "A refresh token is required.");
        }
        const result = await sessions.refresh(token);
        const headers = corsHeaders(request, runtime.config.appOrigin);
        setSessionCookies(
          headers,
          result.accessToken,
          result.refreshToken,
          runtime.config,
        );
        return json({ object: "session", refreshed: true }, 200, headers);
      }
      if (url.pathname === "/v1/session/logout" && request.method === "POST") {
        const identity = await authenticateRequest(request, sessions);
        await sessions.logout(identity.claims.sid);
        const headers = corsHeaders(request, runtime.config.appOrigin);
        const secure = isSecureOrigin(runtime.config.appOrigin);
        headers.append(
          "set-cookie",
          authCookie("mailecho_access", "", 0, secure),
        );
        headers.append(
          "set-cookie",
          authCookie("mailecho_refresh", "", 0, secure),
        );
        return json({ object: "session", logged_out: true }, 200, headers);
      }

      const identity = await authenticateRequest(request, sessions);
      const headers = corsHeaders(request, runtime.config.appOrigin);

      if (url.pathname === "/v1/session/select" && request.method === "POST") {
        const input = await body(request);
        const mailboxId = String(input.mailbox_id || "");
        const user = await runtime.directory.getUser(identity.record.userId);
        const mailbox = await runtime.directory.getMailbox(mailboxId);
        const grant = mailbox
          ? await runtime.directory.getGrant(identity.record.userId, mailbox.id)
          : null;
        if (
          !user?.enabled ||
          !user.groups.includes(runtime.config.oidcWebmailGroup) || !mailbox ||
          mailbox.state !== "active" || !grant || !mailbox.credentialId
        ) {
          throw new AppError(
            "FORBIDDEN",
            "The user is not allowed to select this mailbox.",
            "mailbox_id",
          );
        }
        const credential = await runtime.credentials.get(mailbox.credentialId);
        if (!credential) {
          throw new AppError(
            "PROVISIONING_UNAVAILABLE",
            "The mailbox backend credential is unavailable.",
          );
        }
        identity.record.mailboxId = mailbox.id;
        identity.record.credentialId = credential.id;
        await runtime.sessions.put(identity.record);
        return json({ object: "account", ...mailbox }, 200, headers);
      }

      if (url.pathname === "/v1/me" && request.method === "GET") {
        const user = await runtime.directory.getUser(identity.record.userId);
        const grants = await runtime.directory.listGrantsForUser(
          identity.record.userId,
        );
        const mailboxes = (await Promise.all(grants.map((grant) =>
          runtime.directory.getMailbox(grant.mailboxId)
        ))).filter((mailbox): mailbox is MailboxRecord =>
          Boolean(mailbox)
        );
        return json(
          {
            object: "me",
            user,
            mailboxes,
            current_mailbox_id: identity.record.mailboxId,
            admin: Boolean(
              user?.groups.includes(runtime.config.oidcAdminGroup),
            ),
          },
          200,
          headers,
        );
      }

      if (url.pathname === "/v1/accounts" && request.method === "GET") {
        const grants = await runtime.directory.listGrantsForUser(
          identity.record.userId,
        );
        const mailboxes = (await Promise.all(grants.map((grant) =>
          runtime.directory.getMailbox(grant.mailboxId)
        ))).filter((mailbox): mailbox is MailboxRecord =>
          Boolean(mailbox)
        );
        return json(
          {
            object: "list",
            data: mailboxes.map((mailbox) => ({
              object: "account",
              ...mailbox,
            })),
            has_more: false,
            next_cursor: null,
            page: 1,
            page_size: mailboxes.length,
          },
          200,
          headers,
        );
      }

      if (url.pathname.startsWith("/v1/admin/")) {
        const admin = await requireAdmin(identity, runtime);
        await reconcileMailboxLifecycle(runtime, admin.id);
        if (
          url.pathname === "/v1/admin/mailboxes" && request.method === "GET"
        ) {
          const mailboxes = await runtime.directory.listMailboxes();
          return json(
            {
              object: "list",
              data: mailboxes,
              has_more: false,
              next_cursor: null,
              page: 1,
              page_size: mailboxes.length,
            },
            200,
            headers,
          );
        }
        if (
          url.pathname === "/v1/admin/mailboxes" && request.method === "POST"
        ) {
          const input = await body(request);
          const localPart = generatedLocalPart(String(input.local_part || ""));
          const domain = String(input.domain || runtime.config.mailDomain);
          if (!domain || localPart.includes("@")) {
            throw new AppError(
              "INVALID_PARAMS",
              "A local_part and domain are required.",
            );
          }
          const address = `${localPart}@${domain}`;
          if (await runtime.directory.getMailboxByAddress(address)) {
            throw new AppError(
              "INVALID_PARAMS",
              "The mailbox address is already assigned.",
              "local_part",
            );
          }
          const ownerUserId = String(input.owner_user_id || admin.id);
          const owner = await runtime.directory.getUser(ownerUserId);
          if (!owner) {
            throw new AppError(
              "INVALID_PARAMS",
              "The mailbox owner does not exist.",
              "owner_user_id",
            );
          }
          const { mailbox } = await createManagedMailbox(runtime, {
            localPart,
            domain,
            name: String(input.name || localPart),
            ownerUserId,
            createdBy: admin.id,
          });
          await audit(
            runtime,
            admin.id,
            "mailbox.created",
            {},
            mailbox.id,
            ownerUserId,
          );
          return json({ object: "mailbox", ...mailbox }, 201, headers);
        }
        const mailboxMatch = url.pathname.match(
          /^\/v1\/admin\/mailboxes\/([^/]+)$/,
        );
        if (mailboxMatch && request.method === "PATCH") {
          const mailbox = await runtime.directory.getMailbox(
            decodeURIComponent(mailboxMatch[1]),
          );
          if (!mailbox) {
            throw new AppError(
              "MAILBOX_NOT_FOUND",
              "The mailbox is unavailable.",
            );
          }
          const input = await body(request);
          if (typeof input.local_delivery_enabled === "boolean") {
            mailbox.localDeliveryEnabled = input.local_delivery_enabled;
          }
          if ("state" in input) {
            const state = String(input.state || "");
            if (!["active", "suspended"].includes(state)) {
              throw new AppError(
                "INVALID_PARAMS",
                "Use the schedule-delete or cancel-delete action for deletion lifecycle changes.",
                "state",
              );
            }
            setMailboxOperationalState(
              mailbox,
              state as "active" | "suspended",
            );
          }
          mailbox.updatedAt = new Date().toISOString();
          await runtime.directory.putMailbox(mailbox);
          await audit(runtime, admin.id, "mailbox.updated", {
            state: mailbox.state,
            localDeliveryEnabled: mailbox.localDeliveryEnabled,
          }, mailbox.id);
          return json({ object: "mailbox", ...mailbox }, 200, headers);
        }
        const grantsMatch = url.pathname.match(
          /^\/v1\/admin\/mailboxes\/([^/]+)\/grants$/,
        );
        if (grantsMatch && request.method === "POST") {
          const mailboxId = decodeURIComponent(grantsMatch[1]);
          const mailbox = await runtime.directory.getMailbox(mailboxId);
          if (!mailbox) {
            throw new AppError(
              "MAILBOX_NOT_FOUND",
              "The mailbox is unavailable.",
            );
          }
          const input = await body(request);
          const targetUserId = String(input.user_id || "");
          if (!await runtime.directory.getUser(targetUserId)) {
            throw new AppError(
              "INVALID_PARAMS",
              "The grant target does not exist.",
              "user_id",
            );
          }
          const role = ["member", "manager"].includes(String(input.role))
            ? String(input.role) as MailboxGrant["role"]
            : "member";
          const grant: MailboxGrant = {
            userId: targetUserId,
            mailboxId,
            role,
            createdAt: new Date().toISOString(),
            createdBy: admin.id,
          };
          await runtime.directory.putGrant(grant);
          await audit(
            runtime,
            admin.id,
            "mailbox.grant.created",
            { role },
            mailboxId,
            targetUserId,
          );
          return json({ object: "grant", ...grant }, 201, headers);
        }
        const grantDeleteMatch = url.pathname.match(
          /^\/v1\/admin\/mailboxes\/([^/]+)\/grants\/([^/]+)$/,
        );
        if (grantDeleteMatch && request.method === "DELETE") {
          const mailboxId = decodeURIComponent(grantDeleteMatch[1]);
          const targetUserId = decodeURIComponent(grantDeleteMatch[2]);
          const mailbox = await runtime.directory.getMailbox(mailboxId);
          if (!mailbox) {
            throw new AppError(
              "MAILBOX_NOT_FOUND",
              "The mailbox is unavailable.",
            );
          }
          const grant = await runtime.directory.getGrant(
            targetUserId,
            mailboxId,
          );
          if (grant?.role === "owner") {
            throw new AppError(
              "INVALID_PARAMS",
              "The mailbox owner grant cannot be removed.",
            );
          }
          await runtime.directory.deleteGrant(targetUserId, mailboxId);
          await audit(
            runtime,
            admin.id,
            "mailbox.grant.deleted",
            {},
            mailboxId,
            targetUserId,
          );
          return json({ object: "grant", deleted: true }, 200, headers);
        }
        const actionMatch = url.pathname.match(
          /^\/v1\/admin\/mailboxes\/([^/]+)\/(suspend|restore|rotate-credential|schedule-delete|cancel-delete)$/,
        );
        if (actionMatch && request.method === "POST") {
          const mailboxId = decodeURIComponent(actionMatch[1]);
          const mailbox = await runtime.directory.getMailbox(mailboxId);
          if (!mailbox) {
            throw new AppError(
              "MAILBOX_NOT_FOUND",
              "The mailbox is unavailable.",
            );
          }
          const action = actionMatch[2] as MailboxLifecycleAction;
          applyMailboxLifecycleAction(mailbox, action);
          if (action === "rotate-credential") {
            await rotateMailboxCredential(runtime, mailbox);
          }
          mailbox.updatedAt = new Date().toISOString();
          await runtime.directory.putMailbox(mailbox);
          await audit(runtime, admin.id, `mailbox.${action}`, {}, mailbox.id);
          return json({ object: "mailbox", ...mailbox }, 200, headers);
        }
        if (
          url.pathname === "/v1/admin/audit-events" && request.method === "GET"
        ) {
          const events = await runtime.directory.listAudit();
          return json(
            {
              object: "list",
              data: events,
              has_more: false,
              next_cursor: null,
              page: 1,
              page_size: events.length,
            },
            200,
            headers,
          );
        }
        throw new AppError(
          "INVALID_PARAMS",
          "The requested admin endpoint does not exist.",
        );
      }

      const access = await requireMailboxAccess(identity, runtime);
      const username = access.credential.username;
      const password = access.credential.password;

      const localMessagesMatch = url.pathname.match(
        /^\/v1\/accounts\/([^/]+)\/local-messages$/,
      );
      if (localMessagesMatch && request.method === "GET") {
        const accountId = decodeURIComponent(localMessagesMatch[1]);
        if (accountId !== identity.record.mailboxId) {
          throw new AppError(
            "FORBIDDEN",
            "The user is not allowed to access this mailbox.",
          );
        }
        const folder = url.searchParams.get("folder") as
          | LocalMessageRecord["folder"]
          | null;
        const messages = await runtime.localMessages.list(
          accountId,
          folder || undefined,
        );
        return json(
          {
            object: "list",
            data: messages.map(localMessageFromRecord),
            has_more: false,
            next_cursor: null,
            page: 1,
            page_size: messages.length,
          },
          200,
          headers,
        );
      }

      if (url.pathname === "/v1/mailboxes" && request.method === "GET") {
        const mailboxes = await withImap(
          runtime,
          username,
          password,
          (imap) => imap.listMailboxes(),
        );
        return json(
          { ...listResponse(mailboxes, 1, mailboxes.length, null) },
          200,
          headers,
        );
      }
      const mailboxMatch = url.pathname.match(
        /^\/v1\/mailboxes\/([^/]+)\/messages$/,
      );
      if (mailboxMatch && request.method === "GET") {
        const mailbox = validMailbox(decodeURIComponent(mailboxMatch[1]));
        const requestedLimit = Number(url.searchParams.get("limit") || 25);
        if (
          !Number.isSafeInteger(requestedLimit) || requestedLimit < 1 ||
          requestedLimit > 100
        ) {
          throw new AppError(
            "INVALID_PARAMS",
            "limit must be an integer between 1 and 100.",
            "limit",
          );
        }
        const limit = requestedLimit;
        const cursor = url.searchParams.get("after");
        const cursorPayload = cursor ? decodeCursor(cursor, mailbox) : null;
        const messages = await withImap(
          runtime,
          username,
          password,
          (imap) => imap.fetchSummaries(mailbox, limit + 1, cursorPayload?.uid),
        );
        const filtered = cursorPayload
          ? messages.filter((message) => message.uid < cursorPayload.uid)
          : messages;
        const data = filtered.slice(0, limit);
        const last = data.at(-1);
        const nextCursor = filtered.length > limit && last
          ? encodeCursor({
            version: 1,
            mailbox,
            date: last.date || "1970-01-01T00:00:00.000Z",
            uid: last.uid,
            page: (cursorPayload?.page || 0) + 1,
          })
          : null;
        return json(
          {
            ...listResponse(
              data,
              (cursorPayload?.page || 0) + 1,
              limit,
              nextCursor,
            ),
            ...(expandQuery(url).length ? { expand: expandQuery(url) } : {}),
          },
          200,
          headers,
        );
      }
      const messageMatch = url.pathname.match(
        /^\/v1\/mailboxes\/([^/]+)\/messages\/(\d+)$/,
      );
      if (messageMatch && request.method === "GET") {
        const mailbox = validMailbox(decodeURIComponent(messageMatch[1]));
        const uid = validUid(messageMatch[2]);
        const message = await withImap(
          runtime,
          username,
          password,
          (imap) => imap.fetchMessage(mailbox, uid),
        );
        const expansions = expandQuery(url);
        const resource: MessageResource = {
          ...message,
          object: "message",
          raw: base64Text(message.raw),
        };
        if (expansions.includes("headers")) {
          resource.headers = messageHeaders(message.raw);
        }
        if (expansions.includes("attachments")) {
          resource.attachments = messageAttachments(message.raw);
        }
        if (expansions.includes("mailbox")) {
          const mailboxes = await withImap(
            runtime,
            username,
            password,
            (imap) => imap.listMailboxes(),
          );
          const mailboxResource = mailboxes.find((item) =>
            item.name === mailbox
          );
          if (mailboxResource) resource.mailbox = mailboxResource;
        }
        return json(resource, 200, headers);
      }
      const flagMatch = url.pathname.match(
        /^\/v1\/mailboxes\/([^/]+)\/messages\/(\d+)\/flags$/,
      );
      if (flagMatch && request.method === "PATCH") {
        const mailbox = validMailbox(decodeURIComponent(flagMatch[1]));
        const uid = validUid(flagMatch[2]);
        const input = await body(request);
        const flags = Array.isArray(input.flags)
          ? input.flags.map(String)
          : null;
        if (!flags) {
          throw new AppError(
            "INVALID_PARAMS",
            "flags must be an array.",
            "flags",
          );
        }
        await withImap(
          runtime,
          username,
          password,
          (imap) => imap.storeFlags(mailbox, uid, flags),
        );
        runtime.events?.publish({
          object: "event",
          id: `evt_${crypto.randomUUID().replaceAll("-", "")}`,
          type: "message.updated",
          created_at: new Date().toISOString(),
          data: { session_id: identity.claims.sid, mailbox, uid, flags },
        });
        return json(
          { object: "message", id: `${mailbox}:${uid}`, mailbox, uid, flags },
          200,
          headers,
        );
      }
      const actionMatch = url.pathname.match(
        /^\/v1\/mailboxes\/([^/]+)\/messages\/(\d+)\/(move|copy)$/,
      );
      if (actionMatch && request.method === "POST") {
        const mailbox = validMailbox(decodeURIComponent(actionMatch[1]));
        const uid = validUid(actionMatch[2]);
        const input = await body(request);
        const destination = validMailbox(String(input.destination || ""));
        await withImap(
          runtime,
          username,
          password,
          (imap) =>
            actionMatch[3] === "move"
              ? imap.move(mailbox, uid, destination)
              : imap.copy(mailbox, uid, destination),
        );
        return json(
          {
            object: "message_action",
            action: actionMatch[3],
            mailbox,
            uid,
            destination,
          },
          202,
          headers,
        );
      }
      if (url.pathname === "/v1/messages/send" && request.method === "POST") {
        const idempotencyKey = request.headers.get("idempotency-key")?.trim() ||
          null;
        if (
          idempotencyKey &&
          (idempotencyKey.length > 255 || /[\r\n]/.test(idempotencyKey))
        ) {
          throw new AppError(
            "INVALID_PARAMS",
            "Idempotency-Key is invalid.",
            "Idempotency-Key",
          );
        }
        const cached = idempotencyKey
          ? identity.record.idempotency?.[idempotencyKey]
          : undefined;
        if (cached && cached.expiresAt > Date.now()) {
          return json(cached.body, cached.status, headers);
        }
        const input = await body(request);
        const from = validAddress(
          String(input.from || access.mailbox.address),
          "from",
        );
        if (!allowedSender(access.mailbox, from)) {
          throw new AppError(
            "FORBIDDEN",
            "The sender address is not assigned to this mailbox.",
            "from",
          );
        }
        const recipients = Array.isArray(input.recipients)
          ? input.recipients.map(String).filter(Boolean).map((value) =>
            validAddress(value, "recipients")
          )
          : [];
        if (!recipients.length) {
          throw new AppError(
            "INVALID_PARAMS",
            "At least one recipient is required.",
            "recipients",
          );
        }
        if (recipients.length > runtime.config.maxRecipients) {
          throw new AppError(
            "TOO_MANY_RECIPIENTS",
            "The recipient limit was exceeded.",
            "recipients",
          );
        }
        const raw = String(input.raw || "");
        if (!raw) {
          throw new AppError("INVALID_PARAMS", "raw is required.", "raw");
        }
        const message = base64Bytes(raw);
        if (message.byteLength > runtime.config.maxMessageBytes) {
          throw new AppError(
            "MESSAGE_TOO_LARGE",
            "The message exceeds the configured size limit.",
            "raw",
          );
        }
        const routes = await deliverMessage(
          runtime,
          access.mailbox,
          access.credential,
          from,
          recipients,
          message,
        );
        const result = {
          object: "message",
          sent: true,
          routes,
        } as const;
        if (idempotencyKey) {
          const entries = Object.entries(identity.record.idempotency || {})
            .filter(([, value]) => value.expiresAt > Date.now())
            .slice(-99);
          identity.record.idempotency = Object.fromEntries(entries);
          identity.record.idempotency[idempotencyKey] = {
            status: 202,
            body: result,
            expiresAt: Date.now() + 24 * 60 * 60 * 1000,
          };
          await runtime.sessions.put(identity.record);
        }
        return json(result, 202, headers);
      }
      throw new AppError(
        "INVALID_PARAMS",
        "The requested endpoint does not exist.",
      );
    } catch (error) {
      const response = problemResponse(
        error,
        request,
        runtime.config.problemTypeBaseUrl,
      );
      const cors = corsHeaders(request, runtime.config.appOrigin);
      for (const [key, value] of cors) response.headers.set(key, value);
      return response;
    }
  };
}
