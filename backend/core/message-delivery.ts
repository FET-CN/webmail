import { AppError } from "./errors.ts";
import { localMessageId, type LocalMessageRecord } from "./local-messages.ts";
import type { MailboxCredential, MailboxRecord } from "./domain.ts";
import type { RuntimeAdapter } from "./runtime.ts";
import { SmtpClient } from "../protocol/smtp.ts";

function base64Text(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function addressDomain(address: string): string {
  return address.slice(address.lastIndexOf("@") + 1).toLowerCase();
}

function headerBoundary(message: Uint8Array): number {
  for (let index = 0; index < message.length - 1; index++) {
    if (message[index] === 0x0a && message[index + 1] === 0x0a) {
      return index + 2;
    }
    if (
      message[index] === 0x0d && message[index + 1] === 0x0a &&
      message[index + 2] === 0x0d && message[index + 3] === 0x0a
    ) {
      return index + 4;
    }
  }
  return -1;
}

function messageHeaders(
  message: Uint8Array,
  boundary: number,
): Map<string, string[]> {
  const headerText = new TextDecoder().decode(message.slice(0, boundary))
    .replace(/\r?\n\r?\n$/, "");
  const headers = new Map<string, string[]>();
  let currentName: string | null = null;

  for (const line of headerText.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && currentName) {
      const values = headers.get(currentName)!;
      values[values.length - 1] += ` ${line.trim()}`;
      continue;
    }
    const separator = line.indexOf(":");
    if (separator < 1) {
      currentName = null;
      continue;
    }
    currentName = line.slice(0, separator).toLowerCase();
    const values = headers.get(currentName) || [];
    values.push(line.slice(separator + 1).trim());
    headers.set(currentName, values);
  }
  return headers;
}

function headerAddresses(value: string): string[] {
  const addresses = value.match(
    /[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+/gi,
  );
  return addresses || [];
}

function hasInternalDomain(value: string, internalDomain: string): boolean {
  if (!internalDomain) return false;
  const escapedDomain = internalDomain.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`@${escapedDomain}(?=$|[\\s>,;])`, "i").test(value);
}

function stripBlindCopyHeaders(
  message: Uint8Array,
  boundary: number,
): Uint8Array {
  const headerText = new TextDecoder().decode(message.slice(0, boundary));
  const separator = headerText.match(/\r?\n\r?\n$/)?.[0];
  if (!separator) return message;
  const lines = headerText.slice(0, -separator.length).split(/\r?\n/);
  const retained: string[] = [];
  let omitCurrentHeader = false;
  let removed = false;

  for (const line of lines) {
    if (/^[ \t]/.test(line)) {
      if (!omitCurrentHeader) retained.push(line);
      continue;
    }
    const name = line.slice(0, line.indexOf(":")).toLowerCase();
    omitCurrentHeader = name === "bcc" || name === "resent-bcc";
    if (omitCurrentHeader) {
      removed = true;
    } else {
      retained.push(line);
    }
  }
  if (!removed) return message;

  const headers = new TextEncoder().encode(`${retained.join("\r\n")}\r\n\r\n`);
  const result = new Uint8Array(
    headers.byteLength + message.byteLength - boundary,
  );
  result.set(headers);
  result.set(message.slice(boundary), headers.byteLength);
  return result;
}

/**
 * Verifies that the user-visible MIME sender cannot diverge from the selected
 * mailbox address, keeps internal addresses out of Migadu-bound headers, and
 * removes Bcc fields from recipient copies without changing message body bytes.
 */
