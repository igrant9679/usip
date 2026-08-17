/**
 * CompanyMatchingService — resolve a company identity to an existing workspace
 * account (and/or global organization), with an explainable score + conflict
 * detection driving the auto-link decision.
 *
 * Scoring (per spec): exact domain/CRM id +100, LinkedIn url +95, global-org id
 * +95, exact name +50, fuzzy name +35, same website +40, same email domain +35,
 * same HQ +15; conflicting domains -50; consumer-only -30. Buckets: exact 90+,
 * high 80-89, possible 65-79, no_match <65; strong conflicting ids → conflict.
 *
 * Two rules layered on the spec (owner directive 2026-08-13, after a live run
 * split one org into six accounts):
 *
 *  - A person's MAILBOX domain may recognise an account that already owns it
 *    (+35) but is never identity: it does not stand in for a missing company
 *    domain, and a mailbox that differs from a candidate's domain is NOT a
 *    conflict. Parents, board members and partners carry dc.gov, ftc.gov, a
 *    spouse's employer — that must not veto the company their record names.
 *  - An EXACT normalized-name match with no conflicting identifier is at
 *    least a possible match. On its own it scores 50, below the possible band,
 *    and "no match" here means "create another account with the same name" —
 *    which is never better than a reviewable link to the one that exists.
 *
 * Archived accounts are never candidates: a merge archives its losers and the
 * association undo archives what a bad run created, and both keep their old
 * domain and name columns.
 */
import { and, eq, isNull, or } from "drizzle-orm";
import { getDb } from "../../db";
import { accounts, accountDomains, globalOrganizations, organizationDomains } from "../../../drizzle/schema";
import {
  normalizeCompanyName, normalizeDomain, normalizeWebsite,
  normalizeLinkedInCompanyUrl, nameSimilarity, isConsumerDomain,
} from "./normalize";

export interface CompanyInput {
  name?: string | null;
  domain?: string | null;
  website?: string | null;
  linkedinCompanyUrl?: string | null;
  crmExternalId?: string | null;
  globalOrganizationId?: number | null;
  emailDomain?: string | null;
  hqCity?: string | null;
  hqState?: string | null;
  hqCountry?: string | null;
}

export type MatchConfidence = "exact_match" | "high_confidence" | "possible_match" | "no_match" | "conflict";

export interface CompanyMatch {
  accountId: number | null;
  globalOrganizationId: number | null;
  score: number;
  confidence: MatchConfidence;
  conflict: boolean;
  reasons: string[];
}

type AccountRow = typeof accounts.$inferSelect;
type OrgRow = typeof globalOrganizations.$inferSelect;

/** Derived, normalized view of the input. */
function norm(input: CompanyInput) {
  return {
    name: normalizeCompanyName(input.name),
    // Company sources only. The mailbox is scored separately (below) and never
    // stands in for a company domain — see the header.
    domain: normalizeDomain(input.domain) || normalizeDomain(input.website),
    website: normalizeWebsite(input.website),
    linkedin: normalizeLinkedInCompanyUrl(input.linkedinCompanyUrl),
    emailDomain: input.emailDomain && !isConsumerDomain(input.emailDomain) ? normalizeDomain(input.emailDomain) : "",
    consumerOnly: !!input.emailDomain && isConsumerDomain(input.emailDomain) && !input.domain && !input.website && !input.name,
    hq: [input.hqCity, input.hqState, input.hqCountry].filter(Boolean).join(" ").toLowerCase().trim(),
  };
}

export function scoreCompanyMatch(input: CompanyInput, candidate: {
  normalizedName?: string | null; normalizedDomain?: string | null; domain?: string | null;
  website?: string | null; linkedinCompanyUrl?: string | null; crmExternalId?: string | null;
  globalOrganizationId?: number | null; hqCity?: string | null; hqState?: string | null; hqCountry?: string | null;
}): { score: number; conflict: boolean; exactName: boolean; reasons: string[] } {
  const n = norm(input);
  const reasons: string[] = [];
  let score = 0;
  let conflict = false;
  let exactName = false;

  const candDomain = candidate.normalizedDomain || normalizeDomain(candidate.domain) || normalizeDomain(candidate.website);
  const candLinkedin = normalizeLinkedInCompanyUrl(candidate.linkedinCompanyUrl);
  const candName = candidate.normalizedName || normalizeCompanyName((candidate as { name?: string }).name);
  const candHq = [candidate.hqCity, candidate.hqState, candidate.hqCountry].filter(Boolean).join(" ").toLowerCase().trim();

  if (input.crmExternalId && candidate.crmExternalId && input.crmExternalId === candidate.crmExternalId) {
    score += 100; reasons.push("CRM account id match (+100)");
  }
  if (input.globalOrganizationId && candidate.globalOrganizationId && input.globalOrganizationId === candidate.globalOrganizationId) {
    score += 95; reasons.push("global organization match (+95)");
  }
  if (n.domain && candDomain) {
    if (n.domain === candDomain) { score += 100; reasons.push("exact domain (+100)"); }
    else { score -= 50; reasons.push("conflicting domain (-50)"); conflict = true; }
  }
  if (n.linkedin && candLinkedin && n.linkedin === candLinkedin) {
    score += 95; reasons.push("linkedin company url (+95)");
  }
  if (n.website && candidate.website && normalizeWebsite(candidate.website) === n.website) {
    score += 40; reasons.push("same website (+40)");
  }
  if (n.name && candName) {
    if (n.name === candName) { score += 50; exactName = true; reasons.push("exact name (+50)"); }
    else if (nameSimilarity(n.name, candName) >= 0.6) { score += 35; reasons.push("fuzzy name (+35)"); }
  }
  // Recognition only: a mailbox that matches earns +35; one that differs is
  // silent. It is not a company domain and cannot conflict with one.
  if (n.emailDomain && candDomain && n.emailDomain === candDomain) {
    score += 35; reasons.push("email domain (+35)");
  }
  if (n.hq && candHq && n.hq === candHq) { score += 15; reasons.push("same HQ (+15)"); }
  if (n.consumerOnly) { score -= 30; reasons.push("consumer email only (-30)"); }

  return { score, conflict, exactName, reasons };
}

