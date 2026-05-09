/**
 * Symmetric encryption helper for secrets stored in the database
 * (AI provider API keys, integration credentials, etc.).
 *
 * Algorithm: AES-256-GCM with a random 12-byte IV per encryption.
 * Storage format: `iv:ciphertext:authTag` (each segment hex-encoded).
 *
 * Key source: ENCRYPTION_KEY env var. Either a 64-char hex string (32 bytes)
 * or a passphrase that is hashed to 32 bytes via SHA-256. In production,
 * always provide a hex 32-byte key generated via `openssl rand -hex 32`.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";
import { ENV } from "./env";

const ALGO = "aes-256-gcm";

let cachedKey: Buffer | null = null;

function getKey(): Buffer {
  if (cachedKey) return cachedKey;
  const raw = ENV.encryptionKey;
  if (!raw) {
    throw new Error(
      "ENCRYPTION_KEY env var is not set. Generate with: openssl rand -hex 32"
    );
  }
  // Accept either a hex-encoded 32-byte key or a passphrase (hashed to 32 bytes).
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    cachedKey = Buffer.from(raw, "hex");
  } else {
    cachedKey = createHash("sha256").update(raw).digest();
  }
  return cachedKey;
}

export function encryptSecret(plaintext: string): string {
  if (plaintext === "") return "";
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, getKey(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${ct.toString("hex")}:${tag.toString("hex")}`;
}

export function decryptSecret(payload: string | null | undefined): string {
  if (!payload) return "";
  const parts = payload.split(":");
  if (parts.length !== 3) {
    throw new Error("Invalid ciphertext format");
  }
  const [ivHex, ctHex, tagHex] = parts;
  const iv = Buffer.from(ivHex, "hex");
  const ct = Buffer.from(ctHex, "hex");
  const tag = Buffer.from(tagHex, "hex");
  const decipher = createDecipheriv(ALGO, getKey(), iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString("utf8");
}

/**
 * Decrypt-or-empty: never throws, returns "" on any failure. Use when reading
 * a credential where a corrupt/missing value should fall through to env defaults
 * rather than crash a request.
 */
export function tryDecryptSecret(payload: string | null | undefined): string {
  try {
    return decryptSecret(payload);
  } catch {
    return "";
  }
}

/** Mask a secret for safe display (last 4 chars). */
export function maskSecret(plaintext: string): string {
  if (!plaintext) return "";
  if (plaintext.length <= 4) return "••••";
  return `••••${plaintext.slice(-4)}`;
}
