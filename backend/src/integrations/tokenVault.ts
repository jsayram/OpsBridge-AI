// AES-256-GCM over a provider token bundle. The key is a Worker secret, so a database dump alone
// doesn't reveal a token, and the additional data binds a ciphertext to its workspace and row.
const decodeKey = (b64: string) => {
  const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)) as Uint8Array<ArrayBuffer>;
  if (raw.length !== 32) throw new Error("TOKEN_ENCRYPTION_KEY must be 32 bytes, base64");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
};

const encoder = new TextEncoder();
const bytes = (text: string) => encoder.encode(text) as Uint8Array<ArrayBuffer>;

export async function seal(keyB64: string, plaintext: string, binding: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: bytes(binding) },
    await decodeKey(keyB64),
    bytes(plaintext),
  );
  return { ciphertext: new Uint8Array(sealed), iv };
}

export async function open(
  keyB64: string,
  ciphertext: Uint8Array,
  iv: Uint8Array,
  binding: string,
) {
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: iv as BufferSource, additionalData: bytes(binding) },
    await decodeKey(keyB64),
    ciphertext as BufferSource,
  );
  return new TextDecoder().decode(plain);
}
