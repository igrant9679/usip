/**
 * aiCallDialer.ts — places APPROVED AI calls, and nothing else.
 *
 * Owner ask 2026-10-04: outbound AI calls "gated and not autonomous". A row
 * reaches this file only after a manager approved it (routers/aiCalls.ts,
 * consent confirmed). Even then it dials only when:
 *   - outbound is not paused for the workspace (Settings → Send window);
 *   - it is 9 AM–5 PM on a weekday in the PERSON's time zone;
 *   - the number is not on the do-not-call list;
 *   - the agent is active and has a Plivo number;
 *   - the spend limits allow another call (voiceGuards: calls at once,
 *     minutes per day), the number has not made its calls for the day, and
 *     at most two calls start per workspace per minute.
 * Otherwise the row stays approved, with the reason it is waiting.
 *
 * Every call carries a carrier-side time limit, so Plivo ends it even if
 * Velocity is gone.
 */
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { callSuppressions, voiceAgents, voiceCallRequests, voiceCalls, workspaces } from "../../drizzle/schema";
import { getDb } from "../db";
import { isWithinCallingHours } from "@shared/callingHours";
import { getWorkspaceSendWindow } from "./sendWindow";
import { admitInboundCall } from "./voiceGuards";
import { PlivoError, placeCall, plivoCreds, plivoUrls } from "./plivo";

/** New calls started per workspace per run (runs every minute). */
export const MAX_DIALS_PER_MINUTE_PER_WORKSPACE = 2;
/** Calls one Plivo number places in 24 hours: carriers flag busy new numbers as spam. */
export const MAX_CALLS_PER_NUMBER_PER_DAY = 100;
/** Plivo hangs up at this point (seconds from answer), whatever happens to Velocity. */
export const OUTBOUND_TIME_LIMIT_SEC = 20 * 60;

export const WAIT = {
  paused: "Waiting: outbound is paused for this workspace (Settings → Send window).",
  noPlivo: "Waiting: Plivo is not connected (Settings → Voice agents).",
  hours: "Waiting for calling hours: 9 AM–5 PM weekdays, their time.",
  agent: "Waiting: the agent is paused or has no Plivo number.",
  numberDay: `Waiting: this number has placed its ${MAX_CALLS_PER_NUMBER_PER_DAY} calls for today.`,
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

  const { paused } = await getWorkspaceSendWindow(ws, nowMs);
  if (paused) {
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

  let dialed = 0;
  for (const r of approved) {
    if (dialed >= MAX_DIALS_PER_MINUTE_PER_WORKSPACE) break;
    if (!isWithinCallingHours(nowMs, r.timezone)) { await waitWith(db, r.id, r.statusReason, WAIT.hours); continue; }

    const [dnc] = await db.select({ id: callSuppressions.id }).from(callSuppressions)
      .where(and(eq(callSuppressions.workspaceId, ws), eq(callSuppressions.phone, r.toNumber))).limit(1);
    if (dnc) {
      await db.update(voiceCallRequests).set({ status: "skipped", statusReason: "Number is on the do-not-call list" })
        .where(and(eq(voiceCallRequests.id, r.id), eq(voiceCallRequests.status, "approved")));
      continue;
    }

    const agent = agentById.get(r.agentId);
    if (!agent || agent.status !== "active" || agent.purpose !== "outbound_outreach" || !agent.plivoNumber) {
      await waitWith(db, r.id, r.statusReason, WAIT.agent);
      continue;
    }

    const [{ n } = { n: 0 }] = await db.select({ n: sql<number>`count(*)` }).from(voiceCalls).where(and(
      eq(voiceCalls.workspaceId, ws),
      eq(voiceCalls.direction, "outbound"),
      eq(voiceCalls.fromNumber, agent.plivoNumber),
      gte(voiceCalls.startedAt, new Date(nowMs - 24 * 60 * 60 * 1000)),
    ));
    if (Number(n) >= MAX_CALLS_PER_NUMBER_PER_DAY) { await waitWith(db, r.id, r.statusReason, WAIT.numberDay); continue; }

    const admission = await admitInboundCall(ws, null, nowMs);
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
      fromNumber: agent.plivoNumber,
      status: "queued",
      requestId: r.id,
      relatedType: "prospect",
      relatedId: r.prospectId,
      userId: r.ownerUserId,
      startedAt: new Date(nowMs),
    });
    const rowId = Number((ins as any)[0]?.insertId ?? (ins as any)?.insertId ?? 0);
    await db.update(voiceCallRequests).set({ voiceCallId: rowId || null }).where(eq(voiceCallRequests.id, r.id));
    const urls = plivoUrls(ws, rowId);
    try {
      await placeCall(creds, {
        from: agent.plivoNumber,
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
