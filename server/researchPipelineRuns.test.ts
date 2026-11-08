/**
 * The Research Pipeline page (audit 2026-10-20: P16, P66, P67, P144, P146).
 *
 * A run is for one person: the server refuses a run with nobody to research
 * or write to, and the page asks for one. `start` returns before the stages
 * run, so the 2 s poll shows them progress. Since 2026-11-07 (P144, the rest)
 * the stages are a persisted job on services/jobs/runner.ts: one stage a
 * slice, resumed from the last finished stage after a restart. A stage whose AI call fails, or
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
import { PIPELINE_JOB, PIPELINE_ORPHAN_MS, __settleResearchPipelines, nextPipelineStage } from "./routers/researchPipeline";
import { JOB_STALE_MS, __resetJobRunnerForTests, tickJobs } from "./services/jobs/runner";
import { pipelineJobLine, pipelineSpendLine } from "../client/src/pages/usip/ResearchPipeline";
import { promptVersions } from "../drizzle/schema";

/**
 * One runner slice: a budget too short for a second claim, the model a few
 * ms slow so a stage outlasts it. A tick that starts past its budget runs
 * none, so it is asked again.
 */
const oneSlice = async () => {
  const invoke = h.invoke;
  h.invoke = async (p: any) => { await new Promise((r) => setTimeout(r, 5)); return invoke(p); };
  try {
    for (let i = 0; i < 20; i++) { __resetJobRunnerForTests(); if ((await tickJobs(1)) > 0) return; }
    throw new Error("the runner ran no slice");
  } finally { h.invoke = invoke; }
};

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
  __resetJobRunnerForTests();
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
  // 2026-11-07 (P144, the rest): the stages moved from a promise left behind
  // by the request onto the persisted job runner, so this drives the runner's
  // ticks instead of waiting on in-process promises.
  it("queues the run as a persisted job and asks the model nothing in the request", async () => {
    let calls = 0;
    h.invoke = async (p: any) => { calls++; return answer(p); };
    const { pipelineId } = await caller().researchPipeline.start({ goal: "Book a call", contactId: 10 });
    expect(calls).toBe(0);
    expect(rows("bulk_jobs")).toEqual([expect.objectContaining({ workspaceId: WS, kind: PIPELINE_JOB, status: "queued", total: 5, payload: expect.objectContaining({ pipelineId }) })]);
    expect(await caller().researchPipeline.get({ id: pipelineId })).toMatchObject({ status: "running", currentStage: 1, stage1_prospect: null, job: { status: "queued" } });
  });

  it("the poll sees each stage as it lands: one stage a slice", async () => {
    const { pipelineId } = await caller().researchPipeline.start({ goal: "Book a call", contactId: 10 });
    await oneSlice();
    expect(await caller().researchPipeline.get({ id: pipelineId })).toMatchObject({ status: "running", currentStage: 2, stage2_signals: null });
    expect(rows("bulk_jobs")[0]).toMatchObject({ status: "queued", resumeFrom: 1, done: 1, message: "Stage 1 of 5 done" });
    await oneSlice();
    expect(await caller().researchPipeline.get({ id: pipelineId })).toMatchObject({ status: "running", currentStage: 3 });
    await __settleResearchPipelines();
    expect(await caller().researchPipeline.get({ id: pipelineId })).toMatchObject({ status: "complete", currentStage: 5, job: { status: "done" } });
    expect(rows("email_drafts")).toHaveLength(1);
  });

  it("a restart mid-run resumes from the last finished stage, not from the start", async () => {
    const asked: string[] = [];
    h.invoke = async (p: any) => { asked.push(Object.keys(p.response_format.json_schema.schema.properties)[0]); return answer(p); };
    const { pipelineId } = await caller().researchPipeline.start({ goal: "Book a call", contactId: 10 });
    await oneSlice();
    await oneSlice();
    expect(asked).toEqual(["personSummary", "signals"]);
    // The worker died during stage 3: the job is "running" with a heartbeat
    // older than the runner's stale limit, and the process starts again.
    Object.assign(rows("bulk_jobs")[0], { status: "running", heartbeatAt: new Date(Date.now() - JOB_STALE_MS - 1000) });
    __resetJobRunnerForTests();
    await __settleResearchPipelines();
    expect(asked).toEqual(["personSummary", "signals", "angles", "variants"]);
    expect(await caller().researchPipeline.get({ id: pipelineId })).toMatchObject({ status: "complete", currentStage: 5 });
    expect(rows("email_drafts")).toHaveLength(1);
  });

  it("stage 5's draft and the run's completion are one transaction: a failure part-way leaves no draft", async () => {
    const { pipelineId } = await caller().researchPipeline.start({ goal: "Book a call", contactId: 10 });
    for (let i = 0; i < 4; i++) await oneSlice();
    expect(rows("research_pipelines")[0]).toMatchObject({ currentStage: 5, status: "running" });
    // The version-history insert fails after the draft was written.
    const insert = h.db.insert;
    h.db.insert = (t: any) => { if (t === promptVersions) throw new Error("lost connection"); return insert(t); };
    await oneSlice();
    h.db.insert = insert;
    expect(rows("email_drafts")).toEqual([]);
    expect(await caller().researchPipeline.get({ id: pipelineId })).toMatchObject({ status: "failed", errorMessage: "lost connection", job: { status: "failed" } });
  });

  it("the next stage is the first whose output is not saved", () => {
    expect(nextPipelineStage({ stage1_prospect: null, stage2_signals: null, stage3_angles: null, stage4_draft: null, stage5_final: null })).toBe(1);
    expect(nextPipelineStage({ stage1_prospect: {}, stage2_signals: {}, stage3_angles: null, stage4_draft: null, stage5_final: null })).toBe(3);
    expect(nextPipelineStage({ stage1_prospect: {}, stage2_signals: {}, stage3_angles: {}, stage4_draft: {}, stage5_final: {} })).toBe(6);
  });

  it("a run cut off by a restart with no job left reads as failed; one its job will resume does not", async () => {
    const old = new Date(Date.now() - PIPELINE_ORPHAN_MS - 1000);
    rows("research_pipelines").push(
      { id: 50, workspaceId: WS, createdByUserId: 1, status: "running", currentStage: 2, createdAt: new Date(), updatedAt: old },
      { id: 51, workspaceId: WS, createdByUserId: 1, status: "running", currentStage: 2, createdAt: new Date(), updatedAt: new Date() },
      // Waiting behind other jobs for longer than the orphan limit, its job still queued.
      { id: 52, workspaceId: WS, createdByUserId: 1, status: "running", currentStage: 3, createdAt: new Date(), updatedAt: old },
    );
    rows("bulk_jobs").push({ id: 900, workspaceId: WS, userId: 1, kind: PIPELINE_JOB, status: "queued", total: 5, done: 2, failed: 0, resumeFrom: 2, payload: { pipelineId: 52, goal: "g", tone: "concise" } });
    expect(await caller().researchPipeline.get({ id: 50 })).toMatchObject({ status: "failed", errorMessage: expect.stringContaining("restarted") });
    expect(await caller().researchPipeline.get({ id: 51 })).toMatchObject({ status: "running" });
    expect(await caller().researchPipeline.get({ id: 52 })).toMatchObject({ status: "running", job: { status: "queued" } });
  });
});

