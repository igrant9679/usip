/**
 * Old contact-type members of People lists, resolved to People (audit
 * 2026-10-20, A55).
 *
 * A People list shows its prospects (services/listMembers.ts, memberConds),
 * and addMembers now takes nothing else. Clients from before that rule added
 * CRM contacts to People lists as `record_type = 'contact'`, so those members
 * were on the list and never shown — on the list page or in the Add-existing
 * wizard's "From a list" source, which reads the same page. Each one is
 * resolved through the one contact → person resolver (`resolveToPeopleIds`,
 * which creates the People mirror when none exists) and the membership row
 * is pointed at the person:
 *
 *   - resolved, person not yet on the list  → the row becomes a prospect member
 *   - resolved, person already on the list   → the contact row is removed; the
 *     person stays on the list once (two rows would show them twice)
 *   - not resolved (the contact is gone, or has nothing to make a person
 *     from) → the row is KEPT as it is, and reported. Nothing is dropped.
 *
 * Idempotent: a converted row is no longer a contact row, so a second run
 * finds only what it could not resolve before. Runs once after each boot,
 * and on demand from the list page, which shows how many are left.
 */
import { and, asc, eq, ne, type SQL } from "drizzle-orm";
import { recordListMembers, recordLists } from "../../drizzle/schema";
import { getDb } from "../db";
import { resolveToPeopleIds } from "./crossEngineEnrollment";

export type UnresolvedContactMember = {
  workspaceId: number;
  listId: number;
  memberId: number;
  contactId: number;
  reason: "contact_missing" | "no_identity";
};

export interface ContactMemberReport {
  scanned: number;
  converted: number;
  duplicates: number;
  unresolved: UnresolvedContactMember[];
}

/** What the list page says about one that stays. */
export const UNRESOLVED_REASON_LABEL: Record<UnresolvedContactMember["reason"], string> = {
  contact_missing: "the contact no longer exists",
  no_identity: "the contact has no name, email or LinkedIn to make a person from",
};

/** One pass caps at this many contact members; the next run takes the rest. */
export const CONTACT_MEMBER_BATCH = 2000;

export async function resolveContactListMembers(opts: { workspaceId?: number; listId?: number; limit?: number; skipWorkspaces?: Set<number> } = {}): Promise<ContactMemberReport> {
  const report: ContactMemberReport = { scanned: 0, converted: 0, duplicates: 0, unresolved: [] };
  const db = await getDb();
  if (!db) return report;

  const conds: SQL[] = [eq(recordListMembers.recordType, "contact"), ne(recordLists.entityType, "companies")];
  if (opts.workspaceId != null) conds.push(eq(recordListMembers.workspaceId, opts.workspaceId));
  if (opts.listId != null) conds.push(eq(recordListMembers.listId, opts.listId));
  const members = await db
    .select({ id: recordListMembers.id, workspaceId: recordListMembers.workspaceId, listId: recordListMembers.listId, contactId: recordListMembers.recordId })
    .from(recordListMembers)
    // The list must be the member's own workspace's: a membership filed
    // under another workspace's list is not this pass's to move.
    .innerJoin(recordLists, and(eq(recordLists.id, recordListMembers.listId), eq(recordLists.workspaceId, recordListMembers.workspaceId)))
    .where(and(...conds))
    .orderBy(asc(recordListMembers.id))
    .limit(Math.max(1, opts.limit ?? CONTACT_MEMBER_BATCH));
  report.scanned = members.length;
  if (!members.length) return report;

  const byWs = new Map<number, typeof members>();
  for (const m of members) {
    if (opts.skipWorkspaces?.has(m.workspaceId)) continue;
    byWs.set(m.workspaceId, [...(byWs.get(m.workspaceId) ?? []), m]);
  }

  for (const [ws, rows] of Array.from(byWs.entries())) {
    const contactIds = Array.from(new Set(rows.map((r) => r.contactId)));
    const resolved = await resolveToPeopleIds(ws, { contactIds });
    const failed = new Set(resolved.unresolved.filter((u) => u.type === "contact").map((u) => u.id));

    const byList = new Map<number, typeof rows>();
    for (const r of rows) byList.set(r.listId, [...(byList.get(r.listId) ?? []), r]);

    for (const [listId, listRows] of Array.from(byList.entries())) {
      // One writer per list at a time, as addMembers does (P47): lock the list
      // row, then read who is on it, so a concurrent add can't race this into
      // a duplicate.
      await db.transaction(async (tx) => {
        const [list] = await tx.select({ id: recordLists.id }).from(recordLists)
          .where(and(eq(recordLists.id, listId), eq(recordLists.workspaceId, ws)))
          .for("update");
        if (!list) return;
        const onList = new Set((await tx.select({ rid: recordListMembers.recordId }).from(recordListMembers)
          .where(and(eq(recordListMembers.listId, listId), eq(recordListMembers.workspaceId, ws), eq(recordListMembers.recordType, "prospect"))))
          .map((r) => r.rid));
        for (const m of listRows) {
          const personId = resolved.byContact.get(m.contactId);
          if (!personId) {
            report.unresolved.push({ workspaceId: ws, listId, memberId: m.id, contactId: m.contactId, reason: failed.has(m.contactId) ? "no_identity" : "contact_missing" });
            continue;
          }
          // Still a contact row: a run racing this one has not moved it.
          if (onList.has(personId)) {
            await tx.delete(recordListMembers)
              .where(and(eq(recordListMembers.id, m.id), eq(recordListMembers.workspaceId, ws), eq(recordListMembers.recordType, "contact")));
            report.duplicates++;
          } else {
            await tx.update(recordListMembers).set({ recordType: "prospect", recordId: personId })
              .where(and(eq(recordListMembers.id, m.id), eq(recordListMembers.workspaceId, ws), eq(recordListMembers.recordType, "contact")));
            onList.add(personId);
            report.converted++;
          }
        }
      });
    }
  }
  return report;
}
