import type { ByteDuplex } from "../protocol/transport.ts";
import { startRawWebSocketBridge, transformCredentials } from "./websocket.ts";

function assert(
  condition: unknown,
  message = "Assertion failed",
): asserts condition {
  if (!condition) throw new Error(message);
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

class FakeSocket extends EventTarget {
  binaryType = "blob";
  readyState = WebSocket.OPEN;
  readonly sent: ArrayBuffer[] = [];
  closed = false;

  send(data: ArrayBuffer): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.readyState = WebSocket.CLOSED;
  }

  receive(data: string | ArrayBuffer): void {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
}

function upstream(
  readable: ReadableStream<Uint8Array>,
  writes: Uint8Array[],
  closed: { value: boolean },
): ByteDuplex {
  return {
    readable,
    writable: new WritableStream<Uint8Array>({
      write: (chunk) => {
        writes.push(chunk.slice());
      },
    }),
    close: () => {
      closed.value = true;
    },
  };
}

Deno.test("raw bridge starts after accept without waiting for an open event", async () => {
  const socket = new FakeSocket();
  const gate = deferred<ByteDuplex>();
  const writes: Uint8Array[] = [];
  const closed = { value: false };
  let connects = 0;
  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("* OK ready\r\n"));
      controller.close();
    },
  });

  startRawWebSocketBridge(socket as unknown as WebSocket, async () => {
    connects += 1;
    return gate.promise;
  });
  socket.receive("A001 NOOP\r\n");
  assert(connects === 1, "the upstream connection should start immediately");

  gate.resolve(upstream(readable, writes, closed));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert(
    socket.sent.length === 1,
    "the upstream greeting should reach the client",
  );
  assert(new TextDecoder().decode(socket.sent[0]) === "* OK ready\r\n");
  assert(
    writes.length === 1,
    "the client message should be queued until upstream is ready",
  );
  assert(new TextDecoder().decode(writes[0]) === "A001 NOOP\r\n");
});

Deno.test("raw bridge replaces protocol credentials before upstream delivery", async () => {
  const transform = transformCredentials({
    username: "_webmail_backend@example.com",
    password: "server-secret",
    protocol: "imap",
  });
  const output = transform(
    new TextEncoder().encode("A001 LOGIN alice@example.com browser-secret\r\n"),
  );
  assert(
    new TextDecoder().decode(output[0]) ===
      'A001 LOGIN "_webmail_backend@example.com" "server-secret"\r\n',
  );
  const binary = new Uint8Array([0, 255, 1, 2]);
  assert(
    transform(binary)[0] === binary,
    "authenticated bytes must pass through unchanged",
  );
});

Deno.test("raw bridge preserves binary bytes after the login line", () => {
  const transform = transformCredentials({
    username: "_webmail_backend@example.com",
    password: "server-secret",
    protocol: "smtp",
  });
  const login = new TextEncoder().encode("AUTH PLAIN browser-token\r\n");
  const binary = new Uint8Array([0, 255, 1, 2, 128]);
  const frame = new Uint8Array(login.byteLength + binary.byteLength);
  frame.set(login);
  frame.set(binary, login.byteLength);
  const output = transform(frame);
  assert(output.length === 2);
  assert(new TextDecoder().decode(output[0]) ===
    "AUTH PLAIN " + btoa("\0_webmail_backend@example.com\0server-secret") +
      "\r\n");
  assert(output[1].every((value, index) => value === binary[index]));
});
