/**
 * apollo.ts — Apollo.io BYOK credential management.
 *
 * Procedures:
 *   apollo.get    — masked key status + daily cap + today's usage (any role)
 *   apollo.upsert — set/clear the API key and the daily pull cap (admin only)
 *   apollo.test   — run a real one-record search to prove the key works (admin)
 *
 * Mirrors the aiCredentials router's shape. The plaintext key never leaves the
 * server: `get` returns only a masked tail.
 */
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { workspaceSettings } from "../../drizzle/schema";
import { checkPermission, getDb } from "../db";
import { encryptSecret, maskSecret, tryDecryptSecret } from "../_core/crypto";
import { router } from "../_core/trpc";
import { adminWsProcedure, workspaceProcedure } from "../_core/workspace";
import { apolloPulledToday, apolloTestKey } from "../services/apollo";

async function ensureSettingsRow(workspaceId: number): Promise<void> {
  const db = await getDb();
  if (!db) return;
  const existing = await db
    .select({ workspaceId: workspaceSettings.workspaceId })
    .from(workspaceSettings)
    .where(eq(workspaceSettings.workspaceId, workspaceId))
    .limit(1);
  if (existing.length === 0) {
    await db.insert(workspaceSettings).values({ workspaceId });
  }
}

export const apolloRouter = router({
  /** Masked credential status + the guardrail values. Never returns plaintext. */
  get: workspaceProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const [row] = await db
      .select({
        enc: workspaceSettings.apolloApiKeyEnc,
        cap: workspaceSettings.apolloDailyPullCap,
      })
      .from(workspaceSettings)
      .where(eq(workspaceSettings.workspaceId, ctx.workspace.id))
      .limit(1);

    const plaintext = tryDecryptSecret(row?.enc);
    return {
      configured: plaintext.length > 0,
      masked: maskSecret(plaintext),
      dailyPullCap: row?.cap ?? 50,
      pulledToday: await apolloPulledToday(ctx.workspace.id),
    };
  }),

  /**
   * Set or clear the key and/or the daily cap. Admins only.
   * - apiKey="" clears it (column set to NULL); undefined leaves it unchanged.
   */
  upsert: adminWsProcedure
    .input(
      z.object({
        apiKey: z.string().optional(),
        dailyPullCap: z.number().int().min(1).max(10000).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await checkPermission(ctx, "manage_api_keys");
      await ensureSettingsRow(ctx.workspace.id);
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      const updates: Record<string, string | number | null> = {};
      if (input.apiKey !== undefined) {
        updates.apolloApiKeyEnc = input.apiKey === "" ? null : encryptSecret(input.apiKey.trim());
      }
      if (input.dailyPullCap !== undefined) {
        updates.apolloDailyPullCap = input.dailyPullCap;
      }

      if (Object.keys(updates).length > 0) {
        await db
          .update(workspaceSettings)
          .set(updates)
          .where(eq(workspaceSettings.workspaceId, ctx.workspace.id));
      }
      return { ok: true };
    }),

  /**
   * Live key test. Runs the same search endpoint the sourcing uses (1 record),
   * so a pass proves discovery will work — not merely that the string parses.
   * Consumes zero Apollo credits.
   */
  test: adminWsProcedure.mutation(async ({ ctx }) => {
    const res = await apolloTestKey(ctx.workspace.id);
    if (!res.ok) {
      throw new TRPCError({ code: "BAD_REQUEST", message: res.message });
    }
    return res;
  }),
});
