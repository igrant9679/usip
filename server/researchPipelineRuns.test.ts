/**
 * The Research Pipeline page (audit 2026-10-20: P16, P66, P67, P144, P146).
 *
 * A run is for one person: the server refuses a run with nobody to research
 * or write to, and the page asks for one. `start` returns before the stages
 * run, so the 2 s poll shows them progress. A stage whose AI call fails, or
 * that writes no email, fails the run instead of saving a stock draft as
 * "complete". The link to the draft is a router link to AI drafts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => ({ db: null as any, invoke: null as any }));
vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db }));
vi.mock("./_core/llm", async (a) => ({ ...(await a<typeof import("./_core/llm")>()), invokeLLM: (p: unknown) => h.invoke(p) }));

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { appRouter } from "./routers";
import { PIPELINE_ORPHAN_MS, __settleResearchPipelines } from "./routers/researchPipeline";

const read = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8").replace(/\r\n/g, "\n");
const WS = 2;
const OTHER = 4;

const caller = () => appRouter.createCaller({
  user: { id: 1, openId: "u", email: "o@example.com", name: "O", loginMethod: "password", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
  req: { protocol: "https", headers: { "x-workspace-id": String(WS) } },
  res: { clearCookie: () => {} },
} as unknown as TrpcContext);

/** What each stage's model call answers, by the schema it asks for. */
const answer = (p: any, variants: unknown[] = [{ subject: "Grant timing", body: "Hi {{firstName}}, ...", rationale: "r" }]) => {
  const props = Object.keys(p.response_format.json_schema.schema.properties);
  const out = props.includes("variants") ? { variants }
    : props.includes("angles") ? { angles: [{ angle: "a", hook: "h", cta: "c", rationale: "r" }] }
    : props.includes("signals") ? { signals: [], bestTimingRationale: "" }
    : { personSummary: "p", companySummary: "c", likelyPainPoints: ["x"], relevantContext: "ctx" };
  return { choices: [{ message: { content: JSON.stringify(out) } }] };
};

const rows = (t: string) => h.db.rowsOf(t) as any[];

beforeEach(async () => {
  await __settleResearchPipelines();
  h.db = makeSqlFakeDb({ roles: { [WS]: "rep" }, wsId: () => WS });
  rows("contacts").push(
    { id: 10, workspaceId: WS, firstName: "Dana", lastName: "Reyes", title: "Director of Federal Programs", email: "dana@example.org", accountId: null, companyName: "County Schools" },
    { id: 11, workspaceId: WS, firstName: "Noel", lastName: "Hart", title: "CFO", email: null, accountId: null, companyName: null },
    { id: 12, workspaceId: OTHER, firstName: "Ann", lastName: "Other", title: "CEO", email: "ann@example.org", accountId: null, companyName: null },
    { id: 13, workspaceId: WS, firstName: "", lastName: "", title: null, email: "info@example.org", accountId: null, companyName: null },
  );
  h.invoke = async (p: any) => answer(p);
});

describe("a run is for one person (P16)", () => {
  it("is refused with nobody to research, someone from another workspace, or someone with no email", async () => {
    await expect(caller().researchPipeline.start({ goal: "Book a call" })).rejects.toMatchObject({ code: "BAD_REQUEST", message: "Pick the person the email is for." });
    await expect(caller().researchPipeline.start({ goal: "Book a call", contactId: 12 })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(caller().researchPipeline.start({ goal: "Book a call", contactId: 11 })).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: expect.stringContaining("Noel Hart has no email address") });
    expect(rows("research_pipelines")).toEqual([]);
  });

  it("researches the person and saves a draft addressed to them", async () => {
    const prompts: string[] = [];
    h.invoke = async (p: any) => { prompts.push(p.messages.map((m: any) => m.content).join("\n")); return answer(p); };
    const { pipelineId } = await caller().researchPipeline.start({ goal: "Book a call", contactId: 10 });
    await __settleResearchPipelines();
    expect(prompts[0]).toContain("Person: Dana Reyes, Director of Federal Programs");
    expect(prompts[0]).toContain("Company: County Schools");
    const [run] = rows("research_pipelines");
    expect(run).toMatchObject({ id: pipelineId, status: "complete", toContactId: 10 });
    expect(rows("email_drafts")).toEqual([expect.objectContaining({ toContactId: 10, toEmail: "dana@example.org", subject: "Grant timing", status: "pending_review" })]);
    expect(run.stage5_final.personalizationTokens.firstName).toBe("Dana");
  });

  it("an empty first name falls back to 'there', not to nothing (P146)", async () => {
    await caller().researchPipeline.start({ goal: "Book a call", contactId: 13 });
    await __settleResearchPipelines();
    expect(rows("research_pipelines")[0].stage5_final.personalizationTokens.firstName).toBe("there");
  });
});

