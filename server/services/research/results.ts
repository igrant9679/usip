/**
 * Learning from results (Research phase 6). See @shared/researchResults.
 *
 * Recording: researchUseColumns() is spread into the prospect_intelligence
 * update that saves a generated sequence, so the record always describes the
 * copy that is there now. Reading: researchResults() joins those records to
 * sends (are_execution_queue), replies and meetings (are_signal_log), and the
 * reply classifier (email_replies), the same sources the What's Working page
 * counts, so the numbers agree.
 *
 * What counts:
 * - contacted: at least one step sent;
 * - replied: a reply on any channel, unless every reply was an out-of-office;
 * - positive: a reply read as positive, or classified "willing to meet";
 * - meeting: a meeting booked.
 * Only ARE campaign prospects are counted: they are the copy whose research
 * use is recorded and whose sends and replies are tracked per person.
 */
import { and, asc, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { areExecutionQueue, areSignalLog, emailReplies, personas, prospectIntelligence, prospectQueue } from "../../../drizzle/schema";
import { getDb } from "../../db";
import { researchContextFor, type ResearchContext, type ResearchUse } from "./context";
import type { BriefCheck } from "./avoidCheck";
import { loadSector, sectorContentOf, type Db } from "./store";
import { cleanPersonaResearch } from "@shared/researchShape";
import {
  cleanResearchUse, emptyTally, hookTypeKey, openingLineOf, rankByReplies,
  type BriefCheckResult, type ResearchUseRecord, type Tally,
} from "@shared/researchResults";

/* ── Recording ──────────────────────────────────────────────────────────── */

type Match = Pick<ResearchContext, "sectorId" | "personaId" | "matchedBy">;

/** The research a prospect's copy would be written from, without writing anything. */
export async function researchMatchFor(workspaceId: number, use: Omit<ResearchUse, "surface">): Promise<Match> {
  const ctx = await researchContextFor(workspaceId, { ...use, surface: "judge" });
  return { sectorId: ctx.sectorId, personaId: ctx.personaId, matchedBy: ctx.matchedBy };
}

/** The columns that record which research a prospect's copy used; all null when none matched. */
export function researchUseColumns(
  match: Match,
  brief: Pick<BriefCheck, "checked" | "rules" | "violations" | "pains" | "leads" | "error"> | null,
  copy: { hookType: string; steps: { channel?: unknown; body?: unknown }[] },
): { researchSectorId: number | null; researchPersonaId: number | null; researchUse: ResearchUseRecord | null } {
  if (match.sectorId == null && match.personaId == null) return { researchSectorId: null, researchPersonaId: null, researchUse: null };
  // The pass rate is about avoid rules, so a check with none to apply is "none".
  const check: BriefCheckResult = !brief ? "none" : brief.error ? "error" : !brief.checked || !brief.rules ? "none" : brief.violations.length ? "held" : "passed";
  const first = copy.steps.find((s) => String(s.body ?? "").trim());
  return {
    researchSectorId: match.sectorId,
    researchPersonaId: match.personaId,
    researchUse: {
      pains: brief?.pains ?? [],
      leads: brief?.leads ?? [],
      check,
      hookType: hookTypeKey(copy.hookType),
      opener: openingLineOf(first?.body),
      matchedBy: match.matchedBy,
      at: new Date().toISOString(),
    },
  };
}

/* ── Outcomes ───────────────────────────────────────────────────────────── */

const REPLY_SIGNALS = ["email_reply", "linkedin_reply", "sms_reply", "voice_connected_interested", "voice_connected_not_interested"] as const;
const OUTCOME_SIGNALS = [...REPLY_SIGNALS, "meeting_booked"] as const;
/**
 * The newest this many prospects are counted for each sector or persona; one
 * with more says so (capped). It was this many for all of them together, with
 * no flag, so the busiest sector crowded the rest out of the tallies (P28).
 */
export const MAX_PROSPECTS = 5000;
const CHUNK = 500;

export type Outcome = {
  contacted: boolean;
  replied: boolean;
  positive: boolean;
  meeting: boolean;
  /** The opening line of the first message actually sent ("" when none was). */
  sentOpener: string;
  repliedAt: Date | null;
};

type SentRow = { stepIndex: number; messageContent: unknown; executedAt: Date | null };
type SignalRow = { signalType: string; sentiment: string | null; processedAt: Date | null };
type ReplyRow = { replyClass: string | null };

/** What happened to one prospect, from their sends, signals and classified replies. */
export function outcomeOf(sent: SentRow[], signals: SignalRow[], replies: ReplyRow[]): Outcome {
  const contacted = sent.length > 0;
  const first = [...sent].sort((a, b) => a.stepIndex - b.stepIndex || (a.executedAt?.getTime() ?? 0) - (b.executedAt?.getTime() ?? 0))[0];
  const body = first?.messageContent && typeof first.messageContent === "object" ? (first.messageContent as { body?: unknown }).body : "";
  const replySignals = signals.filter((s) => (REPLY_SIGNALS as readonly string[]).includes(s.signalType));
  // An out-of-office is not a reply: only when every reply on record was one,
  // and none came on another channel.
  const otherChannel = replySignals.some((s) => s.signalType !== "email_reply");
  const autoOnly = !otherChannel && replies.length > 0 && replies.every((r) => r.replyClass === "out_of_office");
  const replied = contacted && replySignals.length > 0 && !autoOnly;
  const positive = replied && (replySignals.some((s) => s.sentiment === "positive") || replies.some((r) => r.replyClass === "willing_to_meet"));
  const meeting = contacted && signals.some((s) => s.signalType === "meeting_booked");
  const times = replySignals.map((s) => s.processedAt?.getTime() ?? 0).filter(Boolean);
  return { contacted, replied, positive, meeting, sentOpener: openingLineOf(body), repliedAt: times.length ? new Date(Math.min(...times)) : null };
}

/**
 * Outcomes for these prospects. Tallies need no message text, so only the
 * results page asks for bodies, and only for the openers it shows (P28): a
 * tally used to read every sent message's body to count them.
 */
async function outcomesFor(db: Db, workspaceId: number, ids: number[]): Promise<Map<number, Outcome>> {
  const sent = new Map<number, SentRow[]>();
  const sig = new Map<number, SignalRow[]>();
  const rep = new Map<number, ReplyRow[]>();
  const push = <T>(m: Map<number, T[]>, k: number, v: T) => { const a = m.get(k); if (a) a.push(v); else m.set(k, [v]); };
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const [s, g, r] = await Promise.all([
      db.select({ pq: areExecutionQueue.prospectQueueId, stepIndex: areExecutionQueue.stepIndex, executedAt: areExecutionQueue.executedAt })
        .from(areExecutionQueue)
        .where(and(eq(areExecutionQueue.workspaceId, workspaceId), eq(areExecutionQueue.status, "sent"), inArray(areExecutionQueue.prospectQueueId, chunk))),
      db.select({ pq: areSignalLog.prospectQueueId, signalType: areSignalLog.signalType, sentiment: areSignalLog.sentiment, processedAt: areSignalLog.processedAt })
        .from(areSignalLog)
        .where(and(eq(areSignalLog.workspaceId, workspaceId), inArray(areSignalLog.prospectQueueId, chunk), inArray(areSignalLog.signalType, [...OUTCOME_SIGNALS]))),
      db.select({ pq: emailReplies.prospectQueueId, replyClass: emailReplies.replyClass })
        .from(emailReplies)
        .where(and(eq(emailReplies.workspaceId, workspaceId), inArray(emailReplies.prospectQueueId, chunk))),
    ]);
    for (const x of s) push(sent, x.pq, { stepIndex: x.stepIndex, messageContent: null, executedAt: x.executedAt });
    for (const x of g) push(sig, x.pq, { signalType: String(x.signalType), sentiment: x.sentiment ?? null, processedAt: x.processedAt });
    for (const x of r) if (x.pq != null) push(rep, x.pq, { replyClass: x.replyClass ?? null });
  }
  return new Map(ids.map((id) => [id, outcomeOf(sent.get(id) ?? [], sig.get(id) ?? [], rep.get(id) ?? [])]));
}

