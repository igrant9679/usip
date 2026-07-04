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
import { and, eq, gte, lte } from "drizzle-orm";
import { router, publicProcedure } from "../_core/trpc";
import { workspaceProcedure } from "../_core/workspace";
import { getDb } from "../db";
import { activities, bookingLinks, calendarEvents, leads, meetings, notifications, users } from "../../drizzle/schema";
import { sendMeetingInvite } from "../services/meetingScheduler";

/** Business-hours window (UTC) used to generate candidate slots. */
const START_HOUR_UTC = 9;
const END_HOUR_UTC = 17;
const HORIZON_DAYS = 14; // look ahead up to 2 weeks
const MAX_SLOTS = 40;

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
}

/**
 * Generate open ISO slots from the business-hours window minus busy events.
 * Pure over its inputs (busy list + now) so it's easy to reason about.
 */
export function generateSlots(
  busy: Array<{ startAt: Date; endAt: Date }>,
  durationMin: number,
  nowMs: number,
): string[] {
  const slots: string[] = [];
  const leadMs = 60 * 60 * 1000; // require ≥1h lead time
  const day = new Date(nowMs);
  day.setUTCHours(0, 0, 0, 0);

  for (let d = 0; d < HORIZON_DAYS && slots.length < MAX_SLOTS; d++) {
    const cursor = new Date(day.getTime() + d * 86400000);
    const dow = cursor.getUTCDay();
    if (dow === 0 || dow === 6) continue; // skip weekends
    for (let mins = START_HOUR_UTC * 60; mins + durationMin <= END_HOUR_UTC * 60; mins += durationMin) {
      const start = new Date(cursor.getTime() + mins * 60000);
      const end = new Date(start.getTime() + durationMin * 60000);
      if (start.getTime() < nowMs + leadMs) continue;
      const overlaps = busy.some((b) => start < b.endAt && end > b.startAt);
      if (!overlaps) slots.push(start.toISOString());
      if (slots.length >= MAX_SLOTS) break;
    }
  }
  return slots;
}

/**
 * Busy intervals for a rep over the horizon — the union of synced external
 * calendar_events AND already-scheduled `meetings`. Including meetings is what
 * closes the double-booking window: a just-booked slot is written to the
 * provider by sendMeetingInvite but doesn't appear in calendar_events until the
 * next sync, whereas its `meetings` row (with scheduledAt) is immediately
 * consistent — so back-to-back bookings of the same slot are correctly blocked.
 */
const BUSY_MEETING_STATUSES = ["proposed", "invited", "scheduled", "rescheduled"];

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
    if (!m.startAt || !BUSY_MEETING_STATUSES.includes(m.status as string)) continue;
    const s = m.startAt as Date;
    busy.push({ startAt: s, endAt: new Date(s.getTime() + (m.durationMin ?? 30) * 60000) });
  }
  return busy;
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

  /** Update the current rep's booking link (title/description/duration/active). */
  update: workspaceProcedure
    .input(z.object({
      title: z.string().min(1).max(160).optional(),
      description: z.string().max(500).nullable().optional(),
      durationMin: z.number().int().min(15).max(120).optional(),
      active: z.boolean().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const set: Record<string, unknown> = {};
      if (input.title !== undefined) set.title = input.title;
      if (input.description !== undefined) set.description = input.description;
      if (input.durationMin !== undefined) set.durationMin = input.durationMin;
      if (input.active !== undefined) set.active = input.active;
      if (Object.keys(set).length === 0) return { ok: true as const };
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
      if (!link || !link.active) throw new TRPCError({ code: "NOT_FOUND", message: "This booking link is not available." });
      const [owner] = await db.select({ name: users.name }).from(users).where(eq(users.id, link.userId));
      const nowMs = Date.now();
      const busy = await busyEventsFor(link.workspaceId, link.userId, nowMs);
      const slots = generateSlots(busy, link.durationMin, nowMs);
      return {
        title: link.title,
        description: link.description,
        durationMin: link.durationMin,
        ownerName: owner?.name || "Your host",
        slots,
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
      // Re-validate the slot is still open (avoid double-booking a busy time).
      const busy = await busyEventsFor(link.workspaceId, link.userId, Date.now());
      const end = new Date(start.getTime() + link.durationMin * 60000);
      if (busy.some((b) => start < b.endAt && end > b.startAt)) {
        throw new TRPCError({ code: "CONFLICT", message: "That time was just taken — please pick another slot." });
      }

      // Inbound lead for the booker (routed to the link owner).
      const parts = input.name.trim().split(/\s+/);
      const firstName = parts[0] || "Guest";
      const lastName = parts.slice(1).join(" ") || "";
      let leadId: number | null = null;
      try {
        const r = await db.insert(leads).values({
          workspaceId: link.workspaceId,
          firstName, lastName,
          email: input.email,
          source: "booking_link",
          status: "new",
          ownerUserId: link.userId,
        } as never);
        leadId = Number((r as any)[0]?.insertId ?? 0) || null;
      } catch (e) {
        console.error("[bookingLinks] lead insert failed:", (e as Error).message);
      }

      // Proposed meeting at the chosen time, then book it for real.
      const ins = await db.insert(meetings).values({
        workspaceId: link.workspaceId,
        ownerUserId: link.userId,
        relatedType: leadId ? "lead" : null,
        relatedId: leadId,
        contactName: input.name.slice(0, 200),
        contactEmail: input.email,
        title: link.title,
        status: "proposed",
        proposedTimes: [start.toISOString()],
        scheduledAt: start,
        durationMin: link.durationMin,
        inviteMessage: input.notes ? input.notes.slice(0, 1500) : null,
        source: "inbound",
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

      await db.update(bookingLinks)
        .set({ bookingCount: (link.bookingCount ?? 0) + 1 } as never)
        .where(eq(bookingLinks.id, link.id));

      // Notify the rep + log a timeline activity so a self-booked meeting never
      // goes unseen — critical when no calendar is connected (no provider invite).
      const whenLabel = `${start.toISOString().slice(0, 16).replace("T", " ")} UTC`;
      try {
        await db.insert(notifications).values({
          workspaceId: link.workspaceId,
          userId: link.userId,
          kind: "system",
          title: `New meeting booked: ${input.name}`,
          body: `${input.name} booked "${link.title}" for ${whenLabel}.${result.sent ? "" : " No calendar connected — add it to their calendar."}`,
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
            subject: `Meeting booked via link: ${input.name}`.slice(0, 240),
            body: `${input.name} <${input.email}> booked "${link.title}" for ${whenLabel}. ${result.sent ? "Calendar invite sent." : "No calendar connected — confirm manually."}`,
            actorUserId: null,
          } as never);
        } catch (e) {
          console.error("[bookingLinks] activity emit failed:", (e as Error).message);
        }
      }

      return {
        ok: true as const,
        scheduledAt: start.toISOString(),
        calendarBooked: result.sent,
        ownerName: undefined as string | undefined,
      };
    }),
});
