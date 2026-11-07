/**
 * Lead routing, the rest of the 2026-10-20 audit (batch Pb), against the real
 * router and the SQL fake:
 *
 *   P13 rules on Score see the score a lead is created with · P41 Geography
 *   and Industry take the territory rule's owner · P42 typed conditions ·
 *   P43 two leads routed at once go round the rotation · P115 leavers are
 *   neither offered nor counted · P124 one reorder at a time, in order, and
 *   strategy names · P126 an "Any" group survives an edit.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => {
  if (!process.env.ENCRYPTION_KEY && !process.env.JWT_SECRET) process.env.ENCRYPTION_KEY = "e".repeat(64);
  return { db: null as any, failUpdateAt: 0, updates: 0 };
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
import { evalConditions } from "./routers/operations";
import { routingConditionsMatch } from "@shared/leadRouting";
import { conditionsForSave, editableConditions, pickableMembers, ruleStatus } from "../client/src/lib/routingRuleView";

const read = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8").replace(/\r\n/g, "\n");
const rows = (t: string) => h.db.rowsOf(t) as any[];

const WS = 2;
const ADMIN = 20, REP = 21, REP_B = 22, LEFT = 23;

function seed() {
  rows("workspaces").push({ id: WS, name: "Pb Test", slug: "pb", ownerUserId: ADMIN, archivedAt: null, plan: "trial" });
  const user = (id: number) => ({
    id, openId: `local:${id}`, name: `User ${id}`, email: `u${id}@pb.example`, loginMethod: "password", role: "user",
    passwordHash: `hash-${id}`, createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date(), emailSignature: null,
  });
  rows("users").push(user(ADMIN), user(REP), user(REP_B), user(LEFT));
  const member = (id: number, userId: number, role: string, deactivatedAt: Date | null = null) => ({
    id, workspaceId: WS, userId, role, title: null, quota: null, deactivatedAt, lastActiveAt: new Date(),
    inviteToken: null, inviteExpiresAt: null, createdAt: new Date(),
  });
  rows("workspace_members").push(
    member(1, ADMIN, "admin"), member(2, REP, "rep"), member(3, REP_B, "rep"), member(4, LEFT, "rep", new Date("2026-10-01T00:00:00Z")),
  );
  rows("workspace_settings").push({ workspaceId: WS, llmMonthlyTokenCap: null });
}

function caller(userId: number) {
  const user = rows("users").find((u) => u.id === userId);
  return appRouter.createCaller({
    user,
    req: { protocol: "https", headers: { "x-workspace-id": String(WS) }, socket: { remoteAddress: "127.0.0.1" } },
    res: { clearCookie: () => {} },
  } as unknown as TrpcContext);
}

function rule(id: number, over: Record<string, unknown> = {}) {
  const row = {
    id, workspaceId: WS, name: `Rule ${id}`, priority: id * 10, enabled: true, conditions: { all: [] },
    strategy: "direct", targetUserIds: [REP], rrCursor: 0, matchCount: 0, lastMatchedAt: null, ...over,
  };
  rows("lead_routing_rules").push(row);
  return row;
}

async function refusal(p: Promise<unknown>): Promise<{ code: string; message: string }> {
  try { await p; } catch (e: any) { return { code: e.code, message: e.message }; }
  throw new Error("expected a refusal, but it resolved");
}

beforeEach(() => {
  h.failUpdateAt = 0;
  h.updates = 0;
  h.db = makeSqlFakeDb({
    realMembers: true,
    beforeUpdate: (table) => {
      if (table !== "lead_routing_rules") return;
      h.updates++;
      if (h.failUpdateAt && h.updates === h.failUpdateAt) throw new Error("simulated write failure");
    },
  });
  seed();
});

/* ── P42: typed conditions ──────────────────────────────────────────────── */

