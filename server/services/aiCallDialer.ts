/**
 * aiCallDialer.ts — places APPROVED AI calls, and nothing else.
 *
 * Owner ask 2026-10-04: outbound AI calls "gated and not autonomous". A row
 * reaches this file only after a manager approved it (routers/aiCalls.ts,
 * consent confirmed). Even then it dials only when:
 *   - AI calls are not paused for the workspace (Settings → Voice agents;
 *     their own switch since 2026-10-05, separate from Pause all outbound,
 *     which holds automated email);
 *   - it is 9 AM–5 PM on a weekday in the PERSON's time zone;
 *   - the number is not on the do-not-call list;
 *   - the agent is active and has a Plivo number;
 *   - the spend limits allow another call (voiceGuards: calls at once,
 *     minutes per day), one of the agent's numbers has calls left for the
 *     day, and the workspace has not started its calls for this minute.
 * Otherwise the row stays approved, with the reason it is waiting.
 *
 * More calls (2026-10-06): an agent may hold several numbers, and each call
 * goes out from the best one (shared/voiceCapacity.ts pickFromNumber: the
 * number this person was last called from, else a local one, else the
 * least used). The workspace limits are an admin's, up to fixed ceilings.
 *
 * Every call carries a carrier-side time limit, so Plivo ends it even if
 * Velocity is gone.
 */
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { callSuppressions, voiceAgents, voiceCallRequests, voiceCalls, workspaceSettings, workspaces } from "../../drizzle/schema";
import { getDb } from "../db";
import { isWithinCallingHours } from "@shared/callingHours";
import { admitInboundCall } from "./voiceGuards";
import { agentNumbers, clampVoiceLimits, DEFAULT_VOICE_LIMITS, MAX_CALLS_PER_NUMBER_PER_DAY, pickFromNumber } from "@shared/voiceCapacity";
import { PlivoError, placeCall, plivoCreds, plivoUrls } from "./plivo";

/** New calls started per workspace per run (runs every minute), unless an admin changed it. */
export const MAX_DIALS_PER_MINUTE_PER_WORKSPACE = DEFAULT_VOICE_LIMITS.dialsPerMinute;
/** Calls one Plivo number places in 24 hours: carriers flag busy new numbers as spam. */
export { MAX_CALLS_PER_NUMBER_PER_DAY };
/** Plivo hangs up at this point (seconds from answer), whatever happens to Velocity. */
export const OUTBOUND_TIME_LIMIT_SEC = 20 * 60;

export const WAIT = {
  paused: "Waiting: AI calls are paused for this workspace (Settings → Voice agents).",
  noPlivo: "Waiting: Plivo is not connected (Settings → Voice agents).",
  hours: "Waiting for calling hours: 9 AM–5 PM weekdays, their time.",
  agent: "Waiting: the agent is paused or has no Plivo number.",
  numberDay: `Waiting: the agent's numbers have each placed their ${MAX_CALLS_PER_NUMBER_PER_DAY} calls for today. Add a number to the agent to make more.`,
} as const;

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

async function waitWith(db: Db, id: number, current: string | null, reason: string): Promise<void> {
  if (current === reason) return;
  await db.update(voiceCallRequests).set({ statusReason: reason }).where(and(eq(voiceCallRequests.id, id), eq(voiceCallRequests.status, "approved")));
}

export async function runAiCallDialer(nowMs = Date.now()): Promise<{ dialed: number }> {
  const db = await getDb();
  if (!db) return { dialed: 0 };
  const wsRows = await db.selectDistinct({ workspaceId: voiceCallRequests.workspaceId }).from(voiceCallRequests).where(eq(voiceCallRequests.status, "approved"));
  let dialed = 0;
  for (const { workspaceId } of wsRows) {
    try {
      dialed += await dialWorkspace(db, workspaceId, nowMs);
    } catch (e) {
      console.error(`[AiCallDialer] workspace ${workspaceId} failed:`, e);
    }
  }
  return { dialed };
}

