/**
 * Research runs, editors and deletes (audit 2026-10-20: P25, P26, P27, P29,
 * P32, P98, P99, P100, P101, P102, P103, P105, P106, P107, P111, P112, P113,
 * P125). The router runs against the shared in-memory database, the engine
 * against scripted Anthropic responses; client screens are pinned by reading
 * their source, as the Research tests already do.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => ({
  db: null as any,
  wsId: 2,
  userId: 1,
  calls: [] as any[],
  script: [] as any[],
  enqueued: [] as number[],
  race: null as null | ((table: string) => void),
}));

vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db }));
vi.mock("./_core/llm", async (a) => ({
  ...(await a<typeof import("./_core/llm")>()),
  workspaceAnthropicKey: async () => "sk-ant-test",
  runAnthropicServerTools: async (args: any) => {
    h.calls.push(args);
    const next = h.script.shift();
    if (!next) throw new Error("unscripted Anthropic call");
    return next;
  },
}));
vi.mock("./services/research/engine", async (a) => ({
  ...(await a<typeof import("./services/research/engine")>()),
  enqueueResearchJob: (id: number) => { h.enqueued.push(id); },
}));

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { appRouter } from "./routers";
import { failOrphanedJobs, MAX_FETCHES, ORPHAN_AFTER_MS, runResearchJob } from "./services/research/engine";
import { __clearResearchContextCache, researchContextFor } from "./services/research/context";
import { RESEARCH_SOURCES_MAX, cleanSectorContent, isWebLink, sourcesLeftOut } from "@shared/researchShape";
import { ExtLink, SourceRef } from "../client/src/components/usip/research/ReportBits";
import { deleteImpact } from "../client/src/components/usip/research/ResearchFields";

const read = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8").replace(/\r\n/g, "\n");
const html = (el: any) => renderToStaticMarkup(el);
const rows = (t: string) => h.db.rowsOf(t) as any[];

/** Workspace 2: user 1 is an admin, user 2 a manager, user 3 another manager. Workspace 4 is someone else's. */
const ROLES: Record<number, Record<number, string>> = { 2: { 1: "admin", 2: "manager", 3: "manager" }, 4: { 1: "admin", 2: "admin", 3: "admin" } };

