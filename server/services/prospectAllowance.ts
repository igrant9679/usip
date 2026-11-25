/**
 * prospectAllowance — the monthly prospect-data allowance of a workspace on a
 * membership plan (owner approved 2026-11-25; the plans, numbers and
 * sentences are in shared/prospectAllowance.ts).
 *
 * WHAT IS METERED. Data a workspace takes with a key that is not its own: the
 * deployment's shared key, a key another workspace lends it, or the shared
 * prospect pool (services/prospectPool). Its own keys are never counted. A
 * workspace on a plan is charged once per person, ever (prospect_allowance_
 * people), within its month and its plan's daily cap per source; pool use by
 * any workspace is also held against the source's platform ceiling.
 *
 * THE SHAPE EVERY COUNTING POINT USES (the executor's partial reservation):
 *
 *   const hold = await holdAllowance(ws, vendor, asked);  // shrink to what is left
 *   if (hold.granted === 0) → skip the source, say hold.reason where the run reports it
 *   … ask the vendor for at most hold.granted …
 *   await hold.settle(people);                            // count who arrived (once each), give back the rest
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
import { and, eq, gte, inArray, lt, lte, sql } from "drizzle-orm";
import { prospectAllowanceDaily, prospectAllowancePeople, prospectAllowanceUsage, prospectSourceCredentials, workspaceSettings } from "../../drizzle/schema";
import { getDb } from "../db";
import { tryDecryptSecret } from "../_core/crypto";
import { affectedRowsOf } from "../_core/claim";
import { linkedKeyVia, linkedSourceRow } from "./keyShares";
import { extractLinkedInIdentifier } from "./linkedinLookup";
import { nameOrgDedupKey } from "./are/queueIdentity";
import { sourceUsedUpMessage } from "@shared/sourceNames";
import {
  ALLOWANCE_UNKNOWN_REASON,
  PLAN_MONTHLY_LIMIT,
  allowanceDay,
  allowancePeriod,
  allowanceShrunkReason,
  allowanceUsedUpReason,
  buildAllowance,
  dailyCapReachedReason,
  isMembershipPlan,
  planDailyCap,
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

/* ─── Whose key ─────────────────────────────────────────────────────────── */

/** Whose key a vendor call for this workspace uses, in detail. */
export type KeyOriginDetail = "own" | "loan" | "pool" | "env" | "none";
/** The coarse form: its own, one it borrows (lent, pooled or the deployment's), or none. */
export type KeyOrigin = "own" | "borrowed" | "none";

/**
 * Whose key this workspace would use for `vendor` right now. With `apiKey`
 * (a call site that already resolved its key), whose THAT key is. The
 * deployment's key pasted into a workspace's own field is still the
 * platform's account (services/spend keySourceOf), so it counts as "env".
 * Throws when the workspace's own key cannot be read.
 */
export async function keyOriginDetail(workspaceId: number, vendor: AllowanceVendor, apiKey?: string): Promise<KeyOriginDetail> {
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
    const key = apiKey !== undefined
      ? apiKey
      : ownIsOwn ? own
      : vendor === "quickenrich"
        ? await (await import("./quickenrich")).getQuickEnrichKey(workspaceId)
        : await (await import("./apollo")).getApolloKey(workspaceId);
    if (!key) return "none";
    if (ownIsOwn && key === own) return "own";
    const via = await linkedKeyVia(workspaceId, vendor, key);
    if (via) return via;
    // The deployment's key, or a key that is the platform's however it was pasted.
    return "env";
  }
  // Table-mode sources keep their keys as prospect_source_credentials rows.
  const { parseSecrets } = await import("./prospectSources/credentials");
  const [row] = await db
    .select({ status: prospectSourceCredentials.status, enc: prospectSourceCredentials.credentialsEnc })
    .from(prospectSourceCredentials)
    .where(and(eq(prospectSourceCredentials.workspaceId, workspaceId), eq(prospectSourceCredentials.sourceSlug, vendor)))
    .limit(1);
  if (row && row.status !== "revoked" && parseSecrets(row.enc).apiKey) return "own";
  // A lent or pooled key resolves through services/keyShares, as every shareable key read must.
  const lent = await linkedSourceRow(workspaceId, vendor);
  return lent && parseSecrets(lent.row.credentialsEnc).apiKey ? lent.via : "none";
}

export async function keyOrigin(workspaceId: number, vendor: AllowanceVendor, apiKey?: string): Promise<KeyOrigin> {
  const d = await keyOriginDetail(workspaceId, vendor, apiKey);
  return d === "own" || d === "none" ? d : "borrowed";
}

/* ─── Each person once ──────────────────────────────────────────────────── */

