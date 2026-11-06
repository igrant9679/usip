/**
 * ProspectSearchExecutor — the waterfall.
 *
 *   for each eligible source, in the workspace's order:
 *     if collected >= target: stop
 *     reserve budget headroom for this source
 *     page = search(criteria, limit = remaining × overfetch)
 *     normalize → dedupe (workspace + this run) → mark net-new
 *     if the source acquires on demand and there are net-new records:
 *       acquire ONLY the net-new ones, commit the units actually spent
 *     else commit what the search itself cost (usually 0)
 *     collected += net-new
 *
 * Never parallel: the next source is not called once the target is met,
 * which is the whole reason this replaces Promise.allSettled — a parallel
 * fan-out pays every vendor for the same person. Overfetch is modest
 * (1.3×) to absorb dedupe losses; on free-preview sources it costs nothing.
 *
 * One failing provider degrades the run, never fails it: the failure is
 * recorded per source, the circuit breaker is told, and the waterfall
 * continues. Terminal failures (bad key, missing scope) are recorded on the
 * credential so the source strip can say so.
 */
import type { ProspectSourceSlug, SearchCriteria } from "@shared/prospectSources";
import { canonicalText } from "@shared/canonicalText";
import type { ProspectRecord, SearchContext, VendorFailure } from "./types";
import type { EligibleSource } from "./registry";
import { Deduper } from "./dedupe";
import { commit, markExhausted, release, remainingUnits, reserve } from "./ledger";
import { recordFailure, recordSuccess } from "./circuit";
import { recordValidation } from "./credentials";
import { isTerminalFailure } from "./types";

export const DEFAULT_OVERFETCH = 1.3;

export interface SourceOutcome {
  slug: ProspectSourceSlug;
  verdict: "full" | "approximate";
  searched: number;
  netNew: number;
  acquired: number;
  unitsSpent: number;
  fundedBy: "plan" | "credits" | "uncapped" | null;
  error?: string;
  errorReason?: VendorFailure["reason"];
  /** The vendor asked us to wait: the search was refused, not empty (VendorFailure.held). */
  held?: boolean;
  retryAfterSeconds?: number;
  nextCursor?: string | null;
  /** The source's own note on the search (SearchResultPage.note). */
  note?: string;
  /** Net-new previews dropped by WaterfallOptions.screen before anything was paid for them. */
  screened?: number;
}

export interface CollectedRecord {
  record: ProspectRecord;
  slug: ProspectSourceSlug;
  netNew: boolean;
  dedupeKey: string | null;
  wasCharged: boolean;
}

export interface WaterfallResult {
  collected: CollectedRecord[];
  /** Records the sources returned that dedupe said we already hold (for the run inspector). */
  duplicates: CollectedRecord[];
  perSource: SourceOutcome[];
  target: number;
  reachedTarget: boolean;
}

export interface WaterfallOptions {
  workspaceId: number;
  criteria: SearchCriteria;
  target: number;
  sources: EligibleSource[];
  deduper: Deduper;
  /** "acquire" spends on net-new records for on-demand sources; "preview"
   *  stages masked previews only (the search page acquires on selection). */
  mode: "acquire" | "preview";
  overfetch?: number;
  /** Per-source cursors from a previous pass (page rotation). */
  cursors?: Partial<Record<ProspectSourceSlug, string | null>>;
  ctx?: SearchContext;
  /** Free-text query used for legacy pull-ledger rows. */
  queryLabel?: string;
  /**
   * Free checks a net-new preview must pass before it is acquired or counted
   * toward the target (audit 2026-10-20, A33: paid export ran first and the
   * never-target and anchor filters threw away people already paid for).
   * Returns why the record is dropped, or null to keep it.
   */
  screen?: (record: ProspectRecord) => string | null;
}

