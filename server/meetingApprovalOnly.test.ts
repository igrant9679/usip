/**
 * Meeting proposals are approval-only (owner ask 2026-09-24: "the Proposal
 * generation function should not have an Autonomous mode. Should require
 * approval and/or edits").
 *
 *   • nothing the autopilot or the Find button drafts is sent by the engine:
 *     only approveAndSend, approveAllProposed and a booking-link self-booking
 *     reach sendMeetingInvite;
 *   • the dial offers Off and Approve, on the Meetings page and the Autonomy
 *     Center; the API refuses 'auto'; migration 0188 moves stored 'auto' rows;
 *   • a proposal can be edited (title, invite text, times) before approval;
 *   • the whole queue can be rewritten with the current brand profile, in
 *     anchored passes that walk the queue instead of rewriting the same rows.
 *
 * Structural pins, because every one of these is a line that could quietly
 * come back — the 'auto' send branch was 12 lines inside the proposing loop.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const svc = readFileSync("server/services/meetingScheduler.ts", "utf8");
const router = readFileSync("server/routers/meetings.ts", "utf8");
const meetingsPage = readFileSync("client/src/pages/usip/MeetingsV2.tsx", "utf8");
const autonomy = readFileSync("client/src/pages/usip/WorkflowsV2.tsx", "utf8");
const raw = readFileSync("server/_core/rawMigrations.ts", "utf8");
const catalog = readFileSync("server/services/assistantActionCatalog.ts", "utf8");
const help = readFileSync("server/seedHelpContent.ts", "utf8");

const between = (src: string, from: string, to: string) => {
  const a = src.indexOf(from);
  const b = src.indexOf(to, a + from.length);
  expect(a, `anchor "${from}" moved — re-anchor`).toBeGreaterThan(-1);
  expect(b, `anchor "${to}" moved — re-anchor`).toBeGreaterThan(a);
  return src.slice(a, b);
};

describe("the engine proposes and never sends", () => {
  it("the proposing loop has no send path and no mode", () => {
    const fn = between(svc, "export async function runMeetingAutopilotForWorkspace(", "/** Cron entry:");
    expect(fn).not.toContain("sendMeetingInvite(");
    expect(fn).not.toContain('"auto"');
    expect(fn).toContain("): Promise<{ proposed: number; skipped: number }> {");
  });

  it("the cron reads no mode and sends nothing", () => {
    const cron = svc.slice(svc.indexOf("export async function runMeetingAutopilotAllWorkspaces"));
    expect(cron.length).toBeGreaterThan(200);
    expect(cron).not.toContain("sendMeetingInvite(");
    expect(cron).not.toMatch(/meetingAutopilotMode as/);
    expect(cron).toContain("runMeetingAutopilotForWorkspace(ws.workspaceId, Math.min(remaining, 10))");
  });

  it("only human approval paths reach sendMeetingInvite in the router", () => {
    const calls = router.split("sendMeetingInvite(").length - 1;
    expect(calls).toBe(2);
    expect(between(router, "approveAndSend: repProcedure", "approveAllProposed:")).toContain("sendMeetingInvite(");
    expect(between(router, "approveAllProposed: repProcedure", "regenerateProposal:")).toContain("sendMeetingInvite(");
  });

  it("the mode type has no auto", () => {
    expect(svc).toContain('export type MeetingAutopilotMode = "off" | "approval";');
  });
});

describe("the dial is Off or Approve everywhere", () => {
  it("the API refuses auto and reads a stored auto as approval", () => {
    expect(router).toContain('mode: z.enum(["off", "approval"])');
    expect(router).not.toContain('mode: z.enum(["off", "approval", "auto"])');
    expect(router).toContain('mode: row.mode === "off" ? "off" as const : "approval" as const');
  });

  it("migration 0188 moves every stored auto to approval", () => {
    expect(raw).toContain('name: "0188_meeting_autopilot_approval_only.sql"');
    expect(raw).toContain("UPDATE `workspace_settings` SET `meetingAutopilotMode` = 'approval' WHERE `meetingAutopilotMode` = 'auto'");
  });

  it("the Meetings page offers no Autonomous option", () => {
    expect(meetingsPage).not.toContain('<SelectItem value="auto">');
    expect(meetingsPage).not.toMatch(/auto: \{ label: "Autopilot: Autonomous"/);
  });

  it("the Autonomy Center hides Autonomous for meetings, and All: Autonomous leaves them on Approve", () => {
    expect(autonomy).toContain('const NO_AUTO = new Set<string>(["meetings"]);');
    expect(autonomy).toContain('{!NO_AUTO.has(a.key) && <SelectItem value="auto">Autonomous</SelectItem>}');
    expect(autonomy).toContain('setMeetAp.mutate({ mode: (mode === "auto" ? "approval" : mode) as any });');
  });

  it("the assistant and the Help Center no longer describe an auto-sending meeting autopilot", () => {
    expect(catalog).toContain("There is no auto mode: a meeting invite never sends without approval.");
    expect(help).not.toContain("proposes and sends invites to prospects who look ready");
    expect(help).not.toContain("in Auto mode books the event");
    expect(help).not.toContain("Meeting Autopilot proposes times and sends the invite");
  });
});

describe("a proposal can be edited before approval", () => {
  const upd = between(router, "updateProposal: repProcedure", "/** Manually create a meeting");

  it("only an open proposal without an agreed time", () => {
    expect(upd).toContain('if (m.status !== "proposed" || m.scheduledAt)');
  });

  it("offered times are future-only, deduped, sorted, at most five", () => {
    expect(upd).toContain("proposedTimes: z.array(z.string().datetime()).min(1).max(5).optional()");
    expect(upd).toContain("if (times.some((t) => new Date(t).getTime() <= nowMs))");
    expect(upd).toContain("Array.from(new Set(input.proposedTimes.map((t) => new Date(t).toISOString()))).sort()");
  });

  it("is workspace-scoped and never sends", () => {
    expect(upd.split("eq(meetings.workspaceId, ctx.workspace.id)").length - 1).toBe(2);
    expect(upd).not.toContain("sendMeetingInvite(");
  });

  it("the card offers Edit and saves through updateProposal", () => {
    expect(meetingsPage).toContain("onEdit={(patch) => updateProposal.mutate({ id: m.id, ...patch })}");
    expect(meetingsPage).toContain('{editing ? "Close" : "Edit"}');
    expect(meetingsPage).toContain('type="datetime-local"');
  });
});

describe("the whole queue can be rewritten with the current brand", () => {
  const pass = between(svc, "export async function regenerateProposalsNotSince(", "/** Draft + persist a proposed meeting for one prospect.");

  it("walks the queue by an anchor instead of rewriting the same rows", () => {
    expect(pass).toContain("lt(meetings.updatedAt, since)");
    expect(pass).toContain("isNull(meetings.scheduledAt)");
    expect(pass).toContain('eq(meetings.status, "proposed")');
    expect(pass).toContain("return { regenerated: done, remaining: rows.length - done };");
    expect(pass).not.toContain("sendMeetingInvite(");
  });

  it("the server anchors the pass and hands the anchor back", () => {
    const ep = between(router, "regenerateAllProposals: repProcedure", "reschedule: repProcedure");
    expect(ep).toContain("const since = input?.since ? new Date(input.since) : new Date();");
    expect(ep).toContain("regenerateProposalsNotSince(ctx.workspace.id, since, 10)");
    expect(ep).toContain("return { ...res, since: since.toISOString() };");
  });

  it("the page confirms before starting and continues with the server's anchor", () => {
    expect(meetingsPage).toContain('confirmLabel="Rewrite all" onConfirm={() => regenerateAll.mutate({})}');
    expect(meetingsPage).toContain("onClick={() => regenerateAll.mutate({ since: regenPass.since })}");
    expect(meetingsPage).toContain("setRegenPass(r.remaining > 0 ? { since: r.since, remaining: r.remaining } : null);");
  });
});
