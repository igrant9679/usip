/**
 * Meeting proposals speak as the WORKSPACE, not as Velocity.
 *
 * Found live 2026-08-26: the draft prompt carried no sender identity and its
 * example title literally read "Velocity <> Acme intro" — so 211 of LSI's
 * 224 AI proposals and all 10 of CF's marketed the platform instead of the
 * tenant, and CF's auto mode SENT two of them to real recipients. These
 * source pins hold the seam (the drafting needs a live DB + LLM).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const scheduler = readFileSync(join(__dirname, "services", "meetingScheduler.ts"), "utf8");
const router = readFileSync(join(__dirname, "routers", "meetings.ts"), "utf8");

describe("proposal drafts carry the workspace's identity", () => {
  it("the prompt is framed as an SDR at the WORKSPACE company, with the one brand block", () => {
    expect(scheduler).toContain('import { buildBrandContext } from "./brandContext"');
    expect(scheduler).toContain("You are an SDR at ${senderCompany}");
    expect(scheduler).toContain("buildBrandContext(workspaceId)");
    expect(scheduler).toContain("never pitch, name, or allude to any software platform");
  });

  it("the example title is templated from the sender, never the platform", () => {
    expect(scheduler).toContain("'${senderCompany} <> ${target.company || \"Acme\"} intro'");
    expect(scheduler).not.toContain("'Velocity <> Acme intro'");
  });
});

describe("the Find-meetings button only ever proposes", () => {
  it("generateProposals proposes without reading any autonomy mode and never sends", () => {
    // Owner ask 2026-09-24 replaced the 2026-08-26 one: meeting proposals are
    // approval-only, so the button's finds wait for a person like the cron's.
    const fn = router.slice(router.indexOf("generateProposals:"), router.indexOf("updateProposal:"));
    expect(fn.length).toBeGreaterThan(100);
    expect(fn).toContain("runMeetingAutopilotForWorkspace(ctx.workspace.id, input?.limit ?? 8, ctx.user.id)");
    expect(fn).not.toContain("meetingAutopilotMode");
    expect(fn).not.toContain("sendMeetingInvite(");
  });
});
