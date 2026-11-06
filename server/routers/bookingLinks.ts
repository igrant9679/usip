/**
 * Booking Links — public self-serve meeting scheduling (Apollo "Meetings").
 *
 * A rep has one shareable link (/b/:slug). A prospect opens it, sees open slots
 * computed from the rep's REAL calendar availability (business-hours slots minus
 * busy calendar_events), and books one — which creates an inbound lead and books
 * a real calendar event via the existing sendMeetingInvite path. Fully hands-off
 * for the rep: a meeting lands on their calendar with zero manual steps.
 *
 * Public procedures resolve the workspace from the booking link itself (no auth
 * context); management procedures are workspace-scoped to the owning rep.
 *
 * MVP note: availability uses a fixed business-hours window in UTC (documented
 * limitation) filtered against real busy events; per-rep working hours + tz are
 * a later refinement. Times are returned as ISO and shown in the visitor's local
 * timezone by the public page.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, eq, gte, lte, ne, sql } from "drizzle-orm";
import { router, publicProcedure } from "../_core/trpc";
import { workspaceProcedure } from "../_core/workspace";
import { isActiveMember } from "../_core/activeMembers";
import { getDb } from "../db";
import { isWorkspaceLive } from "../_core/workspaceArchive";
import { activities, bookingLinks, calendarEvents, leads, meetings, notifications, users, type BookingLink } from "../../drizzle/schema";
import { sendMeetingInvite } from "../services/meetingScheduler";
import { describeConfirmationFailure, sendBookingConfirmationEmail, type BookingConfirmationResult } from "../services/bookingConfirmationEmail";
import { hostedPageChatSlug } from "../services/hostedChat";
import {
  DEFAULT_HORIZON_DAYS, DEFAULT_WORK_DAYS, formatInZone, generateSlots, isValidTimezone,
} from "@shared/availability";
import { slugify } from "@shared/slugify";
import { isLiveMeetingStatus } from "@shared/meetingStatus";

/**
 * Availability bounds. The generator's own defaults live in
 * @shared/availability; HORIZON_DAYS is kept here because the busy-events query
 * below must span exactly the window the generator will consider.
 */
const HORIZON_DAYS = DEFAULT_HORIZON_DAYS;

/**
 * One refusal for every reason a link cannot be booked — turned off, unknown
 * slug, or a host who no longer works here. Kept as a constant so the three
 * throw sites cannot drift into telling a stranger which one it was.
 */
const BOOKING_UNAVAILABLE = "This booking link is not available.";

// slugify comes from @shared/slugify — one rule for every public URL.

/*
 * The timezone primitives and the slot generator moved to
 * @shared/availability so meetingScheduler can use the SAME ones. It could not
 * import them from here: this router imports sendMeetingInvite from that
 * service, so the dependency only runs one way. Re-exported because
 * chatAgents.ts and the tests reach for them through this module.
 */
export { isValidTimezone, generateSlots };
export type { AvailabilityOpts } from "@shared/availability";

/** Parse the stored comma-separated workDays column into weekday numbers. */
export function parseWorkDays(s: string | null | undefined): number[] {
  const days = (s ?? "").split(",").map((x) => Number(x.trim())).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6);
  return days.length ? [...new Set(days)] : DEFAULT_WORK_DAYS;
}

/**
 * Busy intervals for a rep over the horizon — the union of synced external
 * calendar_events AND already-scheduled `meetings`. Including meetings is what
 * closes the double-booking window: a just-booked slot is written to the
 * provider by sendMeetingInvite but doesn't appear in calendar_events until the
 * next sync, whereas its `meetings` row (with scheduledAt) is immediately
 * consistent — so back-to-back bookings of the same slot are correctly blocked.
 */
// Was a local array; now @shared/meetingStatus, which two other files were
// answering the same question with differently. This one was the correct set,
// and it is asked through `isLiveMeetingStatus` so the check is typed rather
// than a `.includes(x as string)` that would accept any spelling at all.

