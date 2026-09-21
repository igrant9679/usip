/**
 * personContactDuplicates — the ONE human who exists twice, once in People
 * (`prospects`) and once in the CRM (`contacts`), with no link between them.
 *
 * 🔴 WHY THIS EXISTS (2026-09-20). Data Health had two duplicate checks and
 * both were single-table: `getMetrics` counts People that share an email or a
 * name+company, and `getDuplicateGroups` lists CONTACTS that share an email or
 * a name+account. Nothing anywhere joined the two tables on identity, so the
 * commonest real duplicate in the product — Jane in People from a scrape, Jane
 * in contacts from a CSV, `person_prospect_id` null or pointing at a third
 * shell row — was not counted, not listed and not repairable. The owner sees
 * her twice; Data Health reports a clean workspace.
 *
 * READ-ONLY, deliberately: nothing in this file inserts, updates or deletes a
 * row, and a test pins that. The repair is `personLink.upsertPersonForContact`,
 * the one matcher every contact seam already goes through. A detector that
 * also writes is a second matcher, and two matchers disagree.
 *
 * THE REPAIR IS A LINK, NOT A MERGE AND NOT A DELETE. There is no People merge
 * anywhere in the product, so a `needs_merge` row here stays until a human
 * edits it — the count does not drop after the repair, and the UI says so.
 *
 * Two reads, not one. A single join cannot classify: the WHERE that keeps the
 * contact's own person out of the candidate list (`person_prospect_id <>
 * prospects.id`) is exactly what hides the row you need to decide whether the
 * contact is already linked CORRECTLY. So: a bounded candidate scan for ids,
 * then a second pass that fetches the whole picture for those ids — every
 * email-matching People row with NO exclusion, the current person, and the
 * person that already claims the contact — and the classification happens in
 * JS where it can see all three.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { contacts, prospects } from "../../drizzle/schema";
import { getDb } from "../db";
import { usableEmailOrNull } from "@shared/fieldHygiene";
import { isGenericInboxEmail } from "@shared/genericEmail";

/** How many candidate contacts one pass will reason about. Not a page size:
 *  past this the answer stops being "here is every split person" and becomes
 *  "here is what fitted in the scan", which is what `capped` reports. */
export const SCAN_CAP = 500;

export interface PersonContactPair {
  contactId: number;
  contactName: string;
  email: string;
  /** The People row the contact points at today, when it points at one. */
  currentPersonId: number | null;
  currentPersonName: string | null;
  /** The People row the repair would land on — claimant first, then the
   *  lowest-id email match, so this is what `upsertPersonForContact` returns. */
  personId: number;
  personName: string;
  kind: "unlinked" | "relinkable" | "needs_merge";
  reason: string;
}

export interface PersonContactDuplicates {
  /** Pairs found inside the scan — NOT a workspace-wide total when `capped`. */
  total: number;
  /** True when the candidate scan hit SCAN_CAP. A zero from a bounded scan
   *  reads as an all-clear unless the bound is stated. */
  capped: boolean;
  scanned: number;
  /** Candidates dropped because the shared address is a shared inbox. */
  skippedGeneric: number;
  pairs: PersonContactPair[];
}

/** The three facts classification needs about a People row. */
export interface PersonFacts {
  id: number;
  email: string | null;
  linkedContactId: number | null;
}

export interface PairClassification {
  kind: PersonContactPair["kind"];
  reason: string;
  /** The person the repair would land on, or null when there is nothing to
   *  link to (a caller with no candidate and no claimant has no pair). */
  personId: number | null;
}

/**
 * PURE — no DB, so the decision table is unit-testable on its own.
 *
 * `candidates` is every People row in the workspace holding this email,
 * INCLUDING the contact's current person when it shares the address. That
 * inclusion is the whole point: without it a contact that is already linked
 * correctly looks identical to one linked to a shell, and the repair button
 * re-points a correct link onto the duplicate row.
 */
