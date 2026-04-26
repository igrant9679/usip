/**
 * ARE — Execution Router
 *
 * Manages the outreach execution queue and Signal Feedback Agent.
 *
 * SIGNAL FEEDBACK AGENT — processes incoming signals (replies, opens, etc.):
 *   1. Sentiment analysis via LLM (positive/neutral/negative/objection)
 *   2. Determines action: pause sequence, create opportunity, add suppression
 *   3. Feeds back into ICP learning (positive signals reinforce ICP dimensions)
 *   4. Updates A/B variant performance counters
 */
import { TRPCError } from "@trpc/server";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import {
  accounts,
  areCampaigns,
  areExecutionQueue,
  areSignalLog,
  areSuppressionList,
  contacts,
  opportunities,
  prospectQueue,
  prospectIntelligence,
} from "../../../drizzle/schema";
import { getDb } from "../../db";
import { invokeLLM } from "../../_core/llm";
import { router } from "../../_core/trpc";
import { workspaceProcedure } from "../../_core/workspace";
import { notifyOwner } from "../../_core/notification";

/* ─── Signal Feedback Agent ─────────────────────────────────────────────── */

export async function processSignal(
  workspaceId: number,
  prospectQueueId: number,
  campaignId: number,
  signalType: typeof areSignalLog.$inferInsert["signalType"],
  rawPayload: Record<string, unknown>,
  executionQueueId?: number,
): Promise<void> {
  const db = await getDb();
  if (!db) return;

  // Determine sentiment via LLM for reply-type signals
  let sentiment: "positive" | "neutral" | "negative" | "objection" | null = null;
  let sentimentReason = "";
  let actionTaken = "";

  const replySignals = ["email_reply", "linkedin_reply", "sms_reply", "voice_connected_interested", "voice_connected_not_interested"];

  if (replySignals.includes(signalType)) {
    const replyText = String(rawPayload.body ?? rawPayload.text ?? rawPayload.message ?? "");
    if (replyText) {
      const sentResult = await invokeLLM({
        messages: [
          {
            role: "system",
            content: `You are a B2B sales reply analyser. Classify the sentiment of a prospect's reply and determine the appropriate next action.`,
          },
          {
            role: "user",
            content: `Reply text: "${replyText}"\n\nClassify the sentiment and recommend action.`,
          },
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "signal_analysis",
            strict: true,
            schema: {
              type: "object",
              properties: {
                sentiment: { type: "string", enum: ["positive", "neutral", "negative", "objection"] },
                reason: { type: "string" },
                recommendedAction: { type: "string", enum: ["continue_sequence", "pause_sequence", "create_opportunity", "add_suppression", "schedule_followup"] },
                urgency: { type: "string", enum: ["high", "medium", "low"] },
              },
              required: ["sentiment", "reason", "recommendedAction", "urgency"],
              additionalProperties: false,
            },
          },
        },
      });

      const sentContent = sentResult.choices[0]?.message?.content;
      if (sentContent) {
        const sentData = JSON.parse(typeof sentContent === "string" ? sentContent : JSON.stringify(sentContent));
        sentiment = sentData.sentiment;
        sentimentReason = sentData.reason;

        // Execute recommended action
        switch (sentData.recommendedAction) {
          case "pause_sequence":
            await db.update(prospectQueue).set({ sequenceStatus: "replied" }).where(eq(prospectQueue.id, prospectQueueId));
            actionTaken = "paused_sequence";
            break;
          case "create_opportunity":
            await db.update(prospectQueue).set({ sequenceStatus: "replied" }).where(eq(prospectQueue.id, prospectQueueId));
            // Increment prospectsReplied counter
            await db.execute(sql`UPDATE are_campaigns SET prospectsReplied = prospectsReplied + 1 WHERE id = ${campaignId}`);
            actionTaken = "flagged_for_opportunity";
            break;
          case "add_suppression":
            const [prospect] = await db.select().from(prospectQueue).where(eq(prospectQueue.id, prospectQueueId)).limit(1);
            if (prospect) {
              await db.insert(areSuppressionList).values({
                workspaceId,
                email: prospect.email ?? undefined,
                linkedinUrl: prospect.linkedinUrl ?? undefined,
                reason: "unsubscribe",
                addedAt: new Date(),
              });
              await db.update(prospectQueue).set({ sequenceStatus: "skipped" }).where(eq(prospectQueue.id, prospectQueueId));
              actionTaken = "added_suppression";
            }
            break;
          default:
            actionTaken = "no_action";
        }
      }
    }
  }

  // Handle meeting booked — optionally auto-create CRM opportunity
  if (signalType === "meeting_booked") {
    sentiment = "positive";
    sentimentReason = "Meeting booked — highest positive signal";
    await db.update(prospectQueue).set({ sequenceStatus: "replied" }).where(eq(prospectQueue.id, prospectQueueId));
    await db.execute(sql`UPDATE are_campaigns SET meetingsBooked = meetingsBooked + 1 WHERE id = ${campaignId}`);
    actionTaken = "meeting_booked";

    // Check if signalToOpportunityEnabled is set on the campaign
    const [campaign] = await db.select().from(areCampaigns).where(eq(areCampaigns.id, campaignId)).limit(1);
    if (campaign?.signalToOpportunityEnabled) {
      // Fetch prospect details
      const [prospect] = await db.select().from(prospectQueue).where(eq(prospectQueue.id, prospectQueueId)).limit(1);
      if (prospect) {
        // Fetch intelligence dossier for context
        const [intel] = await db.select().from(prospectIntelligence)
          .where(eq(prospectIntelligence.prospectQueueId, prospectQueueId)).limit(1);

        // Create or find account
        let accountId: number;
        const companyName = prospect.companyName ?? "Unknown Company";
        const [existingAccount] = await db.select().from(accounts)
          .where(and(eq(accounts.workspaceId, workspaceId), eq(accounts.name, companyName))).limit(1);
        if (existingAccount) {
          accountId = existingAccount.id;
        } else {
          const [newAcc] = await db.insert(accounts).values({
            workspaceId,
            name: companyName,
            domain: prospect.companyDomain ?? undefined,
            industry: prospect.industry ?? undefined,
            ownerUserId: campaign.ownerUserId ?? undefined,
          }).$returningId();
          accountId = newAcc.id;
        }

        // Create contact
        const [newContact] = await db.insert(contacts).values({
          workspaceId,
          accountId,
          firstName: prospect.firstName ?? "Unknown",
          lastName: prospect.lastName ?? "Prospect",
          title: prospect.title ?? undefined,
          email: prospect.email ?? undefined,
          phone: prospect.phone ?? undefined,
          linkedinUrl: prospect.linkedinUrl ?? undefined,
          ownerUserId: campaign.ownerUserId ?? undefined,
        }).$returningId();

        // Build AI note from intelligence dossier
        const intelData = intel?.data as Record<string, unknown> | null;
        const hooks = (intelData?.personalisationHooks as Array<{hook: string}> | null) ?? [];
        const pains = (intelData?.painSignals as Array<{signal: string}> | null) ?? [];
        const aiNote = [
          `ARE Campaign: ${campaign.name}`,
          hooks.length > 0 ? `Hooks: ${hooks.slice(0, 2).map(h => h.hook).join(" | ")}` : null,
          pains.length > 0 ? `Pain signals: ${pains.slice(0, 2).map(p => p.signal).join(", ")}` : null,
          intelData?.recommendedTiming ? `Best timing: ${intelData.recommendedTiming}` : null,
        ].filter(Boolean).join("\n");

        // Create opportunity
        const oppName = companyName + " — ARE Meeting";
        await db.insert(opportunities).values({
          workspaceId,
          accountId,
          name: oppName,
          stage: "discovery",
          value: "0",
          winProb: 30,
          aiNote: aiNote || undefined,
          campaignId,
          ownerUserId: campaign.ownerUserId ?? undefined,
        });

        // Increment opportunitiesCreated counter
        await db.execute(sql`UPDATE are_campaigns SET opportunitiesCreated = opportunitiesCreated + 1 WHERE id = ${campaignId}`);
        actionTaken = "opportunity_created";

        // Notify owner
        await notifyOwner({
          title: `ARE: Meeting booked → Opportunity created`,
          content: `Campaign "${campaign.name}" — ${prospect.firstName ?? ""} ${prospect.lastName ?? ""} at ${companyName} booked a meeting. A new opportunity "${oppName}" has been created in the pipeline.`,
        }).catch(() => {/* non-fatal */});
      }
    }
  }

  // Handle bounces and unsubscribes
  if (signalType === "email_bounce" || signalType === "email_unsubscribe" || signalType === "sms_unsubscribe") {
    const [prospect] = await db.select().from(prospectQueue).where(eq(prospectQueue.id, prospectQueueId)).limit(1);
    if (prospect) {
      await db.insert(areSuppressionList).values({
        workspaceId,
        email: prospect.email ?? undefined,
        reason: signalType === "email_bounce" ? "bounce" : "unsubscribe",
        addedAt: new Date(),
      });
      await db.update(prospectQueue).set({ sequenceStatus: "skipped" }).where(eq(prospectQueue.id, prospectQueueId));
      actionTaken = "added_suppression";
    }
  }

  // Log the signal
  await db.insert(areSignalLog).values({
    workspaceId,
    executionQueueId: executionQueueId ?? undefined,
    prospectQueueId,
    campaignId,
    signalType,
    rawPayload,
    sentiment: sentiment ?? undefined,
    sentimentReason,
    actionTaken,
  });
}

