/**
 * The report builder computes what it says (audit 2026-10-20, G54).
 *
 *   Sum and Average sum and average, where they counted rows under the label ·
 *   Pie, Donut and Funnel get rows in the shape they read · a date can't be
 *   grouped on, which made a group per row · a capped result says it was cut ·
 *   Emails is on the picker · the query waits for typing to settle.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => {
  if (!process.env.ENCRYPTION_KEY && !process.env.JWT_SECRET) process.env.ENCRYPTION_KEY = "b".repeat(64);
  return { db: null as any };
});
vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { appRouter } from "./routers";
import { ReportInsights } from "../client/src/components/usip/ReportInsights";
import { reportChartSeries } from "../client/src/lib/reportChart";

const WS = 2, FOREIGN = 9;
const root = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8").replace(/\r\n/g, "\n");
const rows = (t: string) => h.db.rowsOf(t) as any[];
const run = (spec: Record<string, unknown>) => appRouter.createCaller({
  user: { id: 1, openId: "u", email: "o@example.com", name: "O", loginMethod: "password", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
  req: { protocol: "https", headers: { "x-workspace-id": String(WS) } },
  res: { clearCookie: () => {} },
} as unknown as TrpcContext).reports.run(spec as never);

const deal = (id: number, stage: string, value: number, o: Record<string, unknown> = {}) => ({
  id, workspaceId: WS, accountId: 1, name: `D${id}`, stage, value, winProb: 20, ownerUserId: 1, createdAt: new Date(`2026-10-0${id}T12:00:00Z`), ...o,
});
const byGroup = (r: any) => Object.fromEntries(r.rows.map((x: any) => [x.group, x.agg]));

beforeEach(() => {
  h.db = makeSqlFakeDb({ realMembers: true });
  rows("workspaces").push({ id: WS, name: "W", slug: "w", ownerUserId: 1, archivedAt: null, plan: "trial" });
  rows("users").push({ id: 1, name: "Me" });
  rows("workspace_members").push({ id: 1, workspaceId: WS, userId: 1, role: "admin", deactivatedAt: null, inviteToken: null, lastActiveAt: new Date() });
  rows("opportunities").push(
    deal(1, "discovery", 10), deal(2, "discovery", 20), deal(3, "won", 5), deal(4, "won", 1000, { workspaceId: FOREIGN }),
  );
});

describe("Sum and Average", () => {
  const spec = { object: "deals", columns: ["stage", "value"], filters: [], groupBy: "stage", limit: 200 };

  it("sum the field picked", async () => {
    const r = await run({ ...spec, aggregate: "sum_value", aggregateField: "value" });
    expect(byGroup(r)).toEqual({ discovery: 30, won: 5 });
    expect(r.columns[1].label).toBe("Sum of Value");
  });

  it("with no field sent, use the one the builder showed as picked, not a row count", async () => {
    expect(byGroup(await run({ ...spec, aggregate: "sum_value" }))).toEqual({ discovery: 30, won: 5 });
    const avg = await run({ ...spec, aggregate: "avg_value" });
    expect(byGroup(avg)).toEqual({ discovery: 15, won: 5 });
    expect(avg.columns[1].label).toBe("Avg Value");
  });

  it("refuse a field that isn't a number, and an object with none", async () => {
    await expect(run({ ...spec, aggregate: "sum_value", aggregateField: "name" })).rejects.toThrow(/isn't a number/);
    await expect(run({ object: "prospects", columns: ["company"], filters: [], groupBy: "company", aggregate: "avg_value", limit: 200 }))
      .rejects.toThrow(/no number field/);
  });

  it("the builder picks the field when Sum or Average is chosen, and offers neither without one", () => {
    const src = read("client/src/pages/usip/Reports.tsx");
    expect(src).toContain("aggregateField: aggregate === \"count\" ? undefined : (s.aggregateField ?? numericFields[0]?.key),");
    expect(src).toContain("{numericFields.length > 0 && <option value=\"sum_value\">Sum of…</option>}");
  });
});

describe("grouping and the cap", () => {
  it("a date can't be grouped on: it made a group per row", async () => {
    await expect(run({ object: "deals", columns: ["createdAt"], filters: [], groupBy: "createdAt", aggregate: "count", limit: 200 }))
      .rejects.toThrow(/is a date/);
    const src = read("client/src/pages/usip/Reports.tsx");
    expect(src).toContain("const groupableFields = columnsMeta.filter((c) => c.kind !== \"date\");");
    expect(src).toContain("{groupableFields.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}");
  });

  it("a result cut at the cap says so, rows and groups alike", async () => {
    const flat = { object: "deals", columns: ["name"], filters: [] };
    expect(await run({ ...flat, limit: 2 })).toMatchObject({ truncated: true });
    expect((await run({ ...flat, limit: 2 })).rows).toHaveLength(2);
    expect(await run({ ...flat, limit: 3 })).toMatchObject({ truncated: false });
    const grouped = { object: "deals", columns: ["stage"], filters: [], groupBy: "stage", aggregate: "count" };
    expect(await run({ ...grouped, limit: 1 })).toMatchObject({ truncated: true });
    expect(await run({ ...grouped, limit: 2 })).toMatchObject({ truncated: false });
    expect(read("client/src/pages/usip/Reports.tsx")).toContain("{result.data?.truncated && (");
  });
});

describe("the charts", () => {
  const grouped = {
    grouped: true,
    columns: [{ key: "group", label: "Stage", kind: "text" }, { key: "agg", label: "Sum of Value", kind: "number" }, { key: "n", label: "Rows", kind: "number" }],
    rows: [{ group: "discovery", agg: 30, n: 2 }, { group: "won", agg: 5, n: 1 }],
  };

  it("the funnel renders each group and its number", () => {
    const html = renderToStaticMarkup(createElement(ReportInsights, { result: grouped, viz: "funnel", accent: "#000" }));
    expect(html).toContain("discovery");
    expect(html).toContain(">30<");
    expect(html).not.toContain("NaN");
    expect(html).not.toContain("undefined");
  });

  it("Pie and Donut get names, the funnel stages and counts, the rest labels", () => {
    const pts = [{ label: "won", value: 5 }];
    expect(reportChartSeries("pie", pts)).toEqual([{ name: "won", value: 5 }]);
    expect(reportChartSeries("donut", pts)).toEqual([{ name: "won", value: 5 }]);
    expect(reportChartSeries("funnel", pts)).toEqual([{ stage: "won", count: 5 }]);
    expect(reportChartSeries("bar", pts)).toEqual(pts);
  });

  it("an average gets no total or share, which don't add up", () => {
    const avg = { ...grouped, columns: [grouped.columns[0], { key: "agg", label: "Avg Value", kind: "number" }, grouped.columns[2]] };
    const html = renderToStaticMarkup(createElement(ReportInsights, { result: avg, viz: "bar", accent: "#000" }));
    expect(html).not.toContain("Total avg");
    expect(html).not.toContain("Top share");
    expect(renderToStaticMarkup(createElement(ReportInsights, { result: grouped, viz: "bar", accent: "#000" }))).toContain("Top share");
  });
});

describe("the picker", () => {
  it("offers Emails, which the server has reported on all along", () => {
    expect(read("client/src/pages/usip/Reports.tsx")).toContain('emails: "Emails",');
  });
  it("waits for typing to settle before it queries", () => {
    expect(read("client/src/pages/usip/Reports.tsx")).toContain("const result = trpc.reports.run.useQuery(settledSpec as never, {");
  });
});
