/**
 * Customers, QBRs and Renewals (audit 2026-10-20, batch Rc): R58 · R74 · R93 ·
 * R99.
 *
 *   R58 · one health tier reading for the table, the churn banner and the
 *         seed; a slider saves its own value when let go; an empty NPS is not
 *         0; a churned customer is not ARR
 *   R74 · a failed AI call saves no canned QBR prep; completed QBRs show their
 *         next actions; a churn estimate is not labelled AI; no canned play
 *   R93 · renewal urgency colours only rise; re-score stays reachable
 *   R99 · the NPS chart scales to its box; loading is not "Select a customer"
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => ({
  db: null as any,
  data: {} as Record<string, unknown>,
  llm: null as null | (() => Promise<any>),
}));

vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));
vi.mock("./audit", async (a) => ({ ...(await a<typeof import("./audit")>()), recordAudit: async () => {} }));
vi.mock("./_core/llm", async (a) => ({
  ...(await a<typeof import("./_core/llm")>()),
  invokeLLM: async () => h.llm!(),
}));
vi.mock("@/lib/trpc", () => {
  const noop: any = new Proxy(() => undefined, { get: () => noop, apply: () => undefined });
  const node = (path: string[]): any => new Proxy({}, {
    get(_t, key: string) {
      if (key === "useQuery") return () => ({ data: h.data[path.join(".")], isLoading: false, error: null });
      if (key === "useMutation") return () => ({ mutate: () => {}, mutateAsync: async () => ({}), isPending: false });
      if (key === "useUtils") return () => noop;
      return node([...path, key]);
    },
  });
  return { trpc: node([]) };
});
vi.mock("@/components/usip/Shell", () => ({
  Shell: ({ children }: any) => children,
  PageHeader: ({ description, children }: any) => createElement("header", null, description, children),
  QueryError: () => "query-error",
  TableSkeleton: () => "loading",
  EmptyState: ({ title }: any) => title,
  StatCard: ({ label, value }: any) => `${label}:${value}`,
}));

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { appRouter } from "./routers";
import { calcHealth, churnRiskFor, healthTierFor, HEALTH_TIER_TONE } from "@shared/customerHealth";
import { churnRiskFromScore } from "./seed";
import QBRs from "../client/src/pages/usip/QBRs";
import Renewals from "../client/src/pages/usip/Renewals";

const WS = 2;
const REP = 21;
const T0 = new Date("2026-11-18T15:00:00Z").getTime();
const DAY = 86_400_000;
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

function caller() {
  return appRouter.createCaller({
    user: { id: REP, openId: "u", email: "rep@lsi.example", name: "Rep", loginMethod: "password", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
    req: { protocol: "https", headers: { "x-workspace-id": String(WS) } },
    res: { clearCookie: () => {} },
  } as unknown as TrpcContext);
}
async function refusal(p: Promise<unknown>): Promise<{ code: string; message: string }> {
  try { await p; } catch (e: any) { return { code: e.code, message: e.message }; }
  throw new Error("expected a refusal, but it resolved");
}

function customer(id: number, over: Record<string, unknown> = {}) {
  rows("customers").push({
    id, workspaceId: WS, accountId: 500 + id, arr: "10000.00", expansionPotential: "1000.00",
    contractStart: new Date(T0 - 200 * DAY), contractEnd: new Date(T0 + 200 * DAY), renewalStage: "early",
    healthScore: 70, healthTier: "watch", usageScore: 70, engagementScore: 70, supportScore: 70, npsScore: 40, npsHistory: [],
    ...over,
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(T0));
  h.db = makeSqlFakeDb({ roles: { [WS]: "rep" }, wsId: () => WS });
  h.data = {};
  h.llm = null;
});
afterEach(() => { vi.useRealTimers(); });

/* ── R58 ────────────────────────────────────────────────────────────────── */

