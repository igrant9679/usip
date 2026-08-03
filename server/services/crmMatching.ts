/**
 * Finding the CRM row a person or company already is.
 *
 * Extracted from `promoteProspectToCrm` because a second promotion path now
 * needs the identical rule, and two copies of "is this the same company?" is
 * how one of them silently starts creating duplicate accounts. Same reasoning
 * as the slugify / canonicalText / mergeKeys consolidations: the rule decides
 * identity, so it gets one definition.
 */
import { and, eq, sql } from "drizzle-orm";
import { accounts, contacts } from "../../drizzle/schema";

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
      industry: identity.industry ?? undefined,
      ownerUserId: identity.ownerUserId,
    })
    .$returningId();
  return created.id;
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
  db: NonNullable<Awaited<ReturnType<typeof import("../db").getDb>>>,
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
