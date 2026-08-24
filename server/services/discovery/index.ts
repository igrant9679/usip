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
import { and, eq } from "drizzle-orm";
import { getDb } from "../../db";
import {
  areScrapeJobs,
  discoveryLogs,
  discoveryRuns,
  rawFinds,
} from "../../../drizzle/schema";
import {
  scrapeGoogleBusiness,
  scrapeNews,
  scrapeWeb,
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
import { processRun } from "./consolidate";

/**
 * Real LinkedIn people search for Discovery v2 (replaces the old fabricating
 * scrapeLinkedIn). Pulls from the workspace's bridged LinkedIn account pool
 * (isAdmin so it isn't scoped to one user) and maps hits into the raw-find
 * shape. Returns [] when no account is bridged or the search fails.
 */
async function discoverLinkedInPeople(
  workspaceId: number,
  query: string,
): Promise<Array<Record<string, unknown>>> {
  const res = await searchLinkedInProfiles({
    workspaceId,
    userId: 0,
    isAdmin: true,
    keywords: query,
    limit: 25,
  });
  if (!res.ok) return [];
  return res.hits.map((h) => ({
    firstName: h.firstName,
    lastName: h.lastName,
    title: h.headline,
    companyName: h.company,
    linkedinUrl: h.linkedinUrl,
    sourceUrl: h.linkedinUrl,
    geography: h.location,
  }));
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
): Promise<Array<Record<string, unknown>>> {
  const cap = await getApolloDailyCap(workspaceId);
  const headroom = cap - (await apolloPulledToday(workspaceId));
  if (headroom <= 0) return [];

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
  });
  if (!res.ok) return [];
  await recordPullLedger(workspaceId, "apollo", buildQuery(mode, input), res.prospects.length);
  return res.prospects.map((x) => ({ ...x }));
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
): Promise<Array<Record<string, unknown>>> {
  const apiKey = await getQuickEnrichKey(workspaceId);
  if (!apiKey) return [];
  const cap = await getQuickenrichDailyPullCap(workspaceId);
  const headroom = cap - (await quickenrichPulledToday(workspaceId));
  if (headroom <= 0) return [];
  // Industries must be validated against their controlled vocabulary — one
  // unrecognised value 422s the entire request (observed live 2026-08-24).
  // Lookup unavailable → the industry dimension is omitted, titles still search.
  const allowedIndustries = input.industry ? await getQuickenrichIndustries(apiKey) : null;
  const { body } = buildQuickenrichFilters({
    titles: input.jobTitle ? [input.jobTitle] : [],
    industries: input.industry ? [input.industry] : [],
    geos: input.location ? [input.location] : [],
  }, allowedIndustries);
  if (!body) return [];
  const res = await quickenrichContactFinder(apiKey, body);
  // A real API failure surfaces as this source's error in perSource + the
  // run log, exactly like every other source in the fan-out.
  if (!res.ok) throw new Error(`QuickEnrich contact-finder failed: ${res.error}`);
  const kept = [...res.people]
    .sort((a, b) => Number(b.hasEmail) - Number(a.hasEmail))
    .slice(0, headroom);
  await recordPullLedger(workspaceId, "quickenrich", [input.jobTitle, input.industry, input.location].filter(Boolean).join(" · ") || "person search", kept.length);
  return kept.map((p) => ({
    firstName: p.firstName,
    lastName: p.lastName,
    title: p.title,
    linkedinUrl: p.linkedinUrl,
    sourceUrl: p.linkedinUrl,
    companyName: p.companyName,
    companyDomain: p.companyDomain,
  }));
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
   *  Populated when runDiscovery completes successfully. */
  prospectsCreated: number;
  prospectsUpdated: number;
  highConfidenceCount: number;
  mediumConfidenceCount: number;
  lowConfidenceCount: number;
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
 */
export async function runDiscovery(
  workspaceId: number,
  userId: number | null,
  mode: SearchMode,
  input: DiscoveryInput,
  campaignId?: number | null,
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

  const query = buildQuery(mode, input);
  const icpContext = buildIcpContext(mode, input);
  await emitLog(workspaceId, runId, "discovery.start", "info",
    `Discovery run started — mode=${mode}, query="${query}"`, { input });

  if (!query) {
    await emitLog(workspaceId, runId, "discovery.skip", "warn",
      "No query terms — every input field was empty.");
    await db.update(discoveryRuns).set({
      status: "failed",
      errorMessage: "No query terms",
      durationMs: Date.now() - startedAt,
      completedAt: new Date(),
    }).where(eq(discoveryRuns.id, runId));
    return { runId, rawFindCount: 0, perSource: {}, prospectsCreated: 0, prospectsUpdated: 0, highConfidenceCount: 0, mediumConfidenceCount: 0, lowConfidenceCount: 0 };
  }

  // Choose the source mix per mode. Person mode favors profile lookups
  // (LinkedIn + web pages with team bios). Account mode favors
  // company-shaped sources (Google Business + company sites + news).
  // Both run in parallel so one slow source doesn't gate the others.
  const tasks: Array<Promise<{ source: string; raw: Array<Record<string, unknown>> }>> = [];
  if (mode === "person") {
    tasks.push(
      discoverLinkedInPeople(workspaceId, query).then((raw) => ({ source: "linkedin_people", raw })),
      scrapeWeb(workspaceId, null, query, icpContext).then((raw) => ({ source: "web", raw })),
      scrapeNews(workspaceId, null, query, icpContext).then((raw) => ({ source: "news", raw })),
      discoverViaApollo(workspaceId, mode, input).then((raw) => ({ source: "apollo", raw })),
      discoverViaQuickEnrich(workspaceId, input as PersonSearchInput).then((raw) => ({ source: "quickenrich", raw })),
    );
  } else {
    // Account mode keeps the company-shaped sources. LinkedIn's classic
    // search is people-only, so there's no real "company" LinkedIn source to
    // include here — the old scrapeLinkedIn(...,"company") just fabricated.
    tasks.push(
      scrapeGoogleBusiness(workspaceId, null, query, icpContext).then((raw) => ({ source: "google_business", raw })),
      scrapeWeb(workspaceId, null, query, icpContext).then((raw) => ({ source: "web", raw })),
      scrapeNews(workspaceId, null, query, icpContext).then((raw) => ({ source: "news", raw })),
      discoverViaApollo(workspaceId, mode, input).then((raw) => ({ source: "apollo", raw })),
    );
  }

  const settled = await Promise.allSettled(tasks);
  const perSource: Record<string, { found: number; error?: string }> = {};
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
    const { source, raw } = s.value;
    perSource[source] = { found: raw.length };
    totalFinds += raw.length;
    await emitLog(workspaceId, runId, "source.complete", "info",
      `Source ${source} returned ${raw.length} finds`, { source, count: raw.length });
    for (const r of raw) {
      rowsToInsert.push(toRawFindRow(workspaceId, runId, source, r));
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
  await db.update(discoveryRuns).set({
    rawFindCount: totalFinds,
  }).where(and(eq(discoveryRuns.id, runId), eq(discoveryRuns.workspaceId, workspaceId)));

  // Phase 2: consolidate raw_finds → score → persist into prospects.
  // Wrapped in try/catch so a Phase 2 failure still leaves a usable
  // run (raw_finds are queryable, the user can re-trigger consolidate).
  let persistResult = { prospectsCreated: 0, prospectsUpdated: 0, highConfidenceCount: 0, mediumConfidenceCount: 0, lowConfidenceCount: 0 };
  try {
    if (totalFinds > 0) {
      persistResult = await processRun(workspaceId, runId, mode);

      // Link the new prospects to Accounts. persistAsProspects writes company
      // NAME and DOMAIN but never accountId/globalOrganizationId, even though
      // the schema comments say those are "populated by
      // CompanyAssociationService" — so Discovery v2, the flagship sourcing
      // path, produced prospects with no company association at all. Only the
      // CSV-import path called this service, which is why imported people had
      // companies and discovered people didn't, and why the same company
      // appeared as separate unlinked entities per source.
      //
      // Fire-and-forget, same as the import path: linking must not slow or
      // fail the discovery response the user is waiting on.
      void import("../company/associationService")
        .then((m) => m.associateUnlinkedProspects(workspaceId, 3000, "discovery"))
        .then((s) => emitLog(workspaceId, runId, "company.associate", "info",
          `Company association: ${s.linked} linked, ${s.created} accounts created, ${s.needsReview} need review, ${s.missing} without a company`))
        .catch((e) => console.error("[discovery] company association failed:", e));
    }
  } catch (e) {
    await emitLog(workspaceId, runId, "consolidate.error", "error",
      `Consolidation/persist failed: ${(e as Error)?.message ?? e}`,
      { stack: (e as Error)?.stack });
  }

  const durationMs = Date.now() - startedAt;
  await db.update(discoveryRuns).set({
    status: "complete",
    durationMs,
    completedAt: new Date(),
  }).where(and(eq(discoveryRuns.id, runId), eq(discoveryRuns.workspaceId, workspaceId)));

  await emitLog(workspaceId, runId, "discovery.complete", "info",
    `Run complete — ${totalFinds} raw / ${persistResult.prospectsCreated} new + ${persistResult.prospectsUpdated} updated / ${persistResult.highConfidenceCount} high · ${persistResult.mediumConfidenceCount} medium · ${persistResult.lowConfidenceCount} low in ${durationMs}ms`,
    { perSource, durationMs, persistResult });

  return { runId, rawFindCount: totalFinds, perSource, ...persistResult };
}
