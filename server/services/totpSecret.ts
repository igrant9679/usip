/**
 * The authenticator (TOTP) secret, encrypted at rest (follow-up to the audit's
 * final pass, 2026-11-07).
 *
 * `users.mfa_totp_secret` held the base32 key in plaintext: anyone who could
 * read the users table (a backup, a leaked dump) could generate every
 * account's second factor. The final pass's C4 work encrypted mailbox
 * secrets and named this one as left. It is now written with the same
 * AES-256-GCM field encryption mailbox passwords use (encryptField), and the
 * boot pass in secretBackfill.ts encrypts the rows saved before this change.
 *
 * Reading never weakens the check: a secret that does not decrypt (a changed
 * ENCRYPTION_KEY, a damaged value) opens as null, and callers refuse the code
 * outright. Passing an empty key to the matcher instead would accept the code
 * anyone can compute from an empty HMAC key.
 */
import { decryptField, encryptField } from "../emailAdapter";
import { looksEncrypted } from "./secretBackfill";

/** The stored form of a freshly minted secret. */
export function sealTotpSecret(secretB32: string): string {
  return encryptField(secretB32);
}

/**
 * The usable base32 secret, or null when there is none or it can't be read.
 * A value saved before encryption (base32, never the iv:tag:ciphertext hex
 * shape) reads as it is until the boot pass encrypts it.
 */
export function openTotpSecret(stored: string | null | undefined): string | null {
  if (!stored) return null;
  if (!looksEncrypted(stored)) return stored.trim() || null;
  try {
    return decryptField(stored) || null;
  } catch {
    return null;
  }
}
