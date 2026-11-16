/**
 * AI model tiers, server side: a workspace's settings and the routing step
 * both model-call funnels run (invokeLLM and streamLLM). The rules themselves
 * are pure and live in shared/aiTiers.ts.
 */
import { eq } from "drizzle-orm";
import { workspaceSettings } from "../../drizzle/schema";
import { getDb } from "../db";
import {
  canStepUp,
  cleanTaskTiers,
  cleanTierModels,
  pickTierModel,
  type AiProviderId,
  type AiTask,
  type TaskTiers,
  type TierModels,
  type TierPick,
} from "@shared/aiTiers";

export type TierConfig = { tiers: TierModels; taskTiers: TaskTiers };

const EMPTY: TierConfig = { tiers: {}, taskTiers: {} };

/**
 * Read on every model call, so cached briefly; a save clears its own entry.
 * FAILS TO "NOT SET": a missing column (the migration is applied after the
 * server starts) or a database error must never stop an AI call, and "not
 * set" is exactly the behaviour from before tiers existed.
 */
const CACHE_MS = 60_000;
const cache = new Map<number, { at: number; cfg: TierConfig }>();

export async function loadTierConfig(workspaceId: number | undefined, now = Date.now()): Promise<TierConfig> {
  if (!workspaceId) return EMPTY;
  const hit = cache.get(workspaceId);
  if (hit && now - hit.at < CACHE_MS) return hit.cfg;
  let cfg = EMPTY;
  try {
    const db = await getDb();
    if (db) {
      const [row] = await db
        .select({ tiers: workspaceSettings.aiTierModels, taskTiers: workspaceSettings.aiTaskTiers })
        .from(workspaceSettings)
        .where(eq(workspaceSettings.workspaceId, workspaceId))
        .limit(1);
      cfg = { tiers: cleanTierModels(row?.tiers), taskTiers: cleanTaskTiers(row?.taskTiers) };
    }
  } catch (err) {
    console.error(`[aiTiers] could not read tiers for workspace ${workspaceId}; using the default model:`, err instanceof Error ? err.message : String(err));
  }
  cache.set(workspaceId, { at: now, cfg });
  return cfg;
}

export function forgetTierConfig(workspaceId: number): void {
  cache.delete(workspaceId);
}

/** Test seam: the cache is process-local. */
export function __resetTierConfigForTests(): void {
  cache.clear();
}

type KeyHolder = { anthropicApiKey: string; openaiApiKey: string; geminiApiKey: string };
type Routable = { provider?: AiProviderId; model?: string; task?: AiTask; stepUp?: number };

export type Routed<P> = {
  params: P;
  /** null when tiers had no say: the caller named its own model, or there is no workspace. */
  pick: TierPick | null;
  /** A stronger model is set above this call's tier, so a failed reply is worth one more try there. */
  canStepUp: boolean;
};

/**
 * Put the tier's provider and model on a call, when its tier has one.
 *
 * A caller that names its own provider or model keeps it: the key test in
 * Settings must hit the provider it is testing, whatever the tiers say.
 */
export async function applyTier<P extends Routable>(
  params: P,
  workspaceId: number | undefined,
  creds: KeyHolder,
  stepUp: number = params.stepUp ?? 0,
): Promise<Routed<P>> {
  if (params.provider || params.model || !workspaceId) return { params, pick: null, canStepUp: false };
  const cfg = await loadTierConfig(workspaceId);
  const hasKey = (p: AiProviderId) =>
    p === "anthropic" ? !!creds.anthropicApiKey : p === "openai" ? !!creds.openaiApiKey : !!creds.geminiApiKey;
  const pick = pickTierModel({ task: params.task, stepUp, tiers: cfg.tiers, taskTiers: cfg.taskTiers, hasKey });
  return {
    params: pick.use ? { ...params, provider: pick.use.provider, model: pick.use.model } : params,
    pick,
    canStepUp: canStepUp(pick, { tiers: cfg.tiers, taskTiers: cfg.taskTiers, hasKey }),
  };
}