export function classifyPair(p: {
  contactId: number;
  emailKey: string;
  currentPerson: PersonFacts | null;
  /** The People row whose `linkedContactId` already claims this contact —
   *  `upsertPersonForContact`'s fast path, which wins before any matching. */
  claimant: PersonFacts | null;
  candidates: PersonFacts[];
}): PairClassification {
  const personId = p.claimant?.id ?? p.candidates[0]?.id ?? null;

  if (p.candidates.length >= 2) {
    return { kind: "needs_merge", personId, reason: "two People rows share this email — merge them first." };
  }
  if (p.currentPerson && usableEmailOrNull(p.currentPerson.email) === p.emailKey) {
    return { kind: "needs_merge", personId, reason: "already linked correctly; the duplicate is between two People rows." };
  }
  if (p.currentPerson && p.currentPerson.linkedContactId === p.contactId) {
    // Re-pointing would split the promotion pair prospectPromotion writes, and
    // promotion picks which contact to REUSE by person_prospect_id — so the
    // next promotion of either person would pick a different contact.
    return { kind: "needs_merge", personId, reason: "this contact is the promotion pair of another person." };
  }
  if (p.currentPerson === null) {
    return {
      kind: "unlinked",
      personId,
      reason: p.claimant
        ? "not linked, and that person already claims this contact."
        : "not linked, and one People row holds the same email.",
    };
  }
  return { kind: "relinkable", personId, reason: "linked to a People row with no email." };
}

const EMPTY: PersonContactDuplicates = { total: 0, capped: false, scanned: 0, skippedGeneric: 0, pairs: [] };

function nameOf(first: string | null, last: string | null): string {
  return `${first ?? ""} ${last ?? ""}`.trim();
}

/**
 * Find humans who are a People row and a contact row at once.
 *
 * `opts.limit` bounds the PAIRS RETURNED, not the scan — the scan is always
 * SCAN_CAP wide, so `total` means the same thing whether the caller wanted
 * fifty rows for a list or all of them for a re-classification.
 */
