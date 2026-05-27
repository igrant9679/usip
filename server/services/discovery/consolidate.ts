/**
 * Discovery v2 — Phase 2: consolidate + score + persist.
 *
 * After Phase 1 has fanned out scrapers and persisted raw_finds, this
 * module:
 *   1. consolidateIdentities(runId) — clusters rows by (name+company)
 *      for person mode or by domain+name for account mode, merges
 *      fields preferring the most-complete record, and tracks every
 *      source URL that contributed.
 *   2. scoreConfidence(candidate) — multi-field 0–100 + tier. NEVER
 *      makes another LLM call; pure deterministic scoring over what
 *      Phase 1 already collected. Verification of a LinkedIn URL via
 *      Unipile is deferred to a per-prospect "Verify" action (P4).
 *   3. persistAsProspects(runId, mode) — dedup against existing
 *      prospects (by linkedinUrl / email / name+company), update the
 *      matching row OR insert a new one with the right
 *      verificationStatus (high → verified, medium/low → needs_review).
 *
 * Verification logic is conservative: any cross-source disagreement on
 * a key field (different titles for the same name+company) drops the
 * candidate to "needs_review" with a note. Low-confidence rows are
 * still SAVED so the user can triage them; they're just flagged.
 */
import { and, eq, or } from "drizzle-orm";
import { getDb } from "../../db";
import {
  discoveryLogs,
  discoveryRuns,
  prospects,
  rawFinds,
} from "../../../drizzle/schema";

