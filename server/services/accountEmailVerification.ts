/**
 * Email verification for self-registered accounts (audit 2026-10-20, F1).
 *
 * Register gave a session with no confirmation email, so anyone could hold an
 * account under an address that was not theirs. Sign-up no longer creates a
 * workspace for a stranger (G10, decided 2026-11-06), so a new account joins
 * only by invitation; what was left was proving the address.
 *
 *   · A stranger who registers gets a link, sent through the same system
 *     sender a password reset uses (sendSystemEmail), and a banner until they
 *     open it, with a Resend button.
 *   · An invitation's token was emailed to the address, so accepting one
 *     proves it: the account counts as verified. So does completing a
 *     password reset, and confirming a new sign-in email.
 *   · Every account from before this counts as verified (migration 0312's
 *     backfill), as does any row nobody asked to verify (invitees, SCIM,
 *     OAuth): only a token hash with no verified time means "waiting".
 *
 * Which workspace's sender carries the link: one the account belongs to (an
 * activation-link member), else the platform's own (the oldest live
 * workspace a platform owner owns). And the outbound pause is honoured: a
 * paused workspace sends no verification mail (batch rule 2026-11-07, "any
 * new send path checks the pause"), and the banner says why.
 */
import { and, asc, eq, isNull } from "drizzle-orm";
import { users, workspaceMembers, workspaces } from "../../drizzle/schema";
import { escapeHtml } from "@shared/escapeHtml";
import { hashResetToken, isResetTokenLive, newResetToken } from "./passwordReset";
import type { getDb } from "../db";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

/** A day: long enough to find the mail tomorrow morning; Resend makes a new one. */
export const EMAIL_VERIFY_TTL_MS = 24 * 60 * 60 * 1000;

/** Waiting on verification: a link was minted and has not been honoured. */
export function isEmailVerificationPending(u: { emailVerifiedAt?: unknown; emailVerifyTokenHash?: unknown } | null | undefined): boolean {
  return !!u && !u.emailVerifiedAt && !!u.emailVerifyTokenHash;
}

/** A new link's token, and the columns that record it. The raw token is only ever emailed. */
export function mintEmailVerification(nowMs = Date.now()): { token: string; columns: { emailVerifyTokenHash: string; emailVerifyExpiresAt: Date; emailVerifiedAt: null } } {
  const token = newResetToken();
  return {
    token,
    columns: { emailVerifyTokenHash: hashResetToken(token), emailVerifyExpiresAt: new Date(nowMs + EMAIL_VERIFY_TTL_MS), emailVerifiedAt: null },
  };
}

/**
 * The address is proven some other way (an invitation accepted, a password
 * reset completed, a new sign-in email confirmed). Keeps an earlier verified
 * time; clears any pending link, which has nothing left to prove.
 */
export async function markEmailVerified(db: Db, userId: number, now = new Date()): Promise<void> {
  await db.update(users).set({ emailVerifiedAt: now }).where(and(eq(users.id, userId), isNull(users.emailVerifiedAt)));
  await db.update(users).set({ emailVerifyTokenHash: null, emailVerifyExpiresAt: null }).where(eq(users.id, userId));
}

export type VerifySendResult = { sent: true } | { sent: false; reason: "no_sender" | "paused" | "failed"; message: string };

/**
 * The workspace whose system sender carries this account's link: a workspace
 * it belongs to (owned first, then highest role, then oldest, the reset
 * mail's own order), else the platform's.
 */
export async function verificationSenderWorkspace(db: Db, userId: number): Promise<number | null> {
  const { pickResetSenderWorkspace } = await import("../passwordAuth");
  const memberships = await db
    .select({
      workspaceId: workspaceMembers.workspaceId,
      role: workspaceMembers.role,
      inviteToken: workspaceMembers.inviteToken,
      deactivatedAt: workspaceMembers.deactivatedAt,
      createdAt: workspaceMembers.createdAt,
      ownerUserId: workspaces.ownerUserId,
    })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .where(eq(workspaceMembers.userId, userId));
  const own = pickResetSenderWorkspace(userId, memberships);
  if (own) return own.workspaceId;
  // The platform's sender: the oldest live workspace a platform owner owns.
  const [platform] = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .innerJoin(users, eq(users.id, workspaces.ownerUserId))
    .where(and(eq(users.role, "admin"), isNull(workspaces.archivedAt)))
    .orderBy(asc(workspaces.id))
    .limit(1);
  return platform?.id ?? null;
}