export async function runWaterfall(opts: WaterfallOptions): Promise<WaterfallResult> {
  const collected: CollectedRecord[] = [];
  const duplicates: CollectedRecord[] = [];
  const perSource: SourceOutcome[] = [];
  const target = Math.max(0, Math.floor(opts.target));

  for (let i = 0; i < opts.sources.length; i++) {
    if (collected.length >= target) break;
    const e = opts.sources[i];
    const s = e.source;
    const remaining = target - collected.length;
    const outcome: SourceOutcome = {
      slug: s.slug, verdict: e.match.verdict === "full" ? "full" : "approximate",
      searched: 0, netNew: 0, acquired: 0, unitsSpent: 0, fundedBy: null,
    };
    perSource.push(outcome);

    const caps = e.capabilities;
    // Overfetching costs nothing on a free preview. Where each row is billed it
    // buys people this run cannot take, so ask for exactly the slots left.
    const overfetch = caps.supportsFreePreview === false ? 1 : (opts.overfetch ?? DEFAULT_OVERFETCH);
    let ask = Math.min(caps.maxBatchSize, Math.max(1, Math.ceil(remaining * overfetch)));
    if (e.leadsRemaining != null) ask = Math.min(ask, e.leadsRemaining);
    if (ask <= 0) { outcome.error = "no budget headroom"; outcome.errorReason = "budget_exhausted"; continue; }

    const periods = s.budgetPeriods({ now: new Date(), credentials: e.credentials });
    const meters = periods.length > 0 && s.acquisition === "on_demand" && opts.mode === "acquire";
    // A free preview costs nothing; only acquisition is held against the
    // ledger, and only for what we will actually try to acquire (remaining,
    // not the overfetched ask).
    let hold = meters ? await reserve(opts.workspaceId, s.slug, "leads", Math.min(remaining, ask), periods) : null;
    if (meters && !hold) {
      const left = await remainingUnits(opts.workspaceId, s.slug, "leads", periods);
      const smaller = left.total != null ? Math.min(remaining, left.total) : 0;
      if (smaller > 0) hold = await reserve(opts.workspaceId, s.slug, "leads", smaller, periods);
      if (!hold) { outcome.error = "allowance exhausted for this period"; outcome.errorReason = "budget_exhausted"; continue; }
    }
    outcome.fundedBy = hold ? hold.fundedBy : (periods.length === 0 && e.leadsRemaining == null ? "uncapped" : null);

    const ctx: SearchContext = { ...(opts.ctx ?? {}), cursor: opts.cursors?.[s.slug] ?? null };
    let page;
    try {
      page = await s.search(opts.criteria, e.credentials, ask, ctx);
    } catch (err) {
      page = { ok: false as const, reason: "unavailable" as const, message: (err as Error)?.message ?? String(err) };
    }
    if (!page.ok) {
      outcome.error = page.message; outcome.errorReason = page.reason;
      if (page.held) outcome.held = true;
      if (page.retryAfterSeconds != null) outcome.retryAfterSeconds = page.retryAfterSeconds;
      if (page.unitsSpent) outcome.unitsSpent = page.unitsSpent;
      if (hold) await release(opts.workspaceId, hold);
      await noteFailure(opts.workspaceId, s, page);
      if (page.reason === "budget_exhausted" && periods.length > 0) await markExhausted(opts.workspaceId, s.slug, "leads", periods);
      continue;
    }
    await recordSuccess(opts.workspaceId, s.slug, s.credentialMode);
    outcome.searched = page.records.length;
    outcome.nextCursor = page.nextCursor;
    if (page.note) outcome.note = page.note;
    // What the search itself billed. It stands whatever happens next: a failed
    // acquisition does not un-spend the rows the vendor already delivered.
    if (page.unitsSpent) outcome.unitsSpent = page.unitsSpent;
    // The legacy pull ledger feeds the Apollo/QuickEnrich DAILY CAPS that
    // campaigns run on. A preview is free and fills no queue, so it must not
    // spend them (audit P69): only an acquiring run records its pulls.
    if (s.recordUsage && opts.mode === "acquire") await s.recordUsage(opts.workspaceId, page.records.length, opts.queryLabel ?? "");

    // Dedupe against the workspace and everything collected so far.
    const netNew: Array<{ record: ProspectRecord; key: string | null; keys: string[] }> = [];
    for (let r = 0; r < page.records.length; r++) {
      const rec = page.records[r];
      const d = opts.deduper.check(rec);
      if (!d.netNew) { duplicates.push({ record: rec, slug: s.slug, netNew: false, dedupeKey: d.key, wasCharged: false }); continue; }
      if (opts.screen && opts.screen(rec) !== null) { outcome.screened = (outcome.screened ?? 0) + 1; continue; }
      // Claim within the page too, so two rows for one person from one
      // vendor count once.
      opts.deduper.claim(d.keys);
      netNew.push({ record: rec, key: d.key, keys: d.keys });
    }
    outcome.netNew = netNew.length;

    let toTake = netNew.slice(0, remaining);
    let charged = false;
    if (page.alreadyCharged) {
      outcome.unitsSpent = page.unitsSpent || page.records.length;
      charged = true;
      if (hold) await commit(opts.workspaceId, hold, outcome.unitsSpent);
    } else if (opts.mode === "acquire" && s.acquisition === "on_demand" && toTake.length > 0) {
      const ids = toTake.map((x) => x.record.externalId);
      let acq;
      try {
        acq = await s.acquire(ids, e.credentials, ctx);
      } catch (err) {
        acq = { ok: false as const, reason: "unavailable" as const, message: (err as Error)?.message ?? String(err) };
      }
      if (!acq.ok) {
        outcome.error = `acquire: ${acq.message}`; outcome.errorReason = acq.reason;
        if (acq.held) outcome.held = true;
        if (acq.retryAfterSeconds != null) outcome.retryAfterSeconds = acq.retryAfterSeconds;
        if (acq.unitsSpent) outcome.unitsSpent += acq.unitsSpent;
        if (hold) await release(opts.workspaceId, hold);
        await noteFailure(opts.workspaceId, s, acq);
        if (acq.reason === "budget_exhausted" && periods.length > 0) await markExhausted(opts.workspaceId, s.slug, "leads", periods);
        // Keep the masked previews out of the batch: an unacquired preview
        // is not a prospect we can contact. Give their keys back.
        continue;
      }
      const merged: typeof toTake = [];
      for (let t = 0; t < toTake.length; t++) {
        const full = acquiredFor(toTake[t].record, acq.records);
        if (full) merged.push({ ...toTake[t], record: mergeAcquired(toTake[t].record, full) });
        // Records the vendor could not unmask are dropped from the batch:
        // they were never charged and would enter the queue email-less.
      }
      toTake = merged;
      outcome.acquired = merged.length;
      outcome.unitsSpent += acq.unitsSpent;
      if (acq.note) outcome.note = outcome.note ? `${outcome.note}; ${acq.note}` : acq.note;
      if (acq.hold) {
        outcome.held = true;
        if (acq.hold.retryAfterSeconds != null) outcome.retryAfterSeconds = acq.hold.retryAfterSeconds;
      }
      charged = acq.unitsSpent > 0;
      if (hold) await commit(opts.workspaceId, hold, acq.unitsSpent);
    } else if (hold) {
      await commit(opts.workspaceId, hold, 0);
    }

    for (let t = 0; t < toTake.length; t++) {
      collected.push({ record: toTake[t].record, slug: s.slug, netNew: true, dedupeKey: toTake[t].key, wasCharged: charged });
    }
    // Net-new previews beyond `remaining` were claimed but not taken; that
    // is fine within a run (we do not want them from the next source either).
  }
  return { collected, duplicates, perSource, target, reachedTarget: collected.length >= target };
}

