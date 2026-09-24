/**
 * Rewriting enrolled Revenue Engine sequences that have not started (owner
 * ask 2026-09-24: "CommunityForce only, not-yet-started prospects").
 *
 * What must hold, because the queue it edits is the one dispatch sends from:
 *   • "not started" is strict — enrolled, and every queue row still scheduled;
 *   • the check repeats right before the queue is touched, and each update is
 *     itself conditional on the row still being scheduled;
 *   • content is replaced step for step in the SAME shape enrolment writes,
 *     and scheduledAt is never touched;
 *   • the job runs detached from the request (no per-user ceiling), one per
 *     workspace, sequentially, and never sends;
 *   • the endpoint is admin-only and a dry run unless told otherwise.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const svc = readFileSync("server/services/are/rewriteNotStarted.ts", "utf8");
const router = readFileSync("server/routers/are/campaigns.ts", "utf8");
const engine = readFileSync("server/areEngine.ts", "utf8");
const ctxSrc = readFileSync("server/_core/requestContext.ts", "utf8");

const fnBody = (src: string, decl: string) => {
  const a = src.indexOf(decl);
  expect(a, `anchor moved: ${decl}`).toBeGreaterThan(-1);
  const b = src.indexOf("\nexport ", a + decl.length);
  return src.slice(a, b === -1 ? undefined : b);
};

describe("who counts as not started", () => {
  const find = fnBody(svc, "export async function findNotStartedEnrolled(");

  it("enrolled, with something scheduled and nothing in any other state", () => {
    expect(find).toContain('eq(prospectQueue.sequenceStatus, "enrolled")');
    expect(find).toContain("e.\\`status\\` = 'scheduled'");
    expect(find).toContain("NOT EXISTS (SELECT 1 FROM \\`are_execution_queue\\` e WHERE e.\\`prospectQueueId\\` = ${prospectQueue.id} AND e.\\`status\\` <> 'scheduled')");
    expect(find).toContain("eq(prospectQueue.workspaceId, workspaceId)");
  });
});

describe("rewriting one prospect", () => {
  const one = fnBody(svc, "export async function rewriteOneNotStarted(");

  it("regenerates the stored sequence first, with force", () => {
    expect(one).toContain("runSequenceAgent(target.prospectQueueId, workspaceId, target.campaignId, { force: true })");
  });

  it("re-checks the queue after writing and before touching it", () => {
    const regenAt = one.indexOf("runSequenceAgent(");
    const recheckAt = one.indexOf('if (rows.length === 0 || rows.some((r) => r.status !== "scheduled")) return "started_meanwhile";');
    const updateAt = one.indexOf("await db.update(areExecutionQueue)");
    expect(regenAt).toBeGreaterThan(-1);
    expect(recheckAt).toBeGreaterThan(regenAt);
    expect(updateAt).toBeGreaterThan(recheckAt);
  });

  it("replaces content only on rows still scheduled, in this workspace, keyed by step", () => {
    const upd = one.slice(one.indexOf("await db.update(areExecutionQueue)"));
    expect(upd).toContain('eq(areExecutionQueue.status, "scheduled")');
    expect(upd).toContain("eq(areExecutionQueue.workspaceId, workspaceId)");
    expect(one).toContain("const s = byIndex.get(r.stepIndex);");
  });

  it("writes the same shape enrolment writes, and never moves a scheduled time", () => {
    const shape = "messageContent: { subject: s.subject, body: s.body, variantKey: s.variantKey }";
    expect(engine).toContain(shape);
    expect(one).toContain(shape);
    const set = one.slice(one.indexOf(".set({ messageContent:"), one.indexOf(".where(", one.indexOf(".set({ messageContent:")));
    expect(set).not.toContain("scheduledAt");
    expect(set).not.toContain("status");
  });

  it("never sends", () => {
    // No send path is imported or called (the word "dispatch" appears in the
    // comments that explain the race with it, so match call sites only).
    expect(svc).not.toMatch(/sendCampaignEmail\w*\(|sendWorkspaceEmail\(|sendSystemEmail\(|sendMeetingInvite\(|sendMessage\(|sendLinkedInInvitation\(|runAreEngine\(|tickCampaign\(/);
    expect(svc).not.toMatch(/from "\.\.\/\.\.\/(emailDelivery|areEngine)"/);
  });
});

describe("the job", () => {
  const start = fnBody(svc, "export function startRewriteNotStarted(");

  it("one per workspace, detached from the request, sequential", () => {
    expect(start).toContain("if (jobs.get(workspaceId)?.running) return false;");
    expect(start).toContain("runOutsideRequestContext(() => {");
    expect(start).toContain("for (const t of targets) {");
    expect(start).toContain("const outcome = await rewriteOneNotStarted(workspaceId, t);");
    expect(ctxSrc).toContain("export function runOutsideRequestContext(fn: () => void): void {\n  als.exit(fn);\n}");
  });

  it("the model calls on this path name their workspace (it runs with no request)", () => {
    const prospects = readFileSync("server/routers/are/prospects.ts", "utf8");
    const personalize = prospects.slice(prospects.indexOf("async function personalizeForProspect"));
    expect(personalize.slice(0, personalize.indexOf("invokeLLM({") + 80)).toContain("workspaceId: campaign.workspaceId,");
    const judge = prospects.slice(prospects.indexOf("async function evaluateSequenceQuality"));
    expect(judge.slice(judge.indexOf("invokeLLM({"), judge.indexOf("invokeLLM({") + 40)).toContain("workspaceId,");
  });
});

describe("the endpoint", () => {
  const ep = router.slice(router.indexOf("rewriteNotStartedSequences: adminWsProcedure"), router.indexOf("rewriteNotStartedStatus:"));

  it("is admin-only and a dry run by default", () => {
    expect(ep.length).toBeGreaterThan(100);
    expect(ep).toContain("z.object({ dryRun: z.boolean().default(true) }).optional()");
    expect(ep).toContain('if (input?.dryRun !== false) return { dryRun: true, eligible: targets.length, byCampaign, started: false };');
    expect(ep.indexOf("startRewriteNotStarted(")).toBeGreaterThan(ep.indexOf("if (input?.dryRun !== false)"));
  });

  it("is audited and scoped to the caller's workspace", () => {
    expect(ep).toContain("findNotStartedEnrolled(ctx.workspace.id)");
    expect(ep).toContain('entityType: "are_rewrite_not_started"');
  });
});
