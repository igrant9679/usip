/**
 * Lead scoring, the rest of the 2026-10-20 audit (batch Pb), against the real
 * routers and the SQL fake:
 *
 *   P12 scores keep themselves current: a new lead is scored, engagement and a
 *       daily sweep re-score with no model call, bounded per workspace · P22 the
 *       maximums are the scorer's · P33 penalties lower the total · P34 the bars
 *       add up to the total · P35 Save waits for the saved weights · P36 titles
 *       by whole words · P37 replies are inbound replies · P38 a failed model
 *       call is labelled a title estimate · P39/R84 leads.rescore is gone ·
 *       P44 the preview searches · P116 tier order · P117 decay ignores our
 *       sends · P118 the preview uses unsaved weights · P119 labels · P121
 *       readable errors · P123 one sub-navigation · P128 no name in the prompt.
 *
 * Time is frozen at T0 (Wednesday 2026-11-18, 15:00 UTC).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => {
  if (!process.env.ENCRYPTION_KEY && !process.env.JWT_SECRET) process.env.ENCRYPTION_KEY = "d".repeat(64);
  return {
    db: null as any, calls: 0, prompts: [] as string[], fail: false, fit: 0.5,
    notified: [] as any[], enrolled: [] as any[],
  };
});

vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages: any;
    constructor() {
      this.messages = {
        create: async (params: any) => {
          h.calls++;
          h.prompts.push(JSON.stringify(params.messages));
          if (h.fail) throw new Error("model unavailable");
          return {
            id: "m", model: "claude-haiku-4-5-20251001", stop_reason: "end_turn",
            content: [{ type: "text", text: JSON.stringify({ fit_score: h.fit, pain_points: [], recommended_products: [], objection_risks: [] }) }],
            usage: { input_tokens: 10, output_tokens: 5 },
          };
        },
      };
    }
  },
}));
vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));
vi.mock("./audit", async (a) => ({ ...(await a<typeof import("./audit")>()), recordAudit: async () => {} }));
vi.mock("./_core/env", async (a) => {
  const actual = await a<typeof import("./_core/env")>();
  return { ...actual, ENV: { ...actual.ENV, anthropicApiKey: "env-anthropic", aiDefaultProvider: "anthropic" } };
});
vi.mock("./services/policyNotify", async (a) => ({
  ...(await a<typeof import("./services/policyNotify")>()),
  notifyIfEnabled: async (n: any) => { h.notified.push(n); },
}));
vi.mock("./sequenceEngine", async (a) => ({
  ...(await a<typeof import("./sequenceEngine")>()),
  autoEnrollByTriggers: async (e: any) => { h.enrolled.push(e); },
}));

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { appRouter } from "./routers";
import { __resetLlmBurstForTests } from "./_core/llm";
import { invalidateArchivedWorkspaceCache } from "./_core/workspaceArchive";
import {
  composeScore, DEFAULT_SCORE_CONFIG, scoreAiFit, scoreBehavioral, scoreFirmographic, titleHeuristicFit, titleSeniority,
} from "./leadScoring";
import { RESCORE_STALE_PER_WORKSPACE, runLeadRescoreTick } from "./routers/leadScoring";
import { __resetLeadRescoreQueueForTests, noteLeadEngagement } from "./services/leadRescoreQueue";
import { buildCatalogFrom } from "./services/assistantActionCatalog";
import { componentMaxes, tierBands, tierThresholdProblem } from "@shared/leadScoreModel";
import { readableErrorMessage } from "../client/src/lib/trpcErrorMessage";
import { savedScoreLine } from "../client/src/lib/leadScoreText";

const read = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8").replace(/\r\n/g, "\n");
const rows = (t: string) => h.db.rowsOf(t) as any[];

const WS = 2, OTHER = 7;
const ADMIN = 20, REP = 21;
const T0 = new Date("2026-11-18T15:00:00Z").getTime();
const DAY = 86_400_000;

function seed() {
  rows("workspaces").push(
    { id: WS, name: "Pb Test", slug: "pb", ownerUserId: ADMIN, archivedAt: null, plan: "trial" },
    { id: OTHER, name: "Archived", slug: "arch", ownerUserId: ADMIN, archivedAt: new Date(T0 - 30 * DAY), plan: "trial" },
  );
  const user = (id: number) => ({
    id, openId: `local:${id}`, name: `User ${id}`, email: `u${id}@pb.example`, loginMethod: "password", role: "user",
    passwordHash: `hash-${id}`, createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date(), emailSignature: null,
  });
  rows("users").push(user(ADMIN), user(REP));
  const member = (id: number, userId: number, role: string) => ({
    id, workspaceId: WS, userId, role, title: null, quota: null, deactivatedAt: null, lastActiveAt: new Date(),
    inviteToken: null, inviteExpiresAt: null, createdAt: new Date(),
  });
  rows("workspace_members").push(member(1, ADMIN, "admin"), member(2, REP, "rep"));
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

function lead(id: number, over: Record<string, unknown> = {}) {
  const row = {
    id, workspaceId: WS, firstName: "Testa", lastName: `Lead${id}`, title: "Director of Operations", company: "County Works",
    email: `lead${id}@county.example`, phone: null, source: "import", status: "new", score: 0, grade: null, scoreReasons: null,
    scoredAt: null, ownerUserId: ADMIN, createdAt: new Date(T0 - 10 * DAY), ...over,
  };
  rows("leads").push(row);
  return row;
}

function sentDraft(id: number, leadId: number, over: Record<string, unknown> = {}) {
  rows("email_drafts").push({
    id, workspaceId: WS, toLeadId: leadId, status: "sent", subject: "Hello", body: "b", openCount: 0, clickCount: 0,
    sentAt: new Date(T0 - DAY), lastOpenedAt: null, lastClickedAt: null, bouncedAt: null, ...over,
  });
}

/** A stored AI assessment for a lead, as Recompute leaves it. */
function assessed(leadId: number, fit: number, total = 50) {
  rows("lead_score_history").push({
    id: rows("lead_score_history").length + 1, workspaceId: WS, leadId, firmographic: 0, behavioral: 0, aiFit: Math.round(fit * 30),
    total, tier: "warm", aiFitPayload: { fit_score: fit, pain_points: [], recommended_products: [], objection_risks: [] },
    computedAt: new Date(T0 - 3 * DAY),
  });
}

