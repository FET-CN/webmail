import type { BackendConfig } from "./config.ts";
import { AppError } from "./errors.ts";

export interface MigaduMailbox {
  address: string;
  local_part: string;
  domain_name: string;
  name?: string;
}

export interface MigaduAdmin {
  createMailbox(
    localPart: string,
    domain: string,
    name: string,
    password: string,
  ): Promise<MigaduMailbox>;
  createBackendIdentity(
    localPart: string,
    domain: string,
    mailboxLocalPart: string,
    name: string,
  ): Promise<{ address: string; password: string }>;
  deleteMailbox(localPart: string, domain: string): Promise<void>;
  deleteBackendIdentity(
    localPart: string,
    domain: string,
    mailboxLocalPart: string,
  ): Promise<void>;
}

function randomSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll(
    "=",
    "",
  );
}

function apiCredential(config: BackendConfig): string {
  if (!config.migaduApiUser || !config.migaduApiKey) {
    throw new AppError(
      "PROVISIONING_UNAVAILABLE",
      "Migadu provisioning is not configured.",
    );
  }
  return btoa(`${config.migaduApiUser}:${config.migaduApiKey}`);
}

export class MigaduAdminClient implements MigaduAdmin {
  constructor(private readonly config: BackendConfig) {}

  private async request<T>(
    path: string,
    init: RequestInit = {},
    ignoreNotFound = false,
  ): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Basic ${apiCredential(this.config)}`);
    headers.set("content-type", "application/json");
    const response = await fetch(
      `${this.config.migaduApiBaseUrl.replace(/\/$/, "")}${path}`,
      { ...init, headers },
    );
    const text = await response.text();
    let value: unknown = null;
    try {
      value = text ? JSON.parse(text) : null;
    } catch {
      value = null;
    }
    if (!response.ok && !(ignoreNotFound && response.status === 404)) {
      const providerError = value && typeof value === "object"
        ? Object.fromEntries(
          Object.entries(value as Record<string, unknown>).filter(([key, item]) =>
            ["error", "message", "code", "detail"].includes(key) &&
            (typeof item === "string" || typeof item === "number" ||
              typeof item === "boolean")
          ),
        )
        : undefined;
      console.error("Migadu API rejected a request.", {
        path,
        method: init.method || "GET",
        status: response.status,
        ...(providerError && Object.keys(providerError).length > 0
          ? { providerError }
          : {}),
      });
      throw new AppError(
        "PROVISIONING_UNAVAILABLE",
        `Migadu rejected the mailbox operation (HTTP ${response.status}).`,
        undefined,
        { status: response.status, value },
      );
    }
    return value as T;
  }

  async createMailbox(
    localPart: string,
    domain: string,
    name: string,
    password: string,
  ): Promise<MigaduMailbox> {
    return this.request<MigaduMailbox>(
      `/domains/${encodeURIComponent(domain)}/mailboxes`,
      {
        method: "POST",
        body: JSON.stringify({ name, local_part: localPart, password }),
      },
    );
  }

  async createBackendIdentity(
    localPart: string,
    domain: string,
    mailboxLocalPart: string,
    name: string,
  ): Promise<{ address: string; password: string }> {
    const password = randomSecret();
    const result = await this.request<{ address: string }>(
      `/domains/${encodeURIComponent(domain)}/mailboxes/${
        encodeURIComponent(mailboxLocalPart)
      }/identities`,
      {
        method: "POST",
        body: JSON.stringify({
          name,
          local_part: localPart,
          password_use: "custom",
          password,
        }),
      },
    );
    return { address: result.address, password };
  }

  async deleteMailbox(localPart: string, domain: string): Promise<void> {
    await this.request(
      `/domains/${encodeURIComponent(domain)}/mailboxes/${
        encodeURIComponent(localPart)
      }`,
      { method: "DELETE" },
      true,
    );
  }

  async deleteBackendIdentity(
    localPart: string,
    domain: string,
    mailboxLocalPart: string,
  ): Promise<void> {
    await this.request(
      `/domains/${encodeURIComponent(domain)}/mailboxes/${
        encodeURIComponent(mailboxLocalPart)
      }/identities/${encodeURIComponent(localPart)}`,
      { method: "DELETE" },
      true,
    );
  }
}

export function generatedLocalPart(preferredUsername: string): string {
  const normalized = preferredUsername.toLowerCase().replace(
    /[^a-z0-9._-]+/g,
    "-",
  ).replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "").slice(0, 48);
  if (!normalized) {
    throw new AppError(
      "INVALID_PARAMS",
      "The identity cannot produce a mailbox address.",
    );
  }
  return normalized;
}

export { randomSecret };
