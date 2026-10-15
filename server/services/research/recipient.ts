/**
 * What research needs to know about a recipient: their title and industry
 * (and the ARE campaign, for a queue row). Writers that hold only a contact,
 * lead, prospect or queue id use this to fill a ResearchUse. Every lookup is
 * scoped to the workspace; a missing row just means less to match on.
 */
import { and, desc, eq } from "drizzle-orm";
import { accounts, contacts, leads, proposals, prospectQueue, prospects } from "../../../drizzle/schema";
import { getDb } from "../../db";
import type { ResearchSurface, ResearchUse } from "./context";

export type RecipientRef = {
  contactId?: number | null;
  leadId?: number | null;
  prospectId?: number | null;
  prospectQueueId?: number | null;
  accountId?: number | null;
};

export async function researchUseFor(workspaceId: number, surface: ResearchSurface, ref: RecipientRef): Promise<ResearchUse> {
  const use: ResearchUse = { surface };
  try {
    const db = await getDb();
    if (!db) return use;
    let accountId = ref.accountId ?? null;
    if (ref.prospectQueueId) {
      const [q] = await db
        .select({ title: prospectQueue.title, industry: prospectQueue.industry, campaignId: prospectQueue.campaignId })
        .from(prospectQueue)
        .where(and(eq(prospectQueue.id, ref.prospectQueueId), eq(prospectQueue.workspaceId, workspaceId)))
        .limit(1);
      if (q) { use.prospectTitle = q.title; use.industry = q.industry; use.campaignId = q.campaignId; }
    }
    if (!use.prospectTitle && ref.prospectId) {
      const [p] = await db
        .select({ title: prospects.title, industry: prospects.industry, accountId: prospects.accountId })
        .from(prospects)
        .where(and(eq(prospects.id, ref.prospectId), eq(prospects.workspaceId, workspaceId)))
        .limit(1);
      if (p) { use.prospectTitle = p.title; use.industry ??= p.industry; accountId ??= p.accountId; }
    }
    if (!use.prospectTitle && ref.contactId) {
      const [c] = await db
        .select({ title: contacts.title, accountId: contacts.accountId })
        .from(contacts)
        .where(and(eq(contacts.id, ref.contactId), eq(contacts.workspaceId, workspaceId)))
        .limit(1);
      if (c) { use.prospectTitle = c.title; accountId ??= c.accountId; }
    }
    if (!use.prospectTitle && ref.leadId) {
      const [l] = await db
        .select({ title: leads.title })
        .from(leads)
        .where(and(eq(leads.id, ref.leadId), eq(leads.workspaceId, workspaceId)))
        .limit(1);
      if (l) use.prospectTitle = l.title;
    }
    if (!use.industry && accountId) {
      const [a] = await db
        .select({ industry: accounts.industry })
        .from(accounts)
        .where(and(eq(accounts.id, accountId), eq(accounts.workspaceId, workspaceId)))
        .limit(1);
      if (a) use.industry = a.industry;
    }
  } catch {
    // Less to match on, never a failed writer.
  }
  return use;
}

/** A record named by type and id (meetings, workflows, calls) as a recipient reference. */
export function refFromRelated(type: string | null | undefined, id: number | null | undefined): RecipientRef {
  if (id == null) return {};
  switch (type) {
    case "contact": return { contactId: id };
    case "lead": return { leadId: id };
    case "prospect": return { prospectId: id };
    case "account": return { accountId: id };
    default: return {};
  }
}

/* ── By email address (the mailbox, the composer, proposals) ────────────── */

/**
 * The records an email address belongs to in this workspace: the newest
 * campaign prospect (which carries its campaign), the person, the contact and
 * the lead. Empty when it belongs to none.
 */
export async function recipientRefByEmail(workspaceId: number, email: string | null | undefined): Promise<RecipientRef> {
  const e = String(email ?? "").trim().toLowerCase();
  if (!e.includes("@")) return {};
  try {
    const db = await getDb();
    if (!db) return {};
    const [[q], [p], [c], [l]] = await Promise.all([
      db.select({ id: prospectQueue.id }).from(prospectQueue).where(and(eq(prospectQueue.workspaceId, workspaceId), eq(prospectQueue.email, e))).orderBy(desc(prospectQueue.id)).limit(1),
      db.select({ id: prospects.id }).from(prospects).where(and(eq(prospects.workspaceId, workspaceId), eq(prospects.email, e))).limit(1),
      db.select({ id: contacts.id }).from(contacts).where(and(eq(contacts.workspaceId, workspaceId), eq(contacts.email, e))).limit(1),
      db.select({ id: leads.id }).from(leads).where(and(eq(leads.workspaceId, workspaceId), eq(leads.email, e))).limit(1),
    ]);
    const ref: RecipientRef = {};
    if (q) ref.prospectQueueId = q.id;
    if (p) ref.prospectId = p.id;
    if (c) ref.contactId = c.id;
    if (l) ref.leadId = l.id;
    return ref;
  } catch {
    return {};
  }
}

const isEmpty = (ref: RecipientRef) => !Object.values(ref).some((v) => v != null);
const knowsSomething = (use: ResearchUse) => !!(use.prospectTitle || use.industry || use.campaignId != null || use.sectorId != null || use.personaId != null);

/**
 * Research for a recipient: the records named first, then the first of the
 * email addresses that belongs to a record. Nothing found is a bare use,
 * which the composer matches to nothing, so the writer behaves as before.
 */
export async function researchUseForRecipient(
  workspaceId: number,
  surface: ResearchSurface,
  ref: RecipientRef,
  emails: (string | null | undefined)[] = [],
): Promise<ResearchUse> {
  if (!isEmpty(ref)) {
    const use = await researchUseFor(workspaceId, surface, ref);
    if (knowsSomething(use)) return use;
  }
  for (const email of emails) {
    const byEmail = await recipientRefByEmail(workspaceId, email);
    if (isEmpty(byEmail)) continue;
    const use = await researchUseFor(workspaceId, surface, byEmail);
    if (knowsSomething(use)) return use;
  }
  return { surface };
}

/**
 * The other party in a mail thread: whoever last wrote that is not the
 * mailbox itself, else whom the mailbox last wrote to.
 */
export function threadCounterparty(messages: { fromEmail: string; toEmail?: string | null }[], ownEmail: string | null | undefined): string | null {
  const own = String(ownEmail ?? "").trim().toLowerCase();
  const notOwn = (e: string | null | undefined) => !!e && e.trim().toLowerCase() !== own;
  for (let i = messages.length - 1; i >= 0; i--) if (notOwn(messages[i].fromEmail)) return messages[i].fromEmail.trim();
  for (let i = messages.length - 1; i >= 0; i--) if (notOwn(messages[i].toEmail)) return messages[i].toEmail!.trim();
  return null;
}

/** A proposal's client: its linked contact and account, else its client email. Proposals read the "research" view. */
export async function researchUseForProposal(workspaceId: number, proposalId: number): Promise<ResearchUse> {
  try {
    const db = await getDb();
    if (!db) return { surface: "research" };
    const [p] = await db
      .select({ contactId: proposals.contactId, accountId: proposals.accountId, clientEmail: proposals.clientEmail })
      .from(proposals)
      .where(and(eq(proposals.id, proposalId), eq(proposals.workspaceId, workspaceId)))
      .limit(1);
    if (!p) return { surface: "research" };
    return researchUseForRecipient(workspaceId, "research", { contactId: p.contactId, accountId: p.accountId }, [p.clientEmail]);
  } catch {
    return { surface: "research" };
  }
}
