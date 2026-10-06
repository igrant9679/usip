/**
 * 2026-10-06: Social Autopilot in Autonomous sent LinkedIn invites, likes and
 * openers with no check of Pause all outbound or the send window (nothing
 * went out, because every workspace was on Approve). It now waits like every
 * other automated sender; a held opener becomes a task so the accept is kept.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { leads, tasks, unipileAccounts, unipileInvites, unipileMessages, workspaceSettings } from "../drizzle/schema";

type Row = Record<string, any>;
const state = {
  mode: "auto" as string,
  paused: false,
  inWindow: true,
  inserts: [] as { table: unknown; v: Row }[],
};

const fakeDb: any = {
  select: (cols?: Row) => ({
    from: (table: unknown) => {
      const rows = (): Row[] => {
        if (table === unipileAccounts) return cols && "workspaceId" in cols ? [{ workspaceId: 4, userId: 5721 }] : [{ userId: 5721, id: "acct-1" }];
        if (table === workspaceSettings) return [{ mode: state.mode, cap: 50 }];
        if (table === unipileMessages) return cols && "n" in cols ? [{ n: 0 }] : [];
        if (table === unipileInvites) return cols && "n" in cols ? [{ n: 0 }] : [];
        if (table === leads) return [{ id: 77, firstName: "Dana", lastName: "Reyes", title: "VP Ops", company: "Acme", ownerUserId: 5721, customFields: { linkedinUrl: "https://www.linkedin.com/in/dana-reyes" } }];
        if (table === tasks) return [];
        return [];
      };
      const q: any = { where: () => q, orderBy: () => q, limit: () => Promise.resolve(rows()), then: (r: any, j: any) => Promise.resolve(rows()).then(r, j) };
      return q;
    },
  }),
  update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
  insert: (table: unknown) => ({ values: (v: Row) => { state.inserts.push({ table, v }); return Promise.resolve([{ insertId: 1 }]); } }),
};

vi.mock("./db", () => ({ getDb: async () => fakeDb }));
vi.mock("./services/sendWindow", () => ({
  getWorkspaceSendWindow: async () => ({ timezone: "America/New_York", window: {}, paused: state.paused }),
  // The real inSendWindow is shut while paused; the fake keeps that.
  inSendWindow: async () => !state.paused && state.inWindow,
}));
vi.mock("./_core/llm", () => ({ invokeLLM: async () => ({ choices: [{ message: { content: "Thanks for connecting, Dana." } }] }) }));
vi.mock("./services/linkedin/activityGate", () => ({
  checkLinkedInAction: async () => ({ allowed: true, reason: null, message: "Within limits" }),
  recordLinkedInAction: async () => {},
}));
const sendMessage = vi.fn(async () => ({ id: "m-1", chatId: "c-1" }));
const sendLinkedInInvitation = vi.fn(async () => ({}));
const reactToPost = vi.fn(async () => ({}));
vi.mock("./lib/unipile", () => ({
  sendMessage: (...a: any[]) => (sendMessage as any)(...a),
  sendLinkedInInvitation: (...a: any[]) => (sendLinkedInInvitation as any)(...a),
  reactToPost: (...a: any[]) => (reactToPost as any)(...a),
  listUserPosts: async () => ({ items: [{ social_id: "post-1" }] }),
}));

import { handleNewRelation, runSocialAutopilotInvitesForWorkspace } from "./services/socialAutopilot";

const accept = { account_id: "acct-1", user_provider_id: "ACoAA-dana", user_full_name: "Dana Reyes" };
const taskTitles = () => state.inserts.filter((i) => i.table === tasks).map((i) => i.v.title as string);

beforeEach(() => {
  state.mode = "auto";
  state.paused = false;
  state.inWindow = true;
  state.inserts = [];
  sendMessage.mockClear();
  sendLinkedInInvitation.mockClear();
  reactToPost.mockClear();
});

describe("the opener when someone accepts", () => {
  it("is sent in Autonomous when outbound is live and the window is open", async () => {
    expect(await handleNewRelation(accept)).toBe("opener_sent");
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("is not sent while outbound is paused: it becomes a task for the rep, saying why", async () => {
    state.paused = true;
    expect(await handleNewRelation(accept)).toBe("held_task");
    expect(sendMessage).not.toHaveBeenCalled();
    expect(taskTitles()).toEqual(["Send LinkedIn opener to Dana Reyes (held: outbound is paused)"]);
    expect(state.inserts.find((i) => i.table === tasks)!.v.description).toContain("Thanks for connecting, Dana.");
    expect(state.inserts.find((i) => i.table === tasks)!.v.description).toContain("Outbound is paused for this workspace");
  });

  it("is not sent outside the send window either", async () => {
    state.inWindow = false;
    expect(await handleNewRelation(accept)).toBe("held_task");
    expect(sendMessage).not.toHaveBeenCalled();
    expect(taskTitles()).toEqual(["Send LinkedIn opener to Dana Reyes (held: outside the send window)"]);
  });

  it("on Approve, while paused, it is drafted into a task as before (nothing is sent either way)", async () => {
    state.mode = "approval";
    state.paused = true;
    expect(await handleNewRelation(accept)).toBe("approval_task");
    expect(sendMessage).not.toHaveBeenCalled();
  });
});

describe("the hourly connection invites", () => {
  it("are sent in Autonomous when outbound is live and the window is open, after a like", async () => {
    expect(await runSocialAutopilotInvitesForWorkspace(4)).toMatchObject({ sent: 1 });
    expect(sendLinkedInInvitation).toHaveBeenCalledTimes(1);
    expect(reactToPost).toHaveBeenCalledTimes(1);
  });

  it("send nothing while outbound is paused: no invite, no like, no task", async () => {
    state.paused = true;
    expect(await runSocialAutopilotInvitesForWorkspace(4)).toEqual({ sent: 0, tasked: 0, skipped: 0 });
    expect(sendLinkedInInvitation).not.toHaveBeenCalled();
    expect(reactToPost).not.toHaveBeenCalled();
    expect(taskTitles()).toEqual([]);
  });

  it("send nothing outside the send window (the next hourly run inside it picks up)", async () => {
    state.inWindow = false;
    expect(await runSocialAutopilotInvitesForWorkspace(4)).toEqual({ sent: 0, tasked: 0, skipped: 0 });
    expect(sendLinkedInInvitation).not.toHaveBeenCalled();
    expect(reactToPost).not.toHaveBeenCalled();
  });

  it("on Approve they are still drafted into tasks while paused: drafting sends nothing", async () => {
    state.mode = "approval";
    state.paused = true;
    expect(await runSocialAutopilotInvitesForWorkspace(4)).toMatchObject({ tasked: 1, sent: 0 });
    expect(sendLinkedInInvitation).not.toHaveBeenCalled();
    expect(taskTitles()).toEqual(["Send LinkedIn invite to Dana Reyes"]);
  });
});