const add = (t: Tally, o: Outcome) => {
  t.written++;
  if (o.contacted) t.contacted++;
  if (o.replied) t.replied++;
  if (o.positive) t.positive++;
  if (o.meeting) t.meetings++;
};

/* ── Results for a sector or a persona ─────────────────────────────────── */

export type ResearchResults = {
  total: Tally;
  check: { checked: number; passed: number; held: number; errors: number };
  personas: (Tally & { personaId: number | null; name: string })[];
  pains: (Tally & { text: string; inResearch: boolean })[];
  leads: (Tally & { text: string; inResearch: boolean })[];
  hooks: (Tally & { hookType: string })[];
  repliedOpeners: { line: string; title: string; company: string; positive: boolean; meeting: boolean; at: string | null }[];
  since: string | null;
  capped: boolean;
};

/** One row per text, case-insensitively, keeping the research's own wording where it has it. */
function textTallies(current: string[], used: Map<string, { text: string; t: Tally }>): (Tally & { text: string; inResearch: boolean })[] {
  const out = new Map<string, Tally & { text: string; inResearch: boolean }>();
  for (const c of current) if (!out.has(c.toLowerCase())) out.set(c.toLowerCase(), { ...emptyTally(), text: c, inResearch: true });
  for (const [k, v] of Array.from(used.entries())) {
    const row = out.get(k);
    if (row) Object.assign(row, v.t, { text: row.text, inResearch: true });
    else out.set(k, { ...v.t, text: v.text, inResearch: false });
  }
  // Best first; what the research has that no copy has used yet (all zeros) falls last.
  return rankByReplies(Array.from(out.values()));
}

