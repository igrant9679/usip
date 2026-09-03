/**
 * crossEngineEnrollment — the ONE place the two outreach engines look at
 * each other before a manual enrollment.
 *
 * Velocity has two engines that can mail the same human: ARE campaigns
 * (prospect_queue → are_execution_queue, per-person AI copy) and CRM
 * Sequences (enrollments, one template to everyone). Until 2026-09-02 they
 * shared no code and no check: pushExisting only asked the ARE's own
 * identity index, bulkEnroll only asked the enrollments table, and a person
 * could be in both at once with neither engine aware (seams audit, cause 2).
 *
 * Both manual entry points now call these before inserting. Automated paths
 * (discovery, segment rules, forms) keep their own gates — this module is
 * deliberately about the human "Add to…" act, where a clear skip reason is
 * worth more than a silent dedupe.
 */
import { and, eq, inArray, or, isNull, isNotNull, sql } from "drizzle-orm";
import { getDb } from "../db";
import { enrollments, sequences, prospectQueue, areCampaigns, contacts, leads, prospects } from "../../drizzle/schema";

/** Queue statuses that mean "the ARE is currently working this person". */
export const ACTIVE_QUEUE_STATUSES = ["pending", "approved", "enrolled", "paused"] as const;
/** Enrollment statuses that mean "a sequence is currently working this person". */
export const ACTIVE_ENROLLMENT_STATUSES = ["active", "paused"] as const;

export interface ActiveSequenceHit { sequenceId: number; sequenceName: string; status: string; currentStep: number }
export interface ActiveCampaignHit { campaignId: number; campaignName: string; sequenceStatus: string; queueId: number }

/**
 * For a set of People ids, which are in an ACTIVE sequence right now — by
 * prospect id, by the linked contact/lead ids, or by email (a promoted
 * person is a new row with a new id; the email is the human).
 */
export async function activeSequencesForProspects(
  workspaceId: number,
  prospectIds: number[],
): Promise<Map<number, ActiveSequenceHit[]>> {
  const out = new Map<number, ActiveSequenceHit[]>();
  const db = await getDb();
  if (!db || prospectIds.length === 0) return out;

  const people = await db
    .select({ id: prospects.id, email: prospects.email, linkedContactId: prospects.linkedContactId, linkedLeadId: prospects.linkedLeadId })
    .from(prospects)
    .where(and(eq(prospects.workspaceId, workspaceId), inArray(prospects.id, prospectIds)));
  if (people.length === 0) return out;

  const contactIds = people.map((p) => p.linkedContactId).filter((x): x is number => x != null);
  const leadIds = people.map((p) => p.linkedLeadId).filter((x): x is number => x != null);
  const emails = people.map((p) => (p.email ?? "").trim().toLowerCase()).filter(Boolean);

  const rows = await db
    .select({
      sequenceId: enrollments.sequenceId,
      sequenceName: sequences.name,
      status: enrollments.status,
      currentStep: enrollments.currentStep,
      prospectId: enrollments.prospectId,
      contactId: enrollments.contactId,
      leadId: enrollments.leadId,
      contactEmail: contacts.email,
      leadEmail: leads.email,
      viaProspectEmail: prospects.email,
    })
    .from(enrollments)
    .innerJoin(sequences, eq(sequences.id, enrollments.sequenceId))
    .leftJoin(contacts, eq(contacts.id, enrollments.contactId))
    .leftJoin(leads, eq(leads.id, enrollments.leadId))
    .leftJoin(prospects, eq(prospects.id, enrollments.prospectId))
    .where(and(
      eq(enrollments.workspaceId, workspaceId),
      inArray(enrollments.status, [...ACTIVE_ENROLLMENT_STATUSES]),
      or(
        inArray(enrollments.prospectId, prospectIds),
        contactIds.length ? inArray(enrollments.contactId, contactIds) : sql`false`,
        leadIds.length ? inArray(enrollments.leadId, leadIds) : sql`false`,
        emails.length ? inArray(contacts.email, emails) : sql`false`,
        emails.length ? inArray(leads.email, emails) : sql`false`,
        emails.length ? inArray(prospects.email, emails) : sql`false`,
      ),
    ));

  const byEmail = new Map<string, number[]>();
  for (const p of people) {
    const e = (p.email ?? "").trim().toLowerCase();
    if (e) byEmail.set(e, [...(byEmail.get(e) ?? []), p.id]);
  }
  const byContact = new Map(people.filter((p) => p.linkedContactId).map((p) => [p.linkedContactId!, p.id]));
  const byLead = new Map(people.filter((p) => p.linkedLeadId).map((p) => [p.linkedLeadId!, p.id]));

  const push = (pid: number, hit: ActiveSequenceHit) => {
    const cur = out.get(pid) ?? [];
    if (!cur.some((h) => h.sequenceId === hit.sequenceId)) out.set(pid, [...cur, hit]);
  };
  for (const r of rows) {
    const hit: ActiveSequenceHit = { sequenceId: r.sequenceId, sequenceName: r.sequenceName, status: r.status, currentStep: r.currentStep };
    const targets = new Set<number>();
    if (r.prospectId && prospectIds.includes(r.prospectId)) targets.add(r.prospectId);
    if (r.contactId && byContact.has(r.contactId)) targets.add(byContact.get(r.contactId)!);
    if (r.leadId && byLead.has(r.leadId)) targets.add(byLead.get(r.leadId)!);
    for (const e of [r.contactEmail, r.leadEmail, r.viaProspectEmail]) {
      const k = (e ?? "").trim().toLowerCase();
      if (k && byEmail.has(k)) for (const pid of byEmail.get(k)!) targets.add(pid);
    }
    for (const pid of Array.from(targets)) push(pid, hit);
  }
  return out;
}

