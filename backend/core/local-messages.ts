import type { KeyValueStore } from "./session-kv.ts";

export interface LocalMessageRecord {
  id: string;
  mailboxId: string;
  folder: "INBOX" | "Sent";
  raw: string;
  flags: string[];
  createdAt: string;
  from: string;
  recipients: string[];
}

export interface LocalMessageStore {
  put(message: LocalMessageRecord): Promise<void>;
  list(
    mailboxId: string,
    folder?: LocalMessageRecord["folder"],
  ): Promise<LocalMessageRecord[]>;
  get(mailboxId: string, id: string): Promise<LocalMessageRecord | null>;
  updateFlags(
    mailboxId: string,
    id: string,
    flags: string[],
  ): Promise<LocalMessageRecord | null>;
}

export class KvLocalMessageStore implements LocalMessageStore {
  constructor(private readonly storage: KeyValueStore) {}

  async put(message: LocalMessageRecord): Promise<void> {
    await this.storage.put(
      `local-message:${message.mailboxId}:${message.id}`,
      JSON.stringify(message),
      31_536_000,
    );
  }

  async list(
    mailboxId: string,
    folder?: LocalMessageRecord["folder"],
  ): Promise<LocalMessageRecord[]> {
    if (!this.storage.list) return [];
    const result: LocalMessageRecord[] = [];
    for (const key of await this.storage.list(`local-message:${mailboxId}:`)) {
      const value = await this.storage.get(key);
      if (!value) continue;
      const message = JSON.parse(value) as LocalMessageRecord;
      if (!folder || message.folder === folder) result.push(message);
    }
    return result.sort((left, right) =>
      right.createdAt.localeCompare(left.createdAt)
    );
  }

  async get(mailboxId: string, id: string): Promise<LocalMessageRecord | null> {
    const value = await this.storage.get(`local-message:${mailboxId}:${id}`);
    return value ? JSON.parse(value) as LocalMessageRecord : null;
  }

  async updateFlags(
    mailboxId: string,
    id: string,
    flags: string[],
  ): Promise<LocalMessageRecord | null> {
    const message = await this.get(mailboxId, id);
    if (!message) return null;
    message.flags = flags;
    await this.put(message);
    return message;
  }
}

export class MemoryLocalMessageStore implements LocalMessageStore {
  private readonly messages = new Map<string, LocalMessageRecord>();
  async put(message: LocalMessageRecord): Promise<void> {
    this.messages.set(`${message.mailboxId}:${message.id}`, message);
  }
  async list(
    mailboxId: string,
    folder?: LocalMessageRecord["folder"],
  ): Promise<LocalMessageRecord[]> {
    return [...this.messages.values()].filter((message) =>
      message.mailboxId === mailboxId && (!folder || message.folder === folder)
    ).sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }
  async get(mailboxId: string, id: string): Promise<LocalMessageRecord | null> {
    return this.messages.get(`${mailboxId}:${id}`) || null;
  }
  async updateFlags(
    mailboxId: string,
    id: string,
    flags: string[],
  ): Promise<LocalMessageRecord | null> {
    const message = await this.get(mailboxId, id);
    if (!message) return null;
    message.flags = flags;
    return message;
  }
}

export function localMessageId(): string {
  return `local:${crypto.randomUUID().replaceAll("-", "")}`;
}
