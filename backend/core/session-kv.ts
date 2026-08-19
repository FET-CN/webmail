import type { BackendConfig } from "./config.ts";
import { decryptJson, encryptJson } from "./crypto.ts";
import type { SessionRecord, SessionStore } from "./session.ts";

export interface KeyValueStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, ttlSeconds: number): Promise<void>;
  delete(key: string): Promise<void>;
  list?(prefix: string): Promise<string[]>;
}

export class EncryptedSessionStore implements SessionStore {
  constructor(
    private readonly storage: KeyValueStore,
    private readonly config: BackendConfig,
  ) {}

  async get(sid: string): Promise<SessionRecord | null> {
    const value = await this.storage.get(`session:${sid}`);
    if (!value) return null;
    try {
      const record = await decryptJson<SessionRecord>(
        value,
        this.config.credentialEncryptionKey,
      );
      if (record.expiresAt <= Date.now()) {
        await this.delete(sid);
        return null;
      }
      return record;
    } catch {
      await this.delete(sid);
      return null;
    }
  }

  async put(record: SessionRecord): Promise<void> {
    const ttl = Math.max(1, Math.floor((record.expiresAt - Date.now()) / 1000));
    await this.storage.put(
      `session:${record.sid}`,
      await encryptJson(record, this.config.credentialEncryptionKey),
      ttl,
    );
  }

  async delete(sid: string): Promise<void> {
    await this.storage.delete(`session:${sid}`);
  }

  async revokeFamily(family: string): Promise<void> {
    await this.storage.put(
      `revoked-family:${family}`,
      "1",
      this.config.refreshTtlSeconds,
    );
  }

  async isFamilyRevoked(family: string): Promise<boolean> {
    return await this.storage.get(`revoked-family:${family}`) !== null;
  }
}