export async function researchResults(workspaceId: number, of: { sectorId: number } | { personaId: number }): Promise<ResearchResults> {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });

  // What the research says now: the lists results are compared against.
  let currentPains: string[] = [];
  let currentLeads: string[] = [];
  const personaNames = new Map<number, string>();
  if ("sectorId" in of) {
    const sector = await loadSector(db, workspaceId, of.sectorId);
    const content = sectorContentOf(sector);
    const ps = await db.select({ id: personas.id, name: personas.name, pains: personas.pains }).from(personas)
      .where(and(eq(personas.workspaceId, workspaceId), eq(personas.sectorId, of.sectorId)));
    currentPains = [...content.buyers.painPoints, ...ps.flatMap((p) => cleanPersonaResearch(p).content.pains)];
    currentLeads = content.messaging.leadWith;
    for (const p of ps) personaNames.set(p.id, p.name);
  } else {
    const [p] = await db.select({ id: personas.id, name: personas.name, pains: personas.pains, sectorId: personas.sectorId }).from(personas)
      .where(and(eq(personas.id, of.personaId), eq(personas.workspaceId, workspaceId))).limit(1);
    if (!p) throw new TRPCError({ code: "NOT_FOUND", message: "Persona not found" });
    // The writers had the persona's sector too, so its pains and lead-with points count as the research's.
    const content = p.sectorId != null ? await loadSector(db, workspaceId, p.sectorId).then(sectorContentOf, () => null) : null;
    currentPains = [...(content?.buyers.painPoints ?? []), ...cleanPersonaResearch(p).content.pains];
    currentLeads = content?.messaging.leadWith ?? [];
    personaNames.set(p.id, p.name);
  }

  const rows = await db
    .select({ pq: prospectIntelligence.prospectQueueId, personaId: prospectIntelligence.researchPersonaId, use: prospectIntelligence.researchUse })
    .from(prospectIntelligence)
    .where("sectorId" in of
      ? and(eq(prospectIntelligence.workspaceId, workspaceId), eq(prospectIntelligence.researchSectorId, of.sectorId))
      : and(eq(prospectIntelligence.workspaceId, workspaceId), eq(prospectIntelligence.researchPersonaId, of.personaId)))
    .orderBy(desc(prospectIntelligence.id))
    .limit(MAX_PROSPECTS);
  const ids = rows.map((r) => r.pq);
  const outcomes = await outcomesFor(db, workspaceId, ids);

  // Persona names a sector's results mention but that moved out of it since.
  const missing = Array.from(new Set(rows.map((r) => r.personaId).filter((x): x is number => x != null && !personaNames.has(x))));
  if (missing.length) {
    const more = await db.select({ id: personas.id, name: personas.name }).from(personas)
      .where(and(eq(personas.workspaceId, workspaceId), inArray(personas.id, missing)));
    for (const p of more) personaNames.set(p.id, p.name);
  }

  const total = emptyTally();
  const check = { checked: 0, passed: 0, held: 0, errors: 0 };
  const byPersona = new Map<number | null, Tally>();
  const byPain = new Map<string, { text: string; t: Tally }>();
  const byLead = new Map<string, { text: string; t: Tally }>();
  const byHook = new Map<string, Tally>();
  const replied: { pq: number; o: Outcome; use: ResearchUseRecord }[] = [];
  let since: string | null = null;

  for (const r of rows) {
    const o = outcomes.get(r.pq)!;
    const use = cleanResearchUse(r.use);
    add(total, o);
    if (use.check === "passed" || use.check === "held") check.checked++;
    if (use.check === "passed") check.passed++;
    if (use.check === "held") check.held++;
    if (use.check === "error") check.errors++;
    if (!byPersona.has(r.personaId)) byPersona.set(r.personaId, emptyTally());
    add(byPersona.get(r.personaId)!, o);
    for (const [list, map] of [[use.pains, byPain], [use.leads, byLead]] as const) {
      for (const text of list) {
        const k = text.toLowerCase();
        if (!map.has(k)) map.set(k, { text, t: emptyTally() });
        add(map.get(k)!.t, o);
      }
    }
    if (use.hookType !== "fixed") {
      if (!byHook.has(use.hookType)) byHook.set(use.hookType, emptyTally());
      add(byHook.get(use.hookType)!, o);
    }
    if (o.replied) replied.push({ pq: r.pq, o, use });
    if (use.at && (!since || use.at < since)) since = use.at;
  }

  // Who replied, for the openers that got replies: role and organization, never the person.
  const who = new Map<number, { title: string; company: string }>();
  const shown = replied
    // A meeting first, then a positive reply, then the newest.
    .sort((a, b) => Number(b.o.meeting) - Number(a.o.meeting) || Number(b.o.positive) - Number(a.o.positive) || (b.o.repliedAt?.getTime() ?? 0) - (a.o.repliedAt?.getTime() ?? 0))
    .slice(0, 8);
  if (shown.length) {
    const pqs = shown.map((x) => x.pq);
    const [ps, firstSent] = await Promise.all([
      db.select({ id: prospectQueue.id, title: prospectQueue.title, company: prospectQueue.companyName }).from(prospectQueue)
        .where(and(eq(prospectQueue.workspaceId, workspaceId), inArray(prospectQueue.id, pqs))),
      // The first message sent to each, the only bodies this page reads.
      db.select({ pq: areExecutionQueue.prospectQueueId, stepIndex: areExecutionQueue.stepIndex, messageContent: areExecutionQueue.messageContent, executedAt: areExecutionQueue.executedAt })
        .from(areExecutionQueue)
        .where(and(eq(areExecutionQueue.workspaceId, workspaceId), eq(areExecutionQueue.status, "sent"), inArray(areExecutionQueue.prospectQueueId, pqs))),
    ]);
    for (const p of ps) who.set(p.id, { title: p.title ?? "", company: p.company ?? "" });
    const sentBy = new Map<number, SentRow[]>();
    for (const r of firstSent) sentBy.set(r.pq, [...(sentBy.get(r.pq) ?? []), { stepIndex: r.stepIndex, messageContent: r.messageContent, executedAt: r.executedAt }]);
    for (const x of shown) x.o = { ...x.o, sentOpener: outcomeOf(sentBy.get(x.pq) ?? [], [], []).sentOpener };
  }

  return {
    total,
    check,
    personas: "sectorId" in of
      ? rankByReplies(Array.from(byPersona.entries()).map(([personaId, t]) => ({ ...t, personaId, name: personaId == null ? "No persona matched" : personaNames.get(personaId) ?? "A deleted persona" })))
      : [],
    pains: textTallies(currentPains, byPain),
    leads: textTallies(currentLeads, byLead),
    hooks: rankByReplies(Array.from(byHook.entries()).map(([hookType, t]) => ({ ...t, hookType }))),
    repliedOpeners: shown
      .map((x) => ({ line: x.o.sentOpener || x.use.opener, ...(who.get(x.pq) ?? { title: "", company: "" }), positive: x.o.positive, meeting: x.o.meeting, at: x.o.repliedAt?.toISOString() ?? null }))
      .filter((x) => x.line),
    since,
    capped: rows.length >= MAX_PROSPECTS,
  };
}

