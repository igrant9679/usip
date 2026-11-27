/**
 * The platform's default AI provider (owner decision 2026-11-27,
 * openrouter-spec.md: "a platform setting chooses the default provider for
 * workspaces with no AI choice or key").
 *
 * One platform_settings row, `aiDefaultProvider`, that only the platform
 * owner (users.role 'admin') sets, on Settings → Integrations. ABSENT UNTIL
 * SET, and absent means exactly what happened before it existed: the
 * deployment's AI_DEFAULT_PROVIDER, then the fallback order (Anthropic
 * first). It stays that way until the owner switches it.
 *
 * It decides only for a workspace that has made no choice of its own AND
 * holds no AI key of its own (or lent to it). A workspace that pasted its own
 * Anthropic key is never moved onto the platform's shared OpenRouter key, the
 * owner's money, by this switch; nor is one whose admin picked a default.
 *
 * Read on every model call, so cached briefly; a save clears the cache. A
 * failed read is "not set", which is today's behaviour.
 */
import { eq } from "drizzle-orm";
import { platformSettings } from "../../drizzle/schema";
import { getDb } from "../db";
import { isAiProviderId, type AiProviderId } from "@shared/aiTiers";

export const AI_DEFAULT_SETTING_KEY = "aiDefaultProvider";

const TTL_MS = 30_000;
let cache: { at: number; value: AiProviderId | null } | null = null;

export function invalidatePlatformAiCache(): void {
  cache = null;
}

/** The platform owner's default provider, or null: not set. */
export async function platformDefaultProvider(now: number = Date.now()): Promise<AiProviderId | null> {
  if (cache && now - cache.at < TTL_MS) return cache.value;
  let value: AiProviderId | null = null;
  try {
    const db = await getDb();
    if (!db) return null;
    const [row] = await db
      .select({ value: platformSettings.value })
      .from(platformSettings)
      .where(eq(platformSettings.settingKey, AI_DEFAULT_SETTING_KEY))
      .limit(1);
    const provider = (row?.value as { provider?: unknown } | null)?.provider;
    value = isAiProviderId(provider) ? provider : null;
  } catch (e) {
    console.error("[platformAi] the platform default provider is unreadable; using the deployment's:", (e as Error)?.message);
    return null;
  }
  cache = { at: now, value };
  return value;
}

/** Set (or, with null, clear) the platform default. Platform owner only: the router checks. */
export async function setPlatformDefaultProvider(provider: AiProviderId | null): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  const value = { provider };
  const [existing] = await db
    .select({ k: platformSettings.settingKey })
    .from(platformSettings)
    .where(eq(platformSettings.settingKey, AI_DEFAULT_SETTING_KEY))
    .limit(1);
  if (existing) await db.update(platformSettings).set({ value }).where(eq(platformSettings.settingKey, AI_DEFAULT_SETTING_KEY));
  else await db.insert(platformSettings).values({ settingKey: AI_DEFAULT_SETTING_KEY, value });
  invalidatePlatformAiCache();
}

/**
 * The provider a call prefers, before keys are checked (resolveProvider in
 * both model funnels then takes it if it has a key, else the fallback order):
 *
 *   1. the workspace's own choice (Settings → Integrations, Set default);
 *   2. the platform default, only for a workspace with no AI key of its own;
 *   3. the deployment's AI_DEFAULT_PROVIDER, as before.
 */
export async function preferredProvider(workspaceChoice: string | null | undefined, hasOwnKey: boolean, envDefault: string): Promise<string> {
  if (workspaceChoice) return workspaceChoice;
  if (!hasOwnKey) {
    const platform = await platformDefaultProvider();
    if (platform) return platform;
  }
  return envDefault;
}