async function refusal(p: Promise<unknown>): Promise<{ code: string; message: string }> {
  try { await p; } catch (e: any) { return { code: e.code, message: e.message }; }
  throw new Error("expected a refusal, but it resolved");
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(T0));
  h.db = makeSqlFakeDb({ realMembers: true });
  Object.assign(h, { calls: 0, prompts: [], fail: false, fit: 0.5, notified: [], enrolled: [] });
  __resetLlmBurstForTests();
  __resetLeadRescoreQueueForTests();
  invalidateArchivedWorkspaceCache();
  seed();
});
afterEach(() => {
  vi.useRealTimers();
});

/* ── P12: scores keep themselves current ────────────────────────────────── */

describe("scores update on their own, with no model call (P12)", () => {
  it("the hourly tick scores leads never scored, stamps when, and keeps the last AI fit", async () => {
    lead(1, { title: "CEO" });
    assessed(1, 1);
    lead(2);
    const r = await runLeadRescoreTick();
    expect(r).toEqual({ engaged: 0, swept: 2, failed: 0 });
    expect(h.calls).toBe(0);
    const l1 = rows("leads").find((l) => l.id === 1);
    expect(l1.scoredAt).toEqual(new Date(T0));
    // 30 AI-fit points carried from the stored assessment, not asked for again.
    const firmo = scoreFirmographic(l1).value;
    expect(l1.score).toBe(firmo + 30);
    expect(rows("leads").find((l) => l.id === 2).scoredAt).toEqual(new Date(T0));
  });

  it("is bounded per workspace per tick, and the next tick takes the rest", async () => {
    for (let id = 1; id <= RESCORE_STALE_PER_WORKSPACE + 5; id++) lead(id);
    expect((await runLeadRescoreTick()).swept).toBe(RESCORE_STALE_PER_WORKSPACE);
    expect(rows("leads").filter((l) => l.scoredAt == null)).toHaveLength(5);
    expect((await runLeadRescoreTick()).swept).toBe(5);
    expect(rows("leads").filter((l) => l.scoredAt == null)).toHaveLength(0);
  });

  it("re-scores a lead not scored for a day, leaves a fresh one, and skips archived workspaces", async () => {
    lead(1, { scoredAt: new Date(T0 - 25 * 3600_000) });
    lead(2, { scoredAt: new Date(T0 - 3600_000) });
    lead(3, { workspaceId: OTHER });
    expect((await runLeadRescoreTick()).swept).toBe(1);
    expect(rows("leads").find((l) => l.id === 1).scoredAt).toEqual(new Date(T0));
    expect(rows("leads").find((l) => l.id === 2).scoredAt).toEqual(new Date(T0 - 3600_000));
    expect(rows("leads").find((l) => l.id === 3).scoredAt).toBeNull();
  });

  it("an open noted by the tracker re-scores the lead on the next tick, even if it was scored an hour ago", async () => {
    lead(1, { scoredAt: new Date(T0 - 3600_000) });
    sentDraft(1, 1, { openCount: 2, lastOpenedAt: new Date(T0 - 60_000) });
    noteLeadEngagement(WS, 1);
    expect(await runLeadRescoreTick()).toEqual({ engaged: 1, swept: 0, failed: 0 });
    expect(rows("leads").find((l) => l.id === 1).scoreReasons).toContain("2 opens (+10)");
  });

  it("a lead the tick takes over Sales Ready notifies its owner and reaches score-threshold sequences", async () => {
    lead(1, { title: "Chief Revenue Officer", phone: "555 0100", score: 40 });
    assessed(1, 1);
    rows("email_replies").push({ id: 1, workspaceId: WS, leadId: 1, draftId: 9, campaignId: null, receivedAt: new Date(T0 - DAY) });
    sentDraft(9, 1, { openCount: 3, clickCount: 2, lastOpenedAt: new Date(T0 - DAY) });
    await runLeadRescoreTick();
    const l = rows("leads").find((x) => x.id === 1);
    expect(l.score).toBeGreaterThanOrEqual(81);
    expect(h.notified).toEqual([expect.objectContaining({ event: "salesReadyCrossed", relatedId: 1 })]);
    expect(h.enrolled).toEqual([expect.objectContaining({ kind: "score_threshold", leadId: 1, score: l.score })]);
  });

  it("a re-score that changes nothing adds no history row; Recompute always does", async () => {
    lead(1);
    await runLeadRescoreTick();
    expect(rows("lead_score_history")).toHaveLength(1);
    vi.setSystemTime(new Date(T0 + 2 * DAY));
    await runLeadRescoreTick();
    expect(rows("lead_score_history")).toHaveLength(1);
    expect(rows("leads")[0].scoredAt).toEqual(new Date(T0 + 2 * DAY));
    await caller(REP).leadScoring.recompute({ leadId: 1 });
    expect(rows("lead_score_history")).toHaveLength(2);
    expect(h.calls).toBe(1);
  });

  it("a lead created by a rep is scored at once, without a model call", async () => {
    const { id } = await caller(REP).leads.create({ firstName: "Testa", lastName: "New", company: "County Works", title: "VP Finance", email: "new@county.example" });
    const l = rows("leads").find((x) => x.id === id);
    expect(l.scoredAt).toEqual(new Date(T0));
    expect(l.score).toBe(scoreFirmographic({ title: "VP Finance", company: "County Works", email: "new@county.example" }).value);
    expect(rows("lead_score_history").map((r) => r.leadId)).toEqual([id]);
    expect(h.calls).toBe(0);
  });

  it("the tracker, the reply poller and the boot schedule are wired to it", () => {
    const tracking = read("server/emailTracking.ts");
    expect(tracking.match(/noteLeadEngagement\(draft\.workspaceId, draft\.toLeadId\);/g)).toHaveLength(2);
    // The human-open note sits after the machine-open early return.
    const open = tracking.slice(tracking.indexOf("if (verdict.machine) {"), tracking.indexOf("Click redirect"));
    expect(open).toContain("noteLeadEngagement(draft.workspaceId, draft.toLeadId);");
    expect(read("server/inboundReplyPoller.ts")).toContain("noteLeadEngagement(data.workspaceId, matchedLeadId);");
    const boot = read("server/_core/index.ts");
    expect(boot).toMatch(/guardOverlap\("LeadRescore", \(\) =>\s*import\("\.\.\/routers\/leadScoring"\)\s*\.then\(\(m\) => m\.runLeadRescoreTick\(\)\)/);
    expect(boot).toContain("setInterval(runLeadRescore, 60 * 60 * 1000);");
    expect(read("server/_core/rawMigrations.ts")).toContain("ALTER TABLE `leads` ADD COLUMN `scoredAt` timestamp NULL");
  });
});

/* ── P22, P33, P34: one model, and the bars add up ──────────────────────── */

describe("the model, the bars and the total agree (P22, P33, P34)", () => {
  it("the maximums are what the scorer can give (P22)", () => {
    expect(componentMaxes(DEFAULT_SCORE_CONFIG)).toEqual({ firmographic: 40, behavioral: 75, aiFit: 30, sum: 145 });
    const most = scoreBehavioral({ opens: 99, clicks: 99, replies: 3, completedSteps: 5, bounces: 0, unsubscribes: 0, daysSinceLastEngagement: 0 });
    expect(most.value).toBe(componentMaxes(DEFAULT_SCORE_CONFIG).behavioral);
    const page = read("client/src/pages/usip/LeadScoring.tsx");
    expect(page).not.toContain("Default 40 + 30 + 30");
    expect(page).toContain("const max = componentMaxes(cfg);");
    expect(page).toContain("behavioral up to ${max.behavioral}");
  });

  it("a bounce or an unsubscribe lowers the total (P33)", () => {
    const firmo = scoreFirmographic({ title: "CEO", company: "X", email: "a@x.example" });
    const behav = scoreBehavioral({ opens: 0, clicks: 0, replies: 0, completedSteps: 0, bounces: 1, unsubscribes: 1, daysSinceLastEngagement: 0 });
    const total = composeScore({ firmo, behav, aiFit: scoreAiFit(null) }).total;
    expect(behav.value).toBe(-25);
    expect(total).toBe(firmo.value - 25);
    // Still floored at 0.
    expect(composeScore({ firmo: { value: 5, reasons: [] }, behav, aiFit: scoreAiFit(null) }).total).toBe(0);
  });

  it("the breakdown's three components add up to its total, and AI fit is the stored assessment (P34)", async () => {
    lead(1, { title: "CEO", score: 97 }); // a stale stored score
    assessed(1, 0.5, 97);
    sentDraft(1, 1, { openCount: 1, lastOpenedAt: new Date(T0 - DAY) });
    const bd = await caller(REP).leadScoring.breakdown({ leadId: 1 });
    expect(bd.aiFit.value).toBe(15);
    expect(bd.firmographic.value + bd.behavioral.value + bd.aiFit.value).toBe(bd.total);
    expect(bd.behavioral.max).toBe(75);
    expect(bd.maxSum).toBe(145);
    // The stored score is reported as such, not blended into the bars.
    expect(bd.saved).toEqual(expect.objectContaining({ scored: true, total: 97 }));
  });
});

/* ── P118, P119: the preview ────────────────────────────────────────────── */

describe("the preview uses unsaved weights and says when a lead was never scored (P118, P119)", () => {
  it("a cfg passed to the breakdown is used instead of the saved one", async () => {
    lead(1, { title: "CEO" });
    const saved = await caller(REP).leadScoring.breakdown({ leadId: 1 });
    const { notifyOnSalesReady: _n, ...weights } = { ...DEFAULT_SCORE_CONFIG, notifyOnSalesReady: true };
    const edited = await caller(REP).leadScoring.breakdown({ leadId: 1, cfg: { ...weights, firmoTitleWeight: 40 } });
    expect(edited.firmographic.value - saved.firmographic.value).toBe(25);
    const page = read("client/src/pages/usip/LeadScoring.tsx");
    expect(page).toContain("{ leadId: selected ?? 0, cfg: unsaved ? previewCfg : undefined }");
    expect(page).toContain("<BreakdownPreview cfg={cfg} unsaved=");
  });

  it("a lead never scored has no tier, and the page says Not scored rather than Cold", async () => {
    lead(1);
    const bd = await caller(REP).leadScoring.breakdown({ leadId: 1 });
    expect(bd.saved).toEqual(expect.objectContaining({ scored: false, tier: null }));
    expect(savedScoreLine(bd.saved as any, bd.total)).toMatch(/^Not scored yet\./);
    expect(read("client/src/components/usip/RecordDrawer.tsx")).toContain(': "Not scored";');
  });

  it("reply points are labelled as given once", () => {
    const out = scoreBehavioral({ opens: 0, clicks: 0, replies: 3, completedSteps: 0, bounces: 0, unsubscribes: 0, daysSinceLastEngagement: 0 });
    expect(out.value).toBe(DEFAULT_SCORE_CONFIG.behavReplyPoints);
    expect(out.reasons).toEqual(["Replied (3 replies) (+25, counted once)"]);
    const page = read("client/src/pages/usip/LeadScoring.tsx");
    expect(page).toContain('label="Pts for replying (once)"');
    expect(page).not.toContain('label="Pts/reply"');
  });
});

/* ── P36, P37, P117: what counts ────────────────────────────────────────── */

describe("what the scorer counts (P36, P37, P117)", () => {
  it("titles are read by whole words (P36)", () => {
    expect(["CTO", "COO", "President", "Co-Founder", "Business Owner", "Chief of Staff"].map(titleSeniority)).toEqual(Array(6).fill("c_suite"));
    expect(titleSeniority("Vice President, Sales")).toBe("vp");
    expect(titleSeniority("SVP Marketing")).toBe("vp");
    expect(titleSeniority("Product Owner")).toBe("ic");
    expect(titleSeniority("Microsoft Specialist")).toBe("ic");
    expect(titleSeniority("MVP Program Lead")).toBe("ic");
    expect(titleSeniority("Director, Finance")).toBe("director");
    expect(titleSeniority("Account Manager")).toBe("manager");
    expect(scoreFirmographic({ title: "CTO" }).reasons[0]).toBe("C-suite title (+15)");
    // The fallback fit reads the same words.
    expect(titleHeuristicFit("Product Owner").fit_score).toBe(0.25);
  });

  it("our own 'Re:' follow-up and a 'Feature:' subject are not replies; a genuine reply is (P37)", async () => {
    lead(1);
    rows("activities").push(
      { id: 1, workspaceId: WS, type: "email", relatedType: "lead", relatedId: 1, subject: "Re: quick question", occurredAt: new Date(T0 - DAY) },
      { id: 2, workspaceId: WS, type: "email", relatedType: "lead", relatedId: 1, subject: "Feature: new dashboards", occurredAt: new Date(T0 - DAY) },
    );
    const before = await caller(REP).leadScoring.breakdown({ leadId: 1 });
    expect(before.behavioral.raw.replies).toBe(0);
    rows("email_replies").push({ id: 1, workspaceId: WS, leadId: 1, draftId: 4, campaignId: null, receivedAt: new Date(T0 - DAY) });
    const after = await caller(REP).leadScoring.breakdown({ leadId: 1 });
    expect(after.behavioral.raw.replies).toBe(1);
  });

  it("decay runs from the prospect's last action, not our last send (P117)", async () => {
    lead(1);
    // Opened 95 days ago; we have sent again since, yesterday.
    sentDraft(1, 1, { openCount: 3, sentAt: new Date(T0 - 100 * DAY), lastOpenedAt: new Date(T0 - 95 * DAY) });
    sentDraft(2, 1, { sentAt: new Date(T0 - DAY) });
    const bd = await caller(REP).leadScoring.breakdown({ leadId: 1 });
    expect(bd.behavioral.raw.daysSinceLastEngagement).toBe(95);
    expect(bd.behavioral.reasons).toContain("Decay 3x30d (15→11)");
  });

  it("a connected call or a meeting is the prospect engaging", async () => {
    lead(1);
    sentDraft(1, 1, { openCount: 1, sentAt: new Date(T0 - 100 * DAY), lastOpenedAt: new Date(T0 - 95 * DAY) });
    rows("activities").push({ id: 1, workspaceId: WS, type: "call", callDisposition: "connected", relatedType: "lead", relatedId: 1, occurredAt: new Date(T0 - 2 * DAY) });
    rows("activities").push({ id: 2, workspaceId: WS, type: "note", relatedType: "lead", relatedId: 1, occurredAt: new Date(T0) });
    const bd = await caller(REP).leadScoring.breakdown({ leadId: 1 });
    expect(bd.behavioral.raw.daysSinceLastEngagement).toBe(2);
  });
});

/* ── P38, P128: the model call ──────────────────────────────────────────── */

describe("the AI fit call (P38, P128)", () => {
  it("sends the role and the organization, not the person's name (P128)", async () => {
    lead(1, { firstName: "Unmistakable", lastName: "Namesake" });
    await caller(REP).leadScoring.recompute({ leadId: 1 });
    expect(h.calls).toBe(1);
    expect(h.prompts[0]).toContain("Director of Operations");
    expect(h.prompts[0]).not.toContain("Unmistakable");
    expect(h.prompts[0]).not.toContain("Namesake");
  });

  it("a failed call is stored and shown as a title estimate, not as AI fit (P38)", async () => {
    lead(1);
    h.fail = true;
    const out = await caller(REP).leadScoring.recompute({ leadId: 1 });
    expect(h.calls).toBeGreaterThan(0);
    expect(rows("lead_score_history")[0].aiFitPayload).toEqual(expect.objectContaining({ source: "title_heuristic", fit_score: 0.55 }));
    expect(out.reasons.join(" | ")).toContain("Fit estimated from the title; the AI assessment failed (+17)");
    expect(out.reasons.join(" | ")).not.toMatch(/AI fit \d+%/);
  });
});

/* ── P116, P35, P121, P123, P44: the settings page ──────────────────────── */

describe("the Lead Scoring page (P35, P44, P116, P121, P123)", () => {
  it("thresholds out of order are refused with a sentence, and the bands fill the bar exactly (P116)", async () => {
    const { notifyOnSalesReady: _n, ...weights } = { ...DEFAULT_SCORE_CONFIG, notifyOnSalesReady: true };
    const bad = await refusal(caller(ADMIN).leadScoring.saveConfig({ ...weights, tierHotMin: 31, notifyOnSalesReady: true }));
    expect(bad).toEqual({ code: "BAD_REQUEST", message: "The Hot threshold must be above the Warm threshold." });
    expect(rows("lead_score_config")).toHaveLength(0);
    expect(await caller(ADMIN).leadScoring.saveConfig({ ...weights, notifyOnSalesReady: true })).toEqual({ ok: true });
    expect(tierThresholdProblem({ tierWarmMin: 31, tierHotMin: 61, tierSalesReadyMin: 81 })).toBeNull();
    const widths = tierBands({ tierWarmMin: 31, tierHotMin: 61, tierSalesReadyMin: 81 }).map((b) => b.widthPct);
    expect(widths.reduce((a, b) => a + b, 0)).toBeCloseTo(100, 10);
    expect(read("client/src/pages/usip/LeadScoring.tsx")).toContain("width: `${b.widthPct}%`");
  });

  it("Save waits for the saved weights to load (P35)", () => {
    expect(read("client/src/pages/usip/LeadScoring.tsx")).toContain("disabled={save.isPending || !serverCfg || !!tierProblem}");
  });

  it("a refused value toasts a sentence, not zod's issue list (P121)", () => {
    const zodMessage = JSON.stringify([{ origin: "number", code: "too_big", maximum: 40, inclusive: true, path: ["firmoTitleWeight"], message: "Too big: expected number to be <=40" }], null, 2);
    expect(readableErrorMessage({ message: zodMessage }, { firmoTitleWeight: "Title seniority weight" }))
      .toBe("Title seniority weight: Too big: expected number to be <=40");
    expect(readableErrorMessage({ message: "Not allowed" })).toBe("Not allowed");
    expect(read("client/src/pages/usip/LeadScoring.tsx")).toContain("onError: (e) => toast.error(readableErrorMessage(e, FIELD_LABELS)),");
  });

  it("scoring, routing and territories show the same sub-navigation (P123)", () => {
    for (const page of ["LeadScoring.tsx", "LeadRouting.tsx", "Territories.tsx"]) {
      expect(read(`client/src/pages/usip/${page}`), page).toContain("<SubNav items={LEAD_ASSIGNMENT_NAV} />");
    }
    const nav = read("client/src/lib/leadAssignmentNav.ts");
    for (const href of ['"/lead-scoring"', '"/lead-routing"', '"/territories"']) expect(nav).toContain(href);
  });

  it("the preview's picker searches a few leads instead of loading 500 (P44)", () => {
    const page = read("client/src/pages/usip/LeadScoring.tsx");
    expect(page).toContain("trpc.leads.list.useQuery({ search: query || undefined, limit: PICKER_LIMIT })");
    expect(page).not.toContain("trpc.leads.list.useQuery({})");
    expect(page).toContain('aria-label="Search leads"');
  });
});

/* ── P39, R84: the old scorer ───────────────────────────────────────────── */

describe("leads.rescore is gone, from the router and the assistant (P39, R84)", () => {
  it("has no procedure, and the assistant's catalog offers the real scorer only", () => {
    const procs = (appRouter as any)._def.procedures as Record<string, unknown>;
    expect(procs["leads.rescore"]).toBeUndefined();
    expect(procs["leadScoring.recompute"]).toBeDefined();
    const catalog = buildCatalogFrom(appRouter as any).map((e) => e.path);
    expect(catalog).not.toContain("leads.rescore");
    expect(catalog).toContain("leadScoring.recompute");
    const crm = read("server/routers/crm.ts");
    expect(crm).not.toContain("Math.random() * 15");
  });
});
