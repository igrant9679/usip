/**
 * Meeting proposal modes: Off, Approve, Autonomous.
 *
 * 2026-09-24 morning the owner removed Autonomous ("should not have an
 * Autonomous mode. Should require approval and/or edits"); the same evening,
 * once sending could no longer double-book the owner, book outside 9–16,
 * invite nobody, or count an unanswered invite as a booking, they asked for
 * it back ("I want to turn that on for meeting proposals").
 *
 *   • Approve: nothing the autopilot or the Find button drafts is sent;
 *     only Approve & send / Approve & send all / a booking link reach
 *     sendMeetingInvite;
 *   • Autonomous: each NEW proposal is sent as soon as it is drafted, by the
 *     cron and by the Find button, through sendMeetingInvite and its guards;
 *     proposals already waiting in the queue are never sent by it;
 *   • a proposal can be edited (title, invite text, times) before approval;
 *   • the whole queue can be rewritten with the current brand profile.
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

describe("the engine sends only in Autonomous, and only what it just drafted", () => {
  it("the proposing loop sends a proposal it has just created, only when asked to", () => {
    const fn = between(svc, "export async function runMeetingAutopilotForWorkspace(", "/** Cron entry:");
    expect(fn).toContain("  opts: { send?: boolean } = {},");
    expect(fn).toContain("    if (opts.send) {\n      const r = await sendMeetingInvite(workspaceId, id);");
    // One send, on the id this loop just created: never the queue.
    expect(fn.split("sendMeetingInvite(").length - 1).toBe(1);
  });

  it("the cron sends only for workspaces on Autonomous", () => {
    const cron = svc.slice(svc.indexOf("export async function runMeetingAutopilotAllWorkspaces"));
    expect(cron).toContain('const send = ws.meetingAutopilotMode === "auto";');
    expect(cron).toContain("runMeetingAutopilotForWorkspace(ws.workspaceId, Math.min(remaining, 10), undefined, { send })");
    expect(cron).not.toContain("sendMeetingInvite(");
  });

  it("the Find button honours the workspace's mode", () => {
    const ep = between(router, "generateProposals: repProcedure", "updateProposal: repProcedure");
    expect(ep).toContain('const send = s?.mode === "auto";');
    expect(ep).toContain("runMeetingAutopilotForWorkspace(ctx.workspace.id, input?.limit ?? 8, ctx.user.id, { send })");
  });

  it("besides the engine, only human approval paths reach sendMeetingInvite in the router", () => {
    const calls = router.split("sendMeetingInvite(").length - 1;
    expect(calls).toBe(2);
    expect(between(router, "approveAndSend: repProcedure", "approveAllProposed:")).toContain("sendMeetingInvite(");
    expect(between(router, "approveAllProposed: repProcedure", "regenerateProposal:")).toContain("sendMeetingInvite(");
  });

  it("the mode type has all three", () => {
    expect(svc).toContain('export type MeetingAutopilotMode = "off" | "approval" | "auto";');
  });
});

describe("the dial is Off, Approve or Autonomous everywhere", () => {
  it("the API takes auto and reads it back as stored", () => {
    expect(router).toContain('mode: z.enum(["off", "approval", "auto"])');
    expect(router).toContain('return { ...row, mode: row.mode as "off" | "approval" | "auto" };');
  });

  it("migration 0188 is history and stays (it only moved rows, once)", () => {
    expect(raw).toContain('name: "0188_meeting_autopilot_approval_only.sql"');
  });

  it("the Meetings page offers Autonomous and says what it does", () => {
    expect(meetingsPage).toContain('<SelectItem value="auto">Autopilot: Autonomous</SelectItem>');
    expect(meetingsPage).toContain('auto: { label: "Autopilot: Autonomous"');
    expect(meetingsPage).toContain("Proposals already in the queue still need approval.");
  });

  it("the Autonomy Center offers Autonomous for meetings, and All: Autonomous sets it", () => {
    expect(autonomy).toContain("const NO_AUTO = new Set<string>([]);");
    expect(autonomy).toContain("setMeetAp.mutate({ mode: mode as any });");
  });

  it("the assistant and the Help Center describe all three modes", () => {
    expect(catalog).toContain("auto = each NEW proposal's invite is sent unattended from the owner's calendar");
    expect(help).toContain("(Autonomy Control Center, Off / Approve / Autonomous)");
    expect(help).not.toContain("It has no Autonomous mode");
  });
});

describe("a proposal can be edited before approval", () => {
  const upd = between(router, "updateProposal: repProcedure", "proposalOwners: workspaceProcedure");

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
