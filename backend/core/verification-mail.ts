import type { MailboxCredential } from "./domain.ts";
import type { RuntimeAdapter } from "./runtime.ts";
import { SmtpClient } from "../protocol/smtp.ts";

export interface VerificationMailOptions {
  to: string;
  from: string;
  credential: MailboxCredential;
  code: string;
  expiresMinutes?: number;
}

/**
 * Builds a minimal RFC 5322 text message. The From header matches the SMTP
 * envelope sender so Migadu does not reject the delivery.
 */
export function buildVerificationMessage(
  options: VerificationMailOptions,
): Uint8Array {
  const expiresMinutes = options.expiresMinutes ?? 15;
  const body =
    `Your mailecho verification code is: ${options.code}\r\n` +
    `\r\n` +
    `This code expires in ${expiresMinutes} minutes.\r\n` +
    `If you did not request this, you can ignore this email.\r\n`;
  const headers =
    `From: <${options.from}>\r\n` +
    `To: <${options.to}>\r\n` +
    `Subject: Your mailecho mailbox verification code\r\n` +
    `Date: ${new Date().toUTCString()}\r\n` +
    `Content-Type: text/plain; charset=utf-8\r\n` +
    `\r\n`;
  return new TextEncoder().encode(headers + body);
}

/**
 * Sends a verification mail through the caller's SMTP credential without
 * writing a local-messages record.
 */
export async function sendVerificationMail(
  runtime: RuntimeAdapter,
  options: VerificationMailOptions,
): Promise<void> {
  const message = buildVerificationMessage(options);
  const transport = await runtime.connectSmtp();
  try {
    await new SmtpClient(transport).start(
      options.credential.username,
      options.credential.password,
      options.from,
      [options.to],
      message,
    );
  } finally {
    try {
      await transport.close();
    } catch {
      // The SMTP client may have already closed the connection.
    }
  }
}
