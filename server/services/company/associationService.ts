/**
 * CompanyAssociationService — the heart of the feature.
 *
 * On prospect/contact ingestion, extracts company identity, matches or creates
 * a workspace account (+ a shared global organization), links the person, and
 * records a contact_account_link. Never throws into the ingestion path: company
 * association is best-effort metadata and must not block prospect creation.
 *
 * Auto-link policy: exact/high → link existing · possible (no conflict) → link
 * as needs_review · conflict → leave unlinked (needs_review) · no_match → create
 * new account. Prospects with no usable company identity are marked "missing".
 */
import { and, eq, inArray, isNull } from "drizzle-orm";
import { getDb } from "../../db";
import {
  accounts, prospects, contactAccountLinks, prospectLinkedinEnrichments,
  globalOrganizations, organizationDomains, accountDomains, activities,
} from "../../../drizzle/schema";
import {
  normalizeCompanyName, normalizeDomain, normalizeWebsite, businessDomainFromEmail,
} from "./normalize";
import {
  findWorkspaceAccountMatch, findGlobalOrganizationMatch, shouldAutoLink,
  type CompanyInput,
} from "./matchingService";

const insertId = (res: unknown): number => Number((res as { insertId?: number }[])[0]?.insertId ?? 0);

export interface AssociationResult {
  accountId: number | null;
  globalOrganizationId: number | null;
  created: boolean;
  status: "linked" | "needs_review" | "conflict" | "missing";
  score: number;
}

/**
 * Build a CompanyInput from a prospect-like row.
 *
 * LinkedIn first (owner directive 2026-08-13: "you must fall back on the
 * person's LinkedIn for their attached company record"). Their LinkedIn
 * profile states where they actually work; their mailbox does not. A parent,
 * board member or partner carries dc.gov, ftc.gov or a spouse's employer, and
 * treating that as their company is what split one org into six accounts.
 */
export function companyInputFromProspect(
  p: {
    company?: string | null; companyDomain?: string | null; email?: string | null;
    city?: string | null; state?: string | null; country?: string | null;
  },
  linkedin?: { companyName?: string | null; companyDomain?: string | null } | null,
): CompanyInput {
  return {
    name: (linkedin?.companyName?.trim() || null) ?? p.company ?? null,
    domain: (linkedin?.companyDomain?.trim() || null) ?? p.companyDomain ?? null,
    website: (linkedin?.companyDomain?.trim() || null) ?? p.companyDomain ?? null,
    // Kept ONLY so matching can recognise an existing account that already
    // owns this domain. It is no longer allowed to name or create a company —
    // see createWorkspaceAccount and hasUsableIdentity.
    emailDomain: businessDomainFromEmail(p.email) || null,
    hqCity: p.city ?? null, hqState: p.state ?? null, hqCountry: p.country ?? null,
  };
}

/**
 * A mailbox domain alone is NOT a company identity. If it were, every person
 * whose employer we don't know would mint a company named after their mail
 * host — which is exactly how the 2026-08-13 run produced hundreds of
 * accounts. Identity means a name, or a domain we believe is the company's.
 */
function hasUsableIdentity(input: CompanyInput): boolean {
  return !!(normalizeCompanyName(input.name) || normalizeDomain(input.domain) || normalizeDomain(input.website));
}

async function emitCompanyActivity(ws: number, accountId: number, subject: string, actorUserId?: number | null) {
  const db = await getDb();
  if (!db) return;
  try {
    await db.insert(activities).values({
      workspaceId: ws, type: "system", relatedType: "account", relatedId: accountId,
      subject: subject.slice(0, 240), actorUserId: actorUserId ?? null,
    } as never);
  } catch { /* best-effort */ }
}

export interface LinkedInCompanyFacts {
  companyName?: string | null;
  companyDomain?: string | null;
}

/**
 * The company each person's LinkedIn profile says they work for, batched.
 * This is the source of truth for "who does this person work for" — a mailbox
 * domain is not (owner directive 2026-08-13).
 */
export async function linkedInCompanyFactsFor(
  workspaceId: number, prospectIds: number[],
): Promise<Map<number, LinkedInCompanyFacts>> {
  const out = new Map<number, LinkedInCompanyFacts>();
  if (prospectIds.length === 0) return out;
  const db = await getDb();
  if (!db) return out;
  for (let i = 0; i < prospectIds.length; i += 500) {
    const chunk = prospectIds.slice(i, i + 500);
    const rows = await db
      .select({
        prospectId: prospectLinkedinEnrichments.prospectId,
        companyName: prospectLinkedinEnrichments.currentCompanyName,
        companyDomain: prospectLinkedinEnrichments.currentCompanyDomain,
      })
      .from(prospectLinkedinEnrichments)
      .where(and(
        eq(prospectLinkedinEnrichments.workspaceId, workspaceId),
        inArray(prospectLinkedinEnrichments.prospectId, chunk),
      ));
    for (const r of rows) {
      if (!r.companyName && !r.companyDomain) continue;
      if (!out.has(r.prospectId)) out.set(r.prospectId, { companyName: r.companyName, companyDomain: r.companyDomain });
    }
  }
  return out;
}

