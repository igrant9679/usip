/**
 * Products, quota targets and the missing confirmations (audit 2026-10-20,
 * batch Rc): R75 · R76 · R102.
 *
 *   R75 · a product on a deal or quote line can't be hard-deleted (archive
 *         it); products can be edited and restored; only a duplicate SKU
 *         reads "SKU already exists"; archived products leave new quotes
 *   R102 · Add refuses to overwrite a target; periods read as words; delete
 *         asks first
 *   R76 · the remaining one-click destructive controls ask first
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => ({ db: null as any, roles: {} as Record<number, string> }));

vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));
vi.mock("./audit", async (a) => ({ ...(await a<typeof import("./audit")>()), recordAudit: async () => {} }));

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { appRouter } from "./routers";
import { products } from "../drizzle/schema";
import { quotaPeriodLabel } from "@shared/quotaPeriod";
import { isDuplicateKeyError } from "./services/dbWriteError";

const WS = 2;
const CF = 4;
const ME = 21;
const ROOT = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");
function block(src: string, start: string, end: string): string {
  const i = src.indexOf(start);
  if (i < 0) throw new Error(`anchor not found: ${start}`);
  const j = src.indexOf(end, i + start.length);
  if (j < 0) throw new Error(`end anchor not found after ${start}: ${end}`);
  return src.slice(i, j + end.length);
}
const rows = (t: string) => h.db.rowsOf(t) as any[];

function caller(role = "manager") {
  h.roles[WS] = role;
  return appRouter.createCaller({
    user: { id: ME, openId: "u", email: "m@lsi.example", name: "Manager", loginMethod: "password", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
    req: { protocol: "https", headers: { "x-workspace-id": String(WS) } },
    res: { clearCookie: () => {} },
  } as unknown as TrpcContext);
}
async function refusal(p: Promise<unknown>): Promise<{ code: string; message: string }> {
  try { await p; } catch (e: any) { return { code: e.code, message: e.message }; }
  throw new Error("expected a refusal, but it resolved");
}

beforeEach(() => {
  h.roles = {};
  h.db = makeSqlFakeDb({ roles: h.roles, wsId: () => WS });
});

/* ── R75 ────────────────────────────────────────────────────────────────── */

describe("R75: a product in use is archived, not deleted", () => {
  beforeEach(() => {
    rows("products").push(
      { id: 1, workspaceId: WS, sku: "SEAT", name: "Seat", listPrice: "100.00", cost: "0", billingCycle: "annual", active: true },
      { id: 2, workspaceId: WS, sku: "TYPO", name: "Typo", listPrice: "1.00", cost: "0", billingCycle: "annual", active: true },
    );
  });

  it("refuses while a deal or quote line uses it, and says how many", async () => {
    rows("deal_line_items").push({ id: 10, workspaceId: WS, opportunityId: 5, productId: 1, quantity: 1, unitPrice: "100.00", discountPct: "0", lineTotal: "100.00" });
    rows("quote_line_items").push(
      { id: 20, workspaceId: WS, quoteId: 7, productId: 1, name: "Seat", quantity: 2, unitPrice: "100.00", discountPct: "0", lineTotal: "200.00" },
      { id: 21, workspaceId: WS, quoteId: 8, productId: 1, name: "Seat", quantity: 1, unitPrice: "100.00", discountPct: "0", lineTotal: "100.00" },
    );
    const r = await refusal(caller().products.delete({ id: 1 }));
    expect(r.code).toBe("CONFLICT");
    expect(r.message).toContain("1 deal line and 2 quote lines");
    expect(r.message).toMatch(/Archive it instead/);
    expect(rows("products").map((p) => p.id)).toEqual([1, 2]);
  });

  it("deletes a product nothing uses; another workspace's lines don't count", async () => {
    rows("quote_line_items").push({ id: 30, workspaceId: CF, quoteId: 9, productId: 2, name: "x", quantity: 1, unitPrice: "1", discountPct: "0", lineTotal: "1" });
    await caller().products.delete({ id: 2 });
    expect(rows("products").map((p) => p.id)).toEqual([1]);
  });

  it("archives and restores, and edits keep the product's lines", async () => {
    await caller().products.update({ id: 1, patch: { active: false } });
    expect(rows("products")[0].active).toBe(false);
    await caller().products.update({ id: 1, patch: { active: true, listPrice: 120, name: "Seat licence" } });
    expect(rows("products")[0]).toMatchObject({ active: true, listPrice: "120", name: "Seat licence" });
  });

  it("only a duplicate SKU reads as one", async () => {
    const dup = Object.assign(new Error("Failed query: insert into `products` …"), { cause: { code: "ER_DUP_ENTRY", errno: 1062, sqlMessage: "Duplicate entry '2-SEAT' for key 'uq_prod_sku'" } });
    const down = Object.assign(new Error("Failed query: insert into `products` …"), { cause: { code: "ECONNRESET", message: "read ECONNRESET" } });
    expect(isDuplicateKeyError(dup)).toBe(true);
    expect(isDuplicateKeyError(down)).toBe(false);
    const realInsert = h.db.insert.bind(h.db);
    let next: Error = dup;
    h.db.insert = (t: unknown) => (t === products ? { values: () => Promise.reject(next) } : realInsert(t));
    const input = { sku: "SEAT", name: "Seat", listPrice: 1, cost: 0, billingCycle: "annual" as const };
    expect(await refusal(caller().products.create(input))).toMatchObject({ code: "CONFLICT", message: "A product with this SKU already exists." });
    next = down;
    const r = await refusal(caller().products.create(input));
    expect(r.code).toBe("INTERNAL_SERVER_ERROR");
    expect(r.message).not.toMatch(/SKU/);
  });

  it("the page edits, archives and restores, and new quotes offer active products only", () => {
    const src = read("client/src/pages/usip/Products.tsx");
    expect(src).toContain("update.mutate({ id: editing.id, patch:");
    expect(src).toContain("setActive.mutate({ id: p.id, patch: { active: false } })");
    expect(src).toContain("setActive.mutate({ id: p.id, patch: { active: true } })");
    expect(src).not.toMatch(/pricing tiers/i);
    expect(read("client/src/pages/usip/Quotes.tsx")).toContain("(products.data ?? []).filter((p) => p.active || p.id === li.productId)");
  });
});

