/**
 * activityMetrics.ts — the one place the NON-revenue numbers are computed
 * (audit 2026-10-20, F44; the email half is O42). Deal and revenue numbers are
 * dealMetrics.ts, and this file follows its pattern: every number a screen
 * shows is a named definition below — its population, its window and the
 * time zone its days are cut in — and every screen that shows one reads it
 * from here.
 *
 * 🔴 THE BUG (G53–G57, O42). Each screen did its own arithmetic over the same
 * tables and they disagreed: Email Analytics counted "Emails sent" as draft
 * plus Revenue Engine sends while the Emails page, Analytics and Home counted
 * the sitewide send log; the bounce rate's denominator counted LinkedIn steps
 * as emails; Home's sparklines cut UTC days; reply counts were written four
 * times; and "reply rate" was promised and never computed.
 *
 * Who reads what:
 *   emails sent ........ Home and Dashboard (24 h), Analytics, the Emails page,
 *                        Email Analytics
 *   engagement ......... Analytics, the Emails page, Email Analytics (rates,
 *                        bounce rate denominator)
 *   replies ............ Home and Dashboard (24 h), Analytics, the Emails page,
 *                        Conversations
 *   daily series ....... Home's sparklines
 *   leads .............. Dashboard (and Analytics through the same procedure)
 *   activities ......... Dashboards (activity widgets)
 */
import { and, desc, eq, exists, gt, gte, inArray, isNotNull, lt, ne, sql, type SQL } from "drizzle-orm";
import {
  activities, areExecutionQueue, emailDrafts, emailLog, emailReplies, leads, meetings, prospectQueue, websiteVisits,
} from "../../drizzle/schema";
import type { getDb } from "../db";
import { genuineReplyScope } from "./replyScope";
import { dayIn, lastDays, seriesSince } from "./email/trackingSeries";
import { monthToDateRanges, type Range } from "./dealMetrics";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

/** A half-open window [start, end). Either end may be open. */
export type MetricWindow = { start?: Date; end?: Date };

export type MetricDefinition = {
  label: string;
  /** What is counted. */
  population: string;
  /** Over what time, unless the screen states its own window. */
  window: string;
  /** The zone its days are cut in, when it has days. */
  timeZone: "workspace" | "none";
};

/** The named definitions. A screen that shows one of these numbers says so in these words. */
export const ACTIVITY_METRICS = {
  emailsSent: {
    label: "Emails sent",
    population: "Every message the workspace transmitted, from the sitewide send log (email_log, status sent): sequences, drafts, Revenue Engine campaigns, the mailbox, proposals and notifications.",
    window: "All time, or the window the screen names (Home: the last 24 hours).",
    timeZone: "none",
  },
  trackedSends: {
    label: "Tracked sends",
    population: "The sends engagement can be measured on: sequence, CRM and AI-draft emails marked sent (email_drafts), and Revenue Engine campaign emails marked sent (are_execution_queue, email channel). Counted per path, never blended where a path cannot produce the number.",
    window: "All time.",
    timeZone: "none",
  },
  openRate: {
    label: "Open rate",
    population: "Tracked sends opened at least once by a person (machine prefetches excluded), over all tracked sends.",
    window: "All time.",
    timeZone: "none",
  },
  clickRate: {
    label: "Click rate",
    population: "Sequence, CRM and AI-draft emails with a tracked click, over those emails. Revenue Engine links are not rewritten (cold outbound deliverability), so campaign clicks are counted as site visits instead.",
    window: "All time.",
    timeZone: "none",
  },
  campaignSiteVisits: {
    label: "Campaign site visits",
    population: "Revenue Engine recipients who opened your own site from a link in a campaign email: a visit carrying the signed visitor id campaign links add (F40), at or after their first campaign email.",
    window: "All time (visitor ids are on links sent since 2026-11-07).",
    timeZone: "none",
  },
  replyRate: {
    label: "Reply rate",
    population: "From matched replies only (services/replyScope). Sequence, CRM and AI-draft emails: sent emails a reply was matched to, over sent emails. Revenue Engine: people emailed whose reply was matched to the campaign, over people emailed. Two units, so never blended.",
    window: "All time.",
    timeZone: "none",
  },
  replies: {
    label: "Replies",
    population: "Genuine replies: inbound mail matched to something Velocity sent (a draft or a campaign enrolment; services/replyScope). Never the rest of a synced mailbox.",
    window: "All time, or the window the screen names (Home: the last 24 hours).",
    timeZone: "none",
  },
  activitiesPerDay: {
    label: "Activities logged",
    population: "Activities by when they happened (occurredAt).",
    window: "The last N calendar days, today included.",
    timeZone: "workspace",
  },
  meetingsPerDay: {
    label: "Meetings",
    population: "Meetings with a time on that day (scheduledAt): invited, scheduled, rescheduled, completed or no-show; not a proposed candidate and not a cancelled one.",
    window: "The last N calendar days, today included.",
    timeZone: "workspace",
  },
  repliesPerDay: {
    label: "Replies",
    population: "Genuine replies by when they arrived (receivedAt).",
    window: "The last N calendar days, today included.",
    timeZone: "workspace",
  },
  activeLeads: {
    label: "Active leads",
    population: "Leads still being worked: not unqualified and not converted.",
    window: "Now.",
    timeZone: "none",
  },
  leadsCreated: {
    label: "New leads",
    population: "Leads created, by when they were created (createdAt).",
    window: "This month to date, against the same days of last month.",
    timeZone: "workspace",
  },
  activityCounts: {
    label: "Activities",
    population: "Activities logged, by type (calls, emails, meetings), optionally one person's.",
    window: "The dates the screen picks, as workspace days.",
    timeZone: "workspace",
  },
} as const satisfies Record<string, MetricDefinition>;