async function busyEventsFor(workspaceId: number, userId: number, nowMs: number) {
  const db = await getDb();
  if (!db) return [];
  const from = new Date(nowMs);
  const to = new Date(nowMs + HORIZON_DAYS * 86400000);
  const [events, mtgs] = await Promise.all([
    db.select({ startAt: calendarEvents.startAt, endAt: calendarEvents.endAt })
      .from(calendarEvents)
      .where(and(
        eq(calendarEvents.workspaceId, workspaceId),
        eq(calendarEvents.userId, userId),
        gte(calendarEvents.startAt, from),
        lte(calendarEvents.startAt, to),
      )),
    // scheduledAt IS NULL naturally excluded (NULL comparisons are false), so
    // this only catches meetings with a concrete booked time.
    db.select({ startAt: meetings.scheduledAt, durationMin: meetings.durationMin, status: meetings.status })
      .from(meetings)
      .where(and(
        eq(meetings.workspaceId, workspaceId),
        eq(meetings.ownerUserId, userId),
        gte(meetings.scheduledAt, from),
        lte(meetings.scheduledAt, to),
      )),
  ]);
  const busy = events.map((r) => ({ startAt: r.startAt as Date, endAt: r.endAt as Date }));
  for (const m of mtgs) {
    if (!m.startAt || !isLiveMeetingStatus(m.status as string)) continue;
    const s = m.startAt as Date;
    busy.push({ startAt: s, endAt: new Date(s.getTime() + (m.durationMin ?? 30) * 60000) });
  }
  return busy;
}

/**
 * The link's currently-open slots. Exported so every public booking surface
 * (the /b/:slug page AND the inbound chat agent) computes availability the
 * same way — one definition of "open", one place to change it.
 */
export async function openSlotsForLink(link: BookingLink, nowMs = Date.now()): Promise<string[]> {
  const busy = await busyEventsFor(link.workspaceId, link.userId, nowMs);
  return generateSlots(busy, link.durationMin, nowMs, {
    timezone: link.timezone,
    startHour: link.startHour,
    endHour: link.endHour,
    workDays: parseWorkDays(link.workDays),
    maxSlots: BOOKING_LINK_MAX_SLOTS,
  });
}

/**
 * Enough slots for the whole two-week horizon (G42). The shared default of 40
 * covered about two and a half working days of 30-minute slots, so the page
 * that says "the next two weeks" showed two days, and a later slot could not be
 * booked even by a direct POST (bookSlotForLink re-validates against this
 * list). 15-minute slots over a 12-hour day for ten workdays is 480.
 */
export const BOOKING_LINK_MAX_SLOTS = 500;

/**
 * Whether a live meeting of this rep, created before `meetingId`, overlaps
 * [start, start + durationMin). The re-validation above runs before the insert,
 * so two prospects booking the same slot at once both passed it (G42); each
 * now checks after its own insert, and the later row gives way.
 */
async function earlierOverlap(link: BookingLink, start: Date, durationMin: number, meetingId: number): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  const endMs = start.getTime() + durationMin * 60000;
  const rows = await db.select({ id: meetings.id, scheduledAt: meetings.scheduledAt, durationMin: meetings.durationMin, status: meetings.status })
    .from(meetings)
    .where(and(
      eq(meetings.workspaceId, link.workspaceId),
      eq(meetings.ownerUserId, link.userId),
      gte(meetings.scheduledAt, new Date(start.getTime() - 24 * 3600000)),
      lte(meetings.scheduledAt, new Date(endMs)),
    ));
  return rows.some((m) => {
    if (m.id >= meetingId || !m.scheduledAt || !isLiveMeetingStatus(m.status as string)) return false;
    const s = new Date(m.scheduledAt).getTime();
    return s < endMs && start.getTime() < s + (m.durationMin ?? 30) * 60000;
  });
}

