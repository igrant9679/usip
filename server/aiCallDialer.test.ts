/**
 * The dialer places approved calls only when every gate is open, and the
 * Plivo webhook answers only requests Plivo signed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { callSuppressions, voiceAgents, voiceCallRequests, voiceCalls, workspaceSettings, workspaces } from "../drizzle/schema";

type Row = Record<string, any>;
const state = {
  approved: [] as Row[],
  agents: [] as Row[],
  dnc: [] as Row[],
  callsToday: 0,
  callRow: null as Row | null,
  updates: [] as { table: unknown; set: Row }[],
  inserts: [] as { table: unknown; v: Row }[],
  claimOk: true,
};

const fakeDb: any = {
  select: (cols?: Row) => ({
    from: (table: unknown) => {
      const rows = (): Row[] => {
        if (table === voiceCallRequests) return state.approved;
        if (table === voiceAgents) return state.agents;
        if (table === workspaces) return [{ name: "CommunityForce" }];
        if (table === workspaceSettings) return [{ aiCallsPausedAt: aiPaused.value ? new Date() : null }];
        if (table === callSuppressions) return state.dnc;
        if (table === voiceCalls) return cols && "n" in cols ? [{ n: state.callsToday }] : state.callRow ? [state.callRow] : [];
        return [];
      };
      const q: any = {
        where: () => q,
        orderBy: () => q,
        limit: () => Promise.resolve(rows()),
        then: (res: any, rej: any) => Promise.resolve(rows()).then(res, rej),
      };
      return q;
    },
  }),
  selectDistinct: () => ({ from: () => ({ where: () => Promise.resolve([{ workspaceId: 4 }]) }) }),
  update: (table: unknown) => ({
    set: (set: Row) => ({
      where: () => {
        state.updates.push({ table, set });
        const claim = table === voiceCallRequests && set.status === "dialing";
        return Promise.resolve([{ affectedRows: claim ? (state.claimOk ? 1 : 0) : 1 }]);
      },
    }),
  }),
  insert: (table: unknown) => ({
    values: (v: Row) => { state.inserts.push({ table, v }); return Promise.resolve([{ insertId: 900 }]); },
  }),
};

vi.mock("./db", () => ({ getDb: async () => fakeDb }));
// Pause all outbound (email) — the dialer no longer reads it (2026-10-05).
const paused = { value: false };
// AI calls' own switch.
const aiPaused = { value: false };
vi.mock("./services/sendWindow", () => ({ getWorkspaceSendWindow: async () => ({ timezone: "America/New_York", window: {}, paused: paused.value }) }));
const admission = { value: { ok: true } as any };
vi.mock("./services/voiceGuards", async (orig) => ({ ...(await orig<any>()), admitInboundCall: async () => admission.value }));
const placeCall = vi.fn(async () => ({ requestUuid: "req-1" }));
const creds = { value: { authId: "MAXXXXXXXXXXXXXXXXXX", authToken: "tok" } as any };
vi.mock("./services/plivo", async (orig) => ({ ...(await orig<any>()), placeCall: (...a: any[]) => (placeCall as any)(...a), plivoCreds: async () => creds.value }));

import { dialWorkspace, MAX_DIALS_PER_MINUTE_PER_WORKSPACE, OUTBOUND_TIME_LIMIT_SEC, WAIT } from "./services/aiCallDialer";
import { PlivoError } from "./services/plivo";

// Tuesday 2026-10-06 11:00 Eastern.
const OPEN = Date.parse("2026-10-06T15:00:00Z");
// Same day 18:00 Eastern.
const CLOSED = Date.parse("2026-10-06T22:00:00Z");

const req = (id: number, over: Row = {}): Row => ({ id, workspaceId: 4, agentId: 1, prospectId: 100 + id, toNumber: `+1415555010${id}`, timezone: "America/New_York", status: "approved", statusReason: null, ownerUserId: 5721, approvedAt: new Date(), ...over });
const agent: Row = { id: 1, workspaceId: 4, status: "active", purpose: "outbound_outreach", plivoNumber: "+17037971086" };

const reqUpdates = () => state.updates.filter((u) => u.table === voiceCallRequests).map((u) => u.set);

beforeEach(() => {
  state.approved = [req(1)];
  state.agents = [agent];
  state.dnc = [];
  state.callsToday = 0;
  state.callRow = null;
  state.updates = [];
  state.inserts = [];
  state.claimOk = true;
  paused.value = false;
  aiPaused.value = false;
  admission.value = { ok: true };
  creds.value = { authId: "MAXXXXXXXXXXXXXXXXXX", authToken: "tok" };
  placeCall.mockReset();
  placeCall.mockResolvedValue({ requestUuid: "req-1" });
});

describe("the dialer", () => {
  it("dials an approved call inside calling hours, from the agent's number, with a carrier time limit", async () => {
    const n = await dialWorkspace(fakeDb, 4, OPEN);
    expect(n).toBe(1);
    expect(reqUpdates()[0]).toMatchObject({ status: "dialing" });
    const call = state.inserts.find((i) => i.table === voiceCalls)!.v;
    expect(call).toMatchObject({ direction: "outbound", provider: "plivo", toNumber: "+14155550101", fromNumber: "+17037971086", status: "queued", requestId: 1 });
    const [, p] = placeCall.mock.calls[0] as any[];
    expect(p).toMatchObject({ from: "+17037971086", to: "+14155550101", timeLimit: OUTBOUND_TIME_LIMIT_SEC });
    expect(p.answerUrl).toMatch(/\/api\/voice\/plivo\/answer\?ws=4&call=900$/);
    expect(p.hangupUrl).toMatch(/\/api\/voice\/plivo\/hangup\?ws=4&call=900$/);
  });

  it("waits outside the person's calling hours", async () => {
    expect(await dialWorkspace(fakeDb, 4, CLOSED)).toBe(0);
    expect(placeCall).not.toHaveBeenCalled();
    expect(reqUpdates()).toEqual([{ statusReason: WAIT.hours }]);
  });

  it("calls a Californian at their 9 AM, not the workspace's", async () => {
    state.approved = [req(1, { timezone: "America/Los_Angeles" })];
    expect(await dialWorkspace(fakeDb, 4, OPEN)).toBe(0); // 8 AM Pacific
    expect(await dialWorkspace(fakeDb, 4, Date.parse("2026-10-06T16:00:00Z"))).toBe(1); // 9 AM Pacific
  });

  it("dials nothing while AI calls are paused", async () => {
    aiPaused.value = true;
    expect(await dialWorkspace(fakeDb, 4, OPEN)).toBe(0);
    expect(placeCall).not.toHaveBeenCalled();
    expect(reqUpdates()).toEqual([{ statusReason: WAIT.paused }]);
  });

  it("still dials while Pause all outbound holds email: calls have their own switch", async () => {
    paused.value = true;
    expect(await dialWorkspace(fakeDb, 4, OPEN)).toBe(1);
    expect(placeCall).toHaveBeenCalledTimes(1);
  });

  it("dials nothing without a Plivo connection", async () => {
    creds.value = null;
    expect(await dialWorkspace(fakeDb, 4, OPEN)).toBe(0);
    expect(reqUpdates()).toEqual([{ statusReason: WAIT.noPlivo }]);
  });

  it("skips a number on the do-not-call list", async () => {
    state.dnc = [{ id: 1 }];
    expect(await dialWorkspace(fakeDb, 4, OPEN)).toBe(0);
    expect(placeCall).not.toHaveBeenCalled();
    expect(reqUpdates()[0]).toMatchObject({ status: "skipped" });
  });

  it("waits when the agent is paused or has no number", async () => {
    state.agents = [{ ...agent, status: "paused" }];
    expect(await dialWorkspace(fakeDb, 4, OPEN)).toBe(0);
    expect(reqUpdates()).toEqual([{ statusReason: WAIT.agent }]);
  });

  it("stops at the spend limits", async () => {
    admission.value = { ok: false, code: "concurrency", reason: "Not answered: 3 agent calls were already in progress (limit 3)." };
    expect(await dialWorkspace(fakeDb, 4, OPEN)).toBe(0);
    expect(reqUpdates()[0].statusReason).toBe("Waiting: 3 agent calls were already in progress (limit 3).");
  });

  it("stops at the number's daily cap", async () => {
    state.callsToday = 100;
    expect(await dialWorkspace(fakeDb, 4, OPEN)).toBe(0);
    expect(reqUpdates()).toEqual([{ statusReason: WAIT.numberDay }]);
  });

  it("starts at most two calls a minute per workspace", async () => {
    state.approved = [req(1), req(2), req(3)];
    expect(await dialWorkspace(fakeDb, 4, OPEN)).toBe(MAX_DIALS_PER_MINUTE_PER_WORKSPACE);
    expect(placeCall).toHaveBeenCalledTimes(2);
  });

  it("a row another run already claimed is not dialed twice", async () => {
    state.claimOk = false;
    expect(await dialWorkspace(fakeDb, 4, OPEN)).toBe(0);
    expect(placeCall).not.toHaveBeenCalled();
  });

  it("Plivo's concurrency limit puts the call back in line; other errors close it as failed", async () => {
    placeCall.mockRejectedValueOnce(new PlivoError("Plivo: Concurrency Limit Breached", 403));
    await dialWorkspace(fakeDb, 4, OPEN);
    expect(reqUpdates().at(-1)).toMatchObject({ status: "approved" });

    state.updates = [];
    placeCall.mockRejectedValueOnce(new PlivoError("Plivo: invalid destination", 400));
    await dialWorkspace(fakeDb, 4, OPEN);
    expect(reqUpdates().at(-1)).toMatchObject({ status: "done", result: "failed" });
  });

  it("does not rewrite a reason that has not changed", async () => {
    state.approved = [req(1, { statusReason: WAIT.hours })];
    await dialWorkspace(fakeDb, 4, CLOSED);
    expect(reqUpdates()).toEqual([]);
  });
});

/* ── the webhook ───────────────────────────────────────────────────────── */

