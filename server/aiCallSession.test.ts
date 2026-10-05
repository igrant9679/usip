/**
 * One live AI call (services/voiceRelay.ts CallSession), driven with fake
 * sockets: audio passes through untouched, the agent waits for "hello" on
 * outbound calls, barge-in stops playback, it can only book a time Velocity
 * offered, "don't call me" sticks, and the call always ends and is recorded
 * exactly once.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./db", () => ({ getDb: async () => null }));

import { CallSession, type CallContext, type SessionDeps } from "./services/voiceRelay";
import { MAX_CALL_MS } from "./services/voiceGuards";

const ctx = (over: Partial<CallContext> = {}): CallContext => ({
  workspaceId: 4,
  callRowId: 77,
  direction: "outbound",
  agentName: "Ava",
  voice: "eve",
  model: "grok-voice-think-fast-2.0",
  apiKey: "k",
  instructions: "INSTR",
  tools: [{ type: "function", name: "end_call" }],
  canBook: true,
  ownerUserId: 5721,
  ownerName: "Khaja Syed",
  companyName: "CommunityForce",
  otherNumber: "+14155550100",
  prospectId: 9,
  personName: "Dana Lee",
  personCompany: "Acme",
  emailOnFile: "dana@acme.com",
  personTz: "America/Chicago",
  requestId: 3,
  plivoCallUuid: "uuid-1",
  ...over,
});

type Timer = { fn: () => void; ms: number; cleared: boolean };

function harness(c: CallContext = ctx(), depOver: Partial<SessionDeps> = {}) {
  const plivoOut: any[] = [];
  const xaiOut: any[] = [];
  const timers: Timer[] = [];
  const deps: SessionDeps = {
    findTimes: vi.fn(async () => [
      { option: "A", iso: "2026-10-07T14:00:00Z", spoken: "Wednesday, October 7 at 9:00 AM CDT" },
      { option: "B", iso: "2026-10-08T19:00:00Z", spoken: "Thursday, October 8 at 2:00 PM CDT" },
    ]),
    book: vi.fn(async () => ({ ok: true, meetingId: 501 })),
    doNotCall: vi.fn(async () => {}),
    searchKnowledge: vi.fn(async () => [{ title: "Pricing.pdf", page: 2, content: "Enterprise: $2,400 a year." }]),
    hangup: vi.fn(async () => {}),
    finalize: vi.fn(async () => {}),
    setTimeout: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; },
    clearTimeout: (t) => { (t as Timer).cleared = true; },
    ...depOver,
  };
  const plivo = { send: (d: string) => plivoOut.push(JSON.parse(d)), close: vi.fn() };
  const xai = { send: (d: string) => xaiOut.push(JSON.parse(d)), close: vi.fn() };
  const s = new CallSession(c, plivo, xai, deps);
  const fire = (ms: number) => timers.filter((t) => t.ms === ms && !t.cleared).forEach((t) => t.fn());
  const fromPlivo = (o: unknown) => s.onPlivoMessage(JSON.stringify(o));
  const fromXai = (o: unknown) => s.onXaiMessage(JSON.stringify(o));
  return { s, deps, plivoOut, xaiOut, timers, fire, fromPlivo, fromXai, plivo, xai };
}

const types = (arr: any[]) => arr.map((m) => m.type ?? m.event);
async function ready(h: ReturnType<typeof harness>) {
  h.s.onXaiOpen();
  h.fromPlivo({ event: "start", start: { streamId: "st-1", callId: "uuid-1" } });
  await h.fromXai({ type: "session.updated" });
}
async function toolCall(h: ReturnType<typeof harness>, name: string, args: unknown, callId = "fc1") {
  await h.fromXai({ type: "response.function_call_arguments.done", name, call_id: callId, arguments: JSON.stringify(args) });
  await h.fromXai({ type: "response.done" });
  const out = [...h.xaiOut].reverse().find((m) => m.type === "conversation.item.create" && m.item?.call_id === callId);
  return JSON.parse(out.item.output);
}

describe("session setup and audio", () => {
  it("configures G.711 μ-law both ways, server VAD and the tools", () => {
    const h = harness();
    h.s.onXaiOpen();
    expect(h.xaiOut[0]).toEqual({
      type: "session.update",
      session: {
        voice: "eve",
        instructions: "INSTR",
        audio: { input: { format: { type: "audio/pcmu" } }, output: { format: { type: "audio/pcmu" } } },
        turn_detection: { type: "server_vad" },
        tools: [{ type: "function", name: "end_call" }],
      },
    });
  });

  it("holds caller audio until the session is configured, then passes it through untouched", async () => {
    const h = harness();
    h.s.onXaiOpen();
    h.fromPlivo({ event: "start", start: { streamId: "st-1" } });
    h.fromPlivo({ event: "media", media: { track: "inbound", payload: "AAAA" } });
    expect(types(h.xaiOut)).toEqual(["session.update"]);
    await h.fromXai({ type: "session.updated" });
    h.fromPlivo({ event: "media", media: { track: "inbound", payload: "BBBB" } });
    h.fromPlivo({ event: "media", media: { track: "outbound", payload: "CCCC" } }); // not the caller
    expect(h.xaiOut.filter((m) => m.type === "input_audio_buffer.append").map((m) => m.audio)).toEqual(["AAAA", "BBBB"]);
  });

  it("plays the agent's audio back as μ-law in pieces Plivo accepts", async () => {
    const h = harness();
    await ready(h);
    const big = "Q".repeat(40000);
    await h.fromXai({ type: "response.output_audio.delta", delta: big });
    const plays = h.plivoOut.filter((m) => m.event === "playAudio");
    expect(plays.map((p) => p.media.payload.length)).toEqual([16000, 16000, 8000]);
    expect(plays[0].media).toMatchObject({ contentType: "audio/x-mulaw", sampleRate: 8000 });
    expect(plays.map((p) => p.media.payload).join("")).toBe(big);
  });

  it("barge-in: when the person starts talking, playback stops", async () => {
    const h = harness();
    await ready(h);
    await h.fromXai({ type: "input_audio_buffer.speech_started" });
    expect(h.plivoOut).toContainEqual({ event: "clearAudio", streamId: "st-1" });
  });
});

describe("who speaks first", () => {
  it("outbound: waits for the person; speaks after 4 s of silence", async () => {
    const h = harness();
    await ready(h);
    expect(types(h.xaiOut)).not.toContain("response.create");
    h.fire(4000);
    expect(types(h.xaiOut)).toContain("response.create");
  });
  it("outbound: does not talk over a person who already said hello", async () => {
    const h = harness();
    await ready(h);
    await h.fromXai({ type: "input_audio_buffer.speech_started" });
    h.fire(4000);
    expect(types(h.xaiOut)).not.toContain("response.create");
  });
  it("inbound: the agent greets at once", async () => {
    const h = harness(ctx({ direction: "inbound" }));
    await ready(h);
    expect(types(h.xaiOut)).toContain("response.create");
  });
});

describe("booking", () => {
  let h: ReturnType<typeof harness>;
  beforeEach(async () => { h = harness(); await ready(h); });

  it("offers only the times Velocity found, by letter", async () => {
    const out = await toolCall(h, "find_meeting_times", {});
    expect(out).toEqual({ options: [
      { option: "A", time: "Wednesday, October 7 at 9:00 AM CDT" },
      { option: "B", time: "Thursday, October 8 at 2:00 PM CDT" },
    ] });
    // One response.create after the outputs, so the agent carries on.
    expect(types(h.xaiOut).filter((t) => t === "response.create")).toHaveLength(1);
  });

  it("refuses an option it never offered", async () => {
    const out = await toolCall(h, "book_meeting", { option: "D", email: "dana@acme.com" });
    expect(out.ok).toBe(false);
    expect(out.error).toContain("not one of the offered options");
    expect(h.deps.book).not.toHaveBeenCalled();
  });

  it("refuses a misheard email before anything is sent", async () => {
    const out = await toolCall(h, "book_meeting", { option: "A", email: "dana at acme" });
    expect(out.ok).toBe(false);
    expect(out.error).toContain("spell it");
    expect(h.deps.book).not.toHaveBeenCalled();
  });

  it("books the chosen offered time for the confirmed email", async () => {
    const out = await toolCall(h, "book_meeting", { option: "b", email: "Dana@Acme.com" });
    expect(out).toMatchObject({ ok: true, booked: "Thursday, October 8 at 2:00 PM CDT", invite_sent_to: "dana@acme.com" });
    expect(h.deps.book).toHaveBeenCalledWith(expect.objectContaining({ callRowId: 77 }), "2026-10-08T19:00:00Z", "dana@acme.com", null);
  });

  it("a time taken meanwhile is dropped from the offer and the agent is told to offer another", async () => {
    (h.deps.book as any).mockResolvedValueOnce({ ok: false, meetingId: 501, reason: "time_taken" });
    const out = await toolCall(h, "book_meeting", { option: "A", email: "dana@acme.com" }, "fc1");
    expect(out.error).toContain("offer one of the other times");
    const again = await toolCall(h, "find_meeting_times", {}, "fc2");
    expect(again.options.map((o: any) => o.option)).toEqual(["B"]);
    // The retry reuses the same meeting row.
    await toolCall(h, "book_meeting", { option: "B", email: "dana@acme.com" }, "fc3");
    expect((h.deps.book as any).mock.calls[1][3]).toBe(501);
  });

  it("searches the knowledge base and hands back short, sourced passages", async () => {
    const out = await toolCall(h, "search_knowledge", { query: "enterprise price" });
    expect(h.deps.searchKnowledge).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 4 }), "enterprise price");
    expect(out).toEqual({ passages: [{ source: "Pricing.pdf, p. 2", text: "Enterprise: $2,400 a year." }] });
    (h.deps.searchKnowledge as any).mockResolvedValueOnce([]);
    const none = await toolCall(h, "search_knowledge", { query: "warranty on hardware" }, "fc2");
    expect(none.note).toContain("the team will follow up");
    const empty = await toolCall(h, "search_knowledge", { query: "  " }, "fc3");
    expect(empty.passages).toEqual([]);
  });

  it("cannot book when the owner has no calendar", async () => {
    const g = harness(ctx({ canBook: false }));
    await ready(g);
    const out = await toolCall(g, "book_meeting", { option: "A", email: "dana@acme.com" });
    expect(out.ok).toBe(false);
    expect(g.deps.book).not.toHaveBeenCalled();
    expect(g.deps.findTimes).not.toHaveBeenCalled();
  });
});

describe("ending the call", () => {
  it("end_call: waits for the goodbye to play, then hangs up and records the result once", async () => {
    const h = harness();
    await ready(h);
    await toolCall(h, "end_call", { result: "not_interested", note: "Using a competitor" });
    expect(h.plivoOut).toContainEqual({ event: "checkpoint", streamId: "st-1", name: "goodbye" });
    // No response.create after end_call: the agent has said goodbye.
    expect(types(h.xaiOut)).not.toContain("response.create");
    expect(h.deps.hangup).not.toHaveBeenCalled();
    h.fromPlivo({ event: "playedStream", name: "goodbye" });
    await Promise.resolve();
    expect(h.deps.hangup).toHaveBeenCalledTimes(1);
    await h.s.finish(); // the stream closing afterwards
    expect(h.deps.finalize).toHaveBeenCalledTimes(1);
    expect((h.deps.finalize as any).mock.calls[0][1]).toMatchObject({ result: "not_interested", note: "Using a competitor", answered: true });
  });

  it("end_call: hangs up anyway if the goodbye checkpoint never comes back", async () => {
    const h = harness();
    await ready(h);
    await toolCall(h, "end_call", { result: "call_back", note: "Try Friday" });
    h.fire(8000);
    expect(h.deps.hangup).toHaveBeenCalledTimes(1);
  });

  it("a booking or a do-not-call request outranks what end_call says", async () => {
    const h = harness();
    await ready(h);
    await toolCall(h, "mark_do_not_call", {}, "f1");
    expect(h.deps.doNotCall).toHaveBeenCalledTimes(1);
    await toolCall(h, "end_call", { result: "not_interested" }, "f2");
    h.fromPlivo({ event: "playedStream", name: "goodbye" });
    await new Promise((r) => setTimeout(r, 0));
    expect((h.deps.finalize as any).mock.calls[0][1].result).toBe("do_not_call");

    const b = harness();
    await ready(b);
    await toolCall(b, "book_meeting", { option: "A", email: "dana@acme.com" }, "f1");
    await toolCall(b, "end_call", { result: "no_decision" }, "f2");
    b.fire(8000);
    await new Promise((r) => setTimeout(r, 0));
    expect((b.deps.finalize as any).mock.calls[0][1]).toMatchObject({ result: "booked", meetingId: 501 });
  });

  it("an unknown end_call result is recorded as no decision", async () => {
    const h = harness();
    await ready(h);
    await toolCall(h, "end_call", { result: "hostile_takeover" });
    h.fire(8000);
    await new Promise((r) => setTimeout(r, 0));
    expect((h.deps.finalize as any).mock.calls[0][1].result).toBe("no_decision");
  });

  it("the 30-minute cap hangs up", async () => {
    const h = harness();
    await ready(h);
    h.fire(MAX_CALL_MS);
    await new Promise((r) => setTimeout(r, 0));
    expect(h.deps.hangup).toHaveBeenCalledTimes(1);
    expect((h.deps.finalize as any).mock.calls[0][1].note).toContain("30-minute safety cap");
  });

  it("if xAI drops, the call ends rather than leaving the person in silence", async () => {
    const h = harness();
    await ready(h);
    h.s.onXaiClosed();
    await new Promise((r) => setTimeout(r, 0));
    expect(h.deps.hangup).toHaveBeenCalledTimes(1);
    expect(h.plivo.close).toHaveBeenCalled();
    expect(h.deps.finalize).toHaveBeenCalledTimes(1);
  });

  it("when the person hangs up, xAI is closed (it bills by the minute) and the call is recorded once", async () => {
    const h = harness();
    await ready(h);
    await h.fromXai({ type: "response.output_audio_transcript.done", transcript: "Hi, this is Ava." });
    await h.fromXai({ type: "conversation.item.input_audio_transcription.completed", transcript: "Not now, thanks." });
    await h.s.finish();
    await h.s.finish();
    expect(h.xai.close).toHaveBeenCalled();
    expect(h.deps.finalize).toHaveBeenCalledTimes(1);
    expect((h.deps.finalize as any).mock.calls[0][1].transcript).toEqual(["Agent: Hi, this is Ava.", "Person: Not now, thanks."]);
    expect(h.timers.every((t) => t.cleared)).toBe(true);
  });

  it("a call that never connected is recorded as not answered", async () => {
    const h = harness();
    h.s.onXaiOpen();
    await h.s.finish();
    expect((h.deps.finalize as any).mock.calls[0][1].answered).toBe(false);
  });
});
