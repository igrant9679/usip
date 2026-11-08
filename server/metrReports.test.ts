/**
 * Reports, audit 2026-10-20 F45 (G54): a date column groups by day, week or
 * month in the workspace's zone; every result says how many rows or groups
 * there are in all, with totals over all of them, and pages through them;
 * /reports?report= opens a saved report or a preset; and a scheduled report
 * records each send's outcome so the page can show when it last went and how
 * its last try went. Nothing new sends: the scheduler's sending is unchanged.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => {
  if (!process.env.ENCRYPTION_KEY && !process.env.JWT_SECRET) process.env.ENCRYPTION_KEY = "b".repeat(64);
  return { db: null as any, sends: [] as any[], sendOk: true };
});
vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));
vi.mock("./emailDelivery", async (a) => ({
  ...(await a<typeof import("./emailDelivery")>()),
  sendSystemEmail: async (_ws: number, msg: unknown) => { h.sends.push(msg); return h.sendOk ? { ok: true } : { ok: false, reason: "SMTP refused" }; },
}));

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { appRouter } from "./routers";
import { _clearWorkspaceTimezoneCache } from "./services/workspaceTimezone";
import { emailSavedReport, isDue } from "./services/reportScheduler";
import { bucketKey, bucketLabel, foldSlots, slotSecondsFor } from "@shared/reportBuckets";
import { reportHref, scheduleStatus } from "../client/src/lib/reportLinks";
import { ReportInsights } from "../client/src/components/usip/ReportInsights";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const WS = 2, FOREIGN = 9;
const NY = "America/New_York";
const root = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8").replace(/\r\n/g, "\n");
const rows = (t: string) => h.db.rowsOf(t) as any[];
const caller = () => appRouter.createCaller({
  user: { id: 1, openId: "u", email: "o@example.com", name: "O", loginMethod: "password", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
  req: { protocol: "https", headers: { "x-workspace-id": String(WS) } },
  res: { clearCookie: () => {} },
} as unknown as TrpcContext);
const run = (spec: Record<string, unknown>) => caller().reports.run(spec as never);

const deal = (id: number, stage: string, value: number, o: Record<string, unknown> = {}) => ({
  id, workspaceId: WS, accountId: 1, name: `D${id}`, stage, value, winProb: 20, ownerUserId: 1, daysInStage: 0, createdAt: new Date("2026-10-05T12:00:00Z"), ...o,
});

beforeEach(() => {
  h.db = makeSqlFakeDb({ realMembers: true });
  h.sends = [];
  h.sendOk = true;
  _clearWorkspaceTimezoneCache();
  rows("workspaces").push({ id: WS, name: "W", slug: "w", ownerUserId: 1, archivedAt: null, plan: "trial" });
  rows("users").push({ id: 1, name: "Me", email: "o@example.com" });
  rows("workspace_members").push({ id: 1, workspaceId: WS, userId: 1, role: "admin", deactivatedAt: null, inviteToken: null, lastActiveAt: new Date(), notifEmail: null });
  rows("workspace_settings").push({ workspaceId: WS, timezone: NY });
});
afterEach(() => { _clearWorkspaceTimezoneCache(); });

/* ── Buckets ───────────────────────────────────────────────────────────── */

