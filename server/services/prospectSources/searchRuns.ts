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
  prospects,
  rawFinds,
} from "../../../drizzle/schema";
import { getDb } from "../../db";
import type { ProspectSourceSlug, SearchCriteria } from "@shared/prospectSources";
import { activeFilters } from "@shared/prospectSources";
import type { ProspectRecord } from "./types";
import { eligibleFor, getSource } from "./registry";
import { runWaterfall } from "./executor";
import { workspaceDeduper } from "./dedupe";
import { recordToQueueRow } from "./bridge";
import { loadCredentials, recordValidation, workspacesWithCredentials } from "./credentials";
import { commit, ensurePeriodRows, releaseStaleHolds, remainingUnits, reserve } from "./ledger";

export const MAX_BATCH_TARGET = 200;

export async function startRun(workspaceId: number, userId: number | null, criteria: SearchCriteria, batchTarget: number): Promise<{ runId: number }> {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");
  if (activeFilters(criteria).length === 0) throw new Error("Set at least one filter — searching every vendor's whole database is not an audience.");
  const target = Math.max(1, Math.min(MAX_BATCH_TARGET, Math.floor(batchTarget)));
  const [created] = await db.insert(prospectSearchRuns).values({
    workspaceId, userId, criteria: criteria as never, batchTarget: target, status: "queued",
  } as never).$returningId();
  const runId = created.id;
  void executeRun(workspaceId, runId).catch((e) => console.error(`[prospectSources] run ${runId} crashed:`, e));
  return { runId };
}

export async function executeRun(workspaceId: number, runId: number): Promise<void> {
  const db = await getDb();
  if (!db) return;
  const [run] = await db.select().from(prospectSearchRuns)
    .where(and(eq(prospectSearchRuns.id, runId), eq(prospectSearchRuns.workspaceId, workspaceId))).limit(1);
  if (!run || run.status !== "queued") return;
  await db.update(prospectSearchRuns).set({ status: "running", startedAt: new Date() } as never)
    .where(and(eq(prospectSearchRuns.id, runId), eq(prospectSearchRuns.workspaceId, workspaceId)));
  try {
    const criteria = run.criteria as SearchCriteria;
    const { eligible, skipped } = await eligibleFor(workspaceId, criteria);
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
  const per = new Map<string, { toAcquire: number; free: number }>();
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const s = getSource(r.sourceSlug as ProspectSourceSlug);
    const e = per.get(r.sourceSlug) ?? { toAcquire: 0, free: 0 };
    if (s.acquisition === "on_demand" && !r.wasCharged && !r.promotedProspectId) e.toAcquire += 1; else e.free += 1;
    per.set(r.sourceSlug, e);
  }
  const perSource: Array<{ slug: string; toAcquire: number; free: number; remaining: number | null }> = [];
  let units = 0;
  const entries = Array.from(per.entries());
  for (let i = 0; i < entries.length; i++) {
    const [slug, e] = entries[i];
    const s = getSource(slug as ProspectSourceSlug);
    let remaining: number | null = null;
    const creds = await loadCredentials(workspaceId, s);
    if (creds) {
      const periods = s.budgetPeriods({ now: new Date(), credentials: creds });
      if (periods.length > 0) remaining = (await remainingUnits(workspaceId, s.slug, "leads", periods)).total;
    }
    units += e.toAcquire;
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
  const todo = rows.filter((r) => !r.promotedProspectId);
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
    const byId = new Map<string, ProspectRecord>();
    for (let i = 0; i < acq.records.length; i++) byId.set(acq.records[i].externalId.replace(/#\d+$/, ""), acq.records[i]);
    const { mergeAcquired } = await import("./executor");
    for (let i = 0; i < needs.length; i++) {
      const full = byId.get(needs[i].externalId.replace(/#\d+$/, ""));
      if (!full) { failed += 1; finalRecords.delete(needs[i].id); continue; }
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
  const { toRawFindRow } = await import("../discovery/index");
  const { processRun } = await import("../discovery/consolidate");
  const rawRows: Array<ReturnType<typeof toRawFindRow>> = [];
  for (let i = 0; i < ids.length; i++) {
    const rec = finalRecords.get(ids[i])!;
    const r = todo.find((x) => x.id === ids[i])!;
    rawRows.push(toRawFindRow(workspaceId, discoveryRunId, r.sourceSlug, recordToQueueRow(rec)));
  }
  for (let i = 0; i < rawRows.length; i += 50) {
    const chunk = rawRows.slice(i, i + 50);
    try { await db.insert(rawFinds).values(chunk); }
    catch { for (let j = 0; j < chunk.length; j++) { try { await db.insert(rawFinds).values(chunk[j]); } catch { /* skip */ } } }
  }
  await db.update(discoveryRuns).set({ rawFindCount: rawRows.length } as never).where(eq(discoveryRuns.id, discoveryRunId));
  const persisted = await processRun(workspaceId, discoveryRunId, "person");
  await db.update(discoveryRuns).set({ status: "complete", completedAt: new Date() } as never).where(eq(discoveryRuns.id, discoveryRunId));

  // Stamp each staged row with the People record it became.
  const people = await db.select({ id: prospects.id, email: prospects.email, linkedinUrl: prospects.linkedinUrl, firstName: prospects.firstName, lastName: prospects.lastName })
    .from(prospects).where(and(eq(prospects.workspaceId, workspaceId), eq(prospects.lastDiscoveryRunId, discoveryRunId)));
  let promoted = 0;
  for (let i = 0; i < ids.length; i++) {
    const rec = finalRecords.get(ids[i])!;
    const hit = people.find((p) =>
      (rec.email && p.email && p.email.toLowerCase() === rec.email.toLowerCase())
      || (rec.linkedinUrl && p.linkedinUrl && p.linkedinUrl.toLowerCase() === rec.linkedinUrl.toLowerCase())
      || (p.firstName === rec.firstName && p.lastName === rec.lastName));
    if (hit) {
      promoted += 1;
      await db.update(prospectSearchResults).set({ promotedProspectId: hit.id } as never)
        .where(and(eq(prospectSearchResults.id, ids[i]), eq(prospectSearchResults.workspaceId, workspaceId)));
    }
  }
  return { promoted, acquired, unitsSpent, failed, discoveryRunId, errors, persisted };
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
