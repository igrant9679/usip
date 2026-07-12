/**
 * voiceCrmLink.ts — ties Grok voice-agent calls to CRM records.
 *
 * matchCallerToRecord: resolves an inbound caller number to a contact, lead
 * or prospect (in that priority) by comparing digit-normalized phone numbers
 * (suffix match, ≥7 digits, prefer 10). Formats in the DB vary ("+1 (555)
 * 010-1234" vs "5550101234") so matching happens in JS over the workspace's
 * phone-bearing rows — small sets in practice.
 *
 * logCallActivity: writes the finished call onto the matched record's
 * timeline as a real `call` activity (disposition/duration/outcome), so an
 * AI-answered call-back reads like any other logged call.
 */
import { and, eq, isNotNull } from "drizzle-orm";
import { activities, contacts, leads, prospects, voiceCalls } from "../../drizzle/schema";
import { getDb } from "../db";

export type CallerMatch = { relatedType: "contact" | "lead" | "prospect"; relatedId: number; name: string };

function digits(v: string | null | undefined): string {
  return (v ?? "").replace(/\D/g, "");
}

/** Suffix-compare two digit strings; 10-digit match beats 7-digit. */
function phoneScore(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a.length >= 10 && b.length >= 10 && a.slice(-10) === b.slice(-10)) return 10;
  if (a.length >= 7 && b.length >= 7 && a.slice(-7) === b.slice(-7)) return 7;
  return 0;
}

export async function matchCallerToRecord(workspaceId: number, rawCaller: string | null | undefined): Promise<CallerMatch | null> {
  const caller = digits(rawCaller);
  if (caller.length < 7) return null;
  const db = await getDb();
  if (!db) return null;

  const pools: Array<{ type: CallerMatch["relatedType"]; rows: Array<{ id: number; phone: string | null; name: string }> }> = [];

  const contactRows = await db
    .select({ id: contacts.id, phone: contacts.phone, firstName: contacts.firstName, lastName: contacts.lastName })
    .from(contacts)
    .where(and(eq(contacts.workspaceId, workspaceId), isNotNull(contacts.phone)));
  pools.push({ type: "contact", rows: contactRows.map((r) => ({ id: r.id, phone: r.phone, name: `${r.firstName ?? ""} ${r.lastName ?? ""}`.trim() })) });

  const leadRows = await db
    .select({ id: leads.id, phone: leads.phone, firstName: leads.firstName, lastName: leads.lastName })
    .from(leads)
    .where(and(eq(leads.workspaceId, workspaceId), isNotNull(leads.phone)));
  pools.push({ type: "lead", rows: leadRows.map((r) => ({ id: r.id, phone: r.phone, name: `${r.firstName ?? ""} ${r.lastName ?? ""}`.trim() })) });

  const prospectRows = await db
    .select({ id: prospects.id, phone: prospects.phone, firstName: prospects.firstName, lastName: prospects.lastName })
    .from(prospects)
    .where(and(eq(prospects.workspaceId, workspaceId), isNotNull(prospects.phone)));
  pools.push({ type: "prospect", rows: prospectRows.map((r) => ({ id: r.id, phone: r.phone, name: `${r.firstName ?? ""} ${r.lastName ?? ""}`.trim() })) });

  let best: (CallerMatch & { score: number }) | null = null;
  for (const pool of pools) {
    for (const row of pool.rows) {
      const score = phoneScore(caller, digits(row.phone));
      // contact > lead > prospect on equal score (pools iterate in priority order)
      if (score > 0 && (!best || score > best.score)) {
        best = { relatedType: pool.type, relatedId: row.id, name: row.name || "Unnamed", score };
      }
    }
    if (best?.score === 10) break; // exact-enough match in a higher-priority pool
  }
  return best ? { relatedType: best.relatedType, relatedId: best.relatedId, name: best.name } : null;
}

/**
 * Log a finished agent call onto its matched record's timeline. No-op when
 * the call never matched a record (activities.relatedType is NOT NULL).
 */
export async function logCallActivity(callRowId: number, agentName: string): Promise<void> {
  const db = await getDb();
  if (!db) return;
  const [call] = await db.select().from(voiceCalls).where(eq(voiceCalls.id, callRowId)).limit(1);
  if (!call?.relatedType || !call.relatedId) return;
  // enum-safe values only: activities.type "call"; disposition from the fixed set.
  const disposition = call.status === "completed" ? "connected" : call.status === "no_answer" ? "no_answer" : null;
  await db.insert(activities).values({
    workspaceId: call.workspaceId,
    type: "call",
    relatedType: call.relatedType,
    relatedId: call.relatedId,
    subject: `${call.direction === "inbound" ? "Inbound call-back" : "Outbound call"} answered by AI agent ${agentName}`,
    body: call.outcome ?? null,
    ...(disposition ? { callDisposition: disposition as never } : {}),
    callDurationSec: call.durationSec ?? null,
    callOutcome: call.outcome ? call.outcome.slice(0, 4000) : null,
    actorUserId: call.userId ?? null,
    occurredAt: call.startedAt ?? new Date(),
  });
}
