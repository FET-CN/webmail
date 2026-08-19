import type { BackendConfig } from "./config.ts";
import { AppError } from "./errors.ts";
import type { KeyValueStore } from "./session-kv.ts";

export interface OidcIdentity {
  issuer: string;
  subject: string;
  preferredUsername: string;
  email?: string;
  groups: string[];
}

interface Discovery {
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  issuer: string;
}
interface Jwk {
  kid: string;
  kty: string;
  n: string;
  e: string;
  alg?: string;
  use?: string;
}

function b64decode(value: string): Uint8Array {
  const binary = atob(
    value.replaceAll("-", "+").replaceAll("_", "/") +
      "=".repeat((4 - value.length % 4) % 4),
  );
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function parseJwt(
  token: string,
): {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  signingInput: string;
  signature: Uint8Array;
} {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new AppError(
      "AUTH_INVALID",
      "The identity provider token is invalid.",
    );
  }
  try {
    return {
      header: JSON.parse(
        new TextDecoder().decode(b64decode(parts[0])),
      ) as Record<string, unknown>,
      payload: JSON.parse(
        new TextDecoder().decode(b64decode(parts[1])),
      ) as Record<string, unknown>,
      signingInput: `${parts[0]}.${parts[1]}`,
      signature: b64decode(parts[2]),
    };
  } catch {
    throw new AppError(
      "AUTH_INVALID",
      "The identity provider token is invalid.",
    );
  }
}

async function verifyIdToken(
  token: string,
  discovery: Discovery,
  config: BackendConfig,
): Promise<Record<string, unknown>> {
  const parsed = parseJwt(token);
  if (parsed.header.alg !== "RS256" || typeof parsed.header.kid !== "string") {
    throw new AppError(
      "AUTH_INVALID",
      "The identity provider token algorithm is not allowed.",
    );
  }
  const response = await fetch(discovery.jwks_uri);
  if (!response.ok) {
    throw new AppError(
      "AUTH_INVALID",
      "The identity provider keys are unavailable.",
    );
  }
  const jwks = await response.json() as { keys?: Jwk[] };
  const jwk = jwks.keys?.find((key) =>
    key.kid === parsed.header.kid && key.kty === "RSA"
  );
  if (!jwk) {
    throw new AppError(
      "AUTH_INVALID",
      "The identity provider signing key is unknown.",
    );
  }
  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    parsed.signature,
    new TextEncoder().encode(parsed.signingInput),
  );
  if (!valid) {
    throw new AppError(
      "AUTH_INVALID",
      "The identity provider token signature is invalid.",
    );
  }
  const payload = parsed.payload;
  validateIdTokenClaims(payload, discovery.issuer, config);
  return payload;
}

/** Validates the standard ID-token claims relied on by the webmail session. */
export function validateIdTokenClaims(
  payload: Record<string, unknown>,
  discoveredIssuer: string,
  config: BackendConfig,
): void {
  const audiences = typeof payload.aud === "string"
    ? [payload.aud]
    : Array.isArray(payload.aud) && payload.aud.length > 0 &&
        payload.aud.every((audience) => typeof audience === "string")
    ? payload.aud
    : [];
  const expiration = payload.exp;
  const now = Math.floor(Date.now() / 1000);
  const isValidExpiration = typeof expiration === "number" &&
    Number.isSafeInteger(expiration) && expiration > now;
  if (
    payload.iss !== discoveredIssuer || payload.iss !== config.oidcIssuer ||
    !audiences.includes(config.oidcClientId) ||
    !isValidExpiration ||
    (audiences.length > 1 && payload.azp !== config.oidcClientId)
  ) {
    throw new AppError(
      "AUTH_INVALID",
      "The identity provider token claims are invalid.",
    );
  }
}

export class OidcService {
  private discovery?: Discovery;
  private discoveryAt = 0;
  constructor(
    private readonly config: BackendConfig,
    private readonly storage: KeyValueStore,
  ) {}

