/**
 * voiceRelay.ts — one live Plivo call, relayed to xAI's voice agent.
 *
 * Plivo streams the caller's audio to Velocity over a WebSocket (G.711 μ-law,
 * 8 kHz); Velocity streams it to wss://api.x.ai/v1/realtime with the same
 * format, and streams the agent's audio back. Base64 passes through both ways
 * untouched (xAI's own phone-relay example does the same). Velocity sits in
 * the middle so it can run the agent's tools: offer real times from the
 * owner's calendar, book the meeting, honour "don't call me again", and hang
 * up (owner ask 2026-10-04: AI calls that book meetings).
 *
 * CallSession is socket-agnostic (tests drive it with fakes); startRelay
 * wires it to the real sockets.
 */
import WebSocket from "ws";
import { and, eq, inArray } from "drizzle-orm";
import {
  calendarAccounts,
  contacts,
  leads,
  meetings,
  notifications,
  prospects,
  users,
  voiceAgents,
  voiceCallRequests,
  voiceCalls,
  workspaceSettings,
  workspaces,
} from "../../drizzle/schema";
import { getDb } from "../db";
import { tryDecryptSecret } from "../_core/crypto";
import { activeOwnerOrNull, workspaceNotifyUserId } from "../_core/activeMembers";
import { timezoneForRegion } from "@shared/callingHours";
import { buildBrandContext } from "./brandContext";
import { configuredProposalOwner, openSlotsForOwner, sendMeetingInvite } from "./meetingScheduler";
import { getWorkspaceTimezone } from "./workspaceTimezone";
import { logCallActivity, matchCallerToRecord } from "./voiceCrmLink";
import { MAX_CALL_MS } from "./voiceGuards";
import { buildCallInstructions, callTools, CALL_RESULTS, plausibleEmail, spokenTime, type CallResult } from "./voiceCallScript";
import { hangupCall, plivoCreds } from "./plivo";
import { suppressNumber } from "../routers/aiCalls";

const XAI_REALTIME = "wss://api.x.ai/v1/realtime";
export const DEFAULT_CALL_MODEL = "grok-voice-think-fast-2.0";
/** Plivo caps a WebSocket message at 64 KB and recommends ≤16 KB of base64. Multiple of 4: valid base64 per piece. */
const PLAY_CHUNK = 16000;
/** Outbound: if the person says nothing this long after the audio is up, the agent speaks first. */
const SILENT_PICKUP_MS = 4000;
/** After end_call, wait for the goodbye to finish playing, but no longer than this. */
const GOODBYE_MAX_MS = 8000;
/** Caller audio buffered while the xAI session is configured (~5 s of 20 ms chunks). */
const MAX_BUFFERED_CHUNKS = 250;

export type Sock = { send(data: string): void; close(): void };

export type CallContext = {
  workspaceId: number;
  callRowId: number;
  direction: "outbound" | "inbound";
  agentName: string;
  voice: string;
  model: string;
  apiKey: string;
  instructions: string;
  tools: Record<string, unknown>[];
  canBook: boolean;
  ownerUserId: number | null;
  ownerName: string | null;
  companyName: string;
  /** The other party's number: who was called, or who called. */
  otherNumber: string | null;
  prospectId: number | null;
  personName: string | null;
  personCompany: string | null;
  emailOnFile: string | null;
  personTz: string;
  requestId: number | null;
  plivoCallUuid: string | null;
};

/** What the session needs from the outside world. Real implementations below; tests pass fakes. */
export type SessionDeps = {
  findTimes(ctx: CallContext): Promise<{ option: string; iso: string; spoken: string }[]>;
  book(ctx: CallContext, iso: string, email: string, meetingId: number | null): Promise<{ ok: boolean; meetingId: number | null; reason?: string }>;
  doNotCall(ctx: CallContext): Promise<void>;
  hangup(ctx: CallContext): Promise<void>;
  finalize(ctx: CallContext, f: { transcript: string[]; result: CallResult | null; note: string | null; meetingId: number | null; answered: boolean }): Promise<void>;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(t: unknown): void;
};

