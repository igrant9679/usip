/**
 * Meeting Scheduler — the autonomous AI engine behind /v2/meetings.
 *
 * Goal: get sales meetings booked with as little human interaction as possible.
 *   • proposeMeetingForProspect — computes real open time slots from the owner's
 *     calendar (busy events in calendarEvents), asks the workspace LLM (shared
 *     invokeLLM) to draft a title + invite message, and stores a `meetings` row
 *     in status 'proposed'.
 *   • sendMeetingInvite — books it: if the owner has a connected calendar account
 *     it creates a real provider event (invite sent to the attendee) by reusing
 *     the existing createCalendarAdapter; otherwise it records the meeting locally
 *     and flags inviteSent=false (never falsely claims an invite went out).
 *   • runMeetingAutopilotAllWorkspaces — cron: for each workspace whose
 *     meetingAutopilotMode != 'off', propose meetings for the best-fit prospects
 *     that don't have one yet (respecting the daily cap); in 'auto' it also
 *     sends each new invite. Best-effort — one failure never aborts the batch.
 *
 * Compliance: never targets prospects with verificationStatus='rejected'.
 * Modes: 'approval' proposes and a person edits/approves each invite;
 * 'auto' (Autonomous) also sends each NEW proposal's invite as soon as it is
 * drafted. Autonomous was removed on 2026-09-24 (migration 0188 moved every
 * 'auto' to 'approval') and restored the same day at the owner's ask, once
 * sending could not double-book, book outside 9–16, invite nobody, or count
 * an unanswered invite as a booking. Autonomous never sends proposals that
 * were already waiting in the queue: those still need Approve & send.
 */
import { archivedWorkspaceIds } from "../_core/workspaceArchive";
import { and, eq, gte, inArray, isNotNull, isNull, lt, lte, ne, or, sql } from "drizzle-orm";
import { calendarAccounts, calendarEvents, contacts, leads, meetings, prospects, workspaceMembers, workspaceSettings, workspaces } from "../../drizzle/schema";
import { getDb } from "../db";
import { invokeLLM } from "../_core/llm";
import { HUMAN_COPY_RULES, humanizeAiCopy } from "./humanCopy";
import { buildBrandContext } from "./brandContext";
import { createCalendarAdapter } from "../calendarAdapter";
import { attributeMeetingBookingToAre } from "../routers/are/execution";
// One slot generator + one timezone rule, shared with the booking link. See
// shared/availability.ts for why this cannot import them from bookingLinks.ts.
import { formatInZone, generateSlots, safeTimezone } from "@shared/availability";
import { getWorkspaceTimezone } from "./workspaceTimezone";
import { rankOf } from "../_core/workspace";
import { activeMemberIds } from "../_core/activeMembers";
import { liveMeetingStatuses, remindableMeetingStatuses } from "@shared/meetingStatus";

// Every offerable time derives from the workspace's configured zone rather than
// the host's clock — the container runs on UTC, which is a deployment detail, not
// a property of the person being offered the slot.
// getWorkspaceTimezone lives in services/workspaceTimezone.ts, shared with the
// Tasks "due today" counter and the activity heatmap, which had the same bug.

export type MeetingAutopilotMode = "off" | "approval" | "auto";

/**
 * 🔴 THIS ARRAY WAS MISSING `rescheduled`, and it is the autopilot's dedupe —
 * "does this prospect already have a live meeting?". A prospect who moved their
 * meeting stopped counting, so the engine read them as unbooked and proposed a
 * SECOND one; in `auto` mode that is a second invite to somebody who has just
 * told us when they are free. Now @shared/meetingStatus, where the same
 * question is answered once.
 */
const ACTIVE_MEETING_STATUSES = liveMeetingStatuses();
// Highest privilege first, derived from the one rank map (_core/workspace.ts).
// This file had the hierarchy written out BACKWARDS as its own constant — a
// second place to update, inverted, and easy to miss.

/**
 * Business-hour slots that don't overlap busy events, in the WORKSPACE's
 * timezone.
 *
 * ⚠️ This used to read "business-hour slots (10:00 / 14:00 local)" and build them
 * with `setHours()` + `getDay()`. Local means the Node process's timezone, which
 * in production is UTC — so the meeting autopilot proposed 10:00 and 14:00 UTC,
 * i.e. **6am and 10am to an Eastern prospect**, and decided "is this a weekend?"
 * in UTC as well. That is the identical defect SESSION_STATUS records for the
 * booking link ("It was UTC, which offered prospects 4am ET"), fixed there and
 * missed here — in the path that mails a stranger a proposal.
 *
 * Now one generator for both (@shared/availability), given the proposal window
 * below in the workspace's zone and a 24h minimum notice, sampled hourly so a
 * 2-slot proposal still lands mid-morning and mid-afternoon rather than
 * back-to-back at 09:00.
 */
/**
 * The hours an offered time may START in, inclusive, in the workspace's zone
 * (owner ask 2026-09-24: "suggested dates/times range from 9am - 4pm EST").
 * Was 9:00–17:00. A 30-minute meeting offered at 16:00 ends by 16:30.
 */
export const PROPOSAL_FIRST_START_HOUR = 9;
export const PROPOSAL_LAST_START_HOUR = 16;