function messageForDelivery(
  message: Uint8Array,
  from: string,
  internalDomain: string,
  externalDelivery: boolean,
): Uint8Array {
  const boundary = headerBoundary(message);
  if (boundary < 0) {
    throw new AppError(
      "INVALID_PARAMS",
      "The raw message must include MIME headers.",
      "raw",
    );
  }
  const headers = messageHeaders(message, boundary);
  const fromAddresses = (headers.get("from") || []).flatMap(headerAddresses);
  if (
    fromAddresses.length !== 1 ||
    fromAddresses[0].toLowerCase() !== from.toLowerCase()
  ) {
    throw new AppError(
      "INVALID_PARAMS",
      "The raw From header must match the selected sender.",
      "raw",
    );
  }
  if (externalDelivery) {
    const internalAddress = [...headers.values()].some((values) =>
      values.some((value) => hasInternalDomain(value, internalDomain))
    );
    if (internalAddress) {
      throw new AppError(
        "INVALID_PARAMS",
        "A message sent through Migadu cannot contain internal addresses.",
        "raw",
      );
    }
  }
  return stripBlindCopyHeaders(message, boundary);
}

export function allowedSender(mailbox: MailboxRecord, from: string): boolean {
  return [mailbox.address, mailbox.internalAddress]
    .filter((address): address is string => Boolean(address))
    .some((address) => address.toLowerCase() === from.toLowerCase());
}

/**
 * Routes only the configured internal suffix locally. Unknown internal
 * addresses fail closed instead of leaking into Migadu SMTP.
 */
export async function deliverMessage(
  runtime: RuntimeAdapter,
  sender: MailboxRecord,
  credential: MailboxCredential,
  from: string,
  recipients: string[],
  message: Uint8Array,
): Promise<{ local: number; migadu: number }> {
  const internal: Array<{ address: string; mailbox: MailboxRecord }> = [];
  const external: string[] = [];
  for (const recipient of recipients) {
    if (
      addressDomain(recipient) ===
        runtime.config.internalMailDomain.toLowerCase()
    ) {
      const mailbox = await runtime.directory.getMailboxByInternalAddress(
        recipient,
      );
      if (
        !mailbox || mailbox.state !== "active" ||
        !mailbox.localDeliveryEnabled
      ) {
        throw new AppError(
          "MAILBOX_NOT_FOUND",
          "The internal recipient is unavailable.",
          "recipients",
        );
      }
      internal.push({ address: recipient, mailbox });
    } else {
      external.push(recipient);
    }
  }

  // The API accepts one raw MIME document. Without route-specific header
  // rewriting, a mixed envelope could expose internal recipients to Migadu.
  if (internal.length && external.length) {
    throw new AppError(
      "INVALID_PARAMS",
      "Send internal and external recipients in separate messages.",
      "recipients",
    );
  }

  const senderIsInternal = Boolean(sender.internalAddress) &&
    sender.internalAddress!.toLowerCase() === from.toLowerCase();
  if (senderIsInternal && external.length) {
    throw new AppError(
      "FORBIDDEN",
      "An internal sender can only send to internal recipients.",
      "from",
    );
  }

  const deliveryMessage = messageForDelivery(
    message,
    from,
    runtime.config.internalMailDomain,
    external.length > 0,
  );

  if (external.length) {
    const transport = await runtime.connectSmtp();
    try {
      await new SmtpClient(transport).start(
        credential.username,
        credential.password,
        from,
        external,
        deliveryMessage,
      );
      console.info("Migadu SMTP accepted outbound message.", {
        recipientCount: external.length,
      });
    } finally {
      try {
        await transport.close();
      } catch {
        // The SMTP client may have encountered a connection that is already closed.
      }
    }
  }

  const createdAt = new Date().toISOString();
  const recipientRaw = base64Text(deliveryMessage);
  const records: LocalMessageRecord[] = internal.map((recipient) => ({
    id: localMessageId(),
    mailboxId: recipient.mailbox.id,
    folder: "INBOX",
    raw: recipientRaw,
    flags: [],
    createdAt,
    from,
    recipients,
  }));
  records.push({
    id: localMessageId(),
    mailboxId: sender.id,
    folder: "Sent",
    raw: base64Text(message),
    flags: ["\\Seen"],
    createdAt,
    from,
    recipients,
  });
  for (const record of records) await runtime.localMessages.put(record);
  return { local: internal.length, migadu: external.length };
}
