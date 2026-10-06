/**
 * "Block everything" (owner, 2026-10-06): while Pause all outbound is on,
 * nothing a person clicks goes to prospects either. Each send asks
 * outboundPause before it writes or sends anything; mail and invites that
 * reach only the workspace's own team still go.
 */
import { readFileSync } from "fs";
import path from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = { paused: true, team: [] as { email: string | null; notifEmail: string | null }[] };
const fakeDb: any = {
  select: () => ({
    from: () => ({
      innerJoin: () => ({ where: () => Promise.resolve(state.team) }),
    }),
  }),
};
vi.mock("./db", () => ({ getDb: async () => fakeDb }));
vi.mock("./services/sendWindow", () => ({ getWorkspaceSendWindow: async () => ({ timezone: "America/New_York", window: {}, paused: state.paused }) }));

import { assertOutboundNotPausedFor, OUTBOUND_PAUSED_MESSAGE, recipientAddresses } from "./services/outboundPause";
import { DENY_LEAF, SEND_ALLOWLIST } from "./services/assistantActionCatalog";

beforeEach(() => {
  state.paused = true;
  state.team = [{ email: "Idris.Grant@lsi-media.com", notifEmail: "idris@getvelocityai.app" }, { email: "kira@lsi-media.com", notifEmail: null }];
});

describe("a send with known recipients, while paused", () => {
  it("goes when every recipient is on the team (login or notification address, any case)", async () => {
    await expect(assertOutboundNotPausedFor(2, ["idris.grant@lsi-media.com", "Kira <KIRA@lsi-media.com>", "idris@getvelocityai.app"])).resolves.toBeUndefined();
  });

  it("is refused when any one recipient is outside the team, cc included", async () => {
    await expect(assertOutboundNotPausedFor(2, ["kira@lsi-media.com", "dank@malish.com"])).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: OUTBOUND_PAUSED_MESSAGE });
    await expect(assertOutboundNotPausedFor(2, ["kira@lsi-media.com", undefined, "Joe <joed@bsa.org>, kira@lsi-media.com"])).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it("a deactivated teammate is not on the team (the query only reads active members)", () => {
    const src = readFileSync(path.join(__dirname, "services", "outboundPause.ts"), "utf8");
    expect(src).toContain(".where(and(eq(workspaceMembers.workspaceId, workspaceId), isNull(workspaceMembers.deactivatedAt)));");
  });

  it("with no recipients nothing is sent, so nothing is refused", async () => {
    await expect(assertOutboundNotPausedFor(2, [])).resolves.toBeUndefined();
    await expect(assertOutboundNotPausedFor(2, [null, ""])).resolves.toBeUndefined();
  });

  it("when not paused, anyone may be sent to", async () => {
    state.paused = false;
    await expect(assertOutboundNotPausedFor(2, ["dank@malish.com"])).resolves.toBeUndefined();
  });

  it("reads addresses out of name-and-address lists", () => {
    expect(recipientAddresses(['"Dan K" <Dank@Malish.com>; joe@bsa.org', null, "no address"])).toEqual(["dank@malish.com", "joe@bsa.org"]);
  });
});

/* ── every person send asks first ─────────────────────────────────────── */

const read = (rel: string) => readFileSync(path.join(__dirname, rel), "utf8").replace(/\r\n/g, "\n");
/** One procedure's source: from its name to the next procedure in the router. */
function procedure(src: string, start: string, occurrence = 1): string {
  let at = -1;
  for (let i = 0; i < occurrence; i++) at = src.indexOf(start, at + 1);
  if (at < 0) throw new Error(`not found: ${start}`);
  const rest = src.slice(at + start.length);
  const next = rest.search(/\n  [a-zA-Z]+: [a-zA-Z]*[Pp]rocedure/);
  return start + (next < 0 ? rest : rest.slice(0, next));
}

