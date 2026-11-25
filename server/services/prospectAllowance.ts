/**
 * prospectAllowance — the monthly prospect-data allowance of a workspace on a
 * membership plan (owner approved 2026-11-25; the plans, numbers and
 * sentences are in shared/prospectAllowance.ts).
 *
 * WHAT IS METERED. Data a workspace takes with a key that is not its own: the
 * deployment's shared key, or a key another workspace lends it. Its own keys
 * are never counted, and a workspace with no plan is never counted or held
 * back at all.
 *
 * THE SHAPE EVERY COUNTING POINT USES (the executor's partial reservation):
 *
 *   const hold = await holdAllowance(ws, vendor, asked);  // shrink to what is left
 *   if (hold.granted === 0) → skip the source, say hold.reason where the run reports it
 *   … ask the vendor for at most hold.granted …
 *   await hold.settle(delivered);                         // count what arrived, give back the rest
 *
 * ATOMIC. tryConsume is a conditional UPDATE (`used <= limit − n`), so two
 * runs at the last units cannot both take them: the second matches no row,
 * re-reads what is left and asks for that. `used` never passes the plan's
 * number. A run that dies between hold and settle keeps its units counted
 * (an over-count against the member, never spend past the number).
 *
 * A FAILED READ IS NOT AN ANSWER (the failure-masking class): when the plan
 * or the key's origin cannot be read, the hold grants nothing shared and
 * says so (ALLOWANCE_UNKNOWN_REASON), and the error is logged. It never
 * becomes "unlimited" (the platform pays) nor "used up" (it may not be).
 * Own keys are unaffected: their origin decides before the allowance does.
 *
 * Usage rows are one per (workspace, UTC month): a new month is a new row,
 * so no job resets anything.
 */
import { and, eq, gte, lt, lte, sql } from "drizzle-orm";
import { prospectAllowanceUsage, prospectSourceCredentials, workspaceSettings } from "../../drizzle/schema";
import { getDb } from "../db";
import { tryDecryptSecret } from "../_core/crypto";
import { affectedRowsOf } from "../_core/claim";
import {
  ALLOWANCE_UNKNOWN_REASON,
  PLAN_MONTHLY_LIMIT,
  allowancePeriod,
  allowanceShrunkReason,
  allowanceUsedUpReason,
  buildAllowance,
  isMembershipPlan,
  type AllowanceState,
  type AllowanceVendor,
  type MembershipPlan,
  type ProspectAllowance,
} from "@shared/prospectAllowance";

/** The stored plan holds a value no setter writes: read as unknown, never as "no plan". */
export class UnknownPlanError extends Error {
  constructor(workspaceId: number, value: string) {
    super(`workspace ${workspaceId} has membershipPlan "${value.slice(0, 40)}", which is not a plan`);
    this.name = "UnknownPlanError";
  }
}

/**
 * The workspace's membership plan, or null when it is on none. THROWS when
 * the row cannot be read or holds a value that is not a plan, so a caller can
 * tell "no plan" from "could not tell". No database configured reads as no
 * plan: nothing can be stored or counted without one.
 */
export async function membershipPlanOf(workspaceId: number): Promise<MembershipPlan | null> {
  if (!workspaceId) return null;
  const db = await getDb();
  if (!db) return null;
  // Read by itself: a select naming a column the table does not have yet
  // (before migration 0444 lands) fails whole, and that failure must stay here.
  const [row] = await db
    .select({ plan: workspaceSettings.membershipPlan })
    .from(workspaceSettings)
    .where(eq(workspaceSettings.workspaceId, workspaceId))
    .limit(1);
  const v = row?.plan;
  if (v == null || v === "") return null;
  if (isMembershipPlan(v)) return v;
  throw new UnknownPlanError(workspaceId, String(v));
}

async function usedIn(workspaceId: number, period: string): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const [row] = await db
    .select({ used: prospectAllowanceUsage.used })
    .from(prospectAllowanceUsage)
    .where(and(eq(prospectAllowanceUsage.workspaceId, workspaceId), eq(prospectAllowanceUsage.period, period)))
    .limit(1);
  return Number(row?.used ?? 0);
}

