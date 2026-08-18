/**
 * Brand identity reconciler — the company-enrichment stack's core.
 *
 * observations → score → reconcile → canonical, never newest-wins:
 *
 *  - Every provider sighting becomes a `brand_observations` row (only facts
 *    WE derive: names, domains, a constructed CDN URL, hashes — never
 *    provider bytes or their 24h-expiring icon URLs, per Brandfetch terms).
 *  - Scoring is domain-match-first (fieldMerge's 0–100 CONFIDENCE
 *    vocabulary): a hit whose domain equals the account's scores ≥95; a
 *    name-only hit is CAPPED below 95 so it can never auto-accept; fuzzy
 *    name matches land in the candidate band; a domain CONFLICT (account has
 *    a different domain) is capped into the candidate band too — that shape
 *    is a rebrand signal for a human, not an auto-write.
 *  - Decision thresholds (owner spec): ≥95 auto-applies, 80–94 applies only
 *    what the account's own data corroborates (a contact mailbox or website
 *    on the same domain), 60–79 is stored as a candidate with no field
 *    effect, <60 changes nothing.
 *  - Manual overrides are supreme: fields named in `brand_override` are
 *    never written, whatever the score.
 *  - Auto-apply is deliberately narrow: fill an EMPTY domain, record the
 *    legal name (a new fact), and fix the display spelling ONLY when the
 *    normalized identity is unchanged. A genuinely different name at
 *    domain-exact confidence is surfaced as an event, never auto-renamed.
 *  - Change detection hashes the normalized identity (name|domain — not
 *    URLs, which rotate): a provider whose latest sighting differs from its
 *    previous one emits a `changed` enrichment-history event.
 *
 * The orchestrator is the ONLY automated caller of Brand Search. Prospect
 * enrichment never touches it (owner decision, structurally tested in
 * brandfetch.test.ts) — this stack owns company-level reconciliation.
 *
 * INDEPENDENCE (2026-08-18). A domain the PROVIDER supplied — adopted from a
 * name search by domainAdopt, or written by this reconciler — is not evidence
 * the provider can then be checked against. Before this rule the loop was:
 * name-only hit stored as candidate → adopt fills the empty domain at 60 →
 * next pass, same hit, `accDomain === hitDomain` → domain_exact ≥95 →
 * VERIFIED. And adopt also set websiteUrl to that domain, so "corroborated by
 * the account's own records" was the same guess read back. Both loops
 * stamped brand_verified_at on Brandfetch's wrong same-name hits ("Triumph
 * Academy" → an Australian school; "Golden Bridge" → Vietnam; "Arena Hall" →
 * Belarus). `providerIndependentEvidence` strips provider-sourced values
 * before scoring and corroboration; the truth then has to come from an
 * import, LinkedIn, association, a human pin, or a person's mailbox.
 */
