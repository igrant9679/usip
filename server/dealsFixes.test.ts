/**
 * Deals, the deal page, the boards and the forecast (audit 2026-10-20, batch Ra).
 *
 *   R32 — deleting a deal deletes what its confirmation names, in one
 *         transaction, in this workspace only.
 *   R34 — a line item shows its product and its stored (discounted) total.
 *   R35 — line items and contact roles can be added and removed on the deal
 *         page; the procedures check every id against the workspace.
 *
 * Procedures run through the real router against the SQL-evaluating fake;
 * screens render with a stub trpc.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Router } from "wouter";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => {
  if (!process.env.ENCRYPTION_KEY && !process.env.JWT_SECRET) process.env.ENCRYPTION_KEY = "b".repeat(64);
  return { db: null as any, data: {} as Record<string, unknown> };
});
vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));
vi.mock("@/lib/trpc", () => {
  const noop: any = new Proxy(() => undefined, { get: () => noop, apply: () => undefined });
  const node = (path: string[]): any => new Proxy({}, {
    get(_t, key: string) {
      if (key === "useQuery") return () => ({ data: h.data[path.join(".")], isLoading: false, isError: false });
      if (key === "useMutation") return () => ({ mutate: () => {}, mutateAsync: async () => ({}), isPending: false });
      if (key === "useUtils") return () => noop;
      return node([...path, key]);
    },
  });
  return { trpc: node([]) };
});

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { appRouter } from "./routers";
import { invalidateStageIndex } from "./_core/stageSemantics";
import { _clearWorkspaceTimezoneCache } from "./services/workspaceTimezone";
import { OPPORTUNITY_DELETE_SCOPE } from "@shared/dealDelete";
import { DealContactRoles, DealLineItems } from "../client/src/pages/usip/OpportunityDetail";

const WS = 2, OTHER = 9, ME = 1, REP = 3, MANAGER = 4;
const root = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8").replace(/\r\n/g, "\n");
const rows = (t: string) => h.db.rowsOf(t) as any[];
const caller = (userId = ME, ws = WS) => appRouter.createCaller({
  user: { id: userId, openId: `u${userId}`, email: `u${userId}@example.com`, name: `U${userId}`, loginMethod: "password", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
  req: { protocol: "https", headers: { "x-workspace-id": String(ws) } },
  res: { clearCookie: () => {} },
} as unknown as TrpcContext);
const page = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(createElement(Router, { ssrPath: "/opportunities/1" }, el));
const member = (id: number, userId: number, role: string, ws = WS) =>
  ({ id, workspaceId: ws, userId, role, deactivatedAt: null, inviteToken: null, lastActiveAt: new Date() });
const deal = (id: number, o: Record<string, unknown> = {}) => rows("opportunities").push({
  id, workspaceId: WS, accountId: 1, name: `Deal ${id}`, stage: "discovery", value: "10000", winProb: 20,
  closeDate: null, pipelineId: 1, daysInStage: 0, stageEnteredAt: new Date(), ownerUserId: ME, ...o,
});

beforeEach(() => {
  h.db = makeSqlFakeDb({ realMembers: true });
  h.data = {};
  invalidateStageIndex();
  _clearWorkspaceTimezoneCache();
  rows("workspaces").push(
    { id: WS, name: "W", slug: "w", ownerUserId: ME, archivedAt: null, plan: "trial" },
    { id: OTHER, name: "O", slug: "o", ownerUserId: ME, archivedAt: null, plan: "trial" },
  );
  rows("users").push({ id: ME, name: "Me" }, { id: REP, name: "Rep" }, { id: MANAGER, name: "Manager" });
  rows("workspace_members").push(member(1, ME, "admin"), member(2, REP, "rep"), member(3, MANAGER, "manager"), member(4, ME, "admin", OTHER));
  rows("crm_pipelines").push({ id: 1, workspaceId: WS, name: "Default", isDefault: true, sortOrder: 0 });
  rows("crm_pipeline_stages").push(
    { id: 11, workspaceId: WS, pipelineId: 1, key: "discovery", label: "Discovery", sortOrder: 10, defaultWinProb: 20, isWon: false, isLost: false },
    { id: 12, workspaceId: WS, pipelineId: 1, key: "negotiation", label: "Negotiation", sortOrder: 20, defaultWinProb: 75, isWon: false, isLost: false },
    { id: 15, workspaceId: WS, pipelineId: 1, key: "signed", label: "Signed", sortOrder: 50, defaultWinProb: 100, isWon: true, isLost: false },
  );
  rows("accounts").push({ id: 1, workspaceId: WS, name: "Acme" }, { id: 2, workspaceId: OTHER, name: "Theirs" });
});

/* ── R32 ───────────────────────────────────────────────────────────────── */

