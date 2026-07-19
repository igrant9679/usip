/**
 * aiCredentials.ts — BYOK AI provider credentials per workspace.
 *
 * Procedures:
 *   aiCredentials.get     — return masked + boolean status of all 3 providers (any role)
 *   aiCredentials.upsert  — set/clear API key + model per provider (admin only)
 *   aiCredentials.test    — issue a tiny "ping" call against a provider (admin only)
 */
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { workspaceSettings } from "../../drizzle/schema";
import { checkPermission, getDb } from "../db";
import {
  encryptSecret,
  maskSecret,
  tryDecryptSecret,
} from "../_core/crypto";
import { invokeLLM, type ProviderName } from "../_core/llm";
import { router } from "../_core/trpc";
import { adminWsProcedure, workspaceProcedure } from "../_core/workspace";

const providerEnum = z.enum(["anthropic", "openai", "gemini"]);

async function ensureSettingsRow(workspaceId: number): Promise<void> {
  const db = await getDb();
  const existing = await db
    .select({ workspaceId: workspaceSettings.workspaceId })
    .from(workspaceSettings)
    .where(eq(workspaceSettings.workspaceId, workspaceId))
    .limit(1);
  if (existing.length === 0) {
    await db.insert(workspaceSettings).values({ workspaceId });
  }
}

export const aiCredentialsRouter = router({
  /**
   * Return masked credential status for all 3 providers in the current workspace.
   * Never returns plaintext keys.
   */
  get: workspaceProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    const rows = await db
      .select({
        anthropicApiKeyEnc: workspaceSettings.anthropicApiKeyEnc,
        openaiApiKeyEnc: workspaceSettings.openaiApiKeyEnc,
        geminiApiKeyEnc: workspaceSettings.geminiApiKeyEnc,
        anthropicModel: workspaceSettings.anthropicModel,
        openaiModel: workspaceSettings.openaiModel,
        geminiModel: workspaceSettings.geminiModel,
        aiDefaultProvider: workspaceSettings.aiDefaultProvider,
      })
      .from(workspaceSettings)
      .where(eq(workspaceSettings.workspaceId, ctx.workspace.id))
      .limit(1);

    const row = rows[0];
    const mask = (enc: string | null | undefined) => {
      const pt = tryDecryptSecret(enc);
      return { configured: pt.length > 0, masked: maskSecret(pt) };
    };

    return {
      anthropic: {
        ...mask(row?.anthropicApiKeyEnc),
        model: row?.anthropicModel ?? "",
      },
      openai: {
        ...mask(row?.openaiApiKeyEnc),
        model: row?.openaiModel ?? "",
      },
      gemini: {
        ...mask(row?.geminiApiKeyEnc),
        model: row?.geminiModel ?? "",
      },
      defaultProvider: row?.aiDefaultProvider ?? "",
    };
  }),

  /**
   * Set or clear a provider's API key + default model. Admins only.
   * - apiKey="" clears the key (sets the encrypted column to NULL).
   * - apiKey=undefined leaves it unchanged.
   */
  upsert: adminWsProcedure
    .input(
      z.object({
        provider: providerEnum,
        apiKey: z.string().optional(),
        model: z.string().max(128).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await checkPermission(ctx, "manage_api_keys");
      await ensureSettingsRow(ctx.workspace.id);
      const db = await getDb();

      const updates: Record<string, string | null> = {};
      if (input.apiKey !== undefined) {
        const encCol =
          input.provider === "anthropic"
            ? "anthropicApiKeyEnc"
            : input.provider === "openai"
              ? "openaiApiKeyEnc"
              : "geminiApiKeyEnc";
        updates[encCol] = input.apiKey === "" ? null : encryptSecret(input.apiKey);
      }
      if (input.model !== undefined) {
        const modelCol =
          input.provider === "anthropic"
            ? "anthropicModel"
            : input.provider === "openai"
              ? "openaiModel"
              : "geminiModel";
        updates[modelCol] = input.model === "" ? null : input.model;
      }

      if (Object.keys(updates).length > 0) {
        await db
          .update(workspaceSettings)
          .set(updates)
          .where(eq(workspaceSettings.workspaceId, ctx.workspace.id));
      }

      return { ok: true };
    }),

  /** Set the workspace's default provider (admins only). */
  setDefaultProvider: adminWsProcedure
    .input(z.object({ provider: providerEnum.or(z.literal("")) }))
    .mutation(async ({ ctx, input }) => {
      await ensureSettingsRow(ctx.workspace.id);
      const db = await getDb();
      await db
        .update(workspaceSettings)
        .set({ aiDefaultProvider: input.provider === "" ? null : input.provider })
        .where(eq(workspaceSettings.workspaceId, ctx.workspace.id));
      return { ok: true };
    }),

  /**
   * Send a tiny prompt to verify the configured key + model work end-to-end.
   * Returns { ok, model, latencyMs } on success, throws TRPC error on failure.
   */
  test: adminWsProcedure
    .input(z.object({ provider: providerEnum }))
    .mutation(async ({ ctx, input }) => {
      const start = Date.now();
      try {
        const res = await invokeLLM({
          workspaceId: ctx.workspace.id,
          provider: input.provider as ProviderName,
          messages: [
            { role: "user", content: "Reply with the single word: pong" },
          ],
          max_tokens: 8,
        });
        return {
          ok: true,
          model: res.model,
          latencyMs: Date.now() - start,
          reply:
            typeof res.choices[0]?.message?.content === "string"
              ? (res.choices[0].message.content as string).slice(0, 50)
              : "",
        };
      } catch (err) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: err instanceof Error ? err.message : "Provider test failed",
        });
      }
    }),
});
