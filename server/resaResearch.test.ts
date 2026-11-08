/**
 * Research, the audit's final pass (2026-11-07, batch RESA, U30): a save that
 * meets a newer one merges part by part instead of all-or-nothing; the
 * scorecard says "n of 5 scored"; and the money-flow diagram draws only the
 * links the research states.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => ({ db: null as any }));
vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db }));

import { appRouter } from "./routers";
import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { cleanSectorContent, draftPartChanges, emptySectorContent, mergeDraftParts } from "@shared/researchShape";
import { DEFAULT_WEIGHTS, scorecard, scoredCount, statedMoneyLinks } from "@shared/researchReports";
import { SECTOR_DRAFT_SCHEMA } from "./services/research/engine";

const read = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8").replace(/\r\n/g, "\n");
const block = (src: string, start: string, end: string) => {
  const at = src.indexOf(start);
  expect(at, `missing: ${start}`).toBeGreaterThan(-1);
  const stop = src.indexOf(end, at + start.length);
  return src.slice(at, stop === -1 ? undefined : stop + end.length);
};

function caller() {
  return appRouter.createCaller({
    user: { id: 1, openId: "u1", email: "owner@example.com", name: "Owner", loginMethod: "password", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
    req: { protocol: "https", headers: { "x-workspace-id": "2" } },
    res: { clearCookie: () => {} },
  } as unknown as TrpcContext);
}

beforeEach(() => {
  h.db = makeSqlFakeDb({ roles: { 2: "admin" }, wsId: () => 2 });
});

/* ── Per-part merge ─────────────────────────────────────────────────────── */

describe("a save that meets a newer one merges part by part (U30)", () => {
  const base = cleanSectorContent({ name: "Counties", summary: "Old summary", tagline: "Old tagline", targeting: { titles: ["CFO"] }, openQuestions: ["Q1"] }).content;
  const mine = { ...base, summary: "My summary", targeting: { ...base.targeting, titles: ["CFO", "COO"] }, openQuestions: ["Mine"] };
  const theirs = { ...base, tagline: "Their tagline", targeting: { ...base.targeting, titles: ["Treasurer"] }, openQuestions: ["Mine"] };

  it("names what each side changed, and which parts both changed differently", () => {
    expect(draftPartChanges(base, mine, theirs)).toEqual([
      { part: "tagline", mine: false, theirs: true, conflict: false },
      { part: "summary", mine: true, theirs: false, conflict: false },
      { part: "targeting", mine: true, theirs: true, conflict: true },
      { part: "openQuestions", mine: true, theirs: true, conflict: false },
    ]);
  });

  it("keeps the person's parts, takes theirs, and asks only about a clash", () => {
    const kept = mergeDraftParts(base, mine, theirs, ["targeting"]);
    expect(kept).toMatchObject({ tagline: "Their tagline", summary: "My summary", openQuestions: ["Mine"] });
    expect(kept.targeting.titles).toEqual(["CFO", "COO"]);
    const taken = mergeDraftParts(base, mine, theirs, []);
    expect(taken.targeting.titles).toEqual(["Treasurer"]);
    expect(taken.summary).toBe("My summary");
  });

  it("a merged draft saves against the newer revision, and keeps both people's work", async () => {
    const m = await caller().research.markets.create({ content: { name: "Local government" } });
    const s = await caller().research.sectors.create({ marketId: m.id, content: { name: "Counties", summary: "Old summary", tagline: "Old tagline" } });
    const v1 = (await caller().research.sectors.get({ id: s.id })).sector;
    // Someone else saves first.
    await caller().research.sectors.update({ id: s.id, expectedRevision: v1.revision, content: { ...v1.content, tagline: "Their tagline" } });
    const myDraft = { ...v1.content, summary: "My summary" };
    // The old all-or-nothing path: refused.
    await expect(caller().research.sectors.update({ id: s.id, expectedRevision: v1.revision, content: myDraft })).rejects.toMatchObject({ code: "CONFLICT" });
    // The merge rebuilds the draft on the newer revision; saving it keeps both.
    const v2 = (await caller().research.sectors.get({ id: s.id })).sector;
    const merged = mergeDraftParts(v1.content, myDraft, v2.content, []);
    await caller().research.sectors.update({ id: s.id, expectedRevision: v2.revision, content: merged as unknown as Record<string, unknown> });
    expect((await caller().research.sectors.get({ id: s.id })).sector.content).toMatchObject({ tagline: "Their tagline", summary: "My summary" });
  });

  it("the editor keeps the version it started from, offers the merge on a stale draft, and both pages pass it", () => {
    const fields = read("client/src/components/usip/research/ResearchFields.tsx");
    const hook = block(fields, "export function useResearchDraft<T>(", "\n}\n");
    expect(hook).toContain("useState<{ value: T; base: number; baseValue: T } | null>(null)");
    expect(hook).toContain("baseValue: d?.baseValue ?? saved");
    expect(hook).toContain("parts: draftPartChanges(draft.baseValue, draft.value, saved),");
    expect(hook).toContain("apply: (keepMine: string[]) => setDraft({ value: mergeDraftParts(draft.baseValue, draft.value, saved, keepMine), base: revision, baseValue: saved }),");
    const bar = block(fields, "export function SaveBar(", "\n}\n");
    expect(bar).toContain("{stale && merge && <Button size=\"sm\" variant=\"outline\" onClick={() => setMerging(true)} disabled={saving}>Review and merge</Button>}");
    const dialog = block(fields, "function MergeDialog(", "\n}\n");
    expect(dialog).toContain('{side === "mine" ? "Keep mine" : "Take theirs"}');
    expect(dialog).toContain('merge.apply(conflicts.filter((p) => keep[p.part] !== "theirs").map((p) => p.part));');
    for (const [f, current] of [["ResearchSector.tsx", "sector?.content"], ["ResearchMarket.tsx", "market?.content"]]) {
      const page = read(`client/src/pages/usip/research/${f}`);
      expect(block(page, "<SaveBar", "/>"), f).toContain(`merge={draft.merge}\n        current={${current}}\n        mine={c}`);
    }
  });
});

