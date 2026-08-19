const encoder = new TextEncoder();
const decoder = new TextDecoder();

function b64(bytes: Uint8Array): string {
  let value = "";
  bytes.forEach((byte) => value += String.fromCharCode(byte));
  return btoa(value).replaceAll("+", "-").replaceAll("/", "_").replace(
    /=+$/,
    "",
  );
}

function unb64(value: string): Uint8Array {
  const binary = atob(
    value.replaceAll("-", "+").replaceAll("_", "/") +
      "=".repeat((4 - value.length % 4) % 4),
  );
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function encryptionKey(secret: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(secret));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function encryptJson(
  value: unknown,
  secret: string,
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await encryptionKey(secret),
    encoder.encode(JSON.stringify(value)),
  );
  return `${b64(iv)}.${b64(new Uint8Array(ciphertext))}`;
}

export async function decryptJson<T>(
  value: string,
  secret: string,
): Promise<T> {
  const [encodedIv, encodedCiphertext] = value.split(".");
  if (!encodedIv || !encodedCiphertext) {
    throw new Error("Invalid encrypted value");
  }
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: unb64(encodedIv) },
    await encryptionKey(secret),
    unb64(encodedCiphertext),
  );
  return JSON.parse(decoder.decode(plaintext)) as T;
}