export function computeSlots(
  busy: { startAt: Date | string | null; endAt: Date | string | null }[],
  count: number,
  durationMin: number,
  timezone: string,
  /** ISO start → how many of the owner's other open proposals offer it. */
  offered?: ReadonlyMap<string, number>,
): string[] {
  const ranges = busy
    .filter((b) => b.startAt && b.endAt)
    .map((b) => ({ startAt: new Date(b.startAt as any), endAt: new Date(b.endAt as any) }));
  const all = generateSlots(ranges, 60, Date.now(), {
    timezone,
    startHour: PROPOSAL_FIRST_START_HOUR,
    // The generator samples hourly and its endHour is the first hour a slot
    // may NOT start in (start + 60 min must fit), hence LAST_START + 1.
    endHour: PROPOSAL_LAST_START_HOUR + 1,
    // A proposal that lands in someone's inbox tonight must not offer 9am
    // tomorrow: the meeting is negotiated by email, not booked on the spot.
    leadMs: 24 * 60 * 60 * 1000,
    maxSlots: 200,
  });
  // Prefer 10:00 and 14:00 in the rep's own zone, the two times the old code
  // aimed at — then fall back to anything else in the window so a busy calendar
  // still yields a proposal.
  const zone = safeTimezone(timezone);
  const hourIn = (iso: string) =>
    Number(new Intl.DateTimeFormat("en-US", { timeZone: zone, hour: "2-digit", hour12: false })
      .format(new Date(iso)).replace(/\D/g, "")) % 24;
  const preferred = all.filter((s) => hourIn(s) === 10 || hourIn(s) === 14);
  const rest = all.filter((s) => !preferred.includes(s));
  // Least-offered first (2026-09-24): every CommunityForce proposal offered
  // the same three times, so approving them in bulk booked 33 prospects into
  // one slot. The sort is stable, so among equally-offered slots the order
  // above still decides, and with nothing offered yet this is the old pick.
  const ordered = [...preferred, ...rest]
    .map((s, i) => ({ s, i, n: offered?.get(s) ?? 0 }))
    .sort((a, b) => a.n - b.n || a.i - b.i)
    .map((x) => x.s);
  const picked = ordered.slice(0, count);
  // A slot list must be chronological — the LLM is told to reference these in
  // order and the first one is what `sendMeetingInvite` books by default.
  return picked.sort();
}

interface ProspectLike {
  id: number;
  firstName: string;
  lastName: string;
  title?: string | null;
  company?: string | null;
  industry?: string | null;
  email?: string | null;
}

export interface MeetingTarget {
  ownerUserId: number | null;
  relatedType?: string | null;   // "prospect" | "contact" | "lead" | ...
  relatedId?: number | null;
  name: string;                  // attendee name
  firstName?: string;
  email?: string | null;
  company?: string | null;
  descriptor?: string;           // extra context for the LLM (title/industry/reply gist)
  source?: "manual" | "ai" | "are" | "inbound";
}

/**
 * The member chosen to own new proposals (workspace_settings.
 * meetingProposalOwnerUserId; owner ask 2026-09-24: CommunityForce's
 * proposals should be Khaja Syed's, so their invites send from his
 * calendar). Null when unset, or when that member has since left: the
 * caller's own owner stands, as it did before the setting existed.
 */
export async function configuredProposalOwner(workspaceId: number): Promise<number | null> {
  const db = await getDb();
  if (!db) return null;
  const [row] = await db.select({ owner: workspaceSettings.meetingProposalOwnerUserId })
    .from(workspaceSettings).where(eq(workspaceSettings.workspaceId, workspaceId)).limit(1);
  const owner = row?.owner ?? null;
  if (!owner) return null;
  const stillHere = await activeMemberIds(workspaceId, [owner]);
  return stillHere.has(owner) ? owner : null;
}

/**
 * Draft + persist a proposed meeting for any target (prospect, contact, or an
 * inbound reply's sender). Computes real open slots from the owner's calendar,
 * asks the LLM to draft a title + invite, inserts a `meetings` row. Returns id.
 */
export async function createMeetingProposal(workspaceId: number, target: MeetingTarget): Promise<number | null> {
  const db = await getDb();
  if (!db) return null;
  // The workspace's proposal owner, when set, owns EVERY new proposal: the
  // autopilot, Find meetings with AI, Propose meeting, a positive reply. It
  // is resolved BEFORE drafting because the offered times come from the
  // owner's calendar.
  const ownerUserId = (await configuredProposalOwner(workspaceId)) ?? target.ownerUserId ?? null;
  const draft = await draftProposalContent(workspaceId, { ...target, ownerUserId });
  try {
    const ins = await db.insert(meetings).values({
      workspaceId,
      ownerUserId,
      relatedType: target.relatedType ?? null,
      relatedId: target.relatedId ?? null,
      contactName: target.name || "there",
      contactEmail: target.email ?? null,
      company: target.company ?? null,
      title: draft.title,
      status: "proposed",
      proposedTimes: draft.slots,
      durationMin: draft.durationMin,
      inviteMessage: draft.inviteMessage,
      source: target.source ?? "ai",
      aiReasoning: draft.reasoning || null,
      aiConfidence: draft.confidence,
    } as never);
    return Number((ins as any)[0]?.insertId ?? 0) || null;
  } catch (e) {
    console.error(`[MeetingScheduler] insert failed:`, e);
    return null;
  }
}

/**
 * The owner's busy times read LIVE from the calendar their invites send from
 * (the row sendMeetingInvite books on). Stored calendar_events alone missed
 * them: a Unipile-bridged calendar only lands there on a manual sync, so an
 * owner who never pressed Sync was offered times they were already booked
 * (found 2026-09-24 regenerating CommunityForce's proposals around Khaja
 * Syed's calendar: lastSyncAt null, no stored events). Cached per calendar
 * for five minutes so a Regenerate all pass reads each calendar once, not
 * once per proposal. Best-effort: a provider failure leaves the stored events
 * to decide, as before.
 */
const LIVE_BUSY_TTL_MS = 5 * 60_000;
const liveBusyCache = new Map<number, { at: number; busy: { startAt: Date; endAt: Date }[] }>();

export function __resetLiveBusyCacheForTests(): void {
  liveBusyCache.clear();
}