describe("date buckets are the workspace's days, weeks and months (F45)", () => {
  // Tuesday 2026-11-03, 22:30 in New York = Wednesday 03:30 UTC.
  const EVENING = Date.UTC(2026, 10, 4, 3, 30);

  it("an Eastern evening is that evening's day, week and month", () => {
    expect(bucketKey(EVENING, "day", NY)).toBe("2026-11-03");
    expect(bucketKey(EVENING, "day", "UTC")).toBe("2026-11-04");
    expect(bucketKey(EVENING, "week", NY)).toBe("2026-11-02"); // the Monday
    // 22:30 on 31 October in New York is November in UTC.
    expect(bucketKey(Date.UTC(2026, 10, 1, 2, 30), "month", NY)).toBe("2026-10");
  });

  it("a week starts on Monday, across a clock change", () => {
    // Sunday 1 Nov 2026 (the day New York left daylight time) belongs to the week of Mon 26 Oct.
    expect(bucketKey(Date.UTC(2026, 10, 1, 16), "week", NY)).toBe("2026-10-26");
    expect(bucketKey(Date.UTC(2026, 10, 2, 16), "week", NY)).toBe("2026-11-02");
    expect(bucketLabel("2026-11-02", "week")).toBe("Week of Nov 2, 2026");
    expect(bucketLabel("2026-11", "month")).toBe("Nov 2026");
  });

  it("a calendar date (a close date at noon UTC) keeps its own day in any zone", () => {
    const close = Date.UTC(2026, 10, 1, 12); // "1 November"
    expect(bucketKey(close, "month", "Pacific/Honolulu", true)).toBe("2026-11");
    expect(bucketKey(close, "day", "Asia/Tokyo", true)).toBe("2026-11-01");
  });

  it("slots are an hour, or a quarter hour for a zone off the hour", () => {
    expect(slotSecondsFor(NY)).toBe(3600);
    expect(slotSecondsFor("Asia/Kolkata")).toBe(900);
    expect(slotSecondsFor("Asia/Kathmandu")).toBe(900);
  });

  it("folds slots into buckets, zero-filled, sums and averages kept apart, undated last", () => {
    const slot = (ms: number) => Math.floor(ms / 1000 / 3600);
    const out = foldSlots([
      { slot: slot(Date.UTC(2026, 10, 2, 15)), n: 2, sum: 30, valued: 2 },
      { slot: slot(EVENING), n: 1, sum: 5, valued: 1 }, // Tuesday evening in NY
      { slot: slot(Date.UTC(2026, 10, 5, 15)), n: 1, sum: null, valued: 0 },
      { slot: null, n: 4, sum: 8, valued: 4 },
    ], "day", NY, 3600);
    expect(out.map((b) => [b.key, b.n, b.sum])).toEqual([
      ["2026-11-02", 2, 30], ["2026-11-03", 1, 5], ["2026-11-04", 0, 0], ["2026-11-05", 1, 0], ["", 4, 8],
    ]);
    expect(out.at(-1)!.label).toBe("(no date)");
  });
});

/* ── The builder: totals, paging, buckets end to end ───────────────────── */

