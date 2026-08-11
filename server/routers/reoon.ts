/**
 * reoon.ts — Reoon Email Verifier BYOK credential management.
 *
 * Procedures:
 *   reoon.get    — masked key status + source (workspace vs env) + balance (any role)
 *   reoon.upsert — set/clear the API key (admin only)
 *   reoon.test   — live balance call to prove the key works (admin)
 *
 * Deliberately mirrors routers/apollo.ts. Reoon was the last integration
 * readable only from `process.env.REOON_API_KEY`, which made it the one key a
 * user could not set without a redeploy — and it backs the ONLY email-finding
 * path left now that paid Apollo enrichment is off the table.
 *
 * `get` reports WHERE the key came from, because "configured" alone would hide
 * the case that matters during the migration: the workspace column is empty and
 * everything is quietly running on a process-wide env var.
 */
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { workspaceSettings } from "../../drizzle/schema";
import { checkPermission, getDb } from "../db";
import { encryptSecret, maskSecret, tryDecryptSecret } from "../_core/crypto";
import { router } from "../_core/trpc";
import { adminWsProcedure, workspaceProcedure } from "../_core/workspace";
import { getReoonKey, reoonCheckBalance } from "../services/reoon";

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

export const reoonRouter = router({
  /** Masked credential status + where it resolves from. Never returns plaintext. */
  get: workspaceProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const [row] = await db
      .select({ enc: workspaceSettings.reoonApiKeyEnc, enabled: workspaceSettings.reoonVerificationEnabled })
      .from(workspaceSettings)
      .where(eq(workspaceSettings.workspaceId, ctx.workspace.id))
      .limit(1);

    const workspaceKey = tryDecryptSecret(row?.enc);
    const envKey = process.env.REOON_API_KEY ?? "";
    const effective = workspaceKey || envKey;

    return {
      configured: effective.length > 0,
      masked: maskSecret(effective),
      /** "workspace" = this workspace's own key, "env" = the deploy-wide fallback. */
      source: workspaceKey ? ("workspace" as const) : envKey ? ("env" as const) : ("none" as const),
      /** Reoon = the optional FINAL verification step (migration 0157). */
      verificationEnabled: row?.enabled !== false,
    };
  }),

  /** Toggle Reoon as the final verification step. Admins only. Enforced at
   *  the getReoonKey choke point — OFF behaves exactly as key-absent, so
   *  unverified addresses are never marked valid and never promote. */
  setVerificationEnabled: adminWsProcedure
    .input(z.object({ enabled: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      await ensureSettingsRow(ctx.workspace.id);
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      await db.update(workspaceSettings)
        .set({ reoonVerificationEnabled: input.enabled })
        .where(eq(workspaceSettings.workspaceId, ctx.workspace.id));
      return { ok: true as const, enabled: input.enabled };
    }),

  /**
   * Set or clear the key. Admins only.
   * - apiKey="" clears the column, which falls the workspace BACK to the env
   *   var if the deployment sets one (it does not disable verification).
   */
  upsert: adminWsProcedure
    .input(z.object({ apiKey: z.string() }))
    .mutation(async ({ ctx, input }) => {
      await checkPermission(ctx, "manage_api_keys");
      await ensureSettingsRow(ctx.workspace.id);
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      await db
        .update(workspaceSettings)
        .set({
          reoonApiKeyEnc: input.apiKey === "" ? null : encryptSecret(input.apiKey.trim()),
        })
        .where(eq(workspaceSettings.workspaceId, ctx.workspace.id));
      return { ok: true as const };
    }),

  /**
   * Live key test. Calls the balance endpoint, which consumes no verification
   * credits — so a pass proves the finder will work AND tells the user how much
   * verification they can actually afford before they start a sweep.
   */
  test: adminWsProcedure.mutation(async ({ ctx }) => {
    const apiKey = await getReoonKey(ctx.workspace.id);
    if (!apiKey) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "No Reoon API key configured." });
    }
    try {
      const balance = await reoonCheckBalance(apiKey);
      if (balance.api_status && balance.api_status !== "success") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Reoon rejected that key." });
      }
      return {
        ok: true as const,
        dailyCredits: balance.remaining_daily_credits ?? 0,
        instantCredits: balance.remaining_instant_credits ?? 0,
      };
    } catch (e) {
      if (e instanceof TRPCError) throw e;
      throw new TRPCError({ code: "BAD_REQUEST", message: (e as Error).message });
    }
  }),
});