/** Who a unit of prospect data is about: whatever of these the row carries. */
export type PersonIdentity = {
  linkedinUrl?: string | null;
  email?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  companyName?: string | null;
  companyDomain?: string | null;
};

/**
 * A person's keys for the count-once table (owner 2026-11-25: "a person counts
 * once per workspace, ever"): li:<LinkedIn profile slug> (the identity every
 * prospect source and the email lookup are keyed on), e:<lower-cased email>,
 * and only when a person has neither, n:<canonical name>@<company domain or
 * name> — the same name-and-company key the dedupe already treats as one
 * person (services/are/queueIdentity), so a key here never claims someone the
 * dedupe would call a stranger. Every key a person has is recorded, so a
 * person first counted by LinkedIn is recognised later by email, and back.
 */
export function personKeys(p: PersonIdentity): string[] {
  const out: string[] = [];
  const url = String(p.linkedinUrl ?? "").trim().toLowerCase();
  if (url) {
    const slug = extractLinkedInIdentifier(url);
    const bare = url.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/+$/, "");
    out.push(`li:${(slug ?? bare).slice(0, 180)}`);
  }
  const email = String(p.email ?? "").trim().toLowerCase();
  if (email && email.includes("@")) out.push(`e:${email.slice(0, 185)}`);
  if (out.length === 0) {
    const nk = nameOrgDedupKey({ firstName: p.firstName ?? null, lastName: p.lastName ?? null, companyName: p.companyName ?? null, companyDomain: p.companyDomain ?? null });
    if (nk) out.push(nk.slice(0, 191));
  }
  return out;
}

/** Whether this workspace has counted this person already (any of their keys). */
export async function personCounted(workspaceId: number, p: PersonIdentity): Promise<boolean> {
  const keys = personKeys(p);
  if (keys.length === 0) return false;
  const db = await getDb();
  if (!db) return false;
  const [row] = await db.select({ id: prospectAllowancePeople.id }).from(prospectAllowancePeople)
    .where(and(eq(prospectAllowancePeople.workspaceId, workspaceId), inArray(prospectAllowancePeople.personKey, keys)))
    .limit(1);
  return !!row;
}

/**
 * Claim a person for this workspace: true when this call counted them (none
 * of their keys was there and this call wrote the first one), false when
 * they were counted before or by a concurrent call. A person with no key at
 * all cannot be recognised again and is counted each time.
 */
async function claimPerson(workspaceId: number, p: PersonIdentity, period: string, allowNew = true): Promise<boolean> {
  const keys = personKeys(p);
  if (keys.length === 0) return allowNew;
  const db = await getDb();
  if (await personCounted(workspaceId, p)) {
    // Counted before: record any key they have now and did not then (an email
    // found for someone counted by LinkedIn), so they are known by it too.
    if (db) for (const k of keys) await db.insert(prospectAllowancePeople).values({ workspaceId, personKey: k, period }).onDuplicateKeyUpdate({ set: { workspaceId } });
    return false;
  }
  if (!allowNew) return false;
  if (!db) return true;
  const res = await db.insert(prospectAllowancePeople).values({ workspaceId, personKey: keys[0], period })
    .onDuplicateKeyUpdate({ set: { workspaceId } });
  // The first key decides: 0 rows written means someone counted them a moment ago.
  if (affectedRowsOf(res) !== 1) return false;
  for (const k of keys.slice(1)) {
    await db.insert(prospectAllowancePeople).values({ workspaceId, personKey: k, period })
      .onDuplicateKeyUpdate({ set: { workspaceId } });
  }
  return true;
}

/* ─── The daily cap for shared use ──────────────────────────────────────── */

async function dailyUsedIn(workspaceId: number, source: string, day: string): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const [row] = await db.select({ used: prospectAllowanceDaily.used }).from(prospectAllowanceDaily)
    .where(and(eq(prospectAllowanceDaily.workspaceId, workspaceId), eq(prospectAllowanceDaily.source, source), eq(prospectAllowanceDaily.day, day)))
    .limit(1);
  return Number(row?.used ?? 0);
}

/** Today's shared prospect data from one source, for a workspace on a plan. */
export async function dailyUsedToday(workspaceId: number, source: string): Promise<number> {
  return dailyUsedIn(workspaceId, source, allowanceDay());
}

