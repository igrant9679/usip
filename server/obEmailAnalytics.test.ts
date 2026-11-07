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
 *
 * 2026-11-07 (audit 2026-10-20, F44/O42): those are built now, in
 * services/activityMetrics.ts, and pinned in metrActivityMetrics.test.ts. The
 * summary counts in SQL there, so the cases below that call it run on the SQL
 * fake (makeSqlFakeDb) instead of the row-returning stub, with the same
 * fixture and the same expectations; "Emails sent" became the sitewide send
 * log (as on the Emails page), the tracked sends beside it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import type { TrpcContext } from "./_core/context";
import { areExecutionQueue, emailDrafts, emailTrackingEvents, workspaceSettings, workspaces } from "../drizzle/schema";

const h = vi.hoisted(() => ({ db: null as any, drafts: [] as any[], are: { sent: 0, opened: 0 }, events: [] as any[], tz: "America/New_York", wheres: [] as unknown[] }));
vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db }));

import { appRouter } from "./routers";
import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
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
    h.db = makeSqlFakeDb({ roles: { 2: "admin" }, wsId: () => 2 });
    const rows = (t: string) => h.db.rowsOf(t) as any[];
    rows("workspace_settings").push({ workspaceId: 2, timezone: NY });
    // Ten sequence/CRM sends: four opened (one three times), two clicked.
    for (let i = 0; i < 10; i++) rows("email_drafts").push({ id: i + 1, workspaceId: 2, status: "sent", sentAt: new Date(), openCount: i === 0 ? 3 : i < 4 ? 1 : 0, clickCount: i < 2 ? 1 : 0, bouncedAt: null });
    // Ten campaign sends, five opened; a campaign send records no click.
    for (let i = 0; i < 10; i++) rows("are_execution_queue").push({ id: 100 + i, workspaceId: 2, channel: "email", status: "sent", prospectQueueId: 500 + i, openedAt: i < 5 ? new Date() : null });
    // The send log: the twenty, plus one mailbox reply (every path counts as sent).
    for (let i = 0; i < 21; i++) rows("email_log").push({ id: i + 1, workspaceId: 2, source: i < 10 ? "sequence" : i < 20 ? "campaign" : "mailbox", status: "sent", sentAt: new Date() });
  });

  it("the click rate is over the sends that can be clicked", async () => {
    const s = await caller().smtpConfig.getAnalyticsSummary();
    expect(s.clickRate).toBe(20); // 2 of 10, not 2 of 20
    expect(s.uniqueClicked).toBe(2);
  });

  it("each path's sends and opens are reported, and opened means the same on both", async () => {
    const s = await caller().smtpConfig.getAnalyticsSummary();
    expect(s).toMatchObject({ trackedSent: 20, draftSent: 10, campaignSent: 10, draftOpened: 4, campaignOpened: 5, uniqueOpened: 9 });
    // "Emails sent" is every path, from the send log, as on the Emails page (F44).
    expect(s.totalSent).toBe(21);
    expect(s).toMatchObject({ openRate: 45, draftOpenRate: 40, campaignOpenRate: 50 });
  });

  it("open and click COUNTS are the draft path's own counters, not padded with campaign first-opens", async () => {
    const s = await caller().smtpConfig.getAnalyticsSummary();
    expect(s.totalOpens).toBe(6);
    expect(s.totalClicks).toBe(2);
  });

  it("the Emails page divides clicks the same way", async () => {
    // 2026-11-07 (F44/O42): both read activityMetrics.emailEngagement, so the
    // two pages give one click rate on one fixture.
    const src = read("server/routers/emailActivity.ts");
    expect(src).toContain("clickRate: engagement.rates.click,");
    expect(src).not.toContain("clickRate: sentTotal ?");
    const page = await caller().emailActivity.stats({ status: "sent" });
    const summary = await caller().smtpConfig.getAnalyticsSummary();
    expect(page.clickRate).toBe(summary.clickRate);
    expect(page.clickRate).toBe(20);
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
  it("no AI insights; the reply rate shown is the one computed from matched replies", () => {
    // 2026-11-07 (F44/O42): reply rates exist now (activityMetrics, matched
    // replies only), so the page may show one, and only the summary's.
    const page = read("client/src/pages/usip/EmailAnalytics.tsx");
    expect(page).not.toContain("AI-powered insights");
    expect(page).not.toMatch(/AI insights/i);
    expect(page).toContain("summary.campaignSent} Revenue Engine");
    expect(page).toContain("value={summary ? `${summary.draftReplyRate}%` : \"—\"}");
    // Campaign links are not click-tracked, and the page says so instead of a 0%.
    expect(page).toContain("Revenue Engine links aren't click-tracked");
  });
});
