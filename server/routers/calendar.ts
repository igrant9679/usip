/**
 * calendar.ts — tRPC router for Rep Calendar (Feature 73)
 */

import { z } from "zod";
import { router } from "../_core/trpc";
import { workspaceProcedure, roleRank } from "../_core/workspace";
import { TRPCError } from "@trpc/server";
import { getDb } from "../db";
import { calendarAccounts, calendarEvents } from "../../drizzle/schema";
import { eq, and, gte, lte, desc } from "drizzle-orm";
import { createCalendarAdapter } from "../calendarAdapter";
import { encryptField } from "../emailAdapter";

function resolveTargetUser(
  ctx: { user: { id: number }; member: { role: string } },
  repUserId?: number,
): number {
  if (!repUserId || repUserId === ctx.user.id) return ctx.user.id;
  if (roleRank(ctx.member.role as any) < roleRank("manager")) {
    throw new TRPCError({ code: "FORBIDDEN", message: "Only managers can view other reps' calendars" });
  }
  return repUserId;
}

async function getCalendarAccount(id: number, workspaceId: number) {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
  const [acc] = await db.select().from(calendarAccounts).where(and(eq(calendarAccounts.id, id), eq(calendarAccounts.workspaceId, workspaceId)));
  if (!acc) throw new TRPCError({ code: "NOT_FOUND", message: "Calendar account not found" });
  return acc;
}