export type ActivityMetricKey = keyof typeof ACTIVITY_METRICS;

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** n of `of`, as a whole percent; 0 of nothing is 0, not NaN. */
export const pct = (n: number, of: number): number => (of > 0 ? Math.round((n / of) * 100) : 0);

const within = (col: any, w?: MetricWindow): SQL[] => {
  const out: SQL[] = [];
  if (w?.start) out.push(gte(col, w.start));
  if (w?.end) out.push(lt(col, w.end));
  return out;
};

/** The last `hours` hours up to `now`, as Home's "24h" tiles read them. */
export function lastHours(hours: number, now: Date = new Date()): MetricWindow {
  return { start: new Date(now.getTime() - hours * 3_600_000), end: new Date(now.getTime() + 1) };
}

/* ── Emails sent ─────────────────────────────────────────────────────────── */

/** ACTIVITY_METRICS.emailsSent, and failed sends beside it, optionally one campaign's. */
export async function emailsSent(
  db: Db,
  ws: number,
  opts: { window?: MetricWindow; campaignId?: number } = {},
): Promise<{ sent: number; failed: number }> {
  const scope = [eq(emailLog.workspaceId, ws), ...within(emailLog.sentAt, opts.window)];
  if (opts.campaignId) scope.push(eq(emailLog.campaignId, opts.campaignId));
  const count = (more: SQL) => db.select({ n: sql<number>`count(*)` }).from(emailLog).where(and(...scope, more));
  const [sent, failed] = await Promise.all([count(eq(emailLog.status, "sent")), count(eq(emailLog.status, "failed"))]);
  return { sent: num(sent[0]?.n), failed: num(failed[0]?.n) };
}

/** The sent log per source (the Emails page's chips and Analytics' outreach line). */
export async function emailsSentBySource(db: Db, ws: number, opts: { campaignId?: number } = {}): Promise<Array<{ source: string; count: number }>> {
  const rows = await db.select({ source: emailLog.source, n: sql<number>`count(*)` }).from(emailLog)
    .where(and(eq(emailLog.workspaceId, ws), eq(emailLog.status, "sent"), opts.campaignId ? eq(emailLog.campaignId, opts.campaignId) : undefined))
    .groupBy(emailLog.source);
  return rows.map((r) => ({ source: String(r.source), count: num(r.n) }));
}

/* ── Engagement: the two tracked paths ───────────────────────────────────── */

export type EmailEngagement = {
  /** Sequence, CRM and AI-draft email marked sent. */
  draft: { sent: number; opened: number; clicked: number; bounced: number; replied: number; opens: number; clicks: number };
  /** Revenue Engine campaign email marked sent. Clicks are not tracked on this path (links are not rewritten). */
  campaign: { sent: number; opened: number; people: number; repliedPeople: number; siteVisitors: number };
  trackedSent: number;
  rates: {
    open: number; draftOpen: number; campaignOpen: number;
    /** Draft path only: the one path with click tracking. */
    click: number;
    /** Campaign recipients who visited your site from a campaign link, over people emailed. */
    campaignSiteVisit: number;
    /** Per email (draft path) and per person (campaign): two units, never blended. */
    draftReply: number; campaignReply: number;
  };
};

