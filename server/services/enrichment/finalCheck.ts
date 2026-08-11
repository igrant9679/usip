/**
 * finalCheck — the last record-detail validation before a campaign prospect
 * is enrolled into a sequence.
 *
 * Runs the SAME comprehensive pass every other trigger uses (QuickEnrich +
 * stored LinkedIn profile + pattern+Reoon, reconciled by fieldMerge) on the
 * row's canonical PERSON record — never a parallel validator. LinkedIn
 * participates via the stored profile (the daily check keeps it current);
 * the inline retrieve is deliberately off here (cron context, 100/day cap).
 * LeadRocks participates as import-time evidence already on the record.
 *
 * BEST-EFFORT BY DESIGN: enrollment never blocks on this. The check runs
 * only when the person's email is missing, generic, or unverified, or the
 * record is stale — and the only queue mutation is the email mirror, gated
 * hard on "Reoon-valid AND person-specific AND queue email empty-or-generic".
 */
import { and, eq } from "drizzle-orm";
import { getDb } from "../../db";
import { prospects, prospectQueue } from "../../../drizzle/schema";
import { isGenericInboxEmail } from "@shared/genericEmail";
import { runComprehensiveEnrichment } from "./comprehensivePass";

const STALE_MS = 30 * 86_400_000;

/** Does this person's record justify spending a final check? */
export function personNeedsFinalCheck(person: {
  email: string | null;
  emailStatus: string | null;
  lastEnrichedAt: Date | null;
}): boolean {
  if (!person.email?.trim()) return true;
  if (isGenericInboxEmail(person.email)) return true;
  if (person.emailStatus !== "valid") return true;
  if (!person.lastEnrichedAt) return true;
  return Date.now() - new Date(person.lastEnrichedAt).getTime() > STALE_MS;
}

/** The ONLY condition under which the person's email overwrites the queue
 *  copy: verified person-specific address, and the queue holds nothing
 *  better than empty-or-generic. Returns the email to mirror, or null. */
export function emailToMirror(
  person: { email: string | null; emailStatus: string | null },
  queueEmail: string | null,
): string | null {
  const e = person.email?.trim();
  if (!e || person.emailStatus !== "valid" || isGenericInboxEmail(e)) return null;
  if (queueEmail?.trim() && !isGenericInboxEmail(queueEmail)) return null;
  if (queueEmail?.trim().toLowerCase() === e.toLowerCase()) return null;
  return e;
}

export interface FinalCheckResult {
  ran: boolean;
  mirroredEmail: string | null;
  reason?: string;
}

/**
 * Final-check one queue row via its linked person. Never throws; returns
 * what happened so the engine can log it.
 */
export async function runFinalCheckForQueueRow(
  workspaceId: number,
  queueRowId: number,
): Promise<FinalCheckResult> {
  try {
    const db = await getDb();
    if (!db) return { ran: false, mirroredEmail: null, reason: "db unavailable" };

    const [row] = await db
      .select({ id: prospectQueue.id, email: prospectQueue.email, personProspectId: prospectQueue.personProspectId })
      .from(prospectQueue)
      .where(and(eq(prospectQueue.workspaceId, workspaceId), eq(prospectQueue.id, queueRowId)))
      .limit(1);
    if (!row?.personProspectId) return { ran: false, mirroredEmail: null, reason: "no linked person" };

    const loadPerson = async () => {
      const [p] = await db
        .select({ email: prospects.email, emailStatus: prospects.emailStatus, lastEnrichedAt: prospects.lastEnrichedAt })
        .from(prospects)
        .where(and(eq(prospects.workspaceId, workspaceId), eq(prospects.id, row.personProspectId!)))
        .limit(1);
      return p ?? null;
    };

    let person = await loadPerson();
    if (!person) return { ran: false, mirroredEmail: null, reason: "person missing" };

    let ran = false;
    if (personNeedsFinalCheck({ ...person, lastEnrichedAt: person.lastEnrichedAt ?? null })) {
      // Cron context: userId is only threaded into LinkedIn retrieval/jobs,
      // both disabled via queueLinkedInJob:false — stored profile data still
      // participates in the merge.
      await runComprehensiveEnrichment({
        workspaceId, prospectId: row.personProspectId, userId: 0,
        trigger: "are_final_check", queueLinkedInJob: false,
      });
      ran = true;
      person = (await loadPerson()) ?? person;
    }

    const mirror = emailToMirror(person, row.email);
    if (mirror) {
      await db.update(prospectQueue)
        .set({ email: mirror.slice(0, 320) } as never)
        .where(eq(prospectQueue.id, row.id));
    }
    return { ran, mirroredEmail: mirror };
  } catch (e) {
    console.error(`[finalCheck] queue row ${queueRowId} failed:`, (e as Error)?.message ?? e);
    return { ran: false, mirroredEmail: null, reason: "error" };
  }
}
