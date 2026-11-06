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
 *
 * Audit 2026-10-20, Phase 2:
 *   P3 — a run (or a re-score) rewrote every matched person's review
 *        status: archived people came back, ready to enrol, and verified
 *        ones were downgraded. Now an archived person is not touched at
 *        all, a status a human set is kept, a verified one is never
 *        downgraded, and what discovery sets is recorded as discovery's.
 *   P15 — account mode clustered every find by COMPANY, so it saved one
 *        person per company and no companies at all, and company-only finds
 *        (Google Business, news) were dropped for having no name. People are
 *        now clustered as people in both modes, and in account mode the
 *        company-only finds become accounts.
 */
import { and, eq } from "drizzle-orm";
import { canonicalText } from "@shared/canonicalText";
import { CONFIDENCE, mergeAll, type Candidate, type ProvenanceMap } from "../enrichment/fieldMerge";
import { normalizePersonNamePair } from "../enrichment/personName";
import { isConsumerDomain, normalizeCompanyDisplayName, normalizeCompanyName, normalizeDomain, normalizedAccountFields } from "../company/normalize";
import { COUNTRY_CODES, regionCountry } from "../prospectSources/bridge";
import { extractLinkedInIdentifier } from "../linkedinLookup";
import { describeSuppression, findSuppression } from "../suppression";
import { getDb } from "../../db";
import {
  accounts,
  discoveryLogs,
  discoveryRuns,
  prospects,
  rawFinds,
} from "../../../drizzle/schema";

/* ─── Normalization helpers ──────────────────────────────────────────── */
// One canonical form — @shared/canonicalText.
const norm = canonicalText;
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
  /** The place split into People's columns, and the industry a source gave
   *  (P65: collected, then dropped on save). Optional: older callers build
   *  candidates by hand. */
  city?: string | null;
  state?: string | null;
  country?: string | null;
  industry?: string | null;
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
  // People are clustered as people in BOTH modes (P15): clustering account
  // mode by company merged everyone at a company into one person. `mode`
  // only decides what happens to the finds with no person (persistCompanies).
  void mode;
  const clusters = new Map<string, RawFindRow[]>();
  for (const row of rows) {
    const nm = norm(`${row.firstName ?? ""} ${row.lastName ?? ""}`);
    const co = norm(row.companyName ?? "");
    if (!nm) continue; // need at least a name
    const key = co ? `${nm}|${co}` : nm;
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

  // A source that gave the place in parts (source search's vendors) keeps
  // them; a single string is split (P65).
  const json = (r: RawFindRow) => (r.rawJson && typeof r.rawJson === "object" ? r.rawJson as Record<string, unknown> : {});
  const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const cj = json(canonical);
  const structured = text(cj.city) || text(cj.stateProvince) || text(cj.country);
  const place = structured
    ? { city: text(cj.city), state: text(cj.stateProvince), country: text(cj.country) }
    : placeParts(canonical.location);
  const industry = text(cj.industry) ?? cluster.map((r) => text(json(r).industry)).find(Boolean) ?? null;

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
    ...place,
    industry,
    sourceUrls: [...sourceUrls],
    sourceRows,
    sources,
    conflicts,
  };
}

/**
 * "Austin, Texas, United States" → People's city / state / country (P65).
 * Only what can be placed: a known country or state name, or a two-letter
 * state after a city ("Austin, TX"). One unknown part is kept as the city
 * ("San Francisco Bay Area") rather than dropped.
 */
