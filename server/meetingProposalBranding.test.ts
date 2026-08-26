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

describe("the Find-meetings button honors the workspace's autopilot mode", () => {
  it("generateProposals resolves the stored mode instead of hardcoding approval", () => {
    // Owner ask 2026-08-26: a workspace in full autonomy should not have its
    // manual "find more" pass demand approvals the 45-minute cron doesn't.
    const fn = router.slice(router.indexOf("generateProposals:"), router.indexOf("/** Manually create a meeting"));
    expect(fn).toContain("workspaceSettings.meetingAutopilotMode");
    expect(fn).toContain('s?.mode === "auto" ? "auto"');
    expect(fn).not.toMatch(/runMeetingAutopilotForWorkspace\(ctx\.workspace\.id,\s*"approval"/);
  });
});
