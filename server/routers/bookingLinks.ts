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
import { and, eq, gte, lte, sql } from "drizzle-orm";
import { router, publicProcedure } from "../_core/trpc";
import { workspaceProcedure } from "../_core/workspace";
import { isActiveMember } from "../_core/activeMembers";
import { getDb } from "../db";
import { activities, bookingLinks, calendarEvents, leads, meetings, notifications, users, type BookingLink } from "../../drizzle/schema";
import { sendMeetingInvite } from "../services/meetingScheduler";
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
    inviteMessage: opts.notes ? opts.notes.slice(0, 1500) : null,
    source: opts.meetingSource ?? "inbound",
  } as never);
  const meetingId = Number((ins as any)[0]?.insertId ?? 0) || 0;
  if (!meetingId) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Could not create the meeting." });

  // Book the real calendar event (no-op-safe if no calendar is connected).
  let result: { sent: boolean; scheduledAt: string | null; reason?: string } = { sent: false, scheduledAt: start.toISOString() };
  try {
    result = await sendMeetingInvite(link.workspaceId, meetingId, start.toISOString());
  } catch (e) {
    console.error("[bookingLinks] sendMeetingInvite failed:", (e as Error).message);
  }

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
  const whenLabel = formatInZone(start, link.timezone ?? "UTC");
  try {
    await db.insert(notifications).values({
      workspaceId: link.workspaceId,
      userId: link.userId,
      kind: "system",
      title: `New meeting booked: ${opts.name}`,
      body: `${opts.name} booked "${link.title}" for ${whenLabel}.${result.sent ? "" : " No calendar connected — add it to their calendar."}${opts.notificationSuffix ? ` ${opts.notificationSuffix}` : ""}`,
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
        body: `${opts.name} <${opts.email}> booked "${link.title}" for ${whenLabel}. ${result.sent ? "Calendar invite sent." : "No calendar connected — confirm manually."}`,
        actorUserId: null,
      } as never);
    } catch (e) {
      console.error("[bookingLinks] activity emit failed:", (e as Error).message);
    }
  }

  return { meetingId, leadId, calendarBooked: result.sent, scheduledAt: start.toISOString() };
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
        ownerName: undefined as string | undefined,
      };
    }),
});
