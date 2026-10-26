/**
 * contactMerge.ts — merge a duplicate CRM contact into the one that survives
 * (audit 2026-10-20, P9).
 *
 * 🔴 THE BUG. Data Health's merge moved three things (activities, drafts,
 * enrolments) and the deal roles, then HARD-DELETED the duplicate. Its tasks,
 * email log, replies, suppressions, proposals, meetings, notes, files, list
 * memberships and the People record linked to it all kept pointing at an id
 * that no longer existed — the suppression link included, so a person who
 * had opted out could be mailed again through the surviving record. There
 * was no audit and no transaction, any rep could run it, and merging a
 * contact with itself deleted it.
 *
 * Now: admin only (the router), never into itself, every reference below is
 * re-pointed in one transaction before the delete, duplicates a re-point
 * would create (the same deal role, list, or live enrolment twice) are
 * collapsed, and the deleted row is written to the audit log first.
 */
import { TRPCError } from "@trpc/server";
import { and, eq, getTableName, inArray } from "drizzle-orm";
import {
  activities, aiPipelineJobs, attachments, auditLog, calendarEvents, contactAccountLinks, contacts, crmNotes,
  emailDrafts, emailLog, emailReplies, emailSuppressions, enrollments, leads, meetings, opportunityContactRoles,
  proposals, prospectQueue, prospects, recordFiles, recordListMembers, researchPipelines, tasks, unipileInvites,
  unipileMessages, voiceCalls, websiteVisits,
} from "../../drizzle/schema";
import type { getDb } from "../db";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

/** Columns that hold a contact id, by table. Exported so a test can hold the list against the schema. */
export const CONTACT_REF_COLUMNS = [
  { table: emailDrafts, col: emailDrafts.toContactId, ws: emailDrafts.workspaceId, key: "toContactId" },
  { table: emailLog, col: emailLog.contactId, ws: emailLog.workspaceId, key: "contactId" },
  { table: emailReplies, col: emailReplies.contactId, ws: emailReplies.workspaceId, key: "contactId" },
  { table: emailSuppressions, col: emailSuppressions.contactId, ws: emailSuppressions.workspaceId, key: "contactId" },
  { table: leads, col: leads.convertedContactId, ws: leads.workspaceId, key: "convertedContactId" },
  { table: proposals, col: proposals.contactId, ws: proposals.workspaceId, key: "contactId" },
  { table: aiPipelineJobs, col: aiPipelineJobs.contactId, ws: aiPipelineJobs.workspaceId, key: "contactId" },
  { table: researchPipelines, col: researchPipelines.toContactId, ws: researchPipelines.workspaceId, key: "toContactId" },
  { table: websiteVisits, col: websiteVisits.contactId, ws: websiteVisits.workspaceId, key: "contactId" },
  { table: prospectQueue, col: prospectQueue.linkedContactId, ws: prospectQueue.workspaceId, key: "linkedContactId" },
  { table: unipileInvites, col: unipileInvites.linkedContactId, ws: unipileInvites.workspaceId, key: "linkedContactId" },
  { table: unipileMessages, col: unipileMessages.linkedContactId, ws: unipileMessages.workspaceId, key: "linkedContactId" },
  // The People record (migration 0160) linked to this contact.
  { table: prospects, col: prospects.linkedContactId, ws: prospects.workspaceId, key: "linkedContactId" },
] as const;

/** Rows that name a contact through relatedType/relatedId (or entityType/entityId). */
export const CONTACT_POLY_REFS = [
  { table: tasks, type: tasks.relatedType, id: tasks.relatedId, ws: tasks.workspaceId, idKey: "relatedId" },
  { table: activities, type: activities.relatedType, id: activities.relatedId, ws: activities.workspaceId, idKey: "relatedId" },
  { table: meetings, type: meetings.relatedType, id: meetings.relatedId, ws: meetings.workspaceId, idKey: "relatedId" },
  { table: attachments, type: attachments.relatedType, id: attachments.relatedId, ws: attachments.workspaceId, idKey: "relatedId" },
  { table: recordFiles, type: recordFiles.relatedType, id: recordFiles.relatedId, ws: recordFiles.workspaceId, idKey: "relatedId" },
  { table: calendarEvents, type: calendarEvents.relatedType, id: calendarEvents.relatedId, ws: calendarEvents.workspaceId, idKey: "relatedId" },
  { table: voiceCalls, type: voiceCalls.relatedType, id: voiceCalls.relatedId, ws: voiceCalls.workspaceId, idKey: "relatedId" },
  { table: crmNotes, type: crmNotes.entityType, id: crmNotes.entityId, ws: crmNotes.workspaceId, idKey: "entityId" },
] as const;

/** Fields the survivor takes from the duplicate when its own is blank (or when asked to). */
export const CONTACT_FILLABLE = ["title", "phone", "linkedinUrl", "city", "seniority", "accountId"] as const;

const affected = (r: unknown) => Number((r as any)?.[0]?.affectedRows ?? (r as any)?.affectedRows ?? 0);
const blank = (v: unknown) => v === null || v === undefined || v === "";

