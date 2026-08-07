/**
 * quickenrich.ts — QuickEnrich BYOK credential management.
 *
 * Procedures (deliberately mirrors routers/reoon.ts, the canonical shape):
 *   quickenrich.get    — masked key status + source (workspace vs env)
 *   quickenrich.upsert — set/clear the API key (admin only)
 *   quickenrich.test   — free contact-finder call to prove the key works (admin)
 *
 * ONLY credential management lives here. Sourcing/enrichment procedures arrive
 * with the engine pass that uses the key — shipping them ahead of a consumer
 * is the dead-wiring class, and shipping caps/modes ahead of an engine that
 * reads them is the inert-settings class. The card in Settings says exactly
 * what the key powers today so the UI never overclaims.
 */
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { workspaceSettings } from "../../drizzle/schema";
import { checkPermission, getDb } from "../db";
import { encryptSecret, maskSecret, tryDecryptSecret } from "../_core/crypto";
import { router } from "../_core/trpc";
import { adminWsProcedure, workspaceProcedure } from "../_core/workspace";
import { getQuickEnrichKey, quickenrichTestKey } from "../services/quickenrich";

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

export const quickenrichRouter = router({
  /** Masked credential status + where it resolves from. Never returns plaintext. */
  get: workspaceProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const [row] = await db
      .select({ enc: workspaceSettings.quickenrichApiKeyEnc })
      .from(workspaceSettings)
      .where(eq(workspaceSettings.workspaceId, ctx.workspace.id))
      .limit(1);

    const workspaceKey = tryDecryptSecret(row?.enc);
    const envKey = process.env.QUICKENRICH_API_KEY ?? "";
    const effective = workspaceKey || envKey;

    return {
      configured: effective.length > 0,
      masked: maskSecret(effective),
      /** "workspace" = this workspace's own key, "env" = the deploy-wide fallback. */
      source: workspaceKey ? ("workspace" as const) : envKey ? ("env" as const) : ("none" as const),
    };
  }),

  /**
   * Set or clear the key. Admins only.
   * - apiKey="" clears the column, which falls the workspace BACK to the env
   *   var if the deployment sets one.
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
          quickenrichApiKeyEnc: input.apiKey === "" ? null : encryptSecret(input.apiKey.trim()),
        })
        .where(eq(workspaceSettings.workspaceId, ctx.workspace.id));
      return { ok: true as const };
    }),

  /**
   * Live key test. Their docs publish no balance endpoint, so this makes a
   * minimal call to contact-finder — documented as 0 credits — which proves
   * the key authenticates without spending anything.
   */
  test: adminWsProcedure.mutation(async ({ ctx }) => {
    const apiKey = await getQuickEnrichKey(ctx.workspace.id);
    if (!apiKey) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "No QuickEnrich API key configured." });
    }
    const result = await quickenrichTestKey(apiKey);
    if (!result.ok) {
      throw new TRPCError({ code: "BAD_REQUEST", message: result.message });
    }
    return result;
  }),
});