describe("routing conditions are typed (P42)", () => {
  it("text compares ignore case, and Score compares as a number whatever the editor stored", () => {
    const lead = { source: "webform", title: "VP Sales", score: 75 };
    expect(routingConditionsMatch({ all: [{ field: "source", op: "eq", value: "Webform" }] }, lead)).toBe(true);
    expect(routingConditionsMatch({ all: [{ field: "score", op: "eq", value: "75" }] }, lead)).toBe(true);
    expect(routingConditionsMatch({ all: [{ field: "score", op: "gte", value: "80" }] }, lead)).toBe(false);
    expect(routingConditionsMatch({ all: [{ field: "score", op: "neq", value: "75" }] }, lead)).toBe(false);
    // A missing score matches no comparison, not even "not equal".
    expect(routingConditionsMatch({ all: [{ field: "score", op: "neq", value: 10 }] }, { source: "x" })).toBe(false);
    // The workflow evaluator, which routing used, got all three wrong. Its
    // strings stay exact, so the case-insensitive match is still routing's own.
    expect(evalConditions({ all: [{ field: "source", op: "eq", value: "Webform" }] }, lead)).toBe(false);
    // 2026-11-06 (audit G61): the workflow evaluator now compares a typed number
    // with a numeric field as numbers too, so this line flipped. Routing keeps
    // its own typed evaluator above, which is what this test protects.
    expect(evalConditions({ all: [{ field: "score", op: "eq", value: "75" }] }, lead)).toBe(true);
  });

  it("a blank value can't be saved; one saved before is left out instead of matching every lead", async () => {
    const admin = caller(ADMIN);
    const base = { name: "R", priority: 10, enabled: true, strategy: "direct" as const, targetUserIds: [REP] };
    expect(await refusal(admin.leadRouting.save({ ...base, conditions: { all: [{ field: "title", op: "contains", value: "" }] } })))
      .toEqual({ code: "BAD_REQUEST", message: "Title needs a value; a blank one would match every lead." });
    expect((await refusal(admin.leadRouting.save({ ...base, conditions: { all: [{ field: "score", op: "gte", value: "high" }] } }))).message)
      .toBe("Score needs a number.");
    expect((await refusal(admin.leadRouting.save({ ...base, conditions: { any: [{ field: "title", op: "gt", value: "5" }] } }))).message)
      .toBe('Title can\'t use "gt".');
    expect(rows("lead_routing_rules")).toHaveLength(0);
    // A legacy blank beside a real condition: the real one decides.
    const legacy = { all: [{ field: "title", op: "contains", value: "" }, { field: "source", op: "eq", value: "webform" }] };
    expect(routingConditionsMatch(legacy, { title: "CFO", source: "chat" })).toBe(false);
    expect(routingConditionsMatch(legacy, { title: "CFO", source: "webform" })).toBe(true);
  });

  it("the router evaluates with them", async () => {
    rule(1, { conditions: { all: [{ field: "source", op: "eq", value: "Webform" }] }, targetUserIds: [REP_B] });
    expect(await routeLeadOwner(WS, { source: "webform", score: 0 })).toBe(REP_B);
  });

  it("the editor offers the operators the field takes", () => {
    const page = read("client/src/pages/usip/LeadRouting.tsx");
    expect(page).toContain("const ops = ROUTING_OPS[type];");
    expect(page).toContain('type={type === "number" ? "number" : "text"}');
    expect(page).toContain("disabled={save.isPending || !draft.name.trim() || !!problem}");
  });
});

/* ── P13: Score at creation ─────────────────────────────────────────────── */

