/**
 * profile.ts — self-service settings for the signed-in user.
 *
 * Today this is just the per-user email signature override; the router is
 * a natural home for future things like notification preferences or
 * timezone overrides without bloating admin/settings (which is workspace
 * scoped).
 */
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { TRPCError } from "@trpc/server";
import { getDb } from "../db";
import { users, workspaceMembers } from "../../drizzle/schema";
import { publicProcedure, router } from "../_core/trpc";
import { workspaceProcedure } from "../_core/workspace";
import { revokeAllSessions, useTotpStep } from "../_core/sessionRevocation";
import { reissueSessionCookie } from "../passwordAuth";
import { escapeHtml } from "@shared/escapeHtml";
import { isLockedOut, noteFailure, profileKey } from "../services/accountLockout";
import { makeEmailChangeToken, readEmailChangeToken } from "../services/emailChangeToken";
import { BACKUP_CODE_COUNT, backupCodesLeft, clearBackupCodes, replaceBackupCodes } from "../services/mfaBackupCodes";

/**
 * The setup key as a QR code to scan (audit 2026-10-20, U21): the dialog had
 * only the 32-character key to type and an "Open in authenticator app" link
 * that works only on the phone itself. Drawn here, as an SVG data URL, so the
 * browser bundle carries no QR library. Null if drawing fails: the key and
 * the link still work, and setup must not fail over a picture.
 */
async function totpQrDataUrl(otpauthUrl: string): Promise<string | null> {
  try {
    const QRCode = (await import("qrcode")).default;
    const svg = await QRCode.toString(otpauthUrl, { type: "svg", margin: 1, errorCorrectionLevel: "M" });
    return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
  } catch (e) {
    console.warn("[profile] TOTP QR code failed:", (e as Error).message);
    return null;
  }
}

/** Email-change requests per user per lock window; each sends two emails (G32). */
const MAX_EMAIL_CHANGE_REQUESTS = 5;
const emailChangeKey = (userId: number) => `emailchange:${userId}`;

/**
 * The signed-in user's own credential checks (current password, 2FA code)
 * share one per-account lock (audit 2026-10-20, G32), the sign-in lock's
 * sibling in services/accountLockout.ts.
 */
function assertNotLocked(userId: number): void {
  if (isLockedOut(profileKey(userId))) {
    throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: "Too many incorrect attempts. Wait 15 minutes and try again." });
  }
}