export interface BookSlotOpts {
  startAt: Date;
  name: string;
  email: string;
  notes?: string | null;
  /** `leads.source` for a newly-created lead (e.g. "booking_link", "chat:acme"). */
  leadSource?: string;
  /** Reuse a lead the caller already created (the chat agent does) instead of a new one. */
  existingLeadId?: number | null;
  /** `meetings.source` — how this booking reached us. */
  meetingSource?: string;
  /** Extra line appended to the rep notification, e.g. "Booked by the chat agent." */
  notificationSuffix?: string;
}

/**
 * How often a public booking may land (audit 2026-10-20, G17). Each booking
 * mails a calendar invite from the rep's own calendar to an address the caller
 * typed, so without a cap the link is a relay pointed at a stranger's inbox and
 * a way to fill a rep's week with junk. The per-address limit stops the first,
 * the per-link limit bounds the second; the per-IP limiter in
 * publicRateLimit.ts sits in front of both. Counted over the last 24 hours,
 * cancelled meetings excluded, so a booker who cancels can book again.
 */
export const MAX_BOOKINGS_PER_EMAIL_PER_DAY = 2;
export const MAX_BOOKINGS_PER_LINK_PER_DAY = 20;
export const BOOKING_CAP_EMAIL = "You already have meetings booked with this team. Check your email for the invite, or reply to it to change the time.";
export const BOOKING_CAP_LINK = "This calendar is not taking more bookings today. Please try again tomorrow.";

async function assertBookingCaps(db: NonNullable<Awaited<ReturnType<typeof getDb>>>, link: BookingLink, email: string): Promise<void> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  // Public bookings only: a meeting a rep or the scheduler proposed to this
  // person today must not use up their own right to book.
  const recent = and(
    eq(meetings.workspaceId, link.workspaceId),
    gte(meetings.createdAt, since),
    ne(meetings.status, "cancelled"),
    eq(meetings.source, "inbound"),
  );
  const [byEmail] = await db.select({ n: sql<number>`count(*)` }).from(meetings)
    .where(and(recent, sql`lower(${meetings.contactEmail}) = ${email.trim().toLowerCase()}`));
  if (Number(byEmail?.n ?? 0) >= MAX_BOOKINGS_PER_EMAIL_PER_DAY) {
    throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: BOOKING_CAP_EMAIL });
  }
  const [byLink] = await db.select({ n: sql<number>`count(*)` }).from(meetings)
    .where(and(recent, eq(meetings.ownerUserId, link.userId)));
  if (Number(byLink?.n ?? 0) >= MAX_BOOKINGS_PER_LINK_PER_DAY) {
    throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: BOOKING_CAP_LINK });
  }
}

/** The booker's note as the meeting card's internal line, capped. Null when there is none. */
export function bookerNoteLine(notes: string | null | undefined): string | null {
  const t = String(notes ?? "").trim();
  return t ? `Note from the booker: ${t}`.slice(0, 1000) : null;
}

/**
 * Book one slot on a booking link: revalidate availability, ensure a lead,
 * create the meeting, push it to the real calendar, bump the counter, and tell
 * the rep. Exported so the chat agent books through EXACTLY this path — a
 * second implementation would inevitably drift on the conflict check, which is
 * the part that must never be wrong.
 *
 * Throws TRPCError CONFLICT if the slot is no longer open.
 */
