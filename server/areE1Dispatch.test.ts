/**
 * The Revenue Engine's dispatch loop (audit 2026-10-20, batch E1).
 *
 *   A29 a tick that is already sending stops when the campaign or the workspace
 *       is paused, and stops when it cannot tell — the pause is read again,
 *       fresh, between sends, not once before the loop through a one-minute
 *       cache
 *   A13/A40 copy held for a research avoid rule is not sent, even when the hold
 *       arrived after the steps were scheduled
 *
 * The whole tick runs against the SQL-evaluating fake. The phases whose raw SQL
 * it can't evaluate log and move on, as they would on a database error; the
 * mail pool is mocked and records what it would have sent.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  if (!process.env.ENCRYPTION_KEY && !process.env.JWT_SECRET) process.env.ENCRYPTION_KEY = "b".repeat(64);
  return { db: null as any, sends: [] as string[], afterSend: null as null | ((n: number) => void) };
});

vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));
vi.mock("./routers/are/notify", async (a) => ({ ...(await a<typeof import("./routers/are/notify")>()), areNotify: async () => {} }));
// The window as the one-minute cache last saw it: open. A pause saved since is
// only visible to a fresh read.
vi.mock("./services/sendWindow", async (a) => ({ ...(await a<typeof import("./services/sendWindow")>()), inSendWindow: async () => true }));
vi.mock("./mergeVars", async (a) => ({ ...(await a<typeof import("./mergeVars")>()), resolveBookingUrl: async () => "" }));
vi.mock("./emailDelivery", async (a) => ({
  ...(await a<typeof import("./emailDelivery")>()),
  sendCampaignEmailViaPool: async (_ws: number, msg: any) => {
    h.sends.push(msg.to);
    h.afterSend?.(h.sends.length);
    return { ok: true, accountId: 1, fromEmail: "rep@lsi.example" };
  },
}));

import { getTableName } from "drizzle-orm";
import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { runAreEngine, __resetEngineLogRepeatsForTests } from "./areEngine";

const WS = 2;
const rows = (t: string) => h.db.rowsOf(t) as any[];
const steps = () => rows("are_execution_queue");
const logs = () => rows("are_engine_logs").map((l) => String(l.message));

beforeEach(() => {
  h.db = makeSqlFakeDb({ roles: { [WS]: "admin" }, wsId: () => WS });
  h.sends = [];
  h.afterSend = null;
  __resetEngineLogRepeatsForTests();
  rows("workspaces").push({ id: WS, name: "LSI", slug: "lsi", ownerUserId: 20, archivedAt: null, plan: "trial" });
  rows("workspace_settings").push({ workspaceId: WS, timezone: "UTC", outboundPausedAt: null, emailOpenTracking: false });
  rows("are_campaigns").push({
    id: 7, workspaceId: WS, name: "Counties", status: "active", ownerUserId: 20, autonomyMode: "batch_approval",
    channelsEnabled: { email: true }, targetProspectCount: 0, dailySendCap: 50, stepGapDays: 3, prospectSources: [],
    icpOverrides: {}, discoveryQueryState: null,
  });
  const due = new Date(Date.now() - 60_000);
  for (const id of [1, 2, 3]) {
    rows("prospect_queue").push({ id, workspaceId: WS, campaignId: 7, firstName: "Pat", lastName: `P${id}`, email: `p${id}@example.com`, sequenceStatus: "enrolled", enrichmentStatus: "complete" });
    rows("prospect_intelligence").push({ id: 100 + id, workspaceId: WS, prospectQueueId: id, copyHoldReason: null });
    steps().push({ id: 50 + id, workspaceId: WS, campaignId: 7, prospectQueueId: id, stepIndex: 0, channel: "email", status: "scheduled", scheduledAt: new Date(due.getTime() + id), messageContent: { subject: "Hello", body: "A short note." } });
  }
});

describe("a pause saved while a tick is sending (A29)", () => {
  it("the baseline: with nothing paused, all three go", async () => {
    await runAreEngine({ workspaceId: WS });
    expect(h.sends).toEqual(["p1@example.com", "p2@example.com", "p3@example.com"]);
  });

  it("stops at the workspace pause, and what is left stays scheduled", async () => {
    h.afterSend = (n) => { if (n === 1) rows("workspace_settings")[0].outboundPausedAt = new Date(); };
    await runAreEngine({ workspaceId: WS });
    expect(h.sends).toEqual(["p1@example.com"]);
    expect(steps().map((s) => s.status)).toEqual(["sent", "scheduled", "scheduled"]);
    expect(logs().join("\n")).toContain("Dispatch stopped part-way: outbound was paused for this workspace");
  });

  it("stops when the campaign is paused", async () => {
    h.afterSend = (n) => { if (n === 1) rows("are_campaigns")[0].status = "paused"; };
    await runAreEngine({ workspaceId: WS });
    expect(h.sends).toEqual(["p1@example.com"]);
    expect(logs().join("\n")).toContain("the campaign was set to paused");
  });

  it("stops when it cannot read the switches: unsure is not running", async () => {
    h.afterSend = (n) => {
      if (n !== 1) return;
      const real = h.db.select;
      h.db.select = (p?: Record<string, unknown>) => {
        const b = real(p);
        const from = b.from;
        b.from = (t: any) => { if (getTableName(t) === "are_campaigns") throw new Error("connection lost"); return from.call(b, t); };
        return b;
      };
    };
    await runAreEngine({ workspaceId: WS });
    expect(h.sends).toEqual(["p1@example.com"]);
    expect(logs().join("\n")).toContain("the pause switches could not be read");
  });
});

describe("copy held for an avoid rule (A13/A40)", () => {
  it("is not sent, and its step steps aside an hour instead of heading the page", async () => {
    rows("prospect_intelligence")[0].copyHoldReason = "Breaks your research's avoid rule \"Never promise savings\"";
    await runAreEngine({ workspaceId: WS });
    expect(h.sends).toEqual(["p2@example.com", "p3@example.com"]);
    const held = steps().find((s) => s.prospectQueueId === 1);
    expect(held.status).toBe("scheduled");
    expect(new Date(held.scheduledAt).getTime()).toBeGreaterThan(Date.now() + 59 * 60_000);
    expect(logs().join("\n")).toContain("1 due step was not sent: the prospect's copy breaks an avoid rule");
  });

  it("another workspace's hold on the same prospect id changes nothing here", async () => {
    rows("prospect_intelligence").push({ id: 999, workspaceId: 4, prospectQueueId: 1, copyHoldReason: "theirs" });
    await runAreEngine({ workspaceId: WS });
    expect(h.sends).toHaveLength(3);
  });
});
