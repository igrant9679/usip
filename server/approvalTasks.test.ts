/**
 * Pins for the approve-and-send queues (2026-09-09): chat follow-ups and
 * Social Autopilot invites used to be plain open tasks with no way to send.
 * What must hold: the parser reads the shape chatFollowUp writes (including
 * the new To: line), sends go through the autopilots' own paths, every send
 * claims the task first (at-most-once), the task closes as "sent", the
 * assistant sees these only as flagged sends, and the Tasks page renders
 * them as confirm cards rather than to-dos.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseChatFollowUp } from "./services/approvalTasks";
import { SEND_ALLOWLIST } from "./services/assistantActionCatalog";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

describe("chat follow-up parser", () => {
  it("reads the shape chatFollowUp writes, with and without the To: line", () => {
    const withTo = "Suggested email\nTo: ana@example.org\n\nSubject: quick question\n\nHi Ana,\n\nStill want that demo?\n\nBest";
    expect(parseChatFollowUp(withTo)).toEqual({ to: "ana@example.org", subject: "quick question", body: "Hi Ana,\n\nStill want that demo?\n\nBest" });
    const legacy = "Suggested email\n\nSubject: hello\n\nBody here";
    expect(parseChatFollowUp(legacy)).toEqual({ to: null, subject: "hello", body: "Body here" });
    expect(parseChatFollowUp("Call them back")).toEqual({ to: null, subject: null, body: null });
  });

  it("chatFollowUp now writes the To: line and still matches the attention predicate", () => {
    const src = read("./services/chatFollowUp.ts");
    expect(src).toContain("description: `Suggested email\\nTo: ${email}\\n\\nSubject: ${draft.subject}\\n\\n${draft.body}`");
    expect(read("./routers/attention.ts")).toContain('like(tasks.description, "Suggested email%")');
  });
});

describe("approve-and-send", () => {
  const svc = read("./services/approvalTasks.ts");

  it("claims the task before sending and reopens it on failure (at-most-once)", () => {
    expect((svc.match(/set\(\{ status: "in_progress" \} as never\)/g) ?? []).length).toBe(2);
    expect((svc.match(/eq\(tasks\.status, "open"\)\)\);/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect((svc.match(/set\(\{ status: "open" \} as never\)/g) ?? []).length).toBe(2);
  });

  it("sends through the autopilots' own paths and closes the task as sent", () => {
    expect(svc).toContain("sendWorkspaceEmail(workspaceId, { to, subject: p.subject, text: p.body, html: textToHtml(p.body) })");
    expect(svc).toContain("sendLinkedInInvitation({ accountId: account.id, providerId: slug, message: note })");
    expect(svc).toContain('checkLinkedInAction({ workspaceId, unipileAccountId: account.id, kind: "invite" })');
    expect(svc).toContain("recordLinkedInAction({");
    expect((svc.match(/closeTask\(workspaceId, taskId, "sent"\)/g) ?? []).length).toBe(2);
    // The note generator is the autopilot's own, exported for this.
    expect(read("./services/socialAutopilot.ts")).toContain("export async function generateInviteNote(");
  });

  it("LinkedIn openers stay manual — no provider id on the task, no guessing", () => {
    expect(svc).not.toMatch(/like\(tasks\.title, "Send LinkedIn opener/);
    expect(svc).not.toContain("sendMessage(");
  });

  it("is exposed as rep procedures with audit, and the assistant sees them only as flagged sends", () => {
    const router = read("./routers/activities.ts");
    for (const p of ["approvalQueue:", "sendChatFollowUp:", "sendAllChatFollowUps:", "sendSocialInvite:", "sendAllSocialInvites:"]) expect(router).toContain(p);
    expect((router.match(/approveAndSend/g) ?? []).length).toBeGreaterThanOrEqual(4);
    for (const p of ["tasks.sendChatFollowUp", "tasks.sendAllChatFollowUps", "tasks.sendSocialInvite", "tasks.sendAllSocialInvites"]) {
      expect(SEND_ALLOWLIST[p], p).toMatch(/NOW/);
    }
  });

  it("the Tasks page renders the queues as confirm cards and keeps them out of the plain to-do list", () => {
    const page = read("../client/src/pages/usip/TasksV2.tsx");
    expect(page).toContain("trpc.tasks.approvalQueue.useQuery");
    expect(page).toContain("Waiting for your approval");
    expect(page).toContain(".filter((t) => !approvalIds.has(t.id))");
    expect((page.match(/confirmLabel="Approve & send all"/g) ?? []).length).toBe(2);
    expect((page.match(/confirmLabel="Approve & send"/g) ?? []).length).toBe(2);
  });
});