async function liveOwnerBusy(
  workspaceId: number,
  ownerUserId: number,
  from: Date,
  to: Date,
): Promise<{ startAt: Date; endAt: Date }[]> {
  const db = await getDb();
  if (!db) return [];
  const [acc] = await db.select().from(calendarAccounts)
    .where(and(eq(calendarAccounts.workspaceId, workspaceId), eq(calendarAccounts.userId, ownerUserId)))
    .limit(1);
  if (!acc) return [];
  const hit = liveBusyCache.get(acc.id);
  if (hit && Date.now() - hit.at < LIVE_BUSY_TTL_MS) return hit.busy;
  try {
    const events = await createCalendarAdapter(acc as any).listEvents(acc.calendarId ?? "primary", from, to);
    const busy = events.map((e) => ({ startAt: new Date(e.startAt), endAt: new Date(e.endAt) }));
    liveBusyCache.set(acc.id, { at: Date.now(), busy });
    return busy;
  } catch (e) {
    console.error(`[MeetingScheduler] live calendar read failed for calendar ${acc.id}:`, e instanceof Error ? e.message : String(e));
    return [];
  }
}

/**
 * Everything that makes a time unbookable for the owner right now: their
 * booked meetings in Velocity plus their live calendar, read fresh (not the
 * drafting cache: a bulk approve books one slot after another). A calendar
 * read failure leaves the Velocity bookings to decide.
 */
async function takenRanges(
  workspaceId: number,
  ownerUserId: number,
  acc: any,
  meetingId: number,
  from: Date,
  to: Date,
): Promise<{ startAt: Date; endAt: Date }[]> {
  const { booked } = await ownerCommitments(workspaceId, ownerUserId, meetingId);
  try {
    const events = await createCalendarAdapter(acc).listEvents(acc.calendarId ?? "primary", from, to);
    return booked.concat(events.map((e) => ({ startAt: new Date(e.startAt), endAt: new Date(e.endAt) })));
  } catch (e) {
    console.error(`[MeetingScheduler] live calendar check failed for meeting ${meetingId}:`, e instanceof Error ? e.message : String(e));
    return booked;
  }
}

/**
 * What the owner has already committed inside Velocity: how often each time
 * is offered by their other open proposals, and the meetings already booked
 * for them (invites out, or a time agreed through a booking link). The live
 * calendar can lag a booking; these rows cannot, which is what stops a bulk
 * approve booking everyone into one slot.
 */
async function ownerCommitments(
  workspaceId: number,
  ownerUserId: number,
  excludeMeetingId?: number,
): Promise<{ offered: Map<string, number>; booked: { startAt: Date; endAt: Date }[] }> {
  const offered = new Map<string, number>();
  const booked: { startAt: Date; endAt: Date }[] = [];
  const db = await getDb();
  if (!db) return { offered, booked };
  const rows = await db.select({
    id: meetings.id, status: meetings.status, proposedTimes: meetings.proposedTimes,
    scheduledAt: meetings.scheduledAt, durationMin: meetings.durationMin,
  }).from(meetings).where(and(
    eq(meetings.workspaceId, workspaceId),
    eq(meetings.ownerUserId, ownerUserId),
    inArray(meetings.status, ACTIVE_MEETING_STATUSES),
  ));
  for (const r of rows) {
    if (r.id === excludeMeetingId) continue;
    if (r.scheduledAt) {
      const s = new Date(r.scheduledAt);
      booked.push({ startAt: s, endAt: new Date(s.getTime() + (r.durationMin ?? 30) * 60000) });
    } else if (r.status === "proposed") {
      for (const t of Array.isArray(r.proposedTimes) ? (r.proposedTimes as string[]) : []) {
        const ms = Date.parse(t);
        if (!Number.isFinite(ms)) continue;
        const k = new Date(ms).toISOString();
        offered.set(k, (offered.get(k) ?? 0) + 1);
      }
    }
  }
  return { offered, booked };
}

/**
 * The drafting core createMeetingProposal and regenerateMeetingProposal
 * share: fresh FUTURE slots from the owner's current calendar, and an LLM
 * title + invite in the workspace's own voice. Extracted 2026-09-20 so
 * regeneration can never drift from first-time proposal quality.
 */