/**
 * This month's allowance: `{ plan, limit, used, remaining, period, resetsOn }`,
 * or `{ plan: null }` when the workspace is on no plan (unlimited, uncounted).
 * Throws when it cannot be read; screens catch and say so.
 */
export async function allowanceFor(workspaceId: number, at: Date = new Date()): Promise<AllowanceState> {
  const plan = await membershipPlanOf(workspaceId);
  if (!plan) return { plan: null };
  const period = allowancePeriod(at);
  return buildAllowance(plan, await usedIn(workspaceId, period), period);
}

/**
 * Take up to `n` units of this month's allowance. Returns how many were
 * granted, 0..n: all of them when there is room, what is left when there is
 * less, 0 when the month is used up. A workspace on no plan is granted `n`
 * and nothing is recorded.
 *
 * Atomic: the UPDATE only applies while `used + take <= limit`, so a run that
 * loses a race re-reads what is left instead of overspending.
 *
 * `opts.limit` / `opts.period` let a caller that has already read the plan
 * skip the second read (holdAllowance); left out, the plan is read here and a
 * failed read throws.
 */
export async function tryConsume(workspaceId: number, n: number, opts: { limit?: number; period?: string } = {}): Promise<number> {
  const want = Math.floor(Number(n) || 0);
  if (want <= 0 || !workspaceId) return 0;
  let limit = opts.limit;
  if (limit == null) {
    const plan = await membershipPlanOf(workspaceId);
    if (!plan) return want;
    limit = PLAN_MONTHLY_LIMIT[plan];
  }
  const db = await getDb();
  // A plan was named but nothing can record it: grant nothing rather than spend uncounted.
  if (!db) return 0;
  const period = opts.period ?? allowancePeriod();
  // The month's row, made on first use. A duplicate is the row already there.
  await db
    .insert(prospectAllowanceUsage)
    .values({ workspaceId, period, used: 0 })
    .onDuplicateKeyUpdate({ set: { workspaceId } });
  for (let attempt = 0; attempt < 5; attempt++) {
    const used = await usedIn(workspaceId, period);
    const take = Math.min(want, limit - used);
    if (take <= 0) return 0;
    const res = await db
      .update(prospectAllowanceUsage)
      .set({ used: sql`${prospectAllowanceUsage.used} + ${take}` })
      .where(and(
        eq(prospectAllowanceUsage.workspaceId, workspaceId),
        eq(prospectAllowanceUsage.period, period),
        lte(prospectAllowanceUsage.used, limit - take),
      ));
    if (affectedRowsOf(res) > 0) return take;
    // Another run took units between the read and the write: read again.
  }
  return 0;
}

/** Give back `k` units of a period (default: this month) that were held and not delivered. Never below zero. */
export async function refund(workspaceId: number, k: number, period: string = allowancePeriod()): Promise<void> {
  const back = Math.floor(Number(k) || 0);
  if (back <= 0 || !workspaceId) return;
  const db = await getDb();
  if (!db) return;
  const where = (cmp: ReturnType<typeof gte>) => and(
    eq(prospectAllowanceUsage.workspaceId, workspaceId),
    eq(prospectAllowanceUsage.period, period),
    cmp,
  );
  const res = await db
    .update(prospectAllowanceUsage)
    .set({ used: sql`${prospectAllowanceUsage.used} + ${-back}` })
    .where(where(gte(prospectAllowanceUsage.used, back)));
  if (affectedRowsOf(res) === 0) {
    await db.update(prospectAllowanceUsage).set({ used: 0 }).where(where(lt(prospectAllowanceUsage.used, back)));
  }
}

/**
 * Set (or clear, with null) a workspace's membership plan. The ONE setter:
 * the platform owner's picker calls it today, and a membership-site webhook
 * can call it later. Returns the plan it replaced.
 */
