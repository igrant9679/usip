/**
 * Staged prospect searches — the search page's back end.
 *
 *   startRun   → row in prospect_search_runs, executed in the background
 *                (preview mode: free masked previews only, nothing spent)
 *   executeRun → waterfall over the eligible sources, results staged in
 *                prospect_search_results with net-new / masked flags
 *   promote    → for the rows the user selected: acquire the on-demand
 *                ones (units spent NOW, shown before confirming), then push
 *                everything through the SAME consolidation the Find
 *                Prospects page uses (discovery run → raw_finds → processRun
 *                → prospects with field provenance)
 *
 * A run that was "running" when the server restarted is marked
 * `interrupted` at boot (a deploy kills fire-and-forget work — recorded
 * lesson 2026-09-09) so the page never spins on a run nothing is executing.
 */
import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import {
  discoveryRuns,
  prospectSearchResults,
  prospectSearchRuns,
  rawFinds,
} from "../../../drizzle/schema";
import { getDb } from "../../db";
import type { ProspectSourceSlug, SearchCriteria } from "@shared/prospectSources";
import { narrowingFilters } from "@shared/prospectSources";
import type { ProspectRecord } from "./types";
import { eligibleFor, getSource } from "./registry";
import { runWaterfall } from "./executor";
import { workspaceDeduper } from "./dedupe";
import { recordToQueueRow } from "./bridge";
import { loadCredentials, recordValidation, workspacesWithCredentials } from "./credentials";
import { commit, ensurePeriodRows, releaseStaleHolds, remainingUnits, reserve } from "./ledger";

export const MAX_BATCH_TARGET = 200;

/**
 * Searches queued or running in this process, by what they search for (audit
 * 2026-10-20, P77). The page kept the run id only in memory, so after a
 * reload pressing Run again started a second search — a billed preview, for
 * LeadOcean — while the first was still going. The same search is now found
 * again instead. Runs execute in the process that queued them, so a map here
 * is the whole set.
 */
const activeSearches = new Map<string, number>();

/** Equal for two starts that would run the same search. */
export function searchFingerprint(workspaceId: number, criteria: SearchCriteria, target: number, only: ProspectSourceSlug[] | null | undefined): string {
  const c = criteria as unknown as Record<string, unknown>;
  const fields: Record<string, unknown> = {};
  for (const k of Object.keys(c).sort()) {
    const v = c[k];
    if (Array.isArray(v)) { if (v.length) fields[k] = v.map((x) => String(x).trim().toLowerCase()).sort(); }
    else if (v && typeof v === "object") { if (Object.values(v).some((x) => x != null)) fields[k] = v; }
    else if (v !== undefined && v !== null) fields[k] = v;
  }
  return JSON.stringify([workspaceId, fields, target, only?.length ? Array.from(new Set(only)).sort() : null]);
}

export async function startRun(
  workspaceId: number,
  userId: number | null,
  criteria: SearchCriteria,
  batchTarget: number,
  /** Per-run source picker (owner ask 2026-09-22): null = every eligible source, as before. */
  only?: ProspectSourceSlug[] | null,
): Promise<{ runId: number; alreadyRunning?: boolean }> {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");
  // "Has email" / "Has phone" alone do not make a search filtered (P68).
  if (narrowingFilters(criteria).length === 0) throw new Error("Set at least one filter besides Has email / Has phone — searching every vendor's whole database is not an audience.");
  const target = Math.max(1, Math.min(MAX_BATCH_TARGET, Math.floor(batchTarget)));
  const key = searchFingerprint(workspaceId, criteria, target, only);
  const going = activeSearches.get(key);
  if (going != null) return { runId: going, alreadyRunning: true };
  const [created] = await db.insert(prospectSearchRuns).values({
    workspaceId, userId, criteria: criteria as never, batchTarget: target, status: "queued",
  } as never).$returningId();
  const runId = created.id;
  activeSearches.set(key, runId);
  void executeRun(workspaceId, runId, { only: only ?? null })
    .catch((e) => console.error(`[prospectSources] run ${runId} crashed:`, e))
    .finally(() => { if (activeSearches.get(key) === runId) activeSearches.delete(key); });
  return { runId };
}

