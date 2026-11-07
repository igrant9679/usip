/**
 * recipientZone.ts — the time zone an enrolment's steps come due in (audit
 * 2026-10-20, F18), read from the database for the engine and the Contacts
 * tab. The rule itself is @shared/recipientTime.
 *
 * A prospect enrolment reads its People row; a contact reads the People row
 * it is linked to (contacts keep only a city); a lead has no location, so it
 * keeps the sequence's zone.
 */
import { and, eq, inArray } from "drizzle-orm";
import { contacts, prospects } from "../../drizzle/schema";
import { recipientZone, type ZoneSource } from "@shared/recipientTime";

type Db = any;
type Who = { contactId?: number | null; leadId?: number | null; prospectId?: number | null };
type Place = { timezone: string | null; state: string | null; country: string | null };

/** "Send in each person's time zone" is on for this sequence (off unless set). */
export function sequenceUsesRecipientTime(settings: unknown): boolean {
  return !!settings && typeof settings === "object" && (settings as { recipientTime?: unknown }).recipientTime === true;
}

/** The People rows behind these enrolments, read in two queries at most. */
async function placesFor(db: Db, workspaceId: number, who: Who[]): Promise<{ personOf: (w: Who) => number | null; place: Map<number, Place> }> {
  const contactIds = Array.from(new Set(who.map((w) => w.contactId).filter((v): v is number => !!v)));
  const contactPerson = new Map<number, number>();
  if (contactIds.length) {
    const rows = await db.select({ id: contacts.id, person: contacts.personProspectId }).from(contacts)
      .where(and(eq(contacts.workspaceId, workspaceId), inArray(contacts.id, contactIds)));
    for (const r of rows) if (r.person) contactPerson.set(Number(r.id), Number(r.person));
  }
  const personOf = (w: Who) => (w.prospectId ? Number(w.prospectId) : w.contactId ? contactPerson.get(Number(w.contactId)) ?? null : null);
  const personIds = Array.from(new Set(who.map(personOf).filter((v): v is number => !!v)));
  const place = new Map<number, Place>();
  if (personIds.length) {
    const rows = await db.select({ id: prospects.id, timezone: prospects.timezone, state: prospects.state, country: prospects.country }).from(prospects)
      .where(and(eq(prospects.workspaceId, workspaceId), inArray(prospects.id, personIds)));
    for (const r of rows) place.set(Number(r.id), { timezone: r.timezone ?? null, state: r.state ?? null, country: r.country ?? null });
  }
  return { personOf, place };
}

/** The zone one enrolment's steps come due in, with recipient time on. */
export async function enrollmentRecipientZone(db: Db, workspaceId: number, who: Who, sequenceZone: string): Promise<{ zone: string; source: ZoneSource }> {
  try {
    const { personOf, place } = await placesFor(db, workspaceId, [who]);
    const id = personOf(who);
    return recipientZone(id ? place.get(id) ?? null : null, sequenceZone);
  } catch (e) {
    // A failed read keeps the sequence's zone: the step still comes due inside a window.
    console.warn("[recipientZone] lookup failed:", (e as Error)?.message ?? e);
    return recipientZone(null, sequenceZone);
  }
}

/** The same, for many enrolments at once (the Contacts tab). */
export async function enrollmentRecipientZones(db: Db, workspaceId: number, who: Array<Who & { id: number }>, sequenceZone: string): Promise<Map<number, { zone: string; source: ZoneSource }>> {
  const out = new Map<number, { zone: string; source: ZoneSource }>();
  const { personOf, place } = await placesFor(db, workspaceId, who);
  for (const w of who) {
    const id = personOf(w);
    out.set(w.id, recipientZone(id ? place.get(id) ?? null : null, sequenceZone));
  }
  return out;
}