import { registerPlivoWebhookRoutes } from "./plivoWebhook";
import { v3Signature, __resetNoncesForTests } from "./services/plivo";
import { appBaseUrl } from "./appUrl";

const routes = new Map<string, (req: any, res: any) => Promise<void>>();
registerPlivoWebhookRoutes({ post: (p: string, h: any) => routes.set(p, h) } as any);

function res() {
  const out: { status: number; type?: string; body?: string } = { status: 0 };
  const r: any = {
    headersSent: false,
    status(c: number) { out.status = c; return r; },
    type(t: string) { out.type = t; return r; },
    send(b: string) { out.body = b; r.headersSent = true; return r; },
    end() { r.headersSent = true; return r; },
  };
  return { r, out };
}

async function post(path: string, query: string, body: Row, opts: { nonce?: string; token?: string } = {}) {
  const originalUrl = `${path}?${query}`;
  const nonce = opts.nonce ?? `n-${Math.random()}`;
  const sig = v3Signature(`${appBaseUrl()}${originalUrl}`, body, nonce, opts.token ?? "tok");
  const q = Object.fromEntries(new URLSearchParams(query));
  const { r, out } = res();
  await routes.get(path)!({ originalUrl, query: q, body, headers: { "x-plivo-signature-v3": sig, "x-plivo-signature-v3-nonce": nonce } }, r);
  return out;
}