export async function bookSlotForLink(link: BookingLink, opts: BookSlotOpts) {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
  const start = opts.startAt;

  // An archived workspace takes no bookings (audit 2026-10-20, G36). Here,
  // in the shared path, so the chat agent's bookings are refused too.
  if (!(await isWorkspaceLive(link.workspaceId))) {
    throw new TRPCError({ code: "NOT_FOUND", message: BOOKING_UNAVAILABLE });
  }

  // Re-validate against the CURRENT open slots: enforces busy-conflicts,
  // the working-hours window/timezone, workdays, lead time, and horizon in
  // one place — a hand-crafted POST can't book 3am outside the window.
  const openSlots = await openSlotsForLink(link);
  if (!openSlots.includes(start.toISOString())) {
    throw new TRPCError({ code: "CONFLICT", message: "That time is no longer available — please pick another slot." });
  }

  /**
   * The host must still work here. Checked HERE as well as in `getPublic`
   * because this function is the shared booking path — the chat agent books
   * through it too, and a gate only on the page load would leave the POST open.
   *
   * A departed rep's link is worse than a dead link: `busyEventsFor` finds no
   * calendar events for them, so EVERY slot reads as open; `sendMeetingInvite`
   * finds no calendar account, so it records the meeting with
   * `inviteSent: false` and no invite is ever sent; and the notification below
   * is addressed to a user id that cannot sign in. The prospect is told they
   * are booked and nobody in the workspace is told anything.
   */
  if (!(await isActiveMember(link.workspaceId, link.userId))) {
    throw new TRPCError({ code: "NOT_FOUND", message: BOOKING_UNAVAILABLE });
  }

  await assertBookingCaps(db, link, opts.email);

  // Inbound lead for the booker (routed to the link owner), unless the caller
  // already has one for this person.
  const parts = opts.name.trim().split(/\s+/);
  const firstName = parts[0] || "Guest";
  const lastName = parts.slice(1).join(" ") || "";
  let leadId: number | null = opts.existingLeadId ?? null;
  if (!leadId) {
    try {
      const r = await db.insert(leads).values({
        workspaceId: link.workspaceId,
        firstName, lastName,
        email: opts.email,
        source: opts.leadSource ?? "booking_link",
        status: "new",
        ownerUserId: link.userId,
      } as never);
      leadId = Number((r as any)[0]?.insertId ?? 0) || null;
    } catch (e) {
      console.error("[bookingLinks] lead insert failed:", (e as Error).message);
    }
    // Only inside the `!leadId` branch: a booker the caller already has a lead
    // for is not a new record, and firing on every booking would announce the
    // same person repeatedly. One lead per booking otherwise.
    if (leadId) {
      const createdLeadId = leadId;
      void import("../services/workflowEngine")
        .then((m) => m.fireRecordCreated(link.workspaceId, "lead", createdLeadId, {
          email: opts.email, source: opts.leadSource ?? "booking_link", status: "new",
        }, link.userId ?? null))
        .catch(() => { /* workflow firing is best-effort */ });
    }
  }

  // Proposed meeting at the chosen time, then book it for real.
  const ins = await db.insert(meetings).values({
    workspaceId: link.workspaceId,
    ownerUserId: link.userId,
    relatedType: leadId ? "lead" : null,
    relatedId: leadId,
    contactName: opts.name.slice(0, 200),
    contactEmail: opts.email,
    title: link.title,
    status: "proposed",
    proposedTimes: [start.toISOString()],
    scheduledAt: start,
    durationMin: link.durationMin,
    /**
     * The booker's note is NOT the invite text (audit 2026-10-20, G17).
     * `inviteMessage` becomes the description of the calendar event the rep's
     * own calendar sends to `opts.email`, an address the caller chose: a
     * stranger's text, mailed from the rep, to anyone. It goes on the card's
     * internal line instead, which only the workspace sees.
     */
    inviteMessage: null,
    aiReasoning: bookerNoteLine(opts.notes),
    source: opts.meetingSource ?? "inbound",
  } as never);
  const meetingId = Number((ins as any)[0]?.insertId ?? 0) || 0;
  if (!meetingId) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Could not create the meeting." });
  if (await earlierOverlap(link, start, link.durationMin, meetingId)) {
    // Someone booked this time a moment earlier: this row stands down before
    // any invite goes out, and the visitor picks another slot.
    await db.update(meetings).set({ status: "cancelled" } as never)
      .where(and(eq(meetings.workspaceId, link.workspaceId), eq(meetings.id, meetingId)));
    throw new TRPCError({ code: "CONFLICT", message: "That time was just booked by someone else — please pick another slot." });
  }

  // Book the real calendar event (no-op-safe if no calendar is connected).
  let result: { sent: boolean; scheduledAt: string | null; reason?: string } = { sent: false, scheduledAt: start.toISOString() };
  try {
    result = await sendMeetingInvite(link.workspaceId, meetingId, start.toISOString());
  } catch (e) {
    console.error("[bookingLinks] sendMeetingInvite failed:", (e as Error).message);
  }
  // A self-booked meeting is SCHEDULED whatever the calendar situation — the
  // prospect chose this time. sendMeetingInvite flips the status when a
  // provider invite goes out; without a connected calendar (or on a provider
  // error) the row used to stay "proposed": no reminders (proposed is not
  // remindable), miscounted as an AI proposal, dismissible from the approval
  // queue, and eligible for the stale-proposal regenerator to overwrite a
  // real customer's agreed time (audit 2026-09-20).
  if (!result.sent) {
    await db.update(meetings).set({ status: "scheduled" } as never)
      .where(and(eq(meetings.workspaceId, link.workspaceId), eq(meetings.id, meetingId), eq(meetings.status, "proposed")));
  }

  // No calendar invite went: the booker is emailed a confirmation instead
  // (tracker item 10, 2026-11-06). Before this they got nothing — the only
  // message a booker ever received was the provider's invite. Not held by
  // the outbound pause: booking is the prospect's own action (see
  // services/bookingConfirmationEmail).
  const whenLabel = formatInZone(start, link.timezone ?? "UTC");
  let confirmation: BookingConfirmationResult | null = null;
  if (!result.sent) {
    // A failed name lookup must not sink a booking that has already happened.
    const [host] = await db.select({ name: users.name }).from(users).where(eq(users.id, link.userId)).catch(() => []);
    confirmation = await sendBookingConfirmationEmail({
      workspaceId: link.workspaceId,
      meetingId,
      title: link.title,
      startAt: start,
      durationMin: link.durationMin,
      timezone: link.timezone ?? "UTC",
      hostName: host?.name || "your host",
      ownerUserId: link.userId,
      contactEmail: opts.email,
      contactName: opts.name,
      relatedType: leadId ? "lead" : null,
      relatedId: leadId,
    });
  }
  const confirmationSent = confirmation?.ok === true;

  // Atomic in SQL. `link.bookingCount + 1` computed in JS is a lost update: the
  // count comes from a row read before the booking, and two prospects booking
  // the same rep concurrently both read N and both write N+1, recording two
  // meetings as one. Same shape as the sendingAccountDailyStats fix in 72aa576.
  await db.update(bookingLinks)
    .set({ bookingCount: sql`${bookingLinks.bookingCount} + 1` } as never)
    .where(eq(bookingLinks.id, link.id));

  // Notify the rep + log a timeline activity so a self-booked meeting never
  // goes unseen — critical when no calendar is connected (no provider invite).
  // In the LINK's own timezone, with the zone named. It was
  // `start.toISOString()` + " UTC" — honest, but it made a rep in New York read
  // 13:00 for a 9am meeting they had just been booked into, on the notification
  // whose whole job is telling them when to show up.
  //
  // It names the REAL reason no invite went. Every failure used to read "No
  // calendar connected", which sent a rep whose calendar refused the event, or
  // whose booker already had a meeting, looking for a setting that was fine.
  const outcome = bookingOutcomeLine(result, opts.email, confirmation);
  try {
    await db.insert(notifications).values({
      workspaceId: link.workspaceId,
      userId: link.userId,
      kind: "system",
      title: `New meeting booked: ${opts.name}`,
      body: `${opts.name} booked "${link.title}" for ${whenLabel}. ${outcome}${opts.notificationSuffix ? ` ${opts.notificationSuffix}` : ""}`,
    } as never);
  } catch (e) {
    console.error("[bookingLinks] rep notification failed:", (e as Error).message);
  }
  if (leadId) {
    try {
      await db.insert(activities).values({
        workspaceId: link.workspaceId,
        type: "meeting",
        relatedType: "lead",
        relatedId: leadId,
        subject: `Meeting booked via link: ${opts.name}`.slice(0, 240),
        body: `${opts.name} <${opts.email}> booked "${link.title}" for ${whenLabel}. ${outcome}`,
        actorUserId: null,
      } as never);
    } catch (e) {
      console.error("[bookingLinks] activity emit failed:", (e as Error).message);
    }
  }

  return { meetingId, leadId, calendarBooked: result.sent, confirmationSent, scheduledAt: start.toISOString() };
}

