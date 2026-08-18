import type { MailboxSummary, MessageSummary } from "../contract/api.ts";
import { AppError } from "../core/errors.ts";
import type { ByteDuplex } from "./transport.ts";
import { writeBytes } from "./transport.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function quote(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"`;
}

class ImapReader {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private buffer = new Uint8Array();

  constructor(readable: ReadableStream<Uint8Array>) {
    this.reader = readable.getReader();
  }

  async untilTag(tag: string, limit = 20 * 1024 * 1024): Promise<string> {
    return decoder.decode(await this.untilTagBytes(tag, limit));
  }

  async untilTagBytes(tag: string, limit = 20 * 1024 * 1024): Promise<Uint8Array> {
    while (this.buffer.byteLength < limit) {
      const text = decoder.decode(this.buffer);
      const match = text.match(new RegExp(`(?:^|\\r\\n)${tag} (OK|NO|BAD)(?:[^\\r\\n]*)\\r\\n`));
      if (match && match.index !== undefined) {
        const tagBytes = encoder.encode(`${tag} `);
        for (let index = 0; index + tagBytes.length < this.buffer.length; index++) {
          if (index > 1 && (this.buffer[index - 2] !== 13 || this.buffer[index - 1] !== 10)) continue;
          if (!tagBytes.every((byte, offset) => this.buffer[index + offset] === byte)) continue;
          const lineEnd = this.buffer.indexOf(13, index + tagBytes.length);
          if (lineEnd >= 0 && this.buffer[lineEnd + 1] === 10) {
            const end = lineEnd + 2;
            const response = this.buffer.slice(0, end);
            this.buffer = this.buffer.slice(end);
            return response;
          }
        }
      }
      const next = await this.reader.read();
      if (next.done) throw new AppError("UPSTREAM_UNAVAILABLE", "The IMAP connection closed unexpectedly.");
      const combined = new Uint8Array(this.buffer.byteLength + next.value.byteLength);
      combined.set(this.buffer);
      combined.set(next.value, this.buffer.byteLength);
      this.buffer = combined;
    }
    throw new AppError("UPSTREAM_UNAVAILABLE", "The IMAP response exceeded the configured limit.");
  }

  async greeting(): Promise<string> {
    while (true) {
      const next = await this.reader.read();
      if (next.done) throw new AppError("UPSTREAM_UNAVAILABLE", "The IMAP connection closed unexpectedly.");
      const combined = new Uint8Array(this.buffer.byteLength + next.value.byteLength);
      combined.set(this.buffer);
      combined.set(next.value, this.buffer.byteLength);
      this.buffer = combined;
      const text = decoder.decode(this.buffer);
      if (/^\* (OK|PREAUTH) .*\r\n/m.test(text)) return text;
      if (/^\* (NO|BAD) /m.test(text)) throw new AppError("UPSTREAM_AUTH_FAILED", "The IMAP server rejected the connection.");
    }
  }
}

export class ImapClient {
  private readonly reader: ImapReader;
  private tagNumber = 0;

  constructor(private readonly transport: ByteDuplex) {
    this.reader = new ImapReader(transport.readable);
  }

  async start(): Promise<void> {
    await this.reader.greeting();
  }

  async command(command: string): Promise<string> {
    return decoder.decode(await this.commandBytes(command));
  }

  private async commandBytes(command: string): Promise<Uint8Array> {
    const tag = `M${String(++this.tagNumber).padStart(4, "0")}`;
    await writeBytes(this.transport, encoder.encode(`${tag} ${command}\r\n`));
    const response = await this.reader.untilTagBytes(tag);
    const responseText = decoder.decode(response);
    const result = responseText.match(new RegExp(`(?:^|\\r\\n)${tag} (OK|NO|BAD)(?: ([^\\r\\n]*))?`));
    if (!result || result[1] !== "OK") throw new AppError("UPSTREAM_UNAVAILABLE", "The IMAP command failed.");
    return response;
  }

  async login(username: string, password: string): Promise<void> {
    try {
      await this.command(`LOGIN ${quote(username)} ${quote(password)}`);
    } catch (error) {
      if (error instanceof AppError) throw new AppError("UPSTREAM_AUTH_FAILED", "Migadu rejected the mailbox credentials.", undefined, error);
      throw error;
    }
  }

  async listMailboxes(): Promise<MailboxSummary[]> {
    const response = await this.command(`LIST "" "*"`);
    const mailboxes: MailboxSummary[] = [];
    for (const line of response.split("\r\n")) {
      const match = line.match(/^\* LIST \(([^)]*)\) (?:"([^"]*)"|NIL) (?:"([^"]*)"|NIL)$/);
      if (!match) continue;
      const [, flagText, delimiter = "/", name = ""] = match;
      mailboxes.push({ object: "mailbox", id: name, name, flags: flagText.split(" ").filter(Boolean), delimiter });
    }
    return mailboxes;
  }

  async select(mailbox: string): Promise<{ exists: number; unseen?: number }> {
    const response = await this.command(`SELECT ${quote(mailbox)}`);
    const exists = Number(response.match(/^\* (\d+) EXISTS/m)?.[1] || 0);
    const unseen = response.match(/^\* OK \[UNSEEN (\d+)\]/m)?.[1];
    return { exists, ...(unseen ? { unseen: Number(unseen) } : {}) };
  }

  async fetchSummaries(mailbox: string, limit: number, beforeUid?: number): Promise<MessageSummary[]> {
    await this.select(mailbox);
    const search = await this.command("UID SEARCH ALL");
    const uids = (search.match(/^\\* SEARCH(?: (.*))?$/m)?.[1] || "").split(" ")
      .map(Number).filter((uid) => Number.isSafeInteger(uid) && uid > 0 && (!beforeUid || uid < beforeUid));
    const selected = uids.sort((a, b) => a - b).slice(-(limit + 1));
    if (!selected.length) return [];
    const response = await this.command(`UID FETCH ${selected.join(",")} (UID FLAGS RFC822.SIZE BODY.PEEK[HEADER.FIELDS (DATE SUBJECT FROM TO)])`);
    const summaries: MessageSummary[] = [];
    for (const line of response.split("\r\n")) {
      const match = line.match(/^\* \d+ FETCH \(.*?UID (\d+).*?FLAGS \(([^)]*)\).*?(?:RFC822\.SIZE (\d+))?/);
      if (!match) continue;
      summaries.push({ object: "message_summary", id: `${mailbox}:${match[1]}`, mailbox, uid: Number(match[1]), flags: match[2].split(" ").filter(Boolean), ...(match[3] ? { size: Number(match[3]) } : {}) });
    }
    return summaries.sort((a, b) => b.uid - a.uid).slice(0, limit);
  }

  async fetchMessage(mailbox: string, uid: number): Promise<MessageSummary & { raw: Uint8Array }> {
    await this.select(mailbox);
    const response = await this.commandBytes(`UID FETCH ${uid} (UID FLAGS RFC822.SIZE BODY.PEEK[])`);
    const responseText = decoder.decode(response);
    const summary = this.fetchSummary(responseText, mailbox, uid);
    const marker = responseText.indexOf("BODY.PEEK[]");
    const literalStart = marker >= 0 ? responseText.indexOf("\r\n", marker) + 2 : -1;
    const literalLength = marker >= 0 ? Number(responseText.slice(responseText.indexOf("{", marker) + 1, responseText.indexOf("}", marker))) : 0;
    const raw = literalStart >= 0 && Number.isSafeInteger(literalLength) ? response.slice(encoder.encode(responseText.slice(0, literalStart)).byteLength, encoder.encode(responseText.slice(0, literalStart)).byteLength + literalLength) : response;
    return { ...summary, raw };
  }

  async storeFlags(mailbox: string, uid: number, flags: string[]): Promise<void> {
    await this.select(mailbox);
    if (flags.some((flag) => !/^(?:\\\\[A-Za-z]+|[A-Za-z0-9][A-Za-z0-9_.-]*)$/.test(flag))) {
      throw new AppError("INVALID_PARAMS", "The IMAP flag is invalid.", "flags");
    }
    await this.command(`UID STORE ${uid} FLAGS (${flags.join(" ")})`);
  }

  async copy(mailbox: string, uid: number, destination: string): Promise<void> {
    await this.select(mailbox);
    await this.command(`UID COPY ${uid} ${quote(destination)}`);
  }

  async move(mailbox: string, uid: number, destination: string): Promise<void> {
    await this.select(mailbox);
    try {
      await this.command(`UID MOVE ${uid} ${quote(destination)}`);
    } catch (error) {
      if (error instanceof AppError) {
        await this.copy(mailbox, uid, destination);
        await this.command(`UID STORE ${uid} +FLAGS (\\Deleted)`);
        await this.command("EXPUNGE");
        return;
      }
      throw error;
    }
  }

  async createMailbox(name: string): Promise<void> {
    await this.command(`CREATE ${quote(name)}`);
  }

  async renameMailbox(name: string, destination: string): Promise<void> {
    await this.command(`RENAME ${quote(name)} ${quote(destination)}`);
  }

  async deleteMailbox(name: string): Promise<void> {
    await this.command(`DELETE ${quote(name)}`);
  }

  private fetchSummary(response: string, mailbox: string, uid: number): MessageSummary {
    const match = response.match(/FLAGS \(([^)]*)\)/);
    const size = response.match(/RFC822\.SIZE (\d+)/)?.[1];
    return {
      object: "message_summary",
      id: `${mailbox}:${uid}`,
      mailbox,
      uid,
      flags: match?.[1]?.split(" ").filter(Boolean) || [],
      ...(size ? { size: Number(size) } : {}),
    };
  }

  async logout(): Promise<void> {
    try {
      await this.command("LOGOUT");
    } finally {
      await this.transport.close();
    }
  }
}