export const calendarRouter = router({
  /** List connected calendar accounts for a rep */
  listAccounts: workspaceProcedure
    .input(z.object({ repUserId: z.number().optional() }))
    .query(async ({ ctx, input }) => {
      const targetUserId = resolveTargetUser(ctx, input.repUserId);
      const db = await getDb();
      if (!db) return [];
      return db
        .select({
          id: calendarAccounts.id,
          provider: calendarAccounts.provider,
          label: calendarAccounts.label,
          email: calendarAccounts.email,
          calendarId: calendarAccounts.calendarId,
          syncEnabled: calendarAccounts.syncEnabled,
          lastSyncAt: calendarAccounts.lastSyncAt,
          lastSyncError: calendarAccounts.lastSyncError,
        })
        .from(calendarAccounts)
        .where(and(eq(calendarAccounts.workspaceId, ctx.workspace.id), eq(calendarAccounts.userId, targetUserId)))
        .orderBy(desc(calendarAccounts.createdAt));
    }),

  /** Connect a CalDAV calendar account (Outlook, Apple, generic) */
  connectCalDAV: workspaceProcedure
    .input(z.object({
      provider: z.enum(["outlook_caldav", "apple_caldav", "generic_caldav"]),
      label: z.string().optional(),
      email: z.string().email().optional(),
      caldavUrl: z.string().url(),
      caldavUsername: z.string(),
      caldavPassword: z.string(),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const encryptedPassword = encryptField(input.caldavPassword);
      const [inserted] = await db.insert(calendarAccounts).values({
        workspaceId: ctx.workspace.id,
        userId: ctx.user.id,
        provider: input.provider,
        label: input.label,
        email: input.email,
        caldavUrl: input.caldavUrl,
        caldavUsername: input.caldavUsername,
        caldavPassword: encryptedPassword,
        syncEnabled: true,
      });
      return { id: (inserted as any).insertId };
    }),

  /** Connect a Google Calendar account */
  connectGoogle: workspaceProcedure
    .input(z.object({
      label: z.string().optional(),
      email: z.string().email().optional(),
      oauthAccessToken: z.string(),
      oauthRefreshToken: z.string(),
      oauthTokenExpiry: z.date().optional(),
      calendarId: z.string().default("primary"),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const [inserted] = await db.insert(calendarAccounts).values({
        workspaceId: ctx.workspace.id,
        userId: ctx.user.id,
        provider: "google",
        label: input.label ?? "Google Calendar",
        email: input.email,
        oauthAccessToken: input.oauthAccessToken,
        oauthRefreshToken: input.oauthRefreshToken,
        oauthTokenExpiry: input.oauthTokenExpiry,
        oauthScope: "https://www.googleapis.com/auth/calendar",
        calendarId: input.calendarId,
        syncEnabled: true,
      });
      return { id: (inserted as any).insertId };
    }),

  /** Disconnect (delete) a calendar account */
  disconnectAccount: workspaceProcedure
    .input(z.object({ accountId: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const acc = await getCalendarAccount(input.accountId, ctx.workspace.id);
      if (acc.userId !== ctx.user.id) throw new TRPCError({ code: "FORBIDDEN" });
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      await db.delete(calendarEvents).where(eq(calendarEvents.calendarAccountId, input.accountId));
      await db.delete(calendarAccounts).where(eq(calendarAccounts.id, input.accountId));
      return { ok: true };
    }),

  /** List calendars within an account */
  listCalendars: workspaceProcedure
    .input(z.object({ accountId: z.number(), repUserId: z.number().optional() }))
    .query(async ({ ctx, input }) => {
      resolveTargetUser(ctx, input.repUserId);
      const acc = await getCalendarAccount(input.accountId, ctx.workspace.id);
      const adapter = createCalendarAdapter(acc);
      return adapter.listCalendars();
    }),

  /** List events in a date range — reads from DB cache */
  listEvents: workspaceProcedure
    .input(z.object({
      accountId: z.number().optional(),
      from: z.date(),
      to: z.date(),
      repUserId: z.number().optional(),
    }))
    .query(async ({ ctx, input }) => {
      const targetUserId = resolveTargetUser(ctx, input.repUserId);
      const db = await getDb();
      if (!db) return [];
      const conditions: any[] = [
        eq(calendarEvents.workspaceId, ctx.workspace.id),
        eq(calendarEvents.userId, targetUserId),
        gte(calendarEvents.startAt, input.from),
        lte(calendarEvents.endAt, input.to),
      ];
      if (input.accountId) conditions.push(eq(calendarEvents.calendarAccountId, input.accountId));
      return db
        .select()
        .from(calendarEvents)
        .where(and(...conditions))
        .orderBy(calendarEvents.startAt);
    }),

  /** Create an event and sync to provider, then cache in DB */
  createEvent: workspaceProcedure
    .input(z.object({
      accountId: z.number(),
      calendarId: z.string(),
      title: z.string().min(1),
      description: z.string().optional(),
      location: z.string().optional(),
      meetingUrl: z.string().optional(),
      startAt: z.date(),
      endAt: z.date(),
      allDay: z.boolean().default(false),
      attendees: z.array(z.object({ email: z.string().email(), name: z.string().optional() })).optional(),
      relatedType: z.string().optional(),
      relatedId: z.number().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const acc = await getCalendarAccount(input.accountId, ctx.workspace.id);
      const adapter = createCalendarAdapter(acc);
      const result = await adapter.createEvent(input.calendarId, {
        title: input.title,
        description: input.description,
        location: input.location,
        meetingUrl: input.meetingUrl,
        startAt: input.startAt,
        endAt: input.endAt,
        allDay: input.allDay,
        attendees: input.attendees,
      });
      const db = await getDb();
      if (db) {
        await db.insert(calendarEvents).values({
          workspaceId: ctx.workspace.id,
          userId: ctx.user.id,
          calendarAccountId: input.accountId,
          externalId: result.externalId,
          title: result.title,
          description: result.description,
          location: result.location,
          meetingUrl: result.meetingUrl,
          startAt: result.startAt,
          endAt: result.endAt,
          allDay: result.allDay,
          attendees: result.attendees,
          relatedType: input.relatedType,
          relatedId: input.relatedId,
        });
      }
      return result;
    }),

  /** Update an event */
  updateEvent: workspaceProcedure
    .input(z.object({
      accountId: z.number(),
      calendarId: z.string(),
      externalId: z.string(),
      dbId: z.number().optional(),
      title: z.string().optional(),
      description: z.string().optional(),
      location: z.string().optional(),
      meetingUrl: z.string().optional(),
      startAt: z.date().optional(),
      endAt: z.date().optional(),
      allDay: z.boolean().optional(),
      attendees: z.array(z.object({ email: z.string().email(), name: z.string().optional() })).optional(),
      relatedType: z.string().optional(),
      relatedId: z.number().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const acc = await getCalendarAccount(input.accountId, ctx.workspace.id);
      const adapter = createCalendarAdapter(acc);
      const result = await adapter.updateEvent(input.calendarId, input.externalId, {
        title: input.title,
        description: input.description,
        location: input.location,
        meetingUrl: input.meetingUrl,
        startAt: input.startAt,
        endAt: input.endAt,
        allDay: input.allDay,
        attendees: input.attendees,
      });
      if (input.dbId) {
        const db = await getDb();
        if (db) {
          await db.update(calendarEvents).set({
            title: result.title,
            description: result.description,
            location: result.location,
            meetingUrl: result.meetingUrl,
            startAt: result.startAt,
            endAt: result.endAt,
            allDay: result.allDay,
            attendees: result.attendees,
            relatedType: input.relatedType,
            relatedId: input.relatedId,
          }).where(eq(calendarEvents.id, input.dbId));
        }
      }
      return result;
    }),

  /** Delete an event */
  deleteEvent: workspaceProcedure
    .input(z.object({
      accountId: z.number(),
      calendarId: z.string(),
      externalId: z.string(),
      dbId: z.number().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const acc = await getCalendarAccount(input.accountId, ctx.workspace.id);
      const adapter = createCalendarAdapter(acc);
      await adapter.deleteEvent(input.calendarId, input.externalId);
      if (input.dbId) {
        const db = await getDb();
        if (db) await db.delete(calendarEvents).where(eq(calendarEvents.id, input.dbId));
      }
      return { ok: true };
    }),

  /** Sync events from provider into DB cache */
  syncEvents: workspaceProcedure
    .input(z.object({ accountId: z.number(), from: z.date(), to: z.date() }))
    .mutation(async ({ ctx, input }) => {
      const acc = await getCalendarAccount(input.accountId, ctx.workspace.id);
      const adapter = createCalendarAdapter(acc);
      const calId = acc.calendarId ?? "primary";
      const events = await adapter.listEvents(calId, input.from, input.to);
      const db = await getDb();
      if (!db) return { synced: 0 };
      let upserted = 0;
      for (const e of events) {
        const existing = await db.select({ id: calendarEvents.id }).from(calendarEvents)
          .where(and(eq(calendarEvents.calendarAccountId, input.accountId), eq(calendarEvents.externalId, e.externalId)));
        if (existing.length > 0) {
          await db.update(calendarEvents).set({
            title: e.title, description: e.description, location: e.location,
            meetingUrl: e.meetingUrl, startAt: e.startAt, endAt: e.endAt,
            allDay: e.allDay, attendees: e.attendees, syncedAt: new Date(),
          }).where(eq(calendarEvents.id, existing[0].id));
        } else {
          await db.insert(calendarEvents).values({
            workspaceId: ctx.workspace.id, userId: ctx.user.id,
            calendarAccountId: input.accountId, externalId: e.externalId,
            title: e.title, description: e.description, location: e.location,
            meetingUrl: e.meetingUrl, startAt: e.startAt, endAt: e.endAt,
            allDay: e.allDay, attendees: e.attendees,
          });
        }
        upserted++;
      }
      await db.update(calendarAccounts).set({ lastSyncAt: new Date(), lastSyncError: null }).where(eq(calendarAccounts.id, input.accountId));
      return { synced: upserted };
    }),
});
