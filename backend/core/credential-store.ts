import type { BackendConfig } from "./config.ts";
import { decryptJson, encryptJson } from "./crypto.ts";
import type { MailboxCredential } from "./domain.ts";
import type { KeyValueStore } from "./session-kv.ts";

export interface CredentialStore {
  get(id: string): Promise<MailboxCredential | null>;
  put(credential: MailboxCredential): Promise<void>;
  delete(id: string): Promise<void>;
}

export class EncryptedCredentialStore implements CredentialStore {
  constructor(
    private readonly storage: KeyValueStore,
    private readonly config: BackendConfig,
  ) {}

  async get(id: string): Promise<MailboxCredential | null> {
    const value = await this.storage.get(`credential:${id}`);
    if (!value) return null;
    try {
      return await decryptJson<MailboxCredential>(
        value,
        this.config.credentialEncryptionKey,
      );
    } catch {
      await this.delete(id);
      return null;
    }
  }

  async put(credential: MailboxCredential): Promise<void> {
    await this.storage.put(
      `credential:${credential.id}`,
      await encryptJson(credential, this.config.credentialEncryptionKey),
      31_536_000,
    );
  }

  async delete(id: string): Promise<void> {
    await this.storage.delete(`credential:${id}`);
  }
}