/**
 * For a set of People ids, which are in an ACTIVE ARE campaign right now —
 * by the queue's back-link (personProspectId) or by email.
 */
export async function activeCampaignsForProspects(
  workspaceId: number,
  prospectIds: number[],
): Promise<Map<number, ActiveCampaignHit[]>> {
  const out = new Map<number, ActiveCampaignHit[]>();
  const db = await getDb();
  if (!db || prospectIds.length === 0) return out;

  const people = await db
    .select({ id: prospects.id, email: prospects.email })
    .from(prospects)
    .where(and(eq(prospects.workspaceId, workspaceId), inArray(prospects.id, prospectIds)));
  const emails = people.map((p) => (p.email ?? "").trim().toLowerCase()).filter(Boolean);
  const byEmail = new Map<string, number[]>();
  for (const p of people) {
    const e = (p.email ?? "").trim().toLowerCase();
    if (e) byEmail.set(e, [...(byEmail.get(e) ?? []), p.id]);
  }

  const rows = await db
    .select({
      queueId: prospectQueue.id,
      campaignId: prospectQueue.campaignId,
      campaignName: areCampaigns.name,
      sequenceStatus: prospectQueue.sequenceStatus,
      personProspectId: prospectQueue.personProspectId,
      email: prospectQueue.email,
    })
    .from(prospectQueue)
    .innerJoin(areCampaigns, eq(areCampaigns.id, prospectQueue.campaignId))
    .where(and(
      eq(prospectQueue.workspaceId, workspaceId),
      inArray(prospectQueue.sequenceStatus, [...ACTIVE_QUEUE_STATUSES]),
      or(
        inArray(prospectQueue.personProspectId, prospectIds),
        emails.length ? inArray(prospectQueue.email, emails) : sql`false`,
      ),
    ));

  const push = (pid: number, hit: ActiveCampaignHit) => {
    const cur = out.get(pid) ?? [];
    if (!cur.some((h) => h.campaignId === hit.campaignId)) out.set(pid, [...cur, hit]);
  };
  for (const r of rows) {
    const hit: ActiveCampaignHit = { campaignId: r.campaignId, campaignName: r.campaignName, sequenceStatus: r.sequenceStatus, queueId: r.queueId };
    const targets = new Set<number>();
    if (r.personProspectId && prospectIds.includes(r.personProspectId)) targets.add(r.personProspectId);
    const k = (r.email ?? "").trim().toLowerCase();
    if (k && byEmail.has(k)) for (const pid of byEmail.get(k)!) targets.add(pid);
    for (const pid of Array.from(targets)) push(pid, hit);
  }
  return out;
}

/**
 * Resolve contacts and leads to their People rows (creating the mirror when
 * none exists) so any person type can enter an ARE campaign. Returns the
 * People ids plus the ones that could not be resolved.
 */
export async function resolveToPeopleIds(
  workspaceId: number,
  input: { prospectIds?: number[]; contactIds?: number[]; leadIds?: number[] },
): Promise<{ prospectIds: number[]; unresolved: Array<{ type: "contact" | "lead"; id: number }> }> {
  const db = await getDb();
  const ids = new Set<number>(input.prospectIds ?? []);
  const unresolved: Array<{ type: "contact" | "lead"; id: number }> = [];
  if (!db) return { prospectIds: Array.from(ids), unresolved };

  if (input.contactIds?.length) {
    const rows = await db.select().from(contacts)
      .where(and(eq(contacts.workspaceId, workspaceId), inArray(contacts.id, input.contactIds)));
    const { upsertPersonForContact } = await import("./personLink");
    for (const c of rows) {
      if (c.personProspectId) { ids.add(c.personProspectId); continue; }
      const r = await upsertPersonForContact(workspaceId, {
        id: c.id, firstName: c.firstName, lastName: c.lastName, email: c.email,
        linkedinUrl: (c as any).linkedinUrl ?? null, phone: (c as any).phone ?? null,
        title: (c as any).title ?? null, companyName: (c as any).companyName ?? (c as any).company ?? null,
        companyDomain: (c as any).companyDomain ?? null,
      } as any);
      if (r?.personId) ids.add(r.personId); else unresolved.push({ type: "contact", id: c.id });
    }
  }
  if (input.leadIds?.length) {
    const { bridgeLeadToRecords } = await import("./leadBridge");
    for (const leadId of input.leadIds) {
      const r = await bridgeLeadToRecords(workspaceId, leadId);
      if (r.prospectId) ids.add(r.prospectId); else unresolved.push({ type: "lead", id: leadId });
    }
  }
  return { prospectIds: Array.from(ids), unresolved };
}

// Re-exported so callers that only need the null-guards import one module.
export { isNull, isNotNull };
