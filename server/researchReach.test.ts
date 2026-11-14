/**
 * Research reaches the places it did not (owner, 2026-11-14: "Fix all gaps",
 * after asking how the Research section informs the rest of the app):
 *
 *   - a company's sector tag picks the research for its people;
 *   - a person in a Revenue Engine campaign gets that campaign's research
 *     from every writer, not only the campaign's own and the mailbox;
 *   - the voice agent that ANSWERS calls gets the spoken brief, like the one
 *     that places them;
 *   - the website chat gets it for a visitor who has proven their email, and
 *     for nobody else; its follow-up email gets it for a known address;
 *   - the AI Assistant can read markets and sectors;
 *   - research.writers.view shows what a writer is given, and why.
 *
 * Runs on the shared in-memory database with the provider SDK stubbed, so the
 * composer, the recipient lookups and the procedures are real.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => ({ db: null as any, wsId: 2, calls: [] as any[] }));

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
        const tool = params.tools?.[0]?.name;
        const input = { reply: "ok", extracted: { name: null, email: null, company: null, phone: null }, score: 10, intent: "x", summary: "y", wantsMeeting: false, needsHuman: false, sendCode: false, subject: "s", body: "b" };
        return tool
          ? { id: "m", model: "m", content: [{ type: "tool_use", id: "t", name: tool, input }], stop_reason: "tool_use", usage: { input_tokens: 1, output_tokens: 1 } }
          : { id: "m", model: "m", content: [{ type: "text", text: JSON.stringify(input) }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } };
      },
    };
  },
}));

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { appRouter } from "./routers";
import { __clearResearchContextCache, researchContextFor } from "./services/research/context";
import { researchUseFor, researchUseForRecipient } from "./services/research/recipient";
import { runChatTurn } from "./services/chatAgent";
import { DENY_PATH, getActionCatalog } from "./services/assistantActionCatalog";
import { cleanSectorContent } from "@shared/researchShape";

const read = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8").replace(/\r\n/g, "\n");

const COUNTIES = cleanSectorContent({
  name: "County governments",
  status: "researched",
  buyers: { painPoints: ["No staff to own compliance"] },
  targeting: { titles: ["County Administrator"], industries: ["Government Administration"] },
  messaging: { avoid: ["Don't promise that an overlay makes a county compliant."], vocabulary: ["Title II"], leadWith: ["The deadline moved, the standard did not"] },
}).content;
const CITIES = cleanSectorContent({ name: "City governments", status: "researched", targeting: { titles: ["City Manager"] }, messaging: { vocabulary: ["council"] } }).content;
const HOSPITALS = cleanSectorContent({ name: "Regional hospitals", status: "draft", targeting: { titles: ["Chief Nursing Officer"] }, messaging: { vocabulary: ["census"] } }).content;

const COUNTY_HEAD = "State and local government › County governments";
const CITY_HEAD = "State and local government › City governments";

function seed() {
  const db = h.db;
  db.rowsOf("research_markets").push({ id: 1, workspaceId: 2, name: "State and local government", status: "draft" });
  db.rowsOf("research_sectors").push(
    { id: 10, workspaceId: 2, marketId: 1, ...COUNTIES, status: "researched" },
    { id: 11, workspaceId: 2, marketId: 1, ...CITIES, status: "researched" },
    { id: 12, workspaceId: 2, marketId: 1, ...HOSPITALS, status: "draft" },
  );
  // CommunityForce's own sector: never LSI Media's to use.
  db.rowsOf("research_markets").push({ id: 2, workspaceId: 4, name: "Theirs", status: "draft" });
  db.rowsOf("research_sectors").push({ id: 20, workspaceId: 4, marketId: 2, ...COUNTIES, name: "Their counties", status: "verified" });

  db.rowsOf("accounts").push(
    { id: 70, workspaceId: 2, name: "Springfield", industry: null, researchSectorId: 11 }, // tagged: cities
    { id: 71, workspaceId: 2, name: "Mercy", industry: null, researchSectorId: 12 }, // tagged with a draft
    { id: 72, workspaceId: 2, name: "Odd", industry: null, researchSectorId: 20 }, // tagged with another workspace's
    { id: 73, workspaceId: 2, name: "Plain", industry: null, researchSectorId: null },
  );
  db.rowsOf("contacts").push(
    // A county title at a company tagged as a city: the tag wins.
    { id: 5, workspaceId: 2, firstName: "A", email: "a@springfield.gov", title: "County Administrator", accountId: 70 },
    { id: 6, workspaceId: 2, firstName: "B", email: "b@mercy.org", title: "County Administrator", accountId: 71 },
    { id: 7, workspaceId: 2, firstName: "C", email: "c@odd.org", title: "County Administrator", accountId: 72 },
    { id: 8, workspaceId: 2, firstName: "D", email: "d@plain.org", title: "Office Manager", accountId: 73 },
    { id: 9, workspaceId: 2, firstName: "E", email: "e@linked.org", title: "Office Manager", accountId: null },
  );
  db.rowsOf("prospects").push(
    { id: 30, workspaceId: 2, firstName: "P", lastName: "One", email: "p1@x.org", title: "Office Manager", industry: null, accountId: null },
    { id: 31, workspaceId: 2, firstName: "P", lastName: "Two", email: "p2@x.org", title: "Office Manager", industry: null, accountId: null },
    { id: 32, workspaceId: 2, firstName: "P", lastName: "Three", email: "p3@x.org", title: "Office Manager", industry: null, accountId: 70 },
  );
  db.rowsOf("leads").push({ id: 40, workspaceId: 2, firstName: "L", email: "lead@x.org", title: "Office Manager", company: "X" });
  // Campaign 7 writes for counties; campaign 8 has no research.
  db.rowsOf("are_campaigns").push(
    { id: 7, workspaceId: 2, name: "Counties", researchSectorId: 10, personaId: null },
    { id: 8, workspaceId: 2, name: "Plain", researchSectorId: null, personaId: null },
    { id: 9, workspaceId: 4, name: "Theirs", researchSectorId: 20, personaId: null },
  );
  db.rowsOf("prospect_queue").push(
    { id: 50, workspaceId: 2, campaignId: 7, email: "p1@x.org", title: "Office Manager", sourceType: "apollo", personProspectId: 30, rejectedAt: null },
    // Turned down by the campaign: it lends them nothing.
    { id: 51, workspaceId: 2, campaignId: 7, email: "p2@x.org", title: "Office Manager", sourceType: "apollo", personProspectId: 31, rejectedAt: new Date("2026-11-01T00:00:00Z") },
    { id: 52, workspaceId: 2, campaignId: 7, email: "e@linked.org", title: "Office Manager", sourceType: "apollo", rejectedAt: null },
    // Rejected by campaign 7 later, kept by campaign 8 earlier: the one that kept them counts.
    { id: 56, workspaceId: 2, campaignId: 8, email: "two@x.org", title: "Office Manager", sourceType: "apollo", rejectedAt: null },
    { id: 57, workspaceId: 2, campaignId: 7, email: "two@x.org", title: "Office Manager", sourceType: "apollo", rejectedAt: new Date("2026-11-02T00:00:00Z") },
    { id: 53, workspaceId: 2, campaignId: 7, email: "lead@x.org", title: "Office Manager", sourceType: "apollo", rejectedAt: null },
    { id: 54, workspaceId: 2, campaignId: 7, email: "p3@x.org", title: "Office Manager", sourceType: "apollo", personProspectId: 32, rejectedAt: null },
    // Another workspace's campaign row for the same address.
    { id: 55, workspaceId: 4, campaignId: 9, email: "d@plain.org", title: "Office Manager", sourceType: "apollo", rejectedAt: null },
  );
}

function caller(ws: number) {
  h.wsId = ws;
  return appRouter.createCaller({
    user: { id: 1, openId: "u", email: "o@example.com", name: "O", loginMethod: "password", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
    req: { protocol: "https", headers: { "x-workspace-id": String(ws) } },
    res: { clearCookie: () => {} },
  } as unknown as TrpcContext);
}

beforeEach(() => {
  h.db = makeSqlFakeDb({ roles: { 2: "admin", 4: "admin" }, wsId: () => h.wsId });
  h.calls = [];
  __clearResearchContextCache();
  seed();
});

/* ── The company's sector tag ───────────────────────────────────────────── */