export function placeParts(location: string | null | undefined): { city: string | null; state: string | null; country: string | null } {
  const parts = String(location ?? "").split(",").map((p) => p.trim()).filter(Boolean);
  const isCountry = (s: string) => !!COUNTRY_CODES[s.toLowerCase()];
  const isRegion = (s: string) => regionCountry(s) !== null;
  if (parts.length === 0) return { city: null, state: null, country: null };
  if (parts.length === 1) {
    const p = parts[0];
    if (isCountry(p)) return { city: null, state: null, country: p };
    if (isRegion(p)) return { city: null, state: p, country: null };
    return { city: p, state: null, country: null };
  }
  if (parts.length === 2) {
    const [a, b] = parts;
    if (isCountry(b)) return isRegion(a) ? { city: null, state: a, country: b } : { city: a, state: null, country: b };
    return { city: a, state: b, country: null };
  }
  return { city: parts[0], state: parts[1], country: parts.slice(2).join(", ") };
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

  // Cross-source corroboration — strengthened so well-corroborated
  // candidates clear the 80 threshold instead of stalling at 75 in
  // needs_review.
  //
  //   1 source                → no bump
  //   2 sources               → +10  (was +5)
  //   3+ sources              → +15  (cumulative; new tier)
  //   2+ source URLs          → +5   (unchanged — distinct from sources
  //                                   because one source can yield
  //                                   multiple URLs)
  //   Same LinkedIn URL agreed by 2+ sources → +5 (new)
  //   Same email present from 2+ sources    → +3 (new)
  if (c.sources.size >= 3) {
    score += 15;
    notes.push(`Corroborated by ${c.sources.size} independent sources`);
  } else if (c.sources.size >= 2) {
    score += 10;
    notes.push("Corroborated by 2 independent sources");
  }
  if (c.sourceUrls.length >= 2) score += 5;

  // Field-level cross-source agreement — strongest signals get small
  // additional bumps. Conflicts handled separately below.
  const liUrlValues = c.conflicts["linkedinUrl"];
  if (liUrlValues && liUrlValues.size === 1 && c.sources.size >= 2) {
    score += 5;
    notes.push("LinkedIn URL agreed by multiple sources");
  }
  const emailValues = c.conflicts["email"];
  if (emailValues && emailValues.size === 1 && c.sources.size >= 2) {
    score += 3;
    notes.push("Email agreed by multiple sources");
  }

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

/**
 * The review status a run may write onto a person it matched (P3): never
 * over a human's verdict, never a downgrade of a verified person. Spread into
 * the update; an empty object leaves the status as it is.
 */
export function discoveryVerdict(
  existing: { verificationStatus?: string | null; verificationSetBy?: string | null } | undefined,
  next: "verified" | "needs_review",
): Record<string, unknown> {
  if (existing?.verificationSetBy === "human") return {};
  if (existing?.verificationStatus === "verified" && next !== "verified") return {};
  return { verificationStatus: next, verificationSetBy: "discovery", verificationSetAt: new Date() };
}

/** A find with no person on it — a company (Google Business, news, a directory). */
export const isCompanyOnlyFind = (r: { firstName?: string | null; lastName?: string | null; companyName?: string | null; companyDomain?: string | null }) =>
  !norm(`${r.firstName ?? ""} ${r.lastName ?? ""}`) && !!(norm(r.companyDomain ?? "") || norm(r.companyName ?? ""));

/**
 * Account mode: the companies found with no person become accounts (P15) —
 * matched by domain, then name, and created when new. Never fires
 * record_created (a bulk path; see workflowTriggers.test.ts).
 */
export async function persistCompanies(
  workspaceId: number,
  rows: RawFindRow[],
): Promise<{ accountsCreated: number; accountsMatched: number }> {
  const db = await getDb();
  if (!db) return { accountsCreated: 0, accountsMatched: 0 };
  const byCompany = new Map<string, RawFindRow>();
  for (const r of rows) {
    if (!isCompanyOnlyFind(r)) continue;
    const key = normalizeDomain(r.companyDomain) || normalizeCompanyName(r.companyName);
    if (!key || byCompany.has(key)) continue;
    byCompany.set(key, r);
  }
  let accountsCreated = 0, accountsMatched = 0;
  for (const r of Array.from(byCompany.values())) {
    const domain = normalizeDomain(r.companyDomain) || null;
    const name = normalizeCompanyDisplayName(r.companyName) ?? r.companyName ?? domain ?? "";
    const nameKey = normalizeCompanyName(name);
    let hit: { id: number } | undefined;
    if (domain) [hit] = await db.select({ id: accounts.id }).from(accounts).where(and(eq(accounts.workspaceId, workspaceId), eq(accounts.normalizedDomain, domain))).limit(1);
    if (!hit && nameKey) [hit] = await db.select({ id: accounts.id }).from(accounts).where(and(eq(accounts.workspaceId, workspaceId), eq(accounts.normalizedName, nameKey))).limit(1);
    if (hit) { accountsMatched++; continue; }
    await db.insert(accounts).values({
      workspaceId, name: name.slice(0, 200), domain: domain ?? undefined, ...normalizedAccountFields(name, domain),
    } as never);
    accountsCreated++;
  }
  return { accountsCreated, accountsMatched };
}

/* ─── Persist into prospects (dedup-aware) ───────────────────────── */

export interface PersistResult {
  prospectsCreated: number;
  prospectsUpdated: number;
  /** Matched people left alone because someone archived them (P3). */
  prospectsSkippedArchived?: number;
  /** Not saved: no first and last name to tell who they are. */
  prospectsSkippedNoName?: number;
  /** Not saved: on the suppression or do-not-contact list (P74). */
  prospectsSkippedSuppressed?: number;
  /** Not saved: the same name and company as someone already in People, with
   *  no address or LinkedIn profile to prove it is them (P64). */
  prospectsSkippedNameOnly?: number;
  /** Account mode: companies found with no person, saved as accounts (P15). */
  accountsCreated?: number;
  accountsMatched?: number;
  /** Tiers of the people SAVED, created or updated (P61: candidates that were
   *  skipped used to be counted too). */
  highConfidenceCount: number;
  mediumConfidenceCount: number;
  lowConfidenceCount: number;
  /** Which raw finds became which person: source-search promote stamps its
   *  rows from this rather than matching names back (P71). */
  saved?: Array<{ prospectId: number; sourceRows: number[] }>;
}

/** Every person not saved, for the run record. */
export function skippedCount(r: PersistResult): number {
  return (r.prospectsSkippedArchived ?? 0) + (r.prospectsSkippedNoName ?? 0)
    + (r.prospectsSkippedSuppressed ?? 0) + (r.prospectsSkippedNameOnly ?? 0);
}

/**
 * Identity keys for matching a find to someone already in People (P64): an
 * address, or a LinkedIn profile by its canonical slug, so case and URL shape
 * ("https://www.linkedin.com/in/Jane/", "linkedin.com/in/jane") agree. A name
 * is not an identity: it can only hold a find back, never update a person.
 */
export function strongIdentityKeys(p: { email?: string | null; linkedinUrl?: string | null }): string[] {
  const out: string[] = [];
  const email = String(p.email ?? "").trim().toLowerCase();
  if (email) out.push(`e:${email}`);
  const slug = p.linkedinUrl ? extractLinkedInIdentifier(String(p.linkedinUrl).trim().toLowerCase()) : null;
  if (slug) out.push(`li:${slug}`);
  return out;
}

/** Canonical name at the company's domain and at its name. */
export function nameOrgKeys(p: { firstName?: string | null; lastName?: string | null; company?: string | null; companyDomain?: string | null }): string[] {
  const name = `${norm(p.firstName ?? "")} ${norm(p.lastName ?? "")}`.trim();
  if (!name) return [];
  const out: string[] = [];
  const domain = normalizeDomain(p.companyDomain);
  if (domain) out.push(`n:${name}@${domain}`);
  const company = normalizeCompanyName(p.company);
  if (company) out.push(`n:${name}@${company}`);
  return out;
}

/** The workspace's People by identity key; the lowest id wins a collision. */
async function peopleIndex(db: NonNullable<Awaited<ReturnType<typeof getDb>>>, workspaceId: number) {
  const rows = await db.select({
    id: prospects.id, email: prospects.email, linkedinUrl: prospects.linkedinUrl, firstName: prospects.firstName,
    lastName: prospects.lastName, company: prospects.company, companyDomain: prospects.companyDomain,
  }).from(prospects).where(eq(prospects.workspaceId, workspaceId)).orderBy(prospects.id);
  const strong = new Map<string, number>();
  const named = new Map<string, number>();
  const add = (id: number, p: Parameters<typeof nameOrgKeys>[0] & { email?: string | null; linkedinUrl?: string | null }) => {
    for (const k of strongIdentityKeys(p)) if (!strong.has(k)) strong.set(k, id);
    for (const k of nameOrgKeys(p)) if (!named.has(k)) named.set(k, id);
  };
  for (const r of rows) add(r.id, r);
  return { strong, named, add };
}

const emailDomainOf = (email: string | null | undefined) => {
  const at = (email ?? "").lastIndexOf("@");
  return at > 0 ? (email ?? "").slice(at + 1).trim().toLowerCase() : "";
};

export async function persistAsProspects(
  workspaceId: number,
  runId: number,
  candidates: ScoredCandidate[],
): Promise<PersistResult> {
  const db = await getDb();
  if (!db) return { prospectsCreated: 0, prospectsUpdated: 0, highConfidenceCount: 0, mediumConfidenceCount: 0, lowConfidenceCount: 0 };

  let created = 0;
  let updated = 0;
  let skippedArchived = 0, skippedNoName = 0, skippedSuppressed = 0, skippedNameOnly = 0;
  let high = 0, medium = 0, low = 0;
  const saved: Array<{ prospectId: number; sourceRows: number[] }> = [];
  const tally = (c: ScoredCandidate) => {
    if (c.tier === "high") high++;
    else if (c.tier === "medium") medium++;
    else low++;
  };
  const index = await peopleIndex(db, workspaceId);

  for (const c of candidates) {
    // Skip rows with no first+last name — useless without identity.
    if (!c.firstName || !c.lastName) { skippedNoName++; continue; }

    // Nobody who said no is brought in (P74): an unsubscribe, a complaint or
    // the do-not-contact list (address, LinkedIn profile or company domain)
    // keeps the person out on every channel, and an existing person is not
    // touched either. A bounce only says the address is dead, so the address
    // stays out and the person comes in.
    const target = { email: c.email, linkedinUrl: c.linkedinUrl, companyDomain: c.companyDomain };
    if (await findSuppression(workspaceId, target, "any")) { skippedSuppressed++; continue; }
    const extraNotes: string[] = [];
    let email = c.email?.trim() || null;
    let companyDomain = c.companyDomain?.trim() || null;
    if (email) {
      const bounced = await findSuppression(workspaceId, { email }, "email");
      if (bounced) { extraNotes.push(`Address left out: ${describeSuppression(bounced)}`); email = null; }
    }
    // A free-mail address is a person's own, not a work address, and is not
    // imported as one; gmail.com is never a company's domain.
    if (email && isConsumerDomain(emailDomainOf(email))) { extraNotes.push(`Personal address (${emailDomainOf(email)}) left out`); email = null; }
    if (companyDomain && isConsumerDomain(companyDomain)) companyDomain = null;

    // Match on an address or a LinkedIn profile only (P64). The same name at
    // the same company with neither is held back rather than written onto
    // someone who may be a stranger, or created as a second copy.
    let existingId: number | null = null;
    for (const k of strongIdentityKeys({ email, linkedinUrl: c.linkedinUrl })) {
      const id = index.strong.get(k);
      if (id != null) { existingId = id; break; }
    }
    if (existingId == null && nameOrgKeys({ ...c, company: c.companyName, companyDomain }).some((k) => index.named.has(k))) {
      skippedNameOnly++;
      continue;
    }

    const verificationNotes = c.notes.concat(extraNotes).join(" · ");
    const sourceUrlsJson = c.sourceUrls.slice(0, 50) as any;

    // Person fields flow through the SAME merge every enrichment source
    // uses (roadmap P1.1): discovery is an opportunistic find, so its
    // candidates enter at the scrape tier and can never displace stronger
    // provenance — the old direct .set() here could silently overwrite a
    // Reoon-verified email with a web-scraped one.
    const at = new Date().toISOString();
    const discoveryCandidates: Candidate[] = [];
    const addCand = (field: Candidate["field"], value: string | null | undefined) => {
      if (value?.trim()) discoveryCandidates.push({ field, value: value.trim(), source: "discovery", confidence: CONFIDENCE.scrapeFound, at });
    };
    addCand("title", c.title);
    addCand("company", c.companyName);
    addCand("companyDomain", companyDomain);
    addCand("linkedinUrl", c.linkedinUrl);
    addCand("email", email);
    addCand("phone", c.phone);
    // The place, through the same ledger (P65).
    addCand("city", c.city);
    addCand("state", c.state);
    addCand("country", c.country);
    // Industry has no ledger slot: it fills a blank and never replaces one.
    const industry = c.industry?.trim().slice(0, 80) || null;

    if (existingId) {
      const [existing] = await db.select().from(prospects)
        .where(and(eq(prospects.id, existingId), eq(prospects.workspaceId, workspaceId)))
        .limit(1);
      // An archived person stays archived and untouched (P3).
      if (existing?.verificationStatus === "rejected") { skippedArchived++; continue; }
      const merged = mergeAll(
        {
          email: existing?.email, phone: existing?.phone, company: existing?.company,
          companyDomain: existing?.companyDomain, title: existing?.title, linkedinUrl: existing?.linkedinUrl,
          city: existing?.city, state: existing?.state, country: existing?.country,
        },
        (existing?.fieldProvenance ?? {}) as ProvenanceMap,
        discoveryCandidates,
      );
      const WIDTHS: Record<string, number> = { title: 120, email: 320, city: 80, state: 80, country: 80 };
      const personPatch: Record<string, unknown> = {};
      for (const [field, value] of Object.entries(merged.fields)) {
        personPatch[field] = value.slice(0, WIDTHS[field] ?? 200);
      }
      if (industry && !existing?.industry) personPatch.industry = industry;
      await db.update(prospects).set({
        ...personPatch,
        fieldProvenance: merged.ledger,
        confidenceScore: c.score,
        confidenceTier: c.tier,
        ...discoveryVerdict(existing, c.status),
        verificationNotes,
        sourceUrls: sourceUrlsJson,
        linkedinUrlVerified: c.linkedinUrlVerified,
        lastEnrichedAt: new Date(),
        lastDiscoveryRunId: runId,
      } as never).where(and(eq(prospects.id, existingId), eq(prospects.workspaceId, workspaceId)));
      {
        const { recordFieldHistory } = await import("../enrichment/fieldHistory");
        void recordFieldHistory(workspaceId, existingId, merged.decisions, "discovery");
      }
      updated++;
      tally(c);
      saved.push({ prospectId: existingId, sourceRows: c.sourceRows });
    } else {
      // Fresh insert keeps its shape and now carries a ledger from birth.
      // People "Name" rule (owner 2026-08-25): first + last only,
      // capitalization normalized, at the birth seam.
      const namePair = normalizePersonNamePair(c.firstName, c.lastName);
      const merged = mergeAll({}, {}, discoveryCandidates);
      const [ins] = await db.insert(prospects).values({
        workspaceId,
        firstName: namePair.firstName ?? c.firstName,
        lastName: namePair.lastName ?? c.lastName,
        title: merged.fields.title?.slice(0, 120) ?? c.title,
        // Company display rule (owner 2026-08-25): capitalization normalized at birth.
        company: (normalizeCompanyDisplayName(merged.fields.company ?? c.companyName) ?? c.companyName)?.slice(0, 200),
        companyDomain: merged.fields.companyDomain?.slice(0, 200) ?? companyDomain,
        linkedinUrl: merged.fields.linkedinUrl ?? c.linkedinUrl,
        email: merged.fields.email?.slice(0, 320) ?? email,
        phone: merged.fields.phone?.slice(0, 40) ?? c.phone,
        city: merged.fields.city?.slice(0, 80) ?? null,
        state: merged.fields.state?.slice(0, 80) ?? null,
        country: merged.fields.country?.slice(0, 80) ?? null,
        industry,
        fieldProvenance: merged.ledger,
        confidenceScore: c.score,
        confidenceTier: c.tier,
        verificationStatus: c.status,
        verificationSetBy: "discovery",
        verificationSetAt: new Date(),
        verificationNotes,
        sourceUrls: sourceUrlsJson,
        linkedinUrlVerified: c.linkedinUrlVerified,
        lastEnrichedAt: new Date(),
        lastDiscoveryRunId: runId,
      } as never).$returningId();
      created++;
      tally(c);
      // Two finds in one pass for the same person meet the row just made.
      index.add(ins.id, { email, linkedinUrl: c.linkedinUrl, firstName: c.firstName, lastName: c.lastName, company: c.companyName, companyDomain });
      saved.push({ prospectId: ins.id, sourceRows: c.sourceRows });
    }
  }

  return {
    prospectsCreated: created,
    prospectsUpdated: updated,
    prospectsSkippedArchived: skippedArchived,
    prospectsSkippedNoName: skippedNoName,
    prospectsSkippedSuppressed: skippedSuppressed,
    prospectsSkippedNameOnly: skippedNameOnly,
    highConfidenceCount: high,
    mediumConfidenceCount: medium,
    lowConfidenceCount: low,
    saved,
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

  const result: PersistResult = await persistAsProspects(workspaceId, runId, scored);
  if (mode === "account") Object.assign(result, await persistCompanies(workspaceId, rows));

  // What was saved, and only that (P61): the run record and the toast count
  // the same people the log does.
  await db.update(discoveryRuns).set({
    prospectsCreated: result.prospectsCreated,
    prospectsUpdated: result.prospectsUpdated,
    prospectsSkipped: skippedCount(result),
    accountsCreated: result.accountsCreated ?? 0,
    highConfidenceCount: result.highConfidenceCount,
    mediumConfidenceCount: result.mediumConfidenceCount,
    lowConfidenceCount: result.lowConfidenceCount,
  } as never).where(and(eq(discoveryRuns.id, runId), eq(discoveryRuns.workspaceId, workspaceId)));

  const left = [
    result.prospectsSkippedArchived ? `${result.prospectsSkippedArchived} archived left alone` : "",
    result.prospectsSkippedSuppressed ? `${result.prospectsSkippedSuppressed} on a suppression list` : "",
    result.prospectsSkippedNameOnly ? `${result.prospectsSkippedNameOnly} matching someone in People by name only` : "",
    result.prospectsSkippedNoName ? `${result.prospectsSkippedNoName} with no full name` : "",
  ].filter(Boolean);
  const { saved: _saved, ...details } = result;
  await db.insert(discoveryLogs).values({
    workspaceId, runId, phase: "persist.complete", level: "info",
    message: `Persisted ${result.prospectsCreated} new / ${result.prospectsUpdated} updated prospects`
      + (left.length ? ` (not saved: ${left.join(", ")})` : "")
      + (mode === "account" ? `; ${result.accountsCreated ?? 0} new / ${result.accountsMatched ?? 0} existing companies` : ""),
    details: details as any,
  });

  return result;
}