export async function dialWorkspace(db: Db, ws: number, nowMs: number): Promise<number> {
  const approved = await db.select().from(voiceCallRequests)
    .where(and(eq(voiceCallRequests.workspaceId, ws), eq(voiceCallRequests.status, "approved")))
    .orderBy(voiceCallRequests.approvedAt)
    .limit(50);
  if (!approved.length) return 0;

  // AI calls' own switch (2026-10-05), not Pause all outbound: every call
  // here was approved by a person, and email can stay held while calls run.
  const [settings] = await db.select({
    aiCallsPausedAt: workspaceSettings.aiCallsPausedAt,
    maxConcurrent: workspaceSettings.aiCallsMaxConcurrent,
    dialsPerMinute: workspaceSettings.aiCallsDialsPerMinute,
    dailyMinutes: workspaceSettings.aiCallsDailyMinutes,
  }).from(workspaceSettings)
    .where(eq(workspaceSettings.workspaceId, ws)).limit(1);
  if (settings?.aiCallsPausedAt) {
    for (const r of approved) await waitWith(db, r.id, r.statusReason, WAIT.paused);
    return 0;
  }
  const creds = await plivoCreds(ws);
  if (!creds) {
    for (const r of approved) await waitWith(db, r.id, r.statusReason, WAIT.noPlivo);
    return 0;
  }

  const agentIds = Array.from(new Set(approved.map((r) => r.agentId)));
  const agents = await db.select().from(voiceAgents).where(and(eq(voiceAgents.workspaceId, ws), inArray(voiceAgents.id, agentIds)));
  const agentById = new Map(agents.map((a) => [a.id, a]));
  const [wsRow] = await db.select({ name: workspaces.name }).from(workspaces).where(eq(workspaces.id, ws)).limit(1);
  const limits = clampVoiceLimits(settings);

  // Calls each number placed in the last 24 hours, kept up to date as this run dials.
  const usedToday: Record<string, number> = {};
  const usage = await db.select({ fromNumber: voiceCalls.fromNumber, n: sql<number>`count(*)` }).from(voiceCalls).where(and(
    eq(voiceCalls.workspaceId, ws),
    eq(voiceCalls.direction, "outbound"),
    gte(voiceCalls.startedAt, new Date(nowMs - 24 * 60 * 60 * 1000)),
  )).groupBy(voiceCalls.fromNumber);
  for (const u of usage) {
    const d = String(u.fromNumber ?? "").replace(/\D/g, "");
    if (d) usedToday[d] = (usedToday[d] ?? 0) + Number(u.n);
  }

  let dialed = 0;
  for (const r of approved) {
    if (dialed >= limits.dialsPerMinute) break;
    if (!isWithinCallingHours(nowMs, r.timezone)) { await waitWith(db, r.id, r.statusReason, WAIT.hours); continue; }

    const [dnc] = await db.select({ id: callSuppressions.id }).from(callSuppressions)
      .where(and(eq(callSuppressions.workspaceId, ws), eq(callSuppressions.phone, r.toNumber))).limit(1);
    if (dnc) {
      await db.update(voiceCallRequests).set({ status: "skipped", statusReason: "Number is on the do-not-call list" })
        .where(and(eq(voiceCallRequests.id, r.id), eq(voiceCallRequests.status, "approved")));
      continue;
    }

    const agent = agentById.get(r.agentId);
    const numbers = agentNumbers(agent);
    if (!agent || agent.status !== "active" || agent.purpose !== "outbound_outreach" || !numbers.length) {
      await waitWith(db, r.id, r.statusReason, WAIT.agent);
      continue;
    }

    const [last] = await db.select({ lastFrom: voiceCalls.fromNumber }).from(voiceCalls).where(and(
      eq(voiceCalls.workspaceId, ws),
      eq(voiceCalls.direction, "outbound"),
      eq(voiceCalls.toNumber, r.toNumber),
    )).orderBy(desc(voiceCalls.startedAt)).limit(1);
    const from = pickFromNumber({ numbers, to: r.toNumber, lastFrom: last?.lastFrom ?? null, usedToday });
    if (!from) { await waitWith(db, r.id, r.statusReason, WAIT.numberDay); continue; }

    const admission = await admitInboundCall(ws, null, nowMs, limits);
    if (!admission.ok) {
      await waitWith(db, r.id, r.statusReason, `Waiting: ${admission.reason.replace(/^Not answered: /, "")}`);
      break;
    }

    // Claim it: only one run dials a row.
    const claimed = await db.update(voiceCallRequests)
      .set({ status: "dialing", statusReason: null, attempts: sql`${voiceCallRequests.attempts} + 1`, lastAttemptAt: new Date(nowMs) })
      .where(and(eq(voiceCallRequests.id, r.id), eq(voiceCallRequests.status, "approved")));
    if (Number((claimed as unknown as Array<{ affectedRows?: number }>)[0]?.affectedRows ?? 0) !== 1) continue;

    const ins = await db.insert(voiceCalls).values({
      workspaceId: ws,
      agentId: agent.id,
      direction: "outbound",
      provider: "plivo",
      toNumber: r.toNumber,
      fromNumber: from,
      status: "queued",
      requestId: r.id,
      relatedType: "prospect",
      relatedId: r.prospectId,
      userId: r.ownerUserId,
      startedAt: new Date(nowMs),
    });
    const rowId = Number((ins as any)[0]?.insertId ?? (ins as any)?.insertId ?? 0);
    const fromDigits = from.replace(/\D/g, "");
    usedToday[fromDigits] = (usedToday[fromDigits] ?? 0) + 1;
    await db.update(voiceCallRequests).set({ voiceCallId: rowId || null }).where(eq(voiceCallRequests.id, r.id));
    const urls = plivoUrls(ws, rowId);
    try {
      await placeCall(creds, {
        from,
        to: r.toNumber,
        answerUrl: urls.answer,
        hangupUrl: urls.hangup,
        timeLimit: OUTBOUND_TIME_LIMIT_SEC,
        callerName: wsRow?.name ?? undefined,
      });
      dialed++;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await db.update(voiceCalls).set({ status: "failed", outcome: msg.slice(0, 500), endedAt: new Date(), durationSec: 0 }).where(eq(voiceCalls.id, rowId));
      if (e instanceof PlivoError && (e.status === 403 || e.status === 429)) {
        // Plivo's concurrency or rate limit: try again next minute.
        await db.update(voiceCallRequests).set({ status: "approved", statusReason: `Waiting: ${msg}`, voiceCallId: null })
          .where(eq(voiceCallRequests.id, r.id));
        break;
      }
      await db.update(voiceCallRequests).set({ status: "done", result: "failed", statusReason: msg.slice(0, 240) }).where(eq(voiceCallRequests.id, r.id));
    }
  }
  return dialed;
}