export async function executeRun(
  workspaceId: number,
  runId: number,
  /** The picker's selection travels in memory: the run is executed by the
   *  same process that queued it, and the completed run's perSource records
   *  every source it skipped as "not_selected", so the inspector still shows
   *  what was chosen. */
  opts?: { only?: ProspectSourceSlug[] | null },
): Promise<void> {
  const db = await getDb();
  if (!db) return;
  const [run] = await db.select().from(prospectSearchRuns)
    .where(and(eq(prospectSearchRuns.id, runId), eq(prospectSearchRuns.workspaceId, workspaceId))).limit(1);
  if (!run || run.status !== "queued") return;
  await db.update(prospectSearchRuns).set({ status: "running", startedAt: new Date() } as never)
    .where(and(eq(prospectSearchRuns.id, runId), eq(prospectSearchRuns.workspaceId, workspaceId)));
  try {
    const criteria = run.criteria as SearchCriteria;
    // The selection goes through `only`, the same door the engine uses for a
    // campaign's prospectSources — so the mask, credentials, capability match,
    // circuit and budget checks all still apply to a chosen source.
    const { eligible, skipped } = await eligibleFor(workspaceId, criteria, { only: opts?.only ?? null });
    const deduper = await workspaceDeduper(workspaceId);
    const result = await runWaterfall({
      workspaceId, criteria, target: run.batchTarget, sources: eligible, deduper,
      mode: "preview", ctx: { runId }, queryLabel: `search run ${runId}`,
    });
    const rows: Array<typeof prospectSearchResults.$inferInsert> = [];
    const all = result.collected.concat(result.duplicates);
    for (let i = 0; i < all.length; i++) {
      const c = all[i];
      rows.push({
        workspaceId, runId, sourceSlug: c.slug, externalId: c.record.externalId.slice(0, 191),
        rawPayload: c.record.rawSourcePayload as never,
        normalized: c.record as never,
        dedupeKey: c.dedupeKey ? c.dedupeKey.slice(0, 400) : null,
        isNetNew: c.netNew, wasCharged: c.wasCharged, emailIsMasked: c.record.emailIsMasked,
      });
    }
    for (let i = 0; i < rows.length; i += 50) {
      const chunk = rows.slice(i, i + 50);
      try { await db.insert(prospectSearchResults).values(chunk as never); }
      catch {
        for (let j = 0; j < chunk.length; j++) {
          try { await db.insert(prospectSearchResults).values(chunk[j] as never); }
          catch (e) { console.error("[prospectSources] result row unstorable, skipped:", (e as Error)?.message); }
        }
      }
    }
    const perSource: Record<string, unknown> = {};
    for (let i = 0; i < result.perSource.length; i++) perSource[result.perSource[i].slug] = result.perSource[i];
    for (let i = 0; i < skipped.length; i++) perSource[skipped[i].slug] = { skipped: skipped[i].reason, detail: skipped[i].detail };
    await db.update(prospectSearchRuns).set({
      status: "complete", completedAt: new Date(),
      recordsReturned: all.length, recordsNetNew: result.collected.length,
      perSource: perSource as never,
    } as never).where(and(eq(prospectSearchRuns.id, runId), eq(prospectSearchRuns.workspaceId, workspaceId)));
  } catch (e) {
    await db.update(prospectSearchRuns).set({
      status: "failed", completedAt: new Date(), error: String((e as Error)?.message ?? e).slice(0, 2000),
    } as never).where(and(eq(prospectSearchRuns.id, runId), eq(prospectSearchRuns.workspaceId, workspaceId)));
  }
}