describe("results say how many in all, with totals, and page (F45)", () => {
  beforeEach(() => {
    rows("opportunities").push(
      deal(1, "discovery", 10, { winProb: 10 }), deal(2, "discovery", 20, { winProb: 30 }), deal(3, "won", 5, { winProb: 100 }),
      deal(4, "proposal", 40, { winProb: 50 }), deal(5, "won", 1000, { workspaceId: FOREIGN }),
    );
  });

  it("a row list: the total, a second page, and totals over every row (a sum for value, an average for a probability)", async () => {
    const spec = { object: "deals", columns: ["name", "value", "winProb"], filters: [], sort: { field: "value", dir: "asc" }, limit: 2 };
    const p1 = await run(spec);
    expect(p1).toMatchObject({ total: 4, offset: 0, truncated: true });
    expect(p1.rows.map((r: any) => r.name)).toEqual(["D3", "D1"]);
    const p2 = await run({ ...spec, offset: 2 });
    expect(p2).toMatchObject({ total: 4, offset: 2, truncated: false });
    expect(p2.rows.map((r: any) => r.name)).toEqual(["D2", "D4"]);
    expect(p1.totals).toEqual({ value: 75, winProb: 47.5 });
    expect(p1.totalKinds).toEqual({ value: "sum", winProb: "avg" });
  });

  it("an id column gets no total", async () => {
    rows("activities").push({ id: 1, workspaceId: WS, type: "call", relatedType: "contact", relatedId: 99, occurredAt: new Date(), callDurationSec: 60 });
    const r = await run({ object: "activities", columns: ["type", "relatedId", "callDurationSec"], filters: [], limit: 50 });
    expect(r.totals).toEqual({ callDurationSec: 60 });
  });

  it("groups: how many in all (an empty group counts), totals over every row, and paging", async () => {
    rows("opportunities").push(deal(6, null as never, 7));
    const spec = { object: "deals", columns: ["stage"], filters: [], groupBy: "stage", aggregate: "sum_value", aggregateField: "value", limit: 2 };
    const r = await run(spec);
    expect(r.total).toBe(4); // discovery, won, proposal, and the stageless deal
    expect(r.totals).toEqual({ agg: 82, n: 5 });
    expect(r.rows).toHaveLength(2);
    const p2 = await run({ ...spec, offset: 2 });
    expect(p2.rows).toHaveLength(2);
    expect(p2.truncated).toBe(false);
  });

  it("a date still can't be grouped as is: it needs a day, week or month", async () => {
    await expect(run({ object: "deals", columns: ["createdAt"], filters: [], groupBy: "createdAt", aggregate: "count", limit: 200 }))
      .rejects.toThrow(/is a date\. Group it by day, week or month/);
  });

  it("a date grouped by week: the workspace's weeks, folded from SQL slots, with totals", async () => {
    // Replace the dates: Mon 2 Nov morning, Tue 3 Nov 22:30 NY (Wed in UTC), Sun 1 Nov, and Mon 9 Nov.
    const at = [Date.UTC(2026, 10, 2, 15), Date.UTC(2026, 10, 4, 3, 30), Date.UTC(2026, 10, 1, 16), Date.UTC(2026, 10, 9, 15)];
    rows("opportunities").forEach((d: any, i: number) => { if (d.workspaceId === WS) d.createdAt = new Date(at[i]!); });
    // The SQL slot grouping (floor(unix_timestamp(col) / slot)) is MySQL's; the
    // fake can't group by an expression, so it answers that one query from the
    // same rows the way MySQL would, and the rest of the path runs for real.
    const real = h.db.select;
    let slotQueries = 0;
    h.db.select = (proj?: Record<string, unknown>) => {
      if (!proj || !("slot" in proj)) return real(proj);
      slotQueries++;
      const b: any = { from: () => b, where: () => b, groupBy: () => b,
        then: (res: (v: unknown) => void) => {
          const by = new Map<number, { n: number; s: number; c: number }>();
          for (const d of rows("opportunities").filter((x: any) => x.workspaceId === WS)) {
            const slot = Math.floor(new Date(d.createdAt).getTime() / 1000 / 3600);
            const cur = by.get(slot) ?? { n: 0, s: 0, c: 0 };
            by.set(slot, { n: cur.n + 1, s: cur.s + Number(d.value), c: cur.c + 1 });
          }
          res(Array.from(by, ([slot, v]) => ({ slot, n: v.n, s: v.s, c: v.c })));
        } };
      return b;
    };
    const r = await run({ object: "deals", columns: ["createdAt"], filters: [], groupBy: "createdAt", groupBucket: "week", aggregate: "sum_value", aggregateField: "value", limit: 200 });
    expect(slotQueries).toBe(1);
    expect(r).toMatchObject({ grouped: true, bucket: "week", total: 3 });
    // Week of 26 Oct holds Sunday 1 Nov; week of 2 Nov holds Mon and the Tuesday-evening deal.
    expect(r.rows).toEqual([
      { group: "Week of Oct 26, 2026", agg: 5, n: 1 },
      { group: "Week of Nov 2, 2026", agg: 30, n: 2 },
      { group: "Week of Nov 9, 2026", agg: 40, n: 1 },
    ]);
    expect(r.totals).toEqual({ agg: 75, n: 4 });
    const src = read("server/routers/reports.ts");
    expect(src).toContain("const slotExpr = sql<number>`floor(unix_timestamp(${g.col}) / ${slotSec})`;");
    expect(src).toContain("spec.groupBucket, tz, slotSec, !!g.calendar,");
  });

  it("the export is the whole result from the start, not the page on screen", () => {
    expect(read("server/routers/reports.ts")).toContain("await runSpec(ctx.workspace.id, { ...input, limit: 1000, offset: 0 });");
  });
});

/* ── Last-sent status ──────────────────────────────────────────────────── */