export type GroupTally = Tally & { capped: boolean };

/**
 * Tallies per sector or per persona, the newest MAX_PROSPECTS of each; a
 * group with more is marked capped. How many each has is counted in SQL.
 */
async function groupTallies(db: Db, workspaceId: number, by: "sector" | "persona", groupIds?: number[]): Promise<Record<number, GroupTally>> {
  const col = by === "sector" ? prospectIntelligence.researchSectorId : prospectIntelligence.researchPersonaId;
  const scope = and(eq(prospectIntelligence.workspaceId, workspaceId), groupIds ? inArray(col, groupIds) : isNotNull(col));
  const counts = await db.select({ g: col, n: sql<number>`count(*)` }).from(prospectIntelligence).where(scope).groupBy(col).orderBy(asc(col));
  const rows: { pq: number; g: number }[] = [];
  for (const c of counts) {
    if (c.g == null) continue;
    const newest = await db.select({ pq: prospectIntelligence.prospectQueueId }).from(prospectIntelligence)
      .where(and(eq(prospectIntelligence.workspaceId, workspaceId), eq(col, c.g)))
      .orderBy(desc(prospectIntelligence.id)).limit(MAX_PROSPECTS);
    for (const r of newest) rows.push({ pq: r.pq, g: c.g });
  }
  const outcomes = await outcomesFor(db, workspaceId, Array.from(new Set(rows.map((r) => r.pq))));
  const out: Record<number, GroupTally> = {};
  for (const c of counts) if (c.g != null) out[c.g] = { ...emptyTally(), capped: Number(c.n) > MAX_PROSPECTS };
  for (const r of rows) add(out[r.g], outcomes.get(r.pq)!);
  return out;
}

/** Contacted, replied and meetings for every persona with recorded use, for the persona lists. */
export async function personaResultSummaries(workspaceId: number): Promise<Record<number, GroupTally>> {
  const db = await getDb();
  if (!db) return {};
  return groupTallies(db, workspaceId, "persona");
}

/** Written, contacted, replied and meetings for each of these sectors, for the market's results report. */
export async function sectorTallies(workspaceId: number, sectorIds: number[]): Promise<Record<number, GroupTally>> {
  const db = await getDb();
  if (!db || !sectorIds.length) return {};
  return groupTallies(db, workspaceId, "sector", sectorIds);
}