const BOOK_FAIL: Record<string, string> = {
  time_taken: "That time was just taken. Apologise and offer one of the other times.",
  all_times_taken: "Those times were just taken. Apologise and say the team will email new times.",
  days_full: "That day just filled up. Offer one of the other times.",
  outside_window: "That time can no longer be booked. Offer one of the other times.",
  time_in_past: "That time has passed. Offer one of the other times.",
  already_invited: "They already have a meeting invite on the way from us. Tell them to look out for it.",
  no_attendee_email: "No email address to send the invite to. Ask for one and spell it back.",
  no_calendar_connected: "The calendar is not connected, so you cannot book. Say the team will email times.",
  provider_error: "The calendar did not respond. Apologise and say the team will email the invite shortly.",
};

export class CallSession {
  private streamId: string | null = null;
  private ready = false;
  private buffered: string[] = [];
  private transcript: string[] = [];
  private result: CallResult | null = null;
  private note: string | null = null;
  private meetingId: number | null = null;
  private options: { option: string; iso: string; spoken: string }[] | null = null;
  private speechSeen = false;
  private answered = false;
  private finished = false;
  private ending = false;
  private inflight = 0;
  private responseDone = false;
  private outputsSent = false;
  private timers: unknown[] = [];

  constructor(private ctx: CallContext, private plivo: Sock, private xai: Sock, private deps: SessionDeps) {
    this.timers.push(deps.setTimeout(() => this.hangupNow("Call ended by the 30-minute safety cap."), MAX_CALL_MS));
  }

  /** The xAI socket is open: configure the session. */
  onXaiOpen(): void {
    this.xai.send(JSON.stringify({
      type: "session.update",
      session: {
        voice: this.ctx.voice || "eve",
        instructions: this.ctx.instructions,
        audio: {
          input: { format: { type: "audio/pcmu" } },
          output: { format: { type: "audio/pcmu" } },
        },
        turn_detection: { type: "server_vad" },
        tools: this.ctx.tools,
      },
    }));
  }

  onPlivoMessage(raw: string): void {
    let m: any;
    try { m = JSON.parse(raw); } catch { return; }
    switch (m?.event) {
      case "start":
        this.streamId = m.start?.streamId ?? m.streamId ?? null;
        this.answered = true;
        return;
      case "media": {
        if (m.media?.track && m.media.track !== "inbound") return;
        const audio = m.media?.payload;
        if (typeof audio !== "string" || !audio) return;
        if (this.ready) this.xai.send(JSON.stringify({ type: "input_audio_buffer.append", audio }));
        else if (this.buffered.length < MAX_BUFFERED_CHUNKS) this.buffered.push(audio);
        return;
      }
      case "playedStream":
        if (m.name === "goodbye") this.hangupNow();
        return;
      default:
        return;
    }
  }

  async onXaiMessage(raw: string): Promise<void> {
    let e: any;
    try { e = JSON.parse(raw); } catch { return; }
    switch (e?.type) {
      case "session.updated": {
        if (this.ready) return;
        this.ready = true;
        for (const audio of this.buffered) this.xai.send(JSON.stringify({ type: "input_audio_buffer.append", audio }));
        this.buffered = [];
        if (this.ctx.direction === "inbound") {
          this.xai.send(JSON.stringify({ type: "response.create" }));
        } else {
          // Outbound: let the person say "hello" first; speak if they don't.
          this.timers.push(this.deps.setTimeout(() => {
            if (!this.speechSeen && !this.finished) this.xai.send(JSON.stringify({ type: "response.create" }));
          }, SILENT_PICKUP_MS));
        }
        return;
      }
      case "input_audio_buffer.speech_started":
        this.speechSeen = true;
        // Barge-in: stop whatever the agent was saying.
        if (this.streamId) this.plivo.send(JSON.stringify({ event: "clearAudio", streamId: this.streamId }));
        return;
      case "response.output_audio.delta":
      case "response.audio.delta": {
        const delta = typeof e.delta === "string" ? e.delta : "";
        for (let i = 0; i < delta.length; i += PLAY_CHUNK) {
          this.plivo.send(JSON.stringify({
            event: "playAudio",
            media: { contentType: "audio/x-mulaw", sampleRate: 8000, payload: delta.slice(i, i + PLAY_CHUNK) },
          }));
        }
        return;
      }
      case "response.output_audio_transcript.done":
        if (typeof e.transcript === "string" && e.transcript.trim()) this.transcript.push(`Agent: ${e.transcript.trim()}`);
        return;
      case "conversation.item.input_audio_transcription.completed":
        if (typeof e.transcript === "string" && e.transcript.trim()) {
          this.transcript.push(`${this.ctx.direction === "outbound" ? "Person" : "Caller"}: ${e.transcript.trim()}`);
        }
        return;
      case "response.created":
        this.responseDone = false;
        return;
      case "response.done":
        this.responseDone = true;
        this.maybeContinue();
        return;
      case "response.function_call_arguments.done":
        await this.runTool(String(e.name ?? ""), String(e.call_id ?? ""), String(e.arguments ?? "{}"));
        return;
      case "error":
        console.error("[VoiceRelay] xAI error:", JSON.stringify(e).slice(0, 400));
        if (e.error?.type === "max_duration") this.hangupNow("The voice session reached its maximum length.");
        return;
      default:
        return;
    }
  }

