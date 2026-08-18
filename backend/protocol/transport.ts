export interface ByteDuplex {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  close(): Promise<void> | void;
}

export async function writeBytes(transport: ByteDuplex, bytes: Uint8Array): Promise<void> {
  const writer = transport.writable.getWriter();
  try {
    await writer.write(bytes);
  } finally {
    writer.releaseLock();
  }
}

export async function pipeDuplex(source: ByteDuplex, target: ByteDuplex): Promise<void> {
  try {
    await source.readable.pipeTo(target.writable, { preventClose: true });
  } finally {
    await target.close();
  }
}
