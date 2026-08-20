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

export interface UpstreamCredentials {
  username: string;
  password: string;
  protocol: "imap" | "smtp";
  identityExpiresAt?: number;
}

export function transformCredentials(
  credentials: UpstreamCredentials,
): (chunk: Uint8Array) => Uint8Array[] {
  let pending: Uint8Array<ArrayBufferLike> = new Uint8Array();
  let authenticated = false;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const join = (
    left: Uint8Array<ArrayBufferLike>,
    right: Uint8Array<ArrayBufferLike>,
  ): Uint8Array<ArrayBufferLike> => {
    const result = new Uint8Array(left.byteLength + right.byteLength);
    result.set(left);
    result.set(right, left.byteLength);
    return result;
  };
  return (chunk) => {
    if (authenticated) return [chunk];
    pending = join(pending, chunk);
    const output: Uint8Array[] = [];
    while (!authenticated) {
      let end = -1;
      for (let index = 1; index < pending.length; index++) {
        if (pending[index - 1] === 13 && pending[index] === 10) {
          end = index - 1;
          break;
        }
      }
      if (end < 0) break;
      const lineBytes = pending.slice(0, end);
      const rest = pending.slice(end + 2);
      const line = decoder.decode(lineBytes);
      if (credentials.protocol === "imap" && /^\S+\s+LOGIN\s+/i.test(line)) {
        const tag = line.split(/\s+/, 1)[0];
        output.push(
          encoder.encode(
            `${tag} LOGIN "${credentials.username.replaceAll('"', "")}" "${
              credentials.password.replaceAll('"', "")
            }"\r\n`,
          ),
        );
        authenticated = true;
      } else if (
        credentials.protocol === "smtp" && /^AUTH\s+PLAIN\s+/i.test(line)
      ) {
        const auth = btoa(`\0${credentials.username}\0${credentials.password}`);
        output.push(encoder.encode(`AUTH PLAIN ${auth}\r\n`));
        authenticated = true;
      } else {
        output.push(pending.slice(0, end + 2));
      }
      pending = rest;
    }
    if (authenticated && pending.byteLength) {
      output.push(pending);
      pending = new Uint8Array();
    }
    return output;
  };
}

/**
 * Starts the raw protocol bridge after the Worker server socket has been accepted.
 * Cloudflare does not require an `open` event for an accepted WebSocketPair server.
 */
export function startRawWebSocketBridge(
  socket: WebSocket,
  connectUpstream: () => Promise<ByteDuplex>,
  credentials?: UpstreamCredentials,
): void {
  socket.binaryType = "arraybuffer";
  let upstream: ByteDuplex | undefined;
  let writer: WritableStreamDefaultWriter<Uint8Array> | undefined;
  let closed = false;
  const identityTimer = credentials?.identityExpiresAt
    ? setTimeout(
      () => socket.close(4001, "Identity session expired"),
      Math.max(0, credentials.identityExpiresAt - Date.now()),
    )
    : undefined;
  const pending: Uint8Array[] = [];
  const transform = credentials
    ? transformCredentials(credentials)
    : (chunk: Uint8Array) => [chunk];

  const closeUpstream = async (): Promise<void> => {
    // Clear shared references before awaiting close. The socket close event
    // and the readable pipe can finish concurrently, so both paths may call
    // this function for the same upstream connection.
    const activeWriter = writer;
    const activeUpstream = upstream;
    writer = undefined;
    upstream = undefined;
    activeWriter?.releaseLock();
    if (activeUpstream) {
      try {
        await activeUpstream.close();
      } catch {
        // The connection may already have been closed by its readable stream.
      }
    }
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
    for (const transformed of transform(bytes)) {
      void writer.write(transformed).catch(() => fail());
    }
  });
  socket.addEventListener("close", (event) => {
    closed = true;
    console.log("Protocol WebSocket closed.", {
      code: event.code,
      reason: event.reason || "No reason provided",
      wasClean: event.wasClean,
    });
    if (identityTimer !== undefined) clearTimeout(identityTimer);
    void closeUpstream();
  });

  void (async () => {
    try {
      upstream = await connectUpstream();
      console.log("Protocol upstream connected.");
      if (closed) {
        await closeUpstream();
        return;
      }
      writer = upstream.writable.getWriter();
      for (const bytes of pending) {
        for (const transformed of transform(bytes)) {
          await writer.write(transformed);
        }
      }
      pending.length = 0;
      await upstream.readable.pipeTo(
        new WritableStream<Uint8Array>({
          write: (chunk) => sendBytes(socket, chunk),
        }),
      );
      if (!closed && socket.readyState === WebSocket.OPEN) {
        console.warn("Protocol upstream closed the connection.");
        socket.close(1011, "Upstream disconnected");
      }
      await closeUpstream();
    } catch (error) {
      if (!closed) {
        console.error("Protocol upstream connection failed.", {
          name: error instanceof Error ? error.name : "UnknownError",
        });
      }
      await fail();
    }
  })();
}