export function bucket(score: number, conflict: boolean, exactName = false): MatchConfidence {
  if (conflict && score < 90) return "conflict";
  if (score >= 90) return "exact_match";
  if (score >= 80) return "high_confidence";
  if (score >= 65) return "possible_match";
  // Same normalized name, nothing contradicting it: a reviewable link beats a
  // second account with that name (see header).
  if (exactName) return "possible_match";
  return "no_match";
}

/** exact/high → auto-link (unless conflict). */
export function shouldAutoLink(confidence: MatchConfidence): boolean {
  return confidence === "exact_match" || confidence === "high_confidence";
}

export async function findWorkspaceAccountMatch(workspaceId: number, input: CompanyInput): Promise<CompanyMatch> {
  const db = await getDb();
  const empty: CompanyMatch = { accountId: null, globalOrganizationId: null, score: 0, confidence: "no_match", conflict: false, reasons: [] };
  if (!db) return empty;
  const n = norm(input);

  const byId = new Map<number, AccountRow>();
  const add = (rows: AccountRow[]) => rows.forEach((r) => byId.set(r.id, r));
  // Live accounts only — see header.
  const live = and(eq(accounts.workspaceId, workspaceId), isNull(accounts.archivedAt));
  // The mailbox still finds the account that owns it (recognition); scoring
  // decides whether that is enough.
  const domains = [n.domain, n.emailDomain].filter((d): d is string => !!d);
  for (const d of domains) {
    add(await db.select().from(accounts).where(and(live, eq(accounts.normalizedDomain, d))));
    const ad = await db.select({ accountId: accountDomains.accountId }).from(accountDomains)
      .where(and(eq(accountDomains.workspaceId, workspaceId), eq(accountDomains.normalizedDomain, d)));
    if (ad.length) add(await db.select().from(accounts).where(and(live, or(...ad.map((a) => eq(accounts.id, a.accountId)))!)));
  }
  if (input.crmExternalId) add(await db.select().from(accounts).where(and(live, eq(accounts.crmExternalId, input.crmExternalId))));
  if (input.globalOrganizationId) add(await db.select().from(accounts).where(and(live, eq(accounts.globalOrganizationId, input.globalOrganizationId))));
  if (n.name) add(await db.select().from(accounts).where(and(live, eq(accounts.normalizedName, n.name))));

  const candidates = [...byId.values()];
  if (!candidates.length) return empty;

  const scored = candidates.map((c) => {
    const s = scoreCompanyMatch(input, c);
    return { accountId: c.id, globalOrganizationId: c.globalOrganizationId ?? null, ...s };
  }).sort((a, b) => b.score - a.score);
  const best = scored[0];
  return { accountId: best.accountId, globalOrganizationId: best.globalOrganizationId, score: best.score, confidence: bucket(best.score, best.conflict, best.exactName), conflict: best.conflict, reasons: best.reasons };
}

export async function findGlobalOrganizationMatch(input: CompanyInput): Promise<{ organizationId: number | null; score: number; confidence: MatchConfidence }> {
  const db = await getDb();
  if (!db) return { organizationId: null, score: 0, confidence: "no_match" };
  const n = norm(input);
  const byId = new Map<number, OrgRow>();
  const add = (rows: OrgRow[]) => rows.forEach((r) => byId.set(r.id, r));
  const domains = [n.domain, n.emailDomain].filter((d): d is string => !!d);
  for (const d of domains) {
    add(await db.select().from(globalOrganizations).where(eq(globalOrganizations.normalizedDomain, d)));
    const od = await db.select({ orgId: organizationDomains.globalOrganizationId }).from(organizationDomains)
      .where(eq(organizationDomains.normalizedDomain, d));
    if (od.length) add(await db.select().from(globalOrganizations).where(or(...od.map((o) => eq(globalOrganizations.id, o.orgId)))!));
  }
  if (n.name) add(await db.select().from(globalOrganizations).where(eq(globalOrganizations.normalizedName, n.name)));
  const candidates = [...byId.values()];
  if (!candidates.length) return { organizationId: null, score: 0, confidence: "no_match" };
  const scored = candidates.map((c) => ({ id: c.id, ...scoreCompanyMatch(input, c) })).sort((a, b) => b.score - a.score);
  const best = scored[0];
  return { organizationId: best.id, score: best.score, confidence: bucket(best.score, best.conflict, best.exactName) };
}