/**
 * The acquired record for one preview. A business's several people share its
 * lead id ("B1", "B1#2" … "B1#5"), and keying the export by that id alone gave
 * every one of them the LAST person's record — five previews in, one person
 * five times out (found with N2, 2026-11-06). The same externalId wins (for a
 * numbered person, only if the name agrees: an export may number a business's
 * people differently from the search); else the one person of that business
 * with the same name; else its only person whose name does not disagree;
 * else none.
 */
export function acquiredFor(preview: ProspectRecord, records: ProspectRecord[]): ProspectRecord | undefined {
  const name = (r: ProspectRecord) => canonicalText(`${r.firstName ?? ""} ${r.lastName ?? ""}`);
  const pn = name(preview);
  const agrees = (r: ProspectRecord) => !pn || !name(r) || name(r) === pn;
  const numbered = /#\d+$/.test(preview.externalId);
  const exact = records.find((r) => r.externalId === preview.externalId && (!numbered || agrees(r)));
  if (exact) return exact;
  const base = (id: string) => id.replace(/#\d+$/, "");
  const same = records.filter((r) => base(r.externalId) === base(preview.externalId));
  const named = pn ? same.filter((r) => name(r) === pn) : [];
  if (named.length === 1) return named[0];
  const possible = same.filter(agrees);
  return possible.length === 1 ? possible[0] : undefined;
}

/** Acquired detail wins for fields it fills; preview fields fill the rest. */
export function mergeAcquired(preview: ProspectRecord, full: ProspectRecord): ProspectRecord {
  const out: ProspectRecord = { ...preview };
  const keys = Object.keys(full) as Array<keyof ProspectRecord>;
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    const v = full[k];
    if (k === "rawSourcePayload") { out.rawSourcePayload = { ...preview.rawSourcePayload, ...full.rawSourcePayload }; continue; }
    if (v !== null && v !== undefined && v !== "") (out as unknown as Record<string, unknown>)[k] = v;
  }
  out.emailIsMasked = !out.email || full.emailIsMasked;
  if (out.emailIsMasked) out.email = null;
  return out;
}

async function noteFailure(workspaceId: number, s: EligibleSource["source"], f: VendorFailure): Promise<void> {
  if (f.held) return;
  if (isTerminalFailure(f.reason)) {
    if (s.credentialMode === "table") {
      await recordValidation(workspaceId, s.slug, { ok: false, message: `${f.reason}: ${f.message}`, terminal: true });
    }
    return;
  }
  if (f.reason === "budget_exhausted" || f.reason === "invalid_params") return;
  await recordFailure(workspaceId, s.slug, s.credentialMode);
}
