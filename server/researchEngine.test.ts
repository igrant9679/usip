/**
 * Research, phase 2 (owner, 2026-10-14: "start phase 2"): AI research runs.
 * Done when a real run on a new industry produces a sourced draft that someone
 * reviews and saves, with its cost shown.
 *
 * The engine runs here end to end against scripted Anthropic responses (two
 * research turns joined by pause_turn, then the forced draft call), and the
 * router against the shared in-memory database (server/__fakes__/sqlFakeDb).
 */
import { readFileSync } from "fs";
import path from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => ({
  db: null as any,
  wsId: 2,
  key: "sk-ant-test",
  calls: [] as any[],
  script: [] as Array<any | ((args: any) => any)>,
  enqueued: [] as number[],
}));

vi.mock("./db", async (importActual) => ({
  ...(await importActual<typeof import("./db")>()),
  getDb: async () => h.db,
}));

vi.mock("./_core/llm", async (importActual) => ({
  ...(await importActual<typeof import("./_core/llm")>()),
  workspaceAnthropicKey: async () => h.key,
  runAnthropicServerTools: async (args: any) => {
    h.calls.push(JSON.parse(JSON.stringify({ ...args, signal: undefined, onBlock: undefined })));
    const next = h.script.shift();
    if (!next) throw new Error("unscripted Anthropic call");
    const res = typeof next === "function" ? next(args) : next;
    for (const b of res.content ?? []) args.onBlock?.(b);
    return res;
  },
}));

vi.mock("./services/research/engine", async (importActual) => ({
  ...(await importActual<typeof import("./services/research/engine")>()),
  enqueueResearchJob: (id: number) => { h.enqueued.push(id); },
}));

import { appRouter } from "./routers";
import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import {
  draftInputOf,
  finishDraft,
  friendlyError,
  keepSeenLinks,
  linkKey,
  progressLine,
  readBlocks,
  runResearchJob,
} from "./services/research/engine";
import { requestCostUsd } from "@shared/researchModels";
import { cleanMarketContent, cleanSectorContent, mergeMarketParts, mergeSectorParts } from "@shared/researchShape";

const read = (rel: string) => readFileSync(path.join(__dirname, "..", rel), "utf8").replace(/\r\n/g, "\n");