async function tryConsumeDaily(workspaceId: number, source: string, n: number, cap: number, day: string): Promise<number> {
  const want = Math.floor(Number(n) || 0);
  if (want <= 0) return 0;
  const db = await getDb();
  if (!db) return 0;
  await db.insert(prospectAllowanceDaily).values({ workspaceId, source, day, used: 0 }).onDuplicateKeyUpdate({ set: { workspaceId } });
  for (let attempt = 0; attempt < 5; attempt++) {
    const used = await dailyUsedIn(workspaceId, source, day);
    const take = Math.min(want, cap - used);
    if (take <= 0) return 0;
    const res = await db.update(prospectAllowanceDaily).set({ used: sql`${prospectAllowanceDaily.used} + ${take}` })
      .where(and(eq(prospectAllowanceDaily.workspaceId, workspaceId), eq(prospectAllowanceDaily.source, source), eq(prospectAllowanceDaily.day, day), lte(prospectAllowanceDaily.used, cap - take)));
    if (affectedRowsOf(res) > 0) return take;
  }
  return 0;
}

async function refundDaily(workspaceId: number, source: string, k: number, day: string): Promise<void> {
  const back = Math.floor(Number(k) || 0);
  if (back <= 0) return;
  const db = await getDb();
  if (!db) return;
  const where = (cmp: ReturnType<typeof gte>) => and(eq(prospectAllowanceDaily.workspaceId, workspaceId), eq(prospectAllowanceDaily.source, source), eq(prospectAllowanceDaily.day, day), cmp);
  const res = await db.update(prospectAllowanceDaily).set({ used: sql`${prospectAllowanceDaily.used} + ${-back}` }).where(where(gte(prospectAllowanceDaily.used, back)));
  if (affectedRowsOf(res) === 0) await db.update(prospectAllowanceDaily).set({ used: 0 }).where(where(lt(prospectAllowanceDaily.used, back)));
}

/** The plan's daily cap for shared use, or null when the workspace is on no plan (or it cannot be read). */
export async function planDailyCapFor(workspaceId: number): Promise<number | null> {
  try {
    const plan = await membershipPlanOf(workspaceId);
    return plan ? planDailyCap(plan) : null;
  } catch {
    return null;
  }
}

/**
 * The daily cap a source runs under for this workspace: the plan's
 * ceil(monthly / 10) when a workspace on a plan uses a key that is not its own
 * (owner 2026-11-25: it replaces the vendor's lower cap for shared use only),
 * else the source's own cap. The one function every cap and every screen that
 * shows a cap asks.
 */
export async function effectiveDailyCap(workspaceId: number, vendor: AllowanceVendor, ownCap: number): Promise<number> {
  try {
    const plan = await membershipPlanOf(workspaceId);
    if (!plan) return ownCap;
    const origin = await keyOriginDetail(workspaceId, vendor);
    return origin === "own" || origin === "none" ? ownCap : planDailyCap(plan);
  } catch {
    return ownCap;
  }
}

/* ─── The hold ──────────────────────────────────────────────────────────── */

