import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Agent API keys are bearer credentials and are encrypted at the
 * application layer (AES-256-GCM via Node's built-in `crypto` — no added
 * crypto dependency) before they are ever written to Postgres. The
 * database only ever sees ciphertext; `AGENT_KEY_ENCRYPTION_KEY` (the raw
 * 32-byte key, hex-encoded) lives in env/secrets, never in the database.
 *
 * Wire format (all base64, concatenated before encoding):
 *   iv (12 bytes) || authTag (16 bytes) || ciphertext (variable)
 */
const ALGORITHM = "aes-256-gcm";
const IV_LENGTH_BYTES = 12;
const AUTH_TAG_LENGTH_BYTES = 16;
const KEY_LENGTH_BYTES = 32;

export class InvalidEncryptionKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidEncryptionKeyError";
  }
}

export class DecryptionFailedError extends Error {
  constructor() {
    // Deliberately no ciphertext/plaintext detail in the message: this
    // error can end up in logs, and a bearer credential must never appear
    // there (see also encryptAgentKey/decryptAgentKey doc comments).
    super("Failed to decrypt stored agent credential: ciphertext is malformed or was encrypted with a different key.");
    this.name = "DecryptionFailedError";
  }
}

/**
 * Parses `AGENT_KEY_ENCRYPTION_KEY` (expected: 64 lowercase/uppercase hex
 * characters, i.e. 32 raw bytes) into a Buffer. Fails closed with a
 * descriptive error rather than silently truncating/padding a
 * wrong-length key, which would otherwise produce a key that "works" but
 * is not the 256 bits of entropy the operator thinks it is.
 */
export function parseEncryptionKey(hex: string | undefined): Buffer {
  if (!hex) {
    throw new InvalidEncryptionKeyError(
      "AGENT_KEY_ENCRYPTION_KEY is required when the Postgres-backed store is active (DATABASE_URL is set).",
    );
  }
  if (!/^[0-9a-fA-F]+$/.test(hex)) {
    throw new InvalidEncryptionKeyError("AGENT_KEY_ENCRYPTION_KEY must be a hex string.");
  }
  const buf = Buffer.from(hex, "hex");
  if (buf.length !== KEY_LENGTH_BYTES) {
    throw new InvalidEncryptionKeyError(
      `AGENT_KEY_ENCRYPTION_KEY must decode to exactly ${KEY_LENGTH_BYTES} bytes (${KEY_LENGTH_BYTES * 2} hex characters) for AES-256-GCM; got ${buf.length} bytes.`,
    );
  }
  return buf;
}

/** Encrypts a plaintext Paperclip agent API key for storage. Never log the return value's input. */
export function encryptAgentKey(plaintextKey: string, key: Buffer): string {
  const iv = randomBytes(IV_LENGTH_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintextKey, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]).toString("base64");
}

/** Decrypts a value produced by `encryptAgentKey`. Throws `DecryptionFailedError` on tamper/wrong-key/malformed input. */
export function decryptAgentKey(encoded: string, key: Buffer): string {
  let raw: Buffer;
  try {
    raw = Buffer.from(encoded, "base64");
  } catch {
    throw new DecryptionFailedError();
  }
  if (raw.length < IV_LENGTH_BYTES + AUTH_TAG_LENGTH_BYTES) {
    throw new DecryptionFailedError();
  }
  const iv = raw.subarray(0, IV_LENGTH_BYTES);
  const authTag = raw.subarray(IV_LENGTH_BYTES, IV_LENGTH_BYTES + AUTH_TAG_LENGTH_BYTES);
  const ciphertext = raw.subarray(IV_LENGTH_BYTES + AUTH_TAG_LENGTH_BYTES);
  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return plaintext.toString("utf8");
  } catch {
    throw new DecryptionFailedError();
  }
}
