import { SmtpClient } from "./smtp.ts";
import type { ByteDuplex } from "./transport.ts";

function assert(
  condition: unknown,
  message = "Assertion failed",
): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("SMTP client accepts single-line and multi-line responses", async () => {
  const encoder = new TextEncoder();
  const writes: string[] = [];
  let closeCalls = 0;
  const responses = [
    "220 smtp.example.test ready\r\n",
    "250-smtp.example.test\r\n250 AUTH PLAIN\r\n",
    "235 Authentication successful\r\n",
    "250 Sender accepted\r\n",
    "250 Recipient accepted\r\n",
    "354 Send message content\r\n",
    "250 Message queued\r\n",
    "221 Bye\r\n",
  ];
  const transport: ByteDuplex = {
    readable: new ReadableStream<Uint8Array>({
      pull(controller) {
        const next = responses.shift();
        if (next === undefined) controller.close();
        else controller.enqueue(encoder.encode(next));
      },
    }),
    writable: new WritableStream<Uint8Array>({
      write(chunk) {
        writes.push(new TextDecoder().decode(chunk));
      },
    }),
    close() {
      closeCalls += 1;
    },
  };

  await new SmtpClient(transport).start(
    "backend@example.test",
    "server-secret",
    "sender@example.test",
    ["recipient@example.test"],
    encoder.encode("From: sender@example.test\r\n\r\nHello"),
  );

  assert(writes[0] === "EHLO mailecho\r\n");
  assert(writes.some((write) => write.startsWith("AUTH PLAIN ")));
  assert(writes.includes("MAIL FROM:<sender@example.test>\r\n"));
  assert(writes.includes("RCPT TO:<recipient@example.test>\r\n"));
  assert(writes.includes("QUIT\r\n"));
  assert(closeCalls === 0, "the caller must own the transport lifecycle");
});
