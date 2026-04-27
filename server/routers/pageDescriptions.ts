import { z } from "zod";
import { router, protectedProcedure } from "../_core/trpc";
import { getDb } from "../db";
import { pageDescriptions } from "../../drizzle/schema";
import { eq } from "drizzle-orm";

export const pageDescriptionsRouter = router({
  /** Return the saved description for a page key, or null if not customised. */
  get: protectedProcedure
    .input(z.object({ pageKey: z.string().max(100) }))
    .query(async ({ input }) => {
      const db = await getDb();
      const rows = await db
        .select()
        .from(pageDescriptions)
        .where(eq(pageDescriptions.pageKey, input.pageKey))
        .limit(1);
      return rows[0] ?? null;
    }),

  /** Upsert a description for a page key. Admin-only. */
  update: protectedProcedure
    .input(
      z.object({
        pageKey: z.string().max(100),
        description: z.string().max(500),
      })
    )
    .mutation(async ({ input, ctx }) => {
      if (ctx.user.role !== "admin" && ctx.user.role !== "super_admin") {
        throw new Error("Only admins can edit page descriptions.");
      }
      const db = await getDb();
      await db
        .insert(pageDescriptions)
        .values({
          pageKey: input.pageKey,
          description: input.description,
          updatedByUserId: ctx.user.id,
        })
        .onDuplicateKeyUpdate({
          set: {
            description: input.description,
            updatedByUserId: ctx.user.id,
          },
        });
      return { ok: true };
    }),
});