describe("a company's sector tag picks the research for its people", () => {
  it("the tag wins over a job title that matches another sector", async () => {
    const use = await researchUseFor(2, "outreach", { contactId: 5 });
    expect(use).toMatchObject({ prospectTitle: "County Administrator", accountSectorId: 11 });
    const c = await researchContextFor(2, use);
    expect(c).toMatchObject({ sectorId: 11, matchedBy: "account", sectorName: "City governments", marketName: "State and local government" });
    expect(c.block).toContain(CITY_HEAD);
    expect(c.block).not.toContain(COUNTY_HEAD);
  });

  it("a tag that names a draft, or another workspace's sector, is ignored and the title decides", async () => {
    for (const contactId of [6, 7]) {
      const c = await researchContextFor(2, await researchUseFor(2, "outreach", { contactId }));
      expect(c, `contact ${contactId}`).toMatchObject({ sectorId: 10, matchedBy: "title" });
    }
  });

  it("a sector chosen on purpose still wins: by name, and by the campaign", async () => {
    const named = await researchContextFor(2, { surface: "outreach", sectorId: 10, accountSectorId: 11 });
    expect(named).toMatchObject({ sectorId: 10, matchedBy: "sector" });
    // Person 32 is at the city-tagged company and in the counties campaign.
    const use = await researchUseFor(2, "outreach", { prospectId: 32 });
    expect(use).toMatchObject({ campaignId: 7, accountSectorId: 11 });
    expect(await researchContextFor(2, use)).toMatchObject({ sectorId: 10, matchedBy: "campaign" });
  });

  it("an account brief and a deal's intelligence pass the tag", () => {
    for (const f of ["server/routers/accountBriefs.ts", "server/accountBriefsStreamRoute.ts"]) {
      expect(read(f), f).toContain('research: { surface: "research", accountSectorId: account.researchSectorId ?? null,');
    }
    expect(read("server/routers/opportunityIntelligence.ts")).toContain('research: { surface: "research", accountSectorId: account?.researchSectorId ?? null,');
  });
});

