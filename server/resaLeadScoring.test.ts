/**
 * Lead scoring and routing, the audit's final pass (2026-11-07, batch RESA),
 * against the real routers and the SQL fake:
 *
 *   U17 the Lead Scoring page's what-if runs the server's own scoring math in
 *       the browser (shared/leadScoreMath), from facts the server sends once,
 *       with a tier histogram, an unsaved marker and Reset to defaults ·
 *   U32 the stored AI fit's pains, products and objection risks in the
 *       breakdown ·
 *   F41 each lead says when it was last scored; routing has a "Test a lead"
 *       dry run that changes nothing. (Any/All groups and typed fields were
 *       built by Pb in 60124df0 and 81c5934e; leadRoutingGaps.test.ts pins them.)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => {
  if (!process.env.ENCRYPTION_KEY && !process.env.JWT_SECRET) process.env.ENCRYPTION_KEY = "f".repeat(64);
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
import * as serverMath from "./leadScoring";
import * as sharedMath from "@shared/leadScoreMath";
import { routeLeadOwner, WHAT_IF_SAMPLE } from "./routers/leadScoring";
import { scoredAgo } from "../client/src/lib/leadScoreText";
import { unsavedFields, weightsOf } from "../client/src/pages/usip/LeadScoring";
import { TEST_VERDICT_LABEL, testLeadInput } from "../client/src/pages/usip/LeadRouting";

const { componentsWhatIf, DEFAULT_SCORE_CONFIG, firmoFacts, scoreFirmoFacts, scoreFirmographic, tierHistogram, tierMoves } = sharedMath;

const read = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8").replace(/\r\n/g, "\n");
const rows = (t: string) => h.db.rowsOf(t) as any[];
/** The text from `start` to the first `end` after it; fails when `start` is missing. */
const block = (src: string, start: string, end: string) => {
  const at = src.indexOf(start);
  expect(at, `missing: ${start}`).toBeGreaterThan(-1);
  const stop = src.indexOf(end, at + start.length);
  return src.slice(at, stop === -1 ? undefined : stop + end.length);
};

const WS = 2, OTHER = 9;
const ADMIN = 20, REP = 21, REP_B = 22;
const T0 = new Date("2026-11-18T15:00:00Z").getTime();
const DAY = 86_400_000;

function seed() {
  rows("workspaces").push({ id: WS, name: "Resa", slug: "resa", ownerUserId: ADMIN, archivedAt: null, plan: "trial" });
  const user = (id: number) => ({
    id, openId: `local:${id}`, name: `User ${id}`, email: `u${id}@resa.example`, loginMethod: "password", role: "user",
    passwordHash: `hash-${id}`, createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date(), emailSignature: null,
  });
  rows("users").push(user(ADMIN), user(REP), user(REP_B));
  const member = (id: number, userId: number, role: string) => ({
    id, workspaceId: WS, userId, role, title: null, quota: null, deactivatedAt: null, lastActiveAt: new Date(),
    inviteToken: null, inviteExpiresAt: null, createdAt: new Date(),
  });
  rows("workspace_members").push(member(1, ADMIN, "admin"), member(2, REP, "rep"), member(3, REP_B, "rep"));
  rows("workspace_settings").push({ workspaceId: WS, llmMonthlyTokenCap: null, outboundPausedAt: null, timezone: "UTC" });
}

function caller(userId: number) {
  const user = rows("users").find((u) => u.id === userId);
  return appRouter.createCaller({
    user,
    req: { protocol: "https", headers: { "x-workspace-id": String(WS) }, socket: { remoteAddress: "127.0.0.1" } },
    res: { clearCookie: () => {} },
  } as unknown as TrpcContext);
}

function lead(id: number, over: Record<string, unknown> = {}) {
  const row = {
    id, workspaceId: WS, firstName: "Testa", lastName: `Lead${id}`, title: "Director of Operations", company: "County Works",
    email: `lead${id}@county.example`, phone: null, source: "import", status: "new", score: 0, grade: null, scoreReasons: null,
    scoredAt: null, ownerUserId: ADMIN, createdAt: new Date(T0 - 10 * DAY), ...over,
  };
  rows("leads").push(row);
  return row;
}