  private async metadata(): Promise<Discovery> {
    if (
      !this.config.oidcIssuer || !this.config.oidcClientId ||
      !this.config.oidcClientSecret || !this.config.oidcRedirectUri
    ) {
      throw new AppError("PROVISIONING_UNAVAILABLE", "OIDC is not configured.");
    }
    if (this.discovery && Date.now() - this.discoveryAt < 300_000) {
      return this.discovery;
    }
    const response = await fetch(
      `${
        this.config.oidcIssuer.replace(/\/$/, "")
      }/.well-known/openid-configuration`,
    );
    if (!response.ok) {
      throw new AppError(
        "AUTH_INVALID",
        "The identity provider discovery document is unavailable.",
      );
    }
    this.discovery = await response.json() as Discovery;
    this.discoveryAt = Date.now();
    return this.discovery;
  }

  async start(): Promise<string> {
    const discovery = await this.metadata();
    const state = crypto.randomUUID();
    const nonce = crypto.randomUUID();
    const verifierBytes = crypto.getRandomValues(new Uint8Array(32));
    const verifier = btoa(String.fromCharCode(...verifierBytes)).replaceAll(
      "+",
      "-",
    ).replaceAll("/", "_").replaceAll("=", "");
    await this.storage.put(
      `oidc:${state}`,
      JSON.stringify({ nonce, verifier }),
      600,
    );
    const challengeBytes = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(verifier),
    );
    let binary = "";
    new Uint8Array(challengeBytes).forEach((byte) =>
      binary += String.fromCharCode(byte)
    );
    const challenge = btoa(binary).replaceAll("+", "-").replaceAll("/", "_")
      .replaceAll("=", "");
    const params = new URLSearchParams({
      client_id: this.config.oidcClientId,
      response_type: "code",
      scope: "openid profile email groups",
      redirect_uri: this.config.oidcRedirectUri,
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    return `${discovery.authorization_endpoint}?${params}`;
  }

  async callback(code: string, state: string): Promise<OidcIdentity> {
    const stored = await this.storage.get(`oidc:${state}`);
    await this.storage.delete(`oidc:${state}`);
    if (!stored) {
      throw new AppError(
        "AUTH_INVALID",
        "The identity provider login state is invalid.",
      );
    }
    const { nonce, verifier } = JSON.parse(stored) as {
      nonce: string;
      verifier: string;
    };
    const discovery = await this.metadata();
    const response = await fetch(discovery.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: this.config.oidcRedirectUri,
        client_id: this.config.oidcClientId,
        client_secret: this.config.oidcClientSecret,
        code_verifier: verifier,
      }),
    });
    if (!response.ok) {
      throw new AppError(
        "AUTH_INVALID",
        "The identity provider rejected the authorization code.",
      );
    }
    const token = await response.json() as { id_token?: string };
    if (!token.id_token) {
      throw new AppError(
        "AUTH_INVALID",
        "The identity provider did not return an identity token.",
      );
    }
    const claims = await verifyIdToken(token.id_token, discovery, this.config);
    if (
      claims.nonce !== nonce || typeof claims.sub !== "string" ||
      typeof claims.preferred_username !== "string"
    ) {
      throw new AppError(
        "AUTH_INVALID",
        "The identity provider identity is incomplete.",
      );
    }
    const groups = Array.isArray(claims.groups)
      ? claims.groups.filter((group): group is string =>
        typeof group === "string"
      )
      : [];
    if (!groups.includes(this.config.oidcWebmailGroup)) {
      throw new AppError(
        "FORBIDDEN",
        "The identity is not allowed to use webmail.",
      );
    }
    return {
      issuer: claims.iss as string,
      subject: claims.sub,
      preferredUsername: claims.preferred_username,
      email: typeof claims.email === "string" ? claims.email : undefined,
      groups,
    };
  }
}