  private async runTool(name: string, callId: string, argsJson: string): Promise<void> {
    if (!callId) return;
    let args: any = {};
    try { args = JSON.parse(argsJson || "{}"); } catch { args = {}; }
    this.inflight++;
    let output: unknown;
    try {
      output = await this.tool(name, args);
    } catch (err) {
      console.error(`[VoiceRelay] tool ${name} failed:`, err);
      output = { ok: false, error: "Something went wrong. Apologise and say the team will follow up." };
    }
    this.xai.send(JSON.stringify({ type: "conversation.item.create", item: { type: "function_call_output", call_id: callId, output: JSON.stringify(output) } }));
    this.outputsSent = true;
    this.inflight--;
    this.maybeContinue();
  }

  /** All tool outputs of a response are in: let the agent carry on (one response.create). */
  private maybeContinue(): void {
    if (this.inflight > 0 || !this.responseDone || !this.outputsSent) return;
    this.outputsSent = false;
    this.responseDone = false;
    if (!this.ending && !this.finished) this.xai.send(JSON.stringify({ type: "response.create" }));
  }

  private async tool(name: string, args: any): Promise<unknown> {
    switch (name) {
      case "find_meeting_times": {
        if (!this.ctx.canBook) return { options: [], note: "You cannot book on this call." };
        this.options ??= await this.deps.findTimes(this.ctx);
        if (!this.options.length) return { options: [], note: "No open times in the next two weeks. Say the team will email some times." };
        return { options: this.options.map((o) => ({ option: o.option, time: o.spoken })) };
      }
      case "book_meeting": {
        if (!this.ctx.canBook) return { ok: false, error: "You cannot book on this call." };
        this.options ??= await this.deps.findTimes(this.ctx);
        const pick = this.options.find((o) => o.option.toUpperCase() === String(args.option ?? "").trim().toUpperCase());
        if (!pick) return { ok: false, error: "That is not one of the offered options. Call find_meeting_times and offer those times." };
        const email = plausibleEmail(args.email);
        if (!email) return { ok: false, error: "That email address is not complete. Ask them to spell it, and read it back." };
        const r = await this.deps.book(this.ctx, pick.iso, email, this.meetingId);
        if (r.meetingId) this.meetingId = r.meetingId;
        if (!r.ok) {
          if (r.reason === "time_taken" || r.reason === "days_full") this.options = this.options.filter((o) => o !== pick);
          return { ok: false, error: BOOK_FAIL[r.reason ?? ""] ?? BOOK_FAIL.provider_error };
        }
        this.result = "booked";
        this.transcript.push(`[Booked: ${pick.spoken}, invite to ${email}]`);
        return { ok: true, booked: pick.spoken, invite_sent_to: email, say: "The invite is on its way; they need to accept it in their calendar." };
      }
      case "mark_do_not_call":
        await this.deps.doNotCall(this.ctx);
        this.result = "do_not_call";
        this.transcript.push("[Asked not to be called again: number added to the do-not-call list]");
        return { ok: true };
      case "end_call": {
        const r = String(args.result ?? "");
        // A booking or a do-not-call request outranks whatever the agent says at the end.
        if (this.result !== "booked" && this.result !== "do_not_call") {
          this.result = (CALL_RESULTS as readonly string[]).includes(r) ? (r as CallResult) : "no_decision";
        }
        if (typeof args.note === "string" && args.note.trim()) this.note = args.note.trim().slice(0, 500);
        this.ending = true;
        // Hang up once the goodbye has played (Plivo answers a checkpoint when
        // everything before it has played), or after GOODBYE_MAX_MS.
        if (this.streamId) this.plivo.send(JSON.stringify({ event: "checkpoint", streamId: this.streamId, name: "goodbye" }));
        this.timers.push(this.deps.setTimeout(() => this.hangupNow(), GOODBYE_MAX_MS));
        return { ok: true };
      }
      default:
        return { ok: false, error: `Unknown tool ${name}` };
    }
  }

