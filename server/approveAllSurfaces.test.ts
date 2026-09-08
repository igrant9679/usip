/**
 * "Approve all" on every approvals screen (owner ask 2026-09-08).
 *
 * The rule these pins enforce: every human-approval queue has a bulk approve
 * that (a) is scoped to the WHOLE queue on the server, not the rows on
 * screen, (b) sits behind a confirmation that states the count and what
 * happens, and (c) is wired — the button calls a procedure that exists.
 *
 * Source-level on purpose: the bug this guards against is a button that
 * approves 20 of 200 and says "all", which no runtime test with a 5-row
 * fixture would ever notice.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

type Surface = {
  name: string;
  client: string;
  /** The tRPC path the button calls (client side). */
  calls: string;
  /** Server file + the procedure key that must be defined there. */
  server: string;
  proc: string;
  /** The confirmation mechanism the button must use. */
  confirm: "ConfirmButton" | "confirmAction";
};

const SURFACES: Surface[] = [
  { name: "AI Pipeline drafts", client: "../client/src/pages/usip/AIPipelineQueue.tsx", calls: "trpc.aiPipeline.approveAllPending", server: "./routers/aiPipeline.ts", proc: "approveAllPending:", confirm: "ConfirmButton" },
  { name: "Emails page (awaiting)", client: "../client/src/pages/usip/EmailsV2.tsx", calls: "trpc.emailDrafts.approveAll", server: "./routers/sequences.ts", proc: "approveAll: repProcedure", confirm: "ConfirmButton" },
  { name: "Email Drafts (sequence)", client: "../client/src/pages/usip/EmailDrafts.tsx", calls: "trpc.emailDrafts.approveAll", server: "./routers/sequences.ts", proc: "approveAll: repProcedure", confirm: "ConfirmButton" },
  { name: "Tasks — AI drafts", client: "../client/src/pages/usip/TasksV2.tsx", calls: "trpc.tasks.approveAllDrafts", server: "./routers/activities.ts", proc: "approveAllDrafts:", confirm: "confirmAction" },
  { name: "Meetings — proposals", client: "../client/src/pages/usip/MeetingsV2.tsx", calls: "trpc.meetings.approveAllProposed", server: "./routers/meetings.ts", proc: "approveAllProposed:", confirm: "ConfirmButton" },
  { name: "Campaign — Prospects tab", client: "../client/src/pages/usip/ARECampaignDetail.tsx", calls: "trpc.are.campaigns.approveAllPending", server: "./routers/are/campaigns.ts", proc: "approveAllPending:", confirm: "ConfirmButton" },
  { name: "Hub — routing suggestions", client: "../client/src/components/usip/RoutingSuggestions.tsx", calls: "trpc.are.campaigns.acceptAllRoutingSuggestions", server: "./routers/are/campaigns.ts", proc: "acceptAllRoutingSuggestions:", confirm: "ConfirmButton" },
  { name: "Hub — campaign proposals", client: "../client/src/components/usip/CampaignProposals.tsx", calls: "trpc.are.campaigns.acceptAllProposals", server: "./routers/are/campaigns.ts", proc: "acceptAllProposals:", confirm: "ConfirmButton" },
  { name: "Engine Performance — recommendations", client: "../client/src/pages/usip/AREPerformance.tsx", calls: "trpc.optimization.approveAll", server: "./routers/optimization.ts", proc: "approveAll: adminWsProcedure", confirm: "ConfirmButton" },
  { name: "Autonomy Center — workflow ideas", client: "../client/src/pages/usip/WorkflowsV2.tsx", calls: "trpc.workflowsAi.applyAllSuggestions", server: "./routers/aiFeatures.ts", proc: "applyAllSuggestions:", confirm: "ConfirmButton" },
  { name: "Proposals — extension requests", client: "../client/src/pages/usip/Proposals.tsx", calls: "trpc.proposals.approveExtensionsBulk", server: "./routers/proposals.ts", proc: "approveExtensionsBulk:", confirm: "ConfirmButton" },
];

describe("every approvals screen has a wired, confirmed Approve all", () => {
  for (const s of SURFACES) {
    it(s.name, () => {
      const client = read(s.client);
      const server = read(s.server);
      expect(client, `${s.name}: button not wired to ${s.calls}`).toContain(s.calls);
      expect(server, `${s.name}: ${s.proc} missing in ${s.server}`).toContain(s.proc);
      expect(client, `${s.name}: must confirm through ${s.confirm}`).toContain(s.confirm);
    });
  }
});

describe("bulk approvals are whole-queue, not page-scoped", () => {
  it("AI Pipeline no longer approves only the 20 drafts on screen", () => {
    const client = read("../client/src/pages/usip/AIPipelineQueue.tsx");
    expect(client).not.toContain("bulkApprove.mutate({ draftIds: pendingDraftIds })");
    const server = read("./routers/aiPipeline.ts");
    const proc = server.slice(server.indexOf("approveAllPending:"), server.indexOf("regenerateDraft:"));
    expect(proc).toContain('eq(emailDrafts.status as any, "ai_pending_review")');
    expect(proc).not.toContain("draftIds");
  });

  it("the campaign Prospects tab counts and approves on the server (tab loads 100, bulk bar caps 200)", () => {
    const server = read("./routers/are/campaigns.ts");
    const proc = server.slice(server.indexOf("approveAllPending:"), server.indexOf("approveAllPending:") + 2500);
    // Only enriched + pending rows; the decision stamp is never clobbered.
    expect(proc).toContain('eq(prospectQueue.sequenceStatus, "pending")');
    expect(proc).toContain('eq(prospectQueue.enrichmentStatus, "complete")');
    expect(proc).toContain("COALESCE(${prospectQueue.approvedAt}, NOW())");
    // Counter recount, same as approveBatch — the batch-size write is the bug that reset it.
    expect(proc).toContain("prospectsApproved: Number(n)");
    expect(server).toContain("pendingApprovalCount:");
    const client = read("../client/src/pages/usip/ARECampaignDetail.tsx");
    expect(client).toContain("trpc.are.campaigns.pendingApprovalCount.useQuery");
  });

  it("meetings bulk approve books the earliest FUTURE slot and reports skips instead of hiding them", () => {
    const server = read("./routers/meetings.ts");
    const proc = server.slice(server.indexOf("approveAllProposed:"), server.indexOf("reschedule:"));
    expect(proc).toContain("sendMeetingInvite(ctx.workspace.id, m.id)"); // no chosenTime → earliest future slot
    expect(proc).toContain("skipped[k]");
    expect(proc).toMatch(/limit\(50\)/);
  });

  it("proposal extensions reuse the single approve (activity log + client email identical)", () => {
    const server = read("./routers/proposals.ts");
    const proc = server.slice(server.indexOf("approveExtensionsBulk:"), server.indexOf("denyExtension:"));
    expect(proc).toContain("caller.proposals.approveExtension(");
    expect(proc).toMatch(/max\(50\)/);
  });

  it("workflow suggestions share one apply helper so single and bulk cannot drift", () => {
    const server = read("./routers/aiFeatures.ts");
    expect(server).toContain("async function applySuggestionRow(");
    expect((server.match(/applySuggestionRow\(db, ctx\.workspace\.id, sug\)/g) ?? []).length).toBe(2);
  });
});
