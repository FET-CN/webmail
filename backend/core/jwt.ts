import type { BackendConfig } from "./config.ts";
import { AppError } from "./errors.ts";

type TokenType = "access" | "refresh";
export interface TokenClaims {
  iss: string;
  aud: string;
  sub: string;
  sid: string;
  iat: number;
  exp: number;
  jti: string;
  typ: TokenType;
}

const encoder = new TextEncoder();

function base64url(bytes: Uint8Array): string {
  let binary = "";
  bytes.forEach((byte) => binary += String.fromCharCode(byte));
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(
    /=+$/,
    "",
  );
}

function decodePart(value: string): Uint8Array {
  const binary = atob(
    value.replaceAll("-", "+").replaceAll("_", "/") +
      "=".repeat((4 - value.length % 4) % 4),
  );
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function cryptoBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}

async function key(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function signToken(
  subject: string,
  sessionId: string,
  type: TokenType,
  ttlSeconds: number,
  secret: string,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(
    encoder.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })),
  );
  const payload: TokenClaims = {
    iss: "mailecho",
    aud: "mailecho-web",
    sub: subject,
    sid: sessionId,
    iat: now,
    exp: now + ttlSeconds,
    jti: crypto.randomUUID(),
    typ: type,
  };
  const encodedPayload = base64url(encoder.encode(JSON.stringify(payload)));
  const input = `${header}.${encodedPayload}`;
  const signature = await crypto.subtle.sign(
    "HMAC",
    await key(secret),
    encoder.encode(input),
  );
  return `${input}.${base64url(new Uint8Array(signature))}`;
}

export async function verifyToken(
  token: string,
  expectedType: TokenType,
  secret: string,
): Promise<TokenClaims> {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) throw new Error();
    const [encodedHeader, encodedPayload, encodedSignature] = parts;
    const valid = await crypto.subtle.verify(
      "HMAC",
      await key(secret),
      cryptoBuffer(decodePart(encodedSignature)),
      encoder.encode(`${encodedHeader}.${encodedPayload}`),
    );
    if (!valid) throw new Error();
    const payload = JSON.parse(
      new TextDecoder().decode(decodePart(encodedPayload)),
    ) as TokenClaims;
    if (
      payload.iss !== "mailecho" || payload.aud !== "mailecho-web" ||
      payload.typ !== expectedType ||
      payload.exp <= Math.floor(Date.now() / 1000)
    ) {
      throw new AppError(
        "SESSION_EXPIRED",
        "The authentication session has expired.",
      );
    }
    if (
      ![payload.sub, payload.sid, payload.jti].every((value) =>
        typeof value === "string" && value.length > 0
      ) || !Number.isSafeInteger(payload.iat) ||
      !Number.isSafeInteger(payload.exp)
    ) {
      throw new Error();
    }
    return payload;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("AUTH_INVALID", "The authentication token is invalid.");
  }
}