describe("R32: deleting a deal deletes what the confirmation names", () => {
  const CHILDREN = ["deal_line_items", "opportunity_contact_roles", "opportunity_stage_history", "opportunity_intelligence", "stage_approvals", "pipeline_alerts"];
  beforeEach(() => {
    deal(1);
    deal(2);
    for (const opp of [1, 2]) {
      for (const t of CHILDREN) rows(t).push({ id: opp * 10, workspaceId: WS, opportunityId: opp });
      rows("quotes").push({ id: opp * 10, workspaceId: WS, opportunityId: opp });
      rows("quote_line_items").push({ id: opp * 10, quoteId: opp * 10 });
    }
    // Another workspace's rows that name the same deal id are not this one's.
    for (const t of CHILDREN) rows(t).push({ id: 99, workspaceId: OTHER, opportunityId: 1 });
  });

  it("the deal, its line items, roles, quotes, history and alerts go; the next deal's and another workspace's stay", async () => {
    await caller().opportunities.delete({ id: 1 });
    expect(rows("opportunities").map((o) => o.id)).toEqual([2]);
    for (const t of CHILDREN) {
      expect(rows(t).map((r) => `${r.workspaceId}:${r.opportunityId}`).sort(), t).toEqual([`${WS}:2`, `${OTHER}:1`]);
    }
    expect(rows("quotes").map((q) => q.opportunityId)).toEqual([2]);
    expect(rows("quote_line_items").map((q) => q.quoteId)).toEqual([20]);
    expect(h.db.txLog.committed).toBe(1);
  });

  it("one transaction: a failure part-way leaves the deal and all of its rows", async () => {
    // The fifth delete is the stage history's: quote lines, quotes, line items
    // and roles are already gone when it fails.
    const real = h.db.delete;
    let n = 0;
    h.db.delete = (t: any) => ({ where: (c: unknown) => { if (++n === 5) throw new Error("boom"); return real(t).where(c); } });
    await expect(caller().opportunities.delete({ id: 1 })).rejects.toThrow("boom");
    expect(rows("opportunities").map((o) => o.id)).toEqual([1, 2]);
    for (const t of CHILDREN) expect(rows(t).filter((r) => r.workspaceId === WS && r.opportunityId === 1), t).toHaveLength(1);
    expect(h.db.txLog.rolledBack).toBe(1);
  });

  it("another workspace's deal is not found, and nothing is touched", async () => {
    rows("opportunities").push({ id: 7, workspaceId: OTHER, accountId: 2, name: "Theirs", stage: "discovery", value: "1" });
    await expect(caller().opportunities.delete({ id: 7 })).rejects.toThrow(/not found/i);
    expect(rows("opportunities").map((o) => o.id)).toEqual([1, 2, 7]);
  });

  it("both confirmations name exactly what is deleted", () => {
    expect(OPPORTUNITY_DELETE_SCOPE).toBe("along with its line items, contact roles, quotes, stage history and alerts");
    expect(read("client/src/pages/usip/OpportunityDetail.tsx")).toContain("will be permanently deleted, ${OPPORTUNITY_DELETE_SCOPE}.");
    expect(read("client/src/components/usip/RecordDrawer.tsx")).toContain("will be permanently deleted, ${OPPORTUNITY_DELETE_SCOPE}.");
  });
});

/* ── R34, R35 ──────────────────────────────────────────────────────────── */

describe("R34: a line shows its product and its stored total", () => {
  it("the product's name, the discount, and the line total the server stored", async () => {
    deal(1);
    rows("products").push({ id: 4, workspaceId: WS, sku: "SEAT", name: "Seat licence", listPrice: "100", active: true });
    await caller().opportunities.addLineItem({ opportunityId: 1, productId: 4, quantity: 3, unitPrice: 100, discountPct: 10 });
    const items = await caller().opportunities.listLineItems({ opportunityId: 1 });
    expect(items[0]).toMatchObject({ lineTotal: "270.00", product: { name: "Seat licence" } });
    const html = page(createElement(DealLineItems, { opportunityId: 1, items, onChanged: () => {} }));
    expect(html).toContain("Seat licence");
    expect(html).toContain("$270.00");
    expect(html).toContain("− 10%");
    expect(html).not.toContain("Item #");
    expect(html).not.toContain("$300");
  });

  it("a line whose product was deleted says so instead of a bare id", () => {
    const html = page(createElement(DealLineItems, {
      opportunityId: 1, onChanged: () => {},
      items: [{ id: 1, productId: 8, product: null, quantity: 1, unitPrice: "5.00", discountPct: "0", lineTotal: "5.00" }],
    }));
    expect(html).toContain("Product #8 (removed)");
  });
});

