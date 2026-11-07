/**
 * The Revenue Engine hub (tracker 11; audit 2026-10-20, A61).
 *
 *   Refresh reloads every panel, not just the campaign list, and says so ·
 *   the signal numbers count every signal, not the 30 the feed loaded ·
 *   completed campaigns are not listed as drafts · Live Signals sits beside
 *   the campaigns instead of under the two full-width sections.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getTableName } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => {
  if (!process.env.ENCRYPTION_KEY && !process.env.JWT_SECRET) process.env.ENCRYPTION_KEY = "b".repeat(64);
  return { db: null as any };
});
vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { appRouter } from "./routers";
import { areSignalLog } from "../drizzle/schema";
import { groupHubCampaigns, refreshHub } from "../client/src/pages/usip/areHubModel";

const WS = 2, OTHER = 9;
const read = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8").replace(/\r\n/g, "\n");
const hub = read("client/src/pages/usip/AREHub.tsx");
const caller = () => appRouter.createCaller({
  user: { id: 1, openId: "u", email: "o@example.com", name: "O", loginMethod: "password", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
  req: { protocol: "https", headers: { "x-workspace-id": String(WS) } },
  res: { clearCookie: () => {} },
} as unknown as TrpcContext);

beforeEach(() => {
  h.db = makeSqlFakeDb({ roles: { [WS]: "rep" }, wsId: () => WS });
});

describe("Refresh reloads the whole hub (tracker 11)", () => {
  it("invalidates every are.* query and the approval count", async () => {
    const calls: string[] = [];
    await refreshHub({
      are: { invalidate: async () => { calls.push("are"); } },
      attention: { summary: { invalidate: async () => { calls.push("attention.summary"); } } },
    });
    expect(calls.sort()).toEqual(["are", "attention.summary"]);
  });

  it("the button runs it, shows it running, and says when it is done", () => {
    expect(hub).toContain("<Button variant=\"outline\" size=\"sm\" onClick={onRefresh} disabled={refreshing}");
    expect(hub).toContain("await refreshHub(utils);");
    expect(hub).toContain('toast.success("Revenue Engine refreshed");');
    // The old button refetched the campaign list alone.
    expect(hub).not.toContain("onClick={() => refetch()}");
  });
});

describe("the hub's signal numbers count every signal (A61)", () => {
  beforeEach(() => {
    const s = (id: number, o: Record<string, unknown>) => h.db.rowsOf(getTableName(areSignalLog)).push({
      id, workspaceId: WS, campaignId: 1, prospectQueueId: id, signalType: "email_reply", sentiment: "neutral", processedAt: new Date(), ...o,
    });
    for (let i = 1; i <= 35; i++) s(i, { sentiment: "positive" });
    for (let i = 36; i <= 70; i++) s(i, {});
    s(71, { signalType: "meeting_booked", sentiment: "positive" });
    s(72, { signalType: "meeting_booked" });
    s(73, { workspaceId: OTHER, sentiment: "positive" });
  });

  it("positive and meetings are the workspace's, past the 30 the feed shows", async () => {
    expect(await caller().are.execution.signalSummary()).toEqual({ total: 72, positive: 36, meetings: 2 });
  });

  it("the page reads them from the summary, not from the loaded feed", () => {
    expect(hub).toContain("const positiveSignals = signalSummary?.positive ?? 0;");
    expect(hub).toContain("const meetingSignals = signalSummary?.meetings ?? 0;");
    expect(hub).not.toMatch(/\(signals \?\? \[\]\)\.filter\(\(s\) => s\.sentiment === "positive"\)/);
  });
});

describe("campaign groups and layout (A61)", () => {
  it("completed campaigns have their own group, not Draft's", () => {
    const g = groupHubCampaigns([{ id: 1, status: "active" }, { id: 2, status: "paused" }, { id: 3, status: "completed" }, { id: 4, status: "draft" }]);
    expect(g.completed.map((c) => c.id)).toEqual([3]);
    expect(g.draft.map((c) => c.id)).toEqual([4]);
    expect(hub).toContain("Completed ({completedCampaigns.length})");
  });

  it("Live Signals comes straight after the campaigns, before the full-width proposals", () => {
    const between = hub.slice(hub.indexOf('data-tour-id="are-active-campaigns"'), hub.indexOf("<CampaignProposals />"));
    expect(between.length).toBeGreaterThan(1000);
    expect(between).toContain('data-tour-id="are-signal-feed"');
  });
});