/** Find or create the shared global organization for a company identity. */
export async function upsertGlobalOrganization(input: CompanyInput): Promise<number | null> {
  const db = await getDb();
  if (!db) return null;
  if (!hasUsableIdentity(input)) return null;

  const match = await findGlobalOrganizationMatch(input);
  if (match.organizationId && (match.confidence === "exact_match" || match.confidence === "high_confidence")) {
    return match.organizationId;
  }
  // No emailDomain fallback: a company's domain must come from a company
  // source (LinkedIn, or the record's own companyDomain), never from where
  // one person happens to collect mail. A blank domain is honest and the
  // brand/adopt path fills it later; a mailbox domain is a wrong answer that
  // then poisons matching, linking and email-pattern enrichment.
  const domain = normalizeDomain(input.domain) || normalizeDomain(input.website) || null;
  const name = (input.name && input.name.trim()) || domain || "Unknown company";
  const res = await db.insert(globalOrganizations).values({
    name: name.slice(0, 200), normalizedName: normalizeCompanyName(name) || name.toLowerCase(),
    domain, normalizedDomain: domain, websiteUrl: normalizeWebsite(input.website) || (domain ? `https://${domain}` : null),
    linkedinCompanyUrl: input.linkedinCompanyUrl ?? null,
    headquartersCity: input.hqCity ?? null, headquartersState: input.hqState ?? null, headquartersCountry: input.hqCountry ?? null,
    dataStatus: "partial",
  } as never);
  const orgId = insertId(res);
  if (domain) {
    await db.insert(organizationDomains).values({
      globalOrganizationId: orgId, domain, normalizedDomain: domain, isPrimary: true, sourceType: "prospect_import",
    } as never);
  }
  return orgId;
}

/** Create a workspace account from a company identity. */
export async function createWorkspaceAccount(ws: number, input: CompanyInput, sourceType: string): Promise<number> {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  // No emailDomain fallback: a company's domain must come from a company
  // source (LinkedIn, or the record's own companyDomain), never from where
  // one person happens to collect mail. A blank domain is honest and the
  // brand/adopt path fills it later; a mailbox domain is a wrong answer that
  // then poisons matching, linking and email-pattern enrichment.
  const domain = normalizeDomain(input.domain) || normalizeDomain(input.website) || null;
  const name = (input.name && input.name.trim()) || domain || "Unknown company";
  const orgId = await upsertGlobalOrganization(input);
  const res = await db.insert(accounts).values({
    workspaceId: ws, name: name.slice(0, 200), domain,
    normalizedName: normalizeCompanyName(name) || name.toLowerCase(), normalizedDomain: domain,
    websiteUrl: normalizeWebsite(input.website) || (domain ? `https://${domain}` : null),
    linkedinCompanyUrl: input.linkedinCompanyUrl ?? null,
    globalOrganizationId: orgId,
    hqCity: input.hqCity ?? null, hqState: input.hqState ?? null, hqCountry: input.hqCountry ?? null,
    sourceType, dataStatus: "partial", logoStatus: "unknown", crmSyncStatus: "not_synced",
  } as never);
  const accountId = insertId(res);
  if (domain) {
    await db.insert(accountDomains).values({
      workspaceId: ws, accountId, domain, normalizedDomain: domain, isPrimary: true, sourceType,
    } as never);
  }
  await emitCompanyActivity(ws, accountId, `Company created from prospect: ${name}`);
  return accountId;
}

async function linkPerson(opts: {
  ws: number; personType: "prospect" | "contact"; personId: number; accountId: number;
  globalOrganizationId: number | null; relationshipType: string; sourceType: string;
  confidence: number; titleAtCompany?: string | null;
}) {
  const db = await getDb();
  if (!db) return;
  const { ws, personType, personId, accountId } = opts;
  // De-dupe: skip if a current link to this account already exists.
  const [existing] = await db.select({ id: contactAccountLinks.id }).from(contactAccountLinks)
    .where(and(eq(contactAccountLinks.workspaceId, ws), eq(contactAccountLinks.personType, personType),
      eq(contactAccountLinks.personId, personId), eq(contactAccountLinks.accountId, accountId))).limit(1);
  if (!existing) {
    await db.insert(contactAccountLinks).values({
      workspaceId: ws, personType, personId, accountId, globalOrganizationId: opts.globalOrganizationId,
      relationshipType: opts.relationshipType, sourceType: opts.sourceType,
      confidence: String(opts.confidence), titleAtCompany: opts.titleAtCompany ?? null, isCurrent: true,
    } as never);
  }
}

/**
 * Associate one prospect to a company. Returns the resolution. Never throws.
 */