export async function getRun(workspaceId: number, runId: number) {
  const db = await getDb();
  if (!db) return null;
  const [run] = await db.select().from(prospectSearchRuns)
    .where(and(eq(prospectSearchRuns.id, runId), eq(prospectSearchRuns.workspaceId, workspaceId))).limit(1);
  if (!run) return null;
  const results = await db.select().from(prospectSearchResults)
    .where(and(eq(prospectSearchResults.runId, runId), eq(prospectSearchResults.workspaceId, workspaceId)))
    .orderBy(desc(prospectSearchResults.isNetNew), prospectSearchResults.id);
  return { run, results: results.map((r) => ({ ...r, rawPayload: undefined })) };
}

export async function getResultRaw(workspaceId: number, resultId: number) {
  const db = await getDb();
  if (!db) return null;
  const [r] = await db.select().from(prospectSearchResults)
    .where(and(eq(prospectSearchResults.id, resultId), eq(prospectSearchResults.workspaceId, workspaceId))).limit(1);
  return r ?? null;
}

export async function listRuns(workspaceId: number, limit = 20) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(prospectSearchRuns).where(eq(prospectSearchRuns.workspaceId, workspaceId))
    .orderBy(desc(prospectSearchRuns.id)).limit(limit);
}

/** What promoting these rows would spend, per source, before anyone confirms. */
export async function estimatePromotion(workspaceId: number, runId: number, resultIds: number[]) {
  const db = await getDb();
  if (!db || resultIds.length === 0) return { units: 0, perSource: [] as Array<{ slug: string; toAcquire: number; free: number; remaining: number | null }> };
  const rows = await db.select().from(prospectSearchResults)
    .where(and(eq(prospectSearchResults.workspaceId, workspaceId), eq(prospectSearchResults.runId, runId), inArray(prospectSearchResults.id, resultIds)));
  const per = new Map<string, { toAcquire: number; free: number; ids: string[] }>();
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const s = getSource(r.sourceSlug as ProspectSourceSlug);
    const e = per.get(r.sourceSlug) ?? { toAcquire: 0, free: 0, ids: [] };
    if (s.acquisition === "on_demand" && !r.wasCharged && !r.promotedProspectId) { e.toAcquire += 1; e.ids.push(r.externalId); } else e.free += 1;
    per.set(r.sourceSlug, e);
  }
  const perSource: Array<{ slug: string; toAcquire: number; free: number; remaining: number | null }> = [];
  let units = 0;
  const entries = Array.from(per.entries());
  for (let i = 0; i < entries.length; i++) {
    const [slug, e] = entries[i];
    const s = getSource(slug as ProspectSourceSlug);
    let remaining: number | null = null;
    let cost = e.toAcquire;
    const creds = await loadCredentials(workspaceId, s);
    if (creds) {
      const periods = s.budgetPeriods({ now: new Date(), credentials: creds });
      if (periods.length > 0) remaining = (await remainingUnits(workspaceId, s.slug, "leads", periods)).total;
      if (s.estimateAcquireUnits) cost = e.ids.reduce((n, id) => n + s.estimateAcquireUnits!(id, creds), 0);
    }
    units += cost;
    perSource.push({ slug, toAcquire: e.toAcquire, free: e.free, remaining });
  }
  return { units, perSource };
}

/**
 * Acquire (where needed) and promote selected rows into People through the
 * Find Prospects consolidation, writing field provenance per source.
 */