/**
 * ACTIVITY_METRICS.trackedSends with what happened to them. Each path is
 * counted on the rows that own its counters, each rate over the sends that
 * can produce it. With a campaign, the draft path is empty: no draft belongs
 * to a Revenue Engine campaign.
 */
export async function emailEngagement(db: Db, ws: number, opts: { campaignId?: number } = {}): Promise<EmailEngagement> {
  const drafts = [eq(emailDrafts.workspaceId, ws), eq(emailDrafts.status, "sent")];
  const draftCount = (...more: SQL[]) => db.select({ n: sql<number>`count(*)` }).from(emailDrafts).where(and(...drafts, ...more));
  const sends = [
    eq(areExecutionQueue.workspaceId, ws),
    eq(areExecutionQueue.channel, "email"),
    eq(areExecutionQueue.status, "sent"),
    ...(opts.campaignId ? [eq(areExecutionQueue.campaignId, opts.campaignId)] : []),
  ];
  const sendCount = (...more: SQL[]) => db.select({ n: sql<number>`count(*)` }).from(areExecutionQueue).where(and(...sends, ...more));
  /** A campaign recipient who was sent at least one campaign email. */
  const emailed = () => exists(db.select({ one: sql`1` }).from(areExecutionQueue).where(and(
    eq(areExecutionQueue.prospectQueueId, prospectQueue.id),
    eq(areExecutionQueue.workspaceId, prospectQueue.workspaceId),
    eq(areExecutionQueue.channel, "email"),
    eq(areExecutionQueue.status, "sent"),
  )));
  const recipients = [eq(prospectQueue.workspaceId, ws), ...(opts.campaignId ? [eq(prospectQueue.campaignId, opts.campaignId)] : [])];

  const noDrafts = !!opts.campaignId;
  const zero = Promise.resolve([{ n: 0 }]);
  const [dSent, dOpened, dClicked, dBounced, dReplied, dTotals, cSent, cOpened, cPeople, replyRows, visitRows] = await Promise.all([
    noDrafts ? zero : draftCount(),
    noDrafts ? zero : draftCount(gt(emailDrafts.openCount, 0)),
    noDrafts ? zero : draftCount(gt(emailDrafts.clickCount, 0)),
    noDrafts ? zero : draftCount(isNotNull(emailDrafts.bouncedAt)),
    // A sent email a matched reply answers (reply matching is exact since F5).
    noDrafts ? zero : draftCount(exists(db.select({ one: sql`1` }).from(emailReplies).where(and(
      eq(emailReplies.draftId, emailDrafts.id),
      eq(emailReplies.workspaceId, emailDrafts.workspaceId),
      genuineReplyScope(),
    )))),
    noDrafts
      ? Promise.resolve([{ opens: 0, clicks: 0 }])
      : db.select({ opens: sql<number>`sum(${emailDrafts.openCount})`, clicks: sql<number>`sum(${emailDrafts.clickCount})` }).from(emailDrafts).where(and(...drafts)),
    sendCount(),
    sendCount(isNotNull(areExecutionQueue.openedAt)),
    db.select({ n: sql<number>`count(*)` }).from(prospectQueue).where(and(...recipients, emailed())),
    // People whose reply was matched to a campaign: one row each (bounded by
    // the people who replied; email_replies has no index on the person).
    db.select({ pq: emailReplies.prospectQueueId, n: sql<number>`count(*)` }).from(emailReplies)
      .where(and(eq(emailReplies.workspaceId, ws), isNotNull(emailReplies.campaignId), isNotNull(emailReplies.prospectQueueId), genuineReplyScope(),
        ...(opts.campaignId ? [eq(emailReplies.campaignId, opts.campaignId)] : [])))
      .groupBy(emailReplies.prospectQueueId),
    // Signed site visits that name a People row, newest first and bounded.
    db.select({ person: websiteVisits.prospectId, at: websiteVisits.createdAt }).from(websiteVisits)
      .where(and(eq(websiteVisits.workspaceId, ws), eq(websiteVisits.signed, true), isNotNull(websiteVisits.prospectId)))
      .orderBy(desc(websiteVisits.createdAt)).limit(SITE_VISIT_SCAN),
  ]);

  // Replied people who were emailed (a matched campaign reply from someone the
  // campaign only reached on LinkedIn is not an email reply).
  const repliedIds = replyRows.map((r) => Number(r.pq)).filter((n) => Number.isFinite(n) && n > 0);
  const repliedPeople = repliedIds.length
    ? num((await db.select({ n: sql<number>`count(*)` }).from(prospectQueue)
        .where(and(...recipients, inArray(prospectQueue.id, repliedIds), emailed())))[0]?.n)
    : 0;

  // Site visitors: a recipient whose latest signed visit came at or after their
  // first campaign email.
  const lastVisit = new Map<number, number>();
  for (const v of visitRows) {
    const id = Number(v.person);
    const at = v.at ? new Date(v.at as Date).getTime() : NaN;
    if (Number.isFinite(at) && at > (lastVisit.get(id) ?? -Infinity)) lastVisit.set(id, at);
  }
  let siteVisitors = 0;
  if (lastVisit.size) {
    const pqs = await db.select({ id: prospectQueue.id, person: prospectQueue.personProspectId }).from(prospectQueue)
      .where(and(...recipients, inArray(prospectQueue.personProspectId, Array.from(lastVisit.keys()))));
    if (pqs.length) {
      const firstSend = new Map<number, number>();
      const sendsOf = await db.select({ pq: areExecutionQueue.prospectQueueId, at: areExecutionQueue.executedAt }).from(areExecutionQueue)
        .where(and(...sends, inArray(areExecutionQueue.prospectQueueId, pqs.map((p) => p.id)), isNotNull(areExecutionQueue.executedAt)));
      for (const s of sendsOf) {
        const at = new Date(s.at as Date).getTime();
        const id = Number(s.pq);
        if (Number.isFinite(at) && at < (firstSend.get(id) ?? Infinity)) firstSend.set(id, at);
      }
      for (const p of pqs) {
        const sent = firstSend.get(p.id);
        const visit = p.person != null ? lastVisit.get(Number(p.person)) : undefined;
        if (sent !== undefined && visit !== undefined && visit >= sent) siteVisitors++;
      }
    }
  }

  const draft = {
    sent: num(dSent[0]?.n), opened: num(dOpened[0]?.n), clicked: num(dClicked[0]?.n), bounced: num(dBounced[0]?.n),
    replied: num(dReplied[0]?.n), opens: num(dTotals[0]?.opens), clicks: num(dTotals[0]?.clicks),
  };
  const campaign = { sent: num(cSent[0]?.n), opened: num(cOpened[0]?.n), people: num(cPeople[0]?.n), repliedPeople, siteVisitors };
  const trackedSent = draft.sent + campaign.sent;
  return {
    draft, campaign, trackedSent,
    rates: {
      open: pct(draft.opened + campaign.opened, trackedSent),
      draftOpen: pct(draft.opened, draft.sent),
      campaignOpen: pct(campaign.opened, campaign.sent),
      click: pct(draft.clicked, draft.sent),
      campaignSiteVisit: pct(campaign.siteVisitors, campaign.people),
      draftReply: pct(draft.replied, draft.sent),
      campaignReply: pct(campaign.repliedPeople, campaign.people),
    },
  };
}

