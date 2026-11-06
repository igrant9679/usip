/**
 * The link that proves a new sign-in email belongs to the person asking for it
 * (audit 2026-10-20, G32).
 *
 * `profile.changeMyEmail` used to write the new address straight onto the
 * account after a password check. Whoever held a session and the password
 * could move the account to a mailbox they control, and the reset link would
 * go there from then on, with the real owner never told. Now the change waits
 * for a link sent to the NEW address, and the old one is told.
 *
 * Stateless: the token is signed, carries the account, both addresses and an
 * expiry, and is honoured only while the account still has the OLD address.
 * So it works once (the change itself retires it) and a second request makes
 * the first link stale as soon as either is used. No table needed.
 */
import { createHmac, timingSafeEqual } from "crypto";

export const EMAIL_CHANGE_TTL_MS = 24 * 60 * 60 * 1000;

export type EmailChangeClaim = { userId: number; oldEmail: string; newEmail: string; exp: number };

function secret(): string {
  const k = process.env.JWT_SECRET || process.env.ENCRYPTION_KEY || "";
  if (!k && process.env.NODE_ENV === "production") throw new Error("No server secret for email change links");
  return `email-change:${k || "dev-only"}`;
}

const sign = (payload: string) => createHmac("sha256", secret()).update(payload).digest("base64url");
const norm = (e: string) => e.trim().toLowerCase();

export function makeEmailChangeToken(c: { userId: number; oldEmail: string; newEmail: string }, nowMs = Date.now()): string {
  const payload = Buffer.from(JSON.stringify({
    u: c.userId, o: norm(c.oldEmail), n: norm(c.newEmail), x: nowMs + EMAIL_CHANGE_TTL_MS,
  }), "utf8").toString("base64url");
  return `${payload}.${sign(payload)}`;
}

/** The claim in a token, or null when it is malformed, forged or expired. */
export function readEmailChangeToken(token: string, nowMs = Date.now()): EmailChangeClaim | null {
  const [payload, sig, extra] = String(token ?? "").split(".");
  if (!payload || !sig || extra !== undefined) return null;
  const want = Buffer.from(sign(payload));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  try {
    const o = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!Number.isInteger(o.u) || typeof o.o !== "string" || typeof o.n !== "string" || typeof o.x !== "number") return null;
    if (o.x <= nowMs) return null;
    return { userId: o.u, oldEmail: o.o, newEmail: o.n, exp: o.x };
  } catch {
    return null;
  }
}
