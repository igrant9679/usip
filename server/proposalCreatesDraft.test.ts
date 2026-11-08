/**
 * An accepted campaign proposal makes a DRAFT campaign (audit 2026-10-20,
 * A31). Accepting — by a person or by the Auto sweep — created an ACTIVE
 * campaign at once, so the first launch never asked for the workspace's time
 * zone and the campaign began running without anyone starting it. Now the
 * campaign waits for a person to activate it through campaigns.setStatus,
 * which asks for the zone on that first launch.
 *
 * Executed against the SQL-evaluating fake; the push into the campaign is
 * mocked (it is pinned by its own tests), so no enrichment or AI runs.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => ({ db: null as any, pushes: [] as Array<{ ws: number; campaignId: number; ids: number[] }> }));

vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));
vi.mock("./audit", async (a) => ({ ...(await a<typeof import("./audit")>()), recordAudit: async () => {} }));
vi.mock("./_core/activeMembers", async (a) => ({ ...(await a<typeof import("./_core/activeMembers")>()), workspaceNotifyUserId: async () => 7 }));
// At the Max Concurrent Campaigns limit: a draft must still be created, since
// drafts don't run. The old code held the proposal here instead.
vi.mock("./services/are/campaignConcurrency", async (a) => ({
  ...(await a<typeof import("./services/are/campaignConcurrency")>()),
  campaignHeadroom: async () => ({ hasRoom: false, active: 3, max: 3 }),
}));
vi.mock("./services/are/pushPeople", async (a) => ({
  ...(await a<typeof import("./services/are/pushPeople")>()),
  pushPeopleIntoCampaign: async (ws: number, campaignId: number, ids: number[]) => {
    h.pushes.push({ ws, campaignId, ids });
    return { added: ids.map((prospectId, i) => ({ prospectId, queueId: 100 + i })), skipped: [] };
  },
}));
vi.mock("./areEngine", async (a) => ({ ...(await a<typeof import("./areEngine")>()), runAreEngine: async () => ({}) }));

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { acceptProposal, runCampaignProposalsAllWorkspaces } from "./services/campaignProposals";
import { appRouter } from "./routers";

const WS = 2, ME = 20;
const rows = (t: string) => h.db.rowsOf(t) as any[];
const caller = () => appRouter.createCaller({
  user: { id: ME, openId: "u", email: "me@example.com", name: "Me", loginMethod: "password", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
  req: { protocol: "https", headers: { "x-workspace-id": String(WS) } },
  res: { clearCookie: () => {} },
} as unknown as TrpcContext);

const seedProposal = (over: Record<string, unknown> = {}) => {
  rows("campaign_proposals").push({
    id: 1, workspaceId: WS, status: "pending", source: "sweep", name: "Nonprofit CFOs (US)", description: "d", valueProposition: null,
    targeting: { targetTitles: ["CFO"] }, copyMode: "per_person", reasoning: null, clusterKey: "k", prospectIds: [11, 12, 13], size: 3,
    createdCampaignId: null, createdAt: new Date(), decidedAt: null, decidedBy: null, ...over,
  });
};

beforeEach(() => {
  h.db = makeSqlFakeDb({ roles: { [WS]: "admin" }, wsId: () => WS });
  h.pushes = [];
  // The workspace still has the UTC default zone: a first launch must ask.
  rows("workspace_settings").push({ id: 1, workspaceId: WS, timezone: "UTC", campaignRoutingMode: "auto" });
});

describe("accepting a proposal creates a draft campaign", () => {
  it("a person's accept makes a draft with no start time, and pushes the cluster into it", async () => {
    seedProposal();
    const r = await acceptProposal(WS, 1, ME);
    expect(r.campaignId).not.toBeNull();
    const [c] = rows("are_campaigns");
    expect(c.status).toBe("draft");
    expect(c.startedAt ?? null).toBeNull();
    expect(c.autonomyMode).toBe("batch_approval");
    expect(h.pushes).toEqual([{ ws: WS, campaignId: c.id, ids: [11, 12, 13] }]);
    expect(rows("campaign_proposals")[0]).toMatchObject({ status: "accepted", createdCampaignId: c.id });
  });

  it("the Auto sweep's accept makes a draft too, even at the concurrent-campaign limit", async () => {
    seedProposal();
    // The sweep accepts with no actor (runCampaignProposalsAllWorkspaces).
    expect(typeof runCampaignProposalsAllWorkspaces).toBe("function");
    expect(readFileSync(join(__dirname, "services", "campaignProposals.ts"), "utf8")).toContain("acceptProposal(ws.workspaceId, p.id, null)");
    const a = await acceptProposal(WS, 1, null);
    expect(a.campaignId).not.toBeNull();
    expect(rows("are_campaigns").map((c) => c.status)).toEqual(["draft"]);
    expect(rows("are_campaigns")[0].ownerUserId).toBe(7);
  });

  it("activating it is a first launch: refused while the zone is the UTC default, allowed once confirmed", async () => {
    seedProposal();
    const { campaignId } = await acceptProposal(WS, 1, ME);
    await expect(caller().are.campaigns.setStatus({ id: campaignId!, status: "active" })).rejects.toThrow(/time zone/i);
    expect(rows("are_campaigns")[0].status).toBe("draft");
  });
});

describe("the screens say draft", () => {
  const ROOT = join(__dirname, "..");
  const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");
  it("the proposal card's accept toast says it is a draft to activate, and opens it", () => {
    const src = read("client/src/components/usip/CampaignProposals.tsx");
    const i = src.indexOf("const decide = trpc.are.campaigns.decideProposal.useMutation(");
    const block = src.slice(i, src.indexOf("const generate =", i));
    expect(block).toContain("Draft campaign created");
    expect(block).toContain("Activate it to start");
    expect(block).toContain("navigate(`/are/campaigns/${r.campaignId}`)");
    expect(src).toContain('"Auto: draft campaigns are created for you to activate"');
  });
  it("the help article no longer promises an active campaign", () => {
    const help = read("server/seedHelpContent.ts");
    expect(help).toContain("creating one makes the campaign as a **draft** (batch approval)");
    expect(help).not.toContain("creating one makes the campaign (active, batch approval)");
  });
});
