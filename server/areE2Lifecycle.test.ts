/**
 * Starting and ending a Revenue Engine campaign (audit 2026-10-20, batch E2).
 *
 *   A18 delete is a manager's, audited, one transaction scoped to the
 *       workspace: unsent steps stop, the people still in it are taken out and
 *       freed to join another campaign, sent history stays
 *   A52 Activate asks first, on the campaign page and the list alike, saying it
 *       starts sending and that nothing goes while outbound is paused
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => {
  if (!process.env.ENCRYPTION_KEY && !process.env.JWT_SECRET) process.env.ENCRYPTION_KEY = "b".repeat(64);
  return { db: null as any, role: "manager" };
});
vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { appRouter } from "./routers";
import { existingClaim, workspaceQueueIdentityIndex } from "./services/are/queueIdentity";
import { activateMessage } from "../client/src/components/usip/are/activateConfirm";

const WS = 2, OTHER = 9;
const read = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8").replace(/\r\n/g, "\n");
const rows = (t: string) => h.db.rowsOf(t) as any[];
const caller = () => appRouter.createCaller({
  user: { id: 1, openId: "u", email: "o@example.com", name: "O", loginMethod: "password", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
  req: { protocol: "https", headers: { "x-workspace-id": String(WS) } },
  res: { clearCookie: () => {} },
} as unknown as TrpcContext);
const step = (id: number) => rows("are_execution_queue").find((s) => s.id === id);
const person = (id: number) => rows("prospect_queue").find((p) => p.id === id);

beforeEach(() => {
  h.db = makeSqlFakeDb({ roles: { [WS]: h.role }, wsId: () => WS });
  rows("are_campaigns").push(
    { id: 7, workspaceId: WS, name: "Counties", status: "active" },
    { id: 8, workspaceId: WS, name: "Cities", status: "active" },
    { id: 7, workspaceId: OTHER, name: "Theirs", status: "active" },
  );
  const p = (id: number, o: Record<string, unknown>) => rows("prospect_queue").push({ id, workspaceId: WS, campaignId: 7, firstName: "Pat", lastName: `P${id}`, ...o });
  p(1, { email: "one@example.com", sequenceStatus: "enrolled" });
  p(2, { email: "two@example.com", sequenceStatus: "pending" });
  p(3, { email: "three@example.com", sequenceStatus: "replied" });
  p(4, { email: "four@example.com", campaignId: 8, sequenceStatus: "enrolled" });
  rows("prospect_queue").push({ id: 5, workspaceId: OTHER, campaignId: 7, email: "five@example.com", sequenceStatus: "enrolled" });
  const s = (id: number, o: Record<string, unknown>) => rows("are_execution_queue").push({ id, workspaceId: WS, campaignId: 7, prospectQueueId: 1, stepIndex: 0, channel: "email", status: "scheduled", ...o });
  s(51, { status: "sent", stepIndex: 0 });
  s(52, { stepIndex: 1 });
  s(53, { stepIndex: 2, status: "paused" });
  s(54, { campaignId: 8, prospectQueueId: 4 });
  rows("are_execution_queue").push({ id: 55, workspaceId: OTHER, campaignId: 7, prospectQueueId: 5, stepIndex: 0, channel: "email", status: "scheduled" });
});

describe("deleting a campaign (A18)", () => {
  it("is refused for a rep", async () => {
    h.role = "rep";
    h.db = makeSqlFakeDb({ roles: { [WS]: "rep" }, wsId: () => WS });
    rows("are_campaigns").push({ id: 7, workspaceId: WS, name: "Counties", status: "active" });
    await expect(caller().are.campaigns.delete({ id: 7 })).rejects.toThrow();
    expect(rows("are_campaigns")).toHaveLength(1);
    h.role = "manager";
  });

  it("stops unsent steps, takes its people out, keeps sent history, and touches nothing else", async () => {
    const r = await caller().are.campaigns.delete({ id: 7 });
    expect(r).toEqual({ success: true, stepsStopped: 2, peopleReleased: 2 });
    expect(rows("are_campaigns").map((c) => `${c.workspaceId}:${c.id}`)).toEqual([`${WS}:8`, `${OTHER}:7`]);
    expect(step(51).status).toBe("sent");
    expect([step(52).status, step(53).status]).toEqual(["skipped", "skipped"]);
    expect(step(52).failureReason).toBe("Campaign deleted");
    expect(step(54).status).toBe("scheduled");
    expect(rows("are_execution_queue").find((x) => x.id === 55).status).toBe("scheduled");
    expect([person(1).sequenceStatus, person(2).sequenceStatus]).toEqual(["canceled", "canceled"]);
    expect(person(3).sequenceStatus).toBe("replied");
    expect(person(4).sequenceStatus).toBe("enrolled");
    expect(rows("prospect_queue").find((x) => x.id === 5).sequenceStatus).toBe("enrolled");
    const audit = rows("audit_log").find((a) => a.entityType === "are_campaign");
    expect(audit).toMatchObject({ workspaceId: WS, action: "delete", entityId: 7 });
  });

  it("frees its people's identities for another campaign, and only theirs", async () => {
    const before = await workspaceQueueIdentityIndex(WS);
    expect(existingClaim(before, { email: "one@example.com" })?.campaignId).toBe(7);
    await caller().are.campaigns.delete({ id: 7 });
    const after = await workspaceQueueIdentityIndex(WS);
    expect(existingClaim(after, { email: "one@example.com" })).toBeNull();
    expect(existingClaim(after, { email: "three@example.com" })).toBeNull();
    expect(existingClaim(after, { email: "four@example.com" })?.campaignId).toBe(8);
  });

  it("is one transaction: a failure part-way changes nothing", async () => {
    const real = h.db.delete;
    h.db.delete = () => { throw new Error("lost connection"); };
    await expect(caller().are.campaigns.delete({ id: 7 })).rejects.toThrow(/lost connection/);
    h.db.delete = real;
    expect(step(52).status).toBe("scheduled");
    expect(person(1).sequenceStatus).toBe("enrolled");
    expect(rows("are_campaigns")).toHaveLength(3);
  });

  it("the list offers Delete to managers only and says what it does", () => {
    const list = read("client/src/pages/usip/ARECampaigns.tsx");
    expect(list).toContain("const canDelete = rankOf(currentWs?.role ?? \"rep\") >= ROLE_RANK.manager;");
    expect(list).toContain("{canDelete && (");
    expect(list).not.toContain("The campaign and its prospect queue will be permanently deleted.");
    expect(list).toContain("so they can be added to another campaign");
  });
});

describe("Activate asks first (A52)", () => {
  const c = { name: "Counties", autonomyMode: "batch_approval", autoApproveThreshold: null, dailySendCap: 40 };

  it("says it starts sending, the cap, the window and the mode", () => {
    const msg = activateMessage(c, { sendWindowStartHour: 9, sendWindowEndHour: 17, sendWindowDays: [1, 2, 3, 4, 5], timezone: "America/New_York", outboundPausedAt: null });
    expect(msg).toContain("This starts real sending.");
    expect(msg).toContain("up to 40 a day for this campaign");
    expect(msg).toContain("America/New_York");
    expect(msg).toContain("only the people you approve are sequenced and sent");
    expect(msg).toContain("Nothing is sent while outbound is paused for the workspace.");
  });

  it("says when the workspace is paused right now, and describes Full Auto by its threshold", () => {
    expect(activateMessage(c, { outboundPausedAt: new Date().toISOString() })).toContain("Outbound is paused for this workspace right now, so nothing is sent until someone resumes it.");
    expect(activateMessage({ ...c, autonomyMode: "full", autoApproveThreshold: 75 }, undefined)).toContain("approve at or above 75, reject below");
    expect(activateMessage({ ...c, autonomyMode: "full" }, undefined)).toContain("nothing is approved automatically");
  });

  it("both Activate buttons go through the confirm before setStatus", () => {
    const detail = read("client/src/pages/usip/ARECampaignDetail.tsx");
    const list = read("client/src/pages/usip/ARECampaigns.tsx");
    expect(detail).toContain('onClick={() => confirmActivate(campaign, () => setStatus.mutate({ id: campaignId, status: "active" }))}');
    expect(list).toContain('onClick={() => confirmActivate(c, () => setStatus.mutate({ id: c.id, status: "active" }))}');
    expect(detail).not.toContain('onClick={() => setStatus.mutate({ id: campaignId, status: "active" })}');
    expect(list).not.toContain('onClick={() => setStatus.mutate({ id: c.id, status: "active" })}');
    // And each says it worked.
    for (const src of [detail, list]) expect(src).toContain("Campaign activated. The engine picks it up within 3 minutes.");
  });
});