async function draftProposalContent(workspaceId: number, target: MeetingTarget, opts: { excludeMeetingId?: number } = {}) {
  const db = await getDb();

  const durationMin = 30;
  const ownerUserId = target.ownerUserId ?? null;
  let busy: { startAt: Date | string | null; endAt: Date | string | null }[] = [];
  let offered: Map<string, number> | undefined;
  if (db && ownerUserId) {
    const from = new Date();
    const to = new Date(Date.now() + 14 * 86400000);
    busy = await db
      .select({ startAt: calendarEvents.startAt, endAt: calendarEvents.endAt })
      .from(calendarEvents)
      .where(and(
        eq(calendarEvents.workspaceId, workspaceId),
        eq(calendarEvents.userId, ownerUserId),
        gte(calendarEvents.startAt, from),
        lte(calendarEvents.startAt, to),
      ));
    busy = busy.concat(await liveOwnerBusy(workspaceId, ownerUserId, from, to));
    const mine = await ownerCommitments(workspaceId, ownerUserId, opts.excludeMeetingId);
    busy = busy.concat(mine.booked);
    offered = mine.offered;
  }
  // The workspace's own timezone (workspace_settings.timezone, default "UTC").
  // Settings.tsx describes it as "used for scheduling, reporting, and activity
  // timestamps" and until now NOTHING read it — a saved setting enforced by
  // nothing, on the screen that promises it governs scheduling.
  const workspaceTz = await getWorkspaceTimezone(workspaceId);
  const slots = computeSlots(busy, 3, durationMin, workspaceTz, offered);
  const name = target.name || "there";
  const firstName = target.firstName || name.split(" ")[0] || "there";

  // Who the SENDER is. Without this the model had no identity to represent,
  // and the prompt's example title literally said "Velocity <> Acme" — so
  // proposals marketed the PLATFORM instead of the workspace's own brand
  // (owner report 2026-08-26). The brand block is the ONE workspace voice
  // (buildBrandContext), same as every other generation surface.
  const wsRow = db ? (await db.select({ name: workspaces.name }).from(workspaces)
    .where(eq(workspaces.id, workspaceId)).limit(1))[0] : undefined;
  const senderCompany = wsRow?.name?.trim() || "our team";
  const brandBlock = await buildBrandContext(workspaceId);

  const prompt = `You are an SDR at ${senderCompany}, booking an intro meeting with a prospect about ${senderCompany}'s own products and services. Represent ${senderCompany} only — never pitch, name, or allude to any software platform used to send or schedule this message. Draft a concise, friendly meeting proposal. Return JSON only.
${brandBlock ? `\n${brandBlock}\n` : ""}
Attendee: ${name}${target.descriptor ? ` — ${target.descriptor}` : ""}${target.company ? ` at ${target.company}` : ""}
Duration: ${durationMin} minutes
Candidate times (already chosen — reference them exactly as written, including the timezone, and do not invent new ones): ${slots.map((s) => formatInZone(s, workspaceTz)).join("; ") || "to be proposed"}

Return: {
  "title": "<short meeting title, e.g. '${senderCompany} <> ${target.company || "Acme"} intro'>",
  "inviteMessage": "<2-3 sentence invite proposing the times, warm and specific>",
  "reasoning": "<one sentence: why this meeting, now>",
  "confidence": <integer 0-100>
}

${HUMAN_COPY_RULES}`;

  let title = `Intro meeting — ${name}`;
  let inviteMessage = `Hi ${firstName}, I'd love to set up a quick ${durationMin}-minute intro. Would any of these times work?`;
  let reasoning = "";
  let confidence = 60;
  try {
    const res = await invokeLLM({
      messages: [{ role: "user", content: prompt }],
      // outputSchema forces valid JSON for Anthropic (see taskAutopilot note).
      outputSchema: {
        name: "meeting_proposal",
        schema: {
          type: "object",
          properties: {
            title: { type: "string" },
            inviteMessage: { type: "string" },
            reasoning: { type: "string" },
            confidence: { type: "integer" },
          },
          required: ["title", "inviteMessage", "reasoning", "confidence"],
        },
      },
      max_tokens: 400,
      workspaceId,
    });
    const parsed = JSON.parse(res.choices?.[0]?.message?.content ?? "{}");
    if (parsed.title) title = humanizeAiCopy(String(parsed.title).slice(0, 240));
    if (parsed.inviteMessage) inviteMessage = humanizeAiCopy(String(parsed.inviteMessage).slice(0, 1500));
    reasoning = String(parsed.reasoning ?? "").slice(0, 500);
    confidence = Math.max(0, Math.min(100, Math.round(Number(parsed.confidence ?? 60)) || 60));
  } catch (e) {
    console.error(`[MeetingScheduler] LLM draft failed for ${target.relatedType ?? "target"} ${target.relatedId ?? "?"}:`, e);
  }

  return { slots, durationMin, title, inviteMessage, reasoning, confidence };
}

/**
 * Regenerate a stale proposal IN PLACE (owner ask 2026-09-20): fresh future
 * slots and a fresh invite on the SAME row, so links and the autopilot's
 * has-a-live-meeting dedupe stay stable. Four surfaces had promised a
 * "regenerate" while nothing implemented it.
 */
export async function regenerateMeetingProposal(workspaceId: number, meetingId: number): Promise<{ ok: boolean; reason?: string }> {
  const db = await getDb();
  if (!db) return { ok: false, reason: "db_unavailable" };
  const [m] = await db.select().from(meetings)
    .where(and(eq(meetings.workspaceId, workspaceId), eq(meetings.id, meetingId))).limit(1);
  if (!m) return { ok: false, reason: "not_found" };
  if (m.status !== "proposed") return { ok: false, reason: "not_a_proposal" };
  // A row with a scheduledAt is an AGREED time (booking links set it at
  // insert) — regenerating would overwrite a real commitment with invented
  // slots. Refuse, whatever the status says (audit 2026-09-20).
  if (m.scheduledAt) return { ok: false, reason: "already_scheduled" };
  // The target rebuilds from the row's own denormalized columns; only the
  // descriptor (title/industry colour for the LLM) needs a lookup, and only
  // for prospect-linked rows.
  let descriptor: string | undefined;
  if (m.relatedType === "prospect" && m.relatedId) {
    const [p] = await db.select({ title: prospects.title, industry: prospects.industry }).from(prospects)
      .where(and(eq(prospects.workspaceId, workspaceId), eq(prospects.id, m.relatedId))).limit(1);
    if (p) descriptor = `${p.title ?? "unknown title"}${p.industry ? `, industry ${p.industry}` : ""}`;
  }
  const draft = await draftProposalContent(workspaceId, {
    ownerUserId: m.ownerUserId ?? null,
    relatedType: m.relatedType,
    relatedId: m.relatedId,
    name: m.contactName ?? "there",
    firstName: (m.contactName ?? "").split(" ")[0] || undefined,
    email: m.contactEmail,
    company: m.company,
    descriptor,
    source: (m.source as MeetingTarget["source"]) ?? "ai",
  }, { excludeMeetingId: meetingId }); // its own old offers must not count against it
  await db.update(meetings).set({
    title: draft.title,
    proposedTimes: draft.slots,
    inviteMessage: draft.inviteMessage,
    aiReasoning: draft.reasoning || null,
    aiConfidence: draft.confidence,
  } as never).where(and(eq(meetings.workspaceId, workspaceId), eq(meetings.id, meetingId)));
  return { ok: true };
}

/**
 * Does a proposal need fresh times? Yes when every offered time has passed
 * (it can neither send nor be re-proposed: it holds the dedupe slot), or when
 * ANY offered time starts outside the proposal window — times drafted before
 * the window moved to 9:00–16:00 (2026-09-24), or in a zone the workspace has
 * since changed. An unreadable time cannot be offered either. A row with NO
 * times is a creation failure, not staleness: left alone. Pure, so the rule
 * is tested directly.
 */