describe("what a run spends is said before it starts (P144, Spending)", () => {
  it("estimates from this workspace's ledger: the pipeline's own calls first", async () => {
    const day = new Date().toISOString().slice(0, 10);
    rows("spend_ledger").push(
      { id: 1, workspaceId: WS, day, vendor: "anthropic", meter: "input_tokens", model: "claude-haiku-4-5-20251001", keySource: "own", feature: `job ${PIPELINE_JOB}`, quantity: 8000, calls: 4 },
      { id: 2, workspaceId: WS, day, vendor: "anthropic", meter: "output_tokens", model: "claude-haiku-4-5-20251001", keySource: "own", feature: `job ${PIPELINE_JOB}`, quantity: 2000, calls: 4 },
      { id: 3, workspaceId: OTHER, day, vendor: "anthropic", meter: "input_tokens", model: "claude-haiku-4-5-20251001", keySource: "own", feature: `job ${PIPELINE_JOB}`, quantity: 9_000_000, calls: 1 },
    );
    const e = await caller().researchPipeline.estimate();
    expect(e).toMatchObject({ calls: 4, basis: "pipeline" });
    expect(e.estUsd).toBeGreaterThan(0);
    expect(e.estUsd!).toBeLessThan(0.1);
    expect(pipelineSpendLine(e)).toMatch(/^4 AI calls on this workspace's AI budget, about \$0\.\d\d at what pipeline runs have cost here/);
  });

  it("says when there is nothing to estimate from, rather than guessing", async () => {
    const e = await caller().researchPipeline.estimate();
    expect(e).toMatchObject({ calls: 4, estUsd: null, basis: "none" });
    expect(pipelineSpendLine(e)).toContain("can't be estimated");
  });

  it("the page asks first, and says when the run is queued or running in the background", () => {
    const page = read("client/src/pages/usip/ResearchPipeline.tsx");
    const at = page.indexOf("const handleStart = async () => {");
    expect(at).toBeGreaterThan(-1);
    const block = page.slice(at, page.indexOf("const jobLine", at));
    expect(block).toContain("utils.researchPipeline.estimate.fetch()");
    expect(block).toMatch(/confirmAction\(\{ title: "Run the 5-stage pipeline\?", description: pipelineSpendLine\(estimate\)[\s\S]*start\.mutate\(/);
    expect(pipelineJobLine({ status: "running", stage1_prospect: null, job: { status: "queued" } })).toContain("Queued");
    expect(pipelineJobLine({ status: "running", stage1_prospect: {}, job: { status: "queued" } })).toContain("carries on from the last finished stage");
    expect(pipelineJobLine({ status: "complete" })).toBeNull();
    expect(page).toContain("{jobLine && <p");
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