  /** End the call in Plivo; the stream closing then finishes the session. */
  hangupNow(note?: string): void {
    if (this.finished) return;
    if (note) this.note = this.note ? `${this.note} ${note}` : note;
    void this.deps.hangup(this.ctx).catch(() => {});
    try { this.plivo.close(); } catch { /* noop */ }
    void this.finish();
  }

  /** The Plivo stream closed (call over) or xAI went away: finish once. */
  async finish(): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    for (const t of this.timers) this.deps.clearTimeout(t);
    try { this.xai.close(); } catch { /* noop */ }
    await this.deps.finalize(this.ctx, {
      transcript: this.transcript,
      result: this.result,
      note: this.note,
      meetingId: this.meetingId,
      answered: this.answered,
    });
  }

  /** xAI dropped mid-call: the agent is gone, so the call ends rather than leaving the person in silence. */
  onXaiClosed(): void {
    if (!this.finished) this.hangupNow("The voice agent disconnected.");
  }
}

/* ── context ──────────────────────────────────────────────────────────── */

export async function loadCallContext(callRowId: number): Promise<CallContext | null> {
  const db = await getDb();
  if (!db) return null;
  const [row] = await db.select().from(voiceCalls).where(eq(voiceCalls.id, callRowId)).limit(1);
  if (!row) return null;
  const wsId = row.workspaceId;
  const [agent] = await db.select().from(voiceAgents).where(and(eq(voiceAgents.id, row.agentId), eq(voiceAgents.workspaceId, wsId))).limit(1);
  if (!agent) return null;
  const [settings] = await db.select({ enc: workspaceSettings.xaiApiKeyEnc }).from(workspaceSettings).where(eq(workspaceSettings.workspaceId, wsId)).limit(1);
  const apiKey = tryDecryptSecret(settings?.enc);
  if (!apiKey) return null;
  const [ws] = await db.select({ name: workspaces.name }).from(workspaces).where(eq(workspaces.id, wsId)).limit(1);
  const companyName = ws?.name?.trim() || "our company";
  const wsTz = await getWorkspaceTimezone(wsId);
  const direction = row.direction;

  let request: typeof voiceCallRequests.$inferSelect | null = null;
  if (row.requestId) {
    [request] = await db.select().from(voiceCallRequests).where(and(eq(voiceCallRequests.id, row.requestId), eq(voiceCallRequests.workspaceId, wsId))).limit(1);
  }

  // Who the meeting is with: the request's owner (outbound), else the
  // agent's member, else the workspace's proposal owner. Only a member who
  // still works here: the agent says this name out loud and books on this
  // calendar, so a leaver falls through to the next candidate.
  let ownerUserId: number | null = null;
  for (const cand of [request?.ownerUserId, agent.ownerUserId, await configuredProposalOwner(wsId)]) {
    ownerUserId = await activeOwnerOrNull(wsId, cand ?? null);
    if (ownerUserId) break;
  }
  let ownerName: string | null = null;
  let canBook = false;
  if (ownerUserId) {
    const [u] = await db.select({ name: users.name }).from(users).where(eq(users.id, ownerUserId)).limit(1);
    ownerName = u?.name ?? null;
    const [cal] = await db.select({ id: calendarAccounts.id }).from(calendarAccounts)
      .where(and(eq(calendarAccounts.workspaceId, wsId), eq(calendarAccounts.userId, ownerUserId))).limit(1);
    canBook = !!cal;
  }

  // The person: from the request (outbound), or matched from the caller's number (inbound).
  let prospectId: number | null = null;
  let person: { name: string | null; title: string | null; company: string | null; email: string | null; tz: string | null } = { name: null, title: null, company: null, email: null, tz: null };
  if (request) {
    prospectId = request.prospectId;
    const [p] = await db.select({ title: prospects.title, state: prospects.state, country: prospects.country }).from(prospects)
      .where(and(eq(prospects.id, request.prospectId), eq(prospects.workspaceId, wsId))).limit(1);
    person = { name: request.personName, title: p?.title ?? null, company: request.company, email: request.email, tz: request.timezone };
  } else if (row.relatedType && row.relatedId) {
    if (row.relatedType === "prospect") {
      const [p] = await db.select().from(prospects).where(and(eq(prospects.id, row.relatedId), eq(prospects.workspaceId, wsId))).limit(1);
      if (p) {
        prospectId = p.id;
        person = { name: `${p.firstName} ${p.lastName}`.trim(), title: p.title, company: p.company, email: p.email, tz: timezoneForRegion(p.state, p.country) };
      }
    } else if (row.relatedType === "contact") {
      const [c] = await db.select().from(contacts).where(and(eq(contacts.id, row.relatedId), eq(contacts.workspaceId, wsId))).limit(1);
      if (c) person = { name: `${(c as any).firstName ?? ""} ${(c as any).lastName ?? ""}`.trim() || null, title: (c as any).title ?? null, company: null, email: c.email, tz: null };
    } else if (row.relatedType === "lead") {
      const [l] = await db.select().from(leads).where(and(eq(leads.id, row.relatedId), eq(leads.workspaceId, wsId))).limit(1);
      if (l) person = { name: `${(l as any).firstName ?? ""} ${(l as any).lastName ?? ""}`.trim() || null, title: (l as any).title ?? null, company: (l as any).company ?? null, email: l.email, tz: null };
    }
  }

  const brand = await buildBrandContext(wsId).catch(() => "");
  const instructions = buildCallInstructions({
    direction,
    agentName: agent.name,
    ownerName,
    companyName,
    brand,
    agentInstructions: agent.instructions,
    callNotes: request?.callNotes ?? null,
    person: person.name || person.company ? person : null,
    canBook,
  });

  return {
    workspaceId: wsId,
    callRowId,
    direction,
    agentName: agent.name,
    voice: agent.voice,
    model: agent.model || DEFAULT_CALL_MODEL,
    apiKey,
    instructions,
    tools: callTools(canBook),
    canBook,
    ownerUserId,
    ownerName,
    companyName,
    otherNumber: direction === "outbound" ? (request?.toNumber ?? row.toNumber) : row.fromNumber,
    prospectId,
    personName: person.name,
    personCompany: person.company,
    emailOnFile: person.email,
    personTz: person.tz ?? wsTz,
    requestId: request?.id ?? null,
    plivoCallUuid: row.plivoCallUuid,
  };
}