describe("a scheduled report keeps its last send's outcome (F45)", () => {
  const report = (o: Record<string, unknown> = {}) => {
    rows("saved_reports").push({ id: 7, workspaceId: WS, ownerUserId: 1, name: "Pipeline", object: "deals", config: { object: "deals", columns: ["name"], filters: [], limit: 50 }, scheduleFreq: "daily", scheduleRecipients: "o@example.com", scheduleLastSentAt: null, ...o });
    return rows("saved_reports").find((r: any) => r.id === 7);
  };

  it("a send that goes records when, to how many, and that it went", async () => {
    const r = report();
    expect(await emailSavedReport(7, WS)).toMatchObject({ ok: true, sentTo: 1 });
    expect(r.scheduleLastResult).toBe("sent");
    expect(r.scheduleLastSentTo).toBe(1);
    expect(r.scheduleLastSentAt).toBeInstanceOf(Date);
    expect(r.scheduleLastAttemptAt).toBeInstanceOf(Date);
    expect(r.scheduleLastError).toBeNull();
  });

  it("a send that fails records why, and leaves the last-sent time (when it is due) alone", async () => {
    const before = new Date("2026-11-02T13:00:00Z");
    const r = report({ scheduleLastSentAt: before });
    h.sendOk = false;
    expect(await emailSavedReport(7, WS)).toMatchObject({ ok: false, reason: "SMTP refused" });
    expect(r).toMatchObject({ scheduleLastResult: "failed", scheduleLastError: "SMTP refused" });
    expect(r.scheduleLastSentAt).toBe(before);
    // Due-ness still reads the last SENT time only, so a failure is retried as before.
    expect(isDue("daily", r.scheduleLastSentAt, new Date("2026-11-03T13:00:00Z"), NY)).toBe(true);
  });

  it("no valid recipient is a failed attempt with its reason; nothing is sent", async () => {
    const r = report({ scheduleRecipients: "not-an-address" });
    expect(await emailSavedReport(7, WS)).toMatchObject({ ok: false });
    expect(r).toMatchObject({ scheduleLastResult: "failed", scheduleLastError: "No valid recipients configured" });
    expect(h.sends).toHaveLength(0);
  });

  it("the page says when it last went, and a failed last try with its reason", () => {
    expect(scheduleStatus({ scheduleFreq: "none" })).toBeNull();
    expect(scheduleStatus({ scheduleFreq: "weekly" })!.text).toBe("Emailed weekly; not sent yet.");
    const ok = scheduleStatus({ scheduleFreq: "daily", scheduleLastSentAt: "2026-11-03T13:02:00Z", scheduleLastSentTo: 3, scheduleLastResult: "sent", scheduleLastAttemptAt: "2026-11-03T13:02:00Z" })!;
    expect(ok.failed).toBe(false);
    expect(ok.text).toMatch(/^Last sent .+ to 3 recipients\.$/);
    const bad = scheduleStatus({ scheduleFreq: "daily", scheduleLastResult: "failed", scheduleLastAttemptAt: "2026-11-04T13:00:00Z", scheduleLastError: "SMTP refused" })!;
    expect(bad).toMatchObject({ failed: true });
    expect(bad.text).toMatch(/^Last send failed .+: SMTP refused\. Never sent\.$/);
    const page = read("client/src/pages/usip/Reports.tsx");
    expect(page).toContain("const status = scheduleStatus(r);");
    expect(page).toContain("const st = scheduleStatus(report);");
    expect(page).toContain('<option value="daily">Daily (8 AM, workspace time)</option>');
    expect(page).not.toContain("mornings, UTC");
  });
});

/* ── Deep links and the page ───────────────────────────────────────────── */

describe("?report= opens a report, and the page shows totals and pages (F45)", () => {
  it("links name a saved report by id, a preset by key", () => {
    expect(reportHref({ id: 12 })).toBe("/reports?report=12");
    expect(reportHref({ preset: "won-deals" })).toBe("/reports?report=preset:won-deals");
  });

  it("the page reads ?report=, writes it when a report opens, and offers the link", () => {
    const page = read("client/src/pages/usip/Reports.tsx");
    expect(page).toContain('const reportParam = new URLSearchParams(useSearch()).get("report");');
    expect(page).toContain('if (reportParam.startsWith("preset:")) {');
    expect(page).toContain("navigate(reportHref({ id: r.id }), { replace: true });");
    expect(page).toContain("navigate(reportHref({ preset: p.key }), { replace: true });");
    expect(page).toContain('aria-label="Copy a link to this report"');
  });

  it("the page shows how many in all, pages, and a totals row over every row", () => {
    const page = read("client/src/pages/usip/Reports.tsx");
    expect(page).toContain("offset: page * spec.limit");
    expect(page).toContain('aria-label="Next page"');
    expect(page).toContain('aria-label="Previous page"');
    expect(page).toContain("<tfoot>");
    expect(page).toContain('<optgroup label="By date (day, week or month)">');
    expect(page).toContain('<select aria-label="Date bucket"');
  });

  it("the tiles count every row, not the page", () => {
    const html = renderToStaticMarkup(createElement(ReportInsights, {
      result: { grouped: false, total: 1234, totals: { value: 9999 }, totalKinds: { value: "sum" }, columns: [{ key: "name", label: "Name", kind: "text" }, { key: "value", label: "Value", kind: "number" }], rows: [{ name: "a", value: 1 }] },
      viz: "bar", accent: "#000",
    }));
    expect(html).toContain("1,234");
    expect(html).toContain("9,999");
    const grouped = renderToStaticMarkup(createElement(ReportInsights, {
      result: { grouped: true, total: 40, totals: { agg: 500, n: 60 }, columns: [{ key: "group", label: "Stage", kind: "text" }, { key: "agg", label: "Sum of Value", kind: "number" }, { key: "n", label: "Rows", kind: "number" }], rows: [{ group: "x", agg: 5, n: 1 }] },
      viz: "bar", accent: "#000",
    }));
    expect(grouped).toContain(">40<");
    expect(grouped).toContain(">500<");
  });
});
