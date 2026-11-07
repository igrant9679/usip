/**
 * Discovery v2 — unified person/account search pipeline.
 *
 * Phase 1 (this file): raw aggregator. Takes a structured user search
 * (person or account mode), builds a single query string, fans out to
 * every existing scraper in parallel, persists everything that comes
 * back as raw_finds rows tagged with their source URL, and emits a
 * timestamped trace into discovery_logs.
 *
 * NOTHING here decides if a result is "a real person". That happens in
 * Phase 2 (consolidate → verify → score → persist as prospects). This
 * file only collects evidence and keeps it traceable.
 *
 * Why a single fan-out service and not just call the existing scrapers
 * directly from the router?
 *   1. The ARE engine's scrapers throw if no AI provider is configured;
 *      we wrap each in allSettled so one source failing never blocks
 *      the others (same pattern as runDiscovery in areEngine.ts).
 *   2. Every source's output needs the same normalization before it
 *      lands in raw_finds — the discovered fields are mostly the same
 *      across sources but the wrappers differ.
 *   3. The run + per-step logs need a single owner so the Logs tab can
 *      show "search → 4 sources fanned out → 12 raw finds → … " as a
 *      single coherent trace.
 */
import { and, eq, isNull, lt } from "drizzle-orm";
import { getDb } from "../../db";
import {
  areScrapeJobs,
  discoveryLogs,
  discoveryRuns,
  rawFinds,
  workspaceSettings,
} from "../../../drizzle/schema";
import { ARE_SOURCE_IDS, resolveSourceOrder, selectRunSources, type AreSourceId } from "@shared/areSources";
import {
  scrapeGoogleBusiness,
  scrapeNews,
} from "../../routers/are/scraper";
import { searchLinkedInProfiles } from "../linkedinLookup";
import { apolloSearchPeople, getApolloDailyCap, apolloPulledToday } from "../apollo";
import {
  buildQuickenrichFilters,
  getQuickEnrichKey,
  getQuickenrichDailyPullCap,
  getQuickenrichIndustries,
  quickenrichContactFinder,
  quickenrichPulledToday,
} from "../quickenrich";
import { processRun, skippedCount, type PersistResult } from "./consolidate";
import { alreadyInWorkspace, workspaceIdentityIndex } from "../prospectSources/dedupe";
import { enqueueJob, findActiveJob, kickJobs, registerJobKind, withHeartbeat } from "../jobs/runner";

/**
 * Real LinkedIn people search for Discovery v2 (replaces the old fabricating
 * scrapeLinkedIn). Pulls from the workspace's bridged LinkedIn account pool
 * (isAdmin so it isn't scoped to one user) and maps hits into the raw-find
 * shape. Returns [] when no account is bridged or the search fails.
 */
/**
 * What one source produced, and — when it produced nothing because it could
 * not run (no key, daily cap spent, LinkedIn on hold) — why (audit P63: the
 * run log said "0 finds", which reads like "nobody matched").
 */
type SourceOut = { raw: Array<Record<string, unknown>>; note?: string };

async function discoverLinkedInPeople(
  workspaceId: number,
  query: string,
): Promise<SourceOut> {
  const res = await searchLinkedInProfiles({
    workspaceId,
    userId: 0,
    isAdmin: true,
    keywords: query,
    limit: 25,
    source: "discovery",
  });
  if (!res.ok) return { raw: [], note: res.message };
  return {
    raw: res.hits.map((h) => ({
      firstName: h.firstName,
      lastName: h.lastName,
      title: h.headline,
      companyName: h.company,
      linkedinUrl: h.linkedinUrl,
      sourceUrl: h.linkedinUrl,
      geography: h.location,
    })),
  };
}

/**
 * Apollo as a Discovery v2 source. Takes the structured search input directly
 * rather than the flattened query string, so Apollo filters on real fields
 * instead of keyword-matching a sentence.
 *
 * Search-only (zero Apollo credits, no emails returned) — the company domain
 * it supplies is what downstream enrichment needs. Returns [] when no key is
 * configured or the daily cap is spent, so the rest of the fan-out is
 * unaffected.
 */
/**
 * Record a discovery pull into the SAME daily ledger the ARE campaigns read
 * (are_scrape_jobs). The Apollo and QuickEnrich caps are ONE budget across
 * both surfaces — apolloPulledToday / quickenrichPulledToday SUM this table —
 * so a pull that skips the ledger silently double-spends the allowance.
 * (Apollo here consulted the budget but never wrote it back; found while
 * wiring QuickEnrich, fixed for both.)
 */
async function recordPullLedger(
  workspaceId: number,
  sourceType: "apollo" | "quickenrich",
  query: string,
  resultCount: number,
): Promise<void> {
  if (resultCount <= 0) return;
  const db = await getDb();
  if (!db) return;
  try {
    await db.insert(areScrapeJobs).values({
      workspaceId,
      campaignId: null,
      sourceType,
      query: query.slice(0, 2000),
      status: "complete",
      resultCount,
      scrapedAt: new Date(),
    } as never);
  } catch (e) {
    console.error("[discovery] pull-ledger write failed:", (e as Error).message);
  }
}