function assessed(leadId: number, payload: Record<string, unknown>, at = new Date(T0 - 3 * DAY)) {
  rows("lead_score_history").push({
    id: rows("lead_score_history").length + 1, workspaceId: WS, leadId, firmographic: 0, behavioral: 0, aiFit: 0,
    total: 0, tier: "cold", aiFitPayload: payload, computedAt: at,
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(T0));
  h.db = makeSqlFakeDb({ realMembers: true });
  seed();
});
afterEach(() => vi.useRealTimers());

/* ── U17: the what-if ───────────────────────────────────────────────────── */

describe("the what-if scores with the server's own math, in the browser (U17)", () => {
  it("the server's scorer is the shared module, not a copy", () => {
    for (const fn of ["scoreFirmographic", "scoreBehavioral", "scoreAiFit", "composeScore", "tierFor", "titleSeniority", "titleHeuristicFit"] as const) {
      expect((serverMath as Record<string, unknown>)[fn], fn).toBe((sharedMath as Record<string, unknown>)[fn]);
    }
    expect(serverMath.DEFAULT_SCORE_CONFIG).toBe(DEFAULT_SCORE_CONFIG);
  });

  it("a lead's facts score exactly as the lead does", () => {
    const people = [
      { title: "CEO", company: "Acme", email: "a@acme.example", phone: "1", source: "web" },
      { title: "Product Owner", company: "Acme", email: "a@gmail.com" },
      { title: null, company: "", email: null },
      { title: "VP Sales", company: "  ", email: "x@yahoo.com", source: "import" },
    ];
    const cfg = { ...DEFAULT_SCORE_CONFIG, firmoTitleWeight: 33, firmoOrgTypeWeight: 7 };
    for (const p of people) expect(scoreFirmoFacts(firmoFacts(p), cfg)).toEqual(scoreFirmographic(p, cfg));
  });

  it("the browser's total for a lead is the server's, saved weights and edited ones alike", async () => {
    lead(1, { title: "CEO", phone: "555" });
    rows("email_drafts").push({ id: 1, workspaceId: WS, toLeadId: 1, status: "sent", openCount: 2, clickCount: 1, sentAt: new Date(T0 - 40 * DAY), lastOpenedAt: new Date(T0 - 35 * DAY), lastClickedAt: null, bouncedAt: null });
    assessed(1, { fit_score: 0.7, pain_points: ["a"], recommended_products: [], objection_risks: [] });
    const bd = await caller(REP).leadScoring.breakdown({ leadId: 1 });
    expect(componentsWhatIf(bd.inputs as any, DEFAULT_SCORE_CONFIG).score.total).toBe(bd.total);
    const edited = { ...DEFAULT_SCORE_CONFIG, behavOpenPoints: 1, aiFitMax: 10, tierWarmMin: 20 };
    const server = await caller(REP).leadScoring.breakdown({ leadId: 1, cfg: edited });
    const local = componentsWhatIf(bd.inputs as any, edited);
    expect([local.firmo.value, local.behav.value, local.aiFit.value, local.score.total, local.score.tier])
      .toEqual([server.firmographic.value, server.behavioral.value, server.aiFit.value, server.total, server.tier]);
    // Facts, never the lead's email or phone.
    expect(JSON.stringify(bd.inputs)).not.toContain("county.example");
    expect(Object.keys(bd.inputs.firmo).sort()).toEqual(["filled", "freeEmail", "hasCompany", "seniority"]);
  });

  it("the sample is this workspace's newest leads, as facts, engagement and last fit", async () => {
    lead(1, { title: "CEO" });
    lead(2, { title: "Manager", email: "two@gmail.com" });
    lead(3, { title: "Analyst" });
    lead(4, { workspaceId: OTHER, title: "CEO" });
    rows("email_drafts").push(
      { id: 1, workspaceId: WS, toLeadId: 1, status: "sent", openCount: 3, clickCount: 2, sentAt: new Date(T0 - DAY), lastOpenedAt: new Date(T0 - DAY), lastClickedAt: null, bouncedAt: null },
      { id: 2, workspaceId: WS, toLeadId: 2, status: "sent", openCount: 0, clickCount: 0, sentAt: new Date(T0 - 70 * DAY), lastOpenedAt: null, lastClickedAt: null, bouncedAt: new Date(T0 - 69 * DAY) },
    );
    rows("email_suppressions").push({ id: 1, workspaceId: WS, email: "two@gmail.com", reason: "unsubscribe" });
    rows("enrollments").push({ id: 1, workspaceId: WS, leadId: 3, currentStep: 2 });
    assessed(1, { fit_score: 0.2, pain_points: [], recommended_products: [], objection_risks: [] }, new Date(T0 - 9 * DAY));
    assessed(1, { fit_score: 0.9, pain_points: [], recommended_products: [], objection_risks: [] }, new Date(T0 - 2 * DAY));
    const s = await caller(REP).leadScoring.whatIfSample();
    expect(s.totalLeads).toBe(3);
    expect(s.leads).toHaveLength(3);
    expect(JSON.stringify(s)).not.toMatch(/county\.example|gmail\.com|Testa/);
    // Newest first; each lead's engagement is what its own breakdown reads (one batch read, same counts).
    const ids = [3, 2, 1];
    for (let i = 0; i < 3; i++) {
      const bd = await caller(REP).leadScoring.breakdown({ leadId: ids[i] });
      expect(s.leads[i].behavior, `lead ${ids[i]}`).toEqual(bd.behavioral.raw);
      expect(s.leads[i].firmo).toEqual(bd.inputs.firmo);
    }
    expect(s.leads[1].behavior).toMatchObject({ bounces: 1, unsubscribes: 1 });
    expect(s.leads[0].behavior.completedSteps).toBe(2);
    // The latest assessment, not the first.
    expect(s.leads[2].aiFit).toEqual({ fit_score: 0.9 });
    expect(s.leads[0].aiFit).toBeNull();
    expect(WHAT_IF_SAMPLE).toBe(500);
  });

  it("sorts the sample into tiers and counts who moves", () => {
    const l = (seniority: any, opens: number, fit: number | null) => ({
      firmo: { seniority, hasCompany: true, freeEmail: false, filled: 5 },
      behavior: { opens, clicks: 0, replies: 0, completedSteps: 0, bounces: 0, unsubscribes: 0, daysSinceLastEngagement: 0 },
      aiFit: fit == null ? null : { fit_score: fit },
    });
    const sample = [l("c_suite", 3, 1), l("ic", 0, null), l("manager", 1, 0.5)];
    const now = tierHistogram(sample, DEFAULT_SCORE_CONFIG);
    expect(now.cold + now.warm + now.hot + now.sales_ready).toBe(3);
    const harsher = { ...DEFAULT_SCORE_CONFIG, tierWarmMin: 60, tierHotMin: 90, tierSalesReadyMin: 99 };
    const moves = tierMoves(sample, DEFAULT_SCORE_CONFIG, harsher);
    expect(moves.up).toBe(0);
    expect(moves.down).toBeGreaterThan(0);
    expect(tierHistogram(sample, harsher).cold).toBeGreaterThan(now.cold);
  });

  it("knows which fields are unsaved, and what the scorer reads", () => {
    const saved = { ...DEFAULT_SCORE_CONFIG, notifyOnSalesReady: true };
    expect(unsavedFields(saved, saved)).toEqual([]);
    expect(unsavedFields({ ...saved, aiFitMax: 12, notifyOnSalesReady: false }, saved)).toEqual(["aiFitMax", "notifyOnSalesReady"]);
    expect(weightsOf(saved)).toEqual(DEFAULT_SCORE_CONFIG);
  });

  it("the page scores the preview and the histogram locally, marks unsaved changes and resets to the defaults", () => {
    const page = read("client/src/pages/usip/LeadScoring.tsx");
    expect(page).toContain("const DEFAULTS: Cfg = { ...DEFAULT_SCORE_CONFIG, notifyOnSalesReady: true };");
    // The preview: the server is asked once per lead, the bars are scored here.
    const preview = block(page, "function BreakdownPreview(", "\nfunction ");
    expect(preview).toContain("trpc.leadScoring.breakdown.useQuery(\n    { leadId: selected ?? 0 },");
    expect(preview).not.toContain("cfg: unsaved ? previewCfg");
    expect(preview).toContain("componentsWhatIf(bd.inputs as WhatIfLead, weights)");
    expect(preview).toContain("value={local?.firmo.value ?? bd.firmographic.value}");
    // The histogram.
    const hist = block(page, "function WhatIfHistogram(", "\nfunction ");
    expect(hist).toContain("trpc.leadScoring.whatIfSample.useQuery(");
    expect(hist).toContain("tierHistogram(sample, weightsOf(cfg))");
    expect(hist).toContain("tierMoves(sample, weightsOf(saved), weightsOf(cfg))");
    expect(page).toContain("<WhatIfHistogram cfg={cfg} saved=");
    // The marker and Reset, in the header, for anyone trying weights.
    const header = block(page, "<PageHeader", "</PageHeader>");
    const beforeAdmin = header.slice(0, header.indexOf("{isAdmin && ("));
    expect(beforeAdmin).toContain("Unsaved changes ({unsaved.length})");
    expect(beforeAdmin).toMatch(/onClick=\{\(\) => setCfg\(DEFAULTS\)\}[^>]*>\s*<RotateCcw className="size-4" \/> Reset to defaults/);
    expect(page).toContain("const unsaved = serverCfg ? unsavedFields(cfg, serverCfg as Partial<Cfg>) : [];");
  });
});