export function proposalIsOutdated(times: unknown, timezone: string, nowMs: number): boolean {
  const list = Array.isArray(times) ? times.filter((t): t is string => typeof t === "string") : [];
  if (list.length === 0) return false;
  let anyFuture = false;
  for (const t of list) {
    const ms = new Date(t).getTime();
    if (!Number.isFinite(ms)) return true;
    if (ms > nowMs) anyFuture = true;
    if (!startsInProposalWindow(t, timezone)) return true;
  }
  return !anyFuture;
}

/**
 * Does this time START inside the proposal window (9:00–16:00) in the given
 * zone? The one window test, shared by staleness, sending and editing. An
 * unreadable time is outside it.
 */
export function startsInProposalWindow(time: string | Date, timezone: string): boolean {
  const ms = new Date(time).getTime();
  if (!Number.isFinite(ms)) return false;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: safeTimezone(timezone), hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(ms));
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? 0) % 24;
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  const mins = h * 60 + m;
  return mins >= PROPOSAL_FIRST_START_HOUR * 60 && mins <= PROPOSAL_LAST_START_HOUR * 60;
}

/**
 * Freshen outdated proposals (proposalIsOutdated), bounded. Runs from the
 * autopilot tick (so the backlog can never accumulate again) and from the
 * Meetings page's "Regenerate outdated" button.
 *
 * Unattended (the tick): only the autopilot's own proposals — never a
 * booking-link row (an agreed time carries scheduledAt) and never an inbound
 * or manual one. Attended (`anySource`, the button): every proposal in the
 * queue without an agreed time, because the owner pressed it knowing what it
 * does (owner ask 2026-09-24: "regenerate all existing meeting invites in the
 * queue"). `remaining` is what is still outdated after this pass, so the
 * page can say whether another pass is needed. Regeneration never sends.
 */
export async function regenerateStaleProposals(
  workspaceId: number,
  limit: number,
  opts?: { anySource?: boolean },
): Promise<{ regenerated: number; remaining: number }> {
  const db = await getDb();
  if (!db) return { regenerated: 0, remaining: 0 };
  const where = [
    eq(meetings.workspaceId, workspaceId),
    eq(meetings.status, "proposed"),
    isNull(meetings.scheduledAt),
  ];
  if (!opts?.anySource) where.push(eq(meetings.source, "ai"));
  const rows = await db.select({ id: meetings.id, proposedTimes: meetings.proposedTimes }).from(meetings)
    .where(and(...where))
    .orderBy(meetings.id);
  const tz = await getWorkspaceTimezone(workspaceId);
  const nowMs = Date.now();
  const outdated = rows.filter((r) => proposalIsOutdated(r.proposedTimes, tz, nowMs));
  let done = 0;
  for (const r of outdated) {
    if (done >= limit) break;
    const res = await regenerateMeetingProposal(workspaceId, r.id);
    if (res.ok) done++;
  }
  return { regenerated: done, remaining: outdated.length - done };
}

/**
 * Rewrite EVERY open proposal once (owner ask 2026-09-24: new brand messaging
 * must reach the invites already in the queue, not only new ones). A pass is
 * anchored at `since`, the moment it started, and takes proposals not touched
 * since then: regeneration bumps updatedAt, so repeated clicks walk the queue
 * instead of rewriting the same ten. Any source; never a row with an agreed
 * time. Never sends.
 */
export async function regenerateProposalsNotSince(
  workspaceId: number,
  since: Date,
  limit: number,
): Promise<{ regenerated: number; remaining: number }> {
  const db = await getDb();
  if (!db) return { regenerated: 0, remaining: 0 };
  const rows = await db.select({ id: meetings.id }).from(meetings)
    .where(and(
      eq(meetings.workspaceId, workspaceId),
      eq(meetings.status, "proposed"),
      isNull(meetings.scheduledAt),
      lt(meetings.updatedAt, since),
    ))
    .orderBy(meetings.id);
  let done = 0;
  for (const r of rows) {
    if (done >= limit) break;
    const res = await regenerateMeetingProposal(workspaceId, r.id);
    if (res.ok) done++;
  }
  return { regenerated: done, remaining: rows.length - done };
}

/** Draft + persist a proposed meeting for one prospect. Returns the new meeting id (or null). */
export async function proposeMeetingForProspect(
  workspaceId: number,
  prospect: ProspectLike,
  ownerUserId: number | null,
  source: "manual" | "ai" | "are" | "inbound" = "ai",
): Promise<number | null> {
  return createMeetingProposal(workspaceId, {
    ownerUserId,
    relatedType: "prospect",
    relatedId: prospect.id,
    name: `${prospect.firstName} ${prospect.lastName}`.trim(),
    firstName: prospect.firstName,
    email: prospect.email,
    company: prospect.company,
    descriptor: `${prospect.title ?? "unknown title"}${prospect.industry ? `, industry ${prospect.industry}` : ""}`,
    source,
  });
}

export interface SendInviteResult { sent: boolean; scheduledAt: string | null; reason?: string }