describe("a rule on Score can match (P13)", () => {
  it("a lead is routed on the score it is created with", async () => {
    rule(1, { conditions: { all: [{ field: "score", op: "gte", value: 30 }] }, targetUserIds: [REP_B] });
    const strong = await caller(REP).leads.create({ firstName: "Testa", lastName: "Strong", title: "CEO", company: "County Works", email: "s@county.example", phone: "555 0100" });
    expect(strong.ownerUserId).toBe(REP_B);
    expect(strong.routed).toBe(true);
    const weak = await caller(REP).leads.create({ firstName: "Testa", lastName: "Weak" });
    expect(weak.ownerUserId).toBe(REP);
    // The stored score is the one routing saw.
    expect(rows("leads").find((l) => l.id === strong.id).score).toBeGreaterThanOrEqual(30);
  });

  it("the public entry points pass that score too", () => {
    for (const f of ["server/routers/forms.ts", "server/routers/landingPages.ts", "server/routers/chatAgents.ts", "server/routers/crm.ts"]) {
      const src = read(f);
      expect(src, f).toContain("createTimeScore(");
      expect(src, f).not.toMatch(/routeLeadOwner\([^)]*score: 0/);
      expect(src, f).toMatch(/rescoreLead\(/);
    }
  });
});

/* ── P41: Geography and Industry ────────────────────────────────────────── */

describe("Geography and Industry rules take the territory rule's owner (P41)", () => {
  const territoryRule = (id: number, over: Record<string, unknown>) => rows("crm_territory_rules").push({
    id, workspaceId: WS, name: `T${id}`, priority: 100, industry: null, country: null, state: null, companyContains: null,
    territoryId: null, ownerUserId: REP_B, active: true, ...over,
  });

  beforeEach(() => {
    rows("accounts").push({ id: 1, workspaceId: WS, name: "Acme", industry: "SaaS", region: "US" });
  });

  it("a Geography rule assigns the owner of the territory rule for the lead's country", async () => {
    rule(1, { strategy: "geography", targetUserIds: [REP] });
    territoryRule(1, { industry: "SaaS", ownerUserId: ADMIN }); // not a geography rule
    territoryRule(2, { country: "us", ownerUserId: REP_B });
    expect(await routeLeadOwner(WS, { company: "Acme", score: 0 })).toBe(REP_B);
  });

  it("an Industry rule uses territory rules that name an industry", async () => {
    rule(1, { strategy: "industry", targetUserIds: [REP] });
    territoryRule(1, { country: "US", ownerUserId: ADMIN }); // not an industry rule
    territoryRule(2, { industry: "saas", ownerUserId: REP_B });
    expect(await routeLeadOwner(WS, { company: "Acme", score: 0 })).toBe(REP_B);
  });

  it("with no match, or a territory owner who has left, the first target", async () => {
    rule(1, { strategy: "geography", targetUserIds: [REP] });
    territoryRule(1, { country: "DE" });
    territoryRule(2, { country: "US", ownerUserId: LEFT });
    expect(await routeLeadOwner(WS, { company: "Acme", score: 0 })).toBe(REP);
  });

  it("the strategy picker says what each one does", () => {
    const page = read("client/src/pages/usip/LeadRouting.tsx");
    expect(page).toContain("the owner of the matching territory rule by country or state, else the first target");
  });
});

/* ── P43: the round-robin cursor ────────────────────────────────────────── */

describe("two leads routed at once go to two reps (P43)", () => {
  it("the cursor is claimed, so the second route reads it again", async () => {
    rule(1, { strategy: "round_robin", targetUserIds: [REP, REP_B] });
    const owners = await Promise.all([routeLeadOwner(WS, { score: 0 }), routeLeadOwner(WS, { score: 0 })]);
    expect(owners.sort()).toEqual([REP, REP_B].sort());
    const r = rows("lead_routing_rules")[0];
    expect(r.rrCursor).toBe(2);
    expect(r.matchCount).toBe(2);
    expect(await routeLeadOwner(WS, { score: 0 })).toBe(REP);
  });
});

/* ── P124: reorder, order and names ─────────────────────────────────────── */

describe("reordering is one write, rules tie by age, and strategies read as words (P124)", () => {
  it("a reorder is all or nothing", async () => {
    rule(1); rule(2); rule(3);
    await caller(ADMIN).leadRouting.reorder({ orderedIds: [3, 1, 2] });
    expect(rows("lead_routing_rules").map((r) => [r.id, r.priority])).toEqual([[1, 20], [2, 30], [3, 10]]);
    h.updates = 0;
    h.failUpdateAt = 2;
    await expect(caller(ADMIN).leadRouting.reorder({ orderedIds: [2, 3, 1] })).rejects.toThrow();
    // The first row's write was rolled back with the rest.
    expect(rows("lead_routing_rules").map((r) => [r.id, r.priority])).toEqual([[1, 20], [2, 30], [3, 10]]);
  });

  it("rules with the same priority run oldest first, whatever order they are read in", () => {
    const r = (id: number): RoutingRule => ({ id, enabled: true, priority: 10, conditions: {}, strategy: "direct", targetUserIds: [id * 100], rrCursor: 0 });
    expect(pickRoutingMatch([r(9), r(4)], {}, () => true)!.ruleId).toBe(4);
  });

  it("the list shows its position and the strategy's name, and one reorder at a time", () => {
    const page = read("client/src/pages/usip/LeadRouting.tsx");
    expect(page).toContain("{ROUTING_STRATEGY_LABEL[r.strategy] ?? r.strategy}");
    expect(page).not.toContain("priority {r.priority}");
    expect(page).not.toContain('aria-label="Priority"');
    expect(page).toContain("disabled={i === 0 || reordering}");
  });
});

/* ── P115, P126: the page's view of a rule ──────────────────────────────── */

describe("the rule list and editor (P115, P126)", () => {
  const members = [
    { id: REP, name: "Rep", email: null, deactivatedAt: null },
    { id: LEFT, name: "Gone", email: null, deactivatedAt: new Date("2026-10-01T00:00:00Z") },
  ];

  it("a rule whose targets have all left doesn't read Active, and leavers aren't offered (P115)", () => {
    expect(ruleStatus({ enabled: true, strategy: "round_robin", targetUserIds: [LEFT] }, members)).toBe("no_active_targets");
    expect(ruleStatus({ enabled: true, strategy: "geography", targetUserIds: [LEFT] }, members)).toBe("territory_only");
    expect(ruleStatus({ enabled: true, strategy: "direct", targetUserIds: [LEFT, REP] }, members)).toBe("active");
    expect(ruleStatus({ enabled: false, strategy: "direct", targetUserIds: [REP] }, members)).toBe("disabled");
    expect(pickableMembers(members, []).map((m) => m.id)).toEqual([REP]);
    // Still ticked on this rule: listed so it can be unticked.
    expect(pickableMembers(members, [LEFT]).map((m) => m.id)).toEqual([REP, LEFT]);
    expect(read("server/db.ts")).toContain("deactivatedAt: workspaceMembers.deactivatedAt,");
    const page = read("client/src/pages/usip/LeadRouting.tsx");
    expect(page).toContain("ruleStatus({ enabled: r.enabled, strategy: r.strategy, targetUserIds: targets }, memberList)");
    expect(page).toContain("const pickable = pickableMembers(members, draft.targetUserIds);");
  });

  it("editing keeps an Any group, and the oldest array form opens as All (P126)", () => {
    const stored = { all: [{ field: "title", op: "contains", value: "vp" }], any: [{ field: "source", op: "eq", value: "chat" }] };
    const draft = editableConditions(stored);
    draft.all = [...draft.all, { field: "score", op: "gte", value: 30 }];
    expect(conditionsForSave(draft)).toEqual({ all: [stored.all[0], { field: "score", op: "gte", value: 30 }], any: stored.any });
    expect(editableConditions([{ field: "title", op: "eq", value: "cfo" }])).toEqual({ all: [{ field: "title", op: "eq", value: "cfo" }], any: [] });
    const page = read("client/src/pages/usip/LeadRouting.tsx");
    expect(page).toContain("conditions: { ...draft.conditions, [g]: next }");
    expect(page).toContain("conditions: conditionsForSave(draft.conditions)");
    expect(page).toContain("conditions: editableConditions(r.conditions),");
  });
});
