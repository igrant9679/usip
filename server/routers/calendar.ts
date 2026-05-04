/**
 * calendar.ts — tRPC router for Rep Calendar (Feature 73)
 */

import { z } from "zod";
import { router } from "../_core/trpc";
import { workspaceProcedure, roleRank } from "../_core/workspace";
import { TRPCError } from "@trpc/server";
import { getDb } from "../db";
import { calendarAccounts, calendarEvents, activities, opportunities } from "../../drizzle/schema";
import { eq, and, gte, lte, desc } from "drizzle-orm";
import { createCalendarAdapter } from "../calendarAdapter";
import { encryptField } from "../emailAdapter";
import { invokeLLM } from "../_core/llm";

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

  /** Connect a Microsoft 365 / Outlook calendar account via OAuth tokens */
  connectOutlookOAuth: workspaceProcedure
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
        provider: "outlook_oauth",
        label: input.label ?? "Outlook Calendar",
        email: input.email,
        oauthAccessToken: input.oauthAccessToken,
        oauthRefreshToken: input.oauthRefreshToken,
        oauthTokenExpiry: input.oauthTokenExpiry,
        oauthScope: "Calendars.ReadWrite offline_access",
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

  /** Generate an AI meeting summary and save it as an activity record */
  summarizeMeeting: workspaceProcedure
    .input(z.object({ eventId: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      // Fetch the calendar event
      const [event] = await db.select().from(calendarEvents)
        .where(and(eq(calendarEvents.id, input.eventId), eq(calendarEvents.workspaceId, ctx.workspace.id)));
      if (!event) throw new TRPCError({ code: "NOT_FOUND", message: "Event not found" });

      // Fetch linked opportunity notes if any
      let opportunityContext = "";
      if (event.relatedType === "opportunity" && event.relatedId) {
        const [opp] = await db.select({ name: opportunities.name, stage: opportunities.stage, aiNote: opportunities.aiNote, nextStep: opportunities.nextStep })
          .from(opportunities).where(eq(opportunities.id, event.relatedId));
        if (opp) {
          opportunityContext = `\n\nLinked opportunity: "${opp.name}" (stage: ${opp.stage})${opp.aiNote ? `\nAI notes: ${opp.aiNote}` : ""}${opp.nextStep ? `\nNext step: ${opp.nextStep}` : ""}`;
        }
      }

      // Parse attendees
      let attendeeList = "";
      try {
        const att = event.attendees ? JSON.parse(event.attendees as string) : [];
        attendeeList = att.map((a: any) => a.email || a.name || "").filter(Boolean).join(", ");
      } catch {}

      const prompt = `You are a sales CRM assistant. Generate a concise post-meeting summary for the following calendar event.

Event: ${event.title}
Date: ${event.startAt.toISOString().slice(0, 10)}
Attendees: ${attendeeList || "(none listed)"}
Description: ${event.description || "(none)"}
Location: ${event.location || "(none)"}${opportunityContext}

Provide a structured summary with these sections:
1. **Key Discussion Points** (2-4 bullet points)
2. **Decisions Made** (if any)
3. **Action Items** (owner + task, if any)
4. **Next Steps** (what happens next)

Be concise and professional. Use markdown formatting.`;

      const llmResult = await invokeLLM({
        messages: [
          { role: "system", content: "You are a sales CRM assistant that generates concise, actionable meeting summaries." },
          { role: "user", content: prompt },
        ],
      });
      const summary = llmResult.choices?.[0]?.message?.content ?? "(no summary generated)";

      // Save summary to calendarEvents row
      await db.update(calendarEvents).set({ aiSummary: summary, aiSummarizedAt: new Date() })
        .where(eq(calendarEvents.id, input.eventId));

      // Save as a meeting activity record linked to the related entity (or the event itself)
      const relatedType = event.relatedType ?? "opportunity";
      const relatedId = event.relatedId ?? 0;
      if (relatedId > 0) {
        await db.insert(activities).values({
          workspaceId: ctx.workspace.id,
          type: "meeting",
          relatedType,
          relatedId,
          subject: `Meeting summary: ${event.title}`,
          body: summary,
          meetingStartedAt: event.startAt,
          meetingEndedAt: event.endAt,
          meetingAttendees: event.attendees,
          occurredAt: event.startAt,
          actorUserId: ctx.user.id,
        });
      }

      return { summary };
    }),

  pushSummaryToOpportunity: workspaceProcedure
    .input(z.object({ eventId: z.number(), opportunityId: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      // Fetch the event to get its AI summary
      const [event] = await db.select().from(calendarEvents)
        .where(and(eq(calendarEvents.id, input.eventId), eq(calendarEvents.workspaceId, ctx.workspace.id)));
      if (!event) throw new TRPCError({ code: "NOT_FOUND", message: "Event not found" });
      if (!event.aiSummary) throw new TRPCError({ code: "BAD_REQUEST", message: "No AI summary exists for this event. Run Summarize first." });
      // Verify the opportunity belongs to this workspace
      const [opp] = await db.select({ id: opportunities.id, name: opportunities.name })
        .from(opportunities)
        .where(and(eq(opportunities.id, input.opportunityId), eq(opportunities.workspaceId, ctx.workspace.id)));
      if (!opp) throw new TRPCError({ code: "NOT_FOUND", message: "Opportunity not found" });
      // Insert a meeting activity on the opportunity
      await db.insert(activities).values({
        workspaceId: ctx.workspace.id,
        type: "meeting",
        relatedType: "opportunity",
        relatedId: input.opportunityId,
        subject: `Meeting summary pushed: ${event.title}`,
        body: event.aiSummary,
        meetingStartedAt: event.startAt,
        meetingEndedAt: event.endAt ?? undefined,
        meetingAttendees: event.attendees,
        occurredAt: event.startAt,
        actorUserId: ctx.user.id,
      });
      return { ok: true, opportunityName: opp.name };
    }),
});
