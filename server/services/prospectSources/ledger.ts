/**
 * SourceBudgetLedger — per-workspace, per-vendor, per-period unit accounting
 * with vendor-specific reset semantics.
 *
 * The reservation is ATOMIC in SQL: a conditional UPDATE that only succeeds
 * when `consumed + reserved + n <= limit` (the googlePlaces.reserveBudget
 * shape — affectedRows is the verdict). Two concurrent runs at the last
 * unit cannot both spend it: the second UPDATE matches zero rows. No Redis;
 * this deployment has none, and MySQL's row lock is the same guarantee.
 *
 * Reset semantics are NOT modelled here. Each adapter's `budgetPeriods`
 * resolver names the rows that apply right now (period key + limit +
 * resets_at); the ledger only ensures those rows exist and meters them.
 * WarmySender leads therefore get a daily-pace row AND a billing-anniversary
 * monthly row AND (optionally) a non-expiring credits row; a reservation
 * must clear every capped plan row, or fall through to credits.
 *
 * Lifecycle per waterfall step:  reserve(n) → vendor call → commit(actual)
 * (or release() on failure). `unitsReserved` is what an in-flight run holds;
 * a run that dies mid-way (deploy restart) leaves a hold that the nightly
 * refresh clears (releaseStaleHolds).
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { prospectSourceBudgetLedger } from "../../../drizzle/schema";
import { getDb } from "../../db";
import type { BudgetBucket, ProspectSourceSlug } from "@shared/prospectSources";
import type { BudgetPeriod } from "./types";

export interface Reservation {
  slug: ProspectSourceSlug;
  bucket: BudgetBucket;
  units: number;
  /** Ledger row ids holding the reservation. */
  rowIds: number[];
  fundedBy: "plan" | "credits" | "uncapped";
}

export interface LedgerRowView {
  bucket: string;
  granularity: "daily" | "monthly" | "credits";
  periodKey: string;
  unitsConsumed: number;
  unitsReserved: number;
  unitsLimit: number | null;
  resetsAt: Date | null;
}

/** Make sure every period row exists; refresh limits/resets from the resolver. */
export async function ensurePeriodRows(
  workspaceId: number,
  slug: ProspectSourceSlug,
  periods: BudgetPeriod[],
): Promise<Map<string, number>> {
  const db = await getDb();
  const ids = new Map<string, number>();
  if (!db || periods.length === 0) return ids;
  for (let i = 0; i < periods.length; i++) {
    const p = periods[i];
    await db
      .insert(prospectSourceBudgetLedger)
      .values({
        workspaceId, sourceSlug: slug, bucket: p.bucket, granularity: p.granularity,
        periodKey: p.periodKey, unitsLimit: p.unitsLimit, resetsAt: p.resetsAt,
      } as never)
      // Limits can change (tier discovered, allowance edited) — refresh them;
      // never touch the counters here.
      .onDuplicateKeyUpdate({ set: { unitsLimit: p.unitsLimit, resetsAt: p.resetsAt } as never });
  }
  const rows = await db
    .select({ id: prospectSourceBudgetLedger.id, bucket: prospectSourceBudgetLedger.bucket, granularity: prospectSourceBudgetLedger.granularity, periodKey: prospectSourceBudgetLedger.periodKey })
    .from(prospectSourceBudgetLedger)
    .where(and(eq(prospectSourceBudgetLedger.workspaceId, workspaceId), eq(prospectSourceBudgetLedger.sourceSlug, slug)));
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    ids.set(`${r.bucket}|${r.granularity}|${r.periodKey}`, r.id);
  }
  return ids;
}

function rowKey(p: BudgetPeriod): string {
  return `${p.bucket}|${p.granularity}|${p.periodKey}`;
}

/**
 * Units still available for a bucket right now: the tightest capped plan row
 * (limit − consumed − reserved), plus any credits headroom; null when every
 * applicable row is uncapped.
 */