import { createHash } from "node:crypto";
import { and, desc, eq, gt, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { getDb } from "../../db";
import { accounts, brandObservations, contacts, organizationEnrichmentEvents, prospects } from "../../../drizzle/schema";
import { businessDomainFromEmail, nameSimilarity, normalizeCompanyName, normalizeDomain } from "./normalize";
import { canonicalizeCompanyDisplayName } from "../enrichment/recordNormalize";
import type { BrandSearchHit, BrandSearchOutcome } from "../brand/brandfetch";

/* ─── vocabulary ─────────────────────────────────────────────────────────── */

export const BRAND_PROVIDER = "brandfetch" as const;

/** Decision thresholds on the 0–100 CONFIDENCE scale (owner spec). */
export const BRAND_THRESHOLDS = {
  auto: 95,
  corroborated: 80,
  candidate: 60,
} as const;

/** A no-result sighting is retried after this long (negative cache). */
export const NEGATIVE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** A successful reconcile is refreshed after this long. */
export const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export type MatchBasis = "domain_exact" | "name_exact" | "name_fuzzy" | "none";

export interface ScoredHit {
  hit: BrandSearchHit;
  confidence: number; // 0–100
  basis: MatchBasis;
}

export interface BrandOverride {
  name?: string;
  domain?: string;
  byUserId: number;
  at: string;
  reason?: string;
}

/* ─── pure: identity hashing ─────────────────────────────────────────────── */

/** Hash of the NORMALIZED identity — stable across URL/query rotation. */
export function brandContentHash(name: string | null | undefined, domain: string | null | undefined): string {
  const n = normalizeCompanyName(name ?? "");
  const d = normalizeDomain(domain ?? "");
  return createHash("sha256").update(`${n}|${d}`).digest("hex").slice(0, 40);
}

/* ─── pure: scoring ──────────────────────────────────────────────────────── */

/**
 * Score one Brand Search hit against the account it was queried for.
 * Domain-match-first; name-only hits are capped below the auto threshold.
 */
export function scoreBrandHit(
  account: { name: string; domain: string | null | undefined },
  hit: BrandSearchHit,
): { confidence: number; basis: MatchBasis } {
  const accDomain = normalizeDomain(account.domain);
  const hitDomain = normalizeDomain(hit.domain);
  const accName = normalizeCompanyName(account.name);
  const hitName = normalizeCompanyName(hit.name ?? "");
  const namesEqual = !!accName && accName === hitName;
  const sim = nameSimilarity(account.name, hit.name ?? "");

  if (accDomain && hitDomain && accDomain === hitDomain) {
    // The strongest possible evidence: the brand lives at the account's domain.
    let c = 95;
    if (hit.claimed) c += 2;
    if (namesEqual) c += 2;
    return { confidence: Math.min(99, c), basis: "domain_exact" };
  }

  if (accDomain && hitDomain && accDomain !== hitDomain) {
    // Conflict: same name, different domain — a rebrand/relocation signal.
    // Candidate band at best; a human (or a corroborated future pass) decides.
    if (!namesEqual && sim < 0.5) return { confidence: 0, basis: "none" };
    return { confidence: Math.min(BRAND_THRESHOLDS.candidate + (namesEqual ? 15 : 5), 79), basis: namesEqual ? "name_exact" : "name_fuzzy" };
  }

  // Account has no domain: name evidence only — NEVER reaches auto.
  if (namesEqual) {
    let c = 88;
    if (hit.claimed) c += 4;
    return { confidence: Math.min(94, c), basis: "name_exact" };
  }
  if (sim >= 0.5) {
    return { confidence: Math.min(79, 60 + Math.round(sim * 20)), basis: "name_fuzzy" };
  }
  return { confidence: 0, basis: "none" };
}

/** Pick the best-scoring hit; ties prefer claimed brands. */
export function pickBestHit(
  account: { name: string; domain: string | null | undefined },
  hits: BrandSearchHit[],
): ScoredHit | null {
  let best: ScoredHit | null = null;
  for (const hit of hits) {
    const s = scoreBrandHit(account, hit);
    if (!best || s.confidence > best.confidence || (s.confidence === best.confidence && hit.claimed && !best.hit.claimed)) {
      best = { hit, confidence: s.confidence, basis: s.basis };
    }
  }
  return best && best.confidence > 0 ? best : null;
}

/* ─── pure: legal-vs-display split ───────────────────────────────────────── */

const LEGAL_SUFFIX_RE = /\b(inc|incorporated|llc|l\.l\.c|ltd|limited|corp|corporation|co|company|plc|gmbh|srl|sas|pty|llp|pllc|ag|bv|sa)\.?$/i;

/** The provider's name qualifies as a LEGAL name only when it carries a
 *  legal suffix — otherwise it's just another display spelling. */
export function deriveLegalName(providerName: string | null | undefined): string | null {
  const display = canonicalizeCompanyDisplayName(providerName);
  if (!display) return null;
  return LEGAL_SUFFIX_RE.test(display.replace(/,/g, "")) ? display : null;
}

/* ─── pure: the reconcile decision ───────────────────────────────────────── */

export interface ReconcileAccountState {
  name: string;
  domain: string | null;
  legalName: string | null;
  brandOverride: BrandOverride | null;
}

/** Ledger sources that mean "the brand provider said so" — never evidence
 *  the provider may be checked against. */
export const PROVIDER_SOURCES: ReadonlySet<string> = new Set(["brand_search", BRAND_PROVIDER]);

/**
 * The account's domain and website as evidence INDEPENDENT of the provider.
 * A domain whose ledger source is the provider (adopted from a name search,
 * or written by a reconcile) is returned as null: the provider must earn it
 * again from something else. A websiteUrl that merely mirrors that dependent
 * domain is dropped too — domainAdopt sets `https://<domain>` when the field
 * was empty, so it is the same guess wearing a different hat.
 */
export function providerIndependentEvidence(acc: {
  domain: string | null | undefined;
  websiteUrl: string | null | undefined;
  fieldProvenance: unknown;
}): { domain: string | null; websiteUrl: string | null; domainDependent: boolean } {
  const ledger = (acc.fieldProvenance ?? {}) as { domain?: { source?: string } };
  const src = ledger.domain?.source;
  const domainDependent = !!normalizeDomain(acc.domain) && !!src && PROVIDER_SOURCES.has(src);
  if (!domainDependent) return { domain: acc.domain ?? null, websiteUrl: acc.websiteUrl ?? null, domainDependent: false };
  const mirrors = !!acc.websiteUrl && normalizeDomain(acc.websiteUrl) === normalizeDomain(acc.domain);
  return { domain: null, websiteUrl: mirrors ? null : (acc.websiteUrl ?? null), domainDependent: true };
}

export interface ReconcileDecision {
  action: "applied" | "corroborated" | "candidate" | "no_match";
  /** Field writes for the accounts row (empty when nothing qualifies). */
  changes: Partial<{ name: string; domain: string; legalName: string }>;
  /** True when brand_confidence/brand_verified_at should be stamped. */
  verified: boolean;
  brandConfidence: number;
  /** Human-facing notes for the enrichment-history event. */
  notes: string[];
}

/**
 * Decide what a scored observation may write. `corroboratorDomains` is the
 * account's OWN evidence (website domain + contact mailbox domains) — what
 * lets an 80–94 name-match fill an empty domain.
 */
export function decideBrandReconcile(
  account: ReconcileAccountState,
  scored: ScoredHit | null,
  corroboratorDomains: string[],
): ReconcileDecision {
  if (!scored || scored.confidence < BRAND_THRESHOLDS.candidate) {
    return { action: "no_match", changes: {}, verified: false, brandConfidence: scored?.confidence ?? 0, notes: [] };
  }

  const override = account.brandOverride;
  const overridden = new Set(Object.keys(override ?? {}).filter((k) => k === "name" || k === "domain"));
  const changes: ReconcileDecision["changes"] = {};
  const notes: string[] = [];

  const hitDomain = normalizeDomain(scored.hit.domain);
  const hitDisplay = canonicalizeCompanyDisplayName(scored.hit.name);
  const legal = deriveLegalName(scored.hit.name);
  const sameIdentity = !!hitDisplay && normalizeCompanyName(account.name) === normalizeCompanyName(hitDisplay);

  const applyIdentityFacts = () => {
    // Legal name: a NEW fact, never a rename — only set when absent or when
    // the provider's legal form differs from what we hold.
    if (legal && legal !== account.legalName) changes.legalName = legal;
    // Display spelling: fix ONLY when the normalized identity is unchanged.
    if (!overridden.has("name") && sameIdentity && hitDisplay && hitDisplay !== account.name) {
      changes.name = hitDisplay;
      notes.push(`display spelling "${account.name}" → "${hitDisplay}"`);
    }
    if (hitDisplay && !sameIdentity) {
      notes.push(`provider name "${hitDisplay}" differs from "${account.name}" — not auto-renamed`);
    }
  };

  if (scored.confidence >= BRAND_THRESHOLDS.auto) {
    // domain_exact is the only basis that reaches here (name-only is capped),
    // so the domain itself needs no write — it already matches.
    applyIdentityFacts();
    return { action: "applied", changes, verified: true, brandConfidence: scored.confidence, notes };
  }

  if (scored.confidence >= BRAND_THRESHOLDS.corroborated) {
    // Name-matched but not domain-verified: the account's own data must
    // corroborate the hit's domain before we write anything.
    const corroborated = !!hitDomain && corroboratorDomains.includes(hitDomain);
    if (corroborated) {
      if (!overridden.has("domain") && !normalizeDomain(account.domain) && hitDomain) {
        changes.domain = hitDomain;
        notes.push(`domain ${hitDomain} corroborated by the account's own records`);
      }
      applyIdentityFacts();
      return { action: "corroborated", changes, verified: true, brandConfidence: scored.confidence, notes };
    }
    notes.push(`uncorroborated ${scored.basis} hit${hitDomain ? ` (${hitDomain})` : ""} — stored as candidate`);
    return { action: "candidate", changes: {}, verified: false, brandConfidence: scored.confidence, notes };
  }

  return { action: "candidate", changes: {}, verified: false, brandConfidence: scored.confidence, notes };
}

/* ─── pure: refresh predicate (the cron's scan rule) ─────────────────────── */

/**
 * Does this account need a (re-)reconcile now? True when never verified and
 * outside the negative-cache window, when the last verify has gone stale, or
 * when the account's identity changed since it was last queried.
 */
export function needsBrandRefresh(
  account: { name: string; domain: string | null; brandVerifiedAt: Date | null },
  latestObservation: { observedAt: Date; queryHash: string | null } | null,
  now: Date,
): boolean {
  const identityHash = brandContentHash(account.name, account.domain);
  if (latestObservation && latestObservation.queryHash && latestObservation.queryHash !== identityHash) return true;
  if (account.brandVerifiedAt) return now.getTime() - account.brandVerifiedAt.getTime() > REFRESH_TTL_MS;
  if (!latestObservation) return true;
  return now.getTime() - latestObservation.observedAt.getTime() > NEGATIVE_TTL_MS;
}

/* ─── orchestrator ───────────────────────────────────────────────────────── */

export interface ReconcileResult {
  accountId: number;
  action: ReconcileDecision["action"] | "skipped_no_search" | "skipped_override_all" | "search_failed";
  confidence: number;
  basis: MatchBasis | null;
  changes: string[];
  notes: string[];
}

type ProviderLike = {
  searchReady(): boolean;
  searchBrand(q: string): Promise<BrandSearchOutcome>;
  logoUrl(domain: string | null | undefined, opts?: { type?: "icon" | "symbol" | "logo" }): string | null;
};

async function loadProvider(): Promise<ProviderLike> {
  const { createBrandfetchProvider } = await import("../brand/brandfetch");
  return createBrandfetchProvider();
}

/**
 * The account's own domain evidence: website + the mailbox domains of the
 * people attached to it. People (prospects.accountId) AND Contacts
 * (contacts.accountId) — People are the sitewide record (owner directive
 * 2026-08-17) and LSI's contacts table is empty by instruction, so a
 * contacts-only read had gone blind there. Mailboxes CORROBORATE a provider
 * hit; they never name a domain on their own (see associationService).
 */
export async function corroboratorDomainsFor(workspaceId: number, accountId: number, websiteUrl: string | null): Promise<string[]> {
  const out = new Set<string>();
  const w = normalizeDomain(websiteUrl);
  if (w) out.add(w);
  const db = await getDb();
  if (db) {
    const people = await db
      .select({ email: prospects.email })
      .from(prospects)
      .where(and(eq(prospects.workspaceId, workspaceId), eq(prospects.accountId, accountId)))
      .limit(200);
    const contactRows = await db
      .select({ email: contacts.email })
      .from(contacts)
      .where(and(eq(contacts.workspaceId, workspaceId), eq(contacts.accountId, accountId)))
      .limit(200);
    for (const r of [...people, ...contactRows]) {
      const d = businessDomainFromEmail(r.email);
      if (d) out.add(d);
    }
  }
  return Array.from(out);
}

/**
 * Reconcile ONE account now. Queries Brand Search (when configured), stores
 * the observation, applies the decision, and writes the enrichment-history
 * event — including a `changed` event when the provider's story about this
 * brand differs from its previous sighting.
 */
export async function reconcileAccountBrand(
  workspaceId: number,
  accountId: number,
  opts: { provider?: ProviderLike; byUserId?: number } = {},
): Promise<ReconcileResult> {
  const db = await getDb();
  if (!db) return { accountId, action: "no_match", confidence: 0, basis: null, changes: [], notes: ["database unavailable"] };

  const [acc] = await db
    .select({
      id: accounts.id, name: accounts.name, domain: accounts.domain, legalName: accounts.legalName,
      brandOverride: accounts.brandOverride, websiteUrl: accounts.websiteUrl,
      fieldProvenance: accounts.fieldProvenance,
    })
    .from(accounts)
    .where(and(eq(accounts.workspaceId, workspaceId), eq(accounts.id, accountId)))
    .limit(1);
  if (!acc) return { accountId, action: "no_match", confidence: 0, basis: null, changes: [], notes: ["account not found"] };

  const override = (acc.brandOverride ?? null) as BrandOverride | null;
  if (override?.name && override?.domain) {
    // Both identity fields pinned by a human — nothing for the reconciler.
    return { accountId, action: "skipped_override_all", confidence: 0, basis: null, changes: [], notes: [] };
  }

  const provider = opts.provider ?? (await loadProvider());
  if (!provider.searchReady()) {
    return { accountId, action: "skipped_no_search", confidence: 0, basis: null, changes: [], notes: ["BRANDFETCH_SEARCH_CLIENT_ID not set"] };
  }

  const outcome = await provider.searchBrand(acc.name);
  if (!outcome.ok) {
    // We learned NOTHING about this brand. Recording an observation here would
    // negative-cache the account for a week on the strength of an expired key
    // or a 429 — so record nothing, stamp nothing, and let the caller see it.
    return {
      accountId, action: "search_failed", confidence: 0, basis: null, changes: [],
      notes: [`brand search failed: ${outcome.reason}${outcome.status ? ` (HTTP ${outcome.status})` : ""}`],
    };
  }
  const hits = outcome.hits;
  // Score and corroborate against what we know INDEPENDENTLY of the provider
  // (see header, INDEPENDENCE). A provider-sourced domain scores as no
  // domain: the hit must be corroborated by an import/LinkedIn/association
  // domain or a person's mailbox before it verifies — and a corroborated
  // hit at a different domain may REPLACE the provider's earlier guess.
  const indep = providerIndependentEvidence(acc);
  const scored = pickBestHit({ name: acc.name, domain: indep.domain }, hits);
  const corroborators = await corroboratorDomainsFor(workspaceId, accountId, indep.websiteUrl);
  const decision = decideBrandReconcile(
    { name: acc.name, domain: indep.domain, legalName: acc.legalName, brandOverride: override },
    scored,
    corroborators,
  );
  if (indep.domainDependent) decision.notes.push(`account domain ${acc.domain} is provider-sourced — not counted as evidence`);

  // Change detection BEFORE inserting the new sighting: compare against the
  // provider's previous story about this account.
  const [prev] = await db
    .select({ contentHash: brandObservations.contentHash, rawName: brandObservations.rawName, rawDomain: brandObservations.rawDomain })
    .from(brandObservations)
    .where(and(eq(brandObservations.accountId, accountId), eq(brandObservations.provider, BRAND_PROVIDER)))
    .orderBy(desc(brandObservations.observedAt))
    .limit(1);

  const hitName = scored?.hit.name ?? null;
  const hitDomain = scored ? normalizeDomain(scored.hit.domain) || null : null;
  const contentHash = scored ? brandContentHash(hitName, hitDomain) : null;
  const identityChanged = !!prev && !!prev.contentHash && !!contentHash && prev.contentHash !== contentHash;

  await db.insert(brandObservations).values({
    workspaceId, accountId,
    provider: BRAND_PROVIDER,
    rawName: hitName ? hitName.slice(0, 240) : null,
    normalizedName: hitName ? normalizeCompanyName(hitName).slice(0, 200) : null,
    rawDomain: scored?.hit.domain ? scored.hit.domain.slice(0, 200) : null,
    normalizedDomain: hitDomain,
    logoRef: hitDomain ? provider.logoUrl(hitDomain, { type: "icon" }) : null,
    claimed: scored?.hit.claimed ?? false,
    matchConfidence: scored?.confidence ?? 0,
    matchBasis: scored?.basis ?? "none",
    contentHash,
    queryHash: brandContentHash(acc.name, acc.domain),
    evidence: {
      hitCount: hits.length,
      corroborators,
      brandId: scored?.hit.brandId ?? null,
      notes: decision.notes,
    },
  } as typeof brandObservations.$inferInsert);

  // Apply the decision THROUGH the account provenance ledger (roadmap
  // P2.1): the reconciler's bands decide what to attempt; the ledger's
  // never-downgrade rule decides whether stronger provenance (a user pin
  // at 100, a corroborated prior entry) blocks the write. Same 0151
  // semantics — legacy values get the `preexisting` baseline.
  const changedFields: string[] = [];
  if (Object.keys(decision.changes).length > 0 || decision.verified) {
    const { mergeAccountField } = await import("./accountProvenance");
    const nowIso = new Date().toISOString();
    const ledger = { ...((acc.fieldProvenance ?? {}) as Record<string, unknown>) } as import("./accountProvenance").AccountProvenanceMap;
    let ledgerChanged = false;
    const set: Record<string, unknown> = {};
    for (const field of ["name", "domain", "legalName"] as const) {
      const proposed = decision.changes[field];
      if (!proposed) continue;
      const d = mergeAccountField(field, { value: acc[field], provenance: ledger[field] }, {
        value: proposed, source: BRAND_PROVIDER, confidence: decision.brandConfidence, at: nowIso,
      });
      ledger[field] = d.provenance;
      ledgerChanged = true;
      if (d.action === "filled" || d.action === "replaced") {
        set[field] = d.value;
        if (field === "name") set.normalizedName = normalizeCompanyName(d.value);
        if (field === "domain") set.normalizedDomain = normalizeDomain(d.value);
        changedFields.push(field);
      } else if (d.action === "kept") {
        decision.notes.push(`${field} kept — existing provenance outranks this observation`);
      }
    }
    if (decision.verified) {
      set.brandConfidence = decision.brandConfidence;
      set.brandVerifiedAt = new Date();
    }
    if (ledgerChanged) set.fieldProvenance = ledger;
    if (Object.keys(set).length > 0) {
      await db.update(accounts).set(set as never).where(and(eq(accounts.workspaceId, workspaceId), eq(accounts.id, accountId)));
    }
  }

  // Enrichment-history events: the reconcile itself, plus a `changed` event
  // when the provider's story moved since last sighting.
  const events: Array<typeof organizationEnrichmentEvents.$inferInsert> = [{
    workspaceId, accountId,
    sourceVendor: BRAND_PROVIDER,
    sourceType: "brand_reconcile",
    status: decision.action,
    fieldsUpdated: changedFields.length ? changedFields : null,
    rawSummary: {
      confidence: decision.brandConfidence, basis: scored?.basis ?? "none",
      hitName, hitDomain, notes: decision.notes,
    },
    enrichedByUserId: opts.byUserId ?? null,
  }];
  if (identityChanged) {
    events.push({
      workspaceId, accountId,
      sourceVendor: BRAND_PROVIDER,
      sourceType: "brand_change_detected",
      status: "changed",
      fieldsUpdated: null,
      rawSummary: { previous: { name: prev!.rawName, domain: prev!.rawDomain }, current: { name: hitName, domain: hitDomain } },
      enrichedByUserId: opts.byUserId ?? null,
    });
  }
  await db.insert(organizationEnrichmentEvents).values(events);

  // P3.1: a brand change fires the SAME workflow signal shape a job change
  // does — so rules gated on signal_received can react to rebrands too.
  if (identityChanged) {
    try {
      const { fireWorkflowRules } = await import("../workflowEngine");
      await fireWorkflowRules(workspaceId, "signal_received", {
        payload: {
          signal: "brand_change",
          entity: "account",
          oldName: prev!.rawName, oldDomain: prev!.rawDomain,
          newName: hitName, newDomain: hitDomain,
        },
        relatedType: "account",
        relatedId: accountId,
      });
    } catch (e) {
      console.error(`[BrandReconciler] brand_change rule fire failed:`, (e as Error)?.message ?? e);
    }
  }

  return {
    accountId,
    action: decision.action,
    confidence: decision.brandConfidence,
    basis: scored?.basis ?? null,
    changes: changedFields,
    notes: decision.notes,
  };
}

/* ─── the cron sweep ─────────────────────────────────────────────────────── */

/** Brand Search allows 200 req/5min/IP — stay far under it per run. */
const SWEEP_MAX_SEARCHES = 40;
const SWEEP_SPACING_MS = 1_500;
/** Keyset page size and hard page cap for the candidate scan. */
const CANDIDATE_PAGE = 400;
const CANDIDATE_MAX_PAGES = 25;
/** Consecutive search failures that mean the provider, not the brand, is the problem. */
const SWEEP_FAILURE_ABORT = 3;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface SweepSummary {
  scanned: number;
  searched: number;
  applied: number;
  corroborated: number;
  candidates: number;
  noMatch: number;
  skipped: number;
  /** Searches that never got an answer (auth/rate-limit/network). NOT no_match. */
  failed: number;
}

/**
 * Bounded sweep over ALL workspaces: reconcile accounts that were never
 * verified (outside the negative-cache window), whose verify went stale, or
 * whose identity changed since last queried. Covers pre-existing rows by
 * construction — no event wiring into enrichment paths needed (which also
 * keeps the owner's "prospect enrichment never queries Brandfetch" guard
 * structurally intact).
 */
export interface BrandCandidateRow {
  id: number;
  workspaceId: number;
  name: string;
  domain: string | null;
  brandVerifiedAt: Date | null;
}

/**
 * Gather accounts worth searching, by KEYSET PAGE rather than one capped
 * window.
 *
 * This is the difference between a sweep that finishes and one that stalls. A
 * row held back by the negative cache keeps matching the candidate WHERE for a
 * week — `no_match` leaves brand_verified_at NULL — so a single `LIMIT 400`
 * window fills with rows that will only ever be skipped, and every account
 * behind them becomes unreachable: never searched, so never resolved, so never
 * out of the way. Paging walks PAST the skipped rows, which is what lets a
 * repeated caller (companies.resolveBrandsBatch) drive a workspace to done.
 *
 * Split out from the sweep so this is testable without a database: it takes
 * the page fetch and the observation lookup as callbacks.
 */
export async function collectBrandCandidates(
  fetchPage: (afterId: number, pageSize: number) => Promise<BrandCandidateRow[]>,
  latestObservations: (ids: number[]) => Promise<Map<number, { observedAt: Date; queryHash: string | null }>>,
  opts: { limit: number; now: Date; pageSize?: number; maxPages?: number },
): Promise<{ eligible: BrandCandidateRow[]; scanned: number; skipped: number }> {
  const pageSize = opts.pageSize ?? CANDIDATE_PAGE;
  const maxPages = opts.maxPages ?? CANDIDATE_MAX_PAGES;
  const eligible: BrandCandidateRow[] = [];
  let scanned = 0;
  let skipped = 0;
  let afterId = 0;

  for (let page = 0; page < maxPages && eligible.length < opts.limit; page++) {
    const rows = await fetchPage(afterId, pageSize);
    if (rows.length === 0) break;
    afterId = rows[rows.length - 1]!.id;
    const latest = await latestObservations(rows.map((r) => r.id));
    for (const acc of rows) {
      if (eligible.length >= opts.limit) break;
      scanned++;
      if (!needsBrandRefresh(acc, latest.get(acc.id) ?? null, opts.now)) { skipped++; continue; }
      eligible.push(acc);
    }
    if (rows.length < pageSize) break; // last page
  }
  return { eligible, scanned, skipped };
}

export async function runBrandReconciliation(
  opts: {
    provider?: ProviderLike; limit?: number; spacingMs?: number; workspaceId?: number; domainlessOnly?: boolean;
    /** Reconcile exactly these accounts (live, in the workspace when given)
     *  instead of collecting by the refresh rule — for a caller that knows
     *  which accounts need a fresh look now (e.g. the ones the verification
     *  repair un-stamped, whose recent observation would otherwise keep them
     *  inside the negative-cache window). Same limit/spacing/abort rules. */
    accountIds?: number[];
  } = {},
): Promise<SweepSummary> {
  const summary: SweepSummary = { scanned: 0, searched: 0, applied: 0, corroborated: 0, candidates: 0, noMatch: 0, skipped: 0, failed: 0 };
  const provider = opts.provider ?? (await loadProvider());
  if (!provider.searchReady()) return summary; // dormant without config — never broken, never touches the DB
  const db = await getDb();
  if (!db) return summary;

  const now = new Date();
  const staleBefore = new Date(now.getTime() - REFRESH_TTL_MS);
  const limit = opts.limit ?? SWEEP_MAX_SEARCHES;
  const spacing = opts.spacingMs ?? SWEEP_SPACING_MS;

  const { eligible, scanned, skipped } = opts.accountIds
    ? await (async () => {
        const ids = Array.from(new Set(opts.accountIds)).slice(0, 5000);
        if (ids.length === 0) return { eligible: [] as Array<{ id: number; workspaceId: number; name: string; domain: string | null; brandVerifiedAt: Date | null }>, scanned: 0, skipped: 0 };
        const rows = await db
          .select({ id: accounts.id, workspaceId: accounts.workspaceId, name: accounts.name, domain: accounts.domain, brandVerifiedAt: accounts.brandVerifiedAt })
          .from(accounts)
          .where(and(
            inArray(accounts.id, ids), isNull(accounts.archivedAt), sql`${accounts.name} <> ''`,
            ...(opts.workspaceId ? [eq(accounts.workspaceId, opts.workspaceId)] : []),
          ))
          .orderBy(accounts.id);
        return { eligible: rows.slice(0, limit), scanned: ids.length, skipped: ids.length - Math.min(rows.length, limit) };
      })()
    : await collectBrandCandidates(
    (afterId, pageSize) => db
      .select({ id: accounts.id, workspaceId: accounts.workspaceId, name: accounts.name, domain: accounts.domain, brandVerifiedAt: accounts.brandVerifiedAt })
      .from(accounts)
      .where(and(
        isNull(accounts.archivedAt),
        sql`${accounts.name} <> ''`,
        or(isNull(accounts.brandVerifiedAt), lt(accounts.brandVerifiedAt, staleBefore)),
        gt(accounts.id, afterId),
        // Scoped when a caller is driving ONE workspace to zero; the 6h cron
        // passes nothing and stays cross-workspace as before.
        ...(opts.workspaceId ? [eq(accounts.workspaceId, opts.workspaceId)] : []),
        // Spend the search budget where it changes something. An account that
        // already HAS a domain renders an icon and resolves fine; searching it
        // only upgrades its identity to verified, which the 6h cron does for
        // free. A domain-less account is the actual gap.
        ...(opts.domainlessOnly ? [or(isNull(accounts.domain), sql`${accounts.domain} = ''`)!] : []),
      ))
      .orderBy(accounts.id)
      .limit(pageSize),
    async (ids) => {
      // One query per page for those rows' latest observation (negative cache +
      // identity change — a renamed account re-qualifies despite a fresh row).
      const latestByAccount = new Map<number, { observedAt: Date; queryHash: string | null }>();
      const obsRows = await db
        .select({ accountId: brandObservations.accountId, observedAt: brandObservations.observedAt, queryHash: brandObservations.queryHash })
        .from(brandObservations)
        .where(and(inArray(brandObservations.accountId, ids), eq(brandObservations.provider, BRAND_PROVIDER)))
        .orderBy(desc(brandObservations.observedAt));
      for (const o of obsRows) {
        if (!latestByAccount.has(o.accountId)) latestByAccount.set(o.accountId, { observedAt: o.observedAt, queryHash: o.queryHash });
      }
      return latestByAccount;
    },
    { limit, now },
  );
  summary.scanned = scanned;
  summary.skipped = skipped;
  if (eligible.length === 0) return summary;

  let consecutiveFailures = 0;
  for (const acc of eligible) {
    if (summary.searched > 0 && spacing > 0) await sleep(spacing);
    summary.searched++;
    try {
      const r = await reconcileAccountBrand(acc.workspaceId, acc.id, { provider });
      if (r.action === "applied") summary.applied++;
      else if (r.action === "corroborated") summary.corroborated++;
      else if (r.action === "candidate") summary.candidates++;
      else if (r.action === "no_match") summary.noMatch++;
      else if (r.action === "search_failed") summary.failed++;
      else summary.skipped++;

      // A key that stopped working fails for every account alike. Stop rather
      // than walk the whole table hammering a 401 or deepening a 429.
      if (r.action === "search_failed") {
        if (++consecutiveFailures >= SWEEP_FAILURE_ABORT) {
          console.error(`[BrandReconciler] aborting sweep after ${consecutiveFailures} consecutive search failures: ${r.notes[0] ?? ""}`);
          break;
        }
      } else consecutiveFailures = 0;
    } catch (e) {
      console.error(`[BrandReconciler] account ${acc.id} failed:`, (e as Error)?.message ?? e);
      summary.skipped++;
    }
  }
  return summary;
}
