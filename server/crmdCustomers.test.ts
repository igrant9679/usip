/**
 * Customers you can find, the company as a customer, and renewal or churn in
 * one step (audit 2026-10-20, U26 and F36).
 *
 *   U26  the Customers table searches, sorts and pages on the server; the
 *        company page shows the customer's stored health and ARR;
 *   F36  "Record renewal or churn": a renewal sets the new term and its ARR,
 *        a churn the day and the reason; both write the customer row and an
 *        amendment, and ARR — summed once, in services/dealMetrics — follows;
 *   U26  the Prospects-table half is moot: /prospects redirects to People.
 *
 * Procedures run through the real router against the SQL-evaluating fake.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => {
  if (!process.env.ENCRYPTION_KEY && !process.env.JWT_SECRET) process.env.ENCRYPTION_KEY = "a".repeat(64);
  return { db: null as any };
});
vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));
vi.mock("./audit", async (a) => ({ ...(await a<typeof import("./audit")>()), recordAudit: async () => {} }));

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { appRouter } from "./routers";
import { _clearWorkspaceTimezoneCache } from "./services/workspaceTimezone";
import { customerArrTotals } from "./services/dealMetrics";
import { RETIRED_ROUTES } from "../client/src/lib/retiredRoutes";
import { defaultRenewalTerm } from "../client/src/components/usip/RecordRenewalOrChurn";

const WS = 2, OTHER = 9, ME = 1;
const DAY = 86_400_000;
const root = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8").replace(/\r\n/g, "\n");
const rows = (t: string) => h.db.rowsOf(t) as any[];
const cust = (id: number) => rows("customers").find((c) => c.id === id);
const caller = () => appRouter.createCaller({
  user: { id: ME, openId: "u1", email: "u1@example.com", name: "U1", loginMethod: "password", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
  req: { protocol: "https", headers: { "x-workspace-id": String(WS) } },
  res: { clearCookie: () => {} },
} as unknown as TrpcContext);
const customer = (id: number, accountId: number, o: Record<string, unknown> = {}) => rows("customers").push({
  id, workspaceId: WS, accountId, arr: "1000.00", contractStart: new Date(Date.now() - 200 * DAY), contractEnd: new Date(Date.now() + 165 * DAY),
  tier: "midmarket", healthScore: 50, healthTier: "watch", usageScore: 50, engagementScore: 50, supportScore: 50, npsScore: 0,
  renewalStage: "early", churnedAt: null, churnReason: null, expansionPotential: "0", ...o,
});

beforeEach(() => {
  h.db = makeSqlFakeDb({ realMembers: true });
  _clearWorkspaceTimezoneCache();
  rows("workspaces").push({ id: WS, name: "W", slug: "w", ownerUserId: ME, archivedAt: null, plan: "trial" });
  rows("users").push({ id: ME, name: "Me" });
  rows("workspace_members").push({ id: 1, workspaceId: WS, userId: ME, role: "rep", deactivatedAt: null, inviteToken: null, lastActiveAt: new Date() });
  rows("accounts").push(
    { id: 11, workspaceId: WS, name: "Acme Corp" },
    { id: 12, workspaceId: WS, name: "Beta Industries" },
    { id: 13, workspaceId: WS, name: "Acme Labs" },
    { id: 99, workspaceId: OTHER, name: "Acme Foreign" },
  );
  customer(1, 11, { arr: "5000.00", healthScore: 80, npsScore: 30 });
  customer(2, 12, { arr: "2000.00", healthScore: 30, npsScore: -10 });
  customer(3, 13, { arr: "9000.00", healthScore: 55, npsScore: 10 });
  // Another workspace's customer never shows.
  rows("customers").push({ id: 4, workspaceId: OTHER, accountId: 99, arr: "1.00", healthScore: 1, renewalStage: "early", contractEnd: null });
});

describe("U26: the Customers table searches, sorts and pages on the server", () => {
  it("searches the company name, in this workspace only", async () => {
    const r = await caller().cs.search({ q: "acme" });
    expect(r.total).toBe(2);
    expect(r.rows.map((c: any) => c.account?.name).sort()).toEqual(["Acme Corp", "Acme Labs"]);
  });

  it("sorts by any column, either way, and pages", async () => {
    expect((await caller().cs.search({ sort: "arr", dir: "desc" })).rows.map((c: any) => c.id)).toEqual([3, 1, 2]);
    expect((await caller().cs.search({ sort: "name", dir: "asc" })).rows.map((c: any) => c.id)).toEqual([1, 3, 2]);
    expect((await caller().cs.search({ sort: "health", dir: "asc" })).rows.map((c: any) => c.id)).toEqual([2, 3, 1]);
    for (let i = 5; i < 17; i++) { rows("accounts").push({ id: 100 + i, workspaceId: WS, name: `Co ${i}` }); customer(i, 100 + i, { arr: "1.00" }); }
    const p1 = await caller().cs.search({ sort: "arr", dir: "asc", page: 1, pageSize: 10 });
    const p2 = await caller().cs.search({ sort: "arr", dir: "asc", page: 2, pageSize: 10 });
    expect(p1.total).toBe(15);
    expect(p1.rows).toHaveLength(10);
    expect(p2.rows).toHaveLength(5);
    expect(new Set([...p1.rows, ...p2.rows].map((c: any) => c.id)).size).toBe(15);
  });

  it("the page reads the server's pages, with sortable headers and a search box", () => {
    const page = read("client/src/pages/usip/Customers.tsx");
    expect(page).toContain("trpc.cs.search.useQuery({ q: query || undefined, sort, dir, page, pageSize: PAGE_SIZE })");
    expect(page).not.toContain("trpc.cs.list.useQuery()");
    expect(page).toContain('aria-label="Search customers"');
    expect(page).toContain('{header("arr", "ARR", "right")}');
    expect(page).toContain("aria-sort={sort === s ?");
    expect(page).toContain("onClick={() => setPage(page + 1)}>Next</Button>");
  });
});

describe("U26: the company page shows the customer's health and ARR", () => {
  it("cs.forAccount returns the stored health and ARR, or nothing for a non-customer", async () => {
    const r = await caller().cs.forAccount({ accountId: 11 });
    expect(r).toMatchObject({ id: 1, healthScore: 80, healthTier: "watch", activeArr: 5000 });
    expect(await caller().cs.forAccount({ accountId: 404 })).toBeNull();
    expect(await caller().cs.forAccount({ accountId: 99 })).toBeNull();
  });

  it("the profile renders the card, with Record renewal or churn", () => {
    const page = read("client/src/pages/usip/CompanyProfile.tsx");
    expect(page).toContain("<CustomerHealthCard accountId={id} accountName={c.name} />");
    const card = page.slice(page.indexOf("export function CustomerHealthCard("), page.indexOf("function Detail("));
    expect(card).toContain("trpc.cs.forAccount.useQuery({ accountId }");
    expect(card).toContain('label="Health score" value={`${cust.healthScore} / 100`}');
    expect(card).toContain("formatAmount(cust.activeArr)");
    expect(card).toContain("<RecordRenewalOrChurn customer={cust} accountName={accountName} />");
  });
});

describe("F36: Record renewal or churn", () => {
  it("a renewal sets the new term and ARR, records the change, and ARR follows", async () => {
    const before = (await caller().cs.kpis())!.arr;
    expect(before).toBe(16000);
    const end = new Date(Date.now() + 530 * DAY).toISOString().slice(0, 10);
    const r = await caller().cs.recordRenewal({ customerId: 2, newArr: 2600, termEnd: end });
    expect(r.arrDelta).toBe(600);
    expect(cust(2)).toMatchObject({ arr: "2600" });
    expect(new Date(cust(2).contractEnd).toISOString().slice(0, 10)).toBe(end);
    // The new term starts where the old one ended.
    expect(new Date(cust(2).contractStart).getTime()).toBeGreaterThan(Date.now() + 160 * DAY);
    expect(rows("contract_amendments")).toEqual([expect.objectContaining({ customerId: 2, type: "renewal", arrDelta: "600" })]);
    expect((await caller().cs.kpis())!.arr).toBe(16600);
  });

  it("a churn sets the day and reason, takes the ARR out, and counts it as churned this quarter", async () => {
    const today = new Date().toISOString().slice(0, 10);
    await caller().cs.recordChurn({ customerId: 3, churnedOn: today, reason: "  Switched to a competitor " });
    expect(cust(3)).toMatchObject({ renewalStage: "churned", churnReason: "Switched to a competitor", arr: "9000.00" });
    expect(cust(3).churnedAt).toBeTruthy();
    expect(rows("contract_amendments")).toEqual([expect.objectContaining({ customerId: 3, type: "termination", arrDelta: "-9000" })]);
    const k = (await caller().cs.kpis())!;
    expect(k).toMatchObject({ arr: 7000, total: 2, churnedArrThisQuarter: 9000, churnedThisQuarter: 1 });
    await expect(caller().cs.recordChurn({ customerId: 3, churnedOn: today, reason: "again" })).rejects.toThrow(/already recorded as churned/);
    // A renewal brings them back and clears the churn.
    await caller().cs.recordRenewal({ customerId: 3, newArr: 8000, termStart: today, termEnd: new Date(Date.now() + 365 * DAY).toISOString().slice(0, 10) });
    expect(cust(3)).toMatchObject({ churnedAt: null, churnReason: null });
    expect(cust(3).renewalStage).not.toBe("churned");
  });

  it("refuses a term that ends before it starts, a blank reason, and another workspace's customer", async () => {
    await expect(caller().cs.recordRenewal({ customerId: 1, newArr: 1, termStart: "2027-01-10", termEnd: "2027-01-05" })).rejects.toThrow(/end after it starts/);
    await expect(caller().cs.recordChurn({ customerId: 1, churnedOn: "2026-11-01", reason: "   " })).rejects.toThrow();
    await expect(caller().cs.recordChurn({ customerId: 4, churnedOn: "2026-11-01", reason: "x" })).rejects.toThrow(/not found/i);
    expect(rows("contract_amendments")).toEqual([]);
  });

  it("ARR is summed in the deal-and-revenue module, churned customers apart", () => {
    const t = customerArrTotals([
      { arr: "100.10", renewalStage: "early", contractEnd: null },
      { arr: "0.20", renewalStage: "early", contractEnd: null },
      { arr: "50", renewalStage: "churned", contractEnd: null, churnedAt: new Date() },
    ]);
    expect(t).toEqual({ arr: 100.3, customers: 2, churnedArr: 50, churned: 1 });
    expect(read("server/routers/cs.ts")).toContain("const revenue = customerArrTotals(all, { range: quarter });");
  });

  it("the button is on the Renewals cards, the Customers panel and the company page, defaulting to the same term again", () => {
    expect(read("client/src/pages/usip/Renewals.tsx")).toContain('<RecordRenewalOrChurn customer={c} accountName={c.account?.name ?? null} size="xs" className="mt-1.5" />');
    expect(read("client/src/pages/usip/Customers.tsx")).toContain("<RecordRenewalOrChurn customer={detail.data} accountName={detail.data.account?.name ?? null} />");
    const term = defaultRenewalTerm({ contractStart: "2025-12-01T12:00:00Z", contractEnd: "2026-12-01T12:00:00Z" });
    expect(term).toEqual({ start: "2026-12-01", end: "2027-12-01" });
    expect(read("server/_core/rawMigrations.ts")).toContain("ALTER TABLE `customers` ADD COLUMN `churnReason` varchar(200) NULL");
  });
});

describe("U26: the Prospects table half is moot", () => {
  it("/prospects redirects to People, which searches and sorts", () => {
    expect(RETIRED_ROUTES["/prospects"]).toBe("/v2/people");
  });
});