function caller(userId = 1, ws = 2) {
  h.wsId = ws;
  h.userId = userId;
  return appRouter.createCaller({
    user: { id: userId, openId: `u${userId}`, email: `u${userId}@example.com`, name: `U${userId}`, loginMethod: "password", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
    req: { protocol: "https", headers: { "x-workspace-id": String(ws) } },
    res: { clearCookie: () => {} },
  } as unknown as TrpcContext);
}

beforeEach(() => {
  h.db = makeSqlFakeDb({
    // The role comes from the caller, so one workspace can hold an admin and managers.
    roles: new Proxy({}, { get: (_t, ws) => ROLES[Number(ws)]?.[h.userId] }) as Record<number, string>,
    wsId: () => h.wsId,
    beforeUpdate: (t) => h.race?.(t),
  });
  h.calls = [];
  h.script = [];
  h.enqueued = [];
  h.race = null;
  __clearResearchContextCache();
});

const sectorDraft = (over: Record<string, unknown> = {}) => ({
  kind: "sector",
  content: cleanSectorContent({ name: "K-12", summary: "Districts", targeting: { titles: ["Superintendent"], industries: ["Primary and Secondary Education"], geographies: ["Kentucky"] }, sources: [{ title: "s", url: "https://nces.ed.gov/fast" }], ...over }).content,
  personas: [{ name: "Director of Federal Programs", titles: ["Director of Federal Programs"], cares: "Compliance", pains: ["Audits"], objections: [], angle: "" }],
});

function doneJob(over: Record<string, unknown> = {}) {
  const row = { id: 50, workspaceId: 2, userId: 2, kind: "sector", marketId: null, sectorId: null, subject: "K-12", status: "done", outcome: null, model: "claude-opus-5-5", costUsd: "1.2", brief: "What the run found.", createdAt: new Date(), updatedAt: new Date(), draft: sectorDraft(), ...over };
  rows("research_jobs").push(row);
  return row;
}

/* ── Accepting a draft ──────────────────────────────────────────────────── */

describe("accepted personas take the sector's saved targeting (P25)", () => {
  it("a new sector saved without Targeting gives its personas none of the draft's", async () => {
    const m = await caller().research.markets.create({ content: { name: "Ed" } });
    doneJob({ marketId: m.id });
    const r = await caller(2).research.runs.accept({ id: 50, parts: ["summary"], personas: [0] });
    const [p] = rows("personas");
    expect(p).toMatchObject({ sectorId: r.resultId, targetIndustries: [], targetGeographies: [] });
  });

  it("a refresh without Targeting keeps the sector's own; with it, the draft's", async () => {
    const m = await caller().research.markets.create({ content: { name: "Ed" } });
    const s = await caller().research.sectors.create({ marketId: m.id, content: { name: "K-12", targeting: { industries: ["County government"] } } });
    doneJob({ marketId: m.id, sectorId: s.id });
    await caller(2).research.runs.accept({ id: 50, parts: [], personas: [0], expectedRevision: 1 });
    expect(rows("personas")[0].targetIndustries).toEqual(["County government"]);

    rows("personas").length = 0;
    doneJob({ id: 51, marketId: m.id, sectorId: s.id });
    await caller(2).research.runs.accept({ id: 51, parts: ["targeting"], personas: [0], expectedRevision: 1 });
    expect(rows("personas")[0].targetIndustries).toEqual(["Primary and Secondary Education"]);
  });
});

describe("two saves of one draft at once write once (P112)", () => {
  it("the claim is taken before anything is written, so the second save writes nothing", async () => {
    const m = await caller().research.markets.create({ content: { name: "Ed" } });
    doneJob({ marketId: m.id });
    // Another save claims the draft between this one's read and its write.
    h.race = (t) => { if (t === "research_jobs") rows("research_jobs")[0].outcome = "accepted"; };
    await expect(caller(2).research.runs.accept({ id: 50, parts: ["summary"], personas: [0] })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(rows("research_sectors")).toEqual([]);
    expect(rows("personas")).toEqual([]);
  });

  it("a save that fails gives the draft back", async () => {
    const m = await caller().research.markets.create({ content: { name: "Ed" } });
    const s = await caller().research.sectors.create({ marketId: m.id, content: { name: "K-12" } });
    doneJob({ marketId: m.id, sectorId: s.id });
    await expect(caller(2).research.runs.accept({ id: 50, parts: ["summary"], expectedRevision: 7 })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(rows("research_jobs")[0]).toMatchObject({ outcome: null, reviewedByUserId: null });
    await caller(2).research.runs.accept({ id: 50, parts: ["summary"], expectedRevision: 1 });
    expect(rows("research_jobs")[0]).toMatchObject({ outcome: "accepted", resultId: s.id });
  });
});

describe("a draft whose market or sector was deleted (P99)", () => {
  it("the run says it can't be saved, and saving is refused with that reason", async () => {
    doneJob({ kind: "market", subject: "Hospitals", marketId: 999, draft: { kind: "market", content: { name: "Hospitals" } } });
    const run = await caller(2).research.runs.get({ id: 50 });
    expect(run.targetGone).toMatch(/market this run refreshed was deleted, so its draft can't be saved/);
    await expect(caller(2).research.runs.accept({ id: 50, parts: ["overview"], expectedRevision: 1 })).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: run.targetGone });
    expect(rows("research_jobs")[0].outcome).toBeNull();
    expect(rows("research_markets")).toEqual([]);

    const page = read("client/src/pages/usip/research/ResearchRun.tsx");
    expect(page).toContain("{reviewable && run.targetGone && (");
    expect(page).toContain("{reviewable && !run.targetGone && (");
  });
});

describe("sources past the cap are reported (P102)", () => {
  it("a refresh that would pass 100 sources says how many were not added", async () => {
    const mine = Array.from({ length: RESEARCH_SOURCES_MAX }, (_, i) => ({ title: `s${i}`, url: `https://a.gov/${i}` }));
    expect(sourcesLeftOut(mine, [{ title: "new", url: "https://b.gov" }, { title: "dup", url: "https://a.gov/1" }])).toBe(1);
    expect(sourcesLeftOut(mine.slice(1), [{ title: "new", url: "https://b.gov" }])).toBe(0);

    const m = await caller().research.markets.create({ content: { name: "Ed" } });
    const s = await caller().research.sectors.create({ marketId: m.id, content: { name: "K-12", sources: mine } });
    doneJob({ marketId: m.id, sectorId: s.id });
    const r = await caller(2).research.runs.accept({ id: 50, parts: ["sources"], expectedRevision: 1 });
    expect(r.sourcesNotAdded).toBe(1);
    expect(read("client/src/pages/usip/research/ResearchRun.tsx")).toContain("if (r.sourcesNotAdded > 0) toast.warning(");
  });
});

/* ── Stop, discard, draft again ─────────────────────────────────────────── */

describe("stop and discard follow the server's rule, and discard is confirmed and audited (P98)", () => {
  it("only the starter or an admin discards; it is on the audit log once", async () => {
    doneJob({ userId: 2 });
    await expect(caller(3).research.runs.discard({ id: 50 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await caller(2).research.runs.discard({ id: 50 });
    await caller(2).research.runs.discard({ id: 50 });
    expect(rows("research_jobs")[0].outcome).toBe("discarded");
    expect(rows("audit_log").filter((a) => a.entityType === "research_run" && a.after?.outcome === "discarded")).toHaveLength(1);

    doneJob({ id: 51, userId: 2 });
    await caller(1).research.runs.discard({ id: 51 });
    expect(rows("research_jobs").find((j) => j.id === 51).outcome).toBe("discarded");
  });

  it("the page shows Stop, Discard and Draft again to the same people, and asks before discarding", () => {
    const page = read("client/src/pages/usip/research/ResearchRun.tsx");
    expect(page).toContain("const ownsRun = canEdit && (run.mine || isAdmin);");
    expect(page).toContain("{working && ownsRun && (");
    expect(page).toContain("{run.brief && ownsRun && !run.removedAt && (");
    expect(page).toContain("{ownsRun && <Button variant=\"outline\" disabled={discard.isPending} onClick={confirmDiscard}>Discard draft</Button>}");
    expect(page).not.toContain("onClick={() => discard.mutate({ id })}");
  });
});

describe("drafting again is held to a new run's rules (P100)", () => {
  const failed = (over: Record<string, unknown> = {}) => doneJob({ status: "failed", draft: null, userId: 2, ...over });

  it("its starter or an admin", async () => {
    failed();
    await expect(caller(3).research.runs.redraft({ id: 50 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await caller(1).research.runs.redraft({ id: 50 });
    expect(h.enqueued).toEqual([50]);
  });

  it("one run at a time per person", async () => {
    failed();
    rows("research_jobs").push({ id: 60, workspaceId: 2, userId: 2, kind: "market", subject: "Other", status: "running", costUsd: "0", createdAt: new Date(), updatedAt: new Date() });
    await expect(caller(2).research.runs.redraft({ id: 50 })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(h.enqueued).toEqual([]);
  });

  it("within the day's number, this run aside", async () => {
    await caller().research.settings.set({ model: "claude-opus-5-5", dailyRuns: 1 });
    failed();
    // This run alone fits: it is the day's one run.
    await caller(2).research.runs.redraft({ id: 50 });
    rows("research_jobs")[0].status = "failed";
    rows("research_jobs").push({ id: 61, workspaceId: 2, userId: 2, kind: "market", subject: "Other", status: "done", costUsd: "0.5", createdAt: new Date(), updatedAt: new Date() });
    await expect(caller(2).research.runs.redraft({ id: 50 })).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    expect(h.enqueued).toEqual([50]);
  });
});

/* ── The engine ─────────────────────────────────────────────────────────── */

describe("search and read caps are hard (P101)", () => {
  it("a run that has used its page reads stops researching, and is never offered another", async () => {
    rows("research_markets").push({ id: 1, workspaceId: 2, name: "Ed", status: "draft", source: "manual", revision: 1 });
    rows("research_jobs").push({ id: 1, workspaceId: 2, userId: 1, kind: "sector", marketId: 1, sectorId: null, subject: "K-12", status: "queued", model: "claude-opus-5-5", costUsd: "0", searches: 0, fetches: 0, createdAt: new Date(), updatedAt: new Date() });
    h.script = [
      { content: [{ type: "text", text: "Found a lot." }], stop_reason: "pause_turn", usage: { input_tokens: 10, output_tokens: 10, server_tool_use: { web_search_requests: 3, web_fetch_requests: MAX_FETCHES } } },
      { content: [{ type: "tool_use", id: "t", name: "record_sector", input: { summary: "x" } }], stop_reason: "tool_use", usage: { input_tokens: 10, output_tokens: 10 } },
    ];
    await runResearchJob(1, new AbortController().signal);
    const job = rows("research_jobs")[0];
    expect(job.status).toBe("done");
    expect(job.fetches).toBe(MAX_FETCHES);
    // One research turn, then the draft: no turn after the reads ran out.
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1].params.tools.map((t: any) => t.name)).toEqual(["record_sector"]);
    expect(job.progress.map((p: any) => p.line)).toContain("The research used its 12 searches or 8 page reads; drafting from what it has.");
    expect(read("server/services/research/engine.ts")).not.toContain("Math.max(1, MAX_");
  });
});

describe("a run cut off by a restart does not say nothing was charged (P111)", () => {
  it("says a call in flight may have been billed", async () => {
    rows("research_jobs").push({ id: 7, workspaceId: 2, userId: 1, kind: "market", subject: "Ed", status: "running", costUsd: "0.3", createdAt: new Date(), updatedAt: new Date(Date.now() - ORPHAN_AFTER_MS - 1000) });
    await failOrphanedJobs(h.db, 2);
    const job = rows("research_jobs")[0];
    expect(job.status).toBe("failed");
    expect(job.error).not.toContain("Nothing more was charged");
    expect(job.error).toContain("may still have been billed");
  });
});

/* ── Lists, reports, links ──────────────────────────────────────────────── */

describe("the recent runs card reaches older runs (P113)", () => {
  it("the list takes up to 200, and the card asks for more", async () => {
    for (let i = 1; i <= 30; i++) rows("research_jobs").push({ id: i, workspaceId: 2, userId: 1, kind: "market", subject: `R${i}`, status: "done", costUsd: "0", createdAt: new Date(Date.now() - i * 1000), updatedAt: new Date() });
    expect((await caller().research.runs.list({ limit: 25 })).runs).toHaveLength(25);
    await expect(caller().research.runs.list({ limit: 200 })).resolves.toBeTruthy();
    const card = read("client/src/components/usip/research/ResearchRuns.tsx");
    expect(card).toContain("const q = trpc.research.runs.list.useQuery({ limit }, {");
    expect(card).toContain("{runs.length >= limit && limit < RECENT_RUNS_MAX && (");
    expect(card).toContain("Show older runs");
  });
});

describe("the market report does not carry every run's brief (P107)", () => {
  it("runs say whether they have one, and a brief is read on its own, in its workspace", async () => {
    const m = await caller().research.markets.create({ content: { name: "Ed" } });
    doneJob({ marketId: m.id, brief: "A long brief." });
    // Older than run 50: the report lists newest first, and two runs stamped
    // in the same millisecond have no order (CI, 2026-11-06).
    doneJob({ id: 51, marketId: m.id, brief: "", createdAt: new Date(Date.now() - 60_000) });
    const r = await caller().research.reports.market({ id: m.id });
    expect(r.runs.map((x: any) => [x.id, x.hasBrief, "brief" in x])).toEqual([[50, true, false], [51, false, false]]);
    expect(await caller().research.runs.brief({ id: 50 })).toEqual({ id: 50, brief: "A long brief." });
    await expect(caller(1, 4).research.runs.brief({ id: 50 })).rejects.toMatchObject({ code: "NOT_FOUND" });
    const page = read("client/src/pages/usip/research/ResearchReport.tsx");
    expect(page).toContain("const runs = r.runs.filter((x) => x.hasBrief);");
    expect(page).toContain("<RunBrief id={x.id} />");
  });
});

describe("source fields render as links only when they are web addresses (P103)", () => {
  it("javascript: and plain citations never become an href", () => {
    expect([isWebLink("https://ed.gov/x"), isWebLink("javascript:alert(1)"), isWebLink("NCES Digest Table 214.10"), isWebLink(" http://a.gov ")]).toEqual([true, false, false, true]);
    expect(html(createElement(ExtLink, { url: "javascript:alert(1)" }, "source"))).toBe("source");
    expect(html(createElement(ExtLink, { url: "https://ed.gov/x" }, "source"))).toContain('href="https://ed.gov/x"');
    expect(html(createElement(SourceRef, { value: "NCES Digest Table 214.10" }))).toBe("<span>source: NCES Digest Table 214.10</span>");
    expect(read("client/src/pages/usip/research/ResearchSectorReport.tsx")).toContain("const Ext = ExtLink;");
    expect(read("client/src/pages/usip/research/ResearchReport.tsx")).toContain("<SourceRef value={g.source} />");
  });
});

describe("#results links scroll to the results (P105)", () => {
  it("the results section scrolls itself into view when the address names it", () => {
    const src = read("client/src/components/usip/research/ResearchResults.tsx");
    expect(src).toContain("if (loaded && window.location.hash === `#${RESULTS_ANCHOR}`) document.getElementById(RESULTS_ANCHOR)?.scrollIntoView({ block: \"start\" });");
    expect(src).toContain("id={RESULTS_ANCHOR}");
  });
});

/* ── Saves reach the writers, and other views ───────────────────────────── */

describe("a save reaches the writers at once (P106)", () => {
  it("a sector's new avoid rule and a persona's new angle apply on the next call, not a minute later", async () => {
    const m = await caller().research.markets.create({ content: { name: "Ed" } });
    const s = await caller().research.sectors.create({ marketId: m.id, content: { name: "K-12", status: "researched", targeting: { titles: ["Superintendent"] }, messaging: { avoid: ["old rule"] } } });
    const use = { surface: "outreach" as const, prospectTitle: "Superintendent" };
    expect((await researchContextFor(2, use)).avoid).toEqual(["old rule"]);
    const cur = (await caller().research.sectors.get({ id: s.id })).sector.content;
    await caller().research.sectors.update({ id: s.id, expectedRevision: 1, content: { ...cur, messaging: { ...cur.messaging, avoid: ["new rule"] } } });
    expect((await researchContextFor(2, use)).avoid).toEqual(["new rule"]);

    const p = await caller().personas.create({ name: "Superintendent", targetTitles: ["Superintendent"], sectorId: s.id, angle: "First angle" });
    expect((await researchContextFor(2, use)).block).toContain("First angle");
    await caller().personas.update({ id: p.id, angle: "Second angle" });
    expect((await researchContextFor(2, use)).block).toContain("Second angle");
  });
});

describe("editors refetch on a conflict and watch for newer saves (P26), and refresh other views (P27)", () => {
  it("the market and sector pages", () => {
    for (const f of ["client/src/pages/usip/research/ResearchMarket.tsx", "client/src/pages/usip/research/ResearchSector.tsx"]) {
      const page = read(f);
      expect(page, f).toMatch(/useResearchDraft<\w+>\(\w+\?\.content, \w+\?\.revision, q\.refetch\)/);
      expect(page, f).toContain('if (e.data?.code === "CONFLICT") q.refetch();');
      expect(page, f).toContain("await utils.research.invalidate();");
      expect(page, f).toContain("await Promise.all([utils.research.invalidate(), utils.personas.invalidate()]);");
    }
    expect(read("client/src/pages/usip/research/ResearchHome.tsx")).toContain("await utils.research.invalidate();");
    expect(read("client/src/pages/usip/research/ResearchRun.tsx")).toContain('if (e.data?.code === "CONFLICT" || e.data?.code === "PRECONDITION_FAILED") q.refetch();');
    const fields = read("client/src/components/usip/research/ResearchFields.tsx");
    expect(fields).toContain("const t = setInterval(() => { reread.current?.(); }, DRAFT_POLL_MS);");
  });
});

/* ── Deletes ────────────────────────────────────────────────────────────── */

describe("deleting a market or sector that campaigns use (P29)", () => {
  async function seed() {
    const m = await caller().research.markets.create({ content: { name: "Ed" } });
    const s = await caller().research.sectors.create({ marketId: m.id, content: { name: "K-12" } });
    rows("are_campaigns").push(
      { id: 70, workspaceId: 2, name: "Spring", status: "active", researchSectorId: s.id, personaId: null },
      { id: 71, workspaceId: 2, name: "Old", status: "paused", researchSectorId: s.id, personaId: null },
    );
    rows("accounts").push({ id: 80, workspaceId: 2, name: "County Schools", researchSectorId: s.id, customFields: {} });
    return { m, s };
  }

  it("an active campaign blocks it; the confirmation names what it touches", async () => {
    const { m, s } = await seed();
    const deps = await caller().research.sectors.dependents({ id: s.id });
    expect(deps).toMatchObject({ personas: 0, accounts: 1, campaigns: [{ id: 71, name: "Old", status: "paused" }, { id: 70, name: "Spring", status: "active" }] });
    expect(await caller().research.markets.dependents({ id: m.id })).toMatchObject({ sectors: 1, accounts: 1 });
    await expect(caller().research.sectors.delete({ id: s.id })).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: expect.stringContaining('"Spring"') });
    await expect(caller().research.markets.delete({ id: m.id })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(rows("research_sectors")).toHaveLength(1);
    expect(deleteImpact("sector", deps)).toMatchObject({ blocked: true, text: expect.stringContaining('"Spring"') });
  });

  it("with none active, campaigns and accounts are unlinked, not left with a dead id", async () => {
    const { m, s } = await seed();
    rows("are_campaigns")[0].status = "paused";
    const text = deleteImpact("market", await caller().research.markets.dependents({ id: m.id })).text;
    expect(text).toContain("2 campaigns");
    expect(text).toContain("never-target words");
    expect(text).toContain("1 account loses its sector");
    const r = await caller().research.markets.delete({ id: m.id });
    expect(r).toMatchObject({ sectorsDeleted: 1, campaignsUnlinked: 2 });
    expect(rows("are_campaigns").map((c) => c.researchSectorId)).toEqual([null, null]);
    expect(rows("accounts")[0].researchSectorId).toBeNull();
    expect(rows("research_sectors").find((x) => x.id === s.id)).toBeUndefined();
  });
});

describe("deleting a persona that campaigns use (P32)", () => {
  it("an active campaign blocks it; others are cleared of it", async () => {
    const p = await caller().personas.create({ name: "Superintendent" });
    rows("are_campaigns").push(
      { id: 70, workspaceId: 2, name: "Spring", status: "active", personaId: p.id },
      { id: 71, workspaceId: 2, name: "Old", status: "draft", personaId: p.id },
      { id: 72, workspaceId: 4, name: "Theirs", status: "active", personaId: p.id },
    );
    expect((await caller().personas.usage({ id: p.id })).campaigns.map((c) => c.name)).toEqual(["Old", "Spring"]);
    await expect(caller().personas.delete({ id: p.id })).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: expect.stringContaining('"Spring"') });
    rows("are_campaigns")[0].status = "paused";
    expect(await caller().personas.delete({ id: p.id })).toMatchObject({ campaignsCleared: 2 });
    expect(rows("are_campaigns").map((c) => c.personaId)).toEqual([null, null, p.id]);
    expect(rows("personas")).toEqual([]);
    const page = read("client/src/pages/usip/Personas.tsx");
    expect(page).toContain("campaigns = (await utils.personas.usage.fetch({ id })).campaigns;");
  });
});

describe("personas: presets, deletes and dropped values say what happened (P125)", () => {
  it("a change names only what it changes: linking to a sector keeps the persona's titles and places", async () => {
    // Zod 4 applies a default inside .partial(): { id, sectorId } emptied every list.
    const m = await caller().research.markets.create({ content: { name: "Ed" } });
    const s = await caller().research.sectors.create({ marketId: m.id, content: { name: "K-12" } });
    const p = await caller().personas.create({ name: "Superintendent", targetTitles: ["Superintendent"], targetIndustries: ["Education"], targetGeographies: ["Kentucky"], keywords: ["title i"] });
    await caller().personas.update({ id: p.id, sectorId: s.id });
    await caller().personas.update({ id: p.id, angle: "Lead with the audit" });
    expect(rows("personas")[0]).toMatchObject({ sectorId: s.id, targetTitles: ["Superintendent"], targetIndustries: ["Education"], targetGeographies: ["Kentucky"], keywords: ["title i"], angle: "Lead with the audit" });
  });

  it("what the cleaner drops comes back to be reported", async () => {
    const r = await caller().personas.create({ name: "Grants lead", pains: ["Late reports", "email jane@district.org"] });
    expect(r.dropped).toEqual(["pains"]);
    expect(rows("personas")[0].pains).toEqual(["Late reports"]);
    const u = await caller().personas.update({ id: r.id, cares: "Call 555-201-3344" });
    expect(u.dropped).toEqual(["cares"]);
    expect(rows("personas")[0].cares).toBeNull();

    const page = read("client/src/pages/usip/Personas.tsx");
    expect(page).toContain("reportDropped((await create.mutateAsync(personaPayload(form))).dropped);");
    expect(page).toContain("if (fromPreset.isPending) return;");
    // 2026-11-06 (audit P31): also disabled for anyone below manager, who may
    // not create personas; the pending guard is unchanged.
    expect(page).toContain("disabled={!canEdit || fromPreset.isPending}");
    expect(page).toContain('toast.success("Persona deleted");');
    expect(read("client/src/pages/usip/research/ResearchSector.tsx")).toContain("onSuccess: async (r) => { reportDropped(r.dropped); toast.success(\"Persona added\");");
  });
});