/** How many signed visits are read to find campaign site visitors: the newest, which is where they are. */
const SITE_VISIT_SCAN = 5000;

/* ── Replies ─────────────────────────────────────────────────────────────── */

/** The one WHERE for ACTIVITY_METRICS.replies. */
export function genuineRepliesWhere(ws: number, w?: MetricWindow): SQL {
  return and(eq(emailReplies.workspaceId, ws), genuineReplyScope(), ...within(emailReplies.receivedAt, w))!;
}

export async function countReplies(db: Db, ws: number, w?: MetricWindow): Promise<number> {
  const [r] = await db.select({ n: sql<number>`count(*)` }).from(emailReplies).where(genuineRepliesWhere(ws, w));
  return num(r?.n);
}

/** Conversations' header over the same replies: total and how many still need someone. */
export async function replySummary(db: Db, ws: number): Promise<{ total: number; unhandled: number; needsClassify: number; willingToMeet: number; meetingsProposed: number }> {
  const [row] = await db.select({
    total: sql<number>`count(*)`,
    unhandled: sql<number>`sum(case when ${emailReplies.handledAt} is null then 1 else 0 end)`,
    needsClassify: sql<number>`sum(case when ${emailReplies.classifiedAt} is null then 1 else 0 end)`,
    willingToMeet: sql<number>`sum(case when ${emailReplies.replyClass} = 'willing_to_meet' then 1 else 0 end)`,
    meetingsProposed: sql<number>`sum(case when ${emailReplies.autoActionTaken} = 'meeting_proposed' then 1 else 0 end)`,
  }).from(emailReplies).where(genuineRepliesWhere(ws));
  return {
    total: num(row?.total),
    unhandled: num(row?.unhandled),
    needsClassify: num(row?.needsClassify),
    willingToMeet: num(row?.willingToMeet),
    meetingsProposed: num(row?.meetingsProposed),
  };
}