describe("every id a run stores is this workspace's (P145)", () => {
  it("refuses a foreign lead or company beside a real contact, and stores only what it checked", async () => {
    rows("leads").push({ id: 40, workspaceId: OTHER, firstName: "Lee", lastName: "Other", title: null, email: "lee@example.org", company: null });
    rows("accounts").push(
      { id: 50, workspaceId: OTHER, name: "Their Co", industry: null, employeeBand: null, revenueBand: null },
      { id: 51, workspaceId: WS, name: "County Schools", industry: "Education", employeeBand: null, revenueBand: null },
    );
    await expect(caller().researchPipeline.start({ goal: "Book a call", contactId: 10, leadId: 40 })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(caller().researchPipeline.start({ goal: "Book a call", contactId: 10, accountId: 50 })).rejects.toMatchObject({ code: "NOT_FOUND", message: "That company is not in this workspace." });
    expect(rows("research_pipelines")).toEqual([]);
    await caller().researchPipeline.start({ goal: "Book a call", contactId: 10, accountId: 51 });
    await __settleResearchPipelines();
    expect(rows("research_pipelines")[0]).toMatchObject({ toContactId: 10, toLeadId: null, toAccountId: 51 });
  });
});

describe("start returns before the stages run (P144)", () => {
  it("the poll sees each stage as it lands", async () => {
    const gates: (() => void)[] = [];
    h.invoke = (p: any) => new Promise((res) => gates.push(() => res(answer(p))));
    const { pipelineId } = await caller().researchPipeline.start({ goal: "Book a call", contactId: 10 });
    expect(await caller().researchPipeline.get({ id: pipelineId })).toMatchObject({ status: "running", currentStage: 1, stage1_prospect: null });
    await vi.waitFor(() => expect(gates.length).toBe(1));
    gates[0]();
    await vi.waitFor(async () => expect(await caller().researchPipeline.get({ id: pipelineId })).toMatchObject({ status: "running", currentStage: 2 }));
    for (let i = 1; i < 4; i++) {
      await vi.waitFor(() => expect(gates.length).toBe(i + 1));
      gates[i]();
    }
    await __settleResearchPipelines();
    expect(await caller().researchPipeline.get({ id: pipelineId })).toMatchObject({ status: "complete", currentStage: 5 });
  });

  it("a run cut off by a restart reads as failed, so the page stops polling it", async () => {
    rows("research_pipelines").push(
      { id: 50, workspaceId: WS, createdByUserId: 1, status: "running", currentStage: 2, createdAt: new Date(), updatedAt: new Date(Date.now() - PIPELINE_ORPHAN_MS - 1000) },
      { id: 51, workspaceId: WS, createdByUserId: 1, status: "running", currentStage: 2, createdAt: new Date(), updatedAt: new Date() },
    );
    expect(await caller().researchPipeline.get({ id: 50 })).toMatchObject({ status: "failed", errorMessage: expect.stringContaining("restarted") });
    expect(await caller().researchPipeline.get({ id: 51 })).toMatchObject({ status: "running" });
  });
});

describe("a failed stage fails the run (P67)", () => {
  it("an AI error is not swallowed into a stock draft", async () => {
    h.invoke = async (p: any) => {
      if (Object.keys(p.response_format.json_schema.schema.properties).includes("signals")) throw new Error("provider down");
      return answer(p);
    };
    await caller().researchPipeline.start({ goal: "Book a call", contactId: 10 });
    await __settleResearchPipelines();
    expect(rows("research_pipelines")[0]).toMatchObject({ status: "failed", currentStage: 2, errorMessage: "Signal detection: the AI call failed (provider down)" });
    expect(rows("email_drafts")).toEqual([]);
  });

  it("a draft step that writes no email saves nothing", async () => {
    h.invoke = async (p: any) => answer(p, []);
    await caller().researchPipeline.start({ goal: "Book a call", contactId: 10 });
    await __settleResearchPipelines();
    expect(rows("research_pipelines")[0]).toMatchObject({ status: "failed", errorMessage: expect.stringContaining("wrote no email") });
    expect(rows("email_drafts")).toEqual([]);
    expect(read("server/routers/researchPipeline.ts")).not.toContain('subject: "Quick question"');
  });
});

describe("the page", () => {
  const page = read("client/src/pages/usip/ResearchPipeline.tsx");

  it("asks who the email is for and sends it (P16)", () => {
    expect(page).toContain('<EntityPicker type="contacts" mode="single"');
    expect(page).toContain("start.mutate({ goal: goal.trim(), tone, contactId: recipient[0] });");
    expect(page).toContain("disabled={start.isPending || !goal.trim() || recipient.length === 0}");
  });

  it("links to the AI drafts queue without reloading the app (P66)", () => {
    expect(page).toContain('<Link href="/v2/emails?status=awaiting&source=ai_draft"');
    expect(page).not.toContain("source=sequence");
    expect(page).not.toMatch(/<a href="\/v2\/emails/);
  });

  it("promises no pause it does not have, and names no other product (P146)", () => {
    expect(page).not.toContain("paused for human approval");
    expect(page).not.toContain("USIP");
  });
});