describe("the Plivo webhook", () => {
  beforeEach(() => __resetNoncesForTests());

  it("answers a signed outbound call with the audio stream", async () => {
    state.callRow = { id: 900, status: "queued" };
    const out = await post("/api/voice/plivo/answer", "ws=4&call=900", { CallUUID: "uuid-9", Direction: "outbound" });
    expect(out.status).toBe(200);
    expect(out.type).toBe("application/xml");
    expect(out.body).toContain("<Stream bidirectional=\"true\"");
    expect(out.body).toContain("/api/voice/plivo/stream?c=900&amp;t=");
    expect(state.updates.find((u) => u.table === voiceCalls)?.set).toMatchObject({ plivoCallUuid: "uuid-9" });
  });

  it("rejects a request signed with the wrong token", async () => {
    state.callRow = { id: 900, status: "queued" };
    const out = await post("/api/voice/plivo/answer", "ws=4&call=900", { CallUUID: "uuid-9" }, { token: "forged" });
    expect(out.status).toBe(401);
    expect(out.body).toBeUndefined();
  });

  it("rejects a replayed request (same nonce)", async () => {
    state.callRow = { id: 900, status: "queued" };
    expect((await post("/api/voice/plivo/answer", "ws=4&call=900", { CallUUID: "u" }, { nonce: "same" })).status).toBe(200);
    expect((await post("/api/voice/plivo/answer", "ws=4&call=900", { CallUUID: "u" }, { nonce: "same" })).status).toBe(401);
  });

  it("refuses when the workspace has no Plivo connection", async () => {
    creds.value = null;
    expect((await post("/api/voice/plivo/answer", "ws=4&call=900", { CallUUID: "u" })).status).toBe(403);
  });

  it("hangs up on a finished or unknown outbound call instead of streaming", async () => {
    state.callRow = { id: 900, status: "completed" };
    const out = await post("/api/voice/plivo/answer", "ws=4&call=900", { CallUUID: "u" });
    expect(out.body).toContain("<Hangup/>");
  });

  it("hangs up on a call to a number no agent has", async () => {
    state.agents = [agent];
    const out = await post("/api/voice/plivo/answer", "ws=4", { CallUUID: "u", To: "+12025550199", From: "+14155550100", Direction: "inbound" });
    expect(out.body).toContain("<Hangup/>");
  });

  it("records voicemail from the hangup callback", async () => {
    state.callRow = { id: 900, status: "in_progress", endedAt: null, plivoCallUuid: "u", result: null };
    const out = await post("/api/voice/plivo/hangup", "ws=4&call=900", { CallUUID: "u", CallStatus: "completed", Machine: "true", Duration: "6" });
    expect(out.status).toBe(200);
    expect(state.updates.find((u) => u.table === voiceCalls)?.set).toMatchObject({ status: "voicemail", durationSec: 6 });
  });
});

describe("the AI calls switch", () => {
  it("is an admin's to flip, stores when it was paused, and is audited", async () => {
    const { readFileSync } = await import("fs");
    const src = readFileSync(new URL("./routers/voiceAgents.ts", import.meta.url), "utf8");
    const m = src.slice(src.indexOf("setAiCallsPaused: adminWsProcedure"), src.indexOf("  /** Live key verification"));
    expect(m).toContain("setAiCallsPaused: adminWsProcedure");
    expect(m).toContain("set({ aiCallsPausedAt: input.paused ? new Date() : null })");
    expect(m).toContain('entityType: "ai_calls_switch"');
  });
});