/* ── Daily series, on the workspace's days ───────────────────────────────── */

const MEETING_DAY_STATUSES = ["invited", "scheduled", "rescheduled", "completed", "no_show"] as const;

/**
 * activitiesPerDay / meetingsPerDay / repliesPerDay over the last `days`
 * calendar days in `tz`, oldest first, today last. Only the rows that can land
 * in those days are read, then bucketed by the day they fall on in `tz`: Home
 * cut UTC days, so an Eastern evening's replies sat on tomorrow's bar.
 */
export async function dailyCounts(
  db: Db,
  ws: number,
  metric: "activities" | "meetings" | "replies",
  days: number,
  tz: string,
  nowMs: number = Date.now(),
): Promise<number[]> {
  const keys = lastDays(days, tz, nowMs);
  const since = seriesSince(days, nowMs);
  const rows: Array<{ at: unknown }> = metric === "activities"
    ? await db.select({ at: activities.occurredAt }).from(activities).where(and(eq(activities.workspaceId, ws), gte(activities.occurredAt, since)))
    : metric === "meetings"
      ? await db.select({ at: meetings.scheduledAt }).from(meetings).where(and(eq(meetings.workspaceId, ws), gte(meetings.scheduledAt, since), inArray(meetings.status, [...MEETING_DAY_STATUSES])))
      : await db.select({ at: emailReplies.receivedAt }).from(emailReplies).where(genuineRepliesWhere(ws, { start: since }));
  const byDay = new Map(keys.map((k) => [k, 0]));
  for (const r of rows) {
    const ms = r.at ? new Date(r.at as Date).getTime() : NaN;
    if (!Number.isFinite(ms)) continue;
    const k = dayIn(ms, tz);
    if (byDay.has(k)) byDay.set(k, byDay.get(k)! + 1);
  }
  return keys.map((k) => byDay.get(k)!);
}

/* ── Leads ───────────────────────────────────────────────────────────────── */

/** activeLeads and leadsCreated (month to date against the same days of last month). */
export async function leadCounts(db: Db, ws: number, tz: string, now: Date = new Date()): Promise<{ active: number; createdThisMonth: number; createdSameDaysLastMonth: number }> {
  const span = monthToDateRanges(tz, now);
  const createdIn = (r: Range) => and(eq(leads.workspaceId, ws), gte(leads.createdAt, r.start), lt(leads.createdAt, r.end));
  const count = (where: SQL | undefined) => db.select({ n: sql<number>`count(*)` }).from(leads).where(where);
  const [active, nowRows, prevRows] = await Promise.all([
    count(and(eq(leads.workspaceId, ws), ne(leads.status, "unqualified"), ne(leads.status, "converted"))),
    count(createdIn(span.current)),
    count(createdIn(span.previous)),
  ]);
  return { active: num(active[0]?.n), createdThisMonth: num(nowRows[0]?.n), createdSameDaysLastMonth: num(prevRows[0]?.n) };
}

/* ── Activities ──────────────────────────────────────────────────────────── */

/** The WHERE for ACTIVITY_METRICS.activityCounts: a window (inclusive ends, as the dashboard ranges are) and one person. */
export function activitiesWhere(ws: number, f: { from?: Date | null; to?: Date | null; actorUserId?: number | null } = {}, ...more: SQL[]): SQL {
  const conds: SQL[] = [eq(activities.workspaceId, ws), ...more];
  if (f.actorUserId) conds.push(eq(activities.actorUserId, f.actorUserId));
  // Bound as raw instants, as the dashboard ranges always were (dashboardPresetDates pins them).
  if (f.from) conds.push(sql`${activities.occurredAt} >= ${f.from}`);
  if (f.to) conds.push(sql`${activities.occurredAt} <= ${f.to}`);
  return and(...conds)!;
}

/** Activities by type, counted in SQL. */
export async function activityCountsByType(db: Db, ws: number, f: { from?: Date | null; to?: Date | null; actorUserId?: number | null } = {}): Promise<{ total: number; calls: number; emails: number; meetings: number }> {
  const byType = await db.select({ type: activities.type, n: sql<number>`count(*)` }).from(activities).where(activitiesWhere(ws, f)).groupBy(activities.type);
  const of = (t: string) => num(byType.find((r) => r.type === t)?.n);
  return { total: byType.reduce((s, r) => s + num(r.n), 0), calls: of("call"), emails: of("email"), meetings: of("meeting") };
}
