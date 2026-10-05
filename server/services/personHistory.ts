/**
 * personHistory.ts — what the team already knows about one person, for the
 * AI phone agent (owner ask 2026-10-05: "Add both the knowledge base and the
 * person's history").
 *
 * Gathered for a People record (prospects.id): the latest emails we sent
 * (drafts and Revenue Engine sends), their genuine replies, their deal and
 * its stage, meetings, earlier AI calls, and the Revenue Engine's research
 * (pain signals, trigger events, news). Each line is cleaned to one short
 * line and the whole is capped: the agent is told to use it to be relevant,
 * not to recite it, and it is fenced as information, never instructions,
 * because replies and research are text strangers wrote.
 *
 * Never throws: a call goes ahead without history rather than not at all.
 */
import { and, desc, eq, inArray, or } from "drizzle-orm";
import {
  areExecutionQueue,
  contacts,
  emailDrafts,
  emailReplies,
  meetings,
  opportunities,
  opportunityContactRoles,
  prospectIntelligence,
  prospectQueue,
  prospects,
  voiceCalls,
} from "../../drizzle/schema";
import { getDb } from "../db";
import { genuineReplyScope } from "./replyScope";
import { cleanFact } from "./voiceCallScript";

export const HISTORY_MAX_CHARS = 3000;

