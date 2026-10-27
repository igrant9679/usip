/**
 * Research phase 6, learning from results (owner, 2026-10-14: "start phase
 * 6"). Done when the sector page shows which pains and opening lines get
 * replies. Runs against the shared in-memory database with the provider SDK
 * stubbed, so the brief check's invokeLLM call is real.
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
import { appRouter } from "./routers";
import { __clearResearchContextCache } from "./services/research/context";
import { checkBrief } from "./services/research/avoidCheck";
import { outcomeOf, researchUseColumns } from "./services/research/results";
import { cleanSectorContent } from "@shared/researchShape";
import { MIN_SAMPLE, hookTypeKey, openingLineOf, rankByReplies, replyLabel, emptyTally } from "@shared/researchResults";

const read = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8").replace(/\r\n/g, "\n");

const PAINS = ["No staff to own compliance", "Hundreds of inaccessible PDFs"];
const LEADS = ["The deadline moved; the standard didn't.", "Audits find the same five failures."];
const COUNTIES = cleanSectorContent({
  name: "County governments",
  status: "researched",
  buyers: { painPoints: PAINS },
  targeting: { titles: ["County Administrator", "ADA Coordinator"] },
  messaging: { leadWith: LEADS, avoid: ["Don't promise that an overlay makes a county compliant."] },
}).content;

function caller(ws: number) {
  h.wsId = ws;
  return appRouter.createCaller({
    user: { id: 1, openId: "u", email: "o@example.com", name: "O", loginMethod: "password", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
    req: { protocol: "https", headers: { "x-workspace-id": String(ws) } },
    res: { clearCookie: () => {} },
  } as unknown as TrpcContext);
}

beforeEach(() => {
  h.db = makeSqlFakeDb({ roles: { 2: "admin", 4: "admin", 9: "rep" }, wsId: () => h.wsId });
  h.calls = [];
  h.reply = null;
  __clearResearchContextCache();
});

/* ── Pieces ─────────────────────────────────────────────────────────────── */

describe("the opening line", () => {
  it("is the first sentence after the greeting", () => {
    expect(openingLineOf("Hi {{firstName}},\n\nSaw the county's new ADA plan. Curious how you staff it?")).toBe("Saw the county's new ADA plan.");
    expect(openingLineOf("Hello there!\nThe deadline moved; the standard didn't. More below.")).toBe("The deadline moved; the standard didn't.");
    expect(openingLineOf("Hi Jane, saw the county's new plan. Quick question.")).toBe("saw the county's new plan.");
    expect(openingLineOf("<p>Hi Jane,</p><p>Your audit came back with &amp; without PDFs flagged.</p>")).toBe("Your audit came back with & without PDFs flagged.");
    expect(openingLineOf("Quick one: who owns Title II at the county")).toBe("Quick one: who owns Title II at the county");
    expect(openingLineOf(null)).toBe("");
  });

  it("hooks are stable keys, whatever the enrich model wrote", () => {
    expect(hookTypeKey("Trigger Event")).toBe("trigger_event");
    expect(hookTypeKey("personalization")).toBe("personalisation");
    expect(hookTypeKey("")).toBe("generic");
  });

  it("a rate needs enough contacted prospects to mean something", () => {
    expect(replyLabel({ contacted: 7, replied: 3 })).toBe("3 of 7 replied");
    expect(replyLabel({ contacted: 12, replied: 3 })).toBe("3 of 12 replied (25%)");
    expect(replyLabel({ contacted: 0, replied: 0 })).toBe("not contacted yet");
    const t = (contacted: number, replied: number, name: string) => ({ ...emptyTally(), written: contacted, contacted, replied, name });
    // Two replies from three beats nothing only once there is enough to compare: below MIN_SAMPLE it goes last.
    expect(rankByReplies([t(5, 4, "few"), t(20, 2, "low"), t(10, 5, "high")]).map((x) => x.name)).toEqual(["high", "low", "few"]);
    expect(MIN_SAMPLE).toBe(10);
  });
});