describe("R35: the deal page adds and removes line items and contact roles", () => {
  it("offers a product picker and an add form, and a remove on each line", () => {
    h.data["products.list"] = [{ id: 4, name: "Seat licence", sku: "SEAT", listPrice: "100", active: true }, { id: 5, name: "Old", active: false }];
    const html = page(createElement(DealLineItems, {
      opportunityId: 1, onChanged: () => {},
      items: [{ id: 1, productId: 4, product: { name: "Seat licence" }, quantity: 1, unitPrice: "100", discountPct: "0", lineTotal: "100.00" }],
    }));
    expect(html).toContain('aria-label="Product"');
    expect(html).toContain("Seat licence (SEAT)");
    expect(html).not.toContain(">Old<");
    expect(html).toContain("Add line");
    expect(html).toContain('aria-label="Remove Seat licence"');
  });

  it("offers the account's contacts and the role list", () => {
    h.data["accounts.getWithContacts"] = { account: { id: 1 }, contacts: [{ id: 30, firstName: "Ada", lastName: "Lovelace", title: "CTO" }] };
    const html = page(createElement(DealContactRoles, {
      opportunityId: 1, accountId: 1, accountName: "Acme", onChanged: () => {},
      roles: [{ id: 2, contactId: 30, role: "decision_maker", isPrimary: true, contact: { id: 30, firstName: "Ada", lastName: "Lovelace" } }],
    }));
    expect(html).toContain("Ada Lovelace — CTO");
    expect(html).toContain("decision maker");
    expect(html).toContain("Add role");
    expect(html).toContain('aria-label="Remove this contact role"');
  });

  it("the page calls all four procedures", () => {
    const page = read("client/src/pages/usip/OpportunityDetail.tsx");
    for (const p of ["addLineItem", "removeLineItem", "addRole", "removeRole"]) expect(page).toContain(`trpc.opportunities.${p}.useMutation(`);
  });

  it("a role names this workspace's deal and contact; a line, this workspace's product", async () => {
    deal(1);
    rows("opportunities").push({ id: 7, workspaceId: OTHER, accountId: 2, name: "Theirs", stage: "discovery", value: "1" });
    rows("contacts").push({ id: 30, workspaceId: WS, accountId: 1, firstName: "Ada", lastName: "L" }, { id: 31, workspaceId: OTHER, accountId: 2, firstName: "Eve", lastName: "X" });
    rows("products").push({ id: 4, workspaceId: WS, sku: "S", name: "Seat", listPrice: "1", active: true }, { id: 5, workspaceId: OTHER, sku: "T", name: "Theirs", listPrice: "1", active: true });
    await caller().opportunities.addRole({ opportunityId: 1, contactId: 30, role: "champion" });
    await expect(caller().opportunities.addRole({ opportunityId: 1, contactId: 31, role: "champion" })).rejects.toThrow(/not in this workspace/);
    await expect(caller().opportunities.addRole({ opportunityId: 7, contactId: 30, role: "champion" })).rejects.toThrow(/not found/i);
    await expect(caller().opportunities.addLineItem({ opportunityId: 1, productId: 5, quantity: 1, unitPrice: 1 })).rejects.toThrow(/Product not found/);
    expect(rows("opportunity_contact_roles").map((r) => `${r.opportunityId}:${r.contactId}`)).toEqual(["1:30"]);
    expect(rows("deal_line_items")).toEqual([]);
  });

  it("removing a line removes it from its own deal only", async () => {
    deal(1);
    deal(2);
    rows("deal_line_items").push({ id: 1, workspaceId: WS, opportunityId: 2, productId: 4, quantity: 1, unitPrice: "5", discountPct: "0", lineTotal: "5" });
    await caller().opportunities.removeLineItem({ id: 1, opportunityId: 1 });
    expect(rows("deal_line_items").map((r) => r.id)).toEqual([1]);
  });
});
