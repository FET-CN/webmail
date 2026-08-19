import type { KeyValueStore } from "./session-kv.ts";
import type {
  AuditEvent,
  MailboxGrant,
  MailboxRecord,
  WebmailUser,
} from "./domain.ts";

export interface DirectoryStore {
  getUser(id: string): Promise<WebmailUser | null>;
  getUserByIdentity(
    issuer: string,
    subject: string,
  ): Promise<WebmailUser | null>;
  putUser(user: WebmailUser): Promise<void>;
  getMailbox(id: string): Promise<MailboxRecord | null>;
  getMailboxByAddress(address: string): Promise<MailboxRecord | null>;
  getMailboxByInternalAddress(address: string): Promise<MailboxRecord | null>;
  listMailboxes(): Promise<MailboxRecord[]>;
  putMailbox(mailbox: MailboxRecord): Promise<void>;
  deleteMailbox(mailbox: MailboxRecord): Promise<void>;
  getGrant(userId: string, mailboxId: string): Promise<MailboxGrant | null>;
  listGrantsForUser(userId: string): Promise<MailboxGrant[]>;
  listGrantsForMailbox(mailboxId: string): Promise<MailboxGrant[]>;
  putGrant(grant: MailboxGrant): Promise<void>;
  deleteGrant(userId: string, mailboxId: string): Promise<void>;
  appendAudit(event: AuditEvent): Promise<void>;
  listAudit(): Promise<AuditEvent[]>;
}

function encode(value: string): string {
  return encodeURIComponent(value);
}

export class KvDirectoryStore implements DirectoryStore {
  constructor(private readonly storage: KeyValueStore) {}

  private async read<T>(key: string): Promise<T | null> {
    const value = await this.storage.get(key);
    return value ? JSON.parse(value) as T : null;
  }

  private async write(key: string, value: unknown): Promise<void> {
    await this.storage.put(key, JSON.stringify(value), 31_536_000);
  }

  private async keys(prefix: string): Promise<string[]> {
    if (!this.storage.list) return [];
    return this.storage.list(prefix);
  }

  async getUser(id: string): Promise<WebmailUser | null> {
    return this.read<WebmailUser>(`directory:user:${encode(id)}`);
  }

  async getUserByIdentity(
    issuer: string,
    subject: string,
  ): Promise<WebmailUser | null> {
    const id = await this.read<string>(
      `directory:user-identity:${encode(issuer)}:${encode(subject)}`,
    );
    return id ? this.getUser(id) : null;
  }

  async putUser(user: WebmailUser): Promise<void> {
    await this.write(`directory:user:${encode(user.id)}`, user);
    await this.write(
      `directory:user-identity:${encode(user.issuer)}:${encode(user.subject)}`,
      user.id,
    );
  }

  async getMailbox(id: string): Promise<MailboxRecord | null> {
    return this.read<MailboxRecord>(`directory:mailbox:${encode(id)}`);
  }

  async getMailboxByAddress(address: string): Promise<MailboxRecord | null> {
    const id = await this.read<string>(
      `directory:mailbox-address:${encode(address.toLowerCase())}`,
    );
    return id ? this.getMailbox(id) : null;
  }

  async getMailboxByInternalAddress(
    address: string,
  ): Promise<MailboxRecord | null> {
    const id = await this.read<string>(
      `directory:mailbox-internal-address:${encode(address.toLowerCase())}`,
    );
    return id ? this.getMailbox(id) : null;
  }

  async listMailboxes(): Promise<MailboxRecord[]> {
    const result: MailboxRecord[] = [];
    for (const key of await this.keys("directory:mailbox:")) {
      const mailbox = await this.read<MailboxRecord>(key);
      if (mailbox) result.push(mailbox);
    }
    return result;
  }

  async putMailbox(mailbox: MailboxRecord): Promise<void> {
    await this.write(`directory:mailbox:${encode(mailbox.id)}`, mailbox);
    await this.write(
      `directory:mailbox-address:${encode(mailbox.address.toLowerCase())}`,
      mailbox.id,
    );
    if (mailbox.internalAddress) {
      await this.write(
        `directory:mailbox-internal-address:${
          encode(mailbox.internalAddress.toLowerCase())
        }`,
        mailbox.id,
      );
    }
  }

  async deleteMailbox(mailbox: MailboxRecord): Promise<void> {
    await this.storage.delete(`directory:mailbox:${encode(mailbox.id)}`);
    await this.storage.delete(
      `directory:mailbox-address:${encode(mailbox.address.toLowerCase())}`,
    );
    if (mailbox.internalAddress) {
      await this.storage.delete(
        `directory:mailbox-internal-address:${
          encode(mailbox.internalAddress.toLowerCase())
        }`,
      );
    }
  }

  async getGrant(
    userId: string,
    mailboxId: string,
  ): Promise<MailboxGrant | null> {
    return this.read<MailboxGrant>(
      `directory:grant:${encode(userId)}:${encode(mailboxId)}`,
    );
  }

