/**
 * profile.ts — self-service settings for the signed-in user.
 *
 * Today this is just the per-user email signature override; the router is
 * a natural home for future things like notification preferences or
 * timezone overrides without bloating admin/settings (which is workspace
 * scoped).
 */
import { eq } from "drizzle-orm";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { getDb } from "../db";
import { users } from "../../drizzle/schema";
import { router } from "../_core/trpc";
import { workspaceProcedure } from "../_core/workspace";

export const profileRouter = router({
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
});