describe("R58: one health reading, sliders that don't fight, honest NPS and ARR", () => {
  it("the churn risk is the tier, at every score", () => {
    for (let s = 0; s <= 100; s++) {
      const tier = healthTierFor(s);
      expect(churnRiskFromScore(s)).toBe(churnRiskFor(tier));
      expect(HEALTH_TIER_TONE[tier]).toBeDefined();
    }
    // The two cut-off sets used to disagree here: 60 was "watch" (75/55/35)
    // and "medium"; 50 was "at_risk" and "medium" too.
    expect([healthTierFor(60), churnRiskFor(healthTierFor(60))]).toEqual(["watch", "medium"]);
    expect([healthTierFor(50), churnRiskFor(healthTierFor(50))]).toEqual(["at_risk", "high"]);
    expect(calcHealth({ usageScore: 80, engagementScore: 80, supportScore: 80, npsScore: 60 })).toEqual({ score: 80, tier: "healthy" });
  });

  it("moving one slider keeps the others as stored", async () => {
    customer(1, { usageScore: 10, engagementScore: 90, supportScore: 50 });
    await caller().cs.updateHealthComponents({ id: 1, usage: 40 });
    expect(rows("customers")[0]).toMatchObject({ usageScore: 40, engagementScore: 90, supportScore: 50 });
    await caller().cs.updateHealthComponents({ id: 1, support: 80 });
    expect(rows("customers")[0]).toMatchObject({ usageScore: 40, engagementScore: 90, supportScore: 80 });
    expect(rows("customers")[0].healthScore).toBe(calcHealth({ usageScore: 40, engagementScore: 90, supportScore: 80, npsScore: 40 }).score);
  });

  it("a churned customer is not counted in ARR, expansion or at-risk", async () => {
    customer(1, { arr: "10000.00", healthTier: "watch" });
    customer(2, { arr: "5000.00", expansionPotential: "9000.00", healthTier: "critical", renewalStage: "churned", contractEnd: new Date(T0 - 30 * DAY) });
    const k = await caller().cs.kpis();
    expect(k).toMatchObject({ arr: 10000, expansion: 1000, atRisk: 0, total: 1 });
  });

  it("the page sends one slider's value on release, refuses a blank NPS, and colours every tier", () => {
    const src = read("client/src/pages/usip/Customers.tsx");
    expect(src).toContain("onCommit={(v) => updateHealth.mutate({ id: detail.data!.id, usage: v })}");
    expect(src).toContain("onCommit={(v) => updateHealth.mutate({ id: detail.data!.id, engagement: v })}");
    expect(src).toContain("onCommit={(v) => updateHealth.mutate({ id: detail.data!.id, support: v })}");
    const slider = block(src, "function SliderRow(", "\n}\n");
    expect(slider).toContain("onPointerUp={commit} onKeyUp={commit} onBlur={commit}");
    expect(slider).toContain("onChange={(e) => setDraft(Number(e.target.value))}");
    const nps = block(src, "<form className=\"p-3 flex gap-2\" onSubmit={(e) => {", "}}>");
    expect(nps).toContain(`if (raw === "" || !Number.isInteger(v) || v < -100 || v > 100)`);
    expect(src).toContain("const tier = churnRiskFor(healthTier);");
    expect(src).not.toMatch(/if \(s < 45\)/);
  });
});

/* ── R74 ────────────────────────────────────────────────────────────────── */