export async function remainingUnits(
  workspaceId: number,
  slug: ProspectSourceSlug,
  bucket: BudgetBucket,
  periods: BudgetPeriod[],
): Promise<{ plan: number | null; credits: number; total: number | null }> {
  const db = await getDb();
  const mine = periods.filter((p) => p.bucket === bucket);
  if (!db || mine.length === 0) return { plan: null, credits: 0, total: null };
  const ids = await ensurePeriodRows(workspaceId, slug, mine);
  const rows = await db
    .select()
    .from(prospectSourceBudgetLedger)
    .where(and(eq(prospectSourceBudgetLedger.workspaceId, workspaceId), inArray(prospectSourceBudgetLedger.id, Array.from(ids.values()).length ? Array.from(ids.values()) : [-1])));
  let plan: number | null = null;
  let credits = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r.bucket !== bucket) continue;
    if (r.granularity === "credits") {
      credits += Math.max(0, (r.unitsLimit ?? 0) - r.unitsConsumed - r.unitsReserved);
      continue;
    }
    if (r.unitsLimit == null) continue;
    const left = Math.max(0, r.unitsLimit - r.unitsConsumed - r.unitsReserved);
    plan = plan == null ? left : Math.min(plan, left);
  }
  return { plan, credits, total: plan == null ? null : plan + credits };
}

async function tryHold(db: NonNullable<Awaited<ReturnType<typeof getDb>>>, workspaceId: number, rowId: number, n: number): Promise<boolean> {
  const [res] = await db.execute(
    sql`UPDATE \`prospect_source_budget_ledger\`
        SET \`unitsReserved\` = \`unitsReserved\` + ${n}
        WHERE \`id\` = ${rowId} AND \`workspaceId\` = ${workspaceId}
          AND (\`unitsLimit\` IS NULL OR \`unitsConsumed\` + \`unitsReserved\` + ${n} <= \`unitsLimit\`)`,
  );
  return ((res as { affectedRows?: number })?.affectedRows ?? 0) > 0;
}

async function unhold(db: NonNullable<Awaited<ReturnType<typeof getDb>>>, workspaceId: number, rowIds: number[], n: number): Promise<void> {
  for (let i = 0; i < rowIds.length; i++) {
    await db.execute(
      sql`UPDATE \`prospect_source_budget_ledger\`
          SET \`unitsReserved\` = GREATEST(0, \`unitsReserved\` - ${n})
          WHERE \`id\` = ${rowIds[i]} AND \`workspaceId\` = ${workspaceId}`,
    );
  }
}

/**
 * Reserve `units` for a bucket. Plan rows first (every capped row must
 * admit the hold), then purchased credits. Returns null when nothing can
 * fund it — the caller asks `remainingUnits` for a smaller ask or skips.
 */
export async function reserve(
  workspaceId: number,
  slug: ProspectSourceSlug,
  bucket: BudgetBucket,
  units: number,
  periods: BudgetPeriod[],
): Promise<Reservation | null> {
  const db = await getDb();
  const mine = periods.filter((p) => p.bucket === bucket);
  if (!db || units <= 0) return null;
  if (mine.length === 0) return { slug, bucket, units, rowIds: [], fundedBy: "uncapped" };
  const ids = await ensurePeriodRows(workspaceId, slug, mine);
  const planRows = mine.filter((p) => p.granularity !== "credits").map((p) => ids.get(rowKey(p))).filter((x): x is number => typeof x === "number");
  const creditRows = mine.filter((p) => p.granularity === "credits").map((p) => ids.get(rowKey(p))).filter((x): x is number => typeof x === "number");

  const held: number[] = [];
  let ok = true;
  for (let i = 0; i < planRows.length; i++) {
    if (await tryHold(db, workspaceId, planRows[i], units)) held.push(planRows[i]);
    else { ok = false; break; }
  }
  if (ok) {
    const capped = mine.some((p) => p.granularity !== "credits" && p.unitsLimit != null);
    return { slug, bucket, units, rowIds: held, fundedBy: capped ? "plan" : "uncapped" };
  }
  await unhold(db, workspaceId, held, units);
  // Purchased credits skip the daily pace and draw down after plan leads.
  for (let i = 0; i < creditRows.length; i++) {
    if (await tryHold(db, workspaceId, creditRows[i], units)) {
      return { slug, bucket, units, rowIds: [creditRows[i]], fundedBy: "credits" };
    }
  }
  return null;
}

