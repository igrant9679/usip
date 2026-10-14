/**
 * Research phase 3: the research context every AI writer gets, the avoid-rule
 * check on generated copy, and releasing a held sequence. Runs against the
 * shared in-memory database (server/__fakes__/sqlFakeDb) with the provider SDK
 * stubbed, so invokeLLM and its research option are real.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => ({ db: null as any, wsId: 2, calls: [] as any[], reply: null as null | ((p: any) => any) }));

vi.mock("./db", async (importActual) => ({
  ...(await importActual<typeof import("./db")>()),
  getDb: async () => h.db,
}));
vi.mock("./_core/env", async (importActual) => {
  const actual = await importActual<typeof import("./_core/env")>();
  return { ...actual, ENV: { ...actual.ENV, anthropicApiKey: "test-key", aiDefaultProvider: "anthropic" } };
});
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = {
      create: async (params: any) => {
        h.calls.push(JSON.parse(JSON.stringify(params)));
        if (h.reply) return h.reply(params);
        return { id: "m", model: "m", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } };
      },
    };
  },
}));

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { __clearResearchContextCache, formatResearchBlock, researchContextFor, titleMatchLength } from "./services/research/context";
import { researchUseFor } from "./services/research/recipient";
import { checkAvoidRules, holdReason } from "./services/research/avoidCheck";
import { invokeLLM } from "./_core/llm";
import { appRouter } from "./routers";
import { cleanSectorContent } from "@shared/researchShape";

const read = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8").replace(/\r\n/g, "\n");

const COUNTIES = cleanSectorContent({
  name: "County governments",
  status: "researched",
  summary: "General-purpose local governments.",
  buyers: { painPoints: ["No staff to own compliance", "Hundreds of inaccessible PDFs"] },
  targeting: { titles: ["County Administrator", "ADA Coordinator"], industries: ["Government Administration"] },
  messaging: {
    leadWith: ["The deadline moved; the standard didn't."],
    avoid: ["Don't promise that an overlay makes a county compliant."],
    vocabulary: ["Title II", "WCAG 2.1 AA"],
    sampleOpening: "The DOJ moved the deadline, but not the standard.",
  },
  facts: { marketSize: [{ value: "3,069", label: "county governments", source: "https://www.naco.org/page/what-are-counties" }], buying: ["Cooperative contracts"] },
}).content;

function seed(db: any) {
  db.rowsOf("research_markets").push({ id: 1, workspaceId: 2, name: "State and local government", status: "draft" });
  db.rowsOf("research_sectors").push({ id: 10, workspaceId: 2, marketId: 1, ...COUNTIES, status: "researched" });
  db.rowsOf("research_sectors").push({ id: 11, workspaceId: 2, marketId: 1, ...cleanSectorContent({ name: "Cities", status: "draft", targeting: { titles: ["City Manager"] }, messaging: { avoid: ["Never mention X"] } }).content, status: "draft" });
  // Another workspace's research about the same titles must never leak in.
  db.rowsOf("research_markets").push({ id: 2, workspaceId: 4, name: "Theirs", status: "draft" });
  db.rowsOf("research_sectors").push({ id: 20, workspaceId: 4, marketId: 2, ...cleanSectorContent({ name: "Their counties", status: "verified", targeting: { titles: ["County Administrator"] }, messaging: { avoid: ["Their secret rule"] } }).content, status: "verified" });
  // ...even one whose row points at THIS workspace's market: only its own workspaceId may decide.
  db.rowsOf("research_sectors").push({ id: 21, workspaceId: 4, marketId: 1, ...cleanSectorContent({ name: "Cross-linked", status: "verified", targeting: { titles: ["Sheriff"] }, messaging: { avoid: ["Cross-workspace rule"] } }).content, status: "verified" });
  db.rowsOf("personas").push(
    { id: 100, workspaceId: 2, name: "ADA Coordinator", sectorId: 10, targetTitles: ["ADA Coordinator", "ADA Title II Coordinator"], cares: "Complaints and documentation", pains: ["Liability"], objections: ["No budget"], angle: "Offer a documented audit" },
    { id: 101, workspaceId: 2, name: "Plain persona", sectorId: null, targetTitles: ["Finance Director"], cares: null, pains: [], objections: [], angle: null },
  );
  db.rowsOf("are_campaigns").push({ id: 7, workspaceId: 2, name: "Counties", researchSectorId: 10, personaId: null }, { id: 8, workspaceId: 2, name: "Plain", researchSectorId: null, personaId: 100 });
}

beforeEach(() => {
  h.db = makeSqlFakeDb({ roles: { 2: "admin", 4: "admin" }, wsId: () => h.wsId });
  h.calls = [];
  h.reply = null;
  __clearResearchContextCache();
});

describe("which research applies", () => {
  it("a workspace without research gets nothing, so its writers behave exactly as before", async () => {
    const c = await researchContextFor(2, { surface: "outreach", prospectTitle: "County Administrator" });
    expect(c).toEqual({ block: "", sectorId: null, personaId: null, matchedBy: null, avoid: [] });
  });

  it("the campaign's sector wins; then its persona; then the prospect's title; then the industry", async () => {
    seed(h.db);
    expect(await researchContextFor(2, { surface: "outreach", campaignId: 7, prospectTitle: "Finance Director" })).toMatchObject({ sectorId: 10, matchedBy: "campaign" });
    expect(await researchContextFor(2, { surface: "outreach", campaignId: 8 })).toMatchObject({ sectorId: 10, personaId: 100, matchedBy: "campaign" });
    expect(await researchContextFor(2, { surface: "outreach", prospectTitle: "Senior ADA Title II Coordinator, Loudoun County" })).toMatchObject({ sectorId: 10, personaId: 100, matchedBy: "title" });
    expect(await researchContextFor(2, { surface: "outreach", prospectTitle: "Deputy County Administrator" })).toMatchObject({ sectorId: 10, personaId: null, matchedBy: "title" });
    expect(await researchContextFor(2, { surface: "outreach", prospectTitle: "Plumber", industry: "Government Administration" })).toMatchObject({ sectorId: 10, matchedBy: "industry" });
  });

  it("never a draft sector, never a persona without research, never another workspace's research", async () => {
    seed(h.db);
    expect((await researchContextFor(2, { surface: "outreach", prospectTitle: "City Manager" })).block).toBe("");
    expect((await researchContextFor(2, { surface: "outreach", sectorId: 11 })).block).toBe("");
    expect((await researchContextFor(2, { surface: "outreach", prospectTitle: "Finance Director" })).block).toBe("");
    expect((await researchContextFor(2, { surface: "outreach", sectorId: 20 })).block).toBe("");
    expect((await researchContextFor(2, { surface: "outreach", sectorId: 21 })).block).toBe("");
    expect((await researchContextFor(2, { surface: "outreach", prospectTitle: "Sheriff" })).block).toBe("");
    const mine = await researchContextFor(2, { surface: "outreach", prospectTitle: "County Administrator" });
    expect(mine.block).not.toContain("Their secret rule");
    expect(mine.avoid).toEqual(["Don't promise that an overlay makes a county compliant."]);
  });

  it("a recipient id becomes a title, industry and campaign, inside the workspace only", async () => {
    h.db.rowsOf("prospect_queue").push({ id: 5, workspaceId: 2, campaignId: 7, title: "ADA Coordinator", industry: "Government Administration" });
    h.db.rowsOf("contacts").push({ id: 6, workspaceId: 2, title: "County Administrator", accountId: 9 }, { id: 60, workspaceId: 4, title: "Theirs", accountId: null });
    h.db.rowsOf("accounts").push({ id: 9, workspaceId: 2, industry: "Government Administration" });
    expect(await researchUseFor(2, "outreach", { prospectQueueId: 5 })).toEqual({ surface: "outreach", prospectTitle: "ADA Coordinator", industry: "Government Administration", campaignId: 7 });
    expect(await researchUseFor(2, "reply", { contactId: 6 })).toEqual({ surface: "reply", prospectTitle: "County Administrator", industry: "Government Administration" });
    expect(await researchUseFor(2, "reply", { contactId: 60 })).toEqual({ surface: "reply" });
  });

  it("matches whole words only", () => {
    expect(titleMatchLength("CFO & COO", ["CFO"])).toBe(3);
    expect(titleMatchLength("Director of IT", ["CTO"])).toBe(0);
    expect(titleMatchLength("Chief Technology Officer", ["Technology"])).toBe(10);
    expect(titleMatchLength("Assistant", ["IT"])).toBe(0);
  });
});

describe("the block", () => {
  const persona = { id: 1, name: "ADA Coordinator", sectorId: 10, titles: [], cares: "Documentation", pains: ["Liability"], objections: ["No budget"], angle: "A documented audit" };

  it("outreach carries the rules, the buyer, the pains, the words, what to lead with and a sourced fact", () => {
    const b = formatResearchBlock({ surface: "outreach", marketName: "State and local government", sector: COUNTIES, persona });
    expect(b).toContain("## The prospect's market (your research: State and local government › County governments)");
    expect(b).toContain("Never say or imply:\n- Don't promise that an overlay makes a county compliant.");
    expect(b).toContain("The buyer: ADA Coordinator");
    expect(b).toContain("Lead with:");
    expect(b).toContain("- 3,069 county governments (https://www.naco.org/page/what-are-counties)");
    expect(b).toContain("never as this prospect's own figures");
  });

  it("the phone agent gets no statistics and no objections; the judge gets the rules", () => {
    const v = formatResearchBlock({ surface: "voice", marketName: "M", sector: COUNTIES, persona });
    expect(v).not.toContain("3,069");
    expect(v).not.toContain("Objections");
    expect(v).toContain("Never say or imply");
    const j = formatResearchBlock({ surface: "judge", marketName: "M", sector: COUNTIES, persona: null });
    expect(j.startsWith("## Rules from your market research")).toBe(true);
  });

  it("trims to its budget, lowest priority first, and never drops an avoid rule", () => {
    const long = cleanSectorContent({
      ...COUNTIES,
      buyers: { painPoints: Array.from({ length: 20 }, (_, i) => `Pain number ${i} `.repeat(20)) },
      messaging: { ...COUNTIES.messaging, avoid: Array.from({ length: 10 }, (_, i) => `Avoid rule ${i} `.repeat(12)) },
    }).content;
    const v = formatResearchBlock({ surface: "voice", marketName: "M", sector: long, persona });
    for (let i = 0; i < 10; i++) expect(v).toContain(`Avoid rule ${i}`);
    expect(v).not.toContain("Words they use");
  });
});

describe("the research option on invokeLLM", () => {
  it("adds the block to the system prompt for the prospect's market, and nothing when nothing matches", async () => {
    seed(h.db);
    await invokeLLM({
      workspaceId: 2,
      provider: "anthropic",
      research: { surface: "outreach", prospectTitle: "ADA Coordinator" },
      messages: [{ role: "system", content: "You write emails." }, { role: "user", content: "Write one." }],
    });
    expect(h.calls[0].system).toContain("You write emails.\n\n## The prospect's market");
    expect(h.calls[0].system).toContain("The buyer: ADA Coordinator");

    h.calls = [];
    await invokeLLM({ workspaceId: 2, provider: "anthropic", research: { surface: "outreach", prospectTitle: "Plumber" }, messages: [{ role: "system", content: "You write emails." }, { role: "user", content: "Write one." }] });
    expect(h.calls[0].system).toBe("You write emails.");
  });
});

describe("the avoid-rule check", () => {
  const steps = [{ subject: "Compliance made easy", body: "Our overlay makes your county fully compliant overnight.", channel: "email" }];

  it("costs nothing when the matched research has no avoid rules", async () => {
    expect(await checkAvoidRules(2, { prospectTitle: "Plumber" }, steps)).toEqual({ checked: false, rules: 0, violations: [] });
    expect(h.calls).toHaveLength(0);
  });

  it("asks the model which rules the copy breaks, and says which in the hold", async () => {
    seed(h.db);
    h.reply = () => ({ id: "m", model: "m", content: [{ type: "tool_use", id: "t", name: "respond_with_structured_output", input: { violations: [{ rule: "Don't promise that an overlay makes a county compliant.", quote: "Our overlay makes your county fully compliant" }] } }], stop_reason: "tool_use", usage: { input_tokens: 1, output_tokens: 1 } });
    const r = await checkAvoidRules(2, { campaignId: 7 }, steps);
    expect(r).toMatchObject({ checked: true, rules: 1 });
    expect(r.violations).toHaveLength(1);
    expect(h.calls[0].messages[0].content).toContain("1. Don't promise that an overlay makes a county compliant.");
    expect(h.calls[0].messages[0].content).toContain("Our overlay makes your county fully compliant overnight.");
    expect(holdReason(r.violations)).toBe(`Breaks your research's avoid rule "Don't promise that an overlay makes a county compliant.": "Our overlay makes your county fully compliant"`);
    expect(holdReason([])).toBe("");
  });

  it("a judge that fails holds nothing and reports why", async () => {
    seed(h.db);
    h.reply = () => { throw Object.assign(new Error("overloaded"), { status: 529 }); };
    const r = await checkAvoidRules(2, { campaignId: 7 }, steps);
    expect(r.checked).toBe(false);
    expect(r.violations).toEqual([]);
    expect(r.error).toBeTruthy();
  }, 30_000);

  it("a held sequence is not enrolled, its row says so, and a person can release it in their own workspace", async () => {
    const engine = read("server/areEngine.ts");
    expect(engine).toContain("isNull(prospectIntelligence.copyHoldReason),");
    expect(engine).toContain("an avoid rule from your research and");
    const agent = read("server/routers/are/prospects.ts");
    expect(agent).toContain("const avoid = await checkAvoidRules(workspaceId, { campaignId, prospectTitle: prospect.title, industry: prospect.industry }, steps);");
    expect(agent).toMatch(/sequenceRewriteCount: 0,\n\s+copyHoldReason,\n/);

    h.db.rowsOf("prospect_intelligence").push({ id: 1, prospectQueueId: 5, workspaceId: 2, copyHoldReason: "Breaks your research's avoid rule" });
    const ctx = (ws: number) => ({
      user: { id: 1, openId: "u", email: "o@example.com", name: "O", loginMethod: "password", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
      req: { protocol: "https", headers: { "x-workspace-id": String(ws) } },
      res: { clearCookie: () => {} },
    }) as unknown as TrpcContext;
    h.wsId = 4;
    await expect(appRouter.createCaller(ctx(4)).are.prospects.releaseCopyHold({ prospectId: 5 })).rejects.toMatchObject({ code: "NOT_FOUND" });
    h.wsId = 2;
    expect(await appRouter.createCaller(ctx(2)).are.prospects.releaseCopyHold({ prospectId: 5 })).toEqual({ released: true });
    expect(h.db.rowsOf("prospect_intelligence")[0].copyHoldReason).toBeNull();
    expect(h.db.rowsOf("audit_log").at(-1)).toMatchObject({ entityType: "are_prospect", entityId: 5 });
  });
});