export async function associateProspectToCompany(prospect: {
  id: number; workspaceId: number; company?: string | null; companyDomain?: string | null;
  email?: string | null; title?: string | null; city?: string | null; state?: string | null; country?: string | null;
}, opts?: { sourceType?: string; linkedin?: LinkedInCompanyFacts | null }): Promise<AssociationResult> {
  const sourceType = opts?.sourceType ?? "prospect_import";
  const db = await getDb();
  if (!db) return { accountId: null, globalOrganizationId: null, created: false, status: "missing", score: 0 };

  try {
    // The caller may pass LinkedIn facts it already batched; otherwise read
    // them here. Either way LinkedIn is what says where this person works.
    const linkedin = opts?.linkedin !== undefined
      ? opts.linkedin
      : (await linkedInCompanyFactsFor(prospect.workspaceId, [prospect.id])).get(prospect.id) ?? null;
    const input = companyInputFromProspect(prospect, linkedin);
    if (!hasUsableIdentity(input)) {
      await db.update(prospects).set({ companyMatchStatus: "missing" } as never)
        .where(and(eq(prospects.workspaceId, prospect.workspaceId), eq(prospects.id, prospect.id)));
      return { accountId: null, globalOrganizationId: null, created: false, status: "missing", score: 0 };
    }

    const match = await findWorkspaceAccountMatch(prospect.workspaceId, input);
    let accountId: number | null = null;
    let created = false;
    let status: AssociationResult["status"] = "linked";

    if (match.accountId && shouldAutoLink(match.confidence)) {
      accountId = match.accountId;
    } else if (match.accountId && match.confidence === "possible_match" && !match.conflict) {
      accountId = match.accountId; status = "needs_review";
    } else if (match.confidence === "conflict") {
      // Do not auto-link on conflicting identifiers — flag for review.
      await db.update(prospects).set({ companyMatchStatus: "conflict" } as never)
        .where(and(eq(prospects.workspaceId, prospect.workspaceId), eq(prospects.id, prospect.id)));
      return { accountId: null, globalOrganizationId: null, created: false, status: "conflict", score: match.score };
    } else {
      accountId = await createWorkspaceAccount(prospect.workspaceId, input, sourceType);
      created = true;
    }

    // Resolve global org for the account.
    const [acct] = await db.select({ orgId: accounts.globalOrganizationId }).from(accounts)
      .where(and(eq(accounts.workspaceId, prospect.workspaceId), eq(accounts.id, accountId!))).limit(1);
    let orgId = acct?.orgId ?? null;
    if (!orgId) {
      orgId = await upsertGlobalOrganization(input);
      if (orgId) await db.update(accounts).set({ globalOrganizationId: orgId } as never)
        .where(and(eq(accounts.workspaceId, prospect.workspaceId), eq(accounts.id, accountId!)));
    }

    await db.update(prospects).set({
      accountId, globalOrganizationId: orgId, companyMatchStatus: status,
    } as never).where(and(eq(prospects.workspaceId, prospect.workspaceId), eq(prospects.id, prospect.id)));

    await linkPerson({
      ws: prospect.workspaceId, personType: "prospect", personId: prospect.id, accountId: accountId!,
      globalOrganizationId: orgId, relationshipType: created ? "imported_company" : "current_employer",
      sourceType, confidence: match.score, titleAtCompany: prospect.title ?? null,
    });
    if (!created) await emitCompanyActivity(prospect.workspaceId, accountId!, "Prospect linked to company");

    return { accountId, globalOrganizationId: orgId, created, status, score: match.score };
  } catch (e) {
    console.error(`[company] associate prospect ${prospect.id} failed:`, (e as Error).message);
    return { accountId: null, globalOrganizationId: null, created: false, status: "missing", score: 0 };
  }
}

/**
 * Associate every prospect in the workspace that isn't linked yet (account_id
 * IS NULL) and has usable company data. Serves both post-import sweeps and the
 * one-time backfill. Idempotent — already-linked prospects are skipped.
 */
export async function associateUnlinkedProspects(
  workspaceId: number, limit = 3000, sourceType = "prospect_import",
): Promise<{ processed: number; linked: number; created: number; needsReview: number; missing: number }> {
  const db = await getDb();
  const stats = { processed: 0, linked: 0, created: 0, needsReview: 0, missing: 0 };
  if (!db) return stats;
  const rows = await db.select().from(prospects)
    .where(and(eq(prospects.workspaceId, workspaceId), isNull(prospects.accountId))).limit(limit);
  // One batched read instead of a LinkedIn lookup per prospect.
  const linkedin = await linkedInCompanyFactsFor(workspaceId, rows.map((p) => p.id));
  for (const p of rows) {
    const r = await associateProspectToCompany(p as never, { sourceType, linkedin: linkedin.get(p.id) ?? null });
    stats.processed++;
    if (r.created) stats.created++;
    if (r.status === "linked") stats.linked++;
    else if (r.status === "needs_review") stats.needsReview++;
    else if (r.status === "missing") stats.missing++;
  }
  return stats;
}