/* ─── Router ─────────────────────────────────────────────────────────────── */

export const executionRouter = router({
  getQueue: workspaceProcedure
    .input(z.object({
      campaignId: z.number().optional(),
      status: z.string().optional(),
      channel: z.string().optional(),
      limit: z.number().default(50),
      offset: z.number().default(0),
    }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const conditions = [eq(areExecutionQueue.workspaceId, ctx.workspace.id)];
      if (input.campaignId) conditions.push(eq(areExecutionQueue.campaignId, input.campaignId));
      if (input.status) conditions.push(eq(areExecutionQueue.status, input.status as "scheduled" | "sent" | "failed" | "skipped" | "paused"));
      if (input.channel) conditions.push(eq(areExecutionQueue.channel, input.channel as "email" | "linkedin" | "sms" | "voice"));
      return db
        .select()
        .from(areExecutionQueue)
        .where(and(...conditions))
        .orderBy(desc(areExecutionQueue.scheduledAt))
        .limit(input.limit)
        .offset(input.offset);
    }),

  pause: workspaceProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      await db.update(areExecutionQueue).set({ status: "paused" })
        .where(and(eq(areExecutionQueue.id, input.id), eq(areExecutionQueue.workspaceId, ctx.workspace.id)));
      return { success: true };
    }),

  resume: workspaceProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      await db.update(areExecutionQueue).set({ status: "scheduled" })
        .where(and(eq(areExecutionQueue.id, input.id), eq(areExecutionQueue.workspaceId, ctx.workspace.id)));
      return { success: true };
    }),

  getSignalLog: workspaceProcedure
    .input(z.object({
      campaignId: z.number().optional(),
      prospectId: z.number().optional(),
      signalType: z.string().optional(),
      limit: z.number().default(100),
    }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const conditions = [eq(areSignalLog.workspaceId, ctx.workspace.id)];
      if (input.campaignId) conditions.push(eq(areSignalLog.campaignId, input.campaignId));
      if (input.prospectId) conditions.push(eq(areSignalLog.prospectQueueId, input.prospectId));
      return db
        .select()
        .from(areSignalLog)
        .where(and(...conditions))
        .orderBy(desc(areSignalLog.processedAt))
        .limit(input.limit);
    }),

  /** Ingest an incoming signal (called from webhook or manual test) */
  ingestSignal: workspaceProcedure
    .input(z.object({
      prospectQueueId: z.number(),
      campaignId: z.number(),
      signalType: z.enum([
        "email_open", "email_click", "email_reply", "email_bounce", "email_unsubscribe",
        "linkedin_accepted", "linkedin_reply",
        "sms_reply", "sms_unsubscribe",
        "voice_connected_interested", "voice_connected_not_interested", "voice_voicemail", "voice_no_answer",
        "meeting_booked", "opportunity_created",
      ]),
      rawPayload: z.record(z.string(), z.any()).default({}),
      executionQueueId: z.number().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      await processSignal(
        ctx.workspace.id,
        input.prospectQueueId,
        input.campaignId,
        input.signalType,
        input.rawPayload,
        input.executionQueueId,
      );
      return { success: true };
    }),

  getSuppressionList: workspaceProcedure
    .input(z.object({ limit: z.number().default(100) }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      return db
        .select()
        .from(areSuppressionList)
        .where(eq(areSuppressionList.workspaceId, ctx.workspace.id))
        .orderBy(desc(areSuppressionList.addedAt))
        .limit(input.limit);
    }),

  addSuppression: workspaceProcedure
    .input(z.object({
      email: z.string().email().optional(),
      linkedinUrl: z.string().optional(),
      companyDomain: z.string().optional(),
      reason: z.enum(["unsubscribe", "bounce", "competitor", "existing_customer", "manual", "do_not_contact"]),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      await db.insert(areSuppressionList).values({
        workspaceId: ctx.workspace.id,
        email: input.email,
        linkedinUrl: input.linkedinUrl,
        companyDomain: input.companyDomain,
        reason: input.reason,
        addedByUserId: ctx.user.id,
      });
      return { success: true };
    }),
});
