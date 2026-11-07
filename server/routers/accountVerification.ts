/**
 * accountVerification — the banner's Resend and the link's landing page
 * (audit 2026-10-20, F1). See services/accountEmailVerification.ts.
 *
 * Resend is protectedProcedure, not workspaceProcedure: the account that
 * most needs it is a stranger who has no workspace at all.
 */
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { users } from "../../drizzle/schema";
import { getDb } from "../db";
import { protectedProcedure, publicProcedure, router } from "../_core/trpc";
import { isLockedOut, noteFailure } from "../services/accountLockout";
import { confirmEmailVerification, isEmailVerificationPending, mintEmailVerification, sendVerificationEmail } from "../services/accountEmailVerification";

/** Resends per account per lock window: each is an email to someone's inbox. */
export const MAX_VERIFY_RESENDS = 5;
const resendKey = (userId: number) => `verifyemail:${userId}`;

export const accountVerificationRouter = router({
  /** A fresh link (the old one stops working), mailed to the account's own address. */
  resend: protectedProcedure.mutation(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const [u] = await db
      .select({ emailVerifiedAt: users.emailVerifiedAt, emailVerifyTokenHash: users.emailVerifyTokenHash })
      .from(users)
      .where(eq(users.id, ctx.user.id))
      .limit(1);
    if (!isEmailVerificationPending(u)) return { sent: false as const, alreadyVerified: true as const, message: "Your email is already confirmed." };
    const key = resendKey(ctx.user.id);
    if (isLockedOut(key, Date.now(), MAX_VERIFY_RESENDS)) {
      throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: "You've asked for several links in a short while. Wait 15 minutes, and check your spam folder for the ones already sent." });
    }
    noteFailure(key);
    const { token, columns } = mintEmailVerification();
    await db.update(users).set(columns).where(eq(users.id, ctx.user.id));
    const out = await sendVerificationEmail(db, ctx.user.id, token);
    return out.sent
      ? { sent: true as const, alreadyVerified: false as const, message: "A new link is on its way. Check your inbox and spam folder." }
      : { sent: false as const, alreadyVerified: false as const, message: out.message };
  }),

  /**
   * PUBLIC: the link's landing page calls this on a button press (a mail
   * scanner that fetches the link confirms nothing). The token is the
   * credential: it names the account, works once, and lasts a day.
   */
  confirm: publicProcedure
    .input(z.object({ token: z.string().min(32).max(200) }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const out = await confirmEmailVerification(db, input.token);
      if (!out.ok) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "This link is invalid, already used or more than a day old. Sign in and press Resend for a new one." });
      }
      return { ok: true as const, email: out.email };
    }),
});