/* ── U32: the AI fit in full ────────────────────────────────────────────── */

describe("the breakdown shows the stored AI fit's details (U32)", () => {
  it("every pain, product and risk, and when it was assessed", async () => {
    lead(1);
    assessed(1, { fit_score: 0.64, pain_points: ["Grant reporting", "Staff turnover", "Audit prep"], recommended_products: ["Compliance pack"], objection_risks: ["Budget freeze", " "] }, new Date(T0 - 5 * DAY));
    const bd = await caller(REP).leadScoring.breakdown({ leadId: 1 });
    expect(bd.aiFit.details).toEqual({
      fitPct: 64, estimated: false,
      painPoints: ["Grant reporting", "Staff turnover", "Audit prep"],
      recommendedProducts: ["Compliance pack"],
      objectionRisks: ["Budget freeze"],
      assessedAt: new Date(T0 - 5 * DAY),
    });
  });

  it("a guess from the title says so, and a lead never assessed has none", async () => {
    lead(1);
    lead(2);
    assessed(1, { fit_score: 0.55, pain_points: [], recommended_products: [], objection_risks: [], source: "title_heuristic" });
    expect((await caller(REP).leadScoring.breakdown({ leadId: 1 })).aiFit.details).toMatchObject({ estimated: true, fitPct: 55 });
    expect((await caller(REP).leadScoring.breakdown({ leadId: 2 })).aiFit.details).toBeNull();
  });

  it("the lead panel and the Lead Scoring preview render them", () => {
    const drawer = read("client/src/components/usip/RecordDrawer.tsx");
    expect(block(drawer, 'title="AI Fit"', "</Accordion>")).toContain("<AiFitDetails details={bd.aiFit.details} />");
    expect(block(drawer, "function Accordion(", "\n}\n")).toContain("{open && children && <div");
    const page = read("client/src/pages/usip/LeadScoring.tsx");
    expect(block(page, '<Bar label="AI Fit"', "</Bar>")).toContain("<AiFitDetails details={bd.aiFit.details} />");
    const comp = read("client/src/components/usip/AiFitDetails.tsx");
    for (const label of ["Pains", "Recommended products", "Objection risks"]) expect(comp).toContain(`label: "${label}"`);
  });
});