async function discoverViaApollo(
  workspaceId: number,
  mode: SearchMode,
  input: DiscoveryInput,
): Promise<SourceOut> {
  const cap = await getApolloDailyCap(workspaceId);
  const used = await apolloPulledToday(workspaceId);
  const headroom = cap - used;
  if (headroom <= 0) return { raw: [], note: `today's Apollo record cap is used up (${used}/${cap})` };

  const p = input as PersonSearchInput;
  const a = input as AccountSearchInput;
  const titles = mode === "person" && p.jobTitle ? [p.jobTitle] : [];
  const industry = (mode === "person" ? p.industry : a.industry) ?? "";
  const location = (mode === "person" ? p.location : a.location) ?? "";
  const keywords = [...(input.keywords ?? [])];
  if (mode === "account" && a.companyName) keywords.push(a.companyName);
  if (mode === "person" && p.seniority) keywords.push(p.seniority);

  const res = await apolloSearchPeople(workspaceId, {
    titles,
    industries: industry ? [industry] : [],
    locations: location ? [location] : [],
    keywords,
    perPage: Math.min(headroom, 25),
  }, "findProspects");
  if (!res.ok) return { raw: [], note: res.error ?? "the Apollo search failed" };
  await recordPullLedger(workspaceId, "apollo", buildQuery(mode, input), res.prospects.length);
  return { raw: res.prospects.map((x) => ({ ...x })) };
}

/**
 * QuickEnrich as a Find-prospects source (owner ask 2026-08-21) — the same
 * free contact-finder the ARE campaigns' `quickenrich` source uses: their
 * LinkedIn-keyed DB, people returned WITHOUT emails (has_email flags only;
 * enrichment spends the credit later, per hit). Person mode only — it is a
 * people database. Shares the campaigns' daily pull budget: same cap, same
 * ledger, same has_email-first ranking of the headroom, so the two surfaces
 * cannot double-spend one allowance. Skips silently (Apollo convention in
 * this file) when there is no key, no headroom, or no title/industry to
 * filter on — searching their entire database on keywords alone is refused
 * for the same reason the ARE source refuses it.
 */
async function discoverViaQuickEnrich(
  workspaceId: number,
  input: PersonSearchInput,
): Promise<SourceOut> {
  const apiKey = await getQuickEnrichKey(workspaceId);
  if (!apiKey) return { raw: [], note: "no QuickEnrich key for this workspace (Settings → Data sources)" };
  const cap = await getQuickenrichDailyPullCap(workspaceId);
  const used = await quickenrichPulledToday(workspaceId);
  const headroom = cap - used;
  if (headroom <= 0) return { raw: [], note: `today's QuickEnrich pull cap is used up (${used}/${cap})` };
  // Industries must be validated against their controlled vocabulary — one
  // unrecognised value 422s the entire request (observed live 2026-08-24).
  // Lookup unavailable → the industry dimension is omitted, titles still search.
  const allowedIndustries = input.industry ? await getQuickenrichIndustries(apiKey) : null;
  const { body } = buildQuickenrichFilters({
    titles: input.jobTitle ? [input.jobTitle] : [],
    industries: input.industry ? [input.industry] : [],
    geos: input.location ? [input.location] : [],
  }, allowedIndustries);
  if (!body) return { raw: [], note: "needs a job title, or an industry QuickEnrich knows, to search on" };
  const res = await quickenrichContactFinder(apiKey, body, { workspaceId, feature: "findProspects" });
  // A real API failure surfaces as this source's error in perSource + the
  // run log, exactly like every other source in the fan-out.
  if (!res.ok) throw new Error(`QuickEnrich contact-finder failed: ${res.error}`);
  const kept = [...res.people]
    .sort((a, b) => Number(b.hasEmail) - Number(a.hasEmail))
    .slice(0, headroom);
  await recordPullLedger(workspaceId, "quickenrich", [input.jobTitle, input.industry, input.location].filter(Boolean).join(" · ") || "person search", kept.length);
  return {
    raw: kept.map((p) => ({
      firstName: p.firstName,
      lastName: p.lastName,
      title: p.title,
      linkedinUrl: p.linkedinUrl,
      sourceUrl: p.linkedinUrl,
      companyName: p.companyName,
      companyDomain: p.companyDomain,
    })),
  };
}

export type SearchMode = "person" | "account";

export interface PersonSearchInput {
  jobTitle?: string;
  industry?: string;
  companyName?: string;
  location?: string;
  keywords?: string[];
  seniority?: string;
  department?: string;
}

export interface AccountSearchInput {
  companyName?: string;
  industry?: string;
  location?: string;
  companySize?: string;
  revenueRange?: string;
  keywords?: string[];
  website?: string;
  buyerPersona?: string;
}

export type DiscoveryInput = PersonSearchInput | AccountSearchInput;

interface RunResult {
  runId: number;
  rawFindCount: number;
  perSource: Record<string, { found: number; error?: string }>;
  /** Phase 2 outcome (consolidation + scoring + persist into prospects).
   *  Populated when runDiscovery completes successfully. Counts are of the
   *  people SAVED (P61). */
  prospectsCreated: number;
  prospectsUpdated: number;
  /** People found and not saved: no full name, archived, suppressed, or
   *  matching someone in People by name alone. */
  prospectsSkipped: number;
  /** Account mode: companies saved. */
  accountsCreated: number;
  highConfidenceCount: number;
  mediumConfidenceCount: number;
  lowConfidenceCount: number;
  /** "failed" when the finds could not be saved (P143). */
  status: "complete" | "failed";
  errorMessage?: string;
  /** This request found the same search already running and waited for it
   *  instead of starting (and paying for) a second one (P72). */
  joinedRunning?: boolean;
  /** Finds that were already in People when the run found them (F38). */
  alreadyInPeople?: number;
  /** Found and kept as raw finds, not saved: someone reviews them first (F38). */
  heldForReview?: boolean;
}

