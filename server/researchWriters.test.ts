/**
 * The four writers phase 3 left without research (owner, 2026-10-15: "wire
 * research into the remaining four writers"): mailbox replies and forwards,
 * the editor assistant (emailAssist), Email Builder and snippets, and
 * proposals. Each finds its recipient its own way; a recipient with no
 * research, or another workspace's, changes nothing. Runs against the shared
 * in-memory database with the provider SDK stubbed, so invokeLLM and its
 * research option are real.
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
        return tool
          ? { id: "m", model: "m", content: [{ type: "tool_use", id: "t", name: tool, input: { text: "ok", subject: "Hi", blocks: [], suggestions: [] } }], stop_reason: "tool_use", usage: { input_tokens: 1, output_tokens: 1 } }
          : { id: "m", model: "m", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } };
      },
    };
  },
}));

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { appRouter } from "./routers";
import { __clearResearchContextCache } from "./services/research/context";
import { recipientRefByEmail, researchUseForProposal, researchUseForRecipient, threadCounterparty } from "./services/research/recipient";
import { cleanSectorContent } from "@shared/researchShape";

const read = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8").replace(/\r\n/g, "\n");

const COUNTIES = cleanSectorContent({
  name: "County governments",
  status: "researched",
  buyers: { painPoints: ["No staff to own compliance"] },
  targeting: { titles: ["County Administrator", "ADA Coordinator"], industries: ["Government Administration"] },
  messaging: { avoid: ["Don't promise that an overlay makes a county compliant."], vocabulary: ["Title II"], sampleOpening: "The DOJ moved the deadline, not the standard." },
}).content;
const CITIES = cleanSectorContent({ name: "City governments", status: "researched", targeting: { titles: ["City Manager"] }, messaging: { vocabulary: ["council"] } }).content;
const BLOCK = "## The prospect's market (your research: State and local government › County governments)";
const CITY_BLOCK = "## The prospect's market (your research: State and local government › City governments)";

function seed() {
  const db = h.db;
  db.rowsOf("research_markets").push({ id: 1, workspaceId: 2, name: "State and local government", status: "draft" });
  db.rowsOf("research_sectors").push({ id: 10, workspaceId: 2, marketId: 1, ...COUNTIES, status: "researched" });
  db.rowsOf("research_sectors").push({ id: 11, workspaceId: 2, marketId: 1, ...CITIES, status: "researched" });
  // CommunityForce's sector, about the same titles: never LSI's to use.
  db.rowsOf("research_markets").push({ id: 2, workspaceId: 4, name: "Theirs", status: "draft" });
  db.rowsOf("research_sectors").push({ id: 20, workspaceId: 4, marketId: 2, ...COUNTIES, name: "Their counties", status: "verified" });
  db.rowsOf("accounts").push({ id: 70, workspaceId: 2, name: "Pike County", industry: "Government Administration" });
  db.rowsOf("contacts").push(
    { id: 5, workspaceId: 2, firstName: "Ana", email: "ana@pike.gov", title: "County Administrator", accountId: null },
    { id: 6, workspaceId: 4, firstName: "Bo", email: "bo@other.gov", title: "County Administrator", accountId: null },
    { id: 7, workspaceId: 2, firstName: "Cy", email: "cy@pike.gov", title: null, accountId: null },
    { id: 8, workspaceId: 2, firstName: "Ed", email: "ed@springfield.gov", title: "City Manager", accountId: null },
  );
  db.rowsOf("prospect_queue").push(
    { id: 49, workspaceId: 2, campaignId: 6, email: "dee@pike.gov", title: "Clerk", sourceType: "apollo" },
    { id: 50, workspaceId: 2, campaignId: 7, email: "dee@pike.gov", title: "ADA Coordinator", sourceType: "apollo" },
  );
  db.rowsOf("sending_accounts").push({ id: 3, workspaceId: 2, fromEmail: "me@lsi.com", fromName: "Me", name: "Me" });
  db.rowsOf("email_drafts").push({ id: 90, workspaceId: 2, subject: "s", body: "b", toContactId: 5 }, { id: 91, workspaceId: 4, subject: "s", body: "b", toContactId: 6, toEmail: "ana@pike.gov" }, { id: 92, workspaceId: 2, subject: "s", body: "b", toEmail: "dee@pike.gov" });
  db.rowsOf("proposals").push(
    { id: 80, workspaceId: 2, createdBy: 1, title: "P", clientName: "Pike County", accountId: 70, contactId: null, clientEmail: null },
    { id: 83, workspaceId: 4, createdBy: 1, title: "P", clientName: "Theirs", accountId: null, contactId: null, clientEmail: "ana@pike.gov" },
    { id: 81, workspaceId: 2, createdBy: 1, title: "P", clientName: "Pike County", accountId: null, contactId: null, clientEmail: "ana@pike.gov" },
    { id: 82, workspaceId: 2, createdBy: 1, title: "P", clientName: "Nobody", accountId: null, contactId: null, clientEmail: "nobody@x.org" },
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

/** Everything the model was sent, for looking for the research block. */
const sent = () => JSON.stringify(h.calls);