const GUARD = "await assertOutboundNotPaused(ctx.workspace.id);";
const SURFACES: Array<{ file: string; start: string; occurrence?: number; guard?: string; before: string; what: string }> = [
  { file: "routers/crm.ts", start: "  sendAdHocEmail: repProcedure", occurrence: 1, before: "adapter.sendEmail(", what: "email from a contact" },
  { file: "routers/crm.ts", start: "  sendAdHocEmail: repProcedure", occurrence: 2, before: "adapter.sendEmail(", what: "email from a lead" },
  { file: "routers/mailbox.ts", start: "  sendNew: workspaceProcedure", guard: "await assertOutboundNotPausedFor(ctx.workspace.id, [input.to, input.cc, input.bcc]);", before: "adapter.sendEmail(", what: "mailbox new message" },
  { file: "routers/mailbox.ts", start: "  sendReply: workspaceProcedure", guard: "await assertOutboundNotPausedFor(ctx.workspace.id, [input.to, input.cc]);", before: "adapter.sendEmail(", what: "mailbox reply and forward" },
  { file: "routers/smtpConfig.ts", start: "  sendDraft: workspaceProcedure", before: "transporter.sendMail(", what: "an approved draft by SMTP" },
  { file: "routers/smtpConfig.ts", start: "  sendBulkApproved: adminWsProcedure", before: "transporter.sendMail(", what: "every approved draft by SMTP" },
  { file: "routers/sequences.ts", start: "  send: repProcedure.input(z.object({ id: z.number() }))", before: "deliverEmailDraft(", what: "an approved email draft" },
  { file: "routers/proposals.ts", start: "  sendToClient: repProcedure", before: "const db = await getDb();", what: "a proposal to its client" },
  { file: "routers/proposals.ts", start: "  approveExtension: workspaceProcedure", before: ".update(proposals)", what: "an extension approval mailed to the client" },
  { file: "routers/proposals.ts", start: "  approveExtensionsBulk: workspaceProcedure", before: "caller.proposals.approveExtension(", what: "extension approvals in bulk" },
  { file: "routers/proposals.ts", start: "  denyExtension: workspaceProcedure", before: "logProposalActivity(", what: "an extension denial mailed to the client" },
  { file: "routers/activities.ts", start: "  sendChatFollowUp: repProcedure", before: "sendChatFollowUpTask(", what: "a chat follow-up task" },
  { file: "routers/activities.ts", start: "  sendAllChatFollowUps: repProcedure", before: "sendAllApprovalTasks(", what: "every chat follow-up task" },
  { file: "routers/activities.ts", start: "  sendSocialInvite: repProcedure", before: "sendSocialInviteTask(", what: "a Social Autopilot invite task" },
  { file: "routers/activities.ts", start: "  sendAllSocialInvites: repProcedure", before: "sendAllApprovalTasks(", what: "every Social Autopilot invite task" },
  { file: "routers/unipile.ts", start: "  sendMessage: workspaceProcedure", before: "await sendMessage({", what: "a LinkedIn message or InMail" },
  { file: "routers/unipile.ts", start: "  sendLinkedInInvite: workspaceProcedure", before: "await sendLinkedInInvitation({", what: "a LinkedIn invite" },
  { file: "routers/unipile.ts", start: "  reactToPost: workspaceProcedure", before: "await reactToPost(", what: "a reaction on someone's post" },
  { file: "routers/unipile.ts", start: "  commentOnPost: workspaceProcedure", before: "await commentOnPost(", what: "a comment on someone's post" },
  { file: "routers/calendar.ts", start: "  createEvent: workspaceProcedure", guard: "await assertOutboundNotPausedFor(ctx.workspace.id, (input.attendees ?? []).map((a) => a.email));", before: "adapter.createEvent(", what: "a calendar invite" },
  { file: "routers/calendar.ts", start: "  updateEvent: workspaceProcedure", guard: "await assertOutboundNotPausedFor(ctx.workspace.id, input.attendees", before: "adapter.updateEvent(", what: "a calendar update" },
  { file: "routers/meetings.ts", start: "  approveAndSend: repProcedure", before: "sendMeetingInvite(", what: "meeting Approve & send" },
  { file: "routers/meetings.ts", start: "  approveAllProposed: repProcedure", before: "sendMeetingInvite(", what: "meeting Approve & send all" },
];