export async function mergeContacts(
  db: Db,
  workspaceId: number,
  input: { primaryId: number; secondaryId: number; overrideFields?: string[]; actorUserId: number },
): Promise<{ primaryId: number; mergedFields: string[]; moved: Record<string, number> }> {
  const { primaryId, secondaryId } = input;
  if (primaryId === secondaryId) throw new TRPCError({ code: "BAD_REQUEST", message: "A contact cannot be merged into itself." });
  const ws = workspaceId;
  const [primary] = await db.select().from(contacts).where(and(eq(contacts.id, primaryId), eq(contacts.workspaceId, ws)));
  const [secondary] = await db.select().from(contacts).where(and(eq(contacts.id, secondaryId), eq(contacts.workspaceId, ws)));
  if (!primary || !secondary) throw new TRPCError({ code: "NOT_FOUND", message: "One or both contacts not found" });

  const overrides = new Set(input.overrideFields ?? []);
  const patch: Record<string, unknown> = {};
  for (const field of CONTACT_FILLABLE) {
    const pVal = (primary as any)[field];
    const sVal = (secondary as any)[field];
    if (blank(sVal)) continue;
    if (overrides.has(field) || blank(pVal)) patch[field] = sVal;
  }

  return db.transaction(async (tx) => {
    // The deleted row is recorded first; if that fails, nothing changes.
    await tx.insert(auditLog).values({
      workspaceId: ws, actorUserId: input.actorUserId, action: "delete", entityType: "contact_merge", entityId: primaryId,
      before: secondary as never, after: { survivorId: primaryId, mergedId: secondaryId, filled: Object.keys(patch) } as never,
      ip: null, userAgent: null,
    } as never);

    if (Object.keys(patch).length > 0) {
      await tx.update(contacts).set(patch as never).where(and(eq(contacts.id, primaryId), eq(contacts.workspaceId, ws)));
    }

    const moved: Record<string, number> = {};
    for (const ref of CONTACT_REF_COLUMNS) {
      const r = await tx.update(ref.table).set({ [ref.key]: primaryId } as never).where(and(eq(ref.ws, ws), eq(ref.col, secondaryId)));
      moved[getTableName(ref.table)] = affected(r);
    }
    for (const ref of CONTACT_POLY_REFS) {
      const r = await tx.update(ref.table).set({ [ref.idKey]: primaryId } as never)
        .where(and(eq(ref.ws, ws), eq(ref.type, "contact"), eq(ref.id, secondaryId)));
      moved[getTableName(ref.table)] = affected(r);
    }
    moved.contact_account_links = affected(await tx.update(contactAccountLinks).set({ personId: primaryId } as never)
      .where(and(eq(contactAccountLinks.workspaceId, ws), eq(contactAccountLinks.personType, "contact"), eq(contactAccountLinks.personId, secondaryId))));

    // Deal roles: one per deal.
    const roles = await tx.select({ id: opportunityContactRoles.id, opportunityId: opportunityContactRoles.opportunityId }).from(opportunityContactRoles)
      .where(and(eq(opportunityContactRoles.workspaceId, ws), eq(opportunityContactRoles.contactId, secondaryId)));
    for (const role of roles) {
      const [existing] = await tx.select({ id: opportunityContactRoles.id }).from(opportunityContactRoles)
        .where(and(eq(opportunityContactRoles.workspaceId, ws), eq(opportunityContactRoles.opportunityId, role.opportunityId), eq(opportunityContactRoles.contactId, primaryId))).limit(1);
      if (existing) await tx.delete(opportunityContactRoles).where(and(eq(opportunityContactRoles.id, role.id), eq(opportunityContactRoles.workspaceId, ws)));
      else await tx.update(opportunityContactRoles).set({ contactId: primaryId }).where(and(eq(opportunityContactRoles.id, role.id), eq(opportunityContactRoles.workspaceId, ws)));
    }
    moved.opportunity_contact_roles = roles.length;

    // Lists: one membership per list.
    const members = await tx.select({ id: recordListMembers.id, listId: recordListMembers.listId }).from(recordListMembers)
      .where(and(eq(recordListMembers.workspaceId, ws), eq(recordListMembers.recordType, "contact"), eq(recordListMembers.recordId, secondaryId)));
    for (const m of members) {
      const [already] = await tx.select({ id: recordListMembers.id }).from(recordListMembers)
        .where(and(eq(recordListMembers.workspaceId, ws), eq(recordListMembers.listId, m.listId), eq(recordListMembers.recordType, "contact"), eq(recordListMembers.recordId, primaryId))).limit(1);
      if (already) await tx.delete(recordListMembers).where(and(eq(recordListMembers.id, m.id), eq(recordListMembers.workspaceId, ws)));
      else await tx.update(recordListMembers).set({ recordId: primaryId }).where(and(eq(recordListMembers.id, m.id), eq(recordListMembers.workspaceId, ws)));
    }
    moved.record_list_members = members.length;

    // Enrolments: a person in the same sequence twice would be mailed twice.
    // The duplicate's live enrolment ends where the survivor already has one.
    const live = ["active", "paused"] as const;
    const mine = await tx.select({ sequenceId: enrollments.sequenceId }).from(enrollments)
      .where(and(eq(enrollments.workspaceId, ws), eq(enrollments.contactId, primaryId), inArray(enrollments.status, live as never)));
    const theirs = await tx.select({ id: enrollments.id, sequenceId: enrollments.sequenceId }).from(enrollments)
      .where(and(eq(enrollments.workspaceId, ws), eq(enrollments.contactId, secondaryId)));
    const busy = new Set(mine.map((e) => e.sequenceId));
    for (const e of theirs) {
      await tx.update(enrollments).set({
        contactId: primaryId,
        ...(busy.has(e.sequenceId) ? { status: "exited" } : {}),
      } as never).where(and(eq(enrollments.id, e.id), eq(enrollments.workspaceId, ws)));
    }
    moved.enrollments = theirs.length;

    await tx.delete(contacts).where(and(eq(contacts.id, secondaryId), eq(contacts.workspaceId, ws)));
    return { primaryId, mergedFields: Object.keys(patch), moved };
  });
}