/** Build a single Google-style query string from a structured input. */
function buildQuery(mode: SearchMode, input: DiscoveryInput): string {
  if (mode === "person") {
    const p = input as PersonSearchInput;
    return [
      p.jobTitle,
      p.seniority,
      p.department,
      p.companyName,
      p.industry,
      p.location,
      ...(p.keywords ?? []),
    ].filter(Boolean).join(" ").trim();
  }
  const a = input as AccountSearchInput;
  return [
    a.companyName,
    a.industry,
    a.location,
    a.companySize ? `${a.companySize} employees` : undefined,
    a.revenueRange,
    a.buyerPersona,
    a.website,
    ...(a.keywords ?? []),
  ].filter(Boolean).join(" ").trim();
}

/** Short context string fed to the LLM extractors so they understand
 *  what kind of result the user wants. */
function buildIcpContext(mode: SearchMode, input: DiscoveryInput): string {
  if (mode === "person") {
    const p = input as PersonSearchInput;
    return [
      p.jobTitle && `Titles: ${p.jobTitle}`,
      p.seniority && `Seniority: ${p.seniority}`,
      p.department && `Department: ${p.department}`,
      p.industry && `Industry: ${p.industry}`,
      p.location && `Location: ${p.location}`,
      p.companyName && `Company: ${p.companyName}`,
      p.keywords?.length && `Keywords: ${p.keywords.join(", ")}`,
    ].filter(Boolean).join("; ");
  }
  const a = input as AccountSearchInput;
  return [
    a.companyName && `Company: ${a.companyName}`,
    a.industry && `Industry: ${a.industry}`,
    a.location && `Location: ${a.location}`,
    a.companySize && `Size: ${a.companySize}`,
    a.revenueRange && `Revenue: ${a.revenueRange}`,
    a.buyerPersona && `Target buyer: ${a.buyerPersona}`,
    a.website && `Website: ${a.website}`,
    a.keywords?.length && `Keywords: ${a.keywords.join(", ")}`,
  ].filter(Boolean).join("; ");
}

async function emitLog(
  workspaceId: number,
  runId: number,
  phase: string,
  level: "info" | "warn" | "error",
  message: string,
  details?: unknown,
): Promise<void> {
  try {
    const db = await getDb();
    if (!db) return;
    await db.insert(discoveryLogs).values({
      workspaceId,
      runId,
      phase,
      level,
      message: message.slice(0, 800),
      details: details === undefined ? null : (details as any),
    });
  } catch (e) {
    console.error("[discovery] emitLog failed:", e);
  }
}

/** Normalize a scraper result row into the raw_finds shape. Different
 *  sources return slightly different field names; we collapse them
 *  here so downstream consolidation has one canonical shape to work
 *  against. */
export function toRawFindRow(
  workspaceId: number,
  runId: number,
  source: string,
  raw: Record<string, unknown>,
): typeof rawFinds.$inferInsert {
  /**
   * Clamps must match the COLUMN widths, not a generic 400: MySQL strict
   * mode REJECTS an over-long value, and one rejected row killed the whole
   * multi-row insert — a full run's finds, every source, lost (live
   * 2026-08-21, the first QuickEnrich rows carried a >200-char headline;
   * the older sources had just never produced one). firstName/lastName are
   * varchar(80); title/company/domain/location varchar(200); pageTitle
   * varchar(400).
   */
  const s = (k: string, max: number) => {
    const v = raw[k];
    return v == null ? null : String(v).slice(0, max);
  };
  return {
    workspaceId,
    runId,
    source,
    sourceUrl: raw.sourceUrl ? String(raw.sourceUrl) : null,
    pageTitle: s("pageTitle", 400) || s("title", 400) || null,
    snippet: raw.snippet ? String(raw.snippet).slice(0, 2000) : null,
    firstName: s("firstName", 80),
    lastName: s("lastName", 80),
    title: s("title", 200),
    companyName: s("companyName", 200) || s("company", 200),
    companyDomain: s("companyDomain", 200) || s("domain", 200),
    linkedinUrl: raw.linkedinUrl ? String(raw.linkedinUrl) : null,
    email: raw.email ? String(raw.email).slice(0, 320) : null,
    phone: raw.phone ? String(raw.phone).slice(0, 40) : null,
    location: (s("location", 200) || s("geography", 200)) ?? null,
    rawJson: raw as any,
  };
}