/* ── The campaign a person is in ────────────────────────────────────────── */

describe("a person in a campaign gets its research from every writer", () => {
  it("by their People record, or by the address on their contact or lead", async () => {
    expect(await researchUseFor(2, "outreach", { prospectId: 30 })).toMatchObject({ campaignId: 7 });
    expect(await researchUseFor(2, "outreach", { contactId: 9 })).toMatchObject({ campaignId: 7 });
    expect(await researchUseFor(2, "outreach", { leadId: 40 })).toMatchObject({ campaignId: 7 });
    // "Office Manager" matches no sector, so only the campaign can explain this.
    const c = await researchContextFor(2, await researchUseFor(2, "outreach", { prospectId: 30 }));
    expect(c).toMatchObject({ sectorId: 10, matchedBy: "campaign" });
    expect(c.block).toContain(COUNTY_HEAD);
  });

  it("a campaign that turned someone down lends them nothing", async () => {
    const byRecord = await researchUseFor(2, "outreach", { prospectId: 31 });
    expect(byRecord.campaignId ?? null).toBeNull();
    expect((await researchContextFor(2, byRecord)).block).toBe("");
    // The mailbox finds the campaign row by address: same answer.
    const byAddress = await researchUseForRecipient(2, "reply", {}, ["p2@x.org"]);
    expect(byAddress.campaignId ?? null).toBeNull();
    expect(byAddress.prospectTitle).toBe("Office Manager");
    // Turned down by one campaign and kept by another: the one that kept them.
    expect(await researchUseForRecipient(2, "reply", {}, ["two@x.org"])).toMatchObject({ campaignId: 8 });
  });

  it("someone in no campaign, or only in another workspace's, gets none", async () => {
    const use = await researchUseFor(2, "outreach", { contactId: 8 });
    expect(use.campaignId ?? null).toBeNull();
    expect((await researchContextFor(2, use)).block).toBe("");
  });

  it("the sequence engine, meeting invites and workflow drafts all go through that lookup", () => {
    expect(read("server/sequenceEngine.ts")).toContain('await researchUseFor(enrollment.workspaceId, "outreach", { contactId: enrollment.contactId, leadId: enrollment.leadId, prospectId: enrollment.prospectId })');
    expect(read("server/services/meetingScheduler.ts")).toContain('research: await researchUseFor(workspaceId, "outreach", refFromRelated(target.relatedType, target.relatedId))');
    expect(read("server/services/workflowEngine.ts")).toContain('research: await researchUseFor(ws, "outreach", refFromRelated(entity, ctx.relatedId))');
  });

  it("the LinkedIn writers and the lead fit score look the person up, not only their job title", () => {
    const social = read("server/services/socialAutopilot.ts");
    expect(social.split('const use = await researchUseFor(workspaceId, "outreach", who.ref ?? {});').length - 1).toBe(2);
    expect(social.split("research: { ...use, prospectTitle: who.title ?? use.prospectTitle ?? null }").length - 1).toBe(2);
    expect(social).toContain("ref: { contactId: linkedContactId }");
    expect(social).toContain("ref: { leadId: lead.id }");
    expect(read("server/services/approvalTasks.ts")).toContain('ref: t.relatedType === "lead" && t.relatedId ? { leadId: t.relatedId } : undefined');
    expect(read("server/routers/leadScoring.ts")).toContain('research: await researchUseFor(lead.workspaceId, "research", { leadId: lead.id }),');
  });
});