export async function setMembershipPlan(workspaceId: number, plan: MembershipPlan | null): Promise<{ previous: string | null; plan: MembershipPlan | null }> {
  if (plan !== null && !isMembershipPlan(plan)) throw new Error(`"${String(plan)}" is not a membership plan`);
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");
  const [existing] = await db
    .select({ workspaceId: workspaceSettings.workspaceId, plan: workspaceSettings.membershipPlan })
    .from(workspaceSettings)
    .where(eq(workspaceSettings.workspaceId, workspaceId))
    .limit(1);
  if (existing) {
    await db.update(workspaceSettings).set({ membershipPlan: plan }).where(eq(workspaceSettings.workspaceId, workspaceId));
  } else {
    await db.insert(workspaceSettings).values({ workspaceId, membershipPlan: plan });
  }
  return { previous: existing?.plan ?? null, plan };
}

/** Whose key a vendor call for this workspace uses: its own, one it borrows (shared or lent), or none. */
export type KeyOrigin = "own" | "borrowed" | "none";

/**
 * Whose key this workspace would use for `vendor` right now. With `apiKey`
 * (a call site that already resolved its key), whether THAT key is the
 * workspace's own. The deployment's key pasted into a workspace's own field
 * is still the platform's account (services/spend keySourceOf), so it counts
 * as borrowed. Throws when the workspace's own key cannot be read.
 */
export async function keyOrigin(workspaceId: number, vendor: AllowanceVendor, apiKey?: string): Promise<KeyOrigin> {
  const db = await getDb();
  if (!db) return "none";
  if (vendor === "quickenrich" || vendor === "apollo") {
    const [row] = await db
      .select({ qe: workspaceSettings.quickenrichApiKeyEnc, ap: workspaceSettings.apolloApiKeyEnc })
      .from(workspaceSettings)
      .where(eq(workspaceSettings.workspaceId, workspaceId))
      .limit(1);
    const own = tryDecryptSecret(vendor === "quickenrich" ? row?.qe : row?.ap);
    const env = vendor === "quickenrich" ? (process.env.QUICKENRICH_API_KEY ?? "") : "";
    const ownIsOwn = !!own && own !== env;
    if (apiKey !== undefined) return !apiKey ? "none" : ownIsOwn && apiKey === own ? "own" : "borrowed";
    if (ownIsOwn) return "own";
    const resolved = vendor === "quickenrich"
      ? await (await import("./quickenrich")).getQuickEnrichKey(workspaceId)
      : await (await import("./apollo")).getApolloKey(workspaceId);
    return resolved ? "borrowed" : "none";
  }
  // WarmySender and LeadOcean keep their keys as prospect_source_credentials rows.
  const { parseSecrets } = await import("./prospectSources/credentials");
  const [row] = await db
    .select({ status: prospectSourceCredentials.status, enc: prospectSourceCredentials.credentialsEnc })
    .from(prospectSourceCredentials)
    .where(and(eq(prospectSourceCredentials.workspaceId, workspaceId), eq(prospectSourceCredentials.sourceSlug, vendor)))
    .limit(1);
  if (row && row.status !== "revoked" && parseSecrets(row.enc).apiKey) return "own";
  const { linkedSourceRow } = await import("./keyShares");
  const lent = await linkedSourceRow(workspaceId, vendor);
  return lent && parseSecrets(lent.row.credentialsEnc).apiKey ? "borrowed" : "none";
}

/** What one counting point may take, and how it gives back what it did not use. */
export type AllowanceHold = {
  /** True when this request is counted: a plan, and a borrowed key. */
  metered: boolean;
  asked: number;
  /** At most `asked`. Ask the vendor for no more than this. */
  granted: number;
  /** Why fewer than asked were granted (member-facing), or null. */
  reason: string | null;
  /** The month's allowance as read after the hold, when metered and readable. */
  allowance: ProspectAllowance | null;
  /** Count `delivered` (0..granted) and give back the rest. Only the first call counts. */
  settle(delivered: number): Promise<void>;
};