/* ── n of 5 scored ──────────────────────────────────────────────────────── */

describe("the scorecard says how many of the five scores are set (U30)", () => {
  it("counts them, beside the weighted score that leaves the rest out", () => {
    const one = { id: 1, content: cleanSectorContent({ name: "One line", scores: { fit: 5 } }).content };
    const all = { id: 2, content: cleanSectorContent({ name: "Five lines", scores: { reach: 4, money: 4, pain: 4, fit: 4, access: 4 } }).content };
    const rows = scorecard([all, one], DEFAULT_WEIGHTS);
    // One line at 5 outranks five at 4: the reason the count has to be shown.
    expect(rows.map((r) => [r.content.name, r.score, r.scored])).toEqual([["One line", 100, 1], ["Five lines", 80, 5]]);
    expect(scoredCount({})).toBe(0);
  });

  it("the scorecard, the sector report and the market's sector list show it", () => {
    expect(block(read("client/src/pages/usip/research/ResearchReport.tsx"), "function Scorecard(", "\n}\n")).toContain("{s.scored} of {SECTOR_SCORE_KEYS.length} scored</span>");
    expect(read("client/src/pages/usip/research/ResearchSectorReport.tsx")).toContain("{scoredCount(c.scores)} of {SECTOR_SCORE_KEYS.length} scored</div>");
    expect(read("client/src/pages/usip/research/ResearchMarket.tsx")).toContain("{scored.length} of {SECTOR_SCORE_KEYS.length} scored</Badge>");
  });
});

/* ── Money flow ─────────────────────────────────────────────────────────── */

describe("the money-flow diagram draws only the links the research states (U30)", () => {
  const flow = cleanSectorContent({
    facts: {
      moneyFlow: {
        sources: ["U.S. Department of Education", "Local property tax"],
        intermediaries: [{ name: "State education agencies" }, { name: "Regional service centers" }],
        recipients: [{ type: "School districts" }],
        links: [
          { from: "u.s. department of education ", to: "State education agencies" },
          { from: "State education agencies", to: "School districts" },
          { from: "Local property tax", to: "School districts" },
          { from: "School districts", to: "State education agencies" }, // backwards
          { from: "A fund nobody listed", to: "School districts" },
          { from: "State education agencies", to: "school districts" }, // the same link again
          { from: "", to: "School districts" },
        ],
      },
    },
  }).content.facts.moneyFlow;

  it("the shape keeps stated links once each; an empty sector has none", () => {
    expect(flow.links).toHaveLength(5);
    expect(emptySectorContent("X").facts.moneyFlow.links).toEqual([]);
  });

  it("resolves each link to the nodes it names, and leaves out the rest", () => {
    const { links, unmatched } = statedMoneyLinks(flow);
    expect(links.map((l) => `${l.from.col}:${l.from.label} > ${l.to.col}:${l.to.label}`)).toEqual([
      "0:U.S. Department of Education > 1:State education agencies",
      "1:State education agencies > 2:School districts",
      "0:Local property tax > 2:School districts",
    ]);
    expect(unmatched.map((l) => l.from)).toEqual(["School districts", "A fund nobody listed"]);
    // Nothing stated, nothing drawn: not every source to every intermediary.
    expect(statedMoneyLinks({ ...flow, links: [] }).links).toEqual([]);
  });

  it("the diagram draws the resolved links, not every pair, and says when there are none", () => {
    const src = read("client/src/components/usip/research/MoneyFlow.tsx");
    expect(src).toContain("const edges = statedMoneyLinks(flow).links");
    expect(src).toContain("{edges.map(({ a, b }) => {");
    expect(src).not.toContain("columns[ci + 1].nodes.map(");
    expect(src).toContain("The research states no links between these, so none are drawn.");
  });

  it("the sector page edits the links and flags ones that name nothing; the research engine asks for stated links only", () => {
    const page = read("client/src/pages/usip/research/ResearchSector.tsx");
    expect(block(page, 'label="Money flow links"', "/>")).toContain("onChange={(v) => setF({ moneyFlow: { ...f.moneyFlow, links: v } })}");
    expect(page).toContain("statedMoneyLinks(f.moneyFlow).unmatched");
    const mf = (SECTOR_DRAFT_SCHEMA as any).properties.facts.properties.moneyFlow.properties;
    expect(Object.keys(mf.links.items.properties)).toEqual(["from", "to"]);
    expect(read("server/services/research/engine.ts")).toContain("only where the brief says so; name each end exactly as written in sources, intermediaries or recipients");
  });
});