/* ── The voice agent that answers ───────────────────────────────────────── */

describe("the inbound voice agent", () => {
  it("is given the spoken brief for a caller whose number matched a record", () => {
    const bridge = read("server/services/voiceBridge.ts");
    expect(bridge).toContain('const researchUse = await researchUseFor(agent.workspaceId, "voice", refFromRelated(callRow?.relatedType, callRow?.relatedId));');
    expect(bridge).toContain("const research = (await researchContextFor(agent.workspaceId, researchUse)).block;");
    expect(bridge).toContain("defaultInstructions(agent.name, ownerName), brand, research].filter(Boolean)");
  });

  it("the brief is short and carries no statistics, and an unmatched caller gets none", async () => {
    const matched = await researchContextFor(2, await researchUseFor(2, "voice", { prospectId: 30 }));
    expect(matched.block).toContain("Never say or imply:");
    expect(matched.block.length).toBeLessThanOrEqual(900);
    expect(matched.block).not.toContain("Market facts you may cite");
    expect((await researchContextFor(2, await researchUseFor(2, "voice", {}))).block).toBe("");
  });
});

/* ── The website chat ───────────────────────────────────────────────────── */

describe("the website chat", () => {
  const turn = (researchBlock?: string) =>
    runChatTurn({
      workspaceId: 2,
      displayName: "Ava",
      persona: null,
      qualifyingQuestions: [],
      messages: [{ role: "visitor", text: "Do you help counties?", at: new Date().toISOString() }],
      known: {},
      canBook: false,
      researchBlock,
    });

  it("places a verified visitor's market in the prompt, marked as general", async () => {
    const block = (await researchContextFor(2, { surface: "reply", sectorId: 10 })).block;
    await turn(block);
    const sent = JSON.stringify(h.calls);
    expect(sent).toContain("County governments");
    expect(sent).toContain("never present it as something you know about them or their organisation");
  });

  it("says nothing about a market when the caller passes none", async () => {
    await turn();
    await turn("   ");
    const sent = JSON.stringify(h.calls);
    expect(h.calls.length).toBe(2);
    expect(sent).not.toContain("The prospect's market");
    expect(sent).not.toContain("their market in general");
  });

  it("only a visitor who has proven their email gets one (G44)", () => {
    const router = read("server/routers/chatAgents.ts");
    const from = router.indexOf('let researchBlock = "";');
    const to = router.indexOf("const turn = await runChatTurn({");
    expect(from).toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(from);
    const gate = router.slice(from, to);
    expect(gate).toContain('if (identity.status === "verified") {');
    expect(gate).toContain('const use = await researchUseForRecipient(agent.workspaceId, "reply", {}, [typedEmail]);');
    // Nothing else in the router may set it: one assignment, inside that gate.
    expect(router.split("researchBlock = ").length - 1).toBe(2);
    expect(gate.split("researchBlock = ").length - 1).toBe(2);
  });

  it("the follow-up email is written for the market of a known address", () => {
    const follow = read("server/services/chatFollowUp.ts");
    expect(follow).toContain("research: opts.research,");
    expect(follow).toContain('research: await researchUseForRecipient(agent.workspaceId, "reply", { leadId: (s as any).leadId ?? null }, [email]),');
  });
});