describe("what happened to a prospect", () => {
  const sent = [{ stepIndex: 1, messageContent: { body: "Hi,\nFollow-up line." }, executedAt: new Date("2026-10-02") }, { stepIndex: 0, messageContent: { body: "Hi,\nFirst line. More." }, executedAt: new Date("2026-10-01") }];
  const reply = (signalType: string, sentiment: string | null = null) => ({ signalType, sentiment, processedAt: new Date("2026-10-03") });

  it("an out-of-office alone is not a reply; anything else is", () => {
    expect(outcomeOf(sent, [reply("email_reply")], [{ replyClass: "out_of_office" }])).toMatchObject({ contacted: true, replied: false });
    expect(outcomeOf(sent, [reply("email_reply")], [{ replyClass: "out_of_office" }, { replyClass: "not_interested" }]).replied).toBe(true);
    expect(outcomeOf(sent, [reply("email_reply"), reply("linkedin_reply")], [{ replyClass: "out_of_office" }]).replied).toBe(true);
    expect(outcomeOf(sent, [reply("email_reply")], []).replied).toBe(true); // not classified yet
  });

  it("positive and meetings, and nothing counts without a send", () => {
    expect(outcomeOf(sent, [reply("email_reply", "positive")], []).positive).toBe(true);
    expect(outcomeOf(sent, [reply("email_reply")], [{ replyClass: "willing_to_meet" }]).positive).toBe(true);
    expect(outcomeOf(sent, [reply("email_reply", "negative")], []).positive).toBe(false);
    expect(outcomeOf(sent, [reply("meeting_booked")], []).meeting).toBe(true);
    expect(outcomeOf([], [reply("email_reply", "positive"), reply("meeting_booked")], [])).toMatchObject({ contacted: false, replied: false, positive: false, meeting: false });
  });

  it("the opener is the first step that was actually sent", () => {
    expect(outcomeOf(sent, [], []).sentOpener).toBe("First line.");
  });
});

