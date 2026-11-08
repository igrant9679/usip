/**
 * A Revenue Engine campaign's lifecycle (audit 2026-10-20, F15):
 *
 *   archive instead of delete (delete stays, for admins, behind a confirm);
 *   clone, which makes a draft; a pre-flight before activation that names
 *   what is missing and refuses only what would make the campaign fail; and
 *   a "campaign finished" notice in the app when the target is reached or
 *   every sequence has ended. No email.
 *
 * Runs on the SQL-evaluating fake; the screens are pinned by their source.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => {
  if (!process.env.ENCRYPTION_KEY && !process.env.JWT_SECRET) process.env.ENCRYPTION_KEY = "f".repeat(64);
  return { db: null as any, role: "manager" };
});
vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));
vi.mock("./services/reoon", async (a) => ({ ...(await a<typeof import("./services/reoon")>()), getReoonKey: async () => "" }));

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { appRouter } from "./routers";
import { noticeCampaignFinished } from "./services/are/campaignFinished";
import { activateDialog } from "../client/src/components/usip/are/activateConfirm";
import { invalidateSendWindowCache } from "./services/sendWindow";

const WS = 2, OTHER = 9, ME = 1;
const read = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8").replace(/\r\n/g, "\n");
const rows = (t: string) => h.db.rowsOf(t) as any[];
const camp = (id: number) => rows("are_campaigns").find((c) => c.id === id && c.workspaceId === WS);
const block = (src: string, from: string, to: string) => {
  const a = src.indexOf(from);
  expect(a, `anchor not found: ${from}`).toBeGreaterThan(-1);
  const b = src.indexOf(to, a + from.length);
  expect(b, `end anchor not found: ${to}`).toBeGreaterThan(a);
  return src.slice(a, b);
};
const caller = () => appRouter.createCaller({
  user: { id: ME, openId: "u", email: "o@example.com", name: "O", loginMethod: "password", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
  req: { protocol: "https", headers: { "x-workspace-id": String(WS) } },
  res: { clearCookie: () => {} },
} as unknown as TrpcContext);
const as = (role: string) => { h.role = role; return caller(); };

const base = {
  workspaceId: WS, status: "draft", autonomyMode: "batch_approval", targetProspectCount: 100, dailySendCap: 40,
  channelsEnabled: { email: true, linkedin: false }, prospectSources: ["linkedin"], icpOverrides: { targetTitles: ["Clerk"] },
  sequenceTemplate: "standard_7step", stepGapDays: 7, goalType: "reply", copyMode: "per_person", fixedSteps: null,
  ownerUserId: 5, startedAt: new Date(), archivedAt: null, prospectsDiscovered: 40, prospectsContacted: 12, generatedTemplate: { steps: [1] },
  discoveryQueryState: { lastRunAt: 1 },
};

beforeEach(() => {
  h.role = "manager";
  invalidateSendWindowCache();
  h.db = makeSqlFakeDb({ roles: new Proxy({}, { get: (_t, k) => (Number(k) === WS ? h.role : undefined) }) as Record<number, string>, wsId: () => WS });
  rows("are_campaigns").push(
    { ...base, id: 7, name: "Counties", status: "active" },
    { ...base, id: 8, name: "Cities", status: "paused" },
    { ...base, id: 9, name: "Old", status: "paused", archivedAt: new Date(Date.UTC(2026, 9, 1)) },
    { ...base, id: 7, workspaceId: OTHER, name: "Theirs", status: "active" },
  );
  rows("workspace_settings").push({ workspaceId: WS, timezone: "America/New_York", outboundPausedAt: null, sendWindowStartHour: 0, sendWindowEndHour: 24, sendWindowDays: [0, 1, 2, 3, 4, 5, 6] });
  rows("sending_accounts").push({ id: 1, workspaceId: WS, enabled: true, fromEmail: "a@example.com", name: "A", provider: "generic_smtp" });
});

describe("archive instead of delete", () => {
  it("the list and the count leave archived campaigns out, and show only them on request", async () => {
    expect((await caller().are.campaigns.list({})).map((c) => c.id).sort()).toEqual([7, 8]);
    expect(await caller().are.campaigns.count({})).toEqual({ total: 2 });
    expect((await caller().are.campaigns.list({ archived: true })).map((c) => c.id)).toEqual([9]);
    expect(await caller().are.campaigns.count({ archived: true })).toEqual({ total: 1 });
  });

  it("archiving an active campaign pauses it; unarchiving lists it again and does not start it", async () => {
    expect(await caller().are.campaigns.archive({ id: 7 })).toEqual({ success: true, paused: true });
    expect(camp(7)).toMatchObject({ status: "paused" });
    expect(camp(7).archivedAt).toBeInstanceOf(Date);
    expect((await caller().are.campaigns.list({})).map((c) => c.id)).toEqual([8]);
    await caller().are.campaigns.unarchive({ id: 7 });
    expect(camp(7)).toMatchObject({ status: "paused", archivedAt: null });
    // Their prospects and steps are untouched by either.
    expect(rows("are_campaigns").find((c) => c.workspaceId === OTHER)).toMatchObject({ status: "active", archivedAt: null });
  });

  it("another workspace's campaign is not found", async () => {
    rows("are_campaigns").splice(0, rows("are_campaigns").length, { ...base, id: 77, workspaceId: OTHER, name: "Theirs", status: "active" });
    await expect(caller().are.campaigns.archive({ id: 77 })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(caller().are.campaigns.unarchive({ id: 77 })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(rows("are_campaigns")[0]).toMatchObject({ status: "active", archivedAt: null });
  });

  it("an archived campaign is not activated", async () => {
    await expect(caller().are.campaigns.setStatus({ id: 9, status: "active" })).rejects.toThrow(/archived/);
    expect(camp(9).status).toBe("paused");
  });

  it("delete is an admin's now; a manager archives", async () => {
    await expect(as("manager").are.campaigns.delete({ id: 8 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(camp(8)).toBeTruthy();
    await as("admin").are.campaigns.delete({ id: 8 });
    expect(camp(8)).toBeUndefined();
  });
});

describe("clone makes a draft of the setup, and nothing else", () => {
  it("copies targeting, caps, channels, copy and sources; owner is the person cloning", async () => {
    const r = await caller().are.campaigns.clone({ id: 7 });
    expect(r.name).toBe("Copy of Counties");
    const c = camp(r.id);
    expect(c).toMatchObject({
      status: "draft", name: "Copy of Counties", ownerUserId: ME, dailySendCap: 40, targetProspectCount: 100,
      channelsEnabled: { email: true, linkedin: false }, prospectSources: ["linkedin"], icpOverrides: { targetTitles: ["Clerk"] },
      autonomyMode: "batch_approval", stepGapDays: 7,
    });
    // No people, progress, counters or cached template come along.
    expect(c.prospectsDiscovered ?? 0).toBe(0);
    expect(c.startedAt ?? null).toBeNull();
    expect(c.generatedTemplate ?? null).toBeNull();
    expect(c.discoveryQueryState ?? null).toBeNull();
  });

  it("another workspace's campaign is not cloned", async () => {
    rows("are_campaigns").push({ ...base, id: 78, workspaceId: OTHER, name: "Theirs" });
    await expect(caller().are.campaigns.clone({ id: 78 })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(rows("are_campaigns").filter((c) => c.workspaceId === WS)).toHaveLength(3);
  });
});

describe("the pre-flight names what is missing, and blocks only what would fail", () => {
  const keys = (r: { checks: Array<{ key: string; ok: boolean; blocking: boolean }> }) =>
    Object.fromEntries(r.checks.map((c) => [c.key, `${c.ok ? "ok" : "missing"}${c.blocking ? ":blocks" : ""}`]));

  it("a ready email campaign: nothing blocks; the missing Reoon key is a warning", async () => {
    const r = await caller().are.campaigns.preflight({ id: 8 });
    expect(keys(r)).toEqual({ sender: "ok", reoon: "missing", sources: "ok", timezone: "ok", pause: "ok" });
    expect(r.canActivate).toBe(true);
  });

  it("email only, no mailbox and no Email-Delivery settings: blocks, and setStatus refuses", async () => {
    rows("sending_accounts").splice(0);
    const r = await caller().are.campaigns.preflight({ id: 8 });
    expect(keys(r).sender).toBe("missing:blocks");
    expect(r.canActivate).toBe(false);
    await expect(caller().are.campaigns.setStatus({ id: 8, status: "active" })).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: expect.stringContaining("every email step would fail") });
    expect(camp(8).status).toBe("paused");
    // The workspace's SMTP settings are a sender too.
    rows("smtp_configs").push({ id: 1, workspaceId: WS, host: "smtp.example.com", username: "u", enabled: true, fromEmail: "a@example.com", encryptedPassword: "x" });
    expect(keys(await caller().are.campaigns.preflight({ id: 8 })).sender).toBe("ok");
  });

  it("LinkedIn only, the owner has no account: blocks; with email beside it, a warning", async () => {
    camp(8).channelsEnabled = { email: false, linkedin: true };
    expect(keys(await caller().are.campaigns.preflight({ id: 8 })).linkedin).toBe("missing:blocks");
    camp(8).channelsEnabled = { email: true, linkedin: true };
    expect(keys(await caller().are.campaigns.preflight({ id: 8 })).linkedin).toBe("missing");
    rows("unipile_accounts").push({ id: 1, workspaceId: WS, userId: 5, provider: "LINKEDIN", unipileAccountId: "acc" });
    camp(8).channelsEnabled = { email: false, linkedin: true };
    expect(keys(await caller().are.campaigns.preflight({ id: 8 })).linkedin).toBe("ok");
  });

  it("discovery off and nobody in it: blocks; people in it are enough", async () => {
    camp(8).prospectSources = [];
    expect(keys(await caller().are.campaigns.preflight({ id: 8 })).sources).toBe("missing:blocks");
    rows("prospect_queue").push({ id: 1, workspaceId: WS, campaignId: 8, sequenceStatus: "pending" });
    expect(keys(await caller().are.campaigns.preflight({ id: 8 })).sources).toBe("ok");
  });

  it("the UTC default and the pause are said, never blocking; a ready campaign activates", async () => {
    rows("workspace_settings")[0].timezone = "UTC";
    rows("workspace_settings")[0].outboundPausedAt = new Date();
    invalidateSendWindowCache(WS);
    const r = await caller().are.campaigns.preflight({ id: 8 });
    expect(keys(r)).toMatchObject({ timezone: "missing", pause: "missing" });
    expect(r.canActivate).toBe(true);
    rows("workspace_settings")[0].timezone = "America/New_York";
    await caller().are.campaigns.setStatus({ id: 8, status: "active" });
    expect(camp(8).status).toBe("active");
  });

  it("the confirm lists blockers instead of offering Activate, and warnings beside it", () => {
    const c = { id: 8, name: "Cities", autonomyMode: "batch_approval", autoApproveThreshold: null, dailySendCap: 40 };
    const blocked = activateDialog(c, undefined, [{ key: "sender", label: "Sender accounts", ok: false, blocking: true, detail: "No sending account." }]);
    expect(blocked).toMatchObject({ blocked: true, confirmLabel: "OK", title: '"Cities" can\'t start yet' });
    expect(blocked.lines).toEqual(["Sender accounts: No sending account."]);
    const warned = activateDialog(c, undefined, [{ key: "reoon", label: "Reoon key", ok: false, blocking: false, detail: "No Reoon key." }, { key: "sources", label: "Sources", ok: true, blocking: false, detail: "x" }]);
    expect(warned).toMatchObject({ blocked: false, confirmLabel: "Activate" });
    expect(warned.lead).toContain("This starts real sending.");
    expect(warned.lines).toEqual(["Reoon key: No Reoon key."]);
    expect(activateDialog(c, undefined, null).blocked).toBe(false);
  });
});

describe("the campaign-finished notice", () => {
  beforeEach(() => {
    h.db = makeSqlFakeDb({ realMembers: true });
    rows("workspaces").push({ id: WS, name: "Home", ownerUserId: 1, archivedAt: null });
    rows("workspace_members").push({ id: 1, workspaceId: WS, userId: 1, role: "admin", deactivatedAt: null }, { id: 2, workspaceId: WS, userId: 5, role: "rep", deactivatedAt: null });
    rows("are_campaigns").push({ ...base, id: 7, name: "Counties", status: "active", targetProspectCount: 3, targetReachedNoticeAt: null, sequencesEndedNoticeAt: null });
  });
  const notices = () => rows("notifications").filter((n) => n.kind === "are_event");
  const fresh = () => ({ ...camp(7) });

  it("target reached: the owner hears once, in the app; a raised target clears it for next time", async () => {
    for (let i = 1; i <= 3; i++) rows("prospect_queue").push({ id: i, workspaceId: WS, campaignId: 7, sequenceStatus: "enrolled" });
    rows("prospect_queue").push({ id: 4, workspaceId: WS, campaignId: 7, sequenceStatus: "skipped" });
    rows("are_execution_queue").push({ id: 1, workspaceId: WS, campaignId: 7, prospectQueueId: 1, status: "scheduled" });
    expect(await noticeCampaignFinished(fresh())).toEqual({ targetReached: true, sequencesEnded: false });
    expect(notices()).toHaveLength(1);
    expect(notices()[0]).toMatchObject({ userId: 5, workspaceId: WS, title: "Counties reached its target", relatedType: "are_campaign", relatedId: 7 });
    expect(notices()[0].body).toContain("3 of 3 prospects found");
    expect(camp(7).targetReachedNoticeAt).toBeInstanceOf(Date);
    await noticeCampaignFinished(fresh());
    expect(notices()).toHaveLength(1);
    camp(7).targetProspectCount = 10;
    await noticeCampaignFinished(fresh());
    expect(camp(7).targetReachedNoticeAt).toBeNull();
    expect(notices()).toHaveLength(1);
  });

  it("every sequence ended: told once, and not while a step waits or nothing was ever sent", async () => {
    camp(7).targetProspectCount = 50;
    rows("prospect_queue").push(
      { id: 1, workspaceId: WS, campaignId: 7, sequenceStatus: "replied" },
      { id: 2, workspaceId: WS, campaignId: 7, sequenceStatus: "completed" },
    );
    expect((await noticeCampaignFinished(fresh())).sequencesEnded).toBe(false); // nothing sent yet
    rows("are_execution_queue").push({ id: 1, workspaceId: WS, campaignId: 7, prospectQueueId: 1, status: "sent" });
    rows("are_execution_queue").push({ id: 2, workspaceId: WS, campaignId: 7, prospectQueueId: 2, status: "paused" });
    expect((await noticeCampaignFinished(fresh())).sequencesEnded).toBe(false); // a step waits
    rows("are_execution_queue")[1].status = "skipped";
    expect((await noticeCampaignFinished(fresh())).sequencesEnded).toBe(true);
    expect(notices()).toHaveLength(1);
    expect(notices()[0].title).toBe("Counties has finished its sequences");
    expect(notices()[0].body).toContain("1 replied, 1 ran to the end");
    expect(notices()[0].body).toContain("until it reaches the target of 50");
    await noticeCampaignFinished(fresh());
    expect(notices()).toHaveLength(1);
    // New people: working again, so the next finish is told again.
    rows("prospect_queue").push({ id: 3, workspaceId: WS, campaignId: 7, sequenceStatus: "pending" });
    await noticeCampaignFinished(fresh());
    expect(camp(7).sequencesEndedNoticeAt).toBeNull();
  });

  it("no email: it writes a notification only, and the engine calls it for each campaign it ticks", () => {
    const svc = read("server/services/are/campaignFinished.ts");
    expect(svc).toContain('eventType: "campaign_completed"');
    expect(svc).not.toMatch(/send(System|Workspace)Email|sendCampaignEmail/);
    const engine = read("server/areEngine.ts");
    const tick = block(engine, "async function tickCampaign(", "/* ─── Discovery — scrape one source");
    expect(tick).toContain("await noticeCampaignFinished(campaign);");
  });
});

describe("the screens", () => {
  const list = read("client/src/pages/usip/ARECampaigns.tsx");
  const page = read("client/src/pages/usip/ARECampaignDetail.tsx");

  it("the list has an Archived view, Archive, Unarchive and Clone, and Delete for admins", () => {
    expect(list).toContain("{ limit: CAMPAIGN_PAGE, offset: (listPage - 1) * CAMPAIGN_PAGE, archived: showArchived }");
    expect(list).toContain("trpc.are.campaigns.count.useQuery({ archived: showArchived })");
    expect(list).toContain("onClick={() => clone.mutate({ id: c.id })}");
    expect(list).toContain("onClick={() => unarchive.mutate({ id: c.id })}");
    expect(list).toContain("}, () => archive.mutate({ id: c.id }))}");
    expect(list).toContain('const canDelete = rankOf(currentWs?.role ?? "rep") >= ROLE_RANK.admin;');
  });

  it("the campaign page offers the same, says when it is archived, and asks before archiving or deleting", () => {
    const header = block(page, "<PageHeader\n        title={campaign.name}", "</PageHeader>");
    expect(header).toContain("onClick={() => cloneCampaign.mutate({ id: campaignId })}");
    expect(header).toContain("}, () => archiveCampaign.mutate({ id: campaignId }))}");
    expect(header).toContain("onClick={() => unarchiveCampaign.mutate({ id: campaignId })}");
    expect(header).toContain("{isAdmin && (");
    expect(header).toContain("}, () => deleteCampaign.mutate({ id: campaignId }))}");
    expect(page).toContain("Archived {new Date(campaign.archivedAt).toLocaleDateString()}");
  });

  it("Activate reads the pre-flight first, on both screens", () => {
    const hook = read("client/src/components/usip/are/activateConfirm.ts");
    expect(hook).toContain("utils.are.campaigns.preflight.fetch({ id: c.id }, { staleTime: 0 })");
    expect(hook).toContain("if (d.blocked) {");
  });
});
