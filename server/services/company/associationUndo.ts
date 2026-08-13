/**
 * Undo an association run (owner directive 2026-08-13).
 *
 * `associateUnlinkedProspects` resolves a person's company from their company
 * NAME, their companyDomain, and — the part that went wrong — their EMAIL
 * DOMAIN. A person's mailbox is often not their employer: parents, partners
 * and board members carry dc.gov, ftc.gov, a spouse's company. The matcher
 * reads each distinct mailbox domain as a distinct company, so one org became
 * an account per mailbox domain (Takoma Children's School → six accounts, one
 * of them right) and plenty of accounts took a domain that is simply somebody
 * else's employer.
 *
 * This reverses one run, identified by time:
 *
 *  - accounts CREATED by the run are archived (not deleted — a merge archives
 *    its losers too, and history stays recoverable);
 *  - every person the run linked is unlinked, including links made to
 *    pre-existing accounts, found via contact_account_links.createdAt;
 *  - the link rows and the created accounts' domain rows go;
 *  - activity rows stay. They are history, and history is not undone.
 *
 * Dry run by default: `apply` must be passed explicitly. Nothing here guesses
 * a cutoff — the caller states the window.
 */
import { and, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { getDb } from "../../db";
import { accounts, accountDomains, contactAccountLinks, prospects } from "../../../drizzle/schema";

export interface AssociationUndoPlan {
  since: string;
  applied: boolean;
  /** Accounts the run created (archived when applied). */
  createdAccounts: number;
  /** Of those, how many hold a domain that would go away with them. */
  createdAccountsWithDomain: number;
  /** People the run attached to a company (detached when applied). */
  peopleUnlinked: number;
  /** Link rows removed. */
  linksRemoved: number;
  /** A look at what is being archived, for eyeballing before applying. */
  sample: Array<{ id: number; name: string; domain: string | null }>;
}

export async function undoAssociationRun(
  workspaceId: number,
  opts: { since: Date; apply?: boolean },
): Promise<AssociationUndoPlan> {
  const plan: AssociationUndoPlan = {
    since: opts.since.toISOString(), applied: false,
    createdAccounts: 0, createdAccountsWithDomain: 0, peopleUnlinked: 0, linksRemoved: 0, sample: [],
  };
  const db = await getDb();
  if (!db) return plan;

  // 1. Accounts this run created. sourceType alone is not enough — earlier
  //    imports use the same value — so the time window is what scopes it.
  const created = await db
    .select({ id: accounts.id, name: accounts.name, domain: accounts.domain })
    .from(accounts)
    .where(and(
      eq(accounts.workspaceId, workspaceId),
      isNull(accounts.archivedAt),
      gte(accounts.createdAt, opts.since),
      eq(accounts.sourceType, "prospect_import"),
    ));
  plan.createdAccounts = created.length;
  plan.createdAccountsWithDomain = created.filter((a) => a.domain).length;
  plan.sample = created.slice(0, 8).map((a) => ({ id: a.id, name: a.name, domain: a.domain }));
  const createdIds = created.map((a) => a.id);

  // 2. Everyone the run linked — to a created account OR to one that already
  //    existed. The link row's own timestamp is the honest record of that.
  const links = await db
    .select({ id: contactAccountLinks.id, personType: contactAccountLinks.personType, personId: contactAccountLinks.personId })
    .from(contactAccountLinks)
    .where(and(
      eq(contactAccountLinks.workspaceId, workspaceId),
      gte(contactAccountLinks.createdAt, opts.since),
    ));
  plan.linksRemoved = links.length;
  const prospectIds = Array.from(new Set(links.filter((l) => l.personType === "prospect").map((l) => l.personId)));
  plan.peopleUnlinked = prospectIds.length;

  if (!opts.apply) return plan;
  plan.applied = true;

  // 3. Detach the people first, so nothing points at an account mid-archive.
  for (let i = 0; i < prospectIds.length; i += 200) {
    const chunk = prospectIds.slice(i, i + 200);
    await db.update(prospects)
      .set({ accountId: null, globalOrganizationId: null, companyMatchStatus: null } as never)
      .where(and(eq(prospects.workspaceId, workspaceId), inArray(prospects.id, chunk)));
  }
  // Anything still pointing at an account we are about to archive.
  for (let i = 0; i < createdIds.length; i += 200) {
    const chunk = createdIds.slice(i, i + 200);
    await db.update(prospects)
      .set({ accountId: null, globalOrganizationId: null, companyMatchStatus: null } as never)
      .where(and(eq(prospects.workspaceId, workspaceId), inArray(prospects.accountId, chunk)));
  }

  // 4. Drop the link rows the run made.
  await db.delete(contactAccountLinks).where(and(
    eq(contactAccountLinks.workspaceId, workspaceId),
    gte(contactAccountLinks.createdAt, opts.since),
  ));

  // 5. Archive the created accounts and drop their domain rows.
  for (let i = 0; i < createdIds.length; i += 200) {
    const chunk = createdIds.slice(i, i + 200);
    await db.delete(accountDomains).where(and(
      eq(accountDomains.workspaceId, workspaceId), inArray(accountDomains.accountId, chunk)));
    await db.update(accounts)
      .set({ archivedAt: sql`CURRENT_TIMESTAMP` } as never)
      .where(and(eq(accounts.workspaceId, workspaceId), inArray(accounts.id, chunk)));
  }

  return plan;
}