export async function promoteResults(workspaceId: number, userId: number | null, runId: number, resultIds: number[]) {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");
  const rows = await db.select().from(prospectSearchResults)
    .where(and(eq(prospectSearchResults.workspaceId, workspaceId), eq(prospectSearchResults.runId, runId), inArray(prospectSearchResults.id, resultIds.length ? resultIds : [-1])));
  // A row already looked up and billed with nothing to take is not bought twice.
  const todo = rows.filter((r) => !r.promotedProspectId && !(r.normalized as ProspectRecord | null)?.rawSourcePayload?.noAddressFound);
  if (todo.length === 0) return { promoted: 0, acquired: 0, unitsSpent: 0, failed: 0, discoveryRunId: null as number | null, errors: [] as string[] };

  const errors: string[] = [];
  let acquired = 0, unitsSpent = 0, failed = 0;
  const finalRecords = new Map<number, ProspectRecord>();
  const bySource = new Map<string, typeof todo>();
  for (let i = 0; i < todo.length; i++) {
    const r = todo[i];
    const list = bySource.get(r.sourceSlug) ?? [];
    list.push(r); bySource.set(r.sourceSlug, list);
  }
  const groups = Array.from(bySource.entries());
  for (let g = 0; g < groups.length; g++) {
    const [slug, list] = groups[g];
    const s = getSource(slug as ProspectSourceSlug);
    const needs = list.filter((r) => s.acquisition === "on_demand" && !r.wasCharged);
    for (let i = 0; i < list.length; i++) finalRecords.set(list[i].id, list[i].normalized as ProspectRecord);
    if (needs.length === 0) continue;
    const creds = await loadCredentials(workspaceId, s);
    if (!creds) { errors.push(`${s.displayName}: no credentials`); failed += needs.length; needs.forEach((r) => finalRecords.delete(r.id)); continue; }
    const periods = s.budgetPeriods({ now: new Date(), credentials: creds });
    const hold = periods.length ? await reserve(workspaceId, s.slug, "leads", needs.length, periods) : null;
    if (periods.length && !hold) { errors.push(`${s.displayName}: allowance exhausted for this period`); failed += needs.length; needs.forEach((r) => finalRecords.delete(r.id)); continue; }
    const acq = await s.acquire(needs.map((r) => r.externalId), creds, { runId });
    if (!acq.ok) {
      if (hold) await commit(workspaceId, hold, 0);
      errors.push(`${s.displayName}: ${acq.message}`); failed += needs.length; needs.forEach((r) => finalRecords.delete(r.id));
      continue;
    }
    if (hold) await commit(workspaceId, hold, acq.unitsSpent);
    unitsSpent += acq.unitsSpent;
    if (acq.note) errors.push(`${s.displayName}: ${acq.note}`);
    const paidMisses = new Set(acq.paidMissExternalIds ?? []);
    const { acquiredFor, mergeAcquired } = await import("./executor");
    for (let i = 0; i < needs.length; i++) {
      // Each of a business's people gets their own record (N2).
      const full = acquiredFor(needs[i].normalized as ProspectRecord, acq.records);
      if (!full) {
        failed += 1;
        finalRecords.delete(needs[i].id);
        if (paidMisses.has(needs[i].externalId)) {
          const held = needs[i].normalized as ProspectRecord;
          await db.update(prospectSearchResults).set({ wasCharged: true, normalized: { ...held, rawSourcePayload: { ...held.rawSourcePayload, noAddressFound: true } } as never } as never)
            .where(and(eq(prospectSearchResults.id, needs[i].id), eq(prospectSearchResults.workspaceId, workspaceId)));
        }
        continue;
      }
      const merged = mergeAcquired(needs[i].normalized as ProspectRecord, full);
      finalRecords.set(needs[i].id, merged);
      acquired += 1;
      await db.update(prospectSearchResults).set({ normalized: merged as never, wasCharged: true, emailIsMasked: merged.emailIsMasked } as never)
        .where(and(eq(prospectSearchResults.id, needs[i].id), eq(prospectSearchResults.workspaceId, workspaceId)));
    }
  }

  const ids = Array.from(finalRecords.keys());
  if (ids.length === 0) return { promoted: 0, acquired, unitsSpent, failed, discoveryRunId: null as number | null, errors };

  // Promote through the Find Prospects consolidation: one discovery run,
  // raw finds tagged per vendor, processRun → prospects (+ provenance).
  const [dr] = await db.insert(discoveryRuns).values({
    workspaceId, userId, campaignId: null, mode: "person",
    input: { fromSearchRun: runId, resultIds: ids } as never, status: "running",
  } as never).$returningId();
  const discoveryRunId = dr.id;
  const { toRawFindRow, associateDiscoveredPeople } = await import("../discovery/index");
  const { processRun, skippedCount } = await import("../discovery/consolidate");
  const rawRows: Array<ReturnType<typeof toRawFindRow>> = [];
  for (let i = 0; i < ids.length; i++) {
    const rec = finalRecords.get(ids[i])!;
    const r = todo.find((x) => x.id === ids[i])!;
    // The staged row's id travels on the raw find, so the person it became is
    // read back exactly rather than matched by name (P71).
    rawRows.push(toRawFindRow(workspaceId, discoveryRunId, r.sourceSlug, { ...recordToQueueRow(rec), searchResultId: ids[i] }));
  }
  // An unstorable row is counted and reported, not skipped silently (P71).
  let unstorable = 0;
  for (let i = 0; i < rawRows.length; i += 50) {
    const chunk = rawRows.slice(i, i + 50);
    try { await db.insert(rawFinds).values(chunk); }
    catch {
      for (let j = 0; j < chunk.length; j++) {
        try { await db.insert(rawFinds).values(chunk[j]); }
        catch (e) { unstorable += 1; console.error("[prospectSources] raw find unstorable, skipped:", (e as Error)?.message); }
      }
    }
  }
  if (unstorable > 0) errors.push(`${unstorable} could not be stored for saving and were left out`);
  await db.update(discoveryRuns).set({ rawFindCount: rawRows.length - unstorable } as never)
    .where(and(eq(discoveryRuns.id, discoveryRunId), eq(discoveryRuns.workspaceId, workspaceId)));
  let persisted: Awaited<ReturnType<typeof processRun>>;
  try {
    persisted = await processRun(workspaceId, discoveryRunId, "person");
  } catch (e) {
    // The run says it failed rather than sitting at "running" (P71). What was
    // acquired is on the staged rows already, so promoting again is free.
    const message = String((e as Error)?.message ?? e).slice(0, 500);
    await db.update(discoveryRuns).set({ status: "failed", errorMessage: `Saving to People failed: ${message}`, completedAt: new Date() } as never)
      .where(and(eq(discoveryRuns.id, discoveryRunId), eq(discoveryRuns.workspaceId, workspaceId)));
    errors.push(`Saving to People failed (${message}); nothing acquired is lost, promote again to retry`);
    return { promoted: 0, acquired, unitsSpent, failed, discoveryRunId, errors };
  }
  await db.update(discoveryRuns).set({ status: "complete", completedAt: new Date() } as never)
    .where(and(eq(discoveryRuns.id, discoveryRunId), eq(discoveryRuns.workspaceId, workspaceId)));
  // Linked to companies, as a Find prospects run is (P71).
  associateDiscoveredPeople(workspaceId, discoveryRunId);

  // Stamp each staged row with the People record it became.
  const finds = await db.select({ id: rawFinds.id, rawJson: rawFinds.rawJson }).from(rawFinds)
    .where(and(eq(rawFinds.runId, discoveryRunId), eq(rawFinds.workspaceId, workspaceId)));
  const resultOfFind = new Map<number, number>();
  for (let i = 0; i < finds.length; i++) {
    const rid = Number((finds[i].rawJson as Record<string, unknown> | null)?.searchResultId);
    if (Number.isFinite(rid) && rid > 0) resultOfFind.set(finds[i].id, rid);
  }
  const became = new Map<number, number>();
  const saved = persisted.saved ?? [];
  for (let i = 0; i < saved.length; i++) {
    for (let j = 0; j < saved[i].sourceRows.length; j++) {
      const rid = resultOfFind.get(saved[i].sourceRows[j]);
      if (rid != null) became.set(rid, saved[i].prospectId);
    }
  }
  const stamped = Array.from(became.entries());
  for (let i = 0; i < stamped.length; i++) {
    await db.update(prospectSearchResults).set({ promotedProspectId: stamped[i][1] } as never)
      .where(and(eq(prospectSearchResults.id, stamped[i][0]), eq(prospectSearchResults.workspaceId, workspaceId)));
  }
  const promoted = stamped.length;
  const notSaved = ids.length - unstorable - promoted;
  if (notSaved > 0 && skippedCount(persisted) > 0) {
    const why = [
      persisted.prospectsSkippedSuppressed ? `${persisted.prospectsSkippedSuppressed} on a suppression list` : "",
      persisted.prospectsSkippedNameOnly ? `${persisted.prospectsSkippedNameOnly} matching someone in People by name only` : "",
      persisted.prospectsSkippedNoName ? `${persisted.prospectsSkippedNoName} with no full name` : "",
      persisted.prospectsSkippedArchived ? `${persisted.prospectsSkippedArchived} archived` : "",
    ].filter(Boolean).join(", ");
    errors.push(`${notSaved} not saved to People: ${why}`);
  } else if (notSaved > 0) {
    errors.push(`${notSaved} not saved to People`);
  }
  const { saved: _saved, ...counts } = persisted;
  return { promoted, acquired, unitsSpent, failed, discoveryRunId, errors, persisted: counts };
}

