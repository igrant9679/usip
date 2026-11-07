/**
 * The smaller gains (audit 2026-10-20, F43, batch RESB), against the real
 * routers and the SQL fake. LinkedIn result paging is in
 * resbDiscoveryJob.test.ts, the accept-all skip on re-verify in
 * resbSpend.test.ts; this file has the rest.
 *
 *   capacity-aware routing   a rule may cap the open leads a target owns; a
 *                            full target is passed by, a rule whose targets
 *                            are all full falls through, and no cap routes
 *                            exactly as before
 *   score history pruning    rows older than 90 days go, daily, except each
 *                            subject's latest
 *   the contact merge        retired for the People merge on Data health
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => {
  if (!process.env.ENCRYPTION_KEY && !process.env.JWT_SECRET) process.env.ENCRYPTION_KEY = "e".repeat(64);
  return { db: null as any };
});
vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));
vi.mock("./audit", async (a) => ({ ...(await a<typeof import("./audit")>()), recordAudit: async () => {} }));
vi.mock("./services/policyNotify", async (a) => ({ ...(await a<typeof import("./services/policyNotify")>()), notifyIfEnabled: async () => {} }));
vi.mock("./sequenceEngine", async (a) => ({ ...(await a<typeof import("./sequenceEngine")>()), autoEnrollByTriggers: async () => {} }));

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { appRouter } from "./routers";
import { routeLeadOwner } from "./routers/leadScoring";
import { pickRoutingMatch, type RoutingRule } from "./leadScoring";
import { routingConditionsMatch } from "@shared/leadRouting";
import { SCORE_HISTORY_DAYS, pruneScoreHistory } from "./services/scoreHistoryRetention";

const read = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8").replace(/\r\n/g, "\n");
const rows = (t: string) => h.db.rowsOf(t) as any[];
const WS = 2;
const ADMIN = 20, A = 21, B = 22, C = 23;

beforeEach(() => {
  h.db = makeSqlFakeDb({ realMembers: true });
  rows("workspaces").push({ id: WS, name: "W", slug: "w", ownerUserId: ADMIN, archivedAt: null, plan: "trial" });
  const user = (id: number) => ({ id, openId: `local:${id}`, name: `User ${id}`, email: `u${id}@w.example`, loginMethod: "password", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() });
  rows("users").push(user(ADMIN), user(A), user(B), user(C));
  const member = (id: number, userId: number, role: string) => ({ id, workspaceId: WS, userId, role, deactivatedAt: null, lastActiveAt: new Date(), inviteToken: null, inviteExpiresAt: null, createdAt: new Date() });
  rows("workspace_members").push(member(1, ADMIN, "admin"), member(2, A, "rep"), member(3, B, "rep"), member(4, C, "rep"));
  rows("workspace_settings").push({ workspaceId: WS, llmMonthlyTokenCap: null });
});

const rr = (over: Partial<RoutingRule>): RoutingRule => ({ id: 1, enabled: true, priority: 10, conditions: { all: [] }, strategy: "round_robin", targetUserIds: [A, B, C], rrCursor: 0, ...over });

describe("capacity-aware routing (F43)", () => {
  it("round robin passes a full target, says how far the cursor moved, and with no cap ignores load", () => {
    const load = new Map([[A, 5], [B, 1], [C, 0]]);
    const loadOf = (u: number) => load.get(u) ?? 0;
    expect(pickRoutingMatch([rr({ capacityPerRep: 3 })], {}, routingConditionsMatch, undefined, loadOf))
      .toEqual({ ruleId: 1, ownerUserId: B, newCursor: 2, cursorStep: 2 });
    // No cap: exactly the old rotation, whatever the load.
    expect(pickRoutingMatch([rr({})], {}, routingConditionsMatch, undefined, loadOf))
      .toMatchObject({ ownerUserId: A, newCursor: 1, cursorStep: 1 });
    expect(pickRoutingMatch([rr({ capacityPerRep: null })], {}, routingConditionsMatch, undefined, loadOf)?.ownerUserId).toBe(A);
  });

  it("a rule whose targets are all full falls through to the next rule; a full direct target does too", () => {
    const loadOf = () => 9;
    const next: RoutingRule = { id: 2, enabled: true, priority: 20, conditions: { all: [] }, strategy: "direct", targetUserIds: [ADMIN], rrCursor: 0 };
    expect(pickRoutingMatch([rr({ capacityPerRep: 9 }), next], {}, routingConditionsMatch, undefined, (u) => (u === ADMIN ? 0 : loadOf())))
      .toMatchObject({ ruleId: 2, ownerUserId: ADMIN });
    const direct: RoutingRule = { id: 3, enabled: true, priority: 5, conditions: { all: [] }, strategy: "direct", targetUserIds: [A], rrCursor: 0, capacityPerRep: 2 };
    expect(pickRoutingMatch([direct, next], {}, routingConditionsMatch, undefined, (u) => (u === A ? 2 : 0))?.ruleId).toBe(2);
    expect(pickRoutingMatch([rr({ capacityPerRep: 9 })], {}, routingConditionsMatch, undefined, loadOf)).toBeNull();
  });

  it("routes a new lead past a rep at capacity, counting only their open leads, and moves the stored cursor past them", async () => {
    rows("lead_routing_rules").push({ id: 1, workspaceId: WS, name: "R", priority: 10, enabled: true, conditions: { all: [] }, strategy: "round_robin", targetUserIds: [A, B], rrCursor: 0, matchCount: 0, capacityPerRep: 2 });
    const lead = (id: number, owner: number, status: string, ws = WS) => rows("leads").push({ id, workspaceId: ws, ownerUserId: owner, status, firstName: "x", lastName: "y" });
    lead(1, A, "new"); lead(2, A, "working"); lead(3, A, "converted"); lead(4, A, "new", 4);
    expect(await routeLeadOwner(WS, { score: 0 })).toBe(B);
    expect(rows("lead_routing_rules")[0].rrCursor).toBe(2);
    // A closes a lead: under capacity again, A is next in the rotation.
    rows("leads").find((l) => l.id === 2).status = "unqualified";
    expect(await routeLeadOwner(WS, { score: 0 })).toBe(A);
  });

  it("the rule editor saves a capacity, and an edit without one leaves it", async () => {
    const admin = appRouter.createCaller({
      user: rows("users").find((u) => u.id === ADMIN),
      req: { protocol: "https", headers: { "x-workspace-id": String(WS) }, socket: { remoteAddress: "127.0.0.1" } },
      res: { clearCookie: () => {} },
    } as unknown as TrpcContext);
    const { id } = await admin.leadRouting.save({ name: "R", priority: 10, enabled: true, conditions: { all: [] }, strategy: "round_robin", targetUserIds: [A, B], capacityPerRep: 25 });
    expect(rows("lead_routing_rules").find((r) => r.id === id).capacityPerRep).toBe(25);
    await admin.leadRouting.save({ id, name: "R2", priority: 10, enabled: true, conditions: { all: [] }, strategy: "round_robin", targetUserIds: [A, B] });
    expect(rows("lead_routing_rules").find((r) => r.id === id)).toMatchObject({ name: "R2", capacityPerRep: 25 });
    await admin.leadRouting.save({ id, name: "R2", priority: 10, enabled: true, conditions: { all: [] }, strategy: "round_robin", targetUserIds: [A, B], capacityPerRep: null });
    expect(rows("lead_routing_rules").find((r) => r.id === id).capacityPerRep).toBeNull();
    const ui = read("client/src/pages/usip/LeadRouting.tsx");
    expect(ui).toContain('<Label htmlFor="rule-capacity">Most open leads per target (optional)</Label>');
    expect(ui).toContain("capacityPerRep: e.target.value === \"\" ? null :");
  });
});

describe("score history older than 90 days is pruned, keeping each subject's latest (F43)", () => {
  const NOW = new Date("2026-11-07T12:00:00Z");
  const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);

  it("lead score rows: old ones go when a newer row exists; a lead with only old rows keeps its newest", async () => {
    const lsh = (id: number, leadId: number, age: number, ws = WS) => rows("lead_score_history").push({ id, workspaceId: ws, leadId, firmographic: 1, behavioral: 1, aiFit: 1, total: 3, tier: "cold", computedAt: daysAgo(age) });
    lsh(1, 10, 200); lsh(2, 10, 120); lsh(3, 10, 10);     // lead 10: recent row → both old go
    lsh(4, 11, 300); lsh(5, 11, 95);                      // lead 11: only old → keep 5
    lsh(6, 12, 30);                                        // lead 12: recent only → untouched
    lsh(7, 13, 100, 4);                                    // another workspace, only row → kept
    const r = await pruneScoreHistory(NOW);
    expect(r.leadRows).toBe(3);
    expect(rows("lead_score_history").map((x) => x.id).sort((a, b) => a - b)).toEqual([3, 5, 6, 7]);
    // Run again: nothing more to do.
    expect((await pruneScoreHistory(NOW)).leadRows).toBe(0);
  });

  it("priority score change rows the same way, per model and object", async () => {
    const sh = (id: number, objectId: number, age: number, model = 1) => rows("score_history").push({ id, workspaceId: WS, scoreModelId: model, objectType: "person", objectId, newScore: "50", newRating: "good", changedAt: daysAgo(age) });
    sh(1, 50, 200); sh(2, 50, 5);          // recent exists → 1 goes
    sh(3, 51, 150); sh(4, 51, 100);        // only old → keep 4
    sh(5, 51, 120, 2);                     // same object, other model, only row → kept
    const r = await pruneScoreHistory(NOW);
    expect(r.priorityRows).toBe(2);
    expect(rows("score_history").map((x) => x.id).sort((a, b) => a - b)).toEqual([2, 4, 5]);
    expect(SCORE_HISTORY_DAYS).toBe(90);
  });

  it("runs from the daily retention tick, without a new timer", () => {
    const boot = read("server/_core/index.ts");
    const tick = boot.slice(boot.indexOf("const runLogRetention = () => {"), boot.indexOf("setInterval(runLogRetention, 24 * 60 * 60 * 1000);"));
    expect(tick).toContain('import("../services/scoreHistoryRetention")');
    expect(tick).toContain("m.pruneScoreHistory()");
  });
});

describe("the contact merge is retired for the People merge (F43)", () => {
  it("Data health no longer offers Merge on duplicate contacts; it points at the People merge", () => {
    const page = read("client/src/pages/usip/DataHealth.tsx");
    const section = page.slice(page.indexOf("Duplicate contacts\n          </h2>"), page.indexOf("<SplitPeopleSection canLinkAll={canLinkAll} />"));
    expect(section).not.toContain("onClick={() => setMergeGroup(group as DupeGroup)}");
    expect(section).toContain('href="#people-merge"');
    expect(section).toContain("Contacts are no longer merged here.");
    expect(page).toContain('<div id="people-merge" className="scroll-mt-4" />');
  });
});
