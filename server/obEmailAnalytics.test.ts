/**
 * Email Analytics, audit 2026-10-20 O42 (size L; the part that removes harm).
 *
 *   • The click rate divided draft-path clicks by draft AND Revenue Engine
 *     sends, though a campaign send records no click of its own, so every
 *     campaign email pulled it down — on this page and on the Emails page.
 *     Counts are now reported per path and each rate is over the sends that
 *     can produce it.
 *   • The daily series bucketed by UTC day, over every event ever recorded.
 *     It is now the workspace's days, read for those days only.
 *   • The page promised reply rates and "AI-powered insights" that do not
 *     exist. The copy now describes what is there.
 *
 * Left (not built here): one metrics service for both pages, campaign click
 * counts, reply rates.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import type { TrpcContext } from "./_core/context";
import { areExecutionQueue, emailDrafts, emailTrackingEvents, workspaceSettings, workspaces } from "../drizzle/schema";

const h = vi.hoisted(() => ({ db: null as any, drafts: [] as any[], are: { sent: 0, opened: 0 }, events: [] as any[], tz: "America/New_York", wheres: [] as unknown[] }));
vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db }));

import { appRouter } from "./routers";
import { dayIn, lastDays, trackingSeries } from "./services/email/trackingSeries";
import { _clearWorkspaceTimezoneCache } from "./services/workspaceTimezone";

const read = (rel: string) => readFileSync(rel, "utf8").replace(/\r\n/g, "\n");
const NY = "America/New_York";

function makeDb() {
  const builder = () => {
    const st: { table?: unknown; join?: unknown } = {};
    const b: any = {
      from(t: unknown) { st.table = t; return b; },
      innerJoin(t: unknown) { st.join = t; return b; },
      leftJoin() { return b; },
      where(w: unknown) { if (st.table === emailTrackingEvents) h.wheres.push(w); return b; },
      orderBy() { return b; }, limit() { return b; }, groupBy() { return b; },
      then(res: (v: unknown) => void, rej: (e: unknown) => void) {
        let rows: unknown[] = [];
        if (st.join === workspaces) {
          rows = [{ ws: { id: 2, name: "LSI", ownerUserId: 1, archivedAt: null }, mb: { id: 1, userId: 1, workspaceId: 2, role: "admin", deactivatedAt: null, lastActiveAt: new Date() } }];
        } else if (st.table === emailDrafts) rows = h.drafts;
        else if (st.table === areExecutionQueue) rows = [h.are];
        else if (st.table === emailTrackingEvents) rows = h.events;
        else if (st.table === workspaceSettings) rows = [{ timezone: h.tz }];
        return Promise.resolve(rows).then(res, rej);
      },
    };
    return b;
  };
  return { select: () => builder(), insert: () => ({ values: () => Promise.resolve([{}]) }), update: () => ({ set: () => ({ where: () => Promise.resolve([]) }) }) };
}
const caller = () => appRouter.createCaller({
  user: { id: 1, openId: "u", email: "a@lsi.example", name: "A", loginMethod: "password", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
  req: { protocol: "https", headers: { "x-workspace-id": "2" } },
  res: { clearCookie: () => {} },
} as unknown as TrpcContext);

beforeEach(() => {
  h.db = makeDb();
  h.drafts = [];
  h.are = { sent: 0, opened: 0 };
  h.events = [];
  h.tz = NY;
  h.wheres = [];
  _clearWorkspaceTimezoneCache();
});

describe("draft-path and Revenue Engine mail are counted apart", () => {
  beforeEach(() => {
    // Ten sequence/CRM sends: four opened (one three times), two clicked.
    h.drafts = Array.from({ length: 10 }, (_, i) => ({ id: i + 1, sentAt: new Date(), openCount: i === 0 ? 3 : i < 4 ? 1 : 0, clickCount: i < 2 ? 1 : 0 }));
    // Ten campaign sends, five opened; a campaign send records no click.
    h.are = { sent: 10, opened: 5 };
  });

  it("the click rate is over the sends that can be clicked", async () => {
    const s = await caller().smtpConfig.getAnalyticsSummary();
    expect(s.clickRate).toBe(20); // 2 of 10, not 2 of 20
    expect(s.uniqueClicked).toBe(2);
  });

  it("each path's sends and opens are reported, and opened means the same on both", async () => {
    const s = await caller().smtpConfig.getAnalyticsSummary();
    expect(s).toMatchObject({ totalSent: 20, draftSent: 10, campaignSent: 10, draftOpened: 4, campaignOpened: 5, uniqueOpened: 9 });
    expect(s).toMatchObject({ openRate: 45, draftOpenRate: 40, campaignOpenRate: 50 });
  });

  it("open and click COUNTS are the draft path's own counters, not padded with campaign first-opens", async () => {
    const s = await caller().smtpConfig.getAnalyticsSummary();
    expect(s.totalOpens).toBe(6);
    expect(s.totalClicks).toBe(2);
  });

  it("the Emails page divides clicks the same way", () => {
    const src = read("server/routers/emailActivity.ts");
    expect(src).toContain("const clickableTotal = num(draftEng[0]?.sent);");
    expect(src).toContain("clickRate: clickableTotal ? Math.round((clickedTotal / clickableTotal) * 100) : 0,");
    expect(src).not.toContain("clickRate: sentTotal ?");
  });
});

describe("the daily series is the workspace's days", () => {
  // Wednesday 2026-11-04, 03:30 UTC: still Tuesday the 3rd, 22:30, in New York.
  const AT = Date.UTC(2026, 10, 4, 3, 30);

  it("an evening open in New York lands on that evening's day", () => {
    expect(dayIn(AT, NY)).toBe("2026-11-03");
    expect(dayIn(AT, "UTC")).toBe("2026-11-04");
    const s = trackingSeries([{ type: "open", createdAt: new Date(AT) }], [], 7, NY, AT + 60_000);
    expect(s.at(-1)).toEqual({ date: "2026-11-03", opens: 1, clicks: 0, bounces: 0 });
    expect(s).toHaveLength(7);
  });

  it("the window is whole calendar days, through a clock change, with none skipped or repeated", () => {
    // New York left daylight time on Sunday 2026-11-01.
    expect(lastDays(5, NY, AT)).toEqual(["2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02", "2026-11-03"]);
  });

  it("the procedure buckets on the workspace's zone and reads only the window", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(AT + 60_000));
    try {
      h.events = [{ type: "click", createdAt: new Date(AT) }, { type: "open", createdAt: new Date(AT - 400 * 86_400_000) }];
      const series = await caller().smtpConfig.getTrackingTimeSeries({ days: 7 });
      expect(series.at(-1)).toMatchObject({ date: "2026-11-03", clicks: 1 });
      expect(series.reduce((n, p) => n + p.opens, 0)).toBe(0);
      expect(h.wheres).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
    const src = read("server/routers/smtpConfig.ts");
    const fn = src.slice(src.indexOf("getTrackingTimeSeries: workspaceProcedure"), src.indexOf("getAnalyticsSummary: workspaceProcedure"));
    expect(fn).toContain("gte(emailTrackingEvents.createdAt, since)");
    expect(fn).toContain("gte(emailDrafts.bouncedAt, since)");
    expect(fn).not.toContain("toISOString().slice(0, 10)");
  });
});

describe("the page promises only what is there", () => {
  it("no reply rates, no AI insights", () => {
    const page = read("client/src/pages/usip/EmailAnalytics.tsx");
    expect(page).not.toContain("reply rates");
    expect(page).not.toContain("AI-powered insights");
    expect(page).toContain("summary.campaignSent} Revenue Engine");
    expect(page).toContain("Revenue Engine sends record no clicks here");
  });
});
