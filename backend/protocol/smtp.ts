import { AppError } from "../core/errors.ts";
import type { ByteDuplex } from "./transport.ts";
import { writeBytes } from "./transport.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class SmtpClient {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private buffer = "";

  constructor(private readonly transport: ByteDuplex) {
    this.reader = transport.readable.getReader();
  }

  private async response(): Promise<string> {
    while (true) {
      const lines = this.buffer.split("\r\n");
      if (lines.length > 1 && /^\d{3}[- ]/.test(lines[0])) {
        const code = lines[0].slice(0, 3);
        const end = lines.findIndex((line, index) => index > 0 && line.startsWith(`${code} `));
        if (end >= 0) {
          const response = lines.slice(0, end + 1).join("\r\n") + "\r\n";
          this.buffer = lines.slice(end + 1).join("\r\n");
          return response;
        }
      }
      const next = await this.reader.read();
      if (next.done) throw new AppError("UPSTREAM_UNAVAILABLE", "The SMTP connection closed unexpectedly.");
      this.buffer += decoder.decode(next.value, { stream: true });
      if (this.buffer.length > 20 * 1024 * 1024) throw new AppError("UPSTREAM_UNAVAILABLE", "The SMTP response exceeded the configured limit.");
    }
  }

  private async command(command: string, expected: number | number[]): Promise<void> {
    await writeBytes(this.transport, encoder.encode(`${command}\r\n`));
    const response = await this.response();
    const expectedCodes = Array.isArray(expected) ? expected : [expected];
    if (!expectedCodes.some((code) => response.startsWith(String(code)))) {
      throw new AppError("UPSTREAM_UNAVAILABLE", "The SMTP command failed.");
    }
  }

  async start(username: string, password: string, from: string, recipients: string[], message: Uint8Array): Promise<void> {
    const greeting = await this.response();
    if (!greeting.startsWith("220")) throw new AppError("UPSTREAM_UNAVAILABLE", "The SMTP server rejected the connection.");
    await this.command("EHLO mailecho", 250);
    const auth = btoa(`\0${username}\0${password}`);
    await this.command(`AUTH PLAIN ${auth}`, 235);
    await this.command(`MAIL FROM:<${from}>`, 250);
    for (const recipient of recipients) await this.command(`RCPT TO:<${recipient}>`, 250);
    await this.command("DATA", 354);
    const body = dotStuff(message);
    await writeBytes(this.transport, body);
    const result = await this.response();
    if (!result.startsWith("250")) throw new AppError("UPSTREAM_UNAVAILABLE", "The SMTP server rejected the message.");
    await this.command("QUIT", 221);
    await this.transport.close();
  }
}

function dotStuff(message: Uint8Array): Uint8Array {
  const output: number[] = [];
  let lineStart = true;
  for (const byte of message) {
    if (lineStart && byte === 0x2e) output.push(0x2e);
    output.push(byte);
    lineStart = byte === 0x0a;
  }
  if (output.at(-1) !== 0x0a) output.push(0x0d, 0x0a);
  output.push(0x2e, 0x0d, 0x0a);
  return Uint8Array.from(output);
}