  async listGrantsForUser(userId: string): Promise<MailboxGrant[]> {
    const result: MailboxGrant[] = [];
    for (const key of await this.keys(`directory:grant:${encode(userId)}:`)) {
      const grant = await this.read<MailboxGrant>(key);
      if (grant) result.push(grant);
    }
    return result;
  }

  async listGrantsForMailbox(mailboxId: string): Promise<MailboxGrant[]> {
    const result: MailboxGrant[] = [];
    for (const key of await this.keys("directory:grant:")) {
      const grant = await this.read<MailboxGrant>(key);
      if (grant?.mailboxId === mailboxId) result.push(grant);
    }
    return result;
  }

  async putGrant(grant: MailboxGrant): Promise<void> {
    await this.write(
      `directory:grant:${encode(grant.userId)}:${encode(grant.mailboxId)}`,
      grant,
    );
  }

  async deleteGrant(userId: string, mailboxId: string): Promise<void> {
    await this.storage.delete(
      `directory:grant:${encode(userId)}:${encode(mailboxId)}`,
    );
  }

  async appendAudit(event: AuditEvent): Promise<void> {
    await this.write(
      `directory:audit:${event.createdAt}:${encode(event.id)}`,
      event,
    );
  }

  async listAudit(): Promise<AuditEvent[]> {
    const result: AuditEvent[] = [];
    for (const key of await this.keys("directory:audit:")) {
      const event = await this.read<AuditEvent>(key);
      if (event) result.push(event);
    }
    return result.sort((left, right) =>
      left.createdAt.localeCompare(right.createdAt)
    );
  }
}

export class MemoryDirectoryStore implements DirectoryStore {
  private readonly users = new Map<string, WebmailUser>();
  private readonly identities = new Map<string, string>();
  private readonly mailboxes = new Map<string, MailboxRecord>();
  private readonly addresses = new Map<string, string>();
  private readonly internalAddresses = new Map<string, string>();
  private readonly grants = new Map<string, MailboxGrant>();
  private readonly audit: AuditEvent[] = [];

  async getUser(id: string): Promise<WebmailUser | null> {
    return this.users.get(id) || null;
  }
  async getUserByIdentity(
    issuer: string,
    subject: string,
  ): Promise<WebmailUser | null> {
    const id = this.identities.get(`${issuer}\0${subject}`);
    return id ? this.getUser(id) : null;
  }
  async putUser(user: WebmailUser): Promise<void> {
    this.users.set(user.id, user);
    this.identities.set(`${user.issuer}\0${user.subject}`, user.id);
  }
  async getMailbox(id: string): Promise<MailboxRecord | null> {
    return this.mailboxes.get(id) || null;
  }
  async getMailboxByAddress(address: string): Promise<MailboxRecord | null> {
    const id = this.addresses.get(address.toLowerCase());
    return id ? this.getMailbox(id) : null;
  }
  async getMailboxByInternalAddress(
    address: string,
  ): Promise<MailboxRecord | null> {
    const id = this.internalAddresses.get(address.toLowerCase());
    return id ? this.getMailbox(id) : null;
  }
  async listMailboxes(): Promise<MailboxRecord[]> {
    return [...this.mailboxes.values()];
  }
  async putMailbox(mailbox: MailboxRecord): Promise<void> {
    this.mailboxes.set(mailbox.id, mailbox);
    this.addresses.set(mailbox.address.toLowerCase(), mailbox.id);
    if (mailbox.internalAddress) {
      this.internalAddresses.set(
        mailbox.internalAddress.toLowerCase(),
        mailbox.id,
      );
    }
  }
  async deleteMailbox(mailbox: MailboxRecord): Promise<void> {
    this.mailboxes.delete(mailbox.id);
    this.addresses.delete(mailbox.address.toLowerCase());
    if (mailbox.internalAddress) {
      this.internalAddresses.delete(mailbox.internalAddress.toLowerCase());
    }
  }
  async getGrant(
    userId: string,
    mailboxId: string,
  ): Promise<MailboxGrant | null> {
    return this.grants.get(`${userId}\0${mailboxId}`) || null;
  }
  async listGrantsForUser(userId: string): Promise<MailboxGrant[]> {
    return [...this.grants.values()].filter((grant) => grant.userId === userId);
  }
  async listGrantsForMailbox(mailboxId: string): Promise<MailboxGrant[]> {
    return [...this.grants.values()].filter((grant) =>
      grant.mailboxId === mailboxId
    );
  }
  async putGrant(grant: MailboxGrant): Promise<void> {
    this.grants.set(`${grant.userId}\0${grant.mailboxId}`, grant);
  }
  async deleteGrant(userId: string, mailboxId: string): Promise<void> {
    this.grants.delete(`${userId}\0${mailboxId}`);
  }
  async appendAudit(event: AuditEvent): Promise<void> {
    this.audit.push(event);
  }
  async listAudit(): Promise<AuditEvent[]> {
    return [...this.audit].sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt)
    );
  }
}