/**
 * The Phase 1 entry point. Creates a run row, fans out to every scraper
 * appropriate for the mode in parallel, persists raw_finds, updates
 * counters, and returns the run id so the caller (a tRPC mutation or
 * the new Find Prospects UI) can poll progress / load results.
 *
 * Synchronous within the request — the fan-out is parallel via
 * Promise.allSettled and bounded by each scraper's own LLM call
 * (~1.5s typical, ~10s worst case at the fetch timeout).
 *
 * Audit 2026-10-20, P72: because it is synchronous, a response lost to a
 * proxy timeout, a dropped connection or a reload leaves the run going with
 * no run id on the page, and pressing Run again started — and paid for — the
 * same fan-out a second time. The same search (workspace, mode, fields,
 * campaign, sources) already running in this process is now joined instead:
 * the second request waits for the first run and answers with it. Moving the
 * fan-out to a background job the page polls is what removes the long
 * request itself: Find prospects, the campaign launcher and Re-enrich now call
 * queueDiscovery (below). This awaited form stays for code already outside a
 * request.
 */
const runningSearches = new Map<string, Promise<RunResult>>();

/** Equal for two requests that would run the same search. */
export function discoveryFingerprint(
  workspaceId: number,
  mode: SearchMode,
  input: DiscoveryInput,
  campaignId: number | null | undefined,
  sources: readonly string[] | null | undefined,
): string {
  const fields: Record<string, unknown> = {};
  for (const k of Object.keys(input).sort()) {
    const v = (input as Record<string, unknown>)[k];
    if (Array.isArray(v)) {
      const list = v.map((x) => String(x).trim()).filter(Boolean);
      if (list.length) fields[k] = list;
    } else if (v != null && String(v).trim() !== "") fields[k] = String(v).trim();
  }
  return JSON.stringify([workspaceId, mode, campaignId ?? null, fields, sources?.length ? Array.from(new Set(sources)).sort() : null]);
}

export async function runDiscovery(
  workspaceId: number,
  userId: number | null,
  mode: SearchMode,
  input: DiscoveryInput,
  campaignId?: number | null,
  /** Per-run source picker (Find Prospects). Absent = every enabled candidate. */
  opts?: { sources?: readonly string[] | null },
): Promise<RunResult> {
  const key = discoveryFingerprint(workspaceId, mode, input, campaignId, opts?.sources);
  const running = runningSearches.get(key);
  if (running) return running.then((r) => ({ ...r, joinedRunning: true }));
  const run = runDiscoveryOnce(workspaceId, userId, mode, input, campaignId, opts)
    .finally(() => { runningSearches.delete(key); });
  runningSearches.set(key, run);
  return run;
}

/**
 * A run still "running" this long after it started was cut off by a restart
 * or a crash (P143): the fan-out is bounded by per-source fetch timeouts, so
 * a live one finishes in minutes. Reads mark it failed, as the research
 * pipeline does with its orphans.
 */
export const DISCOVERY_ORPHAN_MS = 30 * 60_000;

export async function failOrphanedDiscoveryRuns(workspaceId: number): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db.update(discoveryRuns).set({
    status: "failed",
    // No semicolon in the text: tenantScope's scanner reads a statement to its first one.
    errorMessage: "Stopped before it finished (the server restarted or the run crashed). Its raw finds, if any, are kept. Run it again or re-score them.",
    completedAt: new Date(),
  }).where(and(
    eq(discoveryRuns.workspaceId, workspaceId),
    eq(discoveryRuns.status, "running"),
    lt(discoveryRuns.startedAt, new Date(Date.now() - DISCOVERY_ORPHAN_MS)),
  ));
}

async function runDiscoveryOnce(
  workspaceId: number,
  userId: number | null,
  mode: SearchMode,
  input: DiscoveryInput,
  campaignId?: number | null,
  opts?: { sources?: readonly string[] | null },
): Promise<RunResult> {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");

  const startedAt = Date.now();
  const [created] = await db.insert(discoveryRuns).values({
    workspaceId,
    userId,
    campaignId: campaignId ?? null,
    mode,
    input: input as any,
    status: "running",
  }).$returningId();
  const runId = created.id;

  // Anything that throws from here on would leave the run "running" for ever
  // (P143): it is marked failed, with the reason, and the error goes on up.
  try {
    return await fanOutAndSave(db, workspaceId, runId, startedAt, mode, input, opts);
  } catch (e) {
    const message = String((e as Error)?.message ?? e).slice(0, 2000);
    await db.update(discoveryRuns).set({
      status: "failed", errorMessage: message, durationMs: Date.now() - startedAt, completedAt: new Date(),
    }).where(and(eq(discoveryRuns.id, runId), eq(discoveryRuns.workspaceId, workspaceId)));
    await emitLog(workspaceId, runId, "discovery.error", "error", `Run failed: ${message}`);
    throw e;
  }
}

/**
 * Link newly saved people to Accounts. persistAsProspects writes company
 * NAME and DOMAIN but never accountId/globalOrganizationId, even though the
 * schema comments say those are "populated by CompanyAssociationService" — so
 * Discovery v2, the flagship sourcing path, produced prospects with no company
 * association at all. Only the CSV-import path called this service, which is
 * why imported people had companies and discovered people didn't, and why the
 * same company appeared as separate unlinked entities per source. Source
 * search's promote and the LinkedIn import save through the same consolidation
 * and call this too (P71).
 *
 * Fire-and-forget, same as the import path: linking must not slow or fail the
 * response the user is waiting on.
 */
export function associateDiscoveredPeople(workspaceId: number, runId: number): void {
  void import("../company/associationService")
    .then((m) => m.associateUnlinkedProspects(workspaceId, 3000, "discovery"))
    .then((s) => emitLog(workspaceId, runId, "company.associate", "info",
      `Company association: ${s.linked} linked, ${s.created} accounts created, ${s.needsReview} need review, ${s.missing} without a company`))
    .catch((e) => console.error("[discovery] company association failed:", e));
}

