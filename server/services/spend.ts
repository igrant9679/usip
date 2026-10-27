/**
 * spend.ts — the one place a paid call is counted (audit 2026-10-20, Phase 3).
 *
 * 🔴 THE GAP. usage_counters counted LLM tokens only for calls that went
 * through invokeLLM inside a workspace request. Streamed replies (streamLLM)
 * were never counted, background engines that passed no workspace used the
 * platform key unmetered, and Reoon verifications and QuickEnrich hits were
 * not counted anywhere. No report could match a vendor's dashboard.
 *
 * Now every vendor's paid call goes through one function per vendor that
 * calls recordSpend here: one row per (workspace, UTC day, vendor, meter,
 * model, key source, feature) in spend_ledger, incremented atomically. The
 * day is UTC because that is how the vendors' own usage pages bucket it.
 *
 *   - `meter` is the vendor's billing unit, named as their dashboard names it
 *     (input_tokens, daily_credits, email_hits…).
 *   - `keySource` is whose account paid: "workspace" = its own key, "shared" =
 *     the deployment's env key. The shared key is the platform's money, which
 *     is why its use is opt-in per workspace (owner decision 2026-10-27).
 *   - workspaceId 0 = a call no workspace could be found for. It is still
 *     counted, because the vendor still billed it; the report shows it so it
 *     can be driven to zero.
 *
 * BEST EFFORT, like usageCounters.bump: a broken ledger is a reporting
 * problem, a thrown one is an outage of whatever it measured. Never rethrows.
 */
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { spendLedger, workspaceSettings } from "../../drizzle/schema";
import { getDb } from "../db";

export type SpendVendor =
  | "anthropic"
  | "openai"
  | "gemini"
  | "reoon"
  | "quickenrich"
  | "apollo"
  | "warmysender"
  | "linkedin";

export type KeySource = "workspace" | "shared";

export const UNATTRIBUTED_WORKSPACE = 0;

export type SpendEvent = {
  workspaceId: number | null | undefined;
  vendor: SpendVendor;
  meter: string;
  quantity: number;
  keySource: KeySource;
  model?: string | null;
  /** What spent it: the tRPC path for a request, a short tag for an engine. */
  feature?: string | null;
};

/** The ledger's day: UTC, as the vendors' usage pages bucket it. */
export function spendDay(at: Date = new Date()): string {
  return at.toISOString().slice(0, 10);
}

/**
 * Whose account a key belongs to. A workspace that pasted the deployment's
 * own key is billed to the same account, so it counts as shared too.
 */
export function keySourceOf(key: string, sharedKey: string | null | undefined): KeySource {
  return sharedKey && key === sharedKey ? "shared" : "workspace";
}

const warnedUnattributed = new Set<string>();

export async function recordSpend(e: SpendEvent): Promise<void> {
  const quantity = Math.round(Number(e.quantity));
  if (!Number.isFinite(quantity) || quantity <= 0) return;
  const workspaceId = e.workspaceId && e.workspaceId > 0 ? e.workspaceId : UNATTRIBUTED_WORKSPACE;
  const feature = String(e.feature ?? "").slice(0, 96);
  if (workspaceId === UNATTRIBUTED_WORKSPACE && !warnedUnattributed.has(`${e.vendor}:${feature}`)) {
    warnedUnattributed.add(`${e.vendor}:${feature}`);
    console.warn(`[spend] ${e.vendor} ${e.meter} with no workspace (feature "${feature || "unknown"}"); counted as unattributed.`);
  }
  try {
    const db = await getDb();
    if (!db) return;
    await db
      .insert(spendLedger)
      .values({
        workspaceId,
        day: spendDay(),
        vendor: e.vendor,
        meter: e.meter.slice(0, 32),
        model: String(e.model ?? "").slice(0, 96),
        keySource: e.keySource,
        feature,
        quantity,
        calls: 1,
      })
      .onDuplicateKeyUpdate({
        set: {
          quantity: sql`${spendLedger.quantity} + ${quantity}`,
          calls: sql`${spendLedger.calls} + 1`,
        },
      });
  } catch (err) {
    console.error(
      `[spend] failed to record ${quantity} ${e.vendor} ${e.meter} for workspace ${workspaceId}:`,
      err instanceof Error ? err.message : String(err),
    );
  }
}

export type AiVendor = "anthropic" | "openai" | "gemini";

/** One model call's usage, in the units the provider bills. */
export type AiUsage = {
  input?: number | null;
  output?: number | null;
  cacheWrite?: number | null;
  cacheRead?: number | null;
  webSearches?: number | null;
};

/**
 * A model call's tokens, one meter each, so the report can line up with the
 * provider's usage page (which splits input, output and cache) and price
 * each at its own rate.
 */