const day = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString().slice(0, 10) : "undated");
const plain = (html: unknown, max: number) => cleanFact(String(html ?? "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " "), max);

/** A JSON research field (array of strings or of objects with a text-ish field) as short phrases. */
export function phrases(v: unknown, max = 3): string[] {
  const arr = Array.isArray(v) ? v : v && typeof v === "object" ? Object.values(v as Record<string, unknown>) : [];
  return arr
    .map((x) => (typeof x === "string" ? x : x && typeof x === "object" ? String((x as any).title ?? (x as any).signal ?? (x as any).text ?? (x as any).summary ?? (x as any).description ?? (x as any).headline ?? "") : ""))
    .map((s) => cleanFact(s, 160))
    .filter(Boolean)
    .slice(0, max);
}

export async function buildPersonHistory(workspaceId: number, prospectId: number): Promise<string> {
  try {
    const db = await getDb();
    if (!db) return "";
    const lines: string[] = [];

    const [person] = await db.select({ linkedContactId: prospects.linkedContactId, accountId: prospects.accountId })
      .from(prospects).where(and(eq(prospects.id, prospectId), eq(prospects.workspaceId, workspaceId))).limit(1);
    if (!person) return "";

    // Emails we sent: drafts addressed to them, and Revenue Engine sends.
    const sent: { at: Date | null; subject: string; body: string }[] = [];
    const drafts = await db.select({ subject: emailDrafts.subject, body: emailDrafts.body, sentAt: emailDrafts.sentAt })
      .from(emailDrafts)
      .where(and(eq(emailDrafts.workspaceId, workspaceId), eq(emailDrafts.toProspectId, prospectId), eq(emailDrafts.status, "sent")))
      .orderBy(desc(emailDrafts.sentAt)).limit(3);
    for (const d of drafts) sent.push({ at: d.sentAt, subject: d.subject ?? "", body: d.body ?? "" });

    const queueRows = await db.select({ id: prospectQueue.id }).from(prospectQueue)
      .where(and(eq(prospectQueue.workspaceId, workspaceId), eq(prospectQueue.personProspectId, prospectId))).limit(20);
    const queueIds = queueRows.map((q) => q.id);
    if (queueIds.length) {
      const areSent = await db.select({ executedAt: areExecutionQueue.executedAt, channel: areExecutionQueue.channel, messageContent: areExecutionQueue.messageContent })
        .from(areExecutionQueue)
        .where(and(eq(areExecutionQueue.workspaceId, workspaceId), inArray(areExecutionQueue.prospectQueueId, queueIds), eq(areExecutionQueue.status, "sent")))
        .orderBy(desc(areExecutionQueue.executedAt)).limit(3);
      for (const a of areSent) {
        const m = (a.messageContent ?? {}) as { subject?: string; body?: string };
        sent.push({ at: a.executedAt, subject: a.channel === "linkedin" ? "LinkedIn message" : m.subject ?? "", body: m.body ?? "" });
      }
    }
    sent.sort((a, b) => new Date(b.at ?? 0).getTime() - new Date(a.at ?? 0).getTime());
    for (const s of sent.slice(0, 3)) {
      lines.push(`We emailed ${day(s.at)}: "${cleanFact(s.subject, 100)}" ${plain(s.body, 160)}`);
    }

    // Their replies: genuine replies only (the table holds every synced inbox message).
    const replies = await db.select({ receivedAt: emailReplies.receivedAt, bodyText: emailReplies.bodyText, replyClass: emailReplies.replyClass })
      .from(emailReplies)
      .where(and(eq(emailReplies.workspaceId, workspaceId), eq(emailReplies.prospectId, prospectId), genuineReplyScope()))
      .orderBy(desc(emailReplies.receivedAt)).limit(3);
    for (const r of replies) {
      lines.push(`They replied ${day(r.receivedAt)}${r.replyClass ? ` (${cleanFact(r.replyClass, 30)})` : ""}: ${plain(r.bodyText, 240)}`);
    }

    // Their deal(s): through the CRM contact made from this person.
    const contactRows = await db.select({ id: contacts.id }).from(contacts)
      .where(and(eq(contacts.workspaceId, workspaceId), or(eq(contacts.personProspectId, prospectId), person.linkedContactId ? eq(contacts.id, person.linkedContactId) : eq(contacts.id, -1))))
      .limit(5);
    const contactIds = contactRows.map((c) => c.id);
    if (contactIds.length) {
      const roles = await db.select({ opportunityId: opportunityContactRoles.opportunityId }).from(opportunityContactRoles)
        .where(and(eq(opportunityContactRoles.workspaceId, workspaceId), inArray(opportunityContactRoles.contactId, contactIds))).limit(5);
      const oppIds = Array.from(new Set(roles.map((r) => r.opportunityId)));
      if (oppIds.length) {
        const opps = await db.select({ name: opportunities.name, stage: opportunities.stage, value: opportunities.value, nextStep: opportunities.nextStep })
          .from(opportunities).where(and(eq(opportunities.workspaceId, workspaceId), inArray(opportunities.id, oppIds)))
          .orderBy(desc(opportunities.updatedAt)).limit(2);
        for (const o of opps) {
          lines.push(`Deal: ${cleanFact(o.name, 100)}, stage ${cleanFact(o.stage, 40)}${o.value ? `, value ${cleanFact(o.value, 20)}` : ""}${o.nextStep ? `. Next step: ${cleanFact(o.nextStep, 140)}` : ""}`);
        }
      }
    }

    // Meetings and earlier AI calls.
    const mtgs = await db.select({ title: meetings.title, status: meetings.status, scheduledAt: meetings.scheduledAt })
      .from(meetings).where(and(eq(meetings.workspaceId, workspaceId), eq(meetings.relatedType, "prospect"), eq(meetings.relatedId, prospectId)))
      .orderBy(desc(meetings.createdAt)).limit(3);
    for (const m of mtgs) lines.push(`Meeting ${cleanFact(m.status, 20)}${m.scheduledAt ? ` for ${day(m.scheduledAt)}` : ""}: ${cleanFact(m.title, 100)}`);

    const calls = await db.select({ startedAt: voiceCalls.startedAt, status: voiceCalls.status, result: voiceCalls.result, direction: voiceCalls.direction })
      .from(voiceCalls).where(and(eq(voiceCalls.workspaceId, workspaceId), eq(voiceCalls.relatedType, "prospect"), eq(voiceCalls.relatedId, prospectId), inArray(voiceCalls.status, ["completed", "voicemail", "no_answer", "busy"])))
      .orderBy(desc(voiceCalls.startedAt)).limit(2);
    for (const c of calls) lines.push(`Earlier AI call ${day(c.startedAt)} (${c.direction}): ${cleanFact(c.result ?? c.status, 30).replace(/_/g, " ")}`);

    // Revenue Engine research.
    if (queueIds.length) {
      const [intel] = await db.select().from(prospectIntelligence)
        .where(and(eq(prospectIntelligence.workspaceId, workspaceId), inArray(prospectIntelligence.prospectQueueId, queueIds)))
        .orderBy(desc(prospectIntelligence.updatedAt)).limit(1);
      if (intel) {
        if (intel.companyOneLiner) lines.push(`Their company: ${cleanFact(intel.companyOneLiner, 200)}`);
        const pains = phrases(intel.painSignals);
        if (pains.length) lines.push(`Likely pain points: ${pains.join("; ")}`);
        const triggers = phrases(intel.triggerEvents);
        if (triggers.length) lines.push(`Recent triggers: ${triggers.join("; ")}`);
        const news = phrases(intel.recentNews, 2);
        if (news.length) lines.push(`In the news: ${news.join("; ")}`);
        const hooks = phrases(intel.personalisationHooks, 2);
        if (hooks.length) lines.push(`Personal hooks: ${hooks.join("; ")}`);
      }
    }

    let out = "";
    for (const l of lines) {
      if (out.length + l.length + 1 > HISTORY_MAX_CHARS) break;
      out += (out ? "\n" : "") + l;
    }
    return out;
  } catch (e) {
    console.error("[PersonHistory] failed:", e);
    return "";
  }
}