beforeEach(() => {
  h.db = makeSqlFakeDb({ roles: { 2: "admin", 4: "admin" }, wsId: () => h.wsId });
  h.calls = [];
  __clearResearchContextCache();
  seed();
});

/* ── Finding the recipient ──────────────────────────────────────────────── */

describe("finding who an email is for", () => {
  it("the other party in a thread is the newest sender who is not the mailbox, else whom it wrote to", () => {
    const m = (fromEmail: string, toEmail?: string) => ({ fromEmail, toEmail });
    expect(threadCounterparty([m("ana@pike.gov", "me@lsi.com"), m("ME@lsi.com", "ana@pike.gov")], "me@lsi.com")).toBe("ana@pike.gov");
    expect(threadCounterparty([m("bo@x.org"), m("ana@pike.gov")], "me@lsi.com")).toBe("ana@pike.gov");
    expect(threadCounterparty([m("me@lsi.com", "cy@pike.gov")], "me@lsi.com")).toBe("cy@pike.gov");
    expect(threadCounterparty([m("me@lsi.com")], "me@lsi.com")).toBeNull();
  });

  it("an address belongs to this workspace's records only, the newest campaign prospect first", async () => {
    expect(await recipientRefByEmail(2, " Ana@Pike.gov ")).toEqual({ contactId: 5 });
    expect(await recipientRefByEmail(2, "dee@pike.gov")).toEqual({ prospectQueueId: 50 });
    expect(await recipientRefByEmail(2, "bo@other.gov")).toEqual({});
    expect(await recipientRefByEmail(2, "not an address")).toEqual({});
  });

  it("records first, then the first address whose record says something", async () => {
    expect(await researchUseForRecipient(2, "reply", { contactId: 5 })).toMatchObject({ surface: "reply", prospectTitle: "County Administrator" });
    // Cy has no title or account: nothing to match, so the next address is tried.
    expect(await researchUseForRecipient(2, "reply", {}, ["cy@pike.gov", "dee@pike.gov"])).toMatchObject({ prospectTitle: "ADA Coordinator", campaignId: 7 });
    expect(await researchUseForRecipient(2, "reply", {}, ["bo@other.gov"])).toEqual({ surface: "reply" });
  });

  it("a proposal's client through its account, else its client email; never another workspace's", async () => {
    expect(await researchUseForProposal(2, 80)).toMatchObject({ surface: "research", industry: "Government Administration" });
    expect(await researchUseForProposal(2, 81)).toMatchObject({ surface: "research", prospectTitle: "County Administrator" });
    expect(await researchUseForProposal(2, 82)).toEqual({ surface: "research" });
    expect(await researchUseForProposal(4, 80)).toEqual({ surface: "research" });
    expect(await researchUseForProposal(2, 83)).toEqual({ surface: "research" });
  });
});

/* ── The writers ────────────────────────────────────────────────────────── */

describe("the mailbox", () => {
  const thread = [{ fromEmail: "ana@pike.gov", toEmail: "me@lsi.com", subject: "ADA", bodyText: "What does it cost?" }];

  it("a reply to someone the CRM knows gets their market's research; a stranger's gets none", async () => {
    await caller(2).mailbox.aiDraftReply({ accountId: 3, messages: thread });
    expect(sent()).toContain(BLOCK);
    expect(sent()).toContain("Don't promise that an overlay makes a county compliant.");
    h.calls = [];
    await caller(2).mailbox.aiDraftReply({ accountId: 3, messages: [{ ...thread[0], fromEmail: "stranger@x.org" }] });
    expect(sent()).not.toContain("## The prospect's market");
  });

  it("a forward uses whom it goes to, else who wrote it", async () => {
    // From a county administrator, to a city manager: the city's research.
    await caller(2).mailbox.aiDraftForward({ accountId: 3, originalMessage: { fromEmail: "ana@pike.gov", subject: "s", bodyText: "b" }, toEmail: "ed@springfield.gov" });
    expect(sent()).toContain(CITY_BLOCK);
    expect(sent()).not.toContain(BLOCK);
    h.calls = [];
    await caller(2).mailbox.aiDraftForward({ accountId: 3, originalMessage: { fromEmail: "stranger@x.org", subject: "s", bodyText: "b" }, toEmail: "dee@pike.gov" });
    expect(sent()).toContain(BLOCK);
    h.calls = [];
    await caller(2).mailbox.aiDraftForward({ accountId: 3, originalMessage: { fromEmail: "ana@pike.gov", subject: "s", bodyText: "b" } });
    expect(sent()).toContain(BLOCK);
  });

  it("the streaming drafts look the recipient up the same way, and the stream passes it on", () => {
    const route = read("server/mailboxStreamRoute.ts");
    expect(route).toContain(`research: await researchUseForRecipient(workspaceId, "reply", {}, [threadCounterparty(messages, senderEmail)]),`);
    expect(route).toContain(`research: await researchUseForRecipient(workspaceId, "reply", {}, [asStr(body.toEmail), original.fromEmail]),`);
    expect(read("server/_core/streamHelpers.ts")).toContain("      research: built.research,\n");
  });
});

