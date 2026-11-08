/**
 * One metrics module for the non-revenue numbers (audit 2026-10-20, F44; the
 * email half is O42): services/activityMetrics.ts names each number's
 * population, window and time zone, and every screen that shows one reads it
 * from there, so the same number never differs between screens.
 *
 * Pinned three ways: each screen's procedure returns the module's number on
 * ONE fixture (Emails page = Email Analytics = Analytics; Conversations =
 * the Emails page's inbound; Home's 24 h tiles; the Dashboard's leads; the
 * Dashboards activity widget); the module's own definitions are checked on
 * that fixture (reply rates from matched replies, campaign site visits, the
 * bounce denominator without LinkedIn steps, workspace days); and each screen's
 * source is checked to call the module rather than count for itself.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import { invalidateStageIndex } from "./_core/stageSemantics";
import { _clearWorkspaceTimezoneCache } from "./services/workspaceTimezone";
import {
  ACTIVITY_METRICS, activityCountsByType, countReplies, dailyCounts, emailEngagement, emailsSent, lastHours, leadCounts,
} from "./services/activityMetrics";

const WS = 2, FOREIGN = 9, ME = 1;
const NY = "America/New_York";
// A FIXED clock (not floating): Wednesday 2026-11-04, 15:00 UTC = 10:00 in New York (EST, UTC−5).
const NOW = Date.UTC(2026, 10, 4, 15, 0);
const ago = (hours: number) => new Date(NOW - hours * 3_600_000);
const root = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8").replace(/\r\n/g, "\n");
const rows = (t: string) => h.db.rowsOf(t) as any[];
const caller = () => appRouter.createCaller({
  user: { id: ME, openId: "u", email: "o@example.com", name: "O", loginMethod: "password", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
  req: { protocol: "https", headers: { "x-workspace-id": String(WS) } },
  res: { clearCookie: () => {} },
} as unknown as TrpcContext);

function seed() {
  h.db = makeSqlFakeDb({ realMembers: true });
  invalidateStageIndex();
  _clearWorkspaceTimezoneCache();
  rows("workspaces").push({ id: WS, name: "W", slug: "w", ownerUserId: ME, archivedAt: null, plan: "trial" });
  rows("users").push({ id: ME, name: "Me", email: "o@example.com" });
  rows("workspace_members").push({ id: 1, workspaceId: WS, userId: ME, role: "admin", deactivatedAt: null, inviteToken: null, lastActiveAt: new Date(NOW) });
  rows("workspace_settings").push({ workspaceId: WS, timezone: NY });

  // The send log: seven sent in WS on every path, one failed, and another workspace's.
  let id = 1;
  const log = (o: Record<string, unknown>) => rows("email_log").push({ id: id++, workspaceId: WS, status: "sent", campaignId: null, ...o });
  log({ source: "sequence", sentAt: ago(2) });
  log({ source: "sequence", sentAt: ago(72) });
  log({ source: "crm", sentAt: ago(80) });
  log({ source: "campaign", campaignId: 7, sentAt: ago(1) });
  log({ source: "campaign", campaignId: 7, sentAt: ago(120) });
  log({ source: "mailbox", sentAt: ago(30) });
  log({ source: "proposal", sentAt: ago(200) });
  log({ source: "sequence", status: "failed", sentAt: ago(3) });
  log({ source: "sequence", workspaceId: FOREIGN, sentAt: ago(1) });

  // Draft path: four sent (two opened, one clicked, one bounced), one awaiting review.
  const draft = (o: Record<string, unknown>) => rows("email_drafts").push({ workspaceId: WS, status: "sent", openCount: 0, clickCount: 0, bouncedAt: null, sequenceId: 1, aiGenerated: false, createdAt: ago(100), ...o });
  draft({ id: 1, openCount: 3, clickCount: 2 });
  draft({ id: 2, openCount: 1 });
  draft({ id: 3 });
  draft({ id: 4, bouncedAt: ago(50) });
  draft({ id: 5, status: "pending_review" });
  draft({ id: 6, workspaceId: FOREIGN, openCount: 5 });

  // Revenue Engine: two emails sent (one opened), a LinkedIn step sent, one email still scheduled.
  rows("prospect_queue").push(
    { id: 501, workspaceId: WS, campaignId: 7, personProspectId: 9001, sequenceStatus: "enrolled", enrichmentStatus: "complete", createdAt: ago(200) },
    { id: 502, workspaceId: WS, campaignId: 7, personProspectId: 9002, sequenceStatus: "enrolled", enrichmentStatus: "complete", createdAt: ago(200) },
    { id: 503, workspaceId: WS, campaignId: 7, personProspectId: 9003, sequenceStatus: "enrolled", enrichmentStatus: "complete", createdAt: ago(200) },
    { id: 504, workspaceId: WS, campaignId: 7, personProspectId: 9004, sequenceStatus: "enrolled", enrichmentStatus: "complete", createdAt: ago(200) },
  );
  const step = (o: Record<string, unknown>) => rows("are_execution_queue").push({ workspaceId: WS, campaignId: 7, channel: "email", status: "sent", openedAt: null, ...o });
  step({ id: 1001, prospectQueueId: 501, executedAt: ago(120), openedAt: ago(110) });
  step({ id: 1002, prospectQueueId: 502, executedAt: ago(1) });
  step({ id: 1003, prospectQueueId: 503, channel: "linkedin", executedAt: ago(5) });
  step({ id: 1004, prospectQueueId: 504, status: "scheduled", executedAt: null });

  // Replies: two to draft 1 (one email replied), one to draft 3, a campaign
  // reply from someone emailed (501), one from someone only reached on
  // LinkedIn (503), private mail, and another workspace's.
  const reply = (o: Record<string, unknown>) => rows("email_replies").push({ workspaceId: WS, draftId: null, campaignId: null, prospectQueueId: null, sendingAccountId: 1, fromEmail: "x@example.com", handledAt: null, classifiedAt: null, replyClass: null, autoActionTaken: null, ...o });
  reply({ id: 1, draftId: 1, receivedAt: ago(1) });
  reply({ id: 2, draftId: 1, receivedAt: ago(40) });
  // 22:30 on Tuesday the 3rd in New York — already Wednesday the 4th in UTC.
  reply({ id: 3, draftId: 3, receivedAt: new Date(Date.UTC(2026, 10, 4, 3, 30)), replyClass: "willing_to_meet" });
  reply({ id: 4, campaignId: 7, prospectQueueId: 501, receivedAt: ago(100) });
  reply({ id: 5, campaignId: 7, prospectQueueId: 503, receivedAt: ago(4) });
  reply({ id: 6, receivedAt: ago(2) }); // private mail
  reply({ id: 7, workspaceId: FOREIGN, draftId: 6, receivedAt: ago(1) });

  // Site visits: 9002 visited after their campaign email (signed); 9001 visited
  // before theirs (signed); 9004 was never emailed; an unsigned claim for 9001.
  rows("website_visits").push(
    { id: 1, workspaceId: WS, visitorId: "v1", prospectId: 9002, signed: true, createdAt: ago(0.5) },
    { id: 2, workspaceId: WS, visitorId: "v2", prospectId: 9001, signed: true, createdAt: ago(130) },
    { id: 3, workspaceId: WS, visitorId: "v3", prospectId: 9004, signed: true, createdAt: ago(0.5) },
    { id: 4, workspaceId: WS, visitorId: "v4", prospectId: 9001, signed: false, createdAt: ago(0.5) },
  );
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
  seed();
});
afterEach(() => { vi.useRealTimers(); _clearWorkspaceTimezoneCache(); });

describe("every number has a named definition (F44)", () => {
  it("states population, window and time zone for each", () => {
    for (const [key, d] of Object.entries(ACTIVITY_METRICS)) {
      expect(d.label, key).toBeTruthy();
      expect(d.population.length, key).toBeGreaterThan(20);
      expect(d.window.length, key).toBeGreaterThan(3);
      expect(["workspace", "none"], key).toContain(d.timeZone);
    }
    // Days are cut in the workspace's zone wherever a number has days.
    for (const k of ["activitiesPerDay", "meetingsPerDay", "repliesPerDay", "leadsCreated", "activityCounts"] as const) {
      expect(ACTIVITY_METRICS[k].timeZone).toBe("workspace");
    }
  });
});

describe("the same number on every screen, on one fixture (F44/O42)", () => {
  it("Emails sent: the Emails page, Email Analytics and the module agree, every path counted", async () => {
    const page = await caller().emailActivity.stats({ status: "sent" });
    const analytics = await caller().smtpConfig.getAnalyticsSummary();
    const mod = await emailsSent(h.db, WS);
    expect(mod).toEqual({ sent: 7, failed: 1 });
    expect(page.sent).toBe(7);
    // Email Analytics counted draft + campaign sends (6) while the Emails page counted the log (7).
    expect(analytics.totalSent).toBe(7);
    expect(page.failed).toBe(1);
  });

  it("open, click and reply rates: the Emails page and Email Analytics agree", async () => {
    const page = await caller().emailActivity.stats({ status: "sent" });
    const a = await caller().smtpConfig.getAnalyticsSummary();
    expect(page.openRate).toBe(a.openRate);
    expect(page.clickRate).toBe(a.clickRate);
    expect(page.draftReplyRate).toBe(a.draftReplyRate);
    expect(page.campaignReplyRate).toBe(a.campaignReplyRate);
    // (2 draft + 1 campaign opened) of (4 + 2) tracked; clicks over the 4 drafts only.
    expect(a).toMatchObject({ openRate: 50, clickRate: 25, trackedSent: 6, draftSent: 4, campaignSent: 2 });
  });

  it("replies: Conversations' total is the Emails page's inbound, matched replies only", async () => {
    const conv = await caller().conversations.stats();
    const page = await caller().emailActivity.stats({ status: "sent" });
    expect(await countReplies(h.db, WS)).toBe(5);
    expect(conv.total).toBe(5);
    expect(page.inbound).toBe(5);
    expect(conv.willingToMeet).toBe(1);
  });

  it("Home's and the Dashboard's 24-hour tiles are the module's emails sent and replies", async () => {
    const s = await caller().attention.summary();
    const w = lastHours(24, new Date(NOW));
    expect(s.digest24h.emailsSent).toBe((await emailsSent(h.db, WS, { window: w })).sent);
    expect(s.digest24h.emailsSent).toBe(2);
    expect(s.digest24h.repliesReceived).toBe(await countReplies(h.db, WS, w));
    // Draft 1 an hour ago, the LinkedIn-reached person 4 h ago, and the 22:30 reply 11.5 h ago.
    expect(s.digest24h.repliesReceived).toBe(3);
  });

  it("the Dashboard's leads are the module's", async () => {
    const lead = (id: number, status: string, iso: string, ws = WS) => ({ id, workspaceId: ws, firstName: "L", lastName: `${id}`, status, createdAt: new Date(iso) });
    rows("leads").push(lead(1, "new", "2026-11-02T12:00:00Z"), lead(2, "working", "2026-10-02T12:00:00Z"), lead(3, "converted", "2026-11-03T12:00:00Z"), lead(4, "unqualified", "2026-10-20T12:00:00Z"), lead(5, "new", "2026-11-02T12:00:00Z", FOREIGN));
    const d = await caller().opportunities.dashboardStats();
    const m = await leadCounts(h.db, WS, NY, new Date(NOW));
    expect(d.activeLeads).toBe(m.active);
    expect(d.leadsThisMonth).toBe(m.createdThisMonth);
    expect(m).toEqual({ active: 2, createdThisMonth: 2, createdSameDaysLastMonth: 1 });
  });

  it("the Dashboards activity widget is the module's count", async () => {
    rows("dashboards").push({ id: 1, workspaceId: WS, name: "D", ownerUserId: ME, layout: [] });
    rows("dashboard_widgets").push({ id: 1, workspaceId: WS, dashboardId: 1, type: "kpi", title: "Acts", config: { metric: "activity_counts" }, filters: null, position: { x: 0, y: 0, w: 1, h: 1 } });
    const act = (id: number, type: string, at: Date, ws = WS) => ({ id, workspaceId: ws, type, relatedType: "contact", relatedId: 1, occurredAt: at, actorUserId: ME });
    rows("activities").push(act(1, "call", ago(1)), act(2, "email", ago(30)), act(3, "meeting", ago(50)), act(4, "note", ago(2)), act(5, "call", ago(1), FOREIGN));
    const res = (await caller().dashboards.resolveWidget({ id: 1 })) as any;
    const m = await activityCountsByType(h.db, WS);
    expect(res.value).toBe(m.total);
    expect(res.breakdown).toEqual({ calls: m.calls, emails: m.emails, meetings: m.meetings });
    expect(m).toEqual({ total: 4, calls: 1, emails: 1, meetings: 1 });
  });
});

describe("the module's definitions (O42)", () => {
  it("reply rates come from matched replies: per email on the draft path, per person emailed on the campaign path", async () => {
    const e = await emailEngagement(h.db, WS);
    // Drafts 1 and 3 have matched replies (draft 1 twice: one email); private mail is nothing.
    expect(e.draft).toMatchObject({ sent: 4, replied: 2, opened: 2, clicked: 1, bounced: 1, opens: 4, clicks: 2 });
    expect(e.rates.draftReply).toBe(50);
    // 501 replied and was emailed; 503's matched reply came after LinkedIn only.
    expect(e.campaign).toMatchObject({ sent: 2, opened: 1, people: 2, repliedPeople: 1 });
    expect(e.rates.campaignReply).toBe(50);
  });

  it("campaign 'clicks' are signed site visits at or after the person's first campaign email", async () => {
    const e = await emailEngagement(h.db, WS);
    // 9002 visited after their email; 9001's signed visit came before theirs and
    // their later one is unsigned; 9004 was never emailed.
    expect(e.campaign.siteVisitors).toBe(1);
    expect(e.rates.campaignSiteVisit).toBe(50);
  });

  it("one campaign's numbers leave the draft path out", async () => {
    const e = await emailEngagement(h.db, WS, { campaignId: 7 });
    expect(e.draft.sent).toBe(0);
    expect(e.campaign.sent).toBe(2);
    const other = await emailEngagement(h.db, WS, { campaignId: 8 });
    expect(other.campaign).toMatchObject({ sent: 0, people: 0, repliedPeople: 0 });
  });

  it("the bounce rate's denominator is tracked email sends, not LinkedIn steps", async () => {
    const b = await caller().smtpConfig.getBounceStats();
    expect(b.totalSent).toBe(6); // 4 drafts + 2 campaign emails; the LinkedIn step is not an email
  });

  it("Home's sparklines are the workspace's days: an evening reply in New York lands on that evening's day", async () => {
    rows("meetings").push(
      { id: 1, workspaceId: WS, status: "scheduled", scheduledAt: new Date(Date.UTC(2026, 10, 4, 16)) },
      { id: 2, workspaceId: WS, status: "cancelled", scheduledAt: new Date(Date.UTC(2026, 10, 4, 17)) },
      { id: 3, workspaceId: WS, status: "proposed", scheduledAt: new Date(Date.UTC(2026, 10, 4, 18)) },
      // 21:00 on Monday the 2nd in New York — Tuesday the 3rd in UTC.
      { id: 4, workspaceId: WS, status: "completed", scheduledAt: new Date(Date.UTC(2026, 10, 3, 2)) },
    );
    const t = await caller().workspace.trend7d();
    // Days: Oct 29 … Nov 4 in New York; index 5 is Tuesday the 3rd, 6 is today.
    expect(t.replies).toEqual(await dailyCounts(h.db, WS, "replies", 7, NY, NOW));
    expect(t.replies[5]).toBe(1); // the 22:30 reply, not on the 4th as a UTC day would put it
    expect(t.replies[6]).toBe(2); // draft 1's reply an hour ago and the campaign reply 4 h ago
    expect(t.meetings[6]).toBe(1); // today's scheduled meeting; not the cancelled or proposed one
    expect(t.meetings[4]).toBe(1); // Monday evening's, on Monday
  });
});

describe("each screen reads the module, not its own count (F44)", () => {
  const block = (rel: string, from: string, to: string) => {
    const src = read(rel);
    const i = src.indexOf(from);
    expect(i, `${rel}: ${from}`).toBeGreaterThan(-1);
    const j = src.indexOf(to, i + from.length);
    return src.slice(i, j === -1 ? undefined : j);
  };

  it("the Emails page's stats", () => {
    const b = block("server/routers/emailActivity.ts", "  stats: workspaceProcedure", "  get: workspaceProcedure");
    expect(b).toContain("emailsSent(db, wsId, { campaignId: input.campaignId })");
    expect(b).toContain("countReplies(db, wsId)");
    expect(b).toContain("emailEngagement(db, wsId, { campaignId: input.campaignId })");
    expect(b).not.toContain(".from(emailReplies)");
  });

  it("Email Analytics' summary and bounce denominator", () => {
    const b = block("server/routers/smtpConfig.ts", "  getAnalyticsSummary: workspaceProcedure", "  /** Bounce health stats");
    expect(b).toContain("emailsSent(db, ws)");
    expect(b).toContain("emailEngagement(db, ws)");
    expect(b).not.toContain(".from(emailDrafts)");
    expect(b).not.toContain(".from(areExecutionQueue)");
    const bounce = block("server/routers/smtpConfig.ts", "  getBounceStats: workspaceProcedure", "\n});");
    expect(bounce).toContain("(await emailEngagement(db, ctx.workspace.id)).trackedSent");
  });

  it("Conversations, Home's digest and Home's sparklines", () => {
    expect(block("server/routers/conversations.ts", "  stats: workspaceProcedure", "  get: workspaceProcedure")).toContain("return replySummary(db, ctx.workspace.id);");
    const att = read("server/routers/attention.ts");
    expect(att).toContain("emailsSent(db, ws, { window: { start: since } })");
    expect(att).toContain("countReplies(db, ws, { start: since })");
    const t = block("server/routers/workspace.ts", "  trend7d: workspaceProcedure", "  switch: protectedProcedure");
    for (const m of ["activities", "meetings", "replies"]) expect(t).toContain(`dailyCounts(db, ctx.workspace.id, "${m}", 7, tz, nowMs)`);
    expect(t).not.toContain("DATE(");
    expect(t).not.toContain("setUTCHours");
  });

  it("the Dashboard's leads and the Dashboards activity widgets", () => {
    const d = block("server/routers/crm.ts", "  dashboardStats: workspaceProcedure", "  stageHistory: workspaceProcedure");
    expect(d).toContain("await leadCounts(db, wid, tz)");
    expect(d).not.toContain("countOf(leads");
    const ops = read("server/routers/operations.ts");
    expect(ops).toContain("const actBase = (...more: any[]) => activitiesWhere(workspaceId,");
    expect(ops).toContain("await activityCountsByType(db, workspaceId,");
  });

  it("the two email pages show the module's reply rate", () => {
    const ea = read("client/src/pages/usip/EmailAnalytics.tsx");
    expect(ea).toContain('label="Reply Rate"');
    expect(ea).toContain("summary.draftReplyRate");
    expect(ea).toContain("summary.campaignSiteVisitors");
    const emails = read("client/src/pages/usip/EmailsV2.tsx");
    expect(emails).toContain('<StatCard label="Reply rate" value={`${st?.draftReplyRate ?? 0}%`}');
  });
});