export async function findPersonContactDuplicates(
  workspaceId: number,
  opts?: { limit?: number },
): Promise<PersonContactDuplicates> {
  const db = await getDb();
  if (!db) return EMPTY;
  const wsId = workspaceId;

  /*
   * Candidate scan. Plain `eq` on the two email columns, NOT
   * `LOWER(TRIM(...))`: both are varchar(320) in utf8mb4 tables whose default
   * collation is already case-insensitive and PAD SPACE, and wrapping the
   * column in a function is what stops `ix_pro_email` being probed at all.
   * The two existing duplicate checks in dataHealth.ts group by raw `email`
   * for the same reason.
   *
   * cap + 1 so `capped` is a fact rather than a guess — the same trick the
   * name tiers use in personLink.findPersonForRow.
   */
  const candidateRows = await db
    .select({ contactId: contacts.id })
    .from(contacts)
    .innerJoin(prospects, and(
      eq(prospects.workspaceId, wsId),
      eq(prospects.email, contacts.email),
    ))
    .where(and(
      eq(contacts.workspaceId, wsId),
      sql`${contacts.email} IS NOT NULL AND ${contacts.email} <> ''`,
      // Conservative shape prefilter. It never excludes a row
      // usableEmailOrNull() would accept, and it keeps "<UNKNOWN>" and the
      // other placeholder tokens from eating the cap.
      sql`${contacts.email} LIKE '%@%.%'`,
      // NOTE what is NOT here: no `prospects.linked_contact_id <> contacts.id`
      // term. A contact whose person already claims it is the SAFEST repair in
      // the product — the fast path links it with no matching and no merge —
      // so it must be surfaced, not filtered out.
      sql`(${contacts.personProspectId} IS NULL OR ${contacts.personProspectId} <> ${prospects.id})`,
    ))
    .groupBy(contacts.id)
    .orderBy(contacts.id)
    .limit(SCAN_CAP + 1);

  const capped = candidateRows.length > SCAN_CAP;
  const ids = candidateRows.slice(0, SCAN_CAP).map((r) => r.contactId);
  if (ids.length === 0) return { ...EMPTY, capped };

  const contactRows = await db
    .select({
      id: contacts.id,
      firstName: contacts.firstName,
      lastName: contacts.lastName,
      email: contacts.email,
      personProspectId: contacts.personProspectId,
    })
    .from(contacts)
    .where(and(eq(contacts.workspaceId, wsId), inArray(contacts.id, ids)))
    .orderBy(contacts.id);

  const emails: string[] = [];
  const currentPersonIds: number[] = [];
  for (const c of contactRows) {
    if (c.email) emails.push(c.email);
    if (c.personProspectId) currentPersonIds.push(c.personProspectId);
  }

  const personSelect = {
    id: prospects.id,
    firstName: prospects.firstName,
    lastName: prospects.lastName,
    email: prospects.email,
    linkedContactId: prospects.linkedContactId,
  };
  type PersonRow = { id: number; firstName: string | null; lastName: string | null; email: string | null; linkedContactId: number | null };

  // Every People row holding a candidate email, with NO exclusion — the
  // contact's own person appears here when it shares the address, which is how
  // "already linked correctly" stays distinguishable from "linked to a shell".
  const byEmail = new Map<string, PersonRow[]>();
  if (emails.length > 0) {
    const rows = await db
      .select(personSelect)
      .from(prospects)
      .where(and(eq(prospects.workspaceId, wsId), inArray(prospects.email, emails)))
      .orderBy(prospects.id);
    for (const r of rows) {
      const key = usableEmailOrNull(r.email);
      if (!key) continue;
      const bucket = byEmail.get(key);
      if (bucket) bucket.push(r);
      else byEmail.set(key, [r]);
    }
  }

  // The current person, which may hold a different email (or none at all).
  const byId = new Map<number, PersonRow>();
  if (currentPersonIds.length > 0) {
    const rows = await db
      .select(personSelect)
      .from(prospects)
      .where(and(eq(prospects.workspaceId, wsId), inArray(prospects.id, currentPersonIds)));
    for (const r of rows) byId.set(r.id, r);
  }

  // The claimant: the fast path in upsertPersonForContact links to whoever
  // already holds `linkedContactId = contact.id`, before any matching runs. If
  // detection ignored it, every such repair would report a personId mismatch.
  const byClaim = new Map<number, PersonRow>();
  {
    const rows = await db
      .select(personSelect)
      .from(prospects)
      .where(and(eq(prospects.workspaceId, wsId), inArray(prospects.linkedContactId, ids)))
      .orderBy(prospects.id);
    for (const r of rows) {
      if (r.linkedContactId && !byClaim.has(r.linkedContactId)) byClaim.set(r.linkedContactId, r);
    }
  }

  let skippedGeneric = 0;
  const pairs: PersonContactPair[] = [];
  for (const c of contactRows) {
    const key = usableEmailOrNull(c.email);
    // Detection and repair must agree on what an email IS: this is the same
    // shape gate personLink's email tier applies, so a row that passes here
    // cannot fall through to the name tiers and mint a THIRD person.
    if (!key) continue;
    // info@acme.com on five contacts and one People row is five false
    // duplicates, and linking them fuses five humans onto one record.
    if (isGenericInboxEmail(key)) { skippedGeneric++; continue; }

    const candidates = byEmail.get(key) ?? [];
    const claimant = byClaim.get(c.id) ?? null;
    if (candidates.length === 0 && !claimant) continue;
    const currentPerson = c.personProspectId ? byId.get(c.personProspectId) ?? null : null;

    const verdict = classifyPair({
      contactId: c.id,
      emailKey: key,
      currentPerson,
      claimant,
      candidates,
    });
    if (verdict.personId === null) continue;

    const person = claimant && claimant.id === verdict.personId ? claimant : candidates.find((p) => p.id === verdict.personId) ?? claimant;
    pairs.push({
      contactId: c.id,
      contactName: nameOf(c.firstName, c.lastName),
      email: key,
      currentPersonId: currentPerson?.id ?? null,
      currentPersonName: currentPerson ? nameOf(currentPerson.firstName, currentPerson.lastName) : null,
      personId: verdict.personId,
      personName: person ? nameOf(person.firstName, person.lastName) : "",
      kind: verdict.kind,
      reason: verdict.reason,
    });
  }

  const limit = opts?.limit ?? SCAN_CAP;
  return {
    total: pairs.length,
    capped,
    scanned: ids.length,
    skippedGeneric,
    pairs: pairs.slice(0, limit),
  };
}