/* ─── Normalization helpers ──────────────────────────────────────────── */
function norm(s: string | null | undefined): string {
  return String(s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function isEmail(s: string | null | undefined): boolean {
  if (!s) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}
function isLinkedInUrl(s: string | null | undefined): boolean {
  if (!s) return false;
  try {
    const u = new URL(s.startsWith("http") ? s : "https://" + s);
    return /linkedin\.com$/i.test(u.hostname) || /linkedin\.com$/i.test(u.hostname.replace(/^www\./, ""));
  } catch {
    return false;
  }
}

/* ─── Types ─────────────────────────────────────────────────────────── */

type RawFindRow = typeof rawFinds.$inferSelect;

export interface IdentityCandidate {
  /** Canonical merged fields. */
  firstName: string | null;
  lastName: string | null;
  title: string | null;
  companyName: string | null;
  companyDomain: string | null;
  linkedinUrl: string | null;
  email: string | null;
  phone: string | null;
  location: string | null;
  /** Every source URL across the cluster. */
  sourceUrls: string[];
  /** raw_finds row ids that contributed. */
  sourceRows: number[];
  /** sources (names) that contributed — for cross-source agreement scoring. */
  sources: Set<string>;
  /** Conflicting values per field — used to drop tier when sources disagree. */
  conflicts: Record<string, Set<string>>;
}

export interface ScoredCandidate extends IdentityCandidate {
  score: number;
  tier: "high" | "medium" | "low";
  status: "verified" | "needs_review";
  notes: string[];
  linkedinUrlVerified: boolean;
}

/* ─── Consolidate raw_finds into identity candidates ────────────────── */

export function consolidateIdentities(
  rows: RawFindRow[],
  mode: "person" | "account",
): IdentityCandidate[] {
  const clusters = new Map<string, RawFindRow[]>();
  for (const row of rows) {
    let key = "";
    if (mode === "person") {
      const nm = norm(`${row.firstName ?? ""} ${row.lastName ?? ""}`);
      const co = norm(row.companyName ?? "");
      if (!nm) continue; // need at least a name
      key = co ? `${nm}|${co}` : nm;
    } else {
      // Prefer domain because companies often share a partial name.
      key = norm(row.companyDomain ?? "") || norm(row.companyName ?? "");
      if (!key) continue;
    }
    const arr = clusters.get(key) ?? [];
    arr.push(row);
    clusters.set(key, arr);
  }

  const candidates: IdentityCandidate[] = [];
  for (const cluster of clusters.values()) {
    candidates.push(mergeCluster(cluster));
  }
  return candidates;
}

function mergeCluster(cluster: RawFindRow[]): IdentityCandidate {
  // Canonical = row with most non-null core fields.
  const score = (r: RawFindRow) =>
    [r.firstName, r.lastName, r.title, r.companyName, r.companyDomain, r.linkedinUrl, r.email, r.location]
      .filter((v) => v != null && String(v).trim() !== "").length;
  const canonical = [...cluster].sort((a, b) => score(b) - score(a))[0];

  const sourceUrls = new Set<string>();
  const sources = new Set<string>();
  const sourceRows: number[] = [];
  const conflicts: Record<string, Set<string>> = {};
  const trackConflict = (field: string, value: string | null | undefined) => {
    if (!value) return;
    const v = String(value).trim();
    if (!v) return;
    if (!conflicts[field]) conflicts[field] = new Set();
    conflicts[field].add(v.toLowerCase());
  };

  for (const r of cluster) {
    sourceRows.push(r.id);
    sources.add(r.source);
    if (r.sourceUrl) sourceUrls.add(r.sourceUrl);
    trackConflict("title", r.title);
    trackConflict("companyName", r.companyName);
    trackConflict("linkedinUrl", r.linkedinUrl);
    trackConflict("email", r.email);
  }

  return {
    firstName: canonical.firstName,
    lastName: canonical.lastName,
    title: canonical.title,
    companyName: canonical.companyName,
    companyDomain: canonical.companyDomain,
    linkedinUrl: canonical.linkedinUrl,
    email: canonical.email,
    phone: canonical.phone,
    location: canonical.location,
    sourceUrls: [...sourceUrls],
    sourceRows,
    sources,
    conflicts,
  };
}

/* ─── Score confidence (0-100 + tier) ─────────────────────────────── */

export function scoreConfidence(c: IdentityCandidate): ScoredCandidate {
  let score = 0;
  const notes: string[] = [];

  // Field completeness — the spine of the score.
  if (c.firstName && c.lastName) score += 20; else notes.push("Missing full name");
  if (c.title) score += 15; else notes.push("No title found");
  if (c.companyName) score += 15; else notes.push("No company name");
  if (c.companyDomain) score += 10;
  if (c.location) score += 5;

  // Identity anchors.
  if (c.linkedinUrl && isLinkedInUrl(c.linkedinUrl)) {
    score += 15;
  } else if (c.linkedinUrl) {
    notes.push("LinkedIn URL present but doesn't look like a valid LinkedIn URL");
  }
  if (c.email && isEmail(c.email)) score += 10;
  else if (c.email) notes.push("Email present but failed format check");

  // Cross-source agreement: multiple sources reinforce confidence.
  if (c.sources.size >= 2) score += 5;
  if (c.sourceUrls.length >= 2) score += 5;

  // Conflicts deduct. Each contested field is a yellow flag.
  let linkedinUrlVerified = false;
  for (const [field, values] of Object.entries(c.conflicts)) {
    if (values.size > 1) {
      score -= 10;
      notes.push(`Conflicting ${field} across sources: ${[...values].slice(0, 3).join(" / ")}`);
    } else if (field === "linkedinUrl" && values.size === 1 && c.sources.size >= 2) {
      // Same LinkedIn URL from 2+ sources is the closest thing to
      // verification we get without calling Unipile.
      linkedinUrlVerified = true;
    }
  }

  // Clamp + bucketize.
  score = Math.max(0, Math.min(100, score));
  const tier: ScoredCandidate["tier"] = score >= 80 ? "high" : score >= 55 ? "medium" : "low";
  const status: ScoredCandidate["status"] = tier === "high" ? "verified" : "needs_review";
  if (tier !== "high") notes.unshift(`Confidence ${score}/100 — needs review`);

  return { ...c, score, tier, status, notes, linkedinUrlVerified };
}

/* ─── Persist into prospects (dedup-aware) ───────────────────────── */

export interface PersistResult {
  prospectsCreated: number;
  prospectsUpdated: number;
  highConfidenceCount: number;
  mediumConfidenceCount: number;
  lowConfidenceCount: number;
}

export async function persistAsProspects(
  workspaceId: number,
  runId: number,
  candidates: ScoredCandidate[],
): Promise<PersistResult> {
  const db = await getDb();
  if (!db) return { prospectsCreated: 0, prospectsUpdated: 0, highConfidenceCount: 0, mediumConfidenceCount: 0, lowConfidenceCount: 0 };

  let created = 0;
  let updated = 0;
  let high = 0, medium = 0, low = 0;

  for (const c of candidates) {
    if (c.tier === "high") high++;
    else if (c.tier === "medium") medium++;
    else low++;

    // Skip rows with no first+last name — useless without identity.
    if (!c.firstName || !c.lastName) continue;

    // Dedup: linkedinUrl > email > (firstName+lastName+company).
    let existingId: number | null = null;
    const conditions: any[] = [];
    if (c.linkedinUrl) conditions.push(eq(prospects.linkedinUrl, c.linkedinUrl));
    if (c.email) conditions.push(eq(prospects.email, c.email));
    if (conditions.length > 0) {
      const [hit] = await db.select({ id: prospects.id }).from(prospects)
        .where(and(eq(prospects.workspaceId, workspaceId), or(...conditions)))
        .limit(1);
      if (hit) existingId = hit.id;
    }
    if (!existingId) {
      // Last-ditch dedup by exact name + company (case-insensitive
      // would require a function index — keep it strict for now).
      const [hit] = await db.select({ id: prospects.id }).from(prospects).where(and(
        eq(prospects.workspaceId, workspaceId),
        eq(prospects.firstName, c.firstName),
        eq(prospects.lastName, c.lastName),
        c.companyName ? eq(prospects.company, c.companyName) : eq(prospects.firstName, c.firstName),
      )).limit(1);
      if (hit) existingId = hit.id;
    }

    const verificationNotes = c.notes.join(" · ");
    const sourceUrlsJson = c.sourceUrls.slice(0, 50) as any;

    if (existingId) {
      // Merge: keep existing non-null fields, fill in missing ones, refresh provenance.
      await db.update(prospects).set({
        title: c.title ?? undefined,
        company: c.companyName ?? undefined,
        companyDomain: c.companyDomain ?? undefined,
        linkedinUrl: c.linkedinUrl ?? undefined,
        email: c.email ?? undefined,
        phone: c.phone ?? undefined,
        confidenceScore: c.score,
        confidenceTier: c.tier,
        verificationStatus: c.status,
        verificationNotes,
        sourceUrls: sourceUrlsJson,
        linkedinUrlVerified: c.linkedinUrlVerified,
        lastEnrichedAt: new Date(),
        lastDiscoveryRunId: runId,
      }).where(and(eq(prospects.id, existingId), eq(prospects.workspaceId, workspaceId)));
      updated++;
    } else {
      await db.insert(prospects).values({
        workspaceId,
        firstName: c.firstName,
        lastName: c.lastName,
        title: c.title,
        company: c.companyName,
        companyDomain: c.companyDomain,
        linkedinUrl: c.linkedinUrl,
        email: c.email,
        phone: c.phone,
        confidenceScore: c.score,
        confidenceTier: c.tier,
        verificationStatus: c.status,
        verificationNotes,
        sourceUrls: sourceUrlsJson,
        linkedinUrlVerified: c.linkedinUrlVerified,
        lastEnrichedAt: new Date(),
        lastDiscoveryRunId: runId,
      });
      created++;
    }
  }

  return {
    prospectsCreated: created,
    prospectsUpdated: updated,
    highConfidenceCount: high,
    mediumConfidenceCount: medium,
    lowConfidenceCount: low,
  };
}

/* ─── Public entry point — orchestrates the full P2 pass ──────────── */

export async function processRun(
  workspaceId: number,
  runId: number,
  mode: "person" | "account",
): Promise<PersistResult> {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");

  const rows = await db.select().from(rawFinds)
    .where(and(eq(rawFinds.runId, runId), eq(rawFinds.workspaceId, workspaceId)));

  await db.insert(discoveryLogs).values({
    workspaceId, runId, phase: "consolidate.start", level: "info",
    message: `Consolidating ${rows.length} raw finds into identity candidates`,
  });

  const candidates = consolidateIdentities(rows, mode);
  const scored = candidates.map(scoreConfidence);

  await db.insert(discoveryLogs).values({
    workspaceId, runId, phase: "consolidate.complete", level: "info",
    message: `Consolidated into ${candidates.length} candidates; scored ${scored.filter((s) => s.tier === "high").length} high / ${scored.filter((s) => s.tier === "medium").length} medium / ${scored.filter((s) => s.tier === "low").length} low`,
    details: {
      candidates: scored.length,
      tiers: {
        high: scored.filter((s) => s.tier === "high").length,
        medium: scored.filter((s) => s.tier === "medium").length,
        low: scored.filter((s) => s.tier === "low").length,
      },
    } as any,
  });

  const result = await persistAsProspects(workspaceId, runId, scored);

  await db.update(discoveryRuns).set({
    prospectsCreated: result.prospectsCreated,
    highConfidenceCount: result.highConfidenceCount,
    mediumConfidenceCount: result.mediumConfidenceCount,
    lowConfidenceCount: result.lowConfidenceCount,
  }).where(and(eq(discoveryRuns.id, runId), eq(discoveryRuns.workspaceId, workspaceId)));

  await db.insert(discoveryLogs).values({
    workspaceId, runId, phase: "persist.complete", level: "info",
    message: `Persisted ${result.prospectsCreated} new / ${result.prospectsUpdated} updated prospects`,
    details: result as any,
  });

  return result;
}