/** Book a proposed meeting: send a real calendar invite if a calendar is connected, else record locally. */
export async function sendMeetingInvite(workspaceId: number, meetingId: number, chosenTime?: string): Promise<SendInviteResult> {
  const db = await getDb();
  if (!db) return { sent: false, scheduledAt: null, reason: "no_db" };

  const [m] = await db.select().from(meetings).where(and(eq(meetings.id, meetingId), eq(meetings.workspaceId, workspaceId)));
  if (!m) return { sent: false, scheduledAt: null, reason: "not_found" };
  // No attendee, no invite (2026-09-24): 8 of CommunityForce's bulk-approved
  // proposals had no email, and each still booked a Teams meeting on the
  // owner's calendar with nobody invited, marked "scheduled, invite sent".
  if (!m.contactEmail?.trim()) return { sent: false, scheduledAt: null, reason: "no_attendee_email" };
  // One live invite per person (2026-09-24): a duplicate prospect record, or
  // a second proposal for the same address, must not send them another.
  const [already] = await db.select({ id: meetings.id }).from(meetings).where(and(
    eq(meetings.workspaceId, workspaceId),
    ne(meetings.id, meetingId),
    sql`lower(${meetings.contactEmail}) = ${m.contactEmail.trim().toLowerCase()}`,
    inArray(meetings.status, remindableMeetingStatuses()),
    gte(meetings.scheduledAt, new Date()),
  )).limit(1);
  if (already) return { sent: false, scheduledAt: null, reason: "already_invited" };

  const times = Array.isArray(m.proposedTimes) ? (m.proposedTimes as string[]) : [];

  /**
   * A proposal does not expire, so its times go stale where they sit. Live on
   * 2026-08-16: of 129 proposals in one workspace, 81 held ONLY past times and
   * 10 were part-past — and nothing anywhere compared a proposed time to the
   * clock. Approving one booked a real calendar event in the past, marked the
   * meeting `scheduled`, stamped `inviteSent`, and credited the ARE campaign
   * with a booking, then emailed the prospect an invitation to a meeting that
   * had already happened.
   *
   * The guard lives HERE rather than on the button because this is the one
   * path both the UI and the autonomous scheduler go through — the same reason
   * the LinkedIn gate and bookSlotForLink are single chokepoints. A disabled
   * button protects the person who can already see the date; it does nothing
   * for the unattended path working through a backlog.
   *
   * With no explicit choice, pick the earliest time still in the FUTURE rather
   * than times[0]. "Here are three times that suit me" means the offer, not
   * the first array element — and defaulting to a stale slot is what made the
   * default action the harmful one.
   */
  const nowMs = Date.now();
  const isFuture = (t: string) => { const ms = new Date(t).getTime(); return Number.isFinite(ms) && ms > nowMs; };
  // Offered times must start inside 9:00–16:00 in the workspace's CURRENT
  // zone (2026-09-24: LSI Media's proposals were drafted while its zone was
  // UTC, so "10:00" meant 6:00 AM Eastern by the time they were approved,
  // and 98 meetings were booked at 6 AM). A time the prospect already agreed
  // (scheduledAt) is theirs and is not second-guessed.
  const tz = await getWorkspaceTimezone(workspaceId);
  const inWindow = (t: string) => startsInProposalWindow(t, tz);
  const offerable = times.filter(isFuture).filter(inWindow).sort();
  const when = chosenTime
    ?? (m.scheduledAt ? new Date(m.scheduledAt).toISOString() : undefined)
    ?? offerable[0];
  if (!when) {
    // Distinguish "never had times" from "had times, all expired" from "has
    // future times, none in the window": each needs regenerating, and a
    // caller that cannot tell them apart cannot say anything useful.
    const reason = times.some(isFuture) ? "outside_window" : times.length ? "all_times_expired" : "no_time";
    return { sent: false, scheduledAt: null, reason };
  }
  let start = new Date(when);
  if (!Number.isFinite(start.getTime())) return { sent: false, scheduledAt: null, reason: "invalid_time" };
  if (start.getTime() <= nowMs) return { sent: false, scheduledAt: null, reason: "time_in_past" };
  if (chosenTime && !m.scheduledAt && !inWindow(chosenTime)) return { sent: false, scheduledAt: null, reason: "outside_window" };
  const durMs = (m.durationMin ?? 30) * 60000;
  let end = new Date(start.getTime() + durMs);

  // Owner's connected calendar (if any) → send a real provider invite.
  let acc: any = null;
  if (m.ownerUserId) {
    const rows = await db.select().from(calendarAccounts)
      .where(and(eq(calendarAccounts.workspaceId, workspaceId), eq(calendarAccounts.userId, m.ownerUserId)));
    acc = rows[0] ?? null;
  }

  /**
   * Never book a slot the owner is already booked in (2026-09-24: a bulk
   * approve booked 17 CommunityForce prospects into one 2 PM slot, every
   * proposal having offered the same times). Checked against the owner's
   * booked meetings in Velocity, which cannot lag, and their live calendar.
   * A time the approver picked is refused when taken; with no pick, the
   * next free offered time is booked instead. A time the prospect already
   * agreed (scheduledAt, from a booking link) is theirs and is not moved.
   */
  if (acc && m.ownerUserId && !m.scheduledAt) {
    const candidates = chosenTime ? [start] : offerable.map((t) => new Date(t));
    const last = candidates[candidates.length - 1];
    const taken = await takenRanges(workspaceId, m.ownerUserId, acc, meetingId, candidates[0], new Date(last.getTime() + durMs));
    const free = candidates.find((c) => !taken.some((r) => r.startAt.getTime() < c.getTime() + durMs && r.endAt.getTime() > c.getTime()));
    if (!free) return { sent: false, scheduledAt: null, reason: chosenTime ? "time_taken" : "all_times_taken" };
    start = free;
    end = new Date(free.getTime() + durMs);
  }

  if (acc) {
    try {
      const adapter = createCalendarAdapter(acc);
      const attendees = m.contactEmail ? [{ email: m.contactEmail, name: m.contactName ?? undefined }] : undefined;
      // The join link (owner ask 2026-09-24): an alternate link set on the
      // proposal is used as-is and written into the invite text; otherwise
      // the calendar generates a Microsoft Teams meeting, whose join details
      // Microsoft adds to the invite itself.
      const altLink = m.meetingUrl?.trim() || null;
      const result = await adapter.createEvent(acc.calendarId ?? "primary", {
        title: m.title,
        description: [m.inviteMessage ?? "", altLink ? `Join: ${altLink}` : ""].filter(Boolean).join("\n\n") || undefined,
        startAt: start,
        endAt: end,
        attendees,
        meetingUrl: altLink ?? undefined,
        onlineMeeting: altLink ? undefined : "teams",
      });
      const ins = await db.insert(calendarEvents).values({
        workspaceId,
        userId: m.ownerUserId,
        calendarAccountId: acc.id,
        externalId: result.externalId,
        title: result.title,
        description: result.description,
        location: result.location,
        meetingUrl: result.meetingUrl,
        startAt: result.startAt,
        endAt: result.endAt,
        allDay: result.allDay,
        attendees: result.attendees,
        relatedType: m.relatedType,
        relatedId: m.relatedId,
      } as never);
      const calEventId = Number((ins as any)[0]?.insertId ?? 0) || null;
      /**
       * An invite is not a booking (owner ask 2026-09-24: "Count bookings
       * only when the prospect accepts"). A time WE offered is `invited`
       * until the attendee accepts on the calendar (meetingResponses reads
       * the answer back and books it then); counting it at send stopped 22
       * CommunityForce prospects' sequences for meetings nobody had agreed
       * to. A time the prospect already picked (scheduledAt, a booking link)
       * is agreed, so it is booked now.
       */
      const agreed = !!m.scheduledAt;
      await db.update(meetings).set({
        status: agreed ? "scheduled" : "invited", scheduledAt: start, inviteSent: true,
        attendeeResponse: agreed ? "accepted" : "none", attendeeRespondedAt: agreed ? new Date() : null,
        calendarEventId: calEventId, calendarAccountId: acc.id, meetingUrl: result.meetingUrl ?? null,
      } as never).where(eq(meetings.id, meetingId));
      // The drafting cache no longer knows this slot is taken.
      liveBusyCache.delete(acc.id);
      // Count toward the ARE campaign KPI (non-blocking, deduped, no-op for a
      // non-ARE attendee): now only for an agreed time.
      if (agreed) void attributeMeetingBookingToAre(workspaceId, { id: meetingId, contactEmail: m.contactEmail });
      return { sent: true, scheduledAt: start.toISOString() };
    } catch (e) {
      console.error(`[MeetingScheduler] provider send failed for meeting ${meetingId}:`, e);
      // fall through to local record
    }
  }

  /**
   * No calendar connected (or the provider failed): the invite did NOT reach
   * the attendee, so NOTHING here may claim it did. This used to "book
   * locally" — status 'scheduled', a scheduledAt the prospect never agreed
   * to, an ARE meeting_booked signal that flipped the queue row to 'replied'
   * and bumped the campaign KPI — manufacturing counterparty agreement out
   * of thin air (owner: "did it invent the meetings?", 2026-08-28; migration
   * 0175 deleted the accumulated phantoms). A system with no delivery
   * channel cannot claim a response. The row stays a PROPOSAL; deliberate
   * out-of-band bookings (agreed by phone) go through meetings.create or
   * reschedule, where a human asserts the agreement themselves.
   */
  return { sent: false, scheduledAt: null, reason: acc ? "provider_error" : "no_calendar_connected" };
}

