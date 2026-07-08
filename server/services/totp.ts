/**
 * Minimal RFC 6238 TOTP implementation (SHA-1, 6 digits, 30s steps) on plain
 * Node crypto — no external dependency. Compatible with Google Authenticator,
 * Microsoft Authenticator, 1Password, Authy, etc.
 *
 * Used by profile.startTotpEnrollment / confirmTotpEnrollment / disableTotp
 * and enforced in the password-login route for users with MFA enabled.
 */
import crypto from "crypto";

const B32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** RFC 4648 base32 (no padding) — what authenticator apps expect. */
export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const ch of clean) {
    value = (value << 5) | B32_ALPHABET.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** 20 random bytes → 32-char base32 secret. */
export function generateTotpSecret(): string {
  return base32Encode(crypto.randomBytes(20));
}

/** The 6-digit code for a given time-step counter. */
function hotp(secretB32: string, counter: number): string {
  const key = base32Decode(secretB32);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac("sha1", key).update(msg).digest();
  const offset = h[h.length - 1] & 0x0f;
  const code =
    (((h[offset] & 0x7f) << 24) | (h[offset + 1] << 16) | (h[offset + 2] << 8) | h[offset + 3]) % 1_000_000;
  return String(code).padStart(6, "0");
}

/** Verify a user-supplied code, allowing ±`window` 30s steps of clock drift. */
export function verifyTotp(secretB32: string, code: string, window = 1, nowMs = Date.now()): boolean {
  const clean = String(code).replace(/\s+/g, "");
  if (!/^\d{6}$/.test(clean)) return false;
  const counter = Math.floor(nowMs / 1000 / 30);
  for (let i = -window; i <= window; i++) {
    const expected = hotp(secretB32, counter + i);
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(clean))) return true;
  }
  return false;
}

/** otpauth:// URL for one-tap add in authenticator apps. */
export function totpAuthUrl(secretB32: string, accountEmail: string, issuer = "Velocity"): string {
  const label = encodeURIComponent(`${issuer}:${accountEmail}`);
  return `otpauth://totp/${label}?secret=${secretB32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}