export async function recordAiUsage(e: {
  workspaceId: number | null | undefined;
  vendor: AiVendor;
  model: string | null | undefined;
  keySource: KeySource;
  feature: string | null | undefined;
  usage: AiUsage;
}): Promise<void> {
  const base = { workspaceId: e.workspaceId, vendor: e.vendor, model: e.model, keySource: e.keySource, feature: e.feature };
  const u = e.usage;
  await recordSpend({ ...base, meter: "input_tokens", quantity: u.input ?? 0 });
  await recordSpend({ ...base, meter: "output_tokens", quantity: u.output ?? 0 });
  await recordSpend({ ...base, meter: "cache_write_tokens", quantity: u.cacheWrite ?? 0 });
  await recordSpend({ ...base, meter: "cache_read_tokens", quantity: u.cacheRead ?? 0 });
  await recordSpend({ ...base, meter: "web_searches", quantity: u.webSearches ?? 0 });
}

/** Test seam for the once-per-feature warning. */
export function __resetSpendWarningsForTests(): void {
  warnedUnattributed.clear();
}

/* ─── Shared deployment keys (opt-in per workspace) ─────────────────────── */

export type SharedKeyVendor = "reoon" | "quickenrich";

/** The meters a shared key's daily cap counts: the vendor's paid units. */
export const SHARED_CAP_METERS: Record<SharedKeyVendor, string[]> = {
  reoon: ["daily_credits", "bulk_emails"],
  quickenrich: ["email_hits"],
};

export type SharedKeyPolicy = { allowed: boolean; dailyCap: number | null };

export async function sharedKeyPolicy(workspaceId: number, vendor: SharedKeyVendor): Promise<SharedKeyPolicy> {
  const db = await getDb();
  if (!db) return { allowed: false, dailyCap: null };
  const [row] = await db
    .select({
      reoon: workspaceSettings.sharedReoonKey,
      quickenrich: workspaceSettings.sharedQuickenrichKey,
      reoonCap: workspaceSettings.sharedReoonDailyCap,
      quickenrichCap: workspaceSettings.sharedQuickenrichDailyCap,
    })
    .from(workspaceSettings)
    .where(eq(workspaceSettings.workspaceId, workspaceId))
    .limit(1);
  if (!row) return { allowed: false, dailyCap: null };
  return vendor === "reoon"
    ? { allowed: !!row.reoon, dailyCap: row.reoonCap ?? null }
    : { allowed: !!row.quickenrich, dailyCap: row.quickenrichCap ?? null };
}

/** Paid units this workspace has spent on the shared key today (UTC). */
export async function sharedUsedToday(workspaceId: number, vendor: SharedKeyVendor): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const [row] = await db
    .select({ n: sql<number>`COALESCE(SUM(${spendLedger.quantity}), 0)` })
    .from(spendLedger)
    .where(
      and(
        eq(spendLedger.workspaceId, workspaceId),
        eq(spendLedger.day, spendDay()),
        eq(spendLedger.vendor, vendor),
        eq(spendLedger.keySource, "shared"),
        inArray(spendLedger.meter, SHARED_CAP_METERS[vendor]),
      ),
    );
  return Number(row?.n ?? 0);
}

export type SharedKeyVerdict = { ok: true } | { ok: false; reason: "not_allowed" | "cap_reached"; detail: string };

/**
 * May this workspace spend on the deployment's key right now? Not unless the
 * platform owner switched it on, and not past the daily cap when one is set.
 */
export async function sharedKeyUsable(workspaceId: number, vendor: SharedKeyVendor): Promise<SharedKeyVerdict> {
  const policy = await sharedKeyPolicy(workspaceId, vendor);
  if (!policy.allowed) {
    return { ok: false, reason: "not_allowed", detail: `this workspace has no ${vendor} key of its own and is not allowed the shared one` };
  }
  if (policy.dailyCap !== null) {
    const used = await sharedUsedToday(workspaceId, vendor);
    if (used >= policy.dailyCap) {
      return { ok: false, reason: "cap_reached", detail: `the shared ${vendor} key's daily cap for this workspace (${policy.dailyCap}) is used up` };
    }
  }
  return { ok: true };
}

/* ─── Reading it back ───────────────────────────────────────────────────── */

export type SpendTotal = {
  workspaceId: number;
  day: string;
  vendor: string;
  meter: string;
  model: string;
  keySource: string;
  feature: string;
  quantity: number;
  calls: number;
};

/** Ledger rows from `fromDay` (inclusive, UTC), for one workspace or all. */
export async function spendSince(fromDay: string, workspaceId?: number): Promise<SpendTotal[]> {
  const db = await getDb();
  if (!db) return [];
  const rows = await db
    .select()
    .from(spendLedger)
    .where(
      workspaceId === undefined
        ? gte(spendLedger.day, fromDay)
        : and(eq(spendLedger.workspaceId, workspaceId), gte(spendLedger.day, fromDay)),
    );
  return rows.map((r) => ({
    workspaceId: r.workspaceId,
    day: r.day,
    vendor: r.vendor,
    meter: r.meter,
    model: r.model,
    keySource: r.keySource,
    feature: r.feature,
    quantity: Number(r.quantity),
    calls: Number(r.calls),
  }));
}
