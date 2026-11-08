/**
 * Quotes folded into proposals (audit 2026-10-20, F34), with versioned
 * pricing (F36).
 *
 *   - a proposal's Pricing tab saves a NEW quote version each time; the one it
 *     replaces is kept, superseded, with its lines, viewable;
 *   - the proposal's price is the current version's total; the linked deal's
 *     value follows only when the person confirms it;
 *   - the client sees the current version's table on the portal, without the
 *     team's AI advice; accepting records that pricing as accepted;
 *   - existing quotes are attached once to their deal's newest proposal, or a
 *     new draft proposal, numbered by age (idempotent); a quote made through
 *     the API joins the same way;
 *   - /quotes redirects to /proposals through RetiredRedirect, fold first.
 *
 * Run against the SQL-evaluating fake; nothing is sent.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => {
  if (!process.env.ENCRYPTION_KEY && !process.env.JWT_SECRET) process.env.ENCRYPTION_KEY = "8".repeat(64);
  return { db: null as any };
});
vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));
vi.mock("./audit", async (a) => ({ ...(await a<typeof import("./audit")>()), recordAudit: async () => {} }));
vi.mock("./services/workflowEngine", async (a) => ({
  ...(await a<typeof import("./services/workflowEngine")>()),
  fireStageChanged: async () => {},
  fireRecordCreated: async () => {},
}));

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { appRouter } from "./routers";
import { invalidateStageIndex } from "./_core/stageSemantics";
import { foldQuotesIntoProposals } from "./services/quoteFold";
import { RETIRED_ROUTES } from "../client/src/lib/retiredRoutes";
import { dealValueQuestion } from "../client/src/components/usip/ProposalPricing";

const WS = 2, OTHER = 9, REP = 21;
const DAY = 86_400_000;
const root = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8").replace(/\r\n/g, "\n");
const rows = (t: string) => h.db.rowsOf(t) as any[];
const caller = (userId: number | null = REP) => appRouter.createCaller({
  user: userId == null ? null : rows("users").find((u) => u.id === userId),
  req: { protocol: "https", ip: "198.51.100.9", headers: { "x-workspace-id": String(WS) }, socket: { remoteAddress: "10.0.0.1" } },
  res: { clearCookie: () => {} },
} as unknown as TrpcContext);
const quote = (id: number, o: Record<string, unknown>) => rows("quotes").push({
  id, workspaceId: WS, opportunityId: 1, quoteNumber: `Q-${id}`, status: "draft", expiresAt: new Date(Date.now() + 30 * DAY),
  subtotal: "100.00", discountTotal: "0.00", taxTotal: "0.00", total: "100.00", notes: null, terms: null, createdByUserId: REP,
  proposalId: null, version: 1, supersededAt: null, aiPriceMin: null, createdAt: new Date(), ...o,
});
const proposal = (id: number, o: Record<string, unknown> = {}) => rows("proposals").push({
  id, workspaceId: WS, createdBy: REP, title: `Proposal ${id}`, clientName: "Acme", status: "draft", shareToken: `tok-${id}`,
  linkedOpportunityId: 1, accountId: 1, budget: null, expiresAt: null, acceptedAt: null, requirements: [], ...o,
});
const lines = [{ name: "Platform", quantity: 2, unitPrice: 1000, discountPct: 10 }, { name: "Onboarding", quantity: 1, unitPrice: 500, discountPct: 0 }];

beforeEach(() => {
  h.db = makeSqlFakeDb({ realMembers: true });
  invalidateStageIndex();
  rows("workspaces").push({ id: WS, name: "W", slug: "w", ownerUserId: REP, archivedAt: null, plan: "trial" }, { id: OTHER, name: "O", slug: "o", ownerUserId: 99, archivedAt: null, plan: "trial" });
  rows("users").push({ id: REP, openId: "u21", name: "Rep", email: "rep@example.com", loginMethod: "password", role: "user" });
  rows("workspace_members").push({ id: 1, workspaceId: WS, userId: REP, role: "manager", deactivatedAt: null, lastActiveAt: new Date(), inviteToken: null });
  rows("accounts").push({ id: 1, workspaceId: WS, name: "Acme Corp" }, { id: 2, workspaceId: WS, name: "Beta" });
  rows("crm_pipelines").push({ id: 1, workspaceId: WS, name: "Default", isDefault: true, sortOrder: 0 });
  rows("crm_pipeline_stages").push(
    { id: 11, workspaceId: WS, pipelineId: 1, key: "negotiation", label: "Negotiation", sortOrder: 10, defaultWinProb: 50, isWon: false, isLost: false },
    { id: 15, workspaceId: WS, pipelineId: 1, key: "won", label: "Won", sortOrder: 50, defaultWinProb: 100, isWon: true, isLost: false },
  );
  rows("opportunities").push(
    { id: 1, workspaceId: WS, accountId: 1, name: "Acme expansion", stage: "negotiation", value: "1000", winProb: 50, pipelineId: 1, ownerUserId: REP, stageEnteredAt: new Date() },
    { id: 2, workspaceId: WS, accountId: 2, name: "Beta pilot", stage: "negotiation", value: "300", winProb: 50, pipelineId: 1, ownerUserId: REP, stageEnteredAt: new Date() },
  );
});

describe("F34: existing quotes fold into proposals", () => {
  it("attaches each to its deal's newest proposal, numbers versions by age, and is idempotent", async () => {
    proposal(5);
    proposal(6);
    quote(1, { createdAt: new Date(Date.now() - 3 * DAY), total: "100.00" });
    quote(2, { createdAt: new Date(Date.now() - 1 * DAY), total: "150.00" });
    const r = await foldQuotesIntoProposals(h.db);
    expect(r).toEqual({ attached: 2, draftsCreated: 0, skipped: 0 });
    const q = (id: number) => rows("quotes").find((x) => x.id === id);
    expect([q(1).proposalId, q(1).version, !!q(1).supersededAt]).toEqual([6, 1, true]);
    expect([q(2).proposalId, q(2).version, q(2).supersededAt]).toEqual([6, 2, null]);
    expect(await foldQuotesIntoProposals(h.db)).toEqual({ attached: 0, draftsCreated: 0, skipped: 0 });
  });

  it("a deal with no proposal gets a draft one; a quote on a missing deal is left, and said", async () => {
    quote(1, { opportunityId: 2, total: "300.00" });
    quote(3, { opportunityId: 404 });
    rows("quotes").push({ id: 4, workspaceId: OTHER, opportunityId: 2, quoteNumber: "Q-x", status: "draft", total: "1", proposalId: null, version: 1, createdAt: new Date() });
    const r = await foldQuotesIntoProposals(h.db, { workspaceId: WS });
    expect(r).toEqual({ attached: 1, draftsCreated: 1, skipped: 1 });
    const draft = rows("proposals").find((p) => p.linkedOpportunityId === 2);
    expect(draft).toMatchObject({ workspaceId: WS, status: "draft", title: "Beta pilot — pricing", clientName: "Beta", accountId: 2, budget: "300.00", createdBy: REP });
    expect(rows("quotes").find((x) => x.id === 1).proposalId).toBe(draft.id);
    expect(rows("quotes").find((x) => x.id === 3).proposalId).toBeNull();
    expect(rows("quotes").find((x) => x.id === 4).proposalId).toBeNull();
  });

  it("a quote made through the API joins its deal's proposal at once", async () => {
    proposal(5);
    await caller().quotes.create({ opportunityId: 1, lineItems: [{ name: "Seat", quantity: 1, unitPrice: 10, discountPct: 0 }] });
    expect(rows("quotes")[0]).toMatchObject({ proposalId: 5, version: 1 });
  });
});

describe("F34/F36: the Pricing tab saves versions and asks before moving the deal", () => {
  beforeEach(() => proposal(5));
  const quotesOf = () => rows("quotes").filter((q) => q.proposalId === 5).sort((a, b) => a.version - b.version);

  it("version 1 sets the proposal's price and leaves the deal's value", async () => {
    const r = await caller().proposals.savePricing({ proposalId: 5, lineItems: lines, terms: "Net 30" });
    expect(r).toMatchObject({ version: 1, total: "2300.00", dealValueChanged: false });
    expect(rows("proposals")[0].budget).toBe("2300.00");
    expect(rows("opportunities")[0].value).toBe("1000");
    expect(rows("quote_line_items").filter((l) => l.quoteId === r.quoteId).map((l) => [l.name, l.lineTotal])).toEqual([["Platform", "1800.00"], ["Onboarding", "500.00"]]);
  });

  it("a change is a new version; the old one is kept, superseded, with its lines; the deal moves on a yes", async () => {
    const v1 = await caller().proposals.savePricing({ proposalId: 5, lineItems: lines });
    const v2 = await caller().proposals.savePricing({ proposalId: 5, lineItems: [{ name: "Platform", quantity: 3, unitPrice: 1000, discountPct: 0 }], setDealValue: true });
    expect(v2).toMatchObject({ version: 2, total: "3000.00", dealValueChanged: true });
    expect(quotesOf().map((q) => [q.version, q.total, !!q.supersededAt])).toEqual([[1, "2300.00", true], [2, "3000.00", false]]);
    expect(rows("quote_line_items").filter((l) => l.quoteId === v1.quoteId)).toHaveLength(2);
    expect(rows("opportunities")[0].value).toBe("3000.00");
    const p = await caller().proposals.pricing({ proposalId: 5 });
    expect(p.current).toMatchObject({ id: v2.quoteId, version: 2 });
    expect(p.versions.map((v) => v.version)).toEqual([2, 1]);
    expect(p.dealValue).toBe("3000.00");
    // An earlier version is still readable on its own.
    expect((await caller().quotes.get({ id: v1.quoteId }))!.lineItems).toHaveLength(2);
  });

  it("refuses an accepted proposal, one with no deal, and another workspace's product", async () => {
    rows("proposals")[0].status = "accepted";
    await expect(caller().proposals.savePricing({ proposalId: 5, lineItems: lines })).rejects.toThrow(/accepted/);
    rows("proposals")[0].status = "draft";
    rows("proposals")[0].linkedOpportunityId = null;
    await expect(caller().proposals.savePricing({ proposalId: 5, lineItems: lines })).rejects.toThrow(/Link this proposal to a deal/);
    rows("proposals")[0].linkedOpportunityId = 1;
    rows("products").push({ id: 70, workspaceId: OTHER, sku: "X", name: "Theirs", listPrice: "1", active: true });
    await expect(caller().proposals.savePricing({ proposalId: 5, lineItems: [{ productId: 70, name: "Theirs", quantity: 1, unitPrice: 1, discountPct: 0 }] })).rejects.toThrow(/not in this workspace/);
    expect(rows("quotes")).toEqual([]);
  });

  it("the page asks only when the deal's value would change", () => {
    expect(dealValueQuestion("1000", 230_000)).toEqual({ from: 1000, to: 2300 });
    expect(dealValueQuestion("2300.00", 230_000)).toBeNull();
    expect(dealValueQuestion(null, 230_000)).toBeNull();
    const src = read("client/src/components/usip/ProposalPricing.tsx");
    expect(src).toContain("if (q) setAsk(q); else submit(false);");
    expect(src).toContain("onClick={() => submit(true)}>Save and set the deal to");
    expect(src).toContain("onClick={() => submit(false)}>Save, keep the deal at");
    // The AI pricing advice came over from the Quotes page, and says what it spends first.
    expect(src).toContain('description: aiCallText(1, budgets.data?.ai, "over this pricing and up to 20 of your won deals")');
    expect(read("client/src/pages/usip/ProposalDetail.tsx")).toContain('<ProposalPricing proposalId={proposal.id} />');
  });
});

describe("F34: the client sees the pricing, and accepting records it", () => {
  beforeEach(() => proposal(5, { status: "sent" }));

  it("the portal gets the current version's table, not the team's AI advice", async () => {
    await caller().proposals.savePricing({ proposalId: 5, lineItems: lines, notes: "Annual billing" });
    rows("quotes")[0].aiPriceMin = "1.00";
    rows("quotes")[0].aiPriceRationale = "internal";
    const r = await caller(null).proposals.getByShareToken({ token: "tok-5" });
    expect(r.pricing).toMatchObject({ version: 1, total: "2300.00", notes: "Annual billing" });
    expect(r.pricing!.lineItems.map((l) => l.name)).toEqual(["Platform", "Onboarding"]);
    expect(JSON.stringify(r.pricing)).not.toMatch(/aiPrice|internal|opportunityId|createdByUserId/);
    expect(read("client/src/pages/ProposalPortal.tsx")).toContain('{key === "pricing" && pricing && <PortalPricingTable pricing={pricing} />}');
  });

  it("accepting on the portal records the current pricing as accepted and closes the deal at it", async () => {
    await caller().proposals.savePricing({ proposalId: 5, lineItems: lines });
    await caller().proposals.savePricing({ proposalId: 5, lineItems: [{ name: "Platform", quantity: 1, unitPrice: 900, discountPct: 0 }] });
    await caller(null).proposals.acceptByToken({ token: "tok-5", signerName: "Jane" });
    const qs = rows("quotes").sort((a, b) => a.version - b.version);
    expect(qs.map((q) => q.status)).toEqual(["draft", "accepted"]);
    expect(rows("opportunities")[0]).toMatchObject({ stage: "won", value: "900.00" });
  });

  it("deleting the proposal deletes its pricing versions", async () => {
    await caller().proposals.savePricing({ proposalId: 5, lineItems: lines });
    await caller().proposals.delete({ id: 5 });
    expect(rows("quotes")).toEqual([]);
    expect(rows("quote_line_items")).toEqual([]);
  });
});

describe("F34: /quotes redirects to proposals, fold first", () => {
  it("the route redirects through RetiredRedirect, and the page is gone", () => {
    expect(RETIRED_ROUTES["/quotes"]).toBe("/proposals");
    const app = read("client/src/App.tsx");
    expect(app).toContain('<Route path="/quotes"><AuthGate><RetiredRedirect from="/quotes" /></AuthGate></Route>');
    expect(app).not.toContain('@/pages/usip/Quotes"');
    expect(existsSync(join(root, "client/src/pages/usip/Quotes.tsx"))).toBe(false);
    expect(read("client/src/lib/toolRegistry.ts")).not.toContain('"/quotes"');
    expect(read("server/_core/rawMigrations.ts")).toContain("ALTER TABLE `quotes` ADD COLUMN `supersededAt` timestamp NULL");
    expect(read("server/_core/index.ts")).toContain("m.foldQuotesIntoProposals(db)");
  });
});