/** What one counting point may take, and how it gives back what it did not use. */
export type AllowanceHold = {
  /** True when this request is counted against the workspace's plan or the pool's ceiling. */
  metered: boolean;
  asked: number;
  /** At most `asked`. Ask the vendor for no more than this. */
  granted: number;
  /** Why fewer than asked were granted (member-facing), or null. */
  reason: string | null;
  /** The month's allowance as read after the hold, when the workspace is on a plan and it was readable. */
  allowance: ProspectAllowance | null;
  /**
   * Count what arrived and give back the rest. `delivered` is who arrived
   * (each person counts once per workspace, ever: one already counted costs
   * nothing more), or a bare number for units with no person attached. Pool
   * units are counted for everything delivered: the vendor charged for them.
   * Only the first call counts.
   */
  settle(delivered: PersonIdentity[] | number): Promise<void>;
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
 * Hold up to `n` units for one request to `vendor`.
 *
 *   - own key, or no key: unmetered (granted = n, nothing recorded);
 *   - a key that is not its own, workspace on a plan: the month's allowance,
 *     the plan's daily cap for this source, and (from the pool) the source's
 *     platform ceiling are all held, together: granted is the least of them;
 *   - from the pool, workspace on no plan: only the platform ceiling.
 *
 * `opts.person`: the one person a lookup is about (the email lookup). Someone
 * this workspace has counted before costs no allowance and no daily unit,
 * only the pool unit the vendor charges.
 */
export async function holdAllowance(
  workspaceId: number | null | undefined,
  vendor: AllowanceVendor,
  n: number,
  opts: { apiKey?: string; person?: PersonIdentity } = {},
): Promise<AllowanceHold> {
  const asked = Math.max(0, Math.floor(Number(n) || 0));
  if (!workspaceId || asked === 0) return unmetered(asked);

  let origin: KeyOriginDetail;
  try {
    origin = await keyOriginDetail(workspaceId, vendor, opts.apiKey);
  } catch (e) {
    logUnreadable(workspaceId, vendor, "whose key is in use", e);
    return blocked(asked, ALLOWANCE_UNKNOWN_REASON);
  }
  // Own keys are never counted; with no key the source fetches nothing and says why itself.
  if (origin === "own" || origin === "none") return unmetered(asked);

  let plan: MembershipPlan | null = null;
  try {
    plan = await membershipPlanOf(workspaceId);
  } catch (e) {
    logUnreadable(workspaceId, vendor, "the membership plan", e);
    return blocked(asked, ALLOWANCE_UNKNOWN_REASON);
  }
  const pooled = origin === "pool";
  if (!plan && !pooled) return unmetered(asked);

  const { poolConfig, tryConsumePool, refundPool, memberSourceLabel } = await import("./prospectPool");
  const period = allowancePeriod();
  const day = allowanceDay();
  const limit = plan ? PLAN_MONTHLY_LIMIT[plan] : 0;
  const dailyCap = plan ? planDailyCap(plan) : 0;
  let free = false;
  try {
    free = !!plan && !!opts.person && await personCounted(workspaceId, opts.person);
  } catch (e) {
    logUnreadable(workspaceId, vendor, "who it has counted", e);
    return blocked(asked, ALLOWANCE_UNKNOWN_REASON);
  }
  const chargesWorkspace = !!plan && !free;

  let monthly = asked, daily = asked, pool = asked;
  try {
    if (chargesWorkspace) {
      monthly = await tryConsume(workspaceId, asked, { limit, period });
      daily = monthly > 0 ? await tryConsumeDaily(workspaceId, vendor, monthly, dailyCap, day) : 0;
      if (daily < monthly) await refund(workspaceId, monthly - daily, period);
    }
    const want = chargesWorkspace ? daily : asked;
    if (pooled && want > 0) {
      const cfg = await poolConfig();
      pool = await tryConsumePool(vendor, want, cfg.sources[vendor]?.monthlyCeiling ?? null, period);
      if (chargesWorkspace && pool < want) {
        await refund(workspaceId, want - pool, period);
        await refundDaily(workspaceId, vendor, want - pool, day);
      }
    } else {
      pool = want;
    }
  } catch (e) {
    logUnreadable(workspaceId, vendor, "this month's prospect-data usage", e);
    return blocked(asked, ALLOWANCE_UNKNOWN_REASON);
  }
  const granted = Math.min(chargesWorkspace ? daily : asked, pool);

  let view: ProspectAllowance | null = null;
  if (plan) {
    try {
      view = buildAllowance(plan, await usedIn(workspaceId, period), period);
    } catch {
      view = buildAllowance(plan, chargesWorkspace && monthly < asked ? limit : 0, period);
    }
  }
  const label = await memberSourceLabel(vendor).catch(() => "This source");
  // Which of the holds ran short decides what the member is told.
  const why = (): string => {
    if (chargesWorkspace && monthly < asked && view) return monthly === 0 ? allowanceUsedUpReason(view) : allowanceShrunkReason(view, monthly, asked);
    if (chargesWorkspace && daily < monthly) return dailyCapReachedReason(label, dailyCap);
    return sourceUsedUpMessage(label);
  };
  if (granted === 0) return blocked(asked, why(), view);

  let settled = false;
  return {
    metered: true,
    asked,
    granted,
    reason: granted < asked ? why() : null,
    allowance: view,
    async settle(delivered: PersonIdentity[] | number) {
      if (settled) return;
      settled = true;
      const people = Array.isArray(delivered) ? delivered : null;
      const units = Math.max(0, Math.floor(people ? people.length : Number(delivered) || 0));
      if (units > granted) {
        console.warn(`[prospectAllowance] workspace ${workspaceId} ${vendor}: ${units} delivered against a hold of ${granted}; counted ${granted}.`);
      }
      const deliveredUnits = Math.min(units, granted);
      try {
        // The workspace pays once per person: count only who has not been counted.
        let charged = 0;
        if (plan && people) {
          for (const p of people) {
            if (await claimPerson(workspaceId, p, period, chargesWorkspace && charged < granted)) charged++;
          }
        } else if (chargesWorkspace) {
          charged = deliveredUnits;
        }
        if (chargesWorkspace) {
          const back = granted - charged;
          await refund(workspaceId, back, period);
          await refundDaily(workspaceId, vendor, back, day);
        }
        // The pool pays for everything the vendor delivered.
        if (pooled) await refundPool(vendor, granted - deliveredUnits, period);
      } catch (e) {
        // Left counted: an over-count against the member, never spend past the number.
        console.error(`[prospectAllowance] could not settle a hold of ${granted} for workspace ${workspaceId} (${vendor}):`, e instanceof Error ? e.message : String(e));
      }
    },
  };
}
