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
 *     that don't have one yet (respecting the daily cap); in 'auto' mode it also
 *     sends the invite. Best-effort — one failure never aborts the batch.
 *
 * Compliance: never targets prospects with verificationStatus='rejected'.
 * Auto-send is opt-in per workspace (default 'off') — the toggle is the user's
 * explicit authorization for the outward action of sending an invite.
 */
import { and, eq, gte, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";
import { calendarAccounts, calendarEvents, meetings, prospects, workspaceMembers, workspaceSettings } from "../../drizzle/schema";
import { getDb } from "../db";
import { invokeLLM } from "../_core/llm";
import { createCalendarAdapter } from "../calendarAdapter";

export type MeetingAutopilotMode = "off" | "approval" | "auto";

const ACTIVE_MEETING_STATUSES = ["proposed", "invited", "scheduled"];
const ROLE_PRIORITY: Record<string, number> = { super_admin: 0, admin: 1, manager: 2, rep: 3 };

/** Generate up to `count` business-hour slots (10:00 / 14:00 local) that don't overlap busy events. */
function computeSlots(busy: { startAt: Date | string | null; endAt: Date | string | null }[], count: number, durationMin: number): string[] {
  const ranges = busy
    .filter((b) => b.startAt && b.endAt)
    .map((b) => [new Date(b.startAt as any).getTime(), new Date(b.endAt as any).getTime()] as [number, number]);
  const overlaps = (s: number, e: number) => ranges.some(([bs, be]) => s < be && e > bs);
  const nowMs = Date.now();
  const slots: string[] = [];
  let day = new Date();
  day.setDate(day.getDate() + 1); // start tomorrow
  let guard = 0;
  while (slots.length < count && guard < 21) {
    guard++;
    const dow = day.getDay();
    if (dow !== 0 && dow !== 6) {
      for (const hour of [10, 14]) {
        if (slots.length >= count) break;
        const s = new Date(day); s.setHours(hour, 0, 0, 0);
        const e = new Date(s.getTime() + durationMin * 60000);
        if (s.getTime() > nowMs && !overlaps(s.getTime(), e.getTime())) slots.push(s.toISOString());
      }
    }
    day = new Date(day.getTime() + 86400000);
  }
  return slots;
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
 * Draft + persist a proposed meeting for any target (prospect, contact, or an
 * inbound reply's sender). Computes real open slots from the owner's calendar,
 * asks the LLM to draft a title + invite, inserts a `meetings` row. Returns id.
 */
export async function createMeetingProposal(workspaceId: number, target: MeetingTarget): Promise<number | null> {
  const db = await getDb();
  if (!db) return null;

  const durationMin = 30;
  const ownerUserId = target.ownerUserId ?? null;
  let busy: { startAt: Date | string | null; endAt: Date | string | null }[] = [];
  if (ownerUserId) {
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
  }
  const slots = computeSlots(busy, 3, durationMin);
  const name = target.name || "there";
  const firstName = target.firstName || name.split(" ")[0] || "there";

  const prompt = `You are an autonomous SDR booking an intro sales meeting. Draft a concise, friendly meeting proposal. Return JSON only.

Attendee: ${name}${target.descriptor ? ` — ${target.descriptor}` : ""}${target.company ? ` at ${target.company}` : ""}
Duration: ${durationMin} minutes
Candidate times (already chosen — reference them, do not invent new ones): ${slots.map((s) => new Date(s).toLocaleString()).join("; ") || "to be proposed"}

Return: {
  "title": "<short meeting title, e.g. 'Velocity <> Acme intro'>",
  "inviteMessage": "<2-3 sentence invite proposing the times, warm and specific>",
  "reasoning": "<one sentence: why this meeting, now>",
  "confidence": <integer 0-100>
}`;

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
    if (parsed.title) title = String(parsed.title).slice(0, 240);
    if (parsed.inviteMessage) inviteMessage = String(parsed.inviteMessage).slice(0, 1500);
    reasoning = String(parsed.reasoning ?? "").slice(0, 500);
    confidence = Math.max(0, Math.min(100, Math.round(Number(parsed.confidence ?? 60)) || 60));
  } catch (e) {
    console.error(`[MeetingScheduler] LLM draft failed for ${target.relatedType ?? "target"} ${target.relatedId ?? "?"}:`, e);
  }

  try {
    const ins = await db.insert(meetings).values({
      workspaceId,
      ownerUserId,
      relatedType: target.relatedType ?? null,
      relatedId: target.relatedId ?? null,
      contactName: name,
      contactEmail: target.email ?? null,
      company: target.company ?? null,
      title,
      status: "proposed",
      proposedTimes: slots,
      durationMin,
      inviteMessage,
      source: target.source ?? "ai",
      aiReasoning: reasoning || null,
      aiConfidence: confidence,
    } as never);
    return Number((ins as any)[0]?.insertId ?? 0) || null;
  } catch (e) {
    console.error(`[MeetingScheduler] insert failed:`, e);
    return null;
  }
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

  const times = Array.isArray(m.proposedTimes) ? (m.proposedTimes as string[]) : [];
  const when = chosenTime ?? (m.scheduledAt ? new Date(m.scheduledAt).toISOString() : times[0]);
  if (!when) return { sent: false, scheduledAt: null, reason: "no_time" };
  const start = new Date(when);
  const end = new Date(start.getTime() + (m.durationMin ?? 30) * 60000);

  // Owner's connected calendar (if any) → send a real provider invite.
  let acc: any = null;
  if (m.ownerUserId) {
    const rows = await db.select().from(calendarAccounts)
      .where(and(eq(calendarAccounts.workspaceId, workspaceId), eq(calendarAccounts.userId, m.ownerUserId)));
    acc = rows[0] ?? null;
  }

  if (acc) {
    try {
      const adapter = createCalendarAdapter(acc);
      const attendees = m.contactEmail ? [{ email: m.contactEmail, name: m.contactName ?? undefined }] : undefined;
      const result = await adapter.createEvent(acc.calendarId ?? "primary", {
        title: m.title,
        description: m.inviteMessage ?? undefined,
        startAt: start,
        endAt: end,
        attendees,
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
      await db.update(meetings).set({
        status: "scheduled", scheduledAt: start, inviteSent: true,
        calendarEventId: calEventId, calendarAccountId: acc.id, meetingUrl: result.meetingUrl ?? null,
      } as never).where(eq(meetings.id, meetingId));
      return { sent: true, scheduledAt: start.toISOString() };
    } catch (e) {
      console.error(`[MeetingScheduler] provider send failed for meeting ${meetingId}:`, e);
      // fall through to local record
    }
  }

  // No calendar connected (or provider failed) — record the booking locally, invite not sent.
  await db.update(meetings).set({ status: "scheduled", scheduledAt: start, inviteSent: false } as never)
    .where(eq(meetings.id, meetingId));
  return { sent: false, scheduledAt: start.toISOString(), reason: acc ? "provider_error" : "no_calendar_connected" };
}

function startOfUtcDay(): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/** Pick the highest-privilege member of a workspace to own autopilot-created meetings. */
async function pickWorkspaceOwner(db: any, workspaceId: number): Promise<number | null> {
  const members = await db.select({ userId: workspaceMembers.userId, role: workspaceMembers.role })
    .from(workspaceMembers).where(eq(workspaceMembers.workspaceId, workspaceId));
  if (!members.length) return null;
  members.sort((a: any, b: any) => (ROLE_PRIORITY[a.role] ?? 9) - (ROLE_PRIORITY[b.role] ?? 9));
  return members[0]?.userId ?? null;
}

/**
 * Propose (and, in 'auto' mode, book) meetings for a single workspace's best-fit
 * prospects. Exposed for the on-demand "Find meetings with AI" button too.
 */
export async function runMeetingAutopilotForWorkspace(
  workspaceId: number,
  mode: "approval" | "auto",
  limit: number,
  ownerUserId?: number | null,
): Promise<{ proposed: number; sent: number; skipped: number }> {
  const db = await getDb();
  if (!db) return { proposed: 0, sent: 0, skipped: 0 };

  const owner = ownerUserId !== undefined ? ownerUserId : await pickWorkspaceOwner(db, workspaceId);

  // Best-fit prospects (hot), never suppressed/rejected.
  const candidates = await db
    .select()
    .from(prospects)
    .where(and(
      eq(prospects.workspaceId, workspaceId),
      gte(prospects.confidenceScore, 70),
      or(isNull(prospects.verificationStatus), ne(prospects.verificationStatus, "rejected")),
    ))
    .orderBy(sql`${prospects.confidenceScore} DESC`)
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

  let proposed = 0, sent = 0, skipped = 0;
  for (const p of candidates) {
    if (proposed >= limit) break;
    if (busy.has(p.id)) { skipped++; continue; }
    const id = await proposeMeetingForProspect(workspaceId, p, owner, "ai");
    if (!id) continue;
    proposed++;
    busy.add(p.id);
    if (mode === "auto") {
      const r = await sendMeetingInvite(workspaceId, id);
      if (r.sent) sent++;
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

  for (const ws of rows) {
    const mode = ws.meetingAutopilotMode as "approval" | "auto";
    const cap = ws.meetingAutopilotDailyCap ?? 10;
    try {
      const [row] = await db.select({ n: sql<number>`count(*)` }).from(meetings)
        .where(and(eq(meetings.workspaceId, ws.workspaceId), eq(meetings.source, "ai"), gte(meetings.createdAt, dayStart)));
      const remaining = cap - Number(row?.n ?? 0);
      if (remaining <= 0) continue;

      const r = await runMeetingAutopilotForWorkspace(ws.workspaceId, mode, Math.min(remaining, 10));
      proposed += r.proposed;
      workspaces++;
      await db.update(workspaceSettings).set({ meetingAutopilotLastRunAt: new Date() } as never)
        .where(eq(workspaceSettings.workspaceId, ws.workspaceId));
      if (r.proposed > 0) console.log(`[MeetingAutopilot] ws ${ws.workspaceId} (${mode}): proposed ${r.proposed}, sent ${r.sent}, skipped ${r.skipped}`);
    } catch (e) {
      console.error(`[MeetingAutopilot] ws ${ws.workspaceId} failed:`, e);
    }
  }
  return { workspaces, proposed };
}