/**
 * Finds that come from somewhere other than the fan-out (the LinkedIn search
 * card), saved to People through the same run → raw finds → consolidation, so
 * one set of rules decides who is the same person and who is left out.
 */
export async function saveFindsAsPeople(
  workspaceId: number,
  userId: number | null,
  source: string,
  finds: Array<Record<string, unknown>>,
  input: Record<string, unknown>,
): Promise<{ runId: number; prospectsCreated: number; prospectsUpdated: number; prospectsSkipped: number }> {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");
  const startedAt = Date.now();
  const [created] = await db.insert(discoveryRuns).values({
    workspaceId, userId, campaignId: null, mode: "person", input: input as any, status: "running",
  }).$returningId();
  const runId = created.id;
  try {
    let stored = 0;
    for (const f of finds) {
      try { await db.insert(rawFinds).values(toRawFindRow(workspaceId, runId, source, f)); stored++; }
      catch (e) { console.error("[discovery] raw_find row unstorable, skipped:", (e as Error)?.message); }
    }
    await db.update(discoveryRuns).set({ rawFindCount: stored })
      .where(and(eq(discoveryRuns.id, runId), eq(discoveryRuns.workspaceId, workspaceId)));
    const r = await processRun(workspaceId, runId, "person");
    await db.update(discoveryRuns).set({ status: "complete", durationMs: Date.now() - startedAt, completedAt: new Date() })
      .where(and(eq(discoveryRuns.id, runId), eq(discoveryRuns.workspaceId, workspaceId)));
    associateDiscoveredPeople(workspaceId, runId);
    return { runId, prospectsCreated: r.prospectsCreated, prospectsUpdated: r.prospectsUpdated, prospectsSkipped: skippedCount(r) + (finds.length - stored) };
  } catch (e) {
    await db.update(discoveryRuns).set({
      status: "failed", errorMessage: String((e as Error)?.message ?? e).slice(0, 2000), durationMs: Date.now() - startedAt, completedAt: new Date(),
    }).where(and(eq(discoveryRuns.id, runId), eq(discoveryRuns.workspaceId, workspaceId)));
    throw e;
  }
}