describe("the editor assistant", () => {
  const improve = { action: "improve" as const, text: "Hello there", isHtml: false };

  it("a record the editor names wins over the address", async () => {
    await caller(2).emailAssist.assist({ ...improve, contactId: 8, recipientEmail: "ana@pike.gov" });
    expect(sent()).toContain(CITY_BLOCK);
    expect(sent()).not.toContain(BLOCK);
  });

  it("uses the research of the record, draft or address the editor names, and nothing without one", async () => {
    for (const who of [{ contactId: 5 }, { prospectQueueId: 50 }, { emailDraftId: 90 }, { emailDraftId: 92 }, { recipientEmail: "ana@pike.gov" }]) {
      h.calls = [];
      __clearResearchContextCache();
      await caller(2).emailAssist.assist({ ...improve, ...who });
      expect(sent(), JSON.stringify(who)).toContain(BLOCK);
      expect(sent(), JSON.stringify(who)).toContain("An opening line to adapt"); // the outreach view
    }
    h.calls = [];
    await caller(2).emailAssist.assist(improve);
    expect(sent()).not.toContain("## The prospect's market");
  });

  it("another workspace's contact or draft adds nothing", async () => {
    await caller(2).emailAssist.assist({ ...improve, contactId: 6 });
    await caller(2).emailAssist.assist({ ...improve, emailDraftId: 91 });
    expect(sent()).not.toContain("## The prospect's market");
  });

  it("every editor that knows its recipient says so", () => {
    expect(read("client/src/pages/usip/Contacts.tsx")).toContain("aiContext={{ subject, contactId: contactIds.length === 1 ? contactIds[0] : undefined }}");
    expect(read("client/src/pages/usip/Leads.tsx")).toContain("aiContext={{ subject, leadId: leadIds.length === 1 ? leadIds[0] : undefined }}");
    const drawer = read("client/src/components/usip/RecordDrawer.tsx");
    expect(drawer).toContain("aiContext={{ subject, leadId }}");
    expect(drawer).toContain("aiContext={{ subject, contactId }}");
    expect(read("client/src/components/usip/emails/DraftEditorTools.tsx")).toContain("aiContext={{ subject, emailDraftId: draft.id }}");
    expect(read("client/src/pages/usip/ARECampaignDetail.tsx")).toContain("aiContext={{ subject: editing.subject, prospectQueueId: row.prospectId }}");
    expect(read("client/src/pages/usip/Mailbox.tsx")).toContain("aiContext={{ subject, recipientEmail: firstEmail(to) }}");
  });
});

describe("Email Builder and snippets", () => {
  it("write for the sector the writer picks, only one of this workspace's", async () => {
    await caller(2).emailTemplates.generateTemplate({ prompt: "A first touch for counties", sectorId: 10 });
    expect(sent()).toContain(BLOCK);
    h.calls = [];
    await caller(2).emailTemplates.suggestSubjects({ bodyText: "Body", sectorId: 10 });
    await caller(2).emailTemplates.rewriteBlock({ content: "Body", instruction: "rewrite", sectorId: 10 });
    await caller(2).snippets.generate({ category: "opener", sectorId: 10 });
    expect(h.calls).toHaveLength(3);
    for (const c of h.calls) expect(JSON.stringify(c)).toContain(BLOCK);
    h.calls = [];
    await caller(2).emailTemplates.generateTemplate({ prompt: "A first touch for counties", sectorId: 20 });
    await caller(2).emailTemplates.generateTemplate({ prompt: "A first touch for counties" });
    expect(sent()).not.toContain("## The prospect's market");
  });

  it("the streaming rewrite takes the sector too", () => {
    const route = read("server/emailBuilderStreamRoute.ts");
    expect(route).toContain(`research: sectorId ? { surface: "outreach", sectorId } : undefined,`);
    expect(read("client/src/pages/usip/EmailBuilder.tsx")).toContain("body: JSON.stringify({ content, instruction, sectorId: sectorRef.current }),");
  });
});

describe("proposals", () => {
  it("a section is written with the client's research, as the research view", async () => {
    await caller(2).proposals.generateSectionContent({ proposalId: 80, sectionKey: "executive_summary", context: { clientName: "Pike County" } });
    expect(sent()).toContain(BLOCK);
    expect(sent()).not.toContain("An opening line to adapt");
    h.calls = [];
    await caller(2).proposals.generateSectionContent({ proposalId: 82, sectionKey: "executive_summary", context: { clientName: "Nobody" } });
    expect(sent()).not.toContain("## The prospect's market");
    expect(read("server/proposalsStreamRoute.ts")).toContain("const research = await researchUseForProposal(workspaceId, proposalId);");
  });
});