function startOfUtcDay(): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/**
 * Pick the highest-privilege ACTIVE member of a workspace to own
 * autopilot-created meetings.
 *
 * The rank sort made the omission bite hardest: a deactivated super_admin
 * sorts to the top, so the first person to be offboarded from a small
 * workspace would silently own every meeting the autopilot booked afterwards —
 * on a calendar nobody connects and against a notification nobody reads.
 */
async function pickWorkspaceOwner(db: any, workspaceId: number): Promise<number | null> {
  const members = await db.select({ userId: workspaceMembers.userId, role: workspaceMembers.role })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), isNull(workspaceMembers.deactivatedAt)));
  if (!members.length) return null;
  members.sort((a: any, b: any) => rankOf(b.role) - rankOf(a.role));
  return members[0]?.userId ?? null;
}

/**
 * Propose meetings for a single workspace's best-fit prospects. Exposed for
 * the on-demand "Find meetings with AI" button too. With `send` (Autonomous)
 * each new proposal's invite goes out as soon as it is drafted, through
 * sendMeetingInvite and every guard it applies; otherwise it waits for a
 * person to approve it.
 */
export async function runMeetingAutopilotForWorkspace(
  workspaceId: number,
  limit: number,
  ownerUserId?: number | null,
  opts: { send?: boolean } = {},
): Promise<{ proposed: number; sent: number; skipped: number }> {
  const db = await getDb();
  if (!db) return { proposed: 0, sent: 0, skipped: 0 };

  const fallbackOwner = ownerUserId !== undefined ? ownerUserId : await pickWorkspaceOwner(db, workspaceId);

  // Best-AVAILABLE prospects, never suppressed/rejected. We deliberately do NOT
  // hard-gate on confidenceScore >= 70: on real workspaces most prospects are
  // unscored, so that gate found nobody and the autopilot never proposed a
  // meeting. Instead take the highest-scored first (NULLs last via DESC) so the
  // engine always has candidates; approval mode lets a human vet each proposal.
  const candidates = await db
    .select()
    .from(prospects)
    .where(and(
      eq(prospects.workspaceId, workspaceId),
      or(isNull(prospects.verificationStatus), ne(prospects.verificationStatus, "rejected")),
      // An invite needs somewhere to go: a prospect with no email can never
      // be sent one, so proposing to them only fills the review queue.
      isNotNull(prospects.email),
      ne(prospects.email, ""),
    ))
    .orderBy(sql`${prospects.confidenceScore} DESC`, sql`${prospects.updatedAt} DESC`)
    .limit(limit * 5);

  if (!candidates.length) return { proposed: 0, sent: 0, skipped: 0 };

  // Skip prospects that already have an active meeting.
  const ids = candidates.map((p: any) => p.id);
  const existing = await db.select({ relatedId: meetings.relatedId }).from(meetings)
    .where(and(
      eq(meetings.workspaceId, workspaceId),
      eq(meetings.relatedType, "prospect"),
      inArray(meetings.relatedId, ids),
      inArray(meetings.status, ACTIVE_MEETING_STATUSES),
    ));
  const busy = new Set(existing.map((r: any) => r.relatedId));
  // And prospects whose EMAIL already has one (2026-09-24): the same person
  // can exist as several prospect rows (CommunityForce had Erika Donalds
  // three times), and the id check above let each copy get its own
  // proposal, which Autonomous would send as its own invite.
  const emailOf = (p: any) => String(p.email ?? "").trim().toLowerCase();
  const emails = Array.from(new Set(candidates.map(emailOf).filter(Boolean)));
  const liveByEmail = emails.length ? await db.select({ contactEmail: meetings.contactEmail }).from(meetings)
    .where(and(
      eq(meetings.workspaceId, workspaceId),
      inArray(meetings.contactEmail, emails),
      inArray(meetings.status, ACTIVE_MEETING_STATUSES),
    )) : [];
  const busyEmails = new Set(liveByEmail.map((r: any) => String(r.contactEmail ?? "").trim().toLowerCase()));

  // Per-prospect owner: assign each meeting to the rep who owns the prospect's
  // linked contact/lead, so on 'auto' the invite sends from THAT rep's own
  // Outlook (multi-user). Falls back to the acting user / a workspace admin.
  const contactIds = [...new Set(candidates.map((p: any) => p.linkedContactId).filter(Boolean))];
  const leadIds = [...new Set(candidates.map((p: any) => p.linkedLeadId).filter(Boolean))];
  const cOwners = contactIds.length ? await db.select({ id: contacts.id, owner: contacts.ownerUserId }).from(contacts).where(and(eq(contacts.workspaceId, workspaceId), inArray(contacts.id, contactIds))) : [];
  const lOwners = leadIds.length ? await db.select({ id: leads.id, owner: leads.ownerUserId }).from(leads).where(and(eq(leads.workspaceId, workspaceId), inArray(leads.id, leadIds))) : [];
  // Only owners who still WORK here: contact/lead rows keep their ownerUserId
  // after offboarding, and an invite that books onto a leaver's calendar is
  // the exact gap _core/activeMembers closes. Departed owners fall through to
  // the fallback (already active-filtered by pickWorkspaceOwner).
  const stillHere = await activeMemberIds(
    workspaceId,
    cOwners.map((r: any) => r.owner).concat(lOwners.map((r: any) => r.owner)),
  );
  const cMap = new Map(cOwners.filter((r: any) => stillHere.has(r.owner)).map((r: any) => [r.id, r.owner]));
  const lMap = new Map(lOwners.filter((r: any) => stillHere.has(r.owner)).map((r: any) => [r.id, r.owner]));
  const ownerFor = (p: any): number | null =>
    (p.linkedContactId && cMap.get(p.linkedContactId)) || (p.linkedLeadId && lMap.get(p.linkedLeadId)) || fallbackOwner;

  let proposed = 0, sent = 0, skipped = 0;
  for (const p of candidates) {
    if (proposed >= limit) break;
    if (busy.has(p.id) || busyEmails.has(emailOf(p))) { skipped++; continue; }
    const id = await proposeMeetingForProspect(workspaceId, p, ownerFor(p), "ai");
    if (!id) continue;
    proposed++;
    busy.add(p.id);
    busyEmails.add(emailOf(p));
    if (opts.send) {
      const r = await sendMeetingInvite(workspaceId, id);
      if (r.sent) sent++;
      // Say why, or "Autonomous proposes but nothing sends" is undiagnosable.
      else console.log(`[MeetingAutopilot] ws ${workspaceId}: proposal ${id} not sent (${r.reason ?? "unknown"})`);
    }
  }
  return { proposed, sent, skipped };
}