/** Turn a hold into spend: consumed += actual, reserved −= held. */
export async function commit(workspaceId: number, r: Reservation, actualUnits: number): Promise<void> {
  const db = await getDb();
  if (!db || r.rowIds.length === 0) return;
  const actual = Math.max(0, Math.round(actualUnits));
  for (let i = 0; i < r.rowIds.length; i++) {
    await db.execute(
      sql`UPDATE \`prospect_source_budget_ledger\`
          SET \`unitsConsumed\` = \`unitsConsumed\` + ${actual},
              \`unitsReserved\` = GREATEST(0, \`unitsReserved\` - ${r.units})
          WHERE \`id\` = ${r.rowIds[i]} AND \`workspaceId\` = ${workspaceId}`,
    );
  }
}

/** Drop a hold without spending (vendor call failed). */
export async function release(workspaceId: number, r: Reservation): Promise<void> {
  const db = await getDb();
  if (!db || r.rowIds.length === 0) return;
  await unhold(db, workspaceId, r.rowIds, r.units);
}

/** Record spend that happened without a prior hold (e.g. a refusal taught us). */
export async function recordSpend(
  workspaceId: number,
  slug: ProspectSourceSlug,
  bucket: BudgetBucket,
  units: number,
  periods: BudgetPeriod[],
): Promise<void> {
  const db = await getDb();
  const mine = periods.filter((p) => p.bucket === bucket && p.granularity !== "credits");
  if (!db || units <= 0 || mine.length === 0) return;
  const ids = await ensurePeriodRows(workspaceId, slug, mine);
  for (let i = 0; i < mine.length; i++) {
    const id = ids.get(rowKey(mine[i]));
    if (id == null) continue;
    await db.execute(
      sql`UPDATE \`prospect_source_budget_ledger\` SET \`unitsConsumed\` = \`unitsConsumed\` + ${Math.round(units)}
          WHERE \`id\` = ${id} AND \`workspaceId\` = ${workspaceId}`,
    );
  }
}

/** Mark a plan bucket exhausted for its current periods (the vendor refused for allowance). */
export async function markExhausted(
  workspaceId: number,
  slug: ProspectSourceSlug,
  bucket: BudgetBucket,
  periods: BudgetPeriod[],
): Promise<void> {
  const db = await getDb();
  const mine = periods.filter((p) => p.bucket === bucket && p.granularity === "daily");
  if (!db || mine.length === 0) return;
  const ids = await ensurePeriodRows(workspaceId, slug, mine);
  for (let i = 0; i < mine.length; i++) {
    const id = ids.get(rowKey(mine[i]));
    if (id == null) continue;
    // Clamp the limit to what was consumed so remainingUnits reads 0 today;
    // tomorrow's row is fresh. Learning from a refusal, not guessing.
    await db.execute(
      sql`UPDATE \`prospect_source_budget_ledger\` SET \`unitsLimit\` = \`unitsConsumed\`
          WHERE \`id\` = ${id} AND \`workspaceId\` = ${workspaceId}`,
    );
  }
}

/** Rows for the UI: current periods for one source. */
export async function ledgerView(workspaceId: number, slug: ProspectSourceSlug, periods: BudgetPeriod[]): Promise<LedgerRowView[]> {
  const db = await getDb();
  if (!db) return [];
  const ids = await ensurePeriodRows(workspaceId, slug, periods);
  const idList = Array.from(ids.values());
  if (idList.length === 0) return [];
  const rows = await db
    .select()
    .from(prospectSourceBudgetLedger)
    .where(and(eq(prospectSourceBudgetLedger.workspaceId, workspaceId), inArray(prospectSourceBudgetLedger.id, idList)));
  const wanted = new Set(periods.map(rowKey));
  return rows
    .filter((r) => wanted.has(`${r.bucket}|${r.granularity}|${r.periodKey}`))
    .map((r) => ({
      bucket: r.bucket, granularity: r.granularity, periodKey: r.periodKey,
      unitsConsumed: r.unitsConsumed, unitsReserved: r.unitsReserved, unitsLimit: r.unitsLimit, resetsAt: r.resetsAt,
    }));
}

/** Nightly: a hold older than the run that made it is a leak from a crashed run. */
export async function releaseStaleHolds(): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const [res] = await db.execute(
    sql`UPDATE \`prospect_source_budget_ledger\` SET \`unitsReserved\` = 0
        WHERE \`unitsReserved\` > 0 AND \`updatedAt\` < (NOW() - INTERVAL 2 HOUR)`,
  );
  return (res as { affectedRows?: number })?.affectedRows ?? 0;
}