/**
 * What the rep is told about delivery: the invite, or why there was none and
 * whether the booker was emailed instead. Exported for the tests.
 */
export function bookingOutcomeLine(
  result: { sent: boolean; reason?: string },
  email: string,
  confirmation: BookingConfirmationResult | null,
): string {
  if (result.sent) return "Calendar invite sent.";
  const why =
    result.reason === "no_calendar_connected" ? "No calendar invite went: no calendar is connected — add it to your calendar."
    : result.reason === "provider_error" ? "No calendar invite went: your calendar refused the event — add it by hand."
    // A second invite to the same address is held back on purpose
    // (sendMeetingInvite, 2026-09-24); the booking stands because the booker
    // chose this time, so the rep is told to look for the duplicate.
    : result.reason === "already_invited" ? "No calendar invite went: they already have an upcoming meeting with you — check whether this one is a duplicate."
    : `No calendar invite went (${result.reason ?? "unknown"}).`;
  const told = !confirmation
    ? ""
    : confirmation.ok
      ? ` A confirmation email went to ${email}.`
      : ` No confirmation email went either (${describeConfirmationFailure(confirmation)}) — contact them.`;
  return `${why}${told}`;
}

export const bookingLinksRouter = router({
  /** Get (or lazily create) the current rep's booking link. */
  mine: workspaceProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const [existing] = await db
      .select()
      .from(bookingLinks)
      .where(and(eq(bookingLinks.workspaceId, ctx.workspace.id), eq(bookingLinks.userId, ctx.user.id)));
    if (existing) return existing;

    // Lazily provision a stable, unique slug from the rep's name + id.
    const [u] = await db.select({ name: users.name }).from(users).where(eq(users.id, ctx.user.id));
    const base = slugify(u?.name || `rep-${ctx.user.id}`) || `rep-${ctx.user.id}`;
    const slug = `${base}-${ctx.user.id}`.slice(0, 80);
    await db.insert(bookingLinks).values({
      workspaceId: ctx.workspace.id,
      userId: ctx.user.id,
      slug,
      title: "Book a meeting",
    } as never);
    const [created] = await db
      .select()
      .from(bookingLinks)
      .where(and(eq(bookingLinks.workspaceId, ctx.workspace.id), eq(bookingLinks.userId, ctx.user.id)));
    return created;
  }),

  /** Update the current rep's booking link (title/duration/active/availability). */
  update: workspaceProcedure
    .input(z.object({
      title: z.string().min(1).max(160).optional(),
      description: z.string().max(500).nullable().optional(),
      durationMin: z.number().int().min(15).max(120).optional(),
      active: z.boolean().optional(),
      /** IANA timezone the working-hours window is defined in (null = UTC). */
      timezone: z.string().max(64).nullable().optional(),
      startHour: z.number().int().min(0).max(23).optional(),
      endHour: z.number().int().min(1).max(24).optional(),
      /** Bookable weekdays, JS numbering (0=Sun … 6=Sat). */
      workDays: z.array(z.number().int().min(0).max(6)).min(1).max(7).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      if (input.timezone && !isValidTimezone(input.timezone)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Unknown timezone." });
      }
      const set: Record<string, unknown> = {};
      if (input.title !== undefined) set.title = input.title;
      if (input.description !== undefined) set.description = input.description;
      if (input.durationMin !== undefined) set.durationMin = input.durationMin;
      if (input.active !== undefined) set.active = input.active;
      if (input.timezone !== undefined) set.timezone = input.timezone;
      if (input.startHour !== undefined) set.startHour = input.startHour;
      if (input.endHour !== undefined) set.endHour = input.endHour;
      if (input.workDays !== undefined) set.workDays = [...new Set(input.workDays)].sort().join(",");
      if (Object.keys(set).length === 0) return { ok: true as const };
      // Cross-field sanity: pull the current row so partial updates can't
      // produce an inverted window (start >= end).
      const [cur] = await db.select({ startHour: bookingLinks.startHour, endHour: bookingLinks.endHour })
        .from(bookingLinks)
        .where(and(eq(bookingLinks.workspaceId, ctx.workspace.id), eq(bookingLinks.userId, ctx.user.id)));
      const nextStart = (input.startHour ?? cur?.startHour ?? 9);
      const nextEnd = (input.endHour ?? cur?.endHour ?? 17);
      if (nextStart >= nextEnd) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Working hours must end after they start." });
      }
      await db.update(bookingLinks).set(set as never)
        .where(and(eq(bookingLinks.workspaceId, ctx.workspace.id), eq(bookingLinks.userId, ctx.user.id)));
      return { ok: true as const };
    }),

  /** PUBLIC: the booking page payload — rep, title, and open slots. */
  getPublic: publicProcedure
    .input(z.object({ slug: z.string().min(1).max(80) }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const [link] = await db.select().from(bookingLinks).where(eq(bookingLinks.slug, input.slug));
      if (!link || !link.active) throw new TRPCError({ code: "NOT_FOUND", message: BOOKING_UNAVAILABLE });
      // …and when the workspace is archived (audit 2026-10-20, G36).
      if (!(await isWorkspaceLive(link.workspaceId))) throw new TRPCError({ code: "NOT_FOUND", message: BOOKING_UNAVAILABLE });
      /**
       * Same refusal, same words, when the host has left the workspace — a
       * stranger must not be able to tell "no such link" from "that rep left",
       * and there is nothing useful to show either way.
       */
      if (!(await isActiveMember(link.workspaceId, link.userId))) {
        throw new TRPCError({ code: "NOT_FOUND", message: BOOKING_UNAVAILABLE });
      }
      const [owner] = await db.select({ name: users.name }).from(users).where(eq(users.id, link.userId));
      const slots = await openSlotsForLink(link);
      return {
        title: link.title,
        description: link.description,
        durationMin: link.durationMin,
        ownerName: owner?.name || "Your host",
        /** The host's availability timezone (informational; slots are ISO/UTC). */
        timezone: link.timezone ?? "UTC",
        slots,
        /**
         * The workspace's hosted-page chat agent, if one is installed (0135).
         * A booking page is where hesitation shows up — "is this even for me?" —
         * and the agent answers it and books through this same path.
         */
        chatSlug: await hostedPageChatSlug(link.workspaceId),
      };
    }),

  /** PUBLIC: book a slot — creates an inbound lead + a real calendar meeting. */
  book: publicProcedure
    .input(z.object({
      slug: z.string().min(1).max(80),
      startAt: z.string().datetime(),
      name: z.string().min(1).max(200),
      email: z.string().email().max(320),
      notes: z.string().max(1000).optional(),
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const [link] = await db.select().from(bookingLinks).where(eq(bookingLinks.slug, input.slug));
      if (!link || !link.active) throw new TRPCError({ code: "NOT_FOUND", message: "This booking link is not available." });

      const start = new Date(input.startAt);
      if (Number.isNaN(start.getTime()) || start.getTime() < Date.now()) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Please pick a valid future time." });
      }

      const booked = await bookSlotForLink(link, {
        startAt: start,
        name: input.name,
        email: input.email,
        notes: input.notes ?? null,
        leadSource: "booking_link",
      });

      return {
        ok: true as const,
        scheduledAt: booked.scheduledAt,
        calendarBooked: booked.calendarBooked,
        /** No invite went, and the booker was emailed a confirmation instead. */
        confirmationSent: booked.confirmationSent,
        ownerName: undefined as string | undefined,
      };
    }),
});
