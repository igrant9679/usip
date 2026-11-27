/**
 * aiCredentials.ts — BYOK AI provider credentials per workspace.
 *
 * Procedures:
 *   aiCredentials.get     — return masked + boolean status of every provider (any role)
 *   aiCredentials.upsert  — set/clear API key + model per provider (admin only)
 *   aiCredentials.test    — issue a tiny "ping" call against a provider (admin only)
 *   aiCredentials.getTiers / setTier / setTaskTier / testTier — model tiers (shared/aiTiers.ts)
 *   aiCredentials.openrouterModels — OpenRouter's models that can give structured answers, with prices (any role)
 *   aiCredentials.platformAi / setPlatformDefault / checkSharedOpenRouterKey — the platform
 *     default provider and the shared OpenRouter key's credit (platform owner only)
 */
import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { workspaceMembers, workspaceSettings } from "../../drizzle/schema";
import { recordAudit } from "../audit";
import { checkPermission, getDb } from "../db";
import {
  encryptSecret,
  maskSecret,
  tryDecryptSecret,
} from "../_core/crypto";
import { ENV } from "../_core/env";
import { invokeLLM, type ProviderName } from "../_core/llm";
import { borrowedKeys } from "../services/keyShares";
import { deepseekSettings } from "../services/deepseekSettings";
import { openrouterSettings } from "../services/openrouterSettings";
import { checkOpenRouterKey, getOpenRouterModels } from "../services/openrouter";
import { platformDefaultProvider, setPlatformDefaultProvider } from "../services/platformAi";
import { forgetTierConfig } from "../services/aiTiers";
import { AI_PROVIDER_IDS, AI_PROVIDER_LABEL, AI_TASK_IDS, AI_TIERS, cleanTaskTiers, cleanTierModels, type AiProviderId, type AiTask } from "@shared/aiTiers";
import {
  OPENROUTER_FALLBACK_MODEL,
  canAnswerStructured,
  defaultOpenRouterModel,
  modelsForStructuredAnswers,
  priceLabel,
} from "@shared/openrouterModels";
import { adminProcedure, router } from "../_core/trpc";
import { adminWsProcedure, workspaceProcedure } from "../_core/workspace";

const providerEnum = z.enum(AI_PROVIDER_IDS);

/** Where each provider's key and model are kept on workspace_settings. */
const KEY_COLUMN = {
  anthropic: "anthropicApiKeyEnc",
  openai: "openaiApiKeyEnc",
  gemini: "geminiApiKeyEnc",
  deepseek: "deepseekApiKeyEnc",
  openrouter: "openrouterApiKeyEnc",
} as const satisfies Record<AiProviderId, string>;
const MODEL_COLUMN = {
  anthropic: "anthropicModel",
  openai: "openaiModel",
  gemini: "geminiModel",
  deepseek: "deepseekModel",
  openrouter: "openrouterModel",
} as const satisfies Record<AiProviderId, string>;

/** The deployment's key per provider, as the env var the owner sets on Railway. */
const ENV_KEY_NAME: Record<AiProviderId, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  gemini: "GEMINI_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
};

/** Whether the deployment holds a key per provider. Booleans only: no key, or any part of one, leaves the server. */
function deploymentKeys(): Record<AiProviderId, boolean> {
  return {
    anthropic: !!ENV.anthropicApiKey,
    openai: !!ENV.openaiApiKey,
    gemini: !!ENV.geminiApiKey,
    deepseek: !!ENV.deepseekApiKey,
    openrouter: !!ENV.openrouterApiKey,
  };
}

/**
 * Refuses an OpenRouter model that is not in OpenRouter's list, or that
 * cannot give a structured answer: every tier and the default model carry
 * structured work here, so only those models are offered (shared/
 * openrouterModels). With the list unreadable nothing is refused; the
 * model funnel still never sends a structured call to a model that cannot
 * answer it.
 */