/* ── the real dependencies ────────────────────────────────────────────── */

export const realDeps: SessionDeps = {
  async findTimes(ctx) {
    if (!ctx.ownerUserId) return [];
    const { slots } = await openSlotsForOwner(ctx.workspaceId, ctx.ownerUserId, 3);
    return slots.map((iso, i) => ({ option: String.fromCharCode(65 + i), iso, spoken: spokenTime(iso, ctx.personTz) }));
  },

  /**
   * One meeting row per call: a proposal with the agreed time, then the same
   * sendMeetingInvite every invite goes through (calendar check, per-day cap,
   * one live invite per person). It stays `invited` until they accept in
   * their calendar: owner rule 2026-09-24, "Count bookings only when the
   * prospect accepts".
   */
  async book(ctx, iso, email, meetingId) {
    const db = await getDb();
    if (!db) return { ok: false, meetingId, reason: "provider_error" };
    let id = meetingId;
    const name = ctx.personName || "there";
    const fields = {
      contactEmail: email,
      proposedTimes: [iso],
      inviteMessage: `Thanks for taking the call. Here is the invite for the time we agreed: ${spokenTime(iso, ctx.personTz)}.`,
    };
    if (id) {
      await db.update(meetings).set(fields as never).where(and(eq(meetings.id, id), eq(meetings.workspaceId, ctx.workspaceId)));
    } else {
      const ins = await db.insert(meetings).values({
        workspaceId: ctx.workspaceId,
        ownerUserId: ctx.ownerUserId,
        relatedType: ctx.prospectId ? "prospect" : null,
        relatedId: ctx.prospectId,
        contactName: name,
        company: ctx.personCompany,
        title: `${ctx.companyName} <> ${ctx.personCompany || name} intro`.slice(0, 200),
        status: "proposed",
        durationMin: 30,
        source: "ai",
        aiReasoning: `Agreed on an AI phone call (call #${ctx.callRowId}).`,
        ...fields,
      } as never);
      id = Number((ins as any)[0]?.insertId ?? (ins as any)?.insertId ?? 0) || null;
    }
    if (!id) return { ok: false, meetingId: null, reason: "provider_error" };
    const sent = await sendMeetingInvite(ctx.workspaceId, id, iso);
    return { ok: sent.sent, meetingId: id, reason: sent.reason };
  },

  async doNotCall(ctx) {
    if (ctx.otherNumber) await suppressNumber(ctx.workspaceId, ctx.otherNumber, "asked_on_call", ctx.prospectId, null);
  },

  async hangup(ctx) {
    const creds = await plivoCreds(ctx.workspaceId);
    const db = await getDb();
    const [row] = db ? await db.select({ uuid: voiceCalls.plivoCallUuid }).from(voiceCalls).where(eq(voiceCalls.id, ctx.callRowId)).limit(1) : [];
    if (creds) await hangupCall(creds, row?.uuid ?? ctx.plivoCallUuid);
  },

  async finalize(ctx, f) {
    await finalizeRelayedCall(ctx, f);
  },

  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (t) => clearTimeout(t as NodeJS.Timeout),
};

