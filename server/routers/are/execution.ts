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
import { areNotify } from "./notify";
import { runSignalEnhancement } from "./signalEnhancement";

/* ─── Prospect → CRM promotion ──────────────────────────────────────────── */

/**
 * Promote an ARE queue row into real CRM records.
 *
 * Until now this lived inline in the meeting_booked branch and was the ONLY
 * way an ARE prospect ever reached the CRM — so a prospect that was sourced,
 * enriched, sequenced, mailed and even replied to still appeared nowhere on
 * the People or Companies pages. (And since processSignal itself had no
 * caller, in practice it never ran at all.)
 *
 * Product rule, user-chosen 2026-07-18: promote on a POSITIVE SIGNAL, not on
 * discovery. The People page stays a list of humans who engaged rather than
 * filling up with unvalidated sourcing output. Note the schema comment on
 * prospectQueue.linkedContactId already said "created after positive reply" —
 * this is the behaviour the columns were designed for.
 *
 * `createOpportunity` is separate and heavier: a positive reply makes someone
 * a contact, but only a booked meeting (with the campaign's
 * signalToOpportunityEnabled on) creates a deal in the pipeline.
 *
 * Idempotent: re-running for the same prospect reuses the linked contact
 * rather than creating duplicates, so a second positive signal is safe.
 */
