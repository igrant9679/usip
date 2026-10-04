/**
 * Security audit of the xAI voice integration (2026-10-04).
 *
 *   1. The webhook only acts on a call signed by a stored secret, signed in
 *      the last 5 minutes. The unsigned "match on the To header" fallback is
 *      gone: it let anyone who knew an agent's number forge a call.
 *   2. A call id is answered once, however often xAI delivers it.
 *   3. Spend limits: calls at once, calls per number per hour, minutes per
 *      day. A refused call is logged, hung up, and never bridged.
 *   4. The bridge hangs up in xAI whenever it stops controlling a call, and
 *      a sweep hangs up calls whose bridge was lost to a restart.
 */
import crypto from "crypto";
import { readFileSync } from "fs";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { notifications, voiceAgents, voiceCalls, workspaceSettings } from "../drizzle/schema";

type Row = Record<string, unknown>;
const state: {
  agents: Row[];
  seen: Row[];
  recent: Row[];
  stale: Row[];
  inserts: { table: unknown; v: Row }[];
  updates: { table: unknown; v: Row }[];
} = { agents: [], seen: [], recent: [], stale: [], inserts: [], updates: [] };

const fakeDb = {
  select: (cols?: Record<string, unknown>) => ({
    from: (table: unknown) => {
      const rows = (): Row[] => {
        if (table === voiceAgents) return state.agents;
        if (table === workspaceSettings) return [{ enc: "xai-test-key" }];
        if (table === voiceCalls) {
          const keys = Object.keys(cols ?? {});
          if (keys.includes("outcome")) return state.stale; // sweep
          if (keys.includes("status")) return state.recent; // admission
          return state.seen; // duplicate check
        }
        return [];
      };
      const q: any = {
        where: () => q,
        limit: () => Promise.resolve(rows()),
        then: (res: (v: Row[]) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(rows()).then(res, rej),
      };
      return q;
    },
  }),
  insert: (table: unknown) => ({
    values: (v: Row) => {
      state.inserts.push({ table, v });
      return Promise.resolve({ insertId: 77 });
    },
  }),
  update: (table: unknown) => ({
    set: (v: Row) => ({
      where: () => {
        state.updates.push({ table, v });
        return Promise.resolve();
      },
    }),
  }),
};

vi.mock("./db", () => ({ getDb: async () => fakeDb }));
// Secrets are stored encrypted; here the "encrypted" value is the secret itself.
vi.mock("./_core/crypto", () => ({ tryDecryptSecret: (v: unknown) => (typeof v === "string" ? v : "") }));
vi.mock("./_core/activeMembers", () => ({
  activeOwnerOrNull: async (_ws: number, id: number | null) => id ?? null,
  workspaceNotifyUserId: async () => 9,
}));
vi.mock("./services/voiceBridge", () => ({ answerInboundCall: vi.fn() }));
vi.mock("./services/voiceCrmLink", () => ({ matchCallerToRecord: async () => null }));

import { answerInboundCall } from "./services/voiceBridge";
import { registerVoiceWebhookRoutes, verifySvixSignature, WEBHOOK_TOLERANCE_SEC } from "./voiceWebhook";
import {
  decideAdmission,
  MAX_AGENT_MINUTES_PER_DAY,
  MAX_CALL_MS,
  MAX_CALLS_PER_CALLER_PER_HOUR,
  MAX_CONCURRENT_CALLS_PER_WORKSPACE,
  STALE_CALL_MS,
  sweepStaleVoiceCalls,
} from "./services/voiceGuards";

// A test-only HMAC key, not a credential for anything.
const SECRET = "whsec_" + Buffer.from("test-only-voice-webhook-key").toString("base64");
const OTHER_SECRET = "whsec_" + Buffer.from("some-other-test-key").toString("base64");

function sign(id: string, ts: string, body: string, secret = SECRET): string {
  const key = Buffer.from(secret.slice(6), "base64");
  return "v1," + crypto.createHmac("sha256", key).update(`${id}.${ts}.${body}`).digest("base64");
}

const nowSec = () => String(Math.floor(Date.now() / 1000));

let handler: (req: unknown, res: unknown) => Promise<void>;
registerVoiceWebhookRoutes({ post: (_p: string, h: typeof handler) => { handler = h; } } as never);

function incoming(callId = "call-1", from = "+14155550100", to = "+18005550199") {
  return {
    object: "event",
    type: "realtime.call.incoming",
    data: { call_id: callId, sip_headers: [{ name: "From", value: from }, { name: "To", value: to }] },
  };
}

async function deliver(body: unknown, headers: Record<string, string>, rawOverride?: string) {
  const raw = rawOverride ?? JSON.stringify(body);
  const req = { body, rawBody: Buffer.from(raw), headers };
  const out: { status: number; json: any } = { status: 0, json: null };
  const res = {
    status(c: number) { out.status = c; return res; },
    json(j: unknown) { out.json = j; return res; },
  };
  await handler(req, res);
  return out;
}

function signedHeaders(body: unknown, ts = nowSec(), secret = SECRET) {
  const raw = JSON.stringify(body);
  return { "webhook-id": "msg_1", "webhook-timestamp": ts, "webhook-signature": sign("msg_1", ts, raw, secret) };
}

const agentWithSecret = { id: 1, workspaceId: 5, ownerUserId: 2, name: "Line", status: "active", phoneNumber: "+18005550199", sipWebhookSecretEnc: SECRET };
const agentWithoutSecret = { id: 2, workspaceId: 6, ownerUserId: 3, name: "Open line", status: "active", phoneNumber: "+18005550123", sipWebhookSecretEnc: null };

const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));

