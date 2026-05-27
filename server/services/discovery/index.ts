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
  discoveryLogs,
  discoveryRuns,
  rawFinds,
} from "../../../drizzle/schema";
import {
  scrapeGoogleBusiness,
  scrapeLinkedIn,
  scrapeNews,
  scrapeWeb,
} from "../../routers/are/scraper";
import { processRun } from "./consolidate";

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
function toRawFindRow(
  workspaceId: number,
  runId: number,
  source: string,
  raw: Record<string, unknown>,
): typeof rawFinds.$inferInsert {
  const s = (k: string) => {
    const v = raw[k];
    return v == null ? null : String(v).slice(0, 400);
  };
  return {
    workspaceId,
    runId,
    source,
    sourceUrl: raw.sourceUrl ? String(raw.sourceUrl) : null,
    pageTitle: s("pageTitle") || s("title") || null,
    snippet: raw.snippet ? String(raw.snippet).slice(0, 2000) : null,
    firstName: s("firstName"),
    lastName: s("lastName"),
    title: s("title"),
    companyName: s("companyName") || s("company"),
    companyDomain: s("companyDomain") || s("domain"),
    linkedinUrl: raw.linkedinUrl ? String(raw.linkedinUrl) : null,
    email: raw.email ? String(raw.email).slice(0, 320) : null,
    phone: raw.phone ? String(raw.phone).slice(0, 40) : null,
    location: s("location") || s("geography") || null,
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
      scrapeLinkedIn(workspaceId, null, query, "people", icpContext).then((raw) => ({ source: "linkedin_people", raw })),
      scrapeWeb(workspaceId, null, query, icpContext).then((raw) => ({ source: "web", raw })),
      scrapeNews(workspaceId, null, query, icpContext).then((raw) => ({ source: "news", raw })),
    );
  } else {
    tasks.push(
      scrapeGoogleBusiness(workspaceId, null, query, icpContext).then((raw) => ({ source: "google_business", raw })),
      scrapeLinkedIn(workspaceId, null, query, "company", icpContext).then((raw) => ({ source: "linkedin_company", raw })),
      scrapeWeb(workspaceId, null, query, icpContext).then((raw) => ({ source: "web", raw })),
      scrapeNews(workspaceId, null, query, icpContext).then((raw) => ({ source: "news", raw })),
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
    // Insert in chunks of 50 to keep a single statement reasonable.
    for (let i = 0; i < rowsToInsert.length; i += 50) {
      await db.insert(rawFinds).values(rowsToInsert.slice(i, i + 50));
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
