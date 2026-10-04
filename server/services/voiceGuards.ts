/**
 * voiceGuards.ts — spend and abuse limits for the xAI voice agents.
 *
 * Every call an agent answers is billed to the workspace's own xAI key by the
 * minute. Before 2026-10-04 the only limit was a 30-minute timer per call, and
 * that timer was lost whenever the control socket dropped or the server
 * restarted, while the call itself carried on inside xAI (closing the socket
 * does not end a SIP call; only POST /realtime/calls/{id}/hangup does). Nothing
 * limited how many calls ran at once, or how often one number could ring.
 *
 * The limits here are deliberately plain constants: generous for a person
 * calling back, tight for a robo-dialer or a replayed webhook.
 */
import { and, eq, gte, inArray, lt } from "drizzle-orm";
import { voiceCalls, workspaceSettings } from "../../drizzle/schema";
import { getDb } from "../db";
import { tryDecryptSecret } from "../_core/crypto";

const XAI_API_BASE = "https://api.x.ai/v1";

/** Hard cap on one call; the bridge hangs up at this point. */
export const MAX_CALL_MS = 30 * 60 * 1000;
/** Calls one workspace's agents may hold at the same time. */
export const MAX_CONCURRENT_CALLS_PER_WORKSPACE = 3;
/** Calls from one number, per workspace, in an hour, before we stop answering it. */
export const MAX_CALLS_PER_CALLER_PER_HOUR = 5;
/** Agent minutes per workspace in any rolling 24 hours. */
export const MAX_AGENT_MINUTES_PER_DAY = 240;
/** A row still ringing/in progress after this lost its bridge (restart mid-call). */
export const STALE_CALL_MS = MAX_CALL_MS + 5 * 60 * 1000;

const LIVE = ["ringing", "in_progress"] as const;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export type AdmissionRow = {
  status: string;
  startedAt: Date | string | null;
  durationSec: number | null;
  fromNumber: string | null;
};

export type Admission =
  | { ok: true }
  | { ok: false; code: "daily_budget" | "concurrency" | "repeat_caller"; reason: string };

const digits = (s: string | null | undefined) => String(s ?? "").replace(/\D/g, "");

/**
 * Whether to answer a new call, given the workspace's calls from the last day
 * (plus one call length, so a call still running from yesterday counts).
 * Pure, so the limits are tested without a database.
 */
export function decideAdmission(rows: AdmissionRow[], from: string | null, nowMs = Date.now()): Admission {
  let usedSec = 0;
  let live = 0;
  let fromCaller = 0;
  const caller = digits(from);
  for (const r of rows) {
    const started = r.startedAt ? new Date(r.startedAt).getTime() : NaN;
    if (!Number.isFinite(started)) continue;
    const isLive = (LIVE as readonly string[]).includes(r.status) && nowMs - started < MAX_CALL_MS;
    if (isLive) live++;
    if (nowMs - started < DAY_MS) {
      usedSec += r.durationSec ?? (isLive ? Math.max(0, (nowMs - started) / 1000) : 0);
    }
    if (caller && nowMs - started < HOUR_MS && digits(r.fromNumber) === caller) fromCaller++;
  }
  if (usedSec >= MAX_AGENT_MINUTES_PER_DAY * 60) {
    return { ok: false, code: "daily_budget", reason: `Not answered: this workspace's agents have used their ${MAX_AGENT_MINUTES_PER_DAY} minutes for the last 24 hours.` };
  }
  if (live >= MAX_CONCURRENT_CALLS_PER_WORKSPACE) {
    return { ok: false, code: "concurrency", reason: `Not answered: ${live} agent calls were already in progress (limit ${MAX_CONCURRENT_CALLS_PER_WORKSPACE}).` };
  }
  if (fromCaller >= MAX_CALLS_PER_CALLER_PER_HOUR) {
    return { ok: false, code: "repeat_caller", reason: `Not answered: this number had already called ${fromCaller} times in the last hour.` };
  }
  return { ok: true };
}

/** Reads the workspace's recent calls and decides. */
export async function admitInboundCall(workspaceId: number, from: string | null, nowMs = Date.now()): Promise<Admission> {
  const db = await getDb();
  if (!db) return { ok: false, code: "concurrency", reason: "Not answered: database unavailable." };
  const rows = await db
    .select({
      status: voiceCalls.status,
      startedAt: voiceCalls.startedAt,
      durationSec: voiceCalls.durationSec,
      fromNumber: voiceCalls.fromNumber,
    })
    .from(voiceCalls)
    .where(and(eq(voiceCalls.workspaceId, workspaceId), gte(voiceCalls.startedAt, new Date(nowMs - DAY_MS - MAX_CALL_MS))));
  return decideAdmission(rows, from, nowMs);
}

/** Ends a call inside xAI. Best effort: ending an already-ended call is harmless. */
export async function hangupXaiCall(apiKey: string, xaiCallId: string): Promise<void> {
  if (!apiKey || !xaiCallId) return;
  await fetch(`${XAI_API_BASE}/realtime/calls/${encodeURIComponent(xaiCallId)}/hangup`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
  }).catch(() => {});
}

/** The workspace's xAI key, or "" when none is configured. */
export async function workspaceXaiKey(workspaceId: number): Promise<string> {
  const db = await getDb();
  if (!db) return "";
  const [row] = await db
    .select({ enc: workspaceSettings.xaiApiKeyEnc })
    .from(workspaceSettings)
    .where(eq(workspaceSettings.workspaceId, workspaceId))
    .limit(1);
  return tryDecryptSecret(row?.enc);
}

/**
 * Calls whose bridge was lost (the server restarted mid-call): still marked
 * ringing/in progress long after the per-call cap. Hang them up in xAI, so
 * they stop billing, and close the row. Runs every 5 minutes.
 */
export async function sweepStaleVoiceCalls(nowMs = Date.now()): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const stale = await db
    .select({ id: voiceCalls.id, workspaceId: voiceCalls.workspaceId, xaiCallId: voiceCalls.xaiCallId, outcome: voiceCalls.outcome, provider: voiceCalls.provider, plivoCallUuid: voiceCalls.plivoCallUuid })
    .from(voiceCalls)
    // "queued" too: a Plivo call the dialer placed whose callbacks never came.
    .where(and(inArray(voiceCalls.status, [...LIVE, "queued"]), lt(voiceCalls.startedAt, new Date(nowMs - STALE_CALL_MS))))
    .limit(100);
  for (const row of stale) {
    if (row.provider === "plivo") {
      const { plivoCreds, hangupCall } = await import("./plivo");
      const creds = await plivoCreds(row.workspaceId);
      if (creds) await hangupCall(creds, row.plivoCallUuid);
    } else if (row.xaiCallId) {
      await hangupXaiCall(await workspaceXaiKey(row.workspaceId), row.xaiCallId);
    }
    const note = "Velocity lost track of this call (most likely a server restart mid-call); the safety sweep hung it up.";
    await db
      .update(voiceCalls)
      .set({ status: "failed", outcome: [row.outcome, note].filter(Boolean).join("\n\n").slice(0, 8000), endedAt: new Date(nowMs) })
      .where(eq(voiceCalls.id, row.id));
    if (row.provider === "plivo") {
      const { finishRequestForCall } = await import("./voiceRelay");
      await finishRequestForCall(row.id).catch(() => {});
    }
  }
  return stale.length;
}