const RESULT_TITLE: Record<string, string> = {
  booked: "meeting booked",
  not_interested: "not interested",
  call_back: "asked for a call back",
  wrong_person: "wrong person",
  do_not_call: "asked not to be called again",
  no_decision: "no decision",
};

/** Write what happened onto the call row, the request, the timeline, and tell the owner. */
export async function finalizeRelayedCall(
  ctx: CallContext,
  f: { transcript: string[]; result: CallResult | null; note: string | null; meetingId: number | null; answered: boolean },
): Promise<void> {
  const db = await getDb();
  if (!db) return;
  const [row] = await db.select().from(voiceCalls).where(eq(voiceCalls.id, ctx.callRowId)).limit(1);
  if (!row) return;
  const ended = new Date();
  const started = row.startedAt ? new Date(row.startedAt).getTime() : ended.getTime();
  const outcome = [
    f.result ? `Result: ${RESULT_TITLE[f.result] ?? f.result}` : null,
    f.note,
    f.transcript.length ? f.transcript.join("\n") : null,
  ].filter(Boolean).join("\n\n") || null;
  // The hangup callback may already have set voicemail/no_answer/busy: keep it.
  const live = ["queued", "ringing", "in_progress"].includes(row.status);
  await db.update(voiceCalls).set({
    ...(live ? { status: f.answered ? "completed" : "failed" } : {}),
    outcome: outcome?.slice(0, 8000) ?? row.outcome,
    result: f.result ?? row.result,
    meetingId: f.meetingId ?? row.meetingId,
    endedAt: row.endedAt ?? ended,
    durationSec: row.durationSec ?? Math.max(0, Math.round((ended.getTime() - started) / 1000)),
  }).where(eq(voiceCalls.id, ctx.callRowId));
  await finishRequestForCall(ctx.callRowId);

  if (!f.answered) return;
  await logCallActivity(ctx.callRowId, ctx.agentName).catch((e) => console.error("[VoiceRelay] activity log failed:", e));
  const notifyUserId = ctx.ownerUserId ?? (await workspaceNotifyUserId(ctx.workspaceId));
  if (notifyUserId) {
    const who = ctx.personName || ctx.otherNumber || "a caller";
    await db.insert(notifications).values({
      workspaceId: ctx.workspaceId,
      userId: notifyUserId,
      kind: "system",
      title: `AI call ${ctx.direction === "outbound" ? "to" : "from"} ${who}: ${RESULT_TITLE[f.result ?? "no_decision"] ?? "finished"}`,
      body: f.result === "booked"
        ? `${ctx.agentName} booked a meeting with ${who}. The invite is out; it counts once they accept.`
        : `${ctx.agentName} finished a call with ${who}.${f.note ? ` Note: ${f.note}` : ""}`,
      relatedType: "voice_call",
      relatedId: ctx.callRowId,
    }).catch(() => {});
  }
}

