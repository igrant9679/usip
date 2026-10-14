/**
 * What research needs to know about a recipient: their title and industry
 * (and the ARE campaign, for a queue row). Writers that hold only a contact,
 * lead, prospect or queue id use this to fill a ResearchUse. Every lookup is
 * scoped to the workspace; a missing row just means less to match on.
 */
import { and, eq } from "drizzle-orm";
import { accounts, contacts, leads, prospectQueue, prospects } from "../../../drizzle/schema";
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