function caller(wsId: number) {
  h.wsId = wsId;
  const ctx = {
    user: { id: 1, openId: "u1", email: "owner@example.com", name: "Owner", loginMethod: "password", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
    req: { protocol: "https", headers: { "x-workspace-id": String(wsId) } },
    res: { clearCookie: () => {} },
  } as unknown as TrpcContext;
  return appRouter.createCaller(ctx);
}

beforeEach(() => {
  h.db = makeSqlFakeDb({ roles: { 2: "admin", 4: "admin", 7: "manager", 8: "rep" }, wsId: () => h.wsId });
  h.key = "sk-ant-test";
  h.calls = [];
  h.script = [];
  h.enqueued = [];
});

/* ── Pure pieces ────────────────────────────────────────────────────────── */

describe("costs", () => {
  it("prices a response from Anthropic's published list (read 2026-10-14)", () => {
    expect(requestCostUsd("claude-opus-5-5", { input_tokens: 1_000_000 })).toBeCloseTo(4);
    expect(requestCostUsd("claude-opus-5-5", { output_tokens: 1_000_000 })).toBeCloseTo(20);
    expect(requestCostUsd("claude-sonnet-5-5", { input_tokens: 1_000_000, output_tokens: 1_000_000 })).toBeCloseTo(12);
    expect(requestCostUsd("claude-opus-5-5", { cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 1_000_000 })).toBeCloseTo(5.2);
    expect(requestCostUsd("claude-opus-5-5", { server_tool_use: { web_search_requests: 10, web_fetch_requests: 5 } })).toBeCloseTo(0.1);
    // Haiku 5.5 has a second tier for prompts over 100,000 tokens.
    expect(requestCostUsd("claude-haiku-5-5", { input_tokens: 100_000 })).toBeCloseTo(0.01);
    expect(requestCostUsd("claude-haiku-5-5", { input_tokens: 200_000 })).toBeCloseTo(0.1);
  });
});

describe("links", () => {
  it("compares links without scheme, www., fragment or trailing slash", () => {
    expect(linkKey("https://www.ED.gov/title-i/#x")).toBe(linkKey("http://ed.gov/title-i"));
    expect(linkKey("https://ed.gov/a?id=1")).not.toBe(linkKey("https://ed.gov/a?id=2"));
    expect(linkKey("javascript:alert(1)")).toBe("");
    expect(linkKey("not a url")).toBe("");
  });

  it("removes links the research never opened; a figure or source that loses its link goes, other rows keep theirs blank", () => {
    const seen = new Set([linkKey("https://nces.ed.gov/fast")]);
    const c: Record<string, unknown> = {
      sources: [{ title: "ok", url: "https://nces.ed.gov/fast" }, { title: "invented", url: "https://made.up/x" }],
      facts: {
        marketSize: [{ value: "13,000", label: "districts", source: "https://nces.ed.gov/fast/" }, { value: "$50B", label: "spend", source: "https://made.up/y" }],
        programs: [{ name: "Title I", url: "https://made.up/z" }],
      },
    };
    const removed = keepSeenLinks(c, seen);
    expect(removed).toEqual(["https://made.up/x", "https://made.up/y", "https://made.up/z"]);
    expect(c.sources).toEqual([{ title: "ok", url: "https://nces.ed.gov/fast" }]);
    expect((c.facts as any).marketSize).toEqual([{ value: "13,000", label: "districts", source: "https://nces.ed.gov/fast/" }]);
    expect((c.facts as any).programs).toEqual([{ name: "Title I", url: "" }]);
  });

  it("reads what a response searched, opened and cited, and says so in progress lines", () => {
    const blocks: any[] = [
      { type: "server_tool_use", id: "s1", name: "web_search", input: { query: "k-12 districts" } },
      { type: "web_search_tool_result", tool_use_id: "s1", content: [{ type: "web_search_result", url: "https://a.gov/1", title: "A" }] },
      { type: "server_tool_use", id: "s2", name: "web_fetch", input: { url: "https://b.org/2" } },
      { type: "web_fetch_tool_result", tool_use_id: "s2", content: { type: "web_fetch_result", url: "https://b.org/2", content: { type: "document", title: "B" } } },
      { type: "web_search_tool_result", tool_use_id: "s3", content: { type: "web_search_tool_result_error", error_code: "max_uses_exceeded" } },
      { type: "text", text: "About 13,000.", citations: [{ type: "web_search_result_location", url: "https://a.gov/1", title: "A", cited_text: "x", encrypted_index: "e" }] },
    ];
    const r = readBlocks(blocks);
    expect(r.sources.map((s) => s.url)).toEqual(["https://a.gov/1", "https://b.org/2", "https://a.gov/1"]);
    expect(r.cited).toEqual(["https://a.gov/1"]);
    expect(r.text).toBe("About 13,000.");
    expect(blocks.map(progressLine).filter(Boolean)).toEqual(["Searching: k-12 districts", "Reading: https://b.org/2"]);
  });
});

describe("finishing a draft", () => {
  it("keeps the person's name and Draft status, dates it, cleans personas and personal data, and reports every removal", () => {
    const { draft, dropped } = finishDraft({
      kind: "sector",
      name: "K-12 districts",
      today: "2026-10-14",
      seen: [{ title: "Fast", url: "https://nces.ed.gov/fast" }],
      cited: ["https://nces.ed.gov/fast"],
      input: {
        name: "Something else",
        status: "verified",
        summary: "Districts",
        buyers: { painPoints: ["Call 555-123-4567", "Late allocations"] },
        sources: [{ title: "Invented", url: "https://invented.example.org/x" }],
        personas: [
          { name: "Director of Federal Programs", titles: ["Director of Federal Programs", "director of federal programs"], cares: "Compliance", pains: ["Audits"], objections: [], angle: "Trail" },
          { name: "jane.doe@district.org" },
          { name: "Director of Federal Programs" },
          { name: "x" },
        ],
      },
    });
    expect(draft.kind).toBe("sector");
    if (draft.kind !== "sector") return;
    expect([draft.content.name, draft.content.status, draft.content.asOf]).toEqual(["K-12 districts", "draft", "2026-10-14"]);
    expect(draft.content.buyers.painPoints).toEqual(["Late allocations"]);
    expect(draft.content.sources).toEqual([{ title: "Fast", url: "https://nces.ed.gov/fast" }]);
    expect(draft.personas).toEqual([{ name: "Director of Federal Programs", titles: ["Director of Federal Programs"], cares: "Compliance", pains: ["Audits"], objections: [], angle: "Trail" }]);
    expect(dropped).toEqual(["link the research never opened: https://invented.example.org/x", "buyers.painPoints", "personas.name"]);
  });
});

describe("accepting parts", () => {
  const cur = cleanSectorContent({ name: "Mine", status: "researched", summary: "old", shortName: "M", targeting: { titles: ["CFO"] }, sources: [{ title: "a", url: "https://a.gov" }] }).content;
  const prop = cleanSectorContent({ name: "Theirs", status: "draft", summary: "new", tagline: "t", shortName: "X", asOf: "2026-10-14", targeting: { titles: ["COO"] }, scores: { fit: 4 }, sources: [{ title: "b", url: "https://b.gov" }, { title: "a again", url: "https://A.gov" }] }).content;

  it("a ticked part replaces; sources are added to; name, status and untouched parts stay", () => {
    const m = mergeSectorParts(cur, prop, ["summary", "targeting", "sources", "status", "name"]);
    expect([m.name, m.status, m.shortName, m.summary, m.tagline, m.asOf]).toEqual(["Mine", "researched", "M", "new", "t", "2026-10-14"]);
    expect(m.targeting.titles).toEqual(["COO"]);
    expect(m.scores.fit).toBeNull();
    expect(m.sources.map((s) => s.url)).toEqual(["https://a.gov", "https://b.gov"]);
    expect(mergeSectorParts(cur, prop, [])).toEqual(cur);
  });

  it("works the same way for markets", () => {
    const a = cleanMarketContent({ name: "M", glossary: [{ term: "LEA", definition: "x" }] }).content;
    const b = cleanMarketContent({ name: "N", tagline: "t", overview: { headline: "h" }, glossary: [{ term: "SEA", definition: "y" }] }).content;
    const m = mergeMarketParts(a, b, ["overview"]);
    expect([m.name, m.tagline, m.overview.headline, m.glossary[0].term]).toEqual(["M", "t", "h", "LEA"]);
  });
});

describe("reading the draft", () => {
  it("takes the record tool's input, else JSON in the text, and says what to do when there is neither", () => {
    expect(draftInputOf({ content: [{ type: "tool_use", id: "t", name: "record_sector", input: { a: 1 } }] as any, stop_reason: "tool_use" }, "record_sector")).toEqual({ a: 1 });
    expect(draftInputOf({ content: [{ type: "tool_use", id: "t", name: "other", input: { a: 1 } }, { type: "text", text: 'Here: {"b":2}' }] as any, stop_reason: "end_turn" }, "record_sector")).toEqual({ b: 2 });
    expect(draftInputOf({ content: [{ type: "text", text: "```json\n{\"c\":3}\n```" }] as any, stop_reason: "end_turn" }, "record_sector")).toEqual({ c: 3 });
    expect(() => draftInputOf({ content: [] as any, stop_reason: "refusal" }, "record_sector")).toThrow(/declined/);
    expect(() => draftInputOf({ content: [{ type: "text", text: "{cut" }] as any, stop_reason: "max_tokens" }, "record_sector")).toThrow(/longer than/);
    expect(() => draftInputOf({ content: [{ type: "text", text: "no draft here" }] as any, stop_reason: "end_turn" }, "record_sector")).toThrow(/not a draft/);
  });
});

describe("error messages a person can act on", () => {
  it("names the fix", () => {
    expect(friendlyError(Object.assign(new Error("x"), { status: 401 }))).toMatch(/key was refused/);
    expect(friendlyError(new Error("Your credit balance is too low"))).toMatch(/out of credit/);
    expect(friendlyError(new Error("web search is not enabled for this organization"))).toMatch(/Web search is turned off/);
    expect(friendlyError(Object.assign(new Error("x"), { status: 429 }))).toMatch(/rate-limiting/);
  });
});

/* ── A whole run ────────────────────────────────────────────────────────── */

function seedSectorJob(extra: Record<string, unknown> = {}) {
  const db = h.db;
  db.rowsOf("research_markets").push({ id: 1, workspaceId: 2, name: "Regional authorities", overview: { headline: "Federal money, local spend", lede: "" }, status: "draft", source: "manual", revision: 1 });
  db.rowsOf("research_jobs").push({
    id: 1, workspaceId: 2, userId: 1, kind: "sector", marketId: 1, sectorId: null, subject: "K-12 districts", focus: "US only",
    status: "queued", model: "claude-opus-5-5", costUsd: "0", searches: 0, fetches: 0, createdAt: new Date(), updatedAt: new Date(), ...extra,
  });
}

const RESEARCH_1 = {
  content: [
    { type: "server_tool_use", id: "s1", name: "web_search", input: { query: "number of US school districts" } },
    { type: "web_search_tool_result", tool_use_id: "s1", content: [{ type: "web_search_result", url: "https://nces.ed.gov/fast", title: "Fast Facts", encrypted_content: "x" }] },
  ],
  stop_reason: "pause_turn",
  usage: { input_tokens: 1000, output_tokens: 100, server_tool_use: { web_search_requests: 1, web_fetch_requests: 0 } },
  container: { id: "cont_1" },
};
const RESEARCH_2 = {
  content: [
    { type: "server_tool_use", id: "s2", name: "web_fetch", input: { url: "https://www.ed.gov/title-i" } },
    { type: "web_fetch_tool_result", tool_use_id: "s2", content: { type: "web_fetch_result", url: "https://www.ed.gov/title-i", content: { type: "document", title: "Title I" } } },
    { type: "text", text: "There are about 13,000 districts (https://nces.ed.gov/fast).", citations: [{ type: "web_search_result_location", url: "https://nces.ed.gov/fast", title: "Fast Facts", cited_text: "13,000", encrypted_index: "e" }] },
  ],
  stop_reason: "end_turn",
  usage: { input_tokens: 5000, output_tokens: 2000, server_tool_use: { web_search_requests: 0, web_fetch_requests: 1 } },
};
const DRAFT_INPUT = {
  summary: "Public school districts",
  targeting: { titles: ["Superintendent"], exclude: ["student"] },
  facts: {
    marketSize: [{ value: "13,000", label: "districts", source: "http://ed.gov/title-i/" }, { value: "$50B", label: "spend", source: "https://made.up/report" }],
  },
  personas: [{ name: "Director of Federal Programs", titles: ["Director of Federal Programs"], cares: "Compliance", pains: ["Audits"], objections: ["Time"], angle: "Trail" }],
};
const DRAFT = {
  content: [{ type: "tool_use", id: "t1", name: "record_sector", input: DRAFT_INPUT }],
  stop_reason: "tool_use",
  usage: { input_tokens: 3000, output_tokens: 1500 },
};

describe("a research run", () => {
  it("researches over a paused turn, drafts, removes unbacked links, and records progress and cost", async () => {
    seedSectorJob();
    h.script = [RESEARCH_1, RESEARCH_2, DRAFT];
    await runResearchJob(1, new AbortController().signal);
    const job = h.db.rowsOf("research_jobs")[0];
    expect(job.status).toBe("done");
    expect([job.searches, job.fetches, job.inputTokens, job.outputTokens]).toEqual([1, 1, 9000, 3600]);
    // (9,000 × $4 + 3,600 × $20) per million + 1 search × $0.01
    expect(Number(job.costUsd)).toBeCloseTo(0.118, 4);
    expect(job.progress.map((p: any) => p.line)).toEqual(expect.arrayContaining([
      "Searching: number of US school districts",
      "Reading: https://www.ed.gov/title-i",
      "Writing the draft",
      "Draft ready. Removed 1 link the research never opened.",
    ]));
    expect(job.brief).toContain("13,000 districts");
    expect(job.draft.content.facts.marketSize).toEqual([{ value: "13,000", label: "districts", source: "http://ed.gov/title-i/" }]);
    expect(job.draft.content.sources).toEqual([{ title: "Fast Facts", url: "https://nces.ed.gov/fast" }]);
    expect(job.draft.personas).toHaveLength(1);
    expect(job.dropped).toEqual(["link the research never opened: https://made.up/report"]);

    // The pause was continued by sending the turn back as-is, with the
    // container, and the remaining search budget.
    const [first, second, third] = h.calls;
    expect(first.workspaceId).toBe(2);
    expect(first.params.model).toBe("claude-opus-5-5");
    expect(first.params.tools.map((t: any) => [t.type, t.max_uses])).toEqual([["web_search_20260209", 12], ["web_fetch_20260209", 8]]);
    expect(first.params.system).toContain("Research organizations, never people");
    expect(first.params.messages[0].content).toContain("Sector to research: K-12 districts");
    expect(first.params.messages[0].content).toContain("Market: Regional authorities");
    expect(first.params.messages[0].content).toContain("US only");
    expect(second.params.messages).toHaveLength(2);
    expect(second.params.messages[1]).toEqual({ role: "assistant", content: RESEARCH_1.content });
    expect(second.params.container).toBe("cont_1");
    expect(second.params.tools[0].max_uses).toBe(11);
    // The draft call sees the brief and the pages, and is forced to the tool.
    // Opus 5.5 refuses a forced tool call, and the sector schema is too big
    // for a structured output's grammar (both found live, 2026-10-14): the
    // record tool is offered with "auto" and the prompt says to call it.
    expect(third.params.tool_choice).toEqual({ type: "auto" });
    expect(third.params.output_config).toBeUndefined();
    expect(third.params.tools.map((t: any) => t.name)).toEqual(["record_sector"]);
    expect(third.params.tools[0].input_schema.properties.personas).toBeDefined();
    expect(third.params.system).toContain("Call the record_sector tool exactly once");
    expect(third.params.messages[0].content).toContain("[1] Fast Facts — https://nces.ed.gov/fast");
    // The research turns are cached, so a continuation re-reads at the cache rate.
    expect(first.params.cache_control).toEqual({ type: "ephemeral" });
    expect(second.params.cache_control).toEqual({ type: "ephemeral" });
    expect(third.params.cache_control).toBeUndefined();
  });

  it("a drafting failure keeps the paid-for research, and Draft again drafts from it without searching", async () => {
    seedSectorJob();
    h.script = [RESEARCH_1, RESEARCH_2, { content: [{ type: "text", text: "not json" }], stop_reason: "end_turn", usage: { input_tokens: 3000, output_tokens: 10 } }];
    await runResearchJob(1, new AbortController().signal);
    let job = h.db.rowsOf("research_jobs")[0];
    expect(job.status).toBe("failed");
    expect(job.error).toMatch(/not a draft/);
    expect(job.brief).toContain("13,000 districts");
    expect(job.sources.map((x: any) => x.url)).toEqual(["https://nces.ed.gov/fast", "https://www.ed.gov/title-i"]);
    const spent = Number(job.costUsd);

    await caller(2).research.runs.redraft({ id: 1 });
    expect(h.enqueued).toEqual([1]);
    expect(job.status).toBe("queued");
    h.calls = [];
    h.script = [DRAFT];
    await runResearchJob(1, new AbortController().signal);
    job = h.db.rowsOf("research_jobs")[0];
    expect(job.status).toBe("done");
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].params.tool_choice).toEqual({ type: "auto" });
    expect(job.searches).toBe(1);
    expect([job.inputTokens, job.outputTokens]).toEqual([1000 + 5000 + 3000 + 3000, 100 + 2000 + 10 + 1500]);
    expect(Number(job.costUsd)).toBeCloseTo(spent + (3000 * 4 + 1500 * 20) / 1e6, 4);
    expect(job.draft.content.facts.marketSize).toEqual([{ value: "13,000", label: "districts", source: "http://ed.gov/title-i/" }]);
    expect(job.progress.map((p: any) => p.line)).toEqual(expect.arrayContaining(["Drafting again from the saved research"]));
  });

  it("only a run that failed after its research can draft again, in its own workspace", async () => {
    seedSectorJob({ status: "failed", brief: "" });
    await expect(caller(2).research.runs.redraft({ id: 1 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    h.db.rowsOf("research_jobs")[0].brief = "Something found";
    await expect(caller(4).research.runs.redraft({ id: 1 })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(caller(8).research.runs.redraft({ id: 1 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    h.db.rowsOf("research_jobs")[0].status = "done";
    await expect(caller(2).research.runs.redraft({ id: 1 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("a refused key fails the run with the fix in words, keeping what it spent", async () => {
    seedSectorJob();
    h.script = [RESEARCH_1, () => { throw Object.assign(new Error("invalid x-api-key"), { status: 401 }); }];
    await runResearchJob(1, new AbortController().signal);
    const job = h.db.rowsOf("research_jobs")[0];
    expect(job.status).toBe("failed");
    expect(job.error).toMatch(/key was refused/);
    expect(Number(job.costUsd)).toBeGreaterThan(0);
  });

  it("a stopped run stops before the next request", async () => {
    seedSectorJob();
    const ac = new AbortController();
    h.script = [(args: any) => { ac.abort(); return RESEARCH_1; }];
    await runResearchJob(1, ac.signal);
    const job = h.db.rowsOf("research_jobs")[0];
    expect(job.status).toBe("cancelled");
    expect(h.calls).toHaveLength(1);
  });

  it("only picks up a queued job", async () => {
    seedSectorJob({ status: "cancelled" });
    await runResearchJob(1, new AbortController().signal);
    expect(h.calls).toHaveLength(0);
  });
});

/* ── The router ─────────────────────────────────────────────────────────── */

describe("starting runs", () => {
  it("needs the workspace's own key, a manager, and a name", async () => {
    h.key = "";
    await expect(caller(2).research.runs.start({ kind: "market", subject: "Hospitals" })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    h.key = "sk-ant-test";
    await expect(caller(8).research.runs.start({ kind: "market", subject: "Hospitals" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller(2).research.runs.start({ kind: "market", subject: "  " })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const r = await caller(7).research.runs.start({ kind: "market", subject: "Hospitals", focus: "Rural, US" });
    expect(h.enqueued).toEqual([r.id]);
    expect(h.db.rowsOf("research_jobs")[0]).toMatchObject({ workspaceId: 7, userId: 1, kind: "market", subject: "Hospitals", focus: "Rural, US", status: "queued", model: "claude-opus-5-5" });
  });

  it("one run at a time per person, and the daily number over the last 24 hours", async () => {
    await caller(2).research.settings.set({ model: "claude-sonnet-5-5", dailyRuns: 2 });
    const a = await caller(2).research.runs.start({ kind: "market", subject: "A" });
    await expect(caller(2).research.runs.start({ kind: "market", subject: "B" })).rejects.toMatchObject({ code: "CONFLICT" });
    const jobs = h.db.rowsOf("research_jobs");
    jobs.find((j: any) => j.id === a.id).status = "done";
    // A run that failed before spending anything does not count, nor does one from yesterday.
    jobs.push({ id: 90, workspaceId: 2, userId: 1, kind: "market", subject: "X", status: "failed", model: "m", costUsd: "0", createdAt: new Date(), updatedAt: new Date() });
    jobs.push({ id: 91, workspaceId: 2, userId: 1, kind: "market", subject: "Y", status: "done", model: "m", costUsd: "2.5", createdAt: new Date(Date.now() - 25 * 3600_000), updatedAt: new Date() });
    const b = await caller(2).research.runs.start({ kind: "market", subject: "B" });
    expect(jobs.find((j: any) => j.id === b.id).model).toBe("claude-sonnet-5-5");
    jobs.find((j: any) => j.id === b.id).status = "done";
    await expect(caller(2).research.runs.start({ kind: "market", subject: "C" })).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    const list = await caller(2).research.runs.list();
    expect([list.usedToday, list.dailyRuns, list.nextFreeAt != null]).toEqual([2, 2, true]);
  });

  it("a run cut off by a restart does not block its owner", async () => {
    h.db.rowsOf("research_jobs").push({ id: 5, workspaceId: 2, userId: 1, kind: "market", subject: "Old", status: "running", model: "m", costUsd: "0.4", createdAt: new Date(Date.now() - 3600_000), updatedAt: new Date(Date.now() - 3600_000) });
    await caller(2).research.runs.start({ kind: "market", subject: "New" });
    expect(h.db.rowsOf("research_jobs").find((j: any) => j.id === 5)).toMatchObject({ status: "failed" });
  });

  it("refuses another workspace's records and a name that is already there", async () => {
    const m = await caller(2).research.markets.create({ content: { name: "Ed" } });
    const s = await caller(2).research.sectors.create({ marketId: m.id, content: { name: "Districts" } });
    await expect(caller(4).research.runs.start({ kind: "sector", sectorId: s.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(caller(4).research.runs.start({ kind: "sector", marketId: m.id, subject: "Charters" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(caller(4).research.runs.start({ kind: "market", marketId: m.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(caller(2).research.runs.start({ kind: "sector", marketId: m.id, subject: "districts" })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(caller(2).research.runs.start({ kind: "market", subject: "ED" })).rejects.toMatchObject({ code: "CONFLICT" });
    const r = await caller(2).research.runs.start({ kind: "sector", sectorId: s.id });
    expect(h.db.rowsOf("research_jobs").find((j: any) => j.id === r.id)).toMatchObject({ kind: "sector", sectorId: s.id, marketId: m.id, subject: "Districts" });
    await expect(caller(4).research.runs.get({ id: r.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(caller(4).research.runs.cancel({ id: r.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("settings", () => {
  it("default to Opus 5.5 and 10 a day; only admins change them, to a listed model", async () => {
    const st = await caller(7).research.settings.get();
    expect([st.model, st.dailyRuns, st.hasKey]).toEqual(["claude-opus-5-5", 10, true]);
    await expect(caller(7).research.settings.set({ model: "claude-haiku-5-5", dailyRuns: 5 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller(2).research.settings.set({ model: "gpt-4o", dailyRuns: 5 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(caller(2).research.settings.set({ model: "claude-haiku-5-5", dailyRuns: 51 })).rejects.toBeTruthy();
    await caller(2).research.settings.set({ model: "claude-haiku-5-5", dailyRuns: 5 });
    expect(await caller(2).research.settings.get()).toMatchObject({ model: "claude-haiku-5-5", dailyRuns: 5 });
  });
});

describe("reviewing and saving a draft", () => {
  function doneJob(over: Record<string, unknown>) {
    const draft = over.draft ?? {
      kind: "sector",
      content: cleanSectorContent({ name: "K-12", summary: "Districts", tagline: "Federal money", targeting: { titles: ["Superintendent"], industries: ["Primary and Secondary Education"] }, scores: { fit: 4 }, sources: [{ title: "s", url: "https://nces.ed.gov/fast" }] }).content,
      personas: [
        { name: "Superintendent", titles: ["Superintendent"], cares: "Outcomes", pains: [], objections: [], angle: "" },
        { name: "Director of Federal Programs", titles: ["Director of Federal Programs"], cares: "Compliance", pains: ["Audits"], objections: ["Time"], angle: "Trail" },
      ],
    };
    const row = { id: 50, workspaceId: 2, userId: 1, kind: "sector", marketId: null, sectorId: null, subject: "K-12", status: "done", model: "claude-opus-5-5", costUsd: "1.2", createdAt: new Date(), updatedAt: new Date(), ...over, draft };
    h.db.rowsOf("research_jobs").push(row);
    return row;
  }

  it("a new sector is created from the ticked parts, as a Draft from AI, with the ticked personas in it", async () => {
    const m = await caller(2).research.markets.create({ content: { name: "Ed" } });
    doneJob({ marketId: m.id });
    await expect(caller(2).research.runs.accept({ id: 50, parts: [], personas: [] })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const r = await caller(2).research.runs.accept({ id: 50, parts: ["summary", "targeting", "nonsense"], personas: [1] });
    expect(r.resultType).toBe("sector");
    const sector = await caller(2).research.sectors.get({ id: r.resultId });
    expect(sector.sector.content).toMatchObject({ name: "K-12", status: "draft", summary: "Districts", tagline: "Federal money" });
    expect(sector.sector.content.targeting.titles).toEqual(["Superintendent"]);
    expect(sector.sector.content.scores.fit).toBeNull();
    expect(sector.sector.source).toBe("ai");
    expect(sector.sector.sourceRef).toBe("research-run:50");
    expect(sector.personas.map((p: any) => [p.name, p.source, p.sectorId, p.pains])).toEqual([["Director of Federal Programs", "ai", r.resultId, ["Audits"]]]);
    expect((await caller(2).research.revisions.list({ entityType: "sector", entityId: r.resultId }))[0].note).toBe("Created from AI research (run 50)");
    expect(h.db.rowsOf("research_jobs").find((j: any) => j.id === 50)).toMatchObject({ outcome: "accepted", resultType: "sector", resultId: r.resultId });
    await expect(caller(2).research.runs.accept({ id: 50, parts: ["summary"] })).rejects.toMatchObject({ code: "CONFLICT", message: "This draft was already saved" });
  });

  it("a refresh saves a new version of what was reviewed, and refuses if it changed since", async () => {
    const m = await caller(2).research.markets.create({ content: { name: "Ed" } });
    const s = await caller(2).research.sectors.create({ marketId: m.id, content: { name: "K-12", summary: "mine", sources: [{ title: "a", url: "https://a.gov" }] } });
    doneJob({ marketId: m.id, sectorId: s.id });
    await caller(2).research.sectors.update({ id: s.id, expectedRevision: 1, content: { name: "K-12", summary: "edited meanwhile", sources: [{ title: "a", url: "https://a.gov" }] } });
    await expect(caller(2).research.runs.accept({ id: 50, parts: ["summary"], expectedRevision: 1 })).rejects.toMatchObject({ code: "CONFLICT" });
    await caller(2).research.runs.accept({ id: 50, parts: ["summary", "sources"], expectedRevision: 2 });
    const after = await caller(2).research.sectors.get({ id: s.id });
    expect(after.sector.revision).toBe(3);
    expect(after.sector.content.summary).toBe("Districts");
    expect(after.sector.content.sources.map((x) => x.url)).toEqual(["https://a.gov", "https://nces.ed.gov/fast"]);
    const history = await caller(2).research.revisions.list({ entityType: "sector", entityId: s.id });
    expect(history[0].note).toBe("AI research (run 50)");
  });

  it("a new market is created from a market draft", async () => {
    doneJob({ kind: "market", subject: "Hospitals", draft: { kind: "market", content: cleanMarketContent({ name: "Hospitals", tagline: "t", glossary: [{ term: "CAH", definition: "Critical access hospital" }] }).content } });
    const r = await caller(2).research.runs.accept({ id: 50, parts: ["glossary"] });
    const got = await caller(2).research.markets.get({ id: r.resultId });
    expect(got.market.content.glossary.map((g) => g.term)).toEqual(["CAH"]);
    expect(got.market.content.tagline).toBe("");
  });

  it("discarding sets it aside; reps and other workspaces cannot act on it; stopping is the owner's or an admin's", async () => {
    doneJob({ marketId: null });
    await expect(caller(4).research.runs.accept({ id: 50, parts: ["summary"] })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await caller(2).research.runs.discard({ id: 50 });
    await expect(caller(2).research.runs.accept({ id: 50, parts: ["summary"] })).rejects.toMatchObject({ code: "CONFLICT", message: "This draft was discarded" });

    h.db.rowsOf("research_jobs").push({ id: 60, workspaceId: 7, userId: 2, kind: "market", subject: "Theirs", status: "running", model: "m", costUsd: "0", createdAt: new Date(), updatedAt: new Date() });
    await expect(caller(7).research.runs.cancel({ id: 60 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    h.db.rowsOf("research_jobs").push({ id: 61, workspaceId: 2, userId: 2, kind: "market", subject: "Theirs", status: "running", model: "m", costUsd: "0", createdAt: new Date(), updatedAt: new Date() });
    expect(await caller(2).research.runs.cancel({ id: 61 })).toMatchObject({ status: "cancelled" });
    expect(h.db.rowsOf("research_jobs").find((j: any) => j.id === 61).status).toBe("cancelled");
  });
});

/* ── Wiring ─────────────────────────────────────────────────────────────── */

describe("wiring", () => {
  it("research bills the workspace's own key and never falls back to the server's", () => {
    const llm = read("server/_core/llm.ts");
    const fn = llm.slice(llm.indexOf("export async function workspaceAnthropicKey"), llm.indexOf("export async function runAnthropicServerTools"));
    expect(fn).toContain("return tryDecryptSecret(row?.enc);");
    expect(fn).not.toContain("ENV.");
    const run = llm.slice(llm.indexOf("export async function runAnthropicServerTools"));
    expect(run).toContain("await checkMonthlyCap(args.workspaceId, Date.now());");
    expect(run).toContain("await recordLlmTokens(");
    expect(run).not.toContain("ENV.");
  });

  it("migration 0202 adds the runs table and the two settings", () => {
    const mig = read("server/_core/rawMigrations.ts");
    const block = mig.slice(mig.indexOf('name: "0202_research_jobs.sql"'));
    const tick = "`";
    expect(block).toContain(`CREATE TABLE IF NOT EXISTS ${tick}research_jobs${tick}`);
    expect(block).toContain(`ALTER TABLE ${tick}workspace_settings${tick} ADD COLUMN ${tick}researchModel${tick}`);
    expect(block).toContain(`ALTER TABLE ${tick}workspace_settings${tick} ADD COLUMN ${tick}researchDailyRuns${tick}`);
  });

  it("the run page and the start buttons are routed and wired", () => {
    expect(read("client/src/App.tsx")).toContain('<Route path="/research/runs/:id">');
    expect(read("client/src/pages/usip/research/ResearchHome.tsx")).toContain('<StartRunDialog target={{ kind: "market" }}');
    expect(read("client/src/pages/usip/research/ResearchSector.tsx")).toContain('<StartRunDialog target={{ kind: "sector", sectorId: id, name: sector.content.name }}');
    expect(read("client/src/pages/usip/research/ResearchMarket.tsx")).toContain('setRunTarget({ kind: "market", marketId: id, name: market.content.name })');
    expect(read("client/src/pages/usip/research/ResearchRun.tsx")).toContain("...(run.current ? { expectedRevision: run.current.revision } : {}),");
  });
});
