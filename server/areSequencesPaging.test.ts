/**
 * The campaign Sequences tab pages, and its counts are the server's (audit
 * 2026-10-20, A44).
 *
 *   one page at a time, every row reachable · the status filter and the
 *   search run in SQL · the count on each filter is for every matching row,
 *   not the page · a dismissed row shows only if it has a sequence.
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
import { prospectIntelligence, prospectQueue } from "../drizzle/schema";

const WS = 2, OTHER = 9, CAMPAIGN = 21;
const T = (t: any) => h.db.rowsOf(getTableName(t)) as any[];
const caller = () => appRouter.createCaller({
  user: { id: 1, openId: "u", email: "o@example.com", name: "O", loginMethod: "password", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
  req: { protocol: "https", headers: { "x-workspace-id": String(WS) } },
  res: { clearCookie: () => {} },
} as unknown as TrpcContext);
const read = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8").replace(/\r\n/g, "\n");

beforeEach(() => {
  h.db = makeSqlFakeDb({ roles: { [WS]: "admin" }, wsId: () => WS });
  const q = (id: number, o: Record<string, unknown>) => T(prospectQueue).push({
    id, workspaceId: WS, campaignId: CAMPAIGN, firstName: `P${id}`, lastName: "Lane", email: `p${id}@example.com`, title: "Dean",
    companyName: "College", sequenceStatus: "pending", enrichmentStatus: "complete", personProspectId: null, ...o,
  });
  // 120 pending, 3 enrolled, 1 approved, a dismissed row with a sequence and one without.
  for (let i = 1; i <= 120; i++) q(i, {});
  q(201, { sequenceStatus: "enrolled", firstName: "Rosa", companyName: "Harbor" });
  q(202, { sequenceStatus: "enrolled" });
  q(203, { sequenceStatus: "enrolled" });
  q(204, { sequenceStatus: "approved" });
  q(205, { sequenceStatus: "skipped" });
  q(206, { sequenceStatus: "skipped" });
  q(207, { campaignId: 99, sequenceStatus: "enrolled" });
  q(208, { workspaceId: OTHER, sequenceStatus: "enrolled" });
  for (const id of [201, 202, 203, 205]) {
    T(prospectIntelligence).push({ id, workspaceId: WS, prospectQueueId: id, generatedSequence: [{ stepIndex: 0, subject: "Hi", body: "Hello" }], cadenceDayOffsets: null });
  }
});

describe("the Sequences tab pages (A44)", () => {
  it("counts every filter for the whole campaign and pages the rest", async () => {
    const page1 = await caller().are.prospects.listSequences({ campaignId: CAMPAIGN, status: "all", limit: 50 });
    expect(page1.countsByStatus).toEqual({ pending: 120, enrolled: 3, approved: 1, skipped: 1 });
    expect(page1.total).toBe(125);
    expect(page1.rows).toHaveLength(50);
    const page3 = await caller().are.prospects.listSequences({ campaignId: CAMPAIGN, status: "all", limit: 50, offset: 100 });
    expect(page3.rows).toHaveLength(25);
    // Every row is on exactly one page.
    const seen = new Set<number>();
    for (let off = 0; off < 125; off += 50) {
      for (const r of (await caller().are.prospects.listSequences({ campaignId: CAMPAIGN, status: "all", limit: 50, offset: off })).rows) seen.add(r.prospectId);
    }
    expect(seen.size).toBe(125);
    expect(seen.has(206)).toBe(false); // dismissed, nothing to show
    expect(seen.has(205)).toBe(true); // dismissed, but has a sequence
  });

  it("the filter and the search are the server's", async () => {
    const active = await caller().are.prospects.listSequences({ campaignId: CAMPAIGN, status: "enrolled" });
    expect(active.rows.map((r) => r.prospectId).sort()).toEqual([201, 202, 203]);
    expect(active.total).toBe(3);
    const rosa = await caller().are.prospects.listSequences({ campaignId: CAMPAIGN, status: "all", search: "rosa harbor" });
    expect(rosa.rows.map((r) => r.prospectId)).toEqual([201]);
    expect(rosa.countsByStatus).toEqual({ enrolled: 1 });
    await expect(caller().are.prospects.listSequences({ campaignId: CAMPAIGN, limit: 500 })).rejects.toThrow();
  });

  it("the tab reads its counts and pages from the response", () => {
    const page = read("client/src/pages/usip/ARECampaignDetail.tsx");
    const tab = page.slice(page.indexOf("function SequencesTab("), page.indexOf("/** Right-side drawer"));
    expect(tab.length).toBeGreaterThan(1000);
    expect(tab).toContain("{ campaignId, status: filter, ...(searchQ ? { search: searchQ } : {}), limit: SEQUENCE_PAGE, offset: (seqPage - 1) * SEQUENCE_PAGE }");
    expect(tab).toContain("const countsByStatus: Record<string, number> = seqData?.countsByStatus ?? {};");
    expect(tab).toContain("Math.ceil((seqData?.total ?? 0) / SEQUENCE_PAGE)");
    // No counting or filtering of the loaded rows on the client.
    expect(tab).not.toContain("rows.reduce((acc");
    expect(tab).not.toContain("rows.filter((r: any) => {");
  });
});
