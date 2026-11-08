/**
 * sequenceTimeline — a sequence's real send dates, projected (audit
 * 2026-10-20, U4).
 *
 * Walks the sequence's steps with the engine's own timing rules
 * (@shared/sequenceTimeline, which server/sequenceEngine.ts imports): waits
 * counted once from the later of due and sent, the sequence's window in its
 * zone (or the workspace's), weekends, the workspace send window that holds
 * LinkedIn steps and auto-send, and, with recipient time on, an example
 * person's zone. Read only: it sends nothing and changes nothing.
 */
import { TRPCError } from "@trpc/server";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { enrollments, prospects, sequences } from "../../drizzle/schema";
import { getDb } from "../db";
import { router } from "../_core/trpc";
import { workspaceProcedure } from "../_core/workspace";
import { getWorkspaceTimezone } from "../services/workspaceTimezone";
import { getWorkspaceSendWindow } from "../services/sendWindow";
import { enrollmentRecipientZone, sequenceUsesRecipientTime } from "../services/recipientZone";
import { describeSendWindow } from "@shared/sendWindow";
import { projectTimeline, sequenceWindowOf, type TimelineStep } from "@shared/sequenceTimeline";

export const sequenceTimelineRouter = router({
  preview: workspaceProcedure
    .input(z.object({
      sequenceId: z.number().int(),
      /** When the person enrols; now by default. */
      startAt: z.string().datetime({ offset: true }).optional(),
      /** With recipient time on: whose zone to show (a People row); else the first person enrolled. */
      prospectId: z.number().int().optional(),
    }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const ws = ctx.workspace.id;
      const [seq] = await db.select({ id: sequences.id, steps: sequences.steps, settings: sequences.settings, status: sequences.status })
        .from(sequences).where(and(eq(sequences.id, input.sequenceId), eq(sequences.workspaceId, ws))).limit(1);
      if (!seq) throw new TRPCError({ code: "NOT_FOUND" });
      const workspaceZone = await getWorkspaceTimezone(ws);
      // The window the engine's LinkedIn gate and auto-send read (services/sendWindow).
      const sw = await getWorkspaceSendWindow(ws);
      const cfg = sequenceWindowOf(seq.settings, workspaceZone);

      // An example person, for recipient time: the one asked for, else the
      // first enrolled, read as the engine reads them (services/recipientZone).
      let recipient: { label: string; zone: string; source: string } | null = null;
      if (sequenceUsesRecipientTime(seq.settings)) {
        let who: { prospectId?: number | null; contactId?: number | null; leadId?: number | null } | null = null;
        let label = "";
        if (input.prospectId) {
          const [p] = await db.select({ id: prospects.id, firstName: prospects.firstName, lastName: prospects.lastName }).from(prospects)
            .where(and(eq(prospects.id, input.prospectId), eq(prospects.workspaceId, ws))).limit(1);
          if (p) { who = { prospectId: p.id }; label = [p.firstName, p.lastName].filter(Boolean).join(" ") || `Person #${p.id}`; }
        }
        if (!who) {
          const [e] = await db.select({ contactId: enrollments.contactId, leadId: enrollments.leadId, prospectId: enrollments.prospectId }).from(enrollments)
            .where(and(eq(enrollments.workspaceId, ws), eq(enrollments.sequenceId, seq.id)))
            .orderBy(asc(enrollments.id)).limit(1);
          if (e) { who = e; label = "the first person enrolled"; }
        }
        if (who) {
          const z = await enrollmentRecipientZone(db, ws, who, cfg.timezone);
          recipient = { label, zone: z.zone, source: z.source };
        }
      }

      const startMs = input.startAt ? Date.parse(input.startAt) : Date.now();
      const steps = (Array.isArray(seq.steps) ? seq.steps : []) as TimelineStep[];
      const projection = projectTimeline(steps, {
        startMs,
        settings: seq.settings,
        workspaceZone,
        workspaceWindow: sw.window,
        workspaceWindowZone: sw.timezone,
        recipient: recipient ? { timezone: recipient.zone } : null,
      });
      // The LinkedIn gate and auto-send read the send window's own zone; say if it differs.
      return {
        startMs,
        status: seq.status,
        entries: projection.entries,
        emailZone: projection.emailZone,
        zoneSource: recipient ? recipient.source : projection.zoneSource,
        workspaceZone,
        sequenceWindow: { start: cfg.sendWindowStart, end: cfg.sendWindowEnd, skipWeekends: cfg.skipWeekends, timezone: cfg.timezone },
        workspaceWindow: describeSendWindow(sw.window),
        outboundPaused: sw.paused,
        recipient,
        assumptions: [
          "Each email goes out as soon as it may: auto-send inside the workspace send window, or a reviewer who sends it at once.",
          "Nobody replies (a reply pauses the person) and no daily cap is reached (a cap moves a step to the next day).",
          "Times are when the engine's next check finds the step due, to within a few minutes.",
        ],
      };
    }),
});
