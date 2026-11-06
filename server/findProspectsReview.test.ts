/**
 * The Needs Review queue can decide, and reaches everyone it counts (audit
 * 2026-10-20, P17).
 *
 * It listed people with no Approve or Archive anywhere but a person page that
 * offered only Archive, and it stopped at the first 50 while its heading
 * counted all of them. `prospects.review` decides one person or a selection;
 * the queue pages; the person page can approve.
 *
 * The router runs against the in-memory database; the screens are pinned by
 * source, as the rest of Find prospects is.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => {
  if (!process.env.ENCRYPTION_KEY && !process.env.JWT_SECRET) process.env.ENCRYPTION_KEY = "d".repeat(64);
  return { db: null as any };
});
vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { appRouter } from "./routers";

const WS = 2;
const read = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8").replace(/\r\n/g, "\n");
const rows = (t: string) => h.db.rowsOf(t) as any[];
const person = (id: number) => rows("prospects").find((p) => p.id === id);
const caller = () => appRouter.createCaller({
  user: { id: 7, openId: "u", email: "rep@example.com", name: "R", loginMethod: "password", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
  req: { protocol: "https", headers: { "x-workspace-id": String(WS) } },
  res: { clearCookie: () => {} },
} as unknown as TrpcContext);

beforeEach(() => {
  h.db = makeSqlFakeDb({ roles: { [WS]: "rep" }, wsId: () => WS });
  rows("workspaces").push({ id: WS, name: "LSI", slug: "lsi", ownerUserId: 1, archivedAt: null, plan: "trial" });
  const p = (id: number, verificationStatus: string, workspaceId = WS) =>
    rows("prospects").push({ id, workspaceId, firstName: "P", lastName: String(id), verificationStatus, verificationSetBy: null, verificationSetByUserId: null, verificationSetAt: null });
  p(1, "needs_review"); p(2, "needs_review"); p(3, "verified"); p(4, "needs_review", 99);
});

describe("prospects.review", () => {
  it("approves a selection, as a human, and says what it did", async () => {
    const r = await caller().prospects.review({ ids: [1, 2], decision: "verified" });
    expect(r).toEqual({ updated: 2, skipped: 0 });
    expect(person(1)).toMatchObject({ verificationStatus: "verified", verificationSetBy: "human", verificationSetByUserId: 7 });
    expect(person(2).verificationStatus).toBe("verified");
    expect(rows("audit_log").at(-1)).toMatchObject({ entityType: "prospect_review", after: { decision: "verified", ids: [1, 2] } });
  });

  it("archives one person", async () => {
    await caller().prospects.review({ ids: [1], decision: "rejected" });
    expect(person(1).verificationStatus).toBe("rejected");
    expect(person(2).verificationStatus).toBe("needs_review");
  });

  it("leaves alone a person decided elsewhere since the list loaded, and another workspace's", async () => {
    const r = await caller().prospects.review({ ids: [3, 4, 1], decision: "rejected" });
    expect(r).toEqual({ updated: 1, skipped: 2 });
    expect(person(3).verificationStatus).toBe("verified");
    expect(person(4).verificationStatus).toBe("needs_review");
  });
});

describe("the screens", () => {
  const page = read("client/src/pages/usip/FindProspects.tsx");
  const queue = page.slice(page.indexOf("function ProspectQueue("));

  it("the queue pages through everything it counts", () => {
    expect(queue.length).toBeGreaterThan(0);
    expect(queue).toContain("trpc.prospects.list.useQuery({ verificationStatus: status, perPage: QUEUE_PAGE_SIZE, page });");
    expect(queue).not.toContain("page: 1 })");
    expect(queue).toContain("onClick={() => { setPage(page + 1); setSelected(new Set()); }}>Next</Button>");
    expect(queue).toContain("`${first}–${last} of ${data.total}`");
  });

  it("each row and a selection can be approved or archived", () => {
    expect(queue).toContain('onClick={() => decide([p.id], "verified")}');
    expect(queue).toContain('onClick={() => decide([p.id], "rejected")}');
    expect(queue).toContain('onClick={() => decide(chosen, "verified")}');
    expect(queue).toContain('}, () => decide(chosen, "rejected"))}>');
    expect(queue).toContain("const review = trpc.prospects.review.useMutation({");
  });

  it("the person page can approve someone awaiting review", () => {
    const detail = read("client/src/pages/usip/ProspectDetail.tsx");
    expect(detail).toContain('{p.verificationStatus === "needs_review" && (');
    expect(detail).toContain('approve.mutate({ ids: [id], decision: "verified" })');
  });
});