/* ── R102 ───────────────────────────────────────────────────────────────── */

describe("R102: quota Add doesn't overwrite, and periods read as words", () => {
  beforeEach(() => {
    rows("workspace_members").push({ id: 1, workspaceId: WS, userId: 30, role: "rep", deactivatedAt: null });
    rows("quota_targets").push({ id: 1, workspaceId: WS, userId: 30, period: "2026-Q4", periodType: "quarterly", revenueTarget: "50000", dealsTarget: 5, activitiesTarget: 100 });
  });

  it("Add refuses a person's second target for the same period; Edit replaces", async () => {
    const add = { userId: 30, period: "2026-11", periodType: "quarterly" as const, revenueTarget: 1, dealsTarget: 1, activitiesTarget: 1, onlyIfNew: true };
    const r = await refusal(caller().quota.set(add));
    expect(r).toMatchObject({ code: "CONFLICT" });
    expect(r.message).toContain("Q4 2026");
    expect(rows("quota_targets")[0].revenueTarget).toBe("50000");
    await caller().quota.set({ ...add, onlyIfNew: undefined, revenueTarget: 60000 });
    expect(rows("quota_targets")).toHaveLength(1);
    expect(rows("quota_targets")[0].revenueTarget).toBe("60000");
    // A different period is a new target.
    await caller().quota.set({ ...add, period: "2026-11", periodType: "monthly" });
    expect(rows("quota_targets").map((t) => t.period).sort()).toEqual(["2026-11", "2026-Q4"]);
  });

  it("labels", () => {
    expect(["2026-10", "2026-01", "2026-Q4", "2026-FY", "odd"].map(quotaPeriodLabel)).toEqual(["October 2026", "January 2026", "Q4 2026", "FY 2026", "odd"]);
  });

  it("the page sends Add as new-only, labels its periods and asks before a delete", () => {
    const src = read("client/src/pages/usip/Quota.tsx");
    expect(block(src, "function handleSave() {", "\n  }\n")).toContain("onlyIfNew: editTarget ? undefined : true");
    expect(src).toContain("<SelectItem key={p} value={p}>{quotaPeriodLabel(p)}</SelectItem>");
    expect(src).toContain("No quota targets set for {quotaPeriodLabel(period)}");
    const card = block(src, "function QuotaCard(", "\n}\n");
    expect(card).toContain(`<ConfirmButton ariaLabel="Delete quota"`);
    expect(card).not.toContain("onClick={onRemove}");
  });
});

/* ── R76 ────────────────────────────────────────────────────────────────── */

describe("R76: destructive one-click controls ask first", () => {
  it("territory and routing-rule deletes, with what points at the territory", () => {
    const src = read("client/src/pages/usip/Territories.tsx");
    expect(src).not.toMatch(/onClick=\{\(\) => (del|delRule)\.mutate/);
    expect(src).toContain(`<ConfirmButton ariaLabel="Delete territory"`);
    expect(src).toContain(`<ConfirmButton ariaLabel="Delete rule"`);
    expect(src).toContain("const ruleCount = (rules ?? []).filter((r: any) => r.territoryId === t.id).length;");
  });

  it("milestone delete and Regenerate Link on a proposal", () => {
    const src = read("client/src/pages/usip/ProposalDetail.tsx");
    expect(src).not.toContain("onClick={() => deleteMilestone.mutate(");
    expect(src).toContain("onConfirm={() => deleteMilestone.mutate({ proposalId: proposal.id, milestoneId: m.id })}");
    // Replacing an existing link asks; making the first one needn't.
    const existing = block(src, "{shareUrl ? (", "Regenerate Link");
    expect(existing).not.toContain("onClick={() => generateLink.mutate(");
    expect(existing).toContain("onConfirm={() => generateLink.mutate({ id: proposal.id })}");
  });

  it("already covered elsewhere: lead convert, company and person archive", () => {
    expect(read("client/src/pages/usip/Leads.tsx")).toContain("<ConvertLeadDialog");
    expect(read("client/src/pages/usip/CompanyProfile.tsx")).toMatch(/confirmAction\(\{ title: `Archive \$\{c\.name\}\?`/);
    expect(read("client/src/pages/usip/ProspectDetail.tsx")).toMatch(/confirmAction\(\{ title: `Archive \$\{fullName\}\?`/);
  });
});
