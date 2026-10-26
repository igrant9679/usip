/**
 * Finding the CRM row a person or company already is.
 *
 * Extracted from `promoteProspectToCrm` because a second promotion path now
 * needs the identical rule, and two copies of "is this the same company?" is
 * how one of them silently starts creating duplicate accounts. Same reasoning
 * as the slugify / canonicalText / mergeKeys consolidations: the rule decides
 * identity, so it gets one definition.
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { accounts, contacts } from "../../drizzle/schema";
import { businessDomainFromEmail, normalizeCompanyName, normalizedAccountFields } from "./company/normalize";

/** Reads only — a transaction handle is fine. */
type ReadDb = Pick<NonNullable<Awaited<ReturnType<typeof import("../db").getDb>>>, "select">;

export interface AccountIdentity {
  companyName: string;
  companyDomain?: string | null;
  industry?: string | null;
  ownerUserId?: number | undefined;
}

/**
 * The account for this company, creating it if there is none.
 *
 * DOMAIN FIRST, then name. Domain is the reliable identity — two "Acme" rows
 * are usually different companies, one domain is one company — and the free
 * Apollo organization search supplies a domain for most rows, which is why
 * matching on it is worth doing before falling back to a name comparison.
 *
 * NO record_created fire here. This is the shared account funnel — ARE
 * promotion and the prospect-promotion sweeper both come through it in loops —
 * and accounts are out of scope for the record_* triggers anyway (see the
 * do-not-fire list in services/workflowEngine.ts).
 */
export async function findOrCreateAccount(
  db: NonNullable<Awaited<ReturnType<typeof import("../db").getDb>>>,
  workspaceId: number,
  identity: AccountIdentity,
): Promise<number> {
  if (identity.companyDomain) {
    const [byDomain] = await db
      .select({ id: accounts.id })
      .from(accounts)
      .where(and(eq(accounts.workspaceId, workspaceId), eq(accounts.domain, identity.companyDomain)))
      .limit(1);
    if (byDomain) return byDomain.id;
  }
  const [byName] = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.workspaceId, workspaceId), eq(accounts.name, identity.companyName)))
    .limit(1);
  if (byName) return byName.id;

  const [created] = await db
    .insert(accounts)
    .values({
      workspaceId,
      name: identity.companyName,
      domain: identity.companyDomain ?? undefined,
      ...normalizedAccountFields(identity.companyName, identity.companyDomain),
      industry: identity.industry ?? undefined,
      ownerUserId: identity.ownerUserId,
    })
    .$returningId();
  return created.id;
}

export type AccountMatch = { id: number; name: string; domain: string | null; reason: "domain" | "name" };

/**
 * The accounts a lead could already be (audit 2026-10-20, R8): converting
 * created a NEW account every time, so a second person from Acme made a
 * second Acme. Domain first — from the lead's work address, never a consumer
 * mailbox — then the normalised company name. Merged-away (archived) accounts
 * are not offered.
 */
export async function accountMatchesForLead(
  db: ReadDb,
  workspaceId: number,
  lead: { company?: string | null; email?: string | null },
): Promise<AccountMatch[]> {
  const out: AccountMatch[] = [];
  const domain = businessDomainFromEmail(lead.email);
  if (domain) {
    const rows = await db.select({ id: accounts.id, name: accounts.name, domain: accounts.domain }).from(accounts)
      .where(and(eq(accounts.workspaceId, workspaceId), eq(accounts.normalizedDomain, domain), isNull(accounts.archivedAt)))
      .limit(5);
    for (const r of rows) out.push({ ...r, domain: r.domain ?? null, reason: "domain" });
  }
  const name = normalizeCompanyName(lead.company);
  if (name) {
    const rows = await db.select({ id: accounts.id, name: accounts.name, domain: accounts.domain }).from(accounts)
      .where(and(eq(accounts.workspaceId, workspaceId), eq(accounts.normalizedName, name), isNull(accounts.archivedAt)))
      .limit(5);
    for (const r of rows) if (!out.some((o) => o.id === r.id)) out.push({ ...r, domain: r.domain ?? null, reason: "name" });
  }
  return out;
}

/**
 * An existing contact with this address in this workspace, or null.
 *
 * Workspace-scoped, and lower-cased on both sides: addresses are
 * case-insensitive, and an import is exactly where "Jane@Acme.com" meets a CRM
 * row created as "jane@acme.com". Matching case-sensitively would create a
 * second contact for the same person, which is the duplicate this exists to
 * prevent.
 */
export async function findContactByEmail(
  db: ReadDb,
  workspaceId: number,
  email: string,
): Promise<number | null> {
  const needle = email.trim().toLowerCase();
  if (!needle) return null;
  // Compared in SQL, not by loading the workspace's contacts and filtering in
  // JS: this runs once per promoted prospect, and a backlog sweep promotes
  // hundreds a day against a CRM that may hold tens of thousands of rows.
  const [hit] = await db
    .select({ id: contacts.id })
    .from(contacts)
    .where(and(eq(contacts.workspaceId, workspaceId), sql`lower(${contacts.email}) = ${needle}`))
    .limit(1);
  return hit?.id ?? null;
}