beforeEach(() => {
  state.agents = [agentWithSecret, agentWithoutSecret];
  state.seen = [];
  state.recent = [];
  state.stale = [];
  state.inserts = [];
  state.updates = [];
  vi.mocked(answerInboundCall).mockClear();
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const flush = () => new Promise((r) => setTimeout(r, 0));
const hangups = () => fetchMock.mock.calls.filter((c) => String(c[0]).includes("/hangup"));
const callInserts = () => state.inserts.filter((i) => i.table === voiceCalls);

describe("verifySvixSignature", () => {
  const body = '{"type":"realtime.call.incoming"}';

  it("accepts a fresh, correct signature", () => {
    const ts = nowSec();
    expect(verifySvixSignature(SECRET, "msg_1", ts, body, sign("msg_1", ts, body))).toBe(true);
  });

  it("accepts when any of several space-separated signatures matches (secret rotation)", () => {
    const ts = nowSec();
    const header = `${sign("msg_1", ts, body, OTHER_SECRET)} ${sign("msg_1", ts, body)}`;
    expect(verifySvixSignature(SECRET, "msg_1", ts, body, header)).toBe(true);
  });

  it("rejects a tampered body, a wrong secret, and a different message id", () => {
    const ts = nowSec();
    const sig = sign("msg_1", ts, body);
    expect(verifySvixSignature(SECRET, "msg_1", ts, body + " ", sig)).toBe(false);
    expect(verifySvixSignature(OTHER_SECRET, "msg_1", ts, body, sig)).toBe(false);
    expect(verifySvixSignature(SECRET, "msg_2", ts, body, sig)).toBe(false);
  });

  it("rejects a replay: a correctly signed timestamp older or newer than 5 minutes", () => {
    const now = Date.now();
    const old = String(Math.floor(now / 1000) - WEBHOOK_TOLERANCE_SEC - 60);
    const future = String(Math.floor(now / 1000) + WEBHOOK_TOLERANCE_SEC + 60);
    const edge = String(Math.floor(now / 1000) - WEBHOOK_TOLERANCE_SEC + 5);
    expect(verifySvixSignature(SECRET, "msg_1", old, body, sign("msg_1", old, body), now)).toBe(false);
    expect(verifySvixSignature(SECRET, "msg_1", future, body, sign("msg_1", future, body), now)).toBe(false);
    expect(verifySvixSignature(SECRET, "msg_1", edge, body, sign("msg_1", edge, body), now)).toBe(true);
    expect(WEBHOOK_TOLERANCE_SEC).toBe(300);
  });

  it("rejects missing or malformed headers", () => {
    const ts = nowSec();
    const sig = sign("msg_1", ts, body);
    expect(verifySvixSignature(SECRET, "", ts, body, sig)).toBe(false);
    expect(verifySvixSignature(SECRET, "msg_1", "", body, sig)).toBe(false);
    expect(verifySvixSignature(SECRET, "msg_1", "12abc", body, sig)).toBe(false);
    expect(verifySvixSignature(SECRET, "msg_1", ts, body, "")).toBe(false);
    expect(verifySvixSignature("", "msg_1", ts, body, sig)).toBe(false);
  });

  it("compares in constant time", () => {
    const src = readFileSync(path.join(__dirname, "voiceWebhook.ts"), "utf8");
    expect(src).toContain("crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))");
  });
});

describe("the webhook", () => {
  it("answers a correctly signed call", async () => {
    const body = incoming();
    const out = await deliver(body, signedHeaders(body));
    expect(out.status).toBe(200);
    expect(out.json).toMatchObject({ ok: true, answered: true });
    expect(answerInboundCall).toHaveBeenCalledTimes(1);
    expect(callInserts()[0].v).toMatchObject({ workspaceId: 5, agentId: 1, status: "ringing", xaiCallId: "call-1" });
  });

  it("rejects an unsigned call to an agent saved without a secret (no To-header fallback)", async () => {
    const body = incoming("forged", "+14155550100", agentWithoutSecret.phoneNumber);
    const out = await deliver(body, {});
    expect(out.status).toBe(401);
    expect(answerInboundCall).not.toHaveBeenCalled();
    expect(state.inserts).toHaveLength(0);
  });

  it("rejects a call signed with a secret no agent holds", async () => {
    const body = incoming();
    const out = await deliver(body, signedHeaders(body, nowSec(), OTHER_SECRET));
    expect(out.status).toBe(401);
    expect(answerInboundCall).not.toHaveBeenCalled();
    expect(state.inserts).toHaveLength(0);
  });

  it("rejects a replayed delivery signed 10 minutes ago", async () => {
    const body = incoming();
    const out = await deliver(body, signedHeaders(body, String(Math.floor(Date.now() / 1000) - 600)));
    expect(out.status).toBe(401);
    expect(answerInboundCall).not.toHaveBeenCalled();
  });

  it("answers a call id once: a repeat delivery is acknowledged and ignored", async () => {
    state.seen = [{ id: 40 }];
    const body = incoming();
    const out = await deliver(body, signedHeaders(body));
    expect(out.status).toBe(200);
    expect(out.json).toMatchObject({ duplicate: true });
    expect(answerInboundCall).not.toHaveBeenCalled();
    expect(state.inserts).toHaveLength(0);
  });

  it("refuses an oversized body before trying any secret", async () => {
    const body = incoming();
    const out = await deliver(body, signedHeaders(body), "x".repeat(70 * 1024));
    expect(out.status).toBe(413);
    expect(state.inserts).toHaveLength(0);
  });

  it("over the concurrency limit: logged as failed with the reason, hung up, never bridged, owner told", async () => {
    const started = new Date(Date.now() - 60_000);
    state.recent = Array.from({ length: MAX_CONCURRENT_CALLS_PER_WORKSPACE }, () => ({ status: "in_progress", startedAt: started, durationSec: null, fromNumber: "+12125550000" }));
    const body = incoming("call-9");
    const out = await deliver(body, signedHeaders(body));
    await flush();
    expect(out.status).toBe(200);
    expect(out.json).toMatchObject({ answered: false });
    expect(answerInboundCall).not.toHaveBeenCalled();
    expect(callInserts()[0].v).toMatchObject({ status: "failed", durationSec: 0 });
    expect(String(callInserts()[0].v.outcome)).toContain("already in progress");
    expect(hangups().map((c) => String(c[0]))).toEqual(["https://api.x.ai/v1/realtime/calls/call-9/hangup"]);
    const note = state.inserts.find((i) => i.table === notifications);
    expect(String(note?.v.title)).toContain("not answered");
  });

  it("a number ringing over and over is refused without a notification each time", async () => {
    const started = new Date(Date.now() - 5 * 60_000);
    state.recent = Array.from({ length: MAX_CALLS_PER_CALLER_PER_HOUR }, () => ({ status: "completed", startedAt: started, durationSec: 20, fromNumber: "+1 (415) 555-0100" }));
    const body = incoming("call-10", "+14155550100");
    const out = await deliver(body, signedHeaders(body));
    expect(out.json).toMatchObject({ answered: false });
    expect(answerInboundCall).not.toHaveBeenCalled();
    expect(state.inserts.find((i) => i.table === notifications)).toBeUndefined();
  });
});

describe("decideAdmission", () => {
  const now = Date.UTC(2026, 9, 4, 15, 0, 0);
  const ago = (ms: number) => new Date(now - ms);
  const MIN = 60_000;

  it("answers when nothing is going on", () => {
    expect(decideAdmission([], "+14155550100", now)).toEqual({ ok: true });
  });

  it("counts live calls, but not a 'live' row older than one call length (a lost bridge)", () => {
    const live = (n: number, age: number) => Array.from({ length: n }, () => ({ status: "in_progress", startedAt: ago(age), durationSec: null, fromNumber: null }));
    expect(decideAdmission(live(MAX_CONCURRENT_CALLS_PER_WORKSPACE - 1, MIN), null, now).ok).toBe(true);
    expect(decideAdmission(live(MAX_CONCURRENT_CALLS_PER_WORKSPACE, MIN), null, now)).toMatchObject({ ok: false, code: "concurrency" });
    expect(decideAdmission(live(MAX_CONCURRENT_CALLS_PER_WORKSPACE, MAX_CALL_MS + MIN), null, now).ok).toBe(true);
  });

  it("limits calls from one number per hour, whatever the number's formatting", () => {
    const calls = (n: number, age: number) => Array.from({ length: n }, () => ({ status: "completed", startedAt: ago(age), durationSec: 30, fromNumber: "+1 (415) 555-0100" }));
    expect(decideAdmission(calls(MAX_CALLS_PER_CALLER_PER_HOUR - 1, 10 * MIN), "14155550100", now).ok).toBe(true);
    expect(decideAdmission(calls(MAX_CALLS_PER_CALLER_PER_HOUR, 10 * MIN), "14155550100", now)).toMatchObject({ ok: false, code: "repeat_caller" });
    expect(decideAdmission(calls(MAX_CALLS_PER_CALLER_PER_HOUR, 61 * MIN), "14155550100", now).ok).toBe(true);
    expect(decideAdmission(calls(MAX_CALLS_PER_CALLER_PER_HOUR, 10 * MIN), "+12125550000", now).ok).toBe(true);
    // A withheld number cannot be counted; the other limits still apply.
    expect(decideAdmission(calls(MAX_CALLS_PER_CALLER_PER_HOUR, 10 * MIN), null, now).ok).toBe(true);
  });

  it("stops at the daily minutes budget, counting a live call's elapsed time", () => {
    const budgetSec = MAX_AGENT_MINUTES_PER_DAY * 60;
    const done = (sec: number, age: number) => ({ status: "completed", startedAt: ago(age), durationSec: sec, fromNumber: null });
    expect(decideAdmission([done(budgetSec - 60, 2 * 60 * MIN)], null, now).ok).toBe(true);
    expect(decideAdmission([done(budgetSec, 2 * 60 * MIN)], null, now)).toMatchObject({ ok: false, code: "daily_budget" });
    expect(decideAdmission([done(budgetSec, 25 * 60 * MIN)], null, now).ok).toBe(true);
    const live = { status: "in_progress", startedAt: ago(2 * MIN), durationSec: null, fromNumber: null };
    expect(decideAdmission([done(budgetSec - 60, 3 * 60 * MIN), live], null, now)).toMatchObject({ ok: false, code: "daily_budget" });
  });
});

describe("lost calls are hung up", () => {
  it("the sweep hangs up stale live calls in xAI and closes their rows", async () => {
    state.stale = [{ id: 11, workspaceId: 5, xaiCallId: "call-lost", outcome: null }];
    const n = await sweepStaleVoiceCalls();
    expect(n).toBe(1);
    expect(hangups().map((c) => String(c[0]))).toEqual(["https://api.x.ai/v1/realtime/calls/call-lost/hangup"]);
    const up = state.updates.find((u) => u.table === voiceCalls);
    expect(up?.v).toMatchObject({ status: "failed" });
    expect(String(up?.v.outcome)).toContain("safety sweep hung it up");
  });

  it("the sweep only takes rows past one call length plus margin, and runs every 5 minutes", () => {
    const guards = readFileSync(path.join(__dirname, "services", "voiceGuards.ts"), "utf8");
    expect(guards).toContain("lt(voiceCalls.startedAt, new Date(nowMs - STALE_CALL_MS))");
    expect(STALE_CALL_MS).toBeGreaterThan(MAX_CALL_MS);
    const index = readFileSync(path.join(__dirname, "_core", "index.ts"), "utf8");
    expect(index).toContain("m.sweepStaleVoiceCalls()");
    expect(index).toContain("setInterval(runStaleVoiceSweep, 5 * 60 * 1000)");
  });

  it("the bridge hangs up in xAI whenever it finishes, not only at the cap", () => {
    const bridge = readFileSync(path.join(__dirname, "services", "voiceBridge.ts"), "utf8");
    const finish = bridge.slice(bridge.indexOf("const finishOnce = async"), bridge.indexOf("const digest = transcript.length"));
    expect(finish).toContain("clearTimeout(capTimer);");
    expect(finish).toContain("void hangupXaiCall(apiKey, opts.xaiCallId);");
  });
});

describe("wiring", () => {
  it("the webhook path has its own rate limit, mounted before the routes", () => {
    const rl = readFileSync(path.join(__dirname, "publicRateLimit.ts"), "utf8");
    const reg = rl.slice(rl.indexOf("export function registerPublicRateLimits"));
    expect(reg).toMatch(/app\.use\("\/api\/voice", \(req: Request, res: Response, next: NextFunction\) =>\s*voiceWebhookLimiter\(req, res, next\)/);
    const index = readFileSync(path.join(__dirname, "_core", "index.ts"), "utf8");
    expect(index.indexOf("registerPublicRateLimits(app);")).toBeLessThan(index.indexOf("registerVoiceWebhookRoutes(app);"));
  });

  it("Settings says when an agent's calls are being rejected for want of a secret", () => {
    const ui = readFileSync(path.join(__dirname, "..", "client", "src", "components", "usip", "settings", "VoiceAgentsSection.tsx"), "utf8");
    expect(ui).toMatch(/!a\.hasWebhookSecret && a\.phoneNumber && <span[^>]*>No signing secret: calls rejected<\/span>/);
  });
});
