import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import {
  DecryptionFailedError,
  InvalidEncryptionKeyError,
  decryptAgentKey,
  encryptAgentKey,
  parseEncryptionKey,
} from "../src/crypto.js";

describe("crypto", () => {
  const key = randomBytes(32);

  it("round-trips a plaintext key through encrypt/decrypt", () => {
    const plaintext = "pk_live_super_secret_paperclip_key";
    const encrypted = encryptAgentKey(plaintext, key);
    expect(encrypted).not.toContain(plaintext);
    expect(decryptAgentKey(encrypted, key)).toBe(plaintext);
  });

  it("produces different ciphertext for the same plaintext each time (random IV)", () => {
    const plaintext = "same-key-value";
    const a = encryptAgentKey(plaintext, key);
    const b = encryptAgentKey(plaintext, key);
    expect(a).not.toBe(b);
  });

  it("fails to decrypt with the wrong key", () => {
    const encrypted = encryptAgentKey("secret", key);
    const wrongKey = randomBytes(32);
    expect(() => decryptAgentKey(encrypted, wrongKey)).toThrow(DecryptionFailedError);
  });

  it("fails to decrypt tampered ciphertext", () => {
    const encrypted = encryptAgentKey("secret", key);
    const raw = Buffer.from(encrypted, "base64");
    raw[raw.length - 1] = raw[raw.length - 1]! ^ 0xff;
    expect(() => decryptAgentKey(raw.toString("base64"), key)).toThrow(DecryptionFailedError);
  });

  it("fails on malformed base64/too-short input", () => {
    expect(() => decryptAgentKey("###", key)).toThrow(DecryptionFailedError);
    expect(() => decryptAgentKey(Buffer.from("short").toString("base64"), key)).toThrow(DecryptionFailedError);
  });

  describe("parseEncryptionKey", () => {
    it("parses a valid 64-char hex string into a 32-byte buffer", () => {
      const hex = randomBytes(32).toString("hex");
      const parsed = parseEncryptionKey(hex);
      expect(parsed.length).toBe(32);
      expect(parsed.toString("hex")).toBe(hex);
    });

    it("rejects an unset key", () => {
      expect(() => parseEncryptionKey(undefined)).toThrow(InvalidEncryptionKeyError);
    });

    it("rejects non-hex input", () => {
      expect(() => parseEncryptionKey("not-hex-zzzz")).toThrow(InvalidEncryptionKeyError);
    });

    it("rejects wrong-length keys", () => {
      expect(() => parseEncryptionKey(randomBytes(16).toString("hex"))).toThrow(InvalidEncryptionKeyError);
      expect(() => parseEncryptionKey(randomBytes(64).toString("hex"))).toThrow(InvalidEncryptionKeyError);
    });
  });
});
