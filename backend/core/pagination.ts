import type { CursorPayload, ResourceList } from "../contract/api.ts";
import { AppError } from "./errors.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function encode(value: Uint8Array): string {
  let binary = "";
  value.forEach((byte) => binary += String.fromCharCode(byte));
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function decode(value: string): Uint8Array {
  try {
    const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - value.length % 4) % 4));
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    throw new AppError("INVALID_CURSOR", "The pagination cursor is invalid.");
  }
}

export function encodeCursor(payload: CursorPayload): string {
  return encode(encoder.encode(JSON.stringify(payload)));
}

export function decodeCursor(cursor: string, mailbox: string): CursorPayload {
  const payload = JSON.parse(decoder.decode(decode(cursor))) as CursorPayload;
  if (payload.version !== 1 || payload.mailbox !== mailbox || !payload.date || !Number.isInteger(payload.uid)) {
    throw new AppError("INVALID_CURSOR", "The pagination cursor is invalid.");
  }
  return payload;
}

export function listResponse<T>(data: T[], page: number, pageSize: number, nextCursor: string | null): ResourceList<T> {
  return {
    object: "list",
    data,
    has_more: nextCursor !== null,
    next_cursor: nextCursor,
    page,
    page_size: pageSize,
  };
}