/** Cron entry: run the meeting autopilot for every workspace with mode != 'off'. */
export async function runMeetingAutopilotAllWorkspaces(): Promise<{ workspaces: number; proposed: number }> {
  const db = await getDb();
  if (!db) return { workspaces: 0, proposed: 0 };

  const rows = await db.select().from(workspaceSettings).where(ne(workspaceSettings.meetingAutopilotMode, "off"));
  const dayStart = startOfUtcDay();
  let workspaces = 0, proposed = 0;

    const archivedWs = await archivedWorkspaceIds();
  for (const ws of rows) {
    if (archivedWs.has(ws.workspaceId)) continue; // archived workspaces are frozen (2026-08-12)
    const cap = ws.meetingAutopilotDailyCap ?? 10;
    try {
      // Regenerate outdated proposals FIRST (owner ask 2026-09-20): a proposal
      // whose every offered time has passed can neither send nor be
      // re-proposed (it holds the dedupe slot), so the backlog only ever
      // grew — 99 rows on LSI by the time this shipped. Bounded per tick.
      // And BEFORE the daily cap check (2026-09-24): regeneration creates no
      // meeting, so the cap on NEW proposals must not gate it — it did, and a
      // workspace that hit its cap left its backlog stale until midnight UTC.
      const swept = await regenerateStaleProposals(ws.workspaceId, 10);
      if (swept.regenerated > 0) console.log(`[MeetingAutopilot] ws ${ws.workspaceId}: regenerated ${swept.regenerated} outdated proposal(s), ${swept.remaining} left`);

      const [row] = await db.select({ n: sql<number>`count(*)` }).from(meetings)
        .where(and(eq(meetings.workspaceId, ws.workspaceId), eq(meetings.source, "ai"), gte(meetings.createdAt, dayStart)));
      const remaining = cap - Number(row?.n ?? 0);
      if (remaining <= 0) continue;

      const send = ws.meetingAutopilotMode === "auto";
      const r = await runMeetingAutopilotForWorkspace(ws.workspaceId, Math.min(remaining, 10), undefined, { send });
      proposed += r.proposed;
      workspaces++;
      await db.update(workspaceSettings).set({ meetingAutopilotLastRunAt: new Date() } as never)
        .where(eq(workspaceSettings.workspaceId, ws.workspaceId));
      if (r.proposed > 0) console.log(`[MeetingAutopilot] ws ${ws.workspaceId} (${send ? "autonomous" : "approval"}): proposed ${r.proposed}, sent ${r.sent}, skipped ${r.skipped}`);
    } catch (e) {
      console.error(`[MeetingAutopilot] ws ${ws.workspaceId} failed:`, e);
    }
  }
  return { workspaces, proposed };
}
