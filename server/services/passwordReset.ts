/**
 * Forgot-password: mint, store and redeem a reset token.
 *
 * Until migration 0142 this app had NO self-service password reset. A user who
 * had forgotten a password could only be recovered by another admin sending a
 * password-setup email, or by `profile.changeMyPassword` while already signed
 * in — so a sole owner locking themselves out had no route back in.
 *
 * The rules this file exists to hold, all of them testable without a database:
 *
 *  • The token is `crypto.randomBytes(32)`. Never Math.random — that generator's
 *    internal state is recoverable from a few outputs, which is exactly how the
 *    SCIM bearer token went wrong in `9a817b3`. `secretRandomness.test.ts`
 *    enforces this repo-wide.
 *  • Only the SHA-256 HASH is stored. A reset token is a full account takeover;
 *    a database dump must not hand one over. Deliberately unlike
 *    `workspaceMembers.inviteToken`, which is stored raw because an invite only
 *    grants what the inviter chose to give.
 *  • Tokens EXPIRE (1 hour) and are SINGLE USE — redeeming clears the columns.
 *  • The request endpoint must answer identically whether or not the address
 *    exists. Login already refuses to leak that (a constant-time dummy compare
 *    guards it); a reset form that says "no such account" would give the same
 *    answer away through the back door.
 */
import { createHash, randomBytes } from "node:crypto";

/** How long a reset link stays usable. Short: it is emailed, and it is a takeover. */
export const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;

/** A fresh reset token. Returns the RAW token — only ever sent by email. */
export function newResetToken(): string {
  return randomBytes(32).toString("hex");
}

/**
 * What gets stored. SHA-256 is right here where bcrypt would not be: the input
 * is already 256 bits of entropy, so there is nothing to brute-force and
 * nothing to salt — the slow hash exists to protect LOW-entropy secrets.
 */
export function hashResetToken(token: string): string {
  return createHash("sha256").update(String(token ?? ""), "utf8").digest("hex");
}

/** When a token minted now should stop working. */
export function resetTokenExpiry(nowMs: number): Date {
  return new Date(nowMs + RESET_TOKEN_TTL_MS);
}

/**
 * Is a stored token still redeemable?
 *
 * A NULL expiry is NOT treated as "never expires" — for an invite that reading
 * is a deliberate feature, but for a takeover token an absent expiry means the
 * row is malformed, and the safe answer to a malformed credential is no.
 */
export function isResetTokenLive(expiresAt: Date | string | null | undefined, nowMs: number): boolean {
  if (!expiresAt) return false;
  const t = new Date(expiresAt).getTime();
  if (Number.isNaN(t)) return false;
  return t > nowMs;
}

/** Password rule for the reset form — the same one registration applies. */
export function isStrongEnoughPassword(password: unknown): password is string {
  return typeof password === "string" && password.length >= 8;
}