/* ── F41: last scored, and the routing dry run ──────────────────────────── */

describe("each lead says when it was last scored (F41)", () => {
  it("the Leads list carries it, and the table shows it", async () => {
    lead(1, { scoredAt: new Date(T0 - 3 * 3600_000), score: 40 });
    lead(2);
    const list = await caller(REP).leads.list({ limit: 10 });
    expect(list.find((l: any) => l.id === 1)).toMatchObject({ scoredAt: new Date(T0 - 3 * 3600_000) });
    expect(list.find((l: any) => l.id === 2)).toMatchObject({ scoredAt: null });
    expect(scoredAgo(new Date(T0 - 3 * 3600_000), T0)).toBe("scored 3 h ago");
    expect(scoredAgo(null, T0)).toBe("not scored yet");
    const page = read("client/src/pages/usip/Leads.tsx");
    expect(page).toContain("{scoredAgo(l.scoredAt)}</div>");
  });
});

describe("routing's Test a lead changes nothing and agrees with the router (F41)", () => {
  const rule = (id: number, over: Record<string, unknown> = {}) => {
    const row = {
      id, workspaceId: WS, name: `Rule ${id}`, priority: id * 10, enabled: true, conditions: { all: [] },
      strategy: "direct", targetUserIds: [REP], rrCursor: 0, matchCount: 0, lastMatchedAt: null, ...over,
    };
    rows("lead_routing_rules").push(row);
    return row;
  };

  it("names the rule that takes a saved lead and who gets it, and writes nothing", async () => {
    lead(1, { source: "Webform", ownerUserId: null, score: 70 });
    rule(1, { enabled: false });
    rule(2, { conditions: { all: [{ field: "source", op: "eq", value: "partner" }] } });
    rule(3, { conditions: { all: [{ field: "score", op: "gte", value: 60 }] }, strategy: "round_robin", targetUserIds: [REP, REP_B], rrCursor: 1 });
    rule(4);
    const before = JSON.stringify(rows("lead_routing_rules"));
    const r = await caller(REP).leadRouting.testLead({ leadId: 1 });
    expect(r.pick).toEqual({ ruleId: 3, ownerUserId: REP_B });
    expect(r.rules.map((x) => x.verdict)).toEqual(["disabled", "no_match", "picked", "not_reached"]);
    // Nothing moved: no cursor, no count, no owner.
    expect(JSON.stringify(rows("lead_routing_rules"))).toBe(before);
    expect(rows("leads")[0].ownerUserId).toBeNull();
    // The router, run for real, picks the same.
    expect(await routeLeadOwner(WS, { title: "Director of Operations", company: "County Works", source: "Webform", score: 70 })).toBe(REP_B);
  });

  it("a rule whose conditions match but has nobody to give it to is passed by, as the router does", async () => {
    rule(1, { targetUserIds: [] });
    rule(2, { targetUserIds: [REP_B] });
    const r = await caller(REP).leadRouting.testLead({ lead: { source: "webform" } });
    expect(r.rules.map((x) => x.verdict)).toEqual(["no_owner", "picked"]);
    expect(r.pick).toEqual({ ruleId: 2, ownerUserId: REP_B });
    expect(await routeLeadOwner(WS, { source: "webform", score: 0 })).toBe(REP_B);
  });

  it("a typed lead is filled in from its account, as the router does, and an empty result says unassigned", async () => {
    rows("accounts").push({ id: 1, workspaceId: WS, name: "Acme", industry: "SaaS", region: "US" });
    rule(1, { conditions: { all: [{ field: "industry", op: "eq", value: "saas" }] }, targetUserIds: [REP_B] });
    const r = await caller(REP).leadRouting.testLead({ lead: { company: "Acme" } });
    expect(r.payload).toMatchObject({ company: "Acme", industry: "SaaS", country: "US" });
    expect(r.pick).toEqual({ ruleId: 1, ownerUserId: REP_B });
    const none = await caller(REP).leadRouting.testLead({ lead: { company: "Nobody Inc" } });
    expect(none.pick).toBeNull();
    expect(none.rules.map((x) => x.verdict)).toEqual(["no_match"]);
  });

  it("refuses another workspace's lead, and a test with no lead", async () => {
    lead(5, { workspaceId: OTHER });
    await expect(caller(REP).leadRouting.testLead({ leadId: 5 })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(caller(REP).leadRouting.testLead({})).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("the page offers it to everyone, reads it as a query, and says nothing changes", () => {
    const page = read("client/src/pages/usip/LeadRouting.tsx");
    const header = block(page, "<PageHeader", "</PageHeader>");
    expect(header).toContain('onClick={() => setTesting(true)}>\n          <FlaskConical className="size-4" /> Test a lead');
    expect(block(header, "{isAdmin && (", "\n        )}")).not.toContain("Test a lead");
    const dialog = block(page, "function TestLeadDialog(", "\nfunction ");
    expect(dialog).toContain("utils.leadRouting.testLead.fetch(");
    expect(dialog).not.toContain("useMutation");
    expect(dialog).toContain("Nothing changes: no owner is set, no round-robin turn is used, no match is counted.");
    expect(testLeadInput({ title: " CFO ", score: "250", company: "" })).toEqual({ title: "CFO", score: 100 });
    expect(Object.keys(TEST_VERDICT_LABEL).sort()).toEqual(["disabled", "no_match", "no_owner", "not_reached", "picked"]);
  });
});