async function fanOutAndSave(
  db: NonNullable<Awaited<ReturnType<typeof getDb>>>,
  workspaceId: number,
  runId: number,
  startedAt: number,
  mode: SearchMode,
  input: DiscoveryInput,
  opts?: { sources?: readonly string[] | null; holdForReview?: boolean },
): Promise<RunResult> {
  const query = buildQuery(mode, input);
  const icpContext = buildIcpContext(mode, input);
  await emitLog(workspaceId, runId, "discovery.start", "info",
    `Discovery run started — mode=${mode}, query="${query}"`, { input, sources: opts?.sources ?? null });

  if (!query) {
    await emitLog(workspaceId, runId, "discovery.skip", "warn",
      "No query terms — every input field was empty.");
    await db.update(discoveryRuns).set({
      status: "failed",
      errorMessage: "No query terms",
      durationMs: Date.now() - startedAt,
      completedAt: new Date(),
    }).where(and(eq(discoveryRuns.id, runId), eq(discoveryRuns.workspaceId, workspaceId)));
    return { runId, rawFindCount: 0, perSource: {}, prospectsCreated: 0, prospectsUpdated: 0, prospectsSkipped: 0, accountsCreated: 0, highConfidenceCount: 0, mediumConfidenceCount: 0, lowConfidenceCount: 0, status: "failed", errorMessage: "No query terms" };
  }

  // Choose the source mix per mode. Person mode favors profile lookups and the
  // vendor databases (LinkedIn, news, Apollo, QuickEnrich). Account mode favors
  // company-shaped sources (Google Business, news, Apollo). Neither includes
  // web pages or company sites: that source was removed on 2026-10-27, and this
  // comment said otherwise until 2026-11-01.
  // Both run in parallel so one slow source doesn't gate the others.
  //
  // The workspace's source mask (Settings, workspace_settings.areSourceConfig,
  // migration 0172) applies on this surface exactly as in the ARE engine: a
  // source the workspace disabled never runs, whatever the mode mix says.
  // ORDER is irrelevant here — raw finds are consolidated, not first-claimed.
  //
  // "Web scraping" is not offered (audit 2026-10-20, P62/A25): it reads a
  // page at a URL, and this search is text, so it returned nothing every time
  // while showing as a source. It stays on the Scraper tab, for a URL.
  type SourceTask = { id: AreSourceId; run: () => Promise<{ source: string } & SourceOut> };
  const candidates: SourceTask[] = mode === "person"
    ? [
      { id: "linkedin", run: () => discoverLinkedInPeople(workspaceId, query).then((r) => ({ source: "linkedin_people", ...r })) },
      { id: "news", run: () => scrapeNews(workspaceId, null, query, icpContext).then((raw) => ({ source: "news", raw })) },
      { id: "apollo", run: () => discoverViaApollo(workspaceId, mode, input).then((r) => ({ source: "apollo", ...r })) },
      { id: "quickenrich", run: () => discoverViaQuickEnrich(workspaceId, input as PersonSearchInput).then((r) => ({ source: "quickenrich", ...r })) },
    ]
    : [
      // Account mode keeps the company-shaped sources. LinkedIn's classic
      // search is people-only, so there's no real "company" LinkedIn source to
      // include here — the old scrapeLinkedIn(...,"company") just fabricated.
      { id: "google_business", run: () => scrapeGoogleBusiness(workspaceId, null, query, icpContext).then((raw) => ({ source: "google_business", raw })) },
      { id: "news", run: () => scrapeNews(workspaceId, null, query, icpContext).then((raw) => ({ source: "news", raw })) },
      { id: "apollo", run: () => discoverViaApollo(workspaceId, mode, input).then((r) => ({ source: "apollo", ...r })) },
    ];
  const [wsSourceRow] = await db
    .select({ order: workspaceSettings.areSourceOrder, mask: workspaceSettings.areScraperSources })
    .from(workspaceSettings)
    .where(eq(workspaceSettings.workspaceId, workspaceId))
    .limit(1);
  const enabledSources = new Set(resolveSourceOrder(wsSourceRow?.order, wsSourceRow?.mask, ARE_SOURCE_IDS));
  // The per-run picker (owner ask 2026-09-22) narrows the mode's candidates
  // AFTER the mask: a selection can never re-enable a source Settings
  // disabled, nor add one the mode does not offer. Absent = every enabled
  // candidate, which is what this page ran before it had a picker.
  const pick = selectRunSources(candidates.map((c) => c.id), enabledSources, opts?.sources);
  if (pick.masked.length > 0) {
    await emitLog(workspaceId, runId, "discovery.mask", "info",
      `Skipped — disabled in workspace Settings: ${pick.masked.join(", ")}`);
  }
  if (pick.unselected.length > 0) {
    await emitLog(workspaceId, runId, "discovery.select", "info",
      `Skipped — not selected for this run: ${pick.unselected.join(", ")}`);
  }
  const runSet = new Set<AreSourceId>(pick.run);
  const tasks = candidates.filter((c) => runSet.has(c.id)).map((c) => c.run());

  const settled = await Promise.allSettled(tasks);
  const perSource: Record<string, { found: number; error?: string; note?: string }> = {};
  let totalFinds = 0;
  const rowsToInsert: typeof rawFinds.$inferInsert[] = [];

  for (const s of settled) {
    if (s.status === "rejected") {
      const reason = s.reason instanceof Error ? s.reason.message : String(s.reason);
      perSource["unknown"] = { found: 0, error: reason };
      await emitLog(workspaceId, runId, "source.error", "error",
        `Source failed: ${reason}`, { reason });
      continue;
    }
    const { source, raw, note } = s.value;
    perSource[source] = { found: raw.length, ...(note ? { note } : {}) };
    totalFinds += raw.length;
    // A source that could not run says why (P63), and says it as a warning.
    await emitLog(workspaceId, runId, "source.complete", note ? "warn" : "info",
      `Source ${source} returned ${raw.length} finds${note ? ` — ${note}` : ""}`, { source, count: raw.length, ...(note ? { note } : {}) });
    for (const r of raw) {
      rowsToInsert.push(toRawFindRow(workspaceId, runId, source, r));
    }
  }

  // "Already in People?" (audit 2026-10-20, F38): every find is checked
  // against the workspace's People and campaign queue with the one identity
  // check Source search uses, before anything is saved, so the run can show
  // which finds were new and which were someone already there.
  let alreadyInPeople = 0;
  if (rowsToInsert.length > 0) {
    try {
      const index = await workspaceIdentityIndex(workspaceId);
      for (const row of rowsToInsert) {
        const known = alreadyInWorkspace(index, { email: row.email, linkedinUrl: row.linkedinUrl, firstName: row.firstName, lastName: row.lastName, companyName: row.companyName, companyDomain: row.companyDomain });
        row.knownAs = known.status;
        row.knownProspectId = known.prospectId;
        if (known.status === "in_people") alreadyInPeople++;
      }
    } catch (e) {
      // The check is a preview: a failed one leaves the finds unlabelled, never unsaved.
      console.error("[discovery] already-in-People check failed:", (e as Error)?.message);
    }
  }

  if (rowsToInsert.length > 0) {
    // Insert in chunks of 50 to keep a single statement reasonable. A failed
    // chunk falls back to per-row so ONE unstorable row cannot lose the whole
    // run's finds across every source (which is exactly what happened live on
    // 2026-08-21 before the clamps above matched the column widths — the
    // imports commit uses the same chunk-then-per-row shape for the same
    // reason).
    for (let i = 0; i < rowsToInsert.length; i += 50) {
      const chunk = rowsToInsert.slice(i, i + 50);
      try {
        await db.insert(rawFinds).values(chunk);
      } catch {
        for (const row of chunk) {
          try {
            await db.insert(rawFinds).values(row);
          } catch (e) {
            totalFinds--;
            console.error("[discovery] raw_find row unstorable, skipped:", (e as Error)?.cause ?? (e as Error)?.message);
          }
        }
      }
    }
  }

  // Update counters BEFORE Phase 2 so the run is queryable even if
  // consolidation fails (the user still wants to see what came back).
  // totalFinds counts what was STORED: an unstorable row was subtracted above.
  await db.update(discoveryRuns).set({
    rawFindCount: totalFinds,
    alreadyInPeople,
  }).where(and(eq(discoveryRuns.id, runId), eq(discoveryRuns.workspaceId, workspaceId)));

  // Review before saving (F38): the finds stay as raw finds, labelled new or
  // already in People, and Save to People on the run (discovery.reprocess)
  // saves them through the same consolidation.
  if (opts?.holdForReview && totalFinds > 0) {
    const durationMs = Date.now() - startedAt;
    await db.update(discoveryRuns).set({ status: "complete", heldForReview: true, durationMs, completedAt: new Date() })
      .where(and(eq(discoveryRuns.id, runId), eq(discoveryRuns.workspaceId, workspaceId)));
    await emitLog(workspaceId, runId, "discovery.held", "info",
      `Run complete — ${totalFinds} raw finds, ${alreadyInPeople} already in People. Not saved yet: review them, then Save to People.`,
      { perSource, durationMs, alreadyInPeople });
    return { runId, rawFindCount: totalFinds, perSource, prospectsCreated: 0, prospectsUpdated: 0, prospectsSkipped: 0, accountsCreated: 0, highConfidenceCount: 0, mediumConfidenceCount: 0, lowConfidenceCount: 0, status: "complete", alreadyInPeople, heldForReview: true };
  }

  // Phase 2: consolidate raw_finds → score → persist into prospects.
  // A Phase 2 failure still leaves a usable run (raw_finds are queryable and
  // Re-score retries the save), but the run says it FAILED, with the reason:
  // it used to be stamped complete with nothing saved (P143).
  let persist: PersistResult = { prospectsCreated: 0, prospectsUpdated: 0, highConfidenceCount: 0, mediumConfidenceCount: 0, lowConfidenceCount: 0 };
  let saveError: string | null = null;
  try {
    if (totalFinds > 0) {
      persist = await processRun(workspaceId, runId, mode);
      associateDiscoveredPeople(workspaceId, runId);
    }
  } catch (e) {
    saveError = `Saving the finds failed: ${String((e as Error)?.message ?? e).slice(0, 500)}. The raw finds are kept; Re-score tries again.`;
    await emitLog(workspaceId, runId, "consolidate.error", "error",
      `Consolidation/persist failed: ${(e as Error)?.message ?? e}`,
      { stack: (e as Error)?.stack });
  }

  const durationMs = Date.now() - startedAt;
  await db.update(discoveryRuns).set({
    status: saveError ? "failed" : "complete",
    ...(saveError ? { errorMessage: saveError } : {}),
    durationMs,
    completedAt: new Date(),
  }).where(and(eq(discoveryRuns.id, runId), eq(discoveryRuns.workspaceId, workspaceId)));

  const persistResult = {
    prospectsCreated: persist.prospectsCreated,
    prospectsUpdated: persist.prospectsUpdated,
    prospectsSkipped: skippedCount(persist),
    accountsCreated: persist.accountsCreated ?? 0,
    highConfidenceCount: persist.highConfidenceCount,
    mediumConfidenceCount: persist.mediumConfidenceCount,
    lowConfidenceCount: persist.lowConfidenceCount,
  };
  await emitLog(workspaceId, runId, saveError ? "discovery.failed" : "discovery.complete", saveError ? "error" : "info",
    saveError
      ? `Run failed after ${totalFinds} raw finds in ${durationMs}ms — ${saveError}`
      : `Run complete — ${totalFinds} raw / ${persistResult.prospectsCreated} new + ${persistResult.prospectsUpdated} updated / ${persistResult.highConfidenceCount} high · ${persistResult.mediumConfidenceCount} medium · ${persistResult.lowConfidenceCount} low in ${durationMs}ms`,
    { perSource, durationMs, persistResult });

  return {
    runId, rawFindCount: totalFinds, perSource, ...persistResult, alreadyInPeople,
    status: saveError ? "failed" : "complete",
    ...(saveError ? { errorMessage: saveError } : {}),
  };
}