const STATUS_RESULT: Record<string, string> = { voicemail: "voicemail", no_answer: "no_answer", busy: "busy", failed: "failed", canceled: "failed" };

/** Close the request a call carried out (idempotent; either the relay or the hangup callback gets here first). */
export async function finishRequestForCall(callRowId: number): Promise<void> {
  const db = await getDb();
  if (!db) return;
  const [row] = await db.select({ requestId: voiceCalls.requestId, status: voiceCalls.status, result: voiceCalls.result, workspaceId: voiceCalls.workspaceId })
    .from(voiceCalls).where(eq(voiceCalls.id, callRowId)).limit(1);
  if (!row?.requestId) return;
  const result = row.result ?? STATUS_RESULT[row.status] ?? (row.status === "completed" ? "no_decision" : null);
  if (!result) return; // still live
  await db.update(voiceCallRequests).set({ status: "done", result, voiceCallId: callRowId })
    .where(and(eq(voiceCallRequests.id, row.requestId), eq(voiceCallRequests.workspaceId, row.workspaceId), inArray(voiceCallRequests.status, ["dialing", "approved"])));
  // A later, better answer (the relay's result after a bare hangup) still lands.
  await db.update(voiceCallRequests).set({ result })
    .where(and(eq(voiceCallRequests.id, row.requestId), eq(voiceCallRequests.workspaceId, row.workspaceId), eq(voiceCallRequests.status, "done")));
}

/* ── wiring to the real sockets ───────────────────────────────────────── */

/** Plivo's audio socket for call row `callRowId` is open (token already checked). */
export async function startRelay(plivoWs: WebSocket, callRowId: number): Promise<void> {
  const ctx = await loadCallContext(callRowId).catch((e) => { console.error("[VoiceRelay] context failed:", e); return null; });
  if (!ctx) {
    try { plivoWs.close(); } catch { /* noop */ }
    const db = await getDb();
    await db?.update(voiceCalls).set({ status: "failed", outcome: "Could not start the agent (no xAI key, or the agent is gone).", endedAt: new Date() })
      .where(eq(voiceCalls.id, callRowId)).catch(() => {});
    await finishRequestForCall(callRowId).catch(() => {});
    return;
  }
  const db = await getDb();
  await db?.update(voiceCalls).set({ status: "in_progress" }).where(and(eq(voiceCalls.id, callRowId), inArray(voiceCalls.status, ["queued", "ringing"])));

  const xaiWs = new WebSocket(`${XAI_REALTIME}?model=${encodeURIComponent(ctx.model)}`, { headers: { Authorization: `Bearer ${ctx.apiKey}` } });
  const session = new CallSession(
    ctx,
    { send: (d) => { if (plivoWs.readyState === WebSocket.OPEN) plivoWs.send(d); }, close: () => plivoWs.close() },
    { send: (d) => { if (xaiWs.readyState === WebSocket.OPEN) xaiWs.send(d); }, close: () => xaiWs.close() },
    realDeps,
  );
  xaiWs.on("open", () => session.onXaiOpen());
  xaiWs.on("message", (buf) => { void session.onXaiMessage(buf.toString()); });
  xaiWs.on("close", () => session.onXaiClosed());
  xaiWs.on("error", (err) => { console.error("[VoiceRelay] xAI socket error:", err.message); session.onXaiClosed(); });
  plivoWs.on("message", (buf) => session.onPlivoMessage(buf.toString()));
  plivoWs.on("close", () => { void session.finish(); });
  plivoWs.on("error", () => { void session.finish(); });
}