export async function promoteProspectToCrm(
  workspaceId: number,
  prospectQueueId: number,
  campaignId: number,
  opts: { createOpportunity: boolean },
): Promise<{ accountId: number; contactId: number; opportunityId?: number } | null> {
  const db = await getDb();
  if (!db) return null;

  const [prospect] = await db.select().from(prospectQueue)
    .where(eq(prospectQueue.id, prospectQueueId)).limit(1);
  if (!prospect) return null;
  const [campaign] = await db.select().from(areCampaigns)
    .where(eq(areCampaigns.id, campaignId)).limit(1);
  if (!campaign) return null;

  const owner = campaign.ownerUserId ?? undefined;
  const companyName = prospect.companyName ?? "Unknown Company";

  // ── Account: match on DOMAIN first, then name. Domain is the reliable
  // identity (two "Acme" rows are usually different companies; one domain
  // is one company), and Apollo now supplies a domain for free.
  let accountId: number | undefined;
  if (prospect.companyDomain) {
    const [byDomain] = await db.select({ id: accounts.id }).from(accounts)
      .where(and(eq(accounts.workspaceId, workspaceId), eq(accounts.domain, prospect.companyDomain)))
      .limit(1);
    if (byDomain) accountId = byDomain.id;
  }
  if (!accountId) {
    const [byName] = await db.select({ id: accounts.id }).from(accounts)
      .where(and(eq(accounts.workspaceId, workspaceId), eq(accounts.name, companyName)))
      .limit(1);
    if (byName) accountId = byName.id;
  }
  if (!accountId) {
    const [newAcc] = await db.insert(accounts).values({
      workspaceId,
      name: companyName,
      domain: prospect.companyDomain ?? undefined,
      industry: prospect.industry ?? undefined,
      ownerUserId: owner,
    }).$returningId();
    accountId = newAcc.id;
  }

  // ── Contact: reuse the previously linked row, else match on email, else
  // create. The old inline code inserted unconditionally, so a prospect who
  // triggered two positive signals became two contacts.
  let contactId: number | undefined = prospect.linkedContactId ?? undefined;
  if (!contactId && prospect.email) {
    const [byEmail] = await db.select({ id: contacts.id }).from(contacts)
      .where(and(eq(contacts.workspaceId, workspaceId), eq(contacts.email, prospect.email)))
      .limit(1);
    if (byEmail) contactId = byEmail.id;
  }
  if (!contactId) {
    const [newContact] = await db.insert(contacts).values({
      workspaceId,
      accountId,
      firstName: prospect.firstName ?? "Unknown",
      lastName: prospect.lastName ?? "Prospect",
      title: prospect.title ?? undefined,
      email: prospect.email ?? undefined,
      phone: prospect.phone ?? undefined,
      linkedinUrl: prospect.linkedinUrl ?? undefined,
      companyName: prospect.companyName ?? undefined,
      companyDomain: prospect.companyDomain ?? undefined,
      ownerUserId: owner,
    }).$returningId();
    contactId = newContact.id;
  }

  let opportunityId: number | undefined;
  if (opts.createOpportunity) {
    const [intel] = await db.select().from(prospectIntelligence)
      .where(eq(prospectIntelligence.prospectQueueId, prospectQueueId)).limit(1);
    // prospectIntelligence stores these as TOP-LEVEL json columns — there is
    // no `data` wrapper, so an earlier `intel?.data?.x` always resolved
    // undefined and the note was permanently blank.
    const hooks = ((intel?.personalisationHooks as Array<{ hook: string }> | null) ?? []);
    const pains = ((intel?.painSignals as Array<{ signal: string }> | null) ?? []);
    const timing = intel?.recommendedTiming as { dayOfWeek?: string; hourOfDay?: number; timezone?: string } | null;
    const timingStr = timing
      ? [timing.dayOfWeek, timing.hourOfDay != null ? `${timing.hourOfDay}:00` : null, timing.timezone].filter(Boolean).join(" ")
      : "";
    const aiNote = [
      `ARE Campaign: ${campaign.name}`,
      hooks.length > 0 ? `Hooks: ${hooks.slice(0, 2).map(h => h.hook).join(" | ")}` : null,
      pains.length > 0 ? `Pain signals: ${pains.slice(0, 2).map(p => p.signal).join(", ")}` : null,
      timingStr ? `Best timing: ${timingStr}` : null,
    ].filter(Boolean).join("\n");

    const [newOpp] = await db.insert(opportunities).values({
      workspaceId,
      accountId,
      name: `${companyName} — ARE Meeting`,
      stage: "discovery",
      value: "0",
      winProb: 30,
      aiNote: aiNote || undefined,
      campaignId,
      ownerUserId: owner,
    }).$returningId();
    opportunityId = newOpp.id;
    await db.execute(sql`UPDATE are_campaigns SET opportunitiesCreated = opportunitiesCreated + 1 WHERE id = ${campaignId}`);
  }

  // Write the linkage back. These columns existed from the start and were
  // never populated by anything, so the queue row and its CRM records had no
  // way to find each other.
  await db.update(prospectQueue)
    .set({
      linkedContactId: contactId,
      ...(opportunityId ? { linkedOpportunityId: opportunityId } : {}),
    })
    .where(eq(prospectQueue.id, prospectQueueId));

  return { accountId, contactId, opportunityId };
}

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
          case "create_opportunity": {
            await db.update(prospectQueue).set({ sequenceStatus: "replied" }).where(eq(prospectQueue.id, prospectQueueId));
            // Increment prospectsReplied counter
            await db.execute(sql`UPDATE are_campaigns SET prospectsReplied = prospectsReplied + 1 WHERE id = ${campaignId}`);
            actionTaken = "flagged_for_opportunity";

            // A positive reply is the promotion trigger the linkedContactId
            // column was designed for ("created after positive reply"). The
            // person becomes a real Contact + Account so the rest of the CRM
            // — timeline, tasks, deals — can work with them. No opportunity
            // yet: replying interestedly isn't a deal, a booked meeting is.
            const promoted = await promoteProspectToCrm(
              workspaceId, prospectQueueId, campaignId, { createOpportunity: false },
            ).catch((e) => {
              console.error("[ARE] promoteProspectToCrm failed on positive reply:", e);
              return null;
            });
            if (promoted) actionTaken = "promoted_to_crm";

            // Notify owner of positive reply
            await areNotify({
              workspaceId,
              eventType: "signal_classified",
              title: "ARE: Positive reply — prospect added to CRM",
              body: `A prospect replied positively. Sentiment: ${sentData.sentiment}. Reason: ${sentData.reason}.` +
                (promoted ? " They've been added to Contacts and Companies." : ""),
              relatedId: campaignId,
              relatedType: "are_campaign",
            });
            break;
          }
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

    // A booked meeting always promotes the prospect into the CRM (it is the
    // strongest positive signal there is). The campaign's
    // signalToOpportunityEnabled flag now governs only the heavier step —
    // whether a deal is also opened in the pipeline.
    const [campaign] = await db.select().from(areCampaigns).where(eq(areCampaigns.id, campaignId)).limit(1);
    const [prospect] = await db.select().from(prospectQueue).where(eq(prospectQueue.id, prospectQueueId)).limit(1);
    const promoted = await promoteProspectToCrm(workspaceId, prospectQueueId, campaignId, {
      createOpportunity: !!campaign?.signalToOpportunityEnabled,
    });

    if (promoted) {
      const who = `${prospect?.firstName ?? ""} ${prospect?.lastName ?? ""}`.trim() || "A prospect";
      const where = prospect?.companyName ?? "their company";
      if (promoted.opportunityId) {
        actionTaken = "opportunity_created";
        await notifyOwner({
          title: `ARE: Meeting booked → Opportunity created`,
          content: `Campaign "${campaign?.name ?? ""}" — ${who} at ${where} booked a meeting. They're now in Contacts, and a new opportunity has been created in the pipeline.`,
        }).catch(() => {/* non-fatal */});
      } else {
        await notifyOwner({
          title: `ARE: Meeting booked`,
          content: `Campaign "${campaign?.name ?? ""}" — ${who} at ${where} booked a meeting and has been added to your CRM. Turn on "Signal to opportunity" in the campaign's settings to also open a deal automatically.`,
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

  // Run Signal Enhancement Agent for positive engagement signals (non-blocking)
  runSignalEnhancement(workspaceId, prospectQueueId, campaignId, signalType).catch(() => {/* non-fatal */});

  // Fire ARE in-app notification for key events
  if (signalType === "email_open" || signalType === "email_click" || signalType === "linkedin_accepted") {
    const [p] = await db.select({ firstName: prospectQueue.firstName, lastName: prospectQueue.lastName, companyName: prospectQueue.companyName }).from(prospectQueue).where(eq(prospectQueue.id, prospectQueueId)).limit(1);
    const label = signalType === "email_open" ? "opened your email" : signalType === "email_click" ? "clicked a link" : "accepted your LinkedIn connection";
    if (p) {
      await areNotify({
        workspaceId,
        eventType: "signal_classified",
        title: "ARE: Engagement signal received",
        body: `${p.firstName ?? ""} ${p.lastName ?? ""} at ${p.companyName ?? "unknown"} ${label}. Hook enhancement is running.`,
        relatedId: campaignId,
        relatedType: "are_campaign",
      });
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