/** Email the link for `token` to the account's own address. Never throws. */
export async function sendVerificationEmail(db: Db, userId: number, token: string): Promise<VerifySendResult> {
  try {
    const [u] = await db.select({ email: users.email, name: users.name }).from(users).where(eq(users.id, userId)).limit(1);
    if (!u?.email) return { sent: false, reason: "failed", message: "This account has no email address to send to." };
    const workspaceId = await verificationSenderWorkspace(db, userId);
    if (workspaceId == null) {
      return { sent: false, reason: "no_sender", message: "Velocity has no email sender set up yet, so the link can't be sent. Ask your administrator to invite you instead: accepting an invitation confirms your address." };
    }
    const { isOutboundPaused } = await import("./outboundPause");
    if (await isOutboundPaused(workspaceId)) {
      return { sent: false, reason: "paused", message: "Email from Velocity is paused right now, so the link can't be sent. Try again later, or ask your administrator to invite you: accepting an invitation confirms your address." };
    }
    const { sendSystemEmail } = await import("../emailDelivery");
    const { appUrl } = await import("../appUrl");
    const link = appUrl(`/verify-email?token=${encodeURIComponent(token)}`);
    const who = escapeHtml(u.name?.trim() || u.email.split("@")[0]);
    const res = await sendSystemEmail(workspaceId, {
      to: u.email,
      subject: "Confirm your email for Velocity",
      // The link is the credential: the Emails page shows that one went out, never the link.
      logPreview: `Email verification link sent to ${u.email} (link withheld from the log).`,
      html: `
<div style="font-family:system-ui,Segoe UI,Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#0f172a">
  <h2 style="margin:0 0 8px;font-size:18px">Confirm your email address</h2>
  <p style="margin:0 0 16px;color:#475569;font-size:14px">Hi ${who}, someone created a Velocity account with this address. If it was you, confirm it:</p>
  <p style="margin:24px 0"><a href="${link}" style="display:inline-block;background:#0f766e;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px">Confirm my email →</a></p>
  <p style="margin:0 0 8px;color:#64748b;font-size:12px">The link works once and expires in 24 hours.</p>
  <p style="margin:0;color:#64748b;font-size:12px"><strong>If this wasn't you</strong>, ignore this email: the account stays unconfirmed.</p>
</div>`,
    });
    if (!res.ok) return { sent: false, reason: "failed", message: "We couldn't send the email just now. Try Resend in a few minutes." };
    return { sent: true };
  } catch (e) {
    console.error("[emailVerification] send failed:", e instanceof Error ? e.message : e);
    return { sent: false, reason: "failed", message: "We couldn't send the email just now. Try Resend in a few minutes." };
  }
}

/**
 * Open the link: the token's account is verified, once. A token that is
 * unknown, already used or past its day is refused alike.
 */
export async function confirmEmailVerification(db: Db, token: string, nowMs = Date.now()): Promise<{ ok: true; email: string | null } | { ok: false }> {
  if (typeof token !== "string" || token.length < 32) return { ok: false };
  const [u] = await db
    .select({ id: users.id, email: users.email, expiresAt: users.emailVerifyExpiresAt })
    .from(users)
    .where(eq(users.emailVerifyTokenHash, hashResetToken(token)))
    .limit(1);
  if (!u || !isResetTokenLive(u.expiresAt, nowMs)) return { ok: false };
  await db
    .update(users)
    .set({ emailVerifiedAt: new Date(nowMs), emailVerifyTokenHash: null, emailVerifyExpiresAt: null })
    .where(and(eq(users.id, u.id), eq(users.emailVerifyTokenHash, hashResetToken(token))));
  return { ok: true, email: u.email ?? null };
}