const unmetered = (asked: number): AllowanceHold => ({
  metered: false, asked, granted: asked, reason: null, allowance: null, settle: async () => {},
});

const blocked = (asked: number, reason: string, allowance: ProspectAllowance | null = null): AllowanceHold => ({
  metered: true, asked, granted: 0, reason, allowance, settle: async () => {},
});

function logUnreadable(workspaceId: number, vendor: AllowanceVendor, what: string, e: unknown): void {
  console.error(
    `[prospectAllowance] could not read ${what} of workspace ${workspaceId} (${vendor}); shared prospect data is not used until it can be read:`,
    e instanceof Error ? e.message : String(e),
  );
}

/**
 * Hold up to `n` units for one request to `vendor`. Unmetered (granted = n,
 * nothing recorded) when the workspace is on no plan, or when the key it would
 * use is its own or there is none. Metered otherwise: granted is what is left,
 * up to n, and `settle(delivered)` gives back what was not delivered.
 *
 * `opts.apiKey`: the key the call site already resolved (the QuickEnrich email
 * lookup), so the origin is judged on the key actually used.
 */
export async function holdAllowance(
  workspaceId: number | null | undefined,
  vendor: AllowanceVendor,
  n: number,
  opts: { apiKey?: string } = {},
): Promise<AllowanceHold> {
  const asked = Math.max(0, Math.floor(Number(n) || 0));
  if (!workspaceId || asked === 0) return unmetered(asked);

  let plan: MembershipPlan | null = null;
  let planUnknown = false;
  try {
    plan = await membershipPlanOf(workspaceId);
  } catch (e) {
    planUnknown = true;
    logUnreadable(workspaceId, vendor, "the membership plan", e);
  }
  if (!planUnknown && !plan) return unmetered(asked);

  let origin: KeyOrigin;
  try {
    origin = await keyOrigin(workspaceId, vendor, opts.apiKey);
  } catch (e) {
    logUnreadable(workspaceId, vendor, "whose key is in use", e);
    return blocked(asked, ALLOWANCE_UNKNOWN_REASON);
  }
  // Own keys are never counted; with no key the source fetches nothing and says why itself.
  if (origin !== "borrowed") return unmetered(asked);
  if (planUnknown || !plan) return blocked(asked, ALLOWANCE_UNKNOWN_REASON);

  const period = allowancePeriod();
  const limit = PLAN_MONTHLY_LIMIT[plan];
  let granted: number;
  try {
    granted = await tryConsume(workspaceId, asked, { limit, period });
  } catch (e) {
    logUnreadable(workspaceId, vendor, "this month's prospect-data usage", e);
    return blocked(asked, ALLOWANCE_UNKNOWN_REASON);
  }
  let view: ProspectAllowance;
  try {
    view = buildAllowance(plan, await usedIn(workspaceId, period), period);
  } catch {
    // The hold stands; only the sentence needs the figure, and a short grant means the month ran out.
    view = buildAllowance(plan, granted < asked ? limit : 0, period);
  }
  if (granted === 0) return blocked(asked, allowanceUsedUpReason(view), view);

  let settled = false;
  return {
    metered: true,
    asked,
    granted,
    reason: granted < asked ? allowanceShrunkReason(view, granted, asked) : null,
    allowance: view,
    async settle(delivered: number) {
      if (settled) return;
      settled = true;
      const d = Math.floor(Number(delivered) || 0);
      if (d > granted) {
        // The caller took more than it was granted; only the grant is counted.
        console.warn(`[prospectAllowance] workspace ${workspaceId} ${vendor}: ${d} delivered against a hold of ${granted}; counted ${granted}.`);
      }
      const back = granted - Math.max(0, Math.min(d, granted));
      try {
        await refund(workspaceId, back, period);
      } catch (e) {
        // Left counted: an over-count against the member, never spend past the number.
        console.error(`[prospectAllowance] could not give back ${back} unit(s) to workspace ${workspaceId}:`, e instanceof Error ? e.message : String(e));
      }
    },
  };
}