describe("recording the research a sequence used", () => {
  const steps = [{ channel: "email", body: "" }, { channel: "email", body: "Hi Jo,\nThe deadline moved. Talk?" }];
  const brief = { checked: true, rules: 1, violations: [], pains: [PAINS[0]], leads: [LEADS[0]] };

  it("nothing when no research matched", () => {
    expect(researchUseColumns({ sectorId: null, personaId: null, matchedBy: null }, brief, { hookType: "award", steps })).toEqual({ researchSectorId: null, researchPersonaId: null, researchUse: null });
  });

  it("the sector, persona, pains, lead-with points, hook, opener and the check's verdict", () => {
    const r = researchUseColumns({ sectorId: 10, personaId: 100, matchedBy: "campaign" }, brief, { hookType: "Trigger Event", steps });
    expect(r).toMatchObject({ researchSectorId: 10, researchPersonaId: 100 });
    expect(r.researchUse).toMatchObject({ pains: [PAINS[0]], leads: [LEADS[0]], check: "passed", hookType: "trigger_event", opener: "The deadline moved.", matchedBy: "campaign" });
    const verdict = (b: any) => researchUseColumns({ sectorId: 10, personaId: null, matchedBy: "title" }, b, { hookType: "x", steps }).researchUse!.check;
    expect(verdict({ ...brief, violations: [{ rule: "r", quote: "q" }] })).toBe("held");
    expect(verdict({ ...brief, checked: false, error: "overloaded" })).toBe("error");
    expect(verdict({ ...brief, rules: 0 })).toBe("none"); // pains tagged, but no avoid rule to pass
    expect(verdict(null)).toBe("none"); // fixed copy
  });

  it("the brief check names the pains and lead-with points the copy uses, from the research's own list", async () => {
    h.db.rowsOf("research_markets").push({ id: 1, workspaceId: 2, name: "SLG", status: "draft" });
    h.db.rowsOf("research_sectors").push({ id: 10, workspaceId: 2, marketId: 1, ...COUNTIES, status: "researched" });
    // The persona the title picks adds its own pains; one the sector already has is not repeated.
    h.db.rowsOf("personas").push({ id: 100, workspaceId: 2, name: "Administrator", sectorId: 10, targetTitles: ["County Administrator"], cares: "Budget", pains: ["no staff to own compliance", "Liability"], objections: [], angle: "" });
    h.reply = () => ({ id: "m", model: "m", content: [{ type: "tool_use", id: "t", name: "respond_with_structured_output", input: { violations: [], pains: [2, 2, 3, 9, 0], leads: [1] } }], stop_reason: "tool_use", usage: { input_tokens: 1, output_tokens: 1 } });
    const r = await checkBrief(2, { prospectTitle: "County Administrator" }, [{ body: "Your PDFs…" }]);
    expect(r).toMatchObject({ checked: true, sectorId: 10, personaId: 100, pains: [PAINS[1], "Liability"], leads: [LEADS[0]], violations: [] });
    expect(h.calls[0].messages[0].content).toContain(`Pains:\n1. ${PAINS[0]}\n2. ${PAINS[1]}\n3. Liability\n\n`);
    expect(h.calls[0].messages[0].content).toContain(`Lead-with points:\n1. ${LEADS[0]}`);
  });

  it("research with pains but no avoid rules is still checked for pains, and nothing is held", async () => {
    h.db.rowsOf("research_markets").push({ id: 1, workspaceId: 2, name: "SLG", status: "draft" });
    h.db.rowsOf("research_sectors").push({ id: 10, workspaceId: 2, marketId: 1, ...COUNTIES, messaging: { ...COUNTIES.messaging, avoid: [] }, status: "researched" });
    h.reply = () => ({ id: "m", model: "m", content: [{ type: "tool_use", id: "t", name: "respond_with_structured_output", input: { violations: [{ rule: "invented", quote: "x" }], pains: [1], leads: [] } }], stop_reason: "tool_use", usage: { input_tokens: 1, output_tokens: 1 } });
    const r = await checkBrief(2, { prospectTitle: "County Administrator" }, [{ body: "x" }]);
    expect(r).toMatchObject({ checked: true, rules: 0, violations: [], pains: [PAINS[0]] });
    expect(h.calls[0].messages[0].content).not.toContain("Rules (never say or imply)");
  });

  it("the sequence writer saves the record with the sequence; fixed copy records who it went to without a check", () => {
    const agent = read("server/routers/are/prospects.ts");
    // 2026-10-24: the WHERE gained the workspace term (audit C6 — the dossier
    // write was keyed on the bare prospect id).
    expect(agent).toContain("      ...researchUseColumns(brief, brief, { hookType: primaryHookOf(intel).hookType, steps }),\n    }).where(and(eq(prospectIntelligence.prospectQueueId, prospectId), eq(prospectIntelligence.workspaceId, workspaceId)));");
    expect(agent).toContain('        ...researchUseColumns(await researchMatchFor(workspaceId, { campaignId, prospectTitle: prospect.title, industry: prospect.industry }), null, { hookType: "fixed", steps }),');
    expect(agent.match(/await checkBrief\(/g)).toHaveLength(1);
  });
});

/* ── Results on the sector and persona pages ───────────────────────────── */

let pq = 0;
/** One prospect whose copy used sector 10: written, maybe sent, maybe answered. */
function prospect(ws: number, o: { persona?: number | null; pains?: string[]; leads?: string[]; hook?: string; check?: string; sent?: string; signals?: [string, string | null][]; replies?: string[]; sector?: number }) {
  const id = ++pq;
  const db = h.db;
  db.rowsOf("prospect_queue").push({ id, workspaceId: ws, campaignId: 7, firstName: "Pat", lastName: `Person${id}`, title: `Title ${id}`, companyName: `County ${id}`, sequenceStatus: "enrolled" });
  db.rowsOf("prospect_intelligence").push({
    id, prospectQueueId: id, workspaceId: ws, researchSectorId: o.sector ?? 10, researchPersonaId: o.persona ?? null,
    researchUse: { pains: o.pains ?? [], leads: o.leads ?? [], check: o.check ?? "passed", hookType: o.hook ?? "trigger_event", opener: "Generated opener.", matchedBy: "campaign", at: `2026-10-0${1 + (id % 5)}T00:00:00.000Z` },
  });
  if (o.sent) db.rowsOf("are_execution_queue").push({ id, workspaceId: ws, campaignId: 7, prospectQueueId: id, stepIndex: 0, channel: "email", status: "sent", executedAt: new Date("2026-10-05"), messageContent: { body: `Hi Pat,\n${o.sent} More.` } });
  for (const [signalType, sentiment] of o.signals ?? []) db.rowsOf("are_signal_log").push({ workspaceId: ws, prospectQueueId: id, campaignId: 7, signalType, sentiment, processedAt: new Date("2026-10-07") });
  for (const replyClass of o.replies ?? []) db.rowsOf("email_replies").push({ workspaceId: ws, prospectQueueId: id, replyClass, receivedAt: new Date() });
  return id;
}

function seedResults() {
  pq = 0;
  const db = h.db;
  db.rowsOf("research_markets").push({ id: 1, workspaceId: 2, name: "SLG", status: "draft" });
  db.rowsOf("research_sectors").push({ id: 10, workspaceId: 2, marketId: 1, ...COUNTIES, status: "researched" });
  db.rowsOf("personas").push(
    { id: 100, workspaceId: 2, name: "ADA Coordinator", sectorId: 10, targetTitles: [], pains: ["Liability"], objections: [] },
    { id: 101, workspaceId: 2, name: "County Administrator", sectorId: 10, targetTitles: [], pains: [], objections: [] },
  );
  // Pain 0 ("No staff…"): 10 contacted, 4 replied (one only out-of-office), 2 positive, 1 meeting.
  for (let i = 0; i < 10; i++) {
    const signals: [string, string | null][] = i < 3 ? [["email_reply", i === 0 ? "positive" : "neutral"]] : i === 3 ? [["email_reply", null]] : [];
    prospect(2, {
      persona: 100, pains: [PAINS[0]], leads: [LEADS[0]], hook: "award",
      sent: `Line ${i} about staffing.`,
      signals: i === 1 ? [...signals, ["meeting_booked", null]] : signals,
      replies: i === 3 ? ["out_of_office"] : i === 2 ? ["willing_to_meet"] : [],
    });
  }
  // Pain 1 ("Hundreds of PDFs"): 10 contacted, none replied; one held by the check.
  for (let i = 0; i < 10; i++) prospect(2, { persona: 101, pains: [PAINS[1]], hook: "pain_signal", sent: `PDF line ${i}.`, check: i === 0 ? "held" : "passed" });
  // Written but never sent, with a pain the research has since dropped.
  prospect(2, { persona: null, pains: ["An old pain"], check: "none" });
  // Fixed copy: a person wrote it, so it counts for the sector but says nothing about hooks.
  prospect(2, { persona: null, hook: "fixed", check: "none", sent: "Our standard letter." });
  // LSI's sector 10 is not CommunityForce's: the same ids in workspace 4 must never count.
  prospect(4, { persona: 100, pains: [PAINS[0]], sent: "Theirs.", signals: [["email_reply", "positive"]] });
}

describe("a sector's results", () => {
  it("show which pains and opening lines get replies", async () => {
    seedResults();
    const r = await caller(2).research.results.sector({ id: 10 });

    expect(r.total).toEqual({ written: 22, contacted: 21, replied: 3, positive: 2, meetings: 1 });
    expect(r.check).toEqual({ checked: 20, passed: 19, held: 1, errors: 0 });
    expect(r.since).toBe("2026-10-01T00:00:00.000Z");

    // Pains: best first, the research's own wording, a dropped one marked, unused ones last.
    expect(r.pains.map((p) => [p.text, p.contacted, p.replied, p.inResearch])).toEqual([
      [PAINS[0], 10, 3, true],
      [PAINS[1], 10, 0, true],
      ["An old pain", 0, 0, false],
      ["Liability", 0, 0, true],
    ]);
    expect(r.leads.map((l) => [l.text, l.written, l.replied])).toEqual([[LEADS[0], 10, 3], [LEADS[1], 0, 0]]);
    expect(r.hooks.map((x) => [x.hookType, x.replied])).toEqual([["award", 3], ["pain_signal", 0], ["trigger_event", 0]]);
    expect(r.personas.map((p) => [p.name, p.contacted, p.replied, p.meetings])).toEqual([
      ["ADA Coordinator", 10, 3, 1],
      ["County Administrator", 10, 0, 0],
      ["No persona matched", 1, 0, 0],
    ]);

    // The lines that got replies, as sent: a meeting first, then positive (newest first), with role and organization, never the person.
    expect(r.repliedOpeners.map((o) => o.line)).toEqual(["Line 1 about staffing.", "Line 2 about staffing.", "Line 0 about staffing."]);
    expect(r.repliedOpeners[0]).toMatchObject({ meeting: true, positive: false, title: "Title 2", company: "County 2" });
    expect(r.repliedOpeners.map((o) => o.positive)).toEqual([false, true, true]);
    expect(JSON.stringify(r)).not.toContain("Person");
    expect(JSON.stringify(r)).not.toContain("Theirs");
  });

  it("are the workspace's own: another workspace's sector is not found, and a rep can read them", async () => {
    seedResults();
    await expect(caller(4).research.results.sector({ id: 10 })).rejects.toMatchObject({ code: "NOT_FOUND" });
    h.db.rowsOf("research_sectors").push({ id: 30, workspaceId: 9, marketId: 1, ...COUNTIES, status: "researched" });
    expect((await caller(9).research.results.sector({ id: 30 })).total.written).toBe(0);
  });

  it("a persona's results, and each persona's line in the lists", async () => {
    seedResults();
    const r = await caller(2).research.results.persona({ id: 100 });
    expect(r.total).toMatchObject({ written: 10, contacted: 10, replied: 3, meetings: 1 });
    expect(r.personas).toEqual([]);
    // The persona's copy had the sector's pains too: they are the research's, not "no longer in it".
    expect(r.pains.find((p) => p.text === PAINS[0])).toMatchObject({ inResearch: true, replied: 3 });
    const all = await caller(2).research.results.personas();
    expect(all[100]).toEqual({ written: 10, contacted: 10, replied: 3, positive: 2, meetings: 1, capped: false });
    expect(all[101]).toEqual({ written: 10, contacted: 10, replied: 0, positive: 0, meetings: 0, capped: false });
    expect(Object.keys(all).sort()).toEqual(["100", "101"]);
    await expect(caller(4).research.results.persona({ id: 101 })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