async function assertOpenRouterModel(model: string): Promise<void> {
  if (!model) return;
  const list = await getOpenRouterModels();
  if (list.models.length === 0) return;
  const m = list.models.find((x) => x.id === model);
  if (!m) throw new TRPCError({ code: "BAD_REQUEST", message: `OpenRouter has no model "${model}". Pick one from the list.` });
  if (!canAnswerStructured(m)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: `${m.name} cannot give structured answers on OpenRouter (no tools or structured outputs), and Velocity's AI features need them. Pick another model.` });
  }
}
const tierEnum = z.enum(AI_TIERS);
const taskEnum = z.enum(AI_TASK_IDS as [AiTask, ...AiTask[]]);

/** The two tier columns, as only their well-formed parts. Separate from `get`: it must work before the columns exist. */
async function readTiers(workspaceId: number) {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
  const [row] = await db
    .select({ tiers: workspaceSettings.aiTierModels, taskTiers: workspaceSettings.aiTaskTiers })
    .from(workspaceSettings)
    .where(eq(workspaceSettings.workspaceId, workspaceId))
    .limit(1);
  return { db, tiers: cleanTierModels(row?.tiers), taskTiers: cleanTaskTiers(row?.taskTiers) };
}

async function ensureSettingsRow(workspaceId: number): Promise<void> {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
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
   * Return masked credential status for every provider in the current workspace.
   * Never returns plaintext keys.
   */
  get: workspaceProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
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
    // DeepSeek's and OpenRouter's columns are read apart from the rest (services/deepseekSettings, openrouterSettings).
    const deepseek = await deepseekSettings(ctx.workspace.id);
    const openrouter = await openrouterSettings(ctx.workspace.id);
    // A key another workspace lends this one (services/keyShares) is in use
    // and named, but never shown here — not even its tail.
    const borrowed = await borrowedKeys(ctx.workspace.id);
    const mask = (enc: string | null | undefined, kind: AiProviderId) => {
      const pt = tryDecryptSecret(enc);
      const lent = pt ? undefined : borrowed.find((b) => b.kind === kind && b.usable);
      return { configured: pt.length > 0 || !!lent, masked: maskSecret(pt), sharedFrom: lent?.ownerName ?? null };
    };

    return {
      anthropic: {
        ...mask(row?.anthropicApiKeyEnc, "anthropic"),
        model: row?.anthropicModel ?? "",
      },
      openai: {
        ...mask(row?.openaiApiKeyEnc, "openai"),
        model: row?.openaiModel ?? "",
      },
      gemini: {
        ...mask(row?.geminiApiKeyEnc, "gemini"),
        model: row?.geminiModel ?? "",
      },
      deepseek: {
        ...mask(deepseek.keyEnc, "deepseek"),
        model: deepseek.model ?? "",
      },
      openrouter: {
        ...mask(openrouter.keyEnc, "openrouter"),
        model: openrouter.model ?? "",
        // Whether the platform's shared OpenRouter key is there to fall back on
        // (a boolean: the key itself never leaves the server).
        platformKey: !!ENV.openrouterApiKey,
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
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });

      // An OpenRouter key is checked with OpenRouter before it is kept
      // (GET /api/v1/key): a refused key is not saved, and OpenRouter's own
      // words say why. The answer carries the key's credit when it has a limit.
      let keyCheck: Awaited<ReturnType<typeof checkOpenRouterKey>> | null = null;
      if (input.provider === "openrouter") {
        const apiKey = input.apiKey?.trim();
        if (apiKey) {
          try {
            keyCheck = await checkOpenRouterKey(apiKey, "workspace");
          } catch (err) {
            throw new TRPCError({ code: "BAD_REQUEST", message: err instanceof Error ? err.message : "OpenRouter did not accept the key" });
          }
        }
        if (input.model) await assertOpenRouterModel(input.model);
      }

      const updates: Record<string, string | null> = {};
      if (input.apiKey !== undefined) {
        updates[KEY_COLUMN[input.provider]] = input.apiKey === "" ? null : encryptSecret(input.provider === "openrouter" ? input.apiKey.trim() : input.apiKey);
      }
      if (input.model !== undefined) {
        updates[MODEL_COLUMN[input.provider]] = input.model === "" ? null : input.model;
      }

      if (Object.keys(updates).length > 0) {
        await db
          .update(workspaceSettings)
          .set(updates)
          .where(eq(workspaceSettings.workspaceId, ctx.workspace.id));
      }

      return keyCheck ? { ok: true, keyCheck } : { ok: true };
    }),

  /**
   * Copy another workspace's AI credentials into THIS one (owner ask
   * 2026-09-09: "copy the LSI key to the demo workspace"). The API never
   * hands a key back in plaintext, so a copy has to happen server-side.
   * Super admin of BOTH workspaces required; keys are decrypted and
   * re-encrypted through the same helpers upsert uses; models and the
   * default provider come along. Audited on the destination.
   */
  copyFromWorkspace: adminWsProcedure
    .input(z.object({ fromWorkspaceId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      if (ctx.member.role !== "super_admin") throw new TRPCError({ code: "FORBIDDEN", message: "Only super admins can copy credentials" });
      if (input.fromWorkspaceId === ctx.workspace.id) throw new TRPCError({ code: "BAD_REQUEST", message: "Source and destination are the same workspace" });
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const [src] = await db
        .select({ role: workspaceMembers.role })
        .from(workspaceMembers)
        .where(and(eq(workspaceMembers.workspaceId, input.fromWorkspaceId), eq(workspaceMembers.userId, ctx.user.id)))
        .limit(1);
      if (!src || src.role !== "super_admin") throw new TRPCError({ code: "FORBIDDEN", message: "You must be a super admin of the source workspace too" });
      const [from] = await db
        .select({
          anthropicApiKeyEnc: workspaceSettings.anthropicApiKeyEnc, anthropicModel: workspaceSettings.anthropicModel,
          openaiApiKeyEnc: workspaceSettings.openaiApiKeyEnc, openaiModel: workspaceSettings.openaiModel,
          geminiApiKeyEnc: workspaceSettings.geminiApiKeyEnc, geminiModel: workspaceSettings.geminiModel,
          aiDefaultProvider: workspaceSettings.aiDefaultProvider,
        })
        .from(workspaceSettings)
        .where(eq(workspaceSettings.workspaceId, input.fromWorkspaceId))
        .limit(1);
      if (!from) throw new TRPCError({ code: "NOT_FOUND", message: "Source workspace has no settings row" });
      const reenc = (enc: string | null) => { const pt = tryDecryptSecret(enc); return pt ? encryptSecret(pt) : null; };
      await ensureSettingsRow(ctx.workspace.id);
      const copied: string[] = [];
      const updates: Record<string, string | null> = {};
      const a = reenc(from.anthropicApiKeyEnc); if (a) { updates.anthropicApiKeyEnc = a; updates.anthropicModel = from.anthropicModel ?? null; copied.push("anthropic"); }
      const o = reenc(from.openaiApiKeyEnc); if (o) { updates.openaiApiKeyEnc = o; updates.openaiModel = from.openaiModel ?? null; copied.push("openai"); }
      const g = reenc(from.geminiApiKeyEnc); if (g) { updates.geminiApiKeyEnc = g; updates.geminiModel = from.geminiModel ?? null; copied.push("gemini"); }
      const fromDeepseek = await deepseekSettings(input.fromWorkspaceId);
      const d = reenc(fromDeepseek.keyEnc); if (d) { updates.deepseekApiKeyEnc = d; updates.deepseekModel = fromDeepseek.model ?? null; copied.push("deepseek"); }
      const fromOpenrouter = await openrouterSettings(input.fromWorkspaceId);
      const r = reenc(fromOpenrouter.keyEnc); if (r) { updates.openrouterApiKeyEnc = r; updates.openrouterModel = fromOpenrouter.model ?? null; copied.push("openrouter"); }
      if (from.aiDefaultProvider) updates.aiDefaultProvider = from.aiDefaultProvider;
      if (copied.length === 0) throw new TRPCError({ code: "BAD_REQUEST", message: "The source workspace has no AI keys to copy" });
      await db.update(workspaceSettings).set(updates).where(eq(workspaceSettings.workspaceId, ctx.workspace.id));
      await recordAudit({ workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "update", entityType: "ai_credentials", entityId: ctx.workspace.id, after: { copiedFromWorkspaceId: input.fromWorkspaceId, providers: copied, defaultProvider: from.aiDefaultProvider ?? null } });
      return { ok: true as const, providers: copied, defaultProvider: from.aiDefaultProvider ?? null };
    }),

  /** Set the workspace's default provider (admins only). */
  setDefaultProvider: adminWsProcedure
    .input(z.object({ provider: providerEnum.or(z.literal("")) }))
    .mutation(async ({ ctx, input }) => {
      await ensureSettingsRow(ctx.workspace.id);
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      await db
        .update(workspaceSettings)
        .set({ aiDefaultProvider: input.provider === "" ? null : input.provider })
        .where(eq(workspaceSettings.workspaceId, ctx.workspace.id));
      return { ok: true };
    }),

  /**
   * Model tiers: what each of the three tiers is set to, and which tasks this
   * workspace has moved off their default tier. The catalog of tasks and the
   * defaults are code (shared/aiTiers.ts), so the screen imports them.
   */
  getTiers: workspaceProcedure.query(async ({ ctx }) => {
    const { tiers, taskTiers } = await readTiers(ctx.workspace.id);
    return { tiers, taskTiers };
  }),

  /** Set one tier's provider and model; an empty model clears the tier. Admins only. */
  setTier: adminWsProcedure
    .input(z.object({ tier: tierEnum, provider: providerEnum, model: z.string().trim().max(128) }))
    .mutation(async ({ ctx, input }) => {
      await checkPermission(ctx, "manage_api_keys");
      if (input.provider === "openrouter") await assertOpenRouterModel(input.model);
      await ensureSettingsRow(ctx.workspace.id);
      const { db, tiers } = await readTiers(ctx.workspace.id);
      const before = tiers[input.tier] ?? null;
      const next = { ...tiers };
      if (input.model) next[input.tier] = { provider: input.provider, model: input.model };
      else delete next[input.tier];
      await db
        .update(workspaceSettings)
        .set({ aiTierModels: Object.keys(next).length > 0 ? next : null })
        .where(eq(workspaceSettings.workspaceId, ctx.workspace.id));
      forgetTierConfig(ctx.workspace.id);
      await recordAudit({ workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "update", entityType: "ai_model_tier", entityId: ctx.workspace.id, before: { tier: input.tier, ...before }, after: { tier: input.tier, ...(next[input.tier] ?? { provider: null, model: null }) } });
      return { ok: true as const, tiers: next };
    }),

  /** Move one kind of work to a tier; `tier: ""` puts it back on its default. Admins only. */
  setTaskTier: adminWsProcedure
    .input(z.object({ task: taskEnum, tier: tierEnum.or(z.literal("")) }))
    .mutation(async ({ ctx, input }) => {
      await checkPermission(ctx, "manage_api_keys");
      await ensureSettingsRow(ctx.workspace.id);
      const { db, taskTiers } = await readTiers(ctx.workspace.id);
      const before = taskTiers[input.task] ?? null;
      const next = { ...taskTiers };
      if (input.tier) next[input.task] = input.tier;
      else delete next[input.task];
      await db
        .update(workspaceSettings)
        .set({ aiTaskTiers: Object.keys(next).length > 0 ? next : null })
        .where(eq(workspaceSettings.workspaceId, ctx.workspace.id));
      forgetTierConfig(ctx.workspace.id);
      await recordAudit({ workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "update", entityType: "ai_task_tier", entityId: ctx.workspace.id, before: { task: input.task, tier: before }, after: { task: input.task, tier: input.tier || null } });
      return { ok: true as const, taskTiers: next };
    }),

  /** The same tiny "ping" as `test`, against the model a tier is set to. */
  testTier: adminWsProcedure
    .input(z.object({ tier: tierEnum }))
    .mutation(async ({ ctx, input }) => {
      const { tiers } = await readTiers(ctx.workspace.id);
      const set = tiers[input.tier];
      if (!set) throw new TRPCError({ code: "BAD_REQUEST", message: "This tier has no model set." });
      const start = Date.now();
      try {
        // Names its provider and model, so the tiers do not reroute their own test.
        const res = await invokeLLM({
          workspaceId: ctx.workspace.id,
          provider: set.provider as ProviderName,
          model: set.model,
          messages: [{ role: "user", content: "Reply with the single word: pong" }],
          max_tokens: 8,
        });
        return { ok: true as const, model: res.model, latencyMs: Date.now() - start };
      } catch (err) {
        throw new TRPCError({ code: "BAD_REQUEST", message: err instanceof Error ? err.message : "Model test failed" });
      }
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
        // No task: this tests the provider it names, whatever the tiers say.
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

  /**
   * OpenRouter's models for the pickers: only those that can give a
   * structured answer (every tier and the default model carry structured
   * work), each with its price per million tokens, and the default model,
   * the newest Claude Sonnet that takes tools, from the live list. A public
   * list, so any member may read it. Cached for three hours (services/openrouter);
   * `error` says why it could not be read, beside whatever list was last read.
   */
  openrouterModels: workspaceProcedure.query(async () => {
    const list = await getOpenRouterModels();
    const offered = modelsForStructuredAnswers(list.models).sort((a, b) => a.name.localeCompare(b.name));
    return {
      models: offered.map((m) => ({
        id: m.id,
        name: m.name,
        contextLength: m.contextLength,
        promptPerMillion: m.promptPerMillion,
        completionPerMillion: m.completionPerMillion,
        price: priceLabel(m),
        tools: m.supportedParameters.includes("tools"),
        structuredOutputs: m.supportedParameters.includes("structured_outputs"),
      })),
      defaultModelId: defaultOpenRouterModel(list.models)?.id ?? OPENROUTER_FALLBACK_MODEL,
      /** Models in OpenRouter's list that are not offered because they cannot give structured answers. */
      notOffered: list.models.length - offered.length,
      fetchedAt: list.fetchedAt,
      error: list.error,
    };
  }),

  /**
   * The platform default provider (services/platformAi), for the platform
   * owner (users.role 'admin') only: what it is set to (null = not set, so the
   * deployment's AI_DEFAULT_PROVIDER and the fallback order decide, as before),
   * and which providers the deployment holds a shared key for. Booleans only.
   */
  platformAi: adminProcedure.query(async () => ({
    defaultProvider: await platformDefaultProvider(),
    envDefaultProvider: ENV.aiDefaultProvider || null,
    deploymentKeys: deploymentKeys(),
  })),

  /**
   * Set (or clear, with "") the platform default provider. Platform owner only.
   * It applies to workspaces that have made no AI choice and hold no AI key
   * of their own. A provider the deployment has no key for is refused: no
   * workspace could use it, and they would quietly fall through to the next.
   */
  setPlatformDefault: adminProcedure
    .input(z.object({ provider: providerEnum.or(z.literal("")) }))
    .mutation(async ({ ctx, input }) => {
      const provider = input.provider === "" ? null : input.provider;
      if (provider && !deploymentKeys()[provider]) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `There is no shared ${AI_PROVIDER_LABEL[provider]} key on the server yet. Set ${ENV_KEY_NAME[provider]} on Railway first, then switch.`,
        });
      }
      const before = await platformDefaultProvider();
      await setPlatformDefaultProvider(provider);
      await recordAudit({
        workspaceId: 0, actorUserId: ctx.user.id, action: "update",
        entityType: "platform_settings", entityId: null,
        before: { aiDefaultProvider: before }, after: { aiDefaultProvider: provider },
      });
      return { ok: true as const, defaultProvider: provider };
    }),

  /** Ask OpenRouter about the platform's shared key: valid, and its credit if it has a limit. Platform owner only. */
  checkSharedOpenRouterKey: adminProcedure.mutation(async () => {
    if (!ENV.openrouterApiKey) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "OPENROUTER_API_KEY is not set on the server." });
    }
    try {
      return { ok: true as const, ...(await checkOpenRouterKey(ENV.openrouterApiKey, "shared")) };
    } catch (err) {
      throw new TRPCError({ code: "BAD_REQUEST", message: err instanceof Error ? err.message : "OpenRouter did not accept the shared key" });
    }
  }),
});
