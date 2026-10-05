/**
 * The xAI SIP bridge (numbers registered in xAI's console) gets the
 * knowledge-base passages too (owner ask 2026-10-05): with documents, the
 * agent is offered search_knowledge and told when to use it; a search is
 * answered on the socket, and the agent is asked to carry on only once its
 * response is done. Without documents, nothing changes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sockets: any[] = [];
vi.mock("ws", async () => {
  const { EventEmitter } = await import("events");
  class FakeWS extends EventEmitter {
    static OPEN = 1;
    readyState = 1;
    sent: any[] = [];
    url: string;
    constructor(url: string) { super(); this.url = url; sockets.push(this); }
    send(d: string) { this.sent.push(JSON.parse(d)); }
    close() { this.readyState = 3; }
  }
  return { default: FakeWS };
});

const fakeDb: any = {
  select: () => ({
    from: (table: any) => {
      const name = table?.[Symbol.for("drizzle:Name")] ?? "";
      const rows = () =>
        name === "voice_agents" ? [{ id: 1, workspaceId: 5, name: "Line", voice: "eve", instructions: null, languageHint: null, ownerUserId: null }]
        : name === "workspace_settings" ? [{ enc: "xai-key", model: null }]
        : name === "voice_calls" ? [{ startedAt: new Date() }]
        : [];
      const q: any = { where: () => q, limit: () => Promise.resolve(rows()), then: (r: any, j: any) => Promise.resolve(rows()).then(r, j) };
      return q;
    },
  }),
  update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
};
vi.mock("./db", () => ({ getDb: async () => fakeDb }));
vi.mock("./_core/crypto", () => ({ tryDecryptSecret: (v: unknown) => (typeof v === "string" ? v : "") }));
vi.mock("./_core/activeMembers", () => ({ activeOwnerOrNull: async () => null }));
vi.mock("./services/brandContext", () => ({ buildBrandContext: async () => "BRAND BLOCK" }));
vi.mock("./services/voiceCrmLink", () => ({ logCallActivity: async () => {} }));
const has = { value: true };
const searchKnowledge = vi.fn(async () => [{ title: "Pricing", page: 2, content: "Enterprise: $2,400 a year." }]);
vi.mock("./services/knowledgeSearch", () => ({ hasKnowledge: async () => has.value, searchKnowledge: (...a: any[]) => (searchKnowledge as any)(...a) }));

const person = { value: null as number | null };
const buildPersonHistory = vi.fn(async () => "They replied 2026-09-30 (interested): Send me pricing.");
vi.mock("./services/personHistory", () => ({ personIdForRecord: async () => person.value, buildPersonHistory: (...a: any[]) => (buildPersonHistory as any)(...a) }));

import { answerInboundCall } from "./services/voiceBridge";
import { ToolTurns } from "./services/voiceToolTurns";

const tick = () => new Promise((r) => setTimeout(r, 5));
async function connect() {
  answerInboundCall({ workspaceId: 5, agentId: 1, callRowId: 10, xaiCallId: "call-1" });
  for (let i = 0; i < 50 && !sockets.length; i++) await tick();
  const ws = sockets[0];
  ws.emit("open");
  return ws;
}
const emit = async (ws: any, evt: unknown) => { ws.emit("message", Buffer.from(JSON.stringify(evt))); await tick(); };

beforeEach(() => {
  sockets.length = 0;
  has.value = true;
  person.value = null;
  buildPersonHistory.mockClear();
  searchKnowledge.mockClear();
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}")));
});
afterEach(() => vi.unstubAllGlobals());

describe("the xAI SIP bridge and the knowledge base", () => {
  it("offers the search tool and says when to use it, keeping its own script and brand block", async () => {
    const ws = await connect();
    const update = ws.sent.find((m: any) => m.type === "session.update");
    expect(update.session.tools).toEqual([expect.objectContaining({ type: "function", name: "search_knowledge" })]);
    expect(update.session.instructions).toContain("BRAND BLOCK");
    expect(update.session.instructions).toContain("call search_knowledge with the question");
    expect(update.session.instructions.indexOf("BRAND BLOCK")).toBeLessThan(update.session.instructions.indexOf("search_knowledge"));
    ws.emit("close");
  });

  it("answers a search on the socket, then lets the agent carry on once its response is done", async () => {
    const ws = await connect();
    const before = ws.sent.length;
    await emit(ws, { type: "response.function_call_arguments.done", name: "search_knowledge", call_id: "c1", arguments: JSON.stringify({ query: "enterprise price" }) });
    expect(searchKnowledge).toHaveBeenCalledWith(5, "enterprise price", 3);
    const out = ws.sent.slice(before).find((m: any) => m.type === "conversation.item.create");
    expect(out.item).toMatchObject({ type: "function_call_output", call_id: "c1" });
    expect(JSON.parse(out.item.output)).toEqual({ passages: [{ source: "Pricing, p. 2", text: "Enterprise: $2,400 a year." }] });
    expect(ws.sent.slice(before).some((m: any) => m.type === "response.create")).toBe(false);
    await emit(ws, { type: "response.done" });
    expect(ws.sent.slice(before).filter((m: any) => m.type === "response.create")).toHaveLength(1);
    ws.emit("close");
  });

  it("an unknown tool gets an error back, not a crash", async () => {
    const ws = await connect();
    await emit(ws, { type: "response.function_call_arguments.done", name: "transfer_money", call_id: "c9", arguments: "{}" });
    const out = ws.sent.find((m: any) => m.type === "conversation.item.create");
    expect(JSON.parse(out.item.output).ok).toBe(false);
    expect(searchKnowledge).not.toHaveBeenCalled();
    ws.emit("close");
  });

  it("without documents, the session is as it was", async () => {
    has.value = false;
    const ws = await connect();
    const update = ws.sent.find((m: any) => m.type === "session.update");
    expect(update.session.tools).toBeUndefined();
    expect(update.session.instructions).not.toContain("search_knowledge");
    ws.emit("close");
  });
});

describe("the xAI SIP bridge and the caller's history", () => {
  it("a caller matched to someone: the agent is told what the team knows, fenced, before the search rule", async () => {
    person.value = 9;
    const ws = await connect();
    const instr: string = ws.sent.find((m: any) => m.type === "session.update").session.instructions;
    expect(buildPersonHistory).toHaveBeenCalledWith(5, 9);
    const fence = instr.slice(instr.indexOf("<<HISTORY"), instr.indexOf("HISTORY>>") + 9);
    expect(fence).toContain("They replied 2026-09-30 (interested): Send me pricing.");
    expect(instr).toContain("do not recite it or read out their emails");
    expect(instr.indexOf("BRAND BLOCK")).toBeLessThan(instr.indexOf("<<HISTORY"));
    expect(instr.indexOf("HISTORY>>")).toBeLessThan(instr.indexOf("call search_knowledge"));
    ws.emit("close");
  });

  it("an unmatched caller: no history is looked up or given", async () => {
    const ws = await connect();
    const instr: string = ws.sent.find((m: any) => m.type === "session.update").session.instructions;
    expect(buildPersonHistory).not.toHaveBeenCalled();
    expect(instr).not.toContain("HISTORY");
    ws.emit("close");
  });
});

describe("ToolTurns", () => {
  it("sends every output of a response, then one response.create after it is done", async () => {
    const sent: any[] = [];
    const t = new ToolTurns((e) => sent.push(e));
    let release!: () => void;
    const slow = new Promise<void>((r) => { release = r; });
    t.onEvent("response.created");
    const a = t.run("a", async () => ({ ok: 1 }));
    const b = t.run("b", async () => { await slow; return { ok: 2 }; });
    await a;
    t.onEvent("response.done");
    expect(sent.map((e) => e.type)).toEqual(["conversation.item.create"]); // b still running
    release();
    await b;
    expect(sent.map((e) => e.type)).toEqual(["conversation.item.create", "conversation.item.create", "response.create"]);
  });

  it("sends nothing after the call ends", async () => {
    const sent: any[] = [];
    const t = new ToolTurns((e) => sent.push(e));
    t.onEvent("response.done");
    t.stop();
    await t.run("a", async () => ({}));
    expect(sent).toEqual([]);
  });

  it("a failing tool still answers", async () => {
    const sent: any[] = [];
    const t = new ToolTurns((e) => sent.push(e));
    await t.run("a", async () => { throw new Error("db down"); });
    expect(JSON.parse(sent[0].item.output).ok).toBe(false);
  });
});
