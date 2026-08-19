import type { ByteDuplex } from "../protocol/transport.ts";

function bytesFromMessage(data: unknown): Uint8Array | null {
  if (typeof data === "string") return new TextEncoder().encode(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      .slice();
  }
  return null;
}

function sendBytes(socket: WebSocket, chunk: Uint8Array): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  // Copy the view so Cloudflare receives an ArrayBuffer with no offset ambiguity.
  socket.send(chunk.slice().buffer);
}

/**
 * Starts the raw protocol bridge after the Worker server socket has been accepted.
 * Cloudflare does not require an `open` event for an accepted WebSocketPair server.
 */
export function startRawWebSocketBridge(
  socket: WebSocket,
  connectUpstream: () => Promise<ByteDuplex>,
): void {
  socket.binaryType = "arraybuffer";
  let upstream: ByteDuplex | undefined;
  let writer: WritableStreamDefaultWriter<Uint8Array> | undefined;
  let closed = false;
  const pending: Uint8Array[] = [];

  const closeUpstream = async (): Promise<void> => {
    writer?.releaseLock();
    writer = undefined;
    if (upstream) {
      await Promise.resolve(upstream.close()).catch(() => undefined);
    }
    upstream = undefined;
  };

  const fail = async (): Promise<void> => {
    if (socket.readyState === WebSocket.OPEN) {
      socket.close(1011, "Upstream unavailable");
    }
    await closeUpstream();
  };

  socket.addEventListener("message", (event) => {
    const bytes = bytesFromMessage(event.data);
    if (!bytes) return;
    if (!writer) {
      pending.push(bytes);
      return;
    }
    void writer.write(bytes).catch(() => fail());
  });
  socket.addEventListener("close", () => {
    closed = true;
    void closeUpstream();
  });

  void (async () => {
    try {
      upstream = await connectUpstream();
      if (closed) {
        await closeUpstream();
        return;
      }
      writer = upstream.writable.getWriter();
      for (const bytes of pending) await writer.write(bytes);
      pending.length = 0;
      await upstream.readable.pipeTo(
        new WritableStream<Uint8Array>({
          write: (chunk) => sendBytes(socket, chunk),
        }),
      );
    } catch {
      await fail();
    }
  })();
}