/* ── The AI Assistant ───────────────────────────────────────────────────── */

describe("the AI Assistant can read the research", () => {
  it("markets, sectors, results and what a writer would use", async () => {
    const paths = new Set((await getActionCatalog()).map((a) => a.path));
    for (const p of ["research.markets.list", "research.markets.get", "research.sectors.get", "research.sectors.options", "research.results.sector", "research.writers.view", "research.runs.list"]) {
      expect(paths.has(p), p).toBe(true);
    }
  });

  it("but never starts or accepts a run, deletes, restores, or touches links and settings", async () => {
    const cat = await getActionCatalog();
    const research = cat.filter((a) => a.path.startsWith("research."));
    expect(research.length).toBeGreaterThan(10);
    const never = /^research\.(runs\.(start|accept|redraft|cancel|discard|remove)|downstream\.|settings\.set|revisions\.restore|markets\.delete|sectors\.delete)/;
    expect(research.filter((a) => never.test(a.path)).map((a) => a.path)).toEqual([]);
    // The mutations left are edits a manager confirms on a card.
    expect(research.filter((a) => a.kind === "mutation").map((a) => a.path).sort()).toEqual(["research.markets.create", "research.markets.update", "research.sectors.create", "research.sectors.update"]);
    for (const p of ["research.runs.start", "research.runs.accept", "research.downstream.links", "research.settings.setIcpFallback"]) expect(DENY_PATH.test(p), p).toBe(true);
  });
});

/* ── What the writers read ──────────────────────────────────────────────── */

describe("research.writers.view", () => {
  it("shows a sector's block for a kind of writing, with its size and budget", async () => {
    const v = await caller(2).research.writers.view({ surface: "outreach", sectorId: 10 });
    expect(v).toMatchObject({ matchedBy: "sector", sector: { id: 10, name: "County governments", marketName: "State and local government" }, persona: null, sectorNotUsed: null, budget: 2600, avoidRules: 1 });
    expect(v.block).toContain("Never say or imply:");
    expect(v.chars).toBe(v.block.length);
    const voice = await caller(2).research.writers.view({ surface: "voice", sectorId: 10 });
    expect(voice.budget).toBe(900);
    expect(voice.block).not.toContain("Lead with:");
  });

  it("says why a sector asked for is not used", async () => {
    expect(await caller(2).research.writers.view({ surface: "outreach", sectorId: 12 })).toMatchObject({ block: "", sector: null, sectorNotUsed: "draft" });
    // Another workspace's sector reads as not there, never as theirs.
    expect(await caller(2).research.writers.view({ surface: "outreach", sectorId: 20 })).toMatchObject({ block: "", sector: null, sectorNotUsed: "missing" });
  });

  it("explains a recipient by address: the record, and the reason", async () => {
    const v = await caller(2).research.writers.view({ surface: "outreach", email: "p1@x.org" });
    expect(v).toMatchObject({ recordFound: true, matchedBy: "campaign", sector: { id: 10 }, known: { title: "Office Manager", inCampaign: true, companyHasSector: false } });
    const tagged = await caller(2).research.writers.view({ surface: "outreach", email: "a@springfield.gov" });
    expect(tagged).toMatchObject({ recordFound: true, matchedBy: "account", sector: { id: 11 }, known: { companyHasSector: true } });
  });

  it("an unknown address finds nothing; a typed title still matches", async () => {
    expect(await caller(2).research.writers.view({ surface: "outreach", email: "nobody@nowhere.org" })).toMatchObject({ recordFound: false, block: "", sector: null, matchedBy: null });
    expect(await caller(2).research.writers.view({ surface: "outreach", email: "nobody@nowhere.org", title: "City Manager" })).toMatchObject({ recordFound: false, matchedBy: "title", sector: { id: 11 } });
  });

  it("never reads another workspace's record or research", async () => {
    // d@plain.org is CommunityForce's campaign prospect too; in LSI Media it is a plain contact.
    const mine = await caller(2).research.writers.view({ surface: "outreach", email: "d@plain.org" });
    expect(mine).toMatchObject({ recordFound: true, block: "", known: { inCampaign: false } });
    const theirs = await caller(4).research.writers.view({ surface: "outreach", email: "p1@x.org" });
    expect(theirs).toMatchObject({ recordFound: false, block: "" });
  });
});