/** Boot: nothing executes a run that was in flight when the process died. */
export async function markInterruptedRuns(): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const res = await db.update(prospectSearchRuns)
    .set({ status: "interrupted", completedAt: new Date(), error: "Server restarted while this run was in progress — run it again." } as never)
    .where(inArray(prospectSearchRuns.status, ["queued", "running"]));
  return Number((res as unknown as Array<{ affectedRows?: number }>)[0]?.affectedRows ?? 0);
}

/**
 * Periodic maintenance (every 6h, archived workspaces skipped by the caller):
 * revalidate every table-mode credential, refresh ledger limits from what the
 * vendor reports, and release holds leaked by crashed runs.
 */
export async function runSourceMaintenance(opts: { skipWorkspace: (ws: number) => boolean }): Promise<{ validated: number; invalid: number; released: number }> {
  let validated = 0, invalid = 0;
  const targets = await workspacesWithCredentials();
  for (let i = 0; i < targets.length; i++) {
    const { workspaceId, slug } = targets[i];
    if (opts.skipWorkspace(workspaceId)) continue;
    const s = getSource(slug);
    const creds = await loadCredentials(workspaceId, s);
    if (!creds) continue;
    try {
      const r = await s.validateCredentials(creds);
      await recordValidation(workspaceId, slug, r);
      validated += 1;
      if (!r.ok) invalid += 1;
      // Sync the ledger's limits to what the vendor reports (verification
      // allowance is authoritative; leads stay as configured).
      const periods = s.budgetPeriods({ now: new Date(), credentials: { ...creds, config: { ...creds.config, ...(r.discovered ?? {}) } } });
      await ensurePeriodRows(workspaceId, slug, periods);
    } catch (e) {
      console.error(`[prospectSources] maintenance ${slug} ws=${workspaceId} failed:`, (e as Error)?.message);
    }
  }
  const released = await releaseStaleHolds();
  const db = await getDb();
  if (db) {
    // Runs stuck "running" for over an hour are dead.
    await db.update(prospectSearchRuns)
      .set({ status: "interrupted", completedAt: new Date(), error: "Run did not finish within an hour — run it again." } as never)
      .where(and(eq(prospectSearchRuns.status, "running"), lt(prospectSearchRuns.startedAt, sql`(NOW() - INTERVAL 1 HOUR)`)));
  }
  return { validated, invalid, released };
}