/* ─── The fan-out as a persisted job (audit 2026-10-20, P72) ─────────── */

/**
 * The fan-out ran inside the HTTP request: a response lost to a proxy
 * timeout, a dropped connection or a reload left the run going with no run id
 * on the page, and a retry paid for it again. Now a search is a discovery run
 * plus a bulk_jobs row (services/jobs/runner): the request answers at once
 * with the run id, the worker runs the fan-out, and Find prospects and the
 * campaign launcher follow the run (discovery.getRun) until it ends. The run
 * row, its raw finds and its log are what they were.
 *
 * Two rules keep it from spending twice:
 *   - the same search already queued or running is joined: the second click
 *     gets the first run back (the fingerprint is in the job's payload);
 *   - the fan-out starts at most once per run: a worker that dies mid-run
 *     leaves fanOutStartedAt set, and the job that picks the run up again
 *     marks it stopped instead of calling the vendors a second time.
 */
export const DISCOVERY_JOB = "discovery.run";

export type DiscoveryJobPayload = {
  runId: number;
  mode: SearchMode;
  input: DiscoveryInput;
  campaignId: number | null;
  sources: string[] | null;
  fingerprint: string;
  holdForReview?: boolean;
};

export type QueuedRun = { runId: number; jobId: number; status: "running"; joinedRunning?: boolean; heldForReview?: boolean };