describe("every send a person clicks asks first", () => {
  for (const s of SURFACES) {
    it(`${s.what} (${s.file})`, () => {
      const body = procedure(read(s.file), s.start, s.occurrence);
      const g = body.indexOf(s.guard ?? GUARD);
      expect(g, "guard missing").toBeGreaterThan(-1);
      const b = body.indexOf(s.before);
      expect(b, `send marker missing: ${s.before}`).toBeGreaterThan(-1);
      expect(g, "the guard must come before anything is written or sent").toBeLessThan(b);
    });
  }

  it("covers every router procedure that sends to an outside person (none added without a guard)", () => {
    // The procedures that reach an outside person, by name, across the routers.
    // A new one must be guarded and added to SURFACES, or argued for here.
    const NOT_HELD = new Map<string, string>([
      ["routers/unipile.ts::createPost", "a post on your own feed is addressed to no one"],
      ["routers/meetings.ts::cancelSentInvites", "cancelling is the clean-up the pause exists for"],
      ["routers/chatAgents.ts::send", "the visitor's own chat (public); its email code is what they asked for"],
      ["routers/operations.ts::sendScheduleNow", "dashboards to your own team"],
      ["routers/operations.ts::send", "quotes.send only marks the quote sent"],
      ["routers/reports.ts::sendNow", "reports to your own team"],
      ["routers/pipelineAlerts.ts::sendDigest", "alerts to your own team"],
      ["routers/sequences.ts::approveAll", "only marks drafts approved; sending them is held (auto-send waits for the window, a person's send asks)"],
      ["routers/activities.ts::approveAllDrafts", "only turns draft tasks into open tasks"],
    ]);
    const files = ["crm", "mailbox", "smtpConfig", "sequences", "proposals", "activities", "unipile", "calendar", "meetings", "chatAgents", "operations", "reports", "pipelineAlerts"];
    const guarded = new Set(SURFACES.map((s) => `${s.file}::${s.start.trim().split(":")[0]}`));
    const unaccounted: string[] = [];
    for (const f of files) {
      const src = read(`routers/${f}.ts`);
      for (const m of Array.from(src.matchAll(/\n  ((?:send|approveAndSend|approveAll|approveExtension|denyExtension|reactTo|commentOn|createPost|createEvent|updateEvent)[A-Za-z]*): [a-zA-Z]*[Pp]rocedure/g))) {
        const key = `routers/${f}.ts::${m[1]}`;
        if (!guarded.has(key) && !NOT_HELD.has(key)) unaccounted.push(key);
      }
    }
    expect(unaccounted).toEqual([]);
  });

  it("Find meetings in Autonomous drafts instead of sending while paused", () => {
    const body = procedure(read("routers/meetings.ts"), "  generateProposals: repProcedure");
    expect(body).toContain("const paused = await isOutboundPaused(ctx.workspace.id);");
    expect(body).toContain('const send = s?.mode === "auto" && !paused;');
    expect(body).toContain("{ send }");
  });

  it("an update with unchanged attendees is checked against the stored ones", () => {
    const body = procedure(read("routers/calendar.ts"), "  updateEvent: workspaceProcedure");
    expect(body).toContain(": await storedAttendeeEmails(ctx.workspace.id, input.dbId));");
  });
});

describe("the assistant", () => {
  it("never sees the extension decisions, which email the client", () => {
    for (const leaf of ["approveExtension", "approveExtensionsBulk", "denyExtension"]) expect(DENY_LEAF.test(leaf), leaf).toBe(true);
    // Reading them stays allowed.
    for (const leaf of ["listExtensionPending", "getExtensionHistory"]) expect(DENY_LEAF.test(leaf), leaf).toBe(false);
  });

  it("says out loud that Find meetings sends in Autonomous", () => {
    expect(SEND_ALLOWLIST["meetings.generateProposals"]).toMatch(/^SENDS .*NOW/);
  });
});