export const profileRouter = router({
  /**
   * The signed-in user's account info for the Settings → Profile page:
   * name/email/login state from users + title/role from their membership
   * in the current workspace.
   */
  getMe: workspaceProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const [u] = await db
      .select({
        name: users.name,
        email: users.email,
        loginMethod: users.loginMethod,
        passwordHash: users.passwordHash,
      })
      .from(users)
      .where(eq(users.id, ctx.user.id))
      .limit(1);
    const [m] = await db
      .select({ title: workspaceMembers.title, role: workspaceMembers.role, quota: workspaceMembers.quota })
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, ctx.workspace.id), eq(workspaceMembers.userId, ctx.user.id)))
      .limit(1);
    return {
      name: u?.name ?? "",
      email: u?.email ?? "",
      loginMethod: u?.loginMethod ?? null,
      hasPassword: !!u?.passwordHash,
      title: m?.title ?? "",
      role: m?.role ?? null,
      quota: m?.quota == null ? null : Number(m.quota),
    };
  }),

  /** Update the signed-in user's display name, member title, and (admins
   *  only) their own credit limit / quota in this workspace. */
  updateMe: workspaceProcedure
    .input(z.object({
      name: z.string().trim().min(1, "Name is required").max(120),
      title: z.string().trim().max(120).nullable().optional(),
      quota: z.number().nonnegative().max(999_999_999_999).nullable().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      await db.update(users).set({ name: input.name }).where(eq(users.id, ctx.user.id));
      const memberPatch: Record<string, unknown> = {};
      if (input.title !== undefined) {
        memberPatch.title = input.title?.trim() ? input.title.trim() : null;
      }
      if (input.quota !== undefined) {
        const [m] = await db
          .select({ role: workspaceMembers.role })
          .from(workspaceMembers)
          .where(and(eq(workspaceMembers.workspaceId, ctx.workspace.id), eq(workspaceMembers.userId, ctx.user.id)))
          .limit(1);
        if (m?.role !== "admin" && m?.role !== "super_admin") {
          throw new TRPCError({ code: "FORBIDDEN", message: "Only admins can change credit limits." });
        }
        memberPatch.quota = input.quota == null ? null : String(input.quota);
      }
      if (Object.keys(memberPatch).length > 0) {
        await db
          .update(workspaceMembers)
          .set(memberPatch)
          .where(and(eq(workspaceMembers.workspaceId, ctx.workspace.id), eq(workspaceMembers.userId, ctx.user.id)));
      }
      return { ok: true };
    }),

  /**
   * Change the signed-in user's login email. Password-verified; OAuth-only
   * accounts are refused (their email identity lives at the provider).
   *
   * Nothing changes here (audit 2026-10-20, G32): a link goes to the NEW
   * address and the change happens when it is opened (confirmEmailChange),
   * and the OLD address is told. Wrong passwords count toward the account's
   * lock, and requests are capped, since each one sends two emails.
   */
  changeMyEmail: workspaceProcedure
    .input(z.object({
      newEmail: z.string().email("Enter a valid email").max(320),
      currentPassword: z.string().min(1, "Enter your current password"),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      assertNotLocked(ctx.user.id);
      const requests = emailChangeKey(ctx.user.id);
      if (isLockedOut(requests, Date.now(), MAX_EMAIL_CHANGE_REQUESTS)) {
        throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: "You've asked to change your email several times in a short while. Wait 15 minutes and try again." });
      }
      noteFailure(requests);
      const email = input.newEmail.trim().toLowerCase();
      const [u] = await db
        .select({ passwordHash: users.passwordHash, email: users.email, name: users.name })
        .from(users)
        .where(eq(users.id, ctx.user.id))
        .limit(1);
      if (!u?.passwordHash) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Your sign-in is managed by your identity provider — the login email can't be changed here.",
        });
      }
      const ok = await bcrypt.compare(input.currentPassword, u.passwordHash);
      if (!ok) {
        noteFailure(profileKey(ctx.user.id));
        throw new TRPCError({ code: "FORBIDDEN", message: "Current password is incorrect." });
      }
      const oldEmail = (u.email ?? "").trim().toLowerCase();
      if (email === oldEmail) throw new TRPCError({ code: "BAD_REQUEST", message: "That is already your login email." });
      const [taken] = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
      if (taken && taken.id !== ctx.user.id) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "That email is already in use." });
      }
      const { sendSystemEmail } = await import("../emailDelivery");
      const { appUrl } = await import("../appUrl");
      const token = makeEmailChangeToken({ userId: ctx.user.id, oldEmail, newEmail: email });
      const link = appUrl(`/confirm-email?token=${encodeURIComponent(token)}`);
      const who = escapeHtml(u.name?.trim() || oldEmail.split("@")[0] || "there");
      const sent = await sendSystemEmail(ctx.workspace.id, {
        to: email,
        subject: "Confirm your new Velocity sign-in email",
        logPreview: `Email-change confirmation sent to ${email} (link withheld from the log).`,
        html: `
<div style="font-family:system-ui,Segoe UI,Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#0f172a">
  <h2 style="margin:0 0 8px;font-size:18px">Confirm your new sign-in email</h2>
  <p style="margin:0 0 16px;color:#475569;font-size:14px">Hi ${who}, you asked to sign in to Velocity with ${escapeHtml(email)} from now on.</p>
  <p style="margin:24px 0"><a href="${link}" style="display:inline-block;background:#0f766e;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px">Confirm this email →</a></p>
  <p style="margin:0;color:#64748b;font-size:12px">The link works once and expires in 24 hours. If you didn't ask for this, ignore this email: nothing changes.</p>
</div>`,
      });
      if (!sent.ok) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "We couldn't send the confirmation email, so your login email has not changed. Ask an admin to check the workspace's email delivery settings." });
      }
      if (oldEmail) {
        await sendSystemEmail(ctx.workspace.id, {
          to: oldEmail,
          subject: "Your Velocity sign-in email is being changed",
          html: `
<div style="font-family:system-ui,Segoe UI,Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#0f172a">
  <h2 style="margin:0 0 8px;font-size:18px">Your sign-in email is being changed</h2>
  <p style="margin:0 0 16px;color:#475569;font-size:14px">Hi ${who}, someone signed in to your Velocity account asked to change its sign-in email to ${escapeHtml(email)}. It changes only when that address confirms.</p>
  <p style="margin:0;color:#64748b;font-size:12px"><strong>If this wasn't you</strong>, change your password now and tell your workspace admin.</p>
</div>`,
        }).catch((e) => console.error("[profile.changeMyEmail] notice to the old address failed:", (e as Error).message));
      }
      return { ok: true, pending: true as const, email };
    }),

  /**
   * PUBLIC: open the link sent to the new address. The signed token is the
   * credential: it names the account and both addresses, and is honoured only
   * while the account still has the old one, so it works once.
   */
  confirmEmailChange: publicProcedure
    .input(z.object({ token: z.string().min(10).max(2000) }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const claim = readEmailChangeToken(input.token);
      if (!claim) throw new TRPCError({ code: "BAD_REQUEST", message: "This link is invalid or has expired. Ask for the change again from Settings → Profile." });
      const [u] = await db.select({ id: users.id, email: users.email }).from(users).where(eq(users.id, claim.userId)).limit(1);
      if (!u || (u.email ?? "").trim().toLowerCase() !== claim.oldEmail) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "This link has already been used, or the account's email has changed since it was sent." });
      }
      const [taken] = await db.select({ id: users.id }).from(users).where(eq(users.email, claim.newEmail)).limit(1);
      if (taken && taken.id !== u.id) throw new TRPCError({ code: "BAD_REQUEST", message: "That email is already in use." });
      await db.update(users).set({ email: claim.newEmail }).where(and(eq(users.id, u.id), eq(users.email, u.email!)));
      return { ok: true as const, email: claim.newEmail };
    }),

  /* ── Multi-factor authentication (TOTP) ─────────────────────────────────
     Real state, real enforcement: once confirmed, password logins require a
     valid authenticator code (see server/passwordAuth.ts). SMS is reported
     as unavailable — no SMS gateway is configured in Velocity. */

  /** Connection state for the Settings → Profile → MFA tab. */
  getMfaStatus: workspaceProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const [u] = await db
      .select({ enabledAt: users.mfaTotpEnabledAt })
      .from(users)
      .where(eq(users.id, ctx.user.id))
      .limit(1);
    return {
      totp: { connected: !!u?.enabledAt, enabledAt: u?.enabledAt ?? null },
      // "N codes left" on the security screen (G15). Zero for an account that
      // set up 2FA before backup codes existed: it can make a set from there.
      backupCodes: { left: u?.enabledAt ? await backupCodesLeft(db, ctx.user.id) : 0, total: BACKUP_CODE_COUNT },
      sms: { connected: false, available: false },
    };
  }),

  /**
   * Begin authenticator-app enrollment: mint a secret (stored unconfirmed)
   * and return it with the otpauth:// URL. Re-starting replaces any prior
   * unconfirmed secret; an ACTIVE enrollment must be disconnected first.
   */
  startTotpEnrollment: workspaceProcedure.mutation(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const [u] = await db
      .select({ enabledAt: users.mfaTotpEnabledAt, email: users.email, pending: users.mfaTotpSecret })
      .from(users)
      .where(eq(users.id, ctx.user.id))
      .limit(1);
    if (u?.enabledAt) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "Authenticator app is already connected — disconnect it first." });
    }
    const { generateTotpSecret, totpAuthUrl } = await import("../services/totp");
    /**
     * An unconfirmed secret is handed back, not replaced (tracker 2026-11-06,
     * item 16). The dialog starts enrolment every time it opens, and each
     * start minted a new secret: someone who added Velocity to their app,
     * closed the dialog (or was sent back to it by the 2FA requirement) and
     * opened it again was now on a different key, while the app kept the old
     * entry. Every code from that entry "didn't match", and the app ended up
     * with several entries all called Velocity. Only this user has seen the
     * pending key, and disconnecting or an admin reset clears it.
     */
    const secret = u?.pending?.trim() || generateTotpSecret();
    if (secret !== u?.pending) {
      await db.update(users).set({ mfaTotpSecret: secret, mfaTotpEnabledAt: null }).where(eq(users.id, ctx.user.id));
    }
    const otpauthUrl = totpAuthUrl(secret, u?.email ?? "account");
    return { secret, otpauthUrl, qrDataUrl: await totpQrDataUrl(otpauthUrl), reused: secret === u?.pending };
  }),

  /** Confirm enrollment with a live code from the authenticator app. */
  confirmTotpEnrollment: workspaceProcedure
    .input(z.object({ code: z.string().min(6).max(10) }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const [u] = await db
        .select({ secret: users.mfaTotpSecret, enabledAt: users.mfaTotpEnabledAt })
        .from(users)
        .where(eq(users.id, ctx.user.id))
        .limit(1);
      if (!u?.secret) throw new TRPCError({ code: "BAD_REQUEST", message: "Start enrollment first." });
      if (u.enabledAt) return { ok: true, alreadyConnected: true };
      const { matchTotpStep, totpRefusal } = await import("../services/totp");
      const step = matchTotpStep(u.secret, input.code);
      if (step === null || !(await useTotpStep(db, ctx.user.id, step))) {
        throw new TRPCError({ code: "FORBIDDEN", message: totpRefusal(step) });
      }
      await db.update(users).set({ mfaTotpEnabledAt: new Date() }).where(eq(users.id, ctx.user.id));
      // The recovery codes are made with the authenticator (G15) and returned
      // this once; the dialog shows them before it closes. This procedure is
      // one of the four the 2FA requirement exempts, so a member forced into
      // setup gets them too.
      const backupCodes = await replaceBackupCodes(db, ctx.user.id);
      // Turning on 2FA ends every other session (audit 2026-10-20): a session
      // minted before it was never asked for a code. This browser stays in.
      await revokeAllSessions(db, ctx.user.id);
      await reissueSessionCookie(db, ctx.req, ctx.res, ctx.user.id);
      return { ok: true, backupCodes };
    }),

  /** Disconnect TOTP. Requires a live code OR the account password. */
  disableTotp: workspaceProcedure
    .input(z.object({
      code: z.string().optional(),
      currentPassword: z.string().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const [u] = await db
        .select({ secret: users.mfaTotpSecret, enabledAt: users.mfaTotpEnabledAt, passwordHash: users.passwordHash })
        .from(users)
        .where(eq(users.id, ctx.user.id))
        .limit(1);
      if (!u?.enabledAt || !u.secret) {
        // Nothing active — also clear any dangling unconfirmed secret.
        await db.update(users).set({ mfaTotpSecret: null, mfaTotpEnabledAt: null }).where(eq(users.id, ctx.user.id));
        await clearBackupCodes(db, ctx.user.id);
        return { ok: true };
      }
      // Turning 2FA off is a credential check like the others (G32).
      assertNotLocked(ctx.user.id);
      const { matchTotpStep } = await import("../services/totp");
      const step = input.code ? matchTotpStep(u.secret, input.code) : null;
      const codeOk = step !== null && (await useTotpStep(db, ctx.user.id, step));
      const pwOk = !!input.currentPassword && !!u.passwordHash && (await bcrypt.compare(input.currentPassword, u.passwordHash));
      if (!codeOk && !pwOk) {
        noteFailure(profileKey(ctx.user.id));
        throw new TRPCError({ code: "FORBIDDEN", message: "Confirm with a current authenticator code or your password." });
      }
      await db.update(users).set({ mfaTotpSecret: null, mfaTotpEnabledAt: null }).where(eq(users.id, ctx.user.id));
      // Codes that would sign in past a second factor the account no longer has.
      await clearBackupCodes(db, ctx.user.id);
      await revokeAllSessions(db, ctx.user.id);
      await reissueSessionCookie(db, ctx.req, ctx.res, ctx.user.id);
      return { ok: true };
    }),

  /**
   * A new set of backup codes (G15), replacing the old set: the old codes
   * stop working at once. A credential check like turning 2FA off, with the
   * same lock, because the codes it returns are a way past the second factor.
   */
  regenerateBackupCodes: workspaceProcedure
    .input(z.object({
      code: z.string().optional(),
      currentPassword: z.string().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const [u] = await db
        .select({ secret: users.mfaTotpSecret, enabledAt: users.mfaTotpEnabledAt, passwordHash: users.passwordHash })
        .from(users)
        .where(eq(users.id, ctx.user.id))
        .limit(1);
      if (!u?.enabledAt || !u.secret) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Set up an authenticator app first; backup codes come with it." });
      }
      assertNotLocked(ctx.user.id);
      const { matchTotpStep } = await import("../services/totp");
      const step = input.code ? matchTotpStep(u.secret, input.code) : null;
      const codeOk = step !== null && (await useTotpStep(db, ctx.user.id, step));
      const pwOk = !!input.currentPassword && !!u.passwordHash && (await bcrypt.compare(input.currentPassword, u.passwordHash));
      if (!codeOk && !pwOk) {
        noteFailure(profileKey(ctx.user.id));
        throw new TRPCError({ code: "FORBIDDEN", message: "Confirm with a current authenticator code or your password." });
      }
      return { backupCodes: await replaceBackupCodes(db, ctx.user.id) };
    }),

  /**
   * Self-service password change. Users who already have a password must
   * supply the current one; OAuth-only users may set their first password
   * without it (same trust level as the invite password-setup flow).
   */
  changeMyPassword: workspaceProcedure
    .input(z.object({
      currentPassword: z.string().optional(),
      newPassword: z.string().min(8, "Password must be at least 8 characters").max(200),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const [u] = await db
        .select({ passwordHash: users.passwordHash })
        .from(users)
        .where(eq(users.id, ctx.user.id))
        .limit(1);
      if (u?.passwordHash) {
        if (!input.currentPassword) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Enter your current password." });
        }
        // A stolen session must not be a free password-guessing oracle (G32).
        assertNotLocked(ctx.user.id);
        const ok = await bcrypt.compare(input.currentPassword, u.passwordHash);
        if (!ok) {
          noteFailure(profileKey(ctx.user.id));
          throw new TRPCError({ code: "FORBIDDEN", message: "Current password is incorrect." });
        }
      }
      const hash = await bcrypt.hash(input.newPassword, 12);
      await db.update(users).set({ passwordHash: hash }).where(eq(users.id, ctx.user.id));
      // A new password ends every session minted under the old one (audit
      // 2026-10-20) — except this browser's, which gets a fresh token.
      await revokeAllSessions(db, ctx.user.id);
      await reissueSessionCookie(db, ctx.req, ctx.res, ctx.user.id);
      return { ok: true };
    }),

  /**
   * Return the signed-in user's per-user signature override.
   * Empty string means "use the workspace default".
   */
  getMySignature: workspaceProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const [row] = await db
      .select({ emailSignature: users.emailSignature })
      .from(users)
      .where(eq(users.id, ctx.user.id))
      .limit(1);
    return { emailSignature: row?.emailSignature ?? "" };
  }),

  /**
   * Update the signed-in user's signature. Pass empty string (or null)
   * to clear the override and fall back to the workspace default.
   */
  updateMySignature: workspaceProcedure
    .input(z.object({ emailSignature: z.string().max(4000).nullable() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const value = input.emailSignature?.trim() ? input.emailSignature.trim() : null;
      await db
        .update(users)
        .set({ emailSignature: value })
        .where(eq(users.id, ctx.user.id));
      return { emailSignature: value ?? "" };
    }),

  /** The signed-in user's appearance preferences (colour theme). Null = default teal. */
  getMyAppearance: workspaceProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const [row] = await db
      .select({ themePalette: users.themePalette, elsieEnabled: users.elsieEnabled })
      .from(users)
      .where(eq(users.id, ctx.user.id))
      .limit(1);
    // elsieEnabled NULL = never set = ON. Resolved here so no caller has to
    // remember which way the default falls.
    return {
      themePalette: row?.themePalette ?? null,
      elsieEnabled: row?.elsieEnabled ?? true,
    };
  }),

  /**
   * Persist appearance choices so they follow the user across devices.
   * Both fields are optional: omitting one leaves it untouched, so the theme
   * picker and the Elsie toggle can write independently without either
   * clobbering the other.
   */
  updateMyAppearance: workspaceProcedure
    .input(z.object({
      themePalette: z.enum(["teal", "indigo", "violet", "rose", "amber", "ocean", "graphite"]).nullable().optional(),
      elsieEnabled: z.boolean().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const set: Record<string, unknown> = {};
      if (input.themePalette !== undefined) {
        // "teal" is the default — store null so future default changes apply.
        set.themePalette = input.themePalette && input.themePalette !== "teal" ? input.themePalette : null;
      }
      if (input.elsieEnabled !== undefined) set.elsieEnabled = input.elsieEnabled;
      if (Object.keys(set).length > 0) {
        await db.update(users).set(set as never).where(eq(users.id, ctx.user.id));
      }
      return { ok: true as const, themePalette: set.themePalette ?? null };
    }),
});