export const DISCOVERY_RESTARTED_ERROR = "Stopped before it finished (the server restarted mid-run). It was not run again, so nothing was paid for twice. Its raw finds, if any, are kept: re-score them, or run the search again.";

/** One enqueue at a time per search in this process, so two quick clicks cannot both find no job. */
const queueing = new Map<string, Promise<QueuedRun>>();

export async function queueDiscovery(
  workspaceId: number,
  userId: number | null,
  mode: SearchMode,
  input: DiscoveryInput,
  campaignId?: number | null,
  opts?: { sources?: readonly string[] | null; holdForReview?: boolean },
): Promise<QueuedRun> {
  const fingerprint = discoveryFingerprint(workspaceId, mode, input, campaignId, opts?.sources) + (opts?.holdForReview ? "|held" : "");
  const pending = queueing.get(fingerprint);
  if (pending) return pending.then((r) => ({ ...r, joinedRunning: true }));
  const p = (async (): Promise<QueuedRun> => {
    const active = await findActiveJob<DiscoveryJobPayload>(workspaceId, DISCOVERY_JOB, (pl) => pl.fingerprint === fingerprint);
    if (active) {
      const pl = (active.payload ?? {}) as DiscoveryJobPayload;
      return { runId: pl.runId, jobId: active.id, status: "running", joinedRunning: true, ...(pl.holdForReview ? { heldForReview: true } : {}) };
    }
    const db = await getDb();
    if (!db) throw new Error("DB unavailable");
    const [created] = await db.insert(discoveryRuns).values({
      workspaceId, userId, campaignId: campaignId ?? null, mode, input: input as any, status: "running",
    }).$returningId();
    const payload: DiscoveryJobPayload = {
      runId: created.id, mode, input, campaignId: campaignId ?? null,
      sources: opts?.sources?.length ? Array.from(opts.sources) : null, fingerprint,
      ...(opts?.holdForReview ? { holdForReview: true } : {}),
    };
    const { job } = await enqueueJob({ workspaceId, userId, kind: DISCOVERY_JOB, payload, total: 1 });
    await emitLog(workspaceId, created.id, "discovery.queued", "info", `Queued as background job ${job.id}; it starts within seconds.`);
    kickJobs();
    return { runId: created.id, jobId: job.id, status: "running", ...(opts?.holdForReview ? { heldForReview: true } : {}) };
  })().finally(() => { queueing.delete(fingerprint); });
  queueing.set(fingerprint, p);
  return p;
}

/** The worker's half: the fan-out for one queued run, at most once. Null when it had already started. */
export async function runQueuedDiscovery(workspaceId: number, p: DiscoveryJobPayload): Promise<RunResult | null> {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");
  const [res] = await db.update(discoveryRuns).set({ fanOutStartedAt: new Date() }).where(and(
    eq(discoveryRuns.id, p.runId),
    eq(discoveryRuns.workspaceId, workspaceId),
    eq(discoveryRuns.status, "running"),
    isNull(discoveryRuns.fanOutStartedAt),
  ));
  if (Number((res as { affectedRows?: number })?.affectedRows ?? 0) !== 1) {
    // Started before by a worker that is gone, or no longer running: never again.
    await db.update(discoveryRuns).set({ status: "failed", errorMessage: DISCOVERY_RESTARTED_ERROR, completedAt: new Date() })
      .where(and(eq(discoveryRuns.id, p.runId), eq(discoveryRuns.workspaceId, workspaceId), eq(discoveryRuns.status, "running")));
    return null;
  }
  const startedAt = Date.now();
  try {
    return await fanOutAndSave(db, workspaceId, p.runId, startedAt, p.mode, p.input, { sources: p.sources, holdForReview: p.holdForReview });
  } catch (e) {
    const message = String((e as Error)?.message ?? e).slice(0, 2000);
    await db.update(discoveryRuns).set({
      status: "failed", errorMessage: message, durationMs: Date.now() - startedAt, completedAt: new Date(),
    }).where(and(eq(discoveryRuns.id, p.runId), eq(discoveryRuns.workspaceId, workspaceId)));
    await emitLog(workspaceId, p.runId, "discovery.error", "error", `Run failed: ${message}`);
    return { runId: p.runId, rawFindCount: 0, perSource: {}, prospectsCreated: 0, prospectsUpdated: 0, prospectsSkipped: 0, accountsCreated: 0, highConfidenceCount: 0, mediumConfidenceCount: 0, lowConfidenceCount: 0, status: "failed", errorMessage: message };
  }
}

registerJobKind<DiscoveryJobPayload>(DISCOVERY_JOB, {
  // One item, the whole fan-out; it is bounded by each source's own timeouts.
  async step(job, payload) {
    const r = await withHeartbeat(job.id, () => runQueuedDiscovery(job.workspaceId, payload));
    const failed = !r || r.status === "failed";
    return {
      cursor: 1,
      done: failed ? 0 : 1,
      failures: failed ? [{ id: payload.runId, error: (r?.errorMessage ?? DISCOVERY_RESTARTED_ERROR).slice(0, 200) }] : [],
      finished: true,
      message: r ? `Run #${payload.runId}: ${r.rawFindCount} raw finds` : `Run #${payload.runId} stopped`,
    };
  },
});