describe("R74: nothing canned is saved or shown as AI", () => {
  beforeEach(() => {
    customer(1);
    rows("accounts").push({ id: 501, workspaceId: WS, name: "Acme" });
    rows("qbrs").push({ id: 7, workspaceId: WS, customerId: 1, scheduledAt: new Date(T0 + 7 * DAY), status: "scheduled", aiPrep: null });
  });

  it("a failed AI call saves no prep and says so", async () => {
    h.llm = async () => { throw new Error("provider down"); };
    const r = await refusal(caller().cs.generateQbrPrep({ qbrId: 7 }));
    expect(r.code).toBe("SERVICE_UNAVAILABLE");
    expect(rows("qbrs")[0].aiPrep).toBeNull();
  });

  it("an answer that isn't the prep is a failure too; a real one is saved, shaped", async () => {
    h.llm = async () => ({ choices: [{ message: { content: "Sorry, I can't help with that." } }] });
    expect((await refusal(caller().cs.generateQbrPrep({ qbrId: 7 }))).code).toBe("SERVICE_UNAVAILABLE");
    expect(rows("qbrs")[0].aiPrep).toBeNull();
    h.llm = async () => ({ choices: [{ message: { content: JSON.stringify({ wins: ["Usage up 30%"], risks: [], asks: ["Intro to finance"], agenda: ["Roadmap", 7] }) } }] });
    await caller().cs.generateQbrPrep({ qbrId: 7 });
    expect(rows("qbrs")[0].aiPrep).toEqual({ wins: ["Usage up 30%"], risks: [], asks: ["Intro to finance"], agenda: ["Roadmap"] });
  });

  it("a completed QBR shows its next actions", () => {
    h.data["cs.listQbrs"] = [{ id: 7, customerId: 1, status: "completed", scheduledAt: new Date(T0), aiPrep: null, notes: "Good call", nextActions: ["Send the SOW", "Book the training"] }];
    h.data["cs.list"] = [{ id: 1, account: { name: "Acme" } }];
    const html = renderToStaticMarkup(createElement(QBRs));
    expect(html).toContain("Next actions");
    expect(html).toContain("Send the SOW");
    expect(html).toContain("Book the training");
  });

  it("a churn estimate reads as an estimate, and the customer page shows no canned play", () => {
    h.data["cs.renewalsBoard"] = [
      { id: 1, renewalStage: "sixty", arr: "1000", healthTier: "watch", healthScore: 60, account: { name: "Est Co" }, churnRiskScore: 45, churnRiskRationale: "Heuristic: health score 60/100 (watch)." },
      { id: 2, renewalStage: "sixty", arr: "1000", healthTier: "watch", healthScore: 60, account: { name: "Ai Co" }, churnRiskScore: 20, churnRiskRationale: "Steady usage and a recent renewal call." },
    ];
    const html = renderToStaticMarkup(createElement(Renewals));
    expect(html).toContain("Churn risk (estimate)");
    expect(html.match(/AI churn risk/g)).toHaveLength(1);
    expect(read("client/src/pages/usip/Customers.tsx")).not.toContain("Recommend exec sponsor outreach");
  });
});

/* ── R93 ────────────────────────────────────────────────────────────────── */

describe("R93: renewal urgency only rises, and a score can be redone", () => {
  it("the column colours run calm to urgent", () => {
    const tone = block(read("client/src/pages/usip/Renewals.tsx"), "const TONE: Record<RenewalStage", "\n};");
    const rank: Record<string, number> = { success: 0, info: 1, warning: 2, danger: 3 };
    const order = ["early", "ninety", "sixty", "thirty", "at_risk"].map((k) => {
      const m = new RegExp(`\\b${k}: "(\\w+)"`).exec(tone);
      if (!m) throw new Error(`no tone for ${k}`);
      return rank[m[1]];
    });
    for (let i = 1; i < order.length; i++) expect(order[i]).toBeGreaterThanOrEqual(order[i - 1]);
    expect(order[order.length - 1]).toBeGreaterThan(order[0]);
  });

  it("a scored card still offers Re-score", () => {
    h.data["cs.renewalsBoard"] = [{ id: 2, renewalStage: "thirty", arr: "1000", healthTier: "healthy", healthScore: 80, account: { name: "Ai Co" }, churnRiskScore: 20, churnRiskRationale: "Fine." }];
    expect(renderToStaticMarkup(createElement(Renewals))).toContain(`aria-label="Re-score churn risk"`);
  });
});

/* ── R99 ────────────────────────────────────────────────────────────────── */

describe("R99: the NPS chart scales, and loading is not 'Select a customer'", () => {
  it("the chart has a viewBox and the panel tells loading, failure and none apart", () => {
    const src = read("client/src/pages/usip/Customers.tsx");
    const spark = block(src, "function NpsSparkline(", "\n}\n");
    expect(spark).toContain("viewBox={`0 0 ${w} ${h}`}");
    expect(src).toContain(`{!selected ? <EmptyState icon={Heart} title="Select a customer" /> : detail.isLoading ? <TableSkeleton rows={4} /> : detail.error ?`);
  });
});
