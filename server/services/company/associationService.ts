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
import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "../../db";
import {
  accounts, prospects, contacts, contactAccountLinks,
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

/** Build a CompanyInput from a prospect-like row. */
export function companyInputFromProspect(p: {
  company?: string | null; companyDomain?: string | null; email?: string | null;
  city?: string | null; state?: string | null; country?: string | null;
}): CompanyInput {
  return {
    name: p.company ?? null,
    domain: p.companyDomain ?? null,
    website: p.companyDomain ?? null,
    emailDomain: businessDomainFromEmail(p.email) || null,
    hqCity: p.city ?? null, hqState: p.state ?? null, hqCountry: p.country ?? null,
  };
}

function hasUsableIdentity(input: CompanyInput): boolean {
  return !!(normalizeCompanyName(input.name) || normalizeDomain(input.domain) || normalizeDomain(input.website) || input.emailDomain);
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

/** Find or create the shared global organization for a company identity. */
export async function upsertGlobalOrganization(input: CompanyInput): Promise<number | null> {
  const db = await getDb();
  if (!db) return null;
  if (!hasUsableIdentity(input)) return null;

  const match = await findGlobalOrganizationMatch(input);
  if (match.organizationId && (match.confidence === "exact_match" || match.confidence === "high_confidence")) {
    return match.organizationId;
  }
  const domain = normalizeDomain(input.domain) || normalizeDomain(input.website) || input.emailDomain || null;
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
  const domain = normalizeDomain(input.domain) || normalizeDomain(input.website) || input.emailDomain || null;
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
}, opts?: { sourceType?: string }): Promise<AssociationResult> {
  const sourceType = opts?.sourceType ?? "prospect_import";
  const db = await getDb();
  if (!db) return { accountId: null, globalOrganizationId: null, created: false, status: "missing", score: 0 };

  try {
    const input = companyInputFromProspect(prospect);
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

/** Associate many prospects (backfill / bulk import). */
export async function associateBulkProspectsToCompanies(
  workspaceId: number, prospectIds: number[], sourceType = "bulk_import",
): Promise<{ processed: number; linked: number; created: number; needsReview: number; missing: number }> {
  const db = await getDb();
  const stats = { processed: 0, linked: 0, created: 0, needsReview: 0, missing: 0 };
  if (!db) return stats;
  for (const id of prospectIds) {
    const [p] = await db.select().from(prospects)
      .where(and(eq(prospects.workspaceId, workspaceId), eq(prospects.id, id))).limit(1);
    if (!p) continue;
    const r = await associateProspectToCompany(p as never, { sourceType });
    stats.processed++;
    if (r.created) stats.created++;
    if (r.status === "linked") stats.linked++;
    else if (r.status === "needs_review") stats.needsReview++;
    else if (r.status === "missing") stats.missing++;
  }
  return stats;
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
  for (const p of rows) {
    const r = await associateProspectToCompany(p as never, { sourceType });
    stats.processed++;
    if (r.created) stats.created++;
    if (r.status === "linked") stats.linked++;
    else if (r.status === "needs_review") stats.needsReview++;
    else if (r.status === "missing") stats.missing++;
  }
  return stats;
}

/** Manually link a contact to an account. */
export async function linkContactToAccount(ws: number, contactId: number, accountId: number, sourceType = "manually_linked"): Promise<void> {
  const db = await getDb();
  if (!db) return;
  const [acct] = await db.select({ orgId: accounts.globalOrganizationId }).from(accounts)
    .where(and(eq(accounts.workspaceId, ws), eq(accounts.id, accountId))).limit(1);
  await db.update(contacts).set({ accountId, globalOrganizationId: acct?.orgId ?? null } as never)
    .where(and(eq(contacts.workspaceId, ws), eq(contacts.id, contactId)));
  await linkPerson({ ws, personType: "contact", personId: contactId, accountId, globalOrganizationId: acct?.orgId ?? null, relationshipType: "manually_linked", sourceType, confidence: 100 });
  await emitCompanyActivity(ws, accountId, "Contact linked to company");
}

export async function unlinkContactFromAccount(ws: number, contactId: number, accountId: number): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db.delete(contactAccountLinks).where(and(
    eq(contactAccountLinks.workspaceId, ws), eq(contactAccountLinks.personType, "contact"),
    eq(contactAccountLinks.personId, contactId), eq(contactAccountLinks.accountId, accountId)));
  await db.update(contacts).set({ accountId: null } as never)
    .where(and(eq(contacts.workspaceId, ws), eq(contacts.id, contactId)));
}
