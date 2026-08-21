/**
 * ARE — Execution Router
 *
 * Manages the outreach execution queue and Signal Feedback Agent.
 *
 * SIGNAL FEEDBACK AGENT — processes incoming signals (replies, opens, etc.):
 *   1. Sentiment analysis via LLM (positive/neutral/negative/objection)
 *   2. Determines action: pause sequence, create opportunity, add suppression
 *   3. Promotes the prospect to the CRM on a positive signal / booked meeting
 *   4. Writes an are_signal_log row — the durable record everything downstream
 *      reads
 *
 * What this module does NOT do, despite two long-standing claims here:
 *   • It does not "update A/B variant performance counters". Nothing ever wrote
 *     are_ab_variants.sentCount/openCount/replyCount/meetingCount; the A/B tab
 *     rendered permanent 0% bars for months because of it. Those counters are
 *     now dead columns — A/B performance is COMPUTED on read from the execution
 *     queue plus this signal log (services/performanceMetrics.getAbVariantStats).
 *   • It does not itself "reinforce ICP dimensions". Signals reach the ICP
 *     indirectly and on a schedule: getSegmentPerformance aggregates these rows
 *     into reply/meeting rates per industry/title/size/geography, which the
 *     daily ICP inference consumes (routers/are/icp.ts). Nothing in this file
 *     writes to icp_profiles.
 *
 * The practical consequence: adding a new signal type here makes it available to
 * the metrics layer automatically, but no counter anywhere needs updating.
 */
import { TRPCError } from "@trpc/server";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import {
  areCampaigns,
  areExecutionQueue,
  areSignalLog,
  areSuppressionList,
  contacts,
  opportunities,
  prospectQueue,
  prospectIntelligence,
  sendingAccounts,
} from "../../../drizzle/schema";
import { getDb } from "../../db";
import { findOrCreateAccount } from "../../services/crmMatching";
import { invokeLLM } from "../../_core/llm";
import { router } from "../../_core/trpc";
import { workspaceProcedure } from "../../_core/workspace";
import { activeOwnerOrNull, workspaceNotifyUserId } from "../../_core/activeMembers";
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
/**
 * Map an ARE intelligence record onto the intent keys the priority scorer reads.
 *
 * The enrichment pass pays an LLM to find trigger events and pain signals, and
 * until now all of it stayed in `prospect_intelligence` — keyed by
 * prospectQueueId, which no CRM surface joins on. Promotion is the one moment
 * the code holds both records, so it is where the data gets carried across.
 * The keys are the ones `intentScoreFromRow` reads, and they are RESERVED in
 * @shared/customFieldKeys precisely so an engine can own them.
 *
 * ⚠️ Deliberately conservative. `triggerEvents[].type` is FREE TEXT — the
 * enrichment JSON schema declares it `{ type: "string" }` with no enum — so
 * deciding "is this a funding round?" would be string-matching an LLM's prose.
 * `recentFunding`, `recentExecChange`, `hiringSignals` and `websiteKeywords`
 * are therefore left ABSENT rather than guessed, and absent means unmeasured
 * (they contribute nothing) rather than a fabricated zero.
 *
 * Pure; the write is separate, so the mapping is testable without a database.
 */
export function intentKeysFromIntelligence(intel: {
  triggerEvents?: unknown;
  painSignals?: unknown;
  recentNews?: unknown;
}): Record<string, unknown> | null {
  const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
  const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

  const topics: string[] = [];
  const push = (s: string) => {
    if (s && !topics.includes(s) && topics.length < 20) topics.push(s);
  };
  for (const p of arr(intel.painSignals)) push(text((p as { signal?: unknown })?.signal));
  for (const t of arr(intel.triggerEvents)) push(text((t as { type?: unknown })?.type));

  const news = arr(intel.recentNews);
  const out: Record<string, unknown> = {};
  if (topics.length) out.intentTopics = topics;
  if (news.length) out.recentNews = news;
  return Object.keys(out).length ? out : null;
}

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

  /**
   * 🔴 THIS ID IS STAMPED ON BRAND-NEW RECORDS, not inherited by old ones.
   *
   * `promoteProspectToCrm` runs on a POSITIVE SIGNAL — a prospect replied
   * interestedly, or booked a meeting — and creates an account, a contact and
   * (when the campaign says so) an opportunity, all owned by whoever owns the
   * ARE campaign. Read raw, an autonomous campaign whose owner had left kept
   * minting fresh CRM records owned by a user who no longer exists, at the
   * exact moment a stranger turned into a deal. `95eca9c` reassigns the
   * accounts and contacts that ALREADY exist when somebody is offboarded; this
   * path would have gone on creating new ones forever afterwards.
   *
   * ⚖️ FALLS BACK RATHER THAN GOING UNOWNED, which is the opposite of what the
   * public forms and landing pages do — and the difference is deliberate.
   * Those take anonymous, high-volume traffic where an unowned lead sitting in
   * a shared list is genuinely better than a wrong owner. This fires rarely and
   * on the strongest buying signal the product has, so a record nobody owns is
   * a deal nobody follows up. The fallback is `workspaceNotifyUserId` — not an
   * invented rule, but the SAME recipient `areNotify` already sends this very
   * event's notification to, so the record lands with the person already being
   * told about it.
   */
  const owner =
    (await activeOwnerOrNull(workspaceId, campaign.ownerUserId)) ??
    (await workspaceNotifyUserId(workspaceId)) ??
    undefined;
  const companyName = prospect.companyName ?? "Unknown Company";

  /**
   * Shared with the People-list promotion (services/prospectPromotion), which
   * needs the identical rule. Two copies of "is this the same company?" is how
   * one of them silently starts creating duplicate accounts, so the matching
   * moved to services/crmMatching and both call it. Behaviour is unchanged:
   * domain first, then name, then create.
   */
  const accountId: number = await findOrCreateAccount(db, workspaceId, {
    companyName,
    companyDomain: prospect.companyDomain,
    industry: prospect.industry,
    ownerUserId: owner,
  });

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
    // People-as-master (0160): the queue row usually already knows its
    // person (0153 ingest seam) — direct write; otherwise the tiered upsert.
    // Fire-and-forget either way; the daily backfill heals misses.
    if (prospect.personProspectId) {
      void db.update(contacts).set({ personProspectId: prospect.personProspectId } as never)
        .where(and(eq(contacts.workspaceId, workspaceId), eq(contacts.id, contactId)))
        .catch((e: unknown) => console.error("[personLink] signal-contact link failed:", (e as Error).message));
    } else {
      void import("../../services/personLink")
        .then((m) => m.upsertPersonForContact(workspaceId, {
          id: contactId!, firstName: prospect.firstName, lastName: prospect.lastName,
          email: prospect.email, phone: prospect.phone, title: prospect.title,
          linkedinUrl: prospect.linkedinUrl, companyName: prospect.companyName, companyDomain: prospect.companyDomain,
        }))
        .catch((e) => console.error("[personLink] signal-contact link failed:", (e as Error).message));
    }
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

  // ── Carry the ARE enrichment onto the contact ───────────────────────────
  // Everything the enrichment pass learned lives in prospect_intelligence,
  // keyed by prospectQueueId — which no CRM surface joins on, so it was
  // invisible the moment the prospect became a contact. Best-effort: losing
  // the carry-over must never fail a promotion.
  try {
    const [intelForContact] = await db.select().from(prospectIntelligence)
      .where(and(
        eq(prospectIntelligence.prospectQueueId, prospectQueueId),
        eq(prospectIntelligence.workspaceId, workspaceId),
      )).limit(1);
    const intentKeys = intelForContact ? intentKeysFromIntelligence(intelForContact) : null;
    if (intentKeys && contactId) {
      const [existingContact] = await db.select({ customFields: contacts.customFields })
        .from(contacts)
        .where(and(eq(contacts.id, contactId), eq(contacts.workspaceId, workspaceId)))
        .limit(1);
      const current = (existingContact?.customFields as Record<string, unknown> | null) ?? {};
      await db.update(contacts)
        // Merge: the admin-defined custom field values live in this same blob.
        .set({ customFields: { ...current, ...intentKeys } } as never)
        .where(and(eq(contacts.id, contactId), eq(contacts.workspaceId, workspaceId)));
    }
  } catch (e) {
    console.error("[ARE] intelligence carry-over failed:", e instanceof Error ? e.message : e);
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

  // P3.3: bridge the HIGH-INTENT ARE signals into the workflow-rule system.
  // Deliberately a small allow-list — the two signal systems keep their own
  // vocabularies; this is a producer, not a merge. Rules gated on
  // signal_received can now react to a booked meeting or a reply.
  const WORKFLOW_BRIDGED_SIGNALS = new Set(["meeting_booked", "email_reply"]);
  if (WORKFLOW_BRIDGED_SIGNALS.has(signalType)) {
    try {
      const { fireWorkflowRules } = await import("../../services/workflowEngine");
      await fireWorkflowRules(workspaceId, "signal_received", {
        payload: { signal: signalType, entity: "are_prospect", campaignId, sentiment: sentiment ?? null },
        relatedType: "prospect_queue",
        relatedId: prospectQueueId,
      });
    } catch (e) {
      console.error(`[ARE] workflow bridge for ${signalType} failed:`, (e as Error)?.message ?? e);
    }
  }
}

/**
 * Attribute a just-booked meeting back to its originating ARE campaign.
 *
 * Called (fire-and-forget) from the meeting-booking chokepoint sendMeetingInvite
 * after a meeting is scheduled. If the attendee's email matches an ARE
 * prospect_queue row, we run the SAME `meeting_booked` signal path a manual /
 * webhook signal would — so the campaign's headline `meetingsBooked` KPI
 * increments and the prospect is promoted to the CRM.
 *
 * Why this exists: `meetingsBooked` only ever moved when someone POSTed a
 * `meeting_booked` signal by hand. Every meeting booked autonomously (Meeting
 * Autopilot's auto mode, a prospect self-booking via /b/:slug, a rep booking a
 * proposed time) went uncounted — the metric the whole product optimises for
 * ("meetings booked for sales calls") sat at 0 in autonomous operation.
 *
 * Deduped via are_signal_log so a reschedule or a repeat invite counts once.
 * No-op when the attendee isn't an ARE-sourced prospect. Best-effort: never
 * throws into the booking flow.
 */
export async function attributeMeetingBookingToAre(
  workspaceId: number,
  meeting: { id: number; contactEmail?: string | null },
): Promise<void> {
  try {
    const db = await getDb();
    if (!db) return;
    const email = (meeting.contactEmail ?? "").trim().toLowerCase();
    if (!email) return;

    // Emails can recur across campaigns — attribute to the attendee's most
    // recent ARE prospect row.
    const [row] = await db
      .select({ id: prospectQueue.id, campaignId: prospectQueue.campaignId })
      .from(prospectQueue)
      .where(and(
        eq(prospectQueue.workspaceId, workspaceId),
        sql`lower(${prospectQueue.email}) = ${email}`,
      ))
      .orderBy(desc(prospectQueue.id))
      .limit(1);
    if (!row) return; // attendee isn't an ARE-sourced prospect — nothing to attribute

    // Only the first booking for a prospect counts.
    const [prior] = await db
      .select({ id: areSignalLog.id })
      .from(areSignalLog)
      .where(and(
        eq(areSignalLog.prospectQueueId, row.id),
        eq(areSignalLog.signalType, "meeting_booked" as never),
      ))
      .limit(1);
    if (prior) return;

    await processSignal(workspaceId, row.id, row.campaignId, "meeting_booked", {
      source: "autonomous_booking",
      meetingId: meeting.id,
    });
  } catch (e) {
    console.error(`[ARE] attributeMeetingBookingToAre failed for meeting ${meeting.id}:`, (e as Error).message);
  }
}

/* ─── Per-step representative rows (the Sequences tab's progress truth) ──── */

/**
 * A (prospect, stepIndex) pair accumulates rows over its life: the canceled
 * copy from a regeneration, the failed no-email attempt, the re-enrolled
 * scheduled row, eventually a sent one. The question the Sequences tab asks —
 * "where is this step up to" — has ONE answer per step, and it is the row
 * ranked here: a send is history and outranks everything; a scheduled row is
 * the live plan and outranks any dead attempt; among equals the newest row is
 * the current generation.
 *
 * Exists because the tab used to read raw `getQueue` rows with `limit: 200`
 * (its comment: "an active campaign has a handful of enrolled prospects") —
 * campaign 21 holds 1,000+ rows, the page was the 200 FUTURE-most by
 * scheduledAt, and every SENT row (past dates) fell off it. Live 2026-08-20:
 * a prospect two emails into her sequence rendered as "0/7 sent · next:
 * step 4 Sep 6" (owner report). The unfiltered-page-boundary class again —
 * the fix is a reduction, not a bigger limit.
 */
const STEP_STATE_PRECEDENCE: Record<string, number> = { sent: 0, scheduled: 1, paused: 2, failed: 3, skipped: 4 };

export function reduceStepStates<T extends { id: number; prospectQueueId: number; stepIndex: number; status: string }>(rows: T[]): T[] {
  const best = new Map<string, T>();
  for (const r of rows) {
    const k = `${r.prospectQueueId}:${r.stepIndex}`;
    const cur = best.get(k);
    if (!cur) { best.set(k, r); continue; }
    const a = STEP_STATE_PRECEDENCE[r.status] ?? 9;
    const b = STEP_STATE_PRECEDENCE[cur.status] ?? 9;
    if (a < b || (a === b && r.id > cur.id)) best.set(k, r);
  }
  return Array.from(best.values());
}

/* ─── Router ─────────────────────────────────────────────────────────────── */

export const executionRouter = router({
  /**
   * One representative row per (prospect, stepIndex) for a whole campaign —
   * see reduceStepStates. Deliberately NO LIMIT on the scan: the reduction is
   * the bound (≤ prospects × steps rows out), and a limited scan is exactly
   * the truncation this endpoint exists to replace.
   */
  getStepStates: workspaceProcedure
    .input(z.object({ campaignId: z.number() }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const rows = await db
        .select({
          id: areExecutionQueue.id,
          prospectQueueId: areExecutionQueue.prospectQueueId,
          stepIndex: areExecutionQueue.stepIndex,
          channel: areExecutionQueue.channel,
          status: areExecutionQueue.status,
          scheduledAt: areExecutionQueue.scheduledAt,
          executedAt: areExecutionQueue.executedAt,
        })
        .from(areExecutionQueue)
        .where(and(
          eq(areExecutionQueue.workspaceId, ctx.workspace.id),
          eq(areExecutionQueue.campaignId, input.campaignId),
        ));
      return reduceStepStates(rows);
    }),

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

  /**
   * The signal feed, with WHO produced each signal and WHAT it answers.
   *
   * Used to be a bare `select()` off are_signal_log, so the Signals tab could
   * only render the machine vocabulary: a type slug, a sentiment, a timestamp.
   * The person was one join away (prospect_queue) and the message they acted on
   * was another (are_execution_queue) — an activity feed that cannot say who
   * did the thing is not an activity feed.
   *
   * Both joins are LEFT: a signal survives its prospect being deleted, and
   * reply/meeting signals carry no executionQueueId at all (the inbound poller
   * matches on the person, not on a specific send), so an inner join would
   * silently drop exactly the signals that matter most.
   *
   * `signalType` was accepted in the input and never applied — every "filter"
   * returned the unfiltered feed. Applied here, in SQL, alongside the LIMIT:
   * filtering a limited page in JS is the shape that emptied the Active tab
   * (320072b).
   */
  getSignalLog: workspaceProcedure
    .input(z.object({
      campaignId: z.number().optional(),
      prospectId: z.number().optional(),
      signalType: z.string().optional(),
      /** Person search — name, email or company. Applied in SQL, see below. */
      search: z.string().optional(),
      limit: z.number().default(100),
    }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const conditions = [eq(areSignalLog.workspaceId, ctx.workspace.id)];
      if (input.campaignId) conditions.push(eq(areSignalLog.campaignId, input.campaignId));
      if (input.prospectId) conditions.push(eq(areSignalLog.prospectQueueId, input.prospectId));
      if (input.signalType) conditions.push(eq(areSignalLog.signalType, input.signalType as never));
      const term = (input.search ?? "").trim();
      if (term) {
        const like = `%${term}%`;
        conditions.push(sql`(
          CONCAT_WS(' ', ${prospectQueue.firstName}, ${prospectQueue.lastName}) LIKE ${like}
          OR ${prospectQueue.email} LIKE ${like}
          OR ${prospectQueue.companyName} LIKE ${like}
        )`);
      }
      return db
        .select({
          id: areSignalLog.id,
          signalType: areSignalLog.signalType,
          sentiment: areSignalLog.sentiment,
          sentimentReason: areSignalLog.sentimentReason,
          actionTaken: areSignalLog.actionTaken,
          processedAt: areSignalLog.processedAt,
          rawPayload: areSignalLog.rawPayload,
          campaignId: areSignalLog.campaignId,
          // ── who ──
          prospectQueueId: areSignalLog.prospectQueueId,
          firstName: prospectQueue.firstName,
          lastName: prospectQueue.lastName,
          email: prospectQueue.email,
          title: prospectQueue.title,
          companyName: prospectQueue.companyName,
          linkedinUrl: prospectQueue.linkedinUrl,
          // Where the person can be opened: their CRM contact once promoted,
          // else their canonical People row (migration 0153).
          linkedContactId: prospectQueue.linkedContactId,
          personProspectId: prospectQueue.personProspectId,
          // ── what they acted on ──
          executionQueueId: areSignalLog.executionQueueId,
          stepIndex: areExecutionQueue.stepIndex,
          channel: areExecutionQueue.channel,
          messageContent: areExecutionQueue.messageContent,
          messageSentAt: areExecutionQueue.executedAt,
          messageStatus: areExecutionQueue.status,
        })
        .from(areSignalLog)
        .leftJoin(prospectQueue, eq(prospectQueue.id, areSignalLog.prospectQueueId))
        .leftJoin(areExecutionQueue, eq(areExecutionQueue.id, areSignalLog.executionQueueId))
        .where(and(...conditions))
        .orderBy(desc(areSignalLog.processedAt))
        .limit(input.limit);
    }),

  /**
   * One dispatched message, with everything known about it.
   *
   * Backs the preview modal opened from the Signals feed and the Step
   * performance cards: the copy that actually went out (not the stored
   * template), who it went to, which inbox sent it, and every signal it
   * produced. Assembled here rather than in the client so the modal cannot
   * show a different open count from the tab behind it.
   */
  getMessage: workspaceProcedure
    .input(z.object({ executionQueueId: z.number() }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const [row] = await db
        .select({
          q: areExecutionQueue,
          firstName: prospectQueue.firstName,
          lastName: prospectQueue.lastName,
          email: prospectQueue.email,
          title: prospectQueue.title,
          companyName: prospectQueue.companyName,
          linkedContactId: prospectQueue.linkedContactId,
          personProspectId: prospectQueue.personProspectId,
          campaignName: areCampaigns.name,
          accountName: sendingAccounts.name,
          accountEmail: sendingAccounts.fromEmail,
        })
        .from(areExecutionQueue)
        .leftJoin(prospectQueue, eq(prospectQueue.id, areExecutionQueue.prospectQueueId))
        .leftJoin(areCampaigns, eq(areCampaigns.id, areExecutionQueue.campaignId))
        .leftJoin(sendingAccounts, eq(sendingAccounts.id, areExecutionQueue.sendingAccountId))
        .where(and(
          eq(areExecutionQueue.id, input.executionQueueId),
          eq(areExecutionQueue.workspaceId, ctx.workspace.id),
        ))
        .limit(1);
      if (!row) throw new TRPCError({ code: "NOT_FOUND" });

      const signals = await db
        .select({
          id: areSignalLog.id,
          signalType: areSignalLog.signalType,
          sentiment: areSignalLog.sentiment,
          sentimentReason: areSignalLog.sentimentReason,
          actionTaken: areSignalLog.actionTaken,
          processedAt: areSignalLog.processedAt,
          rawPayload: areSignalLog.rawPayload,
        })
        .from(areSignalLog)
        .where(and(
          eq(areSignalLog.workspaceId, ctx.workspace.id),
          eq(areSignalLog.prospectQueueId, row.q.prospectQueueId),
        ))
        .orderBy(desc(areSignalLog.processedAt))
        .limit(50);

      const mc = (row.q.messageContent ?? null) as { subject?: string; body?: string; variantKey?: string } | null;
      return {
        id: row.q.id,
        campaignId: row.q.campaignId,
        campaignName: row.campaignName ?? null,
        prospectQueueId: row.q.prospectQueueId,
        stepIndex: row.q.stepIndex,
        channel: row.q.channel,
        status: row.q.status,
        // A sent row cannot also carry a failure reason — the dispatcher's
        // pre-mark used to leave one behind (migration 0164).
        failureReason: row.q.status === "sent" ? null : row.q.failureReason,
        scheduledAt: row.q.scheduledAt,
        executedAt: row.q.executedAt,
        subject: mc?.subject ?? null,
        body: mc?.body ?? null,
        variantKey: mc?.variantKey ?? "A",
        // Engagement. openCount is HUMAN opens since migration 0165;
        // machineOpenCount is the prefetch traffic, shown separately so the
        // split is visible rather than hidden.
        openedAt: row.q.openedAt,
        openCount: row.q.openCount,
        machineOpenCount: (row.q as { machineOpenCount?: number }).machineOpenCount ?? 0,
        /** False when this send predates open tracking — no token, no opens ever. */
        opensTracked: !!row.q.trackingToken,
        recipient: {
          firstName: row.firstName,
          lastName: row.lastName,
          email: row.email,
          title: row.title,
          companyName: row.companyName,
          linkedContactId: row.linkedContactId,
          personProspectId: row.personProspectId,
        },
        sentFrom: {
          accountId: row.q.sendingAccountId ?? null,
          name: row.accountName ?? null,
          email: row.accountEmail ?? row.q.fromEmail ?? null,
        },
        signals,
      };
    }),

  /**
   * The most recent dispatched message for a (step, variant) cell.
   *
   * The Step performance cards describe a STEP, not one message, so opening
   * one has to resolve an example to show. Newest first, because that is the
   * copy the engine is currently producing.
   */
  findStepMessage: workspaceProcedure
    .input(z.object({
      campaignId: z.number(),
      stepIndex: z.number(),
      variantKey: z.string().default("A"),
    }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const [row] = await db
        .select({ id: areExecutionQueue.id })
        .from(areExecutionQueue)
        .where(and(
          eq(areExecutionQueue.workspaceId, ctx.workspace.id),
          eq(areExecutionQueue.campaignId, input.campaignId),
          eq(areExecutionQueue.stepIndex, input.stepIndex),
          eq(areExecutionQueue.status, "sent" as never),
        ))
        .orderBy(desc(areExecutionQueue.executedAt), desc(areExecutionQueue.id))
        .limit(1);
      return { executionQueueId: row?.id ?? null };
    }),

  /**
   * How many of each signal type this campaign has produced.
   *
   * Exists so the feed's type filter can show a TRUE total per type. Counting
   * the rows already on screen would count a page — with getSignalLog limited,
   * "Email open 50" would mean "50 of them fit", which is the same lie the
   * unordered LIMIT told on the Active tab.
   */
  getSignalCounts: workspaceProcedure
    .input(z.object({ campaignId: z.number().optional() }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const conditions = [eq(areSignalLog.workspaceId, ctx.workspace.id)];
      if (input.campaignId) conditions.push(eq(areSignalLog.campaignId, input.campaignId));
      const rows = await db
        .select({
          signalType: areSignalLog.signalType,
          count: sql<number>`count(*)`,
          lastAt: sql<Date>`max(${areSignalLog.processedAt})`,
        })
        .from(areSignalLog)
        .where(and(...conditions))
        .groupBy(areSignalLog.signalType);
      return rows.map((r) => ({
        signalType: r.signalType as string,
        count: Number(r.count) || 0,
        lastAt: r.lastAt,
      }));
    }),

  /**
   * Put steps skipped as "channel not wired" back on the queue.
   *
   * Wiring LinkedIn (2026-08-15) does not revive the steps already skipped for
   * it — dispatch only picks up `scheduled` rows, and a migration that flipped
   * them silently would be the wrong shape for this decision. Those steps were
   * written for a moment that has passed: on the campaigns as they stand, the
   * oldest is due 19 June. Reviving a step-3 follow-up whose step 1 never went
   * out reads strangely to the recipient, so it is the owner's call, not a
   * side effect of a deploy.
   *
   * `dryRun` defaults TRUE: the first call tells you how many rows it would
   * touch. Nothing here sends anything — it re-queues, and the daily cap, the
   * campaign's own paused/active state and the LinkedIn activity gate all
   * still stand between a re-queued step and an actual send.
   */
  reviveSkippedSteps: workspaceProcedure
    .input(z.object({
      campaignId: z.number(),
      channel: z.enum(["linkedin", "sms", "voice"]).default("linkedin"),
      /** Re-schedule for now, rather than leaving a due date months past. */
      rescheduleNow: z.boolean().default(true),
      dryRun: z.boolean().default(true),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      // Matched on the reason PREFIX so both the old wording ("ARE engine v1
      // sends email only") and the current one qualify — the sentence changed
      // when the channel was wired.
      const reasonLike = `Channel '${input.channel}' not wired%`;
      const rows = await db
        .select({ id: areExecutionQueue.id, prospectQueueId: areExecutionQueue.prospectQueueId })
        .from(areExecutionQueue)
        .where(and(
          eq(areExecutionQueue.workspaceId, ctx.workspace.id),
          eq(areExecutionQueue.campaignId, input.campaignId),
          eq(areExecutionQueue.channel, input.channel as never),
          eq(areExecutionQueue.status, "skipped" as never),
          sql`${areExecutionQueue.failureReason} LIKE ${reasonLike}`,
        ));
      if (input.dryRun || rows.length === 0) {
        return { dryRun: true, wouldRevive: rows.length, revived: 0 };
      }
      /**
       * The clause is written out here rather than shared with the SELECT
       * above through a variable. `tenantScope.test.ts` rejects a destructive
       * statement whose WHERE it cannot read — and it is right to: an
       * unreadable UPDATE passes every scoping check by default, so a later
       * edit could drop the workspace predicate and nothing would notice.
       * Duplication is the price of the statement being auditable where it is.
       */
      await db
        .update(areExecutionQueue)
        .set({
          status: "scheduled",
          failureReason: null,
          executedAt: null,
          ...(input.rescheduleNow ? { scheduledAt: new Date() } : {}),
        } as never)
        .where(and(
          eq(areExecutionQueue.workspaceId, ctx.workspace.id),
          eq(areExecutionQueue.campaignId, input.campaignId),
          eq(areExecutionQueue.channel, input.channel as never),
          eq(areExecutionQueue.status, "skipped" as never),
          sql`${areExecutionQueue.failureReason} LIKE ${reasonLike}`,
        ));
      // Same reason the email heal revives its prospects: the completion sweep
      // only scans "enrolled", so a re-queued step under a "completed" prospect
      // would dispatch beneath a lying status.
      const ids = Array.from(new Set(rows.map((r) => r.prospectQueueId)));
      if (ids.length) {
        await db
          .update(prospectQueue)
          .set({ sequenceStatus: "enrolled" } as never)
          .where(and(
            inArray(prospectQueue.id, ids),
            eq(prospectQueue.sequenceStatus, "completed" as never),
          ));
      }
      return { dryRun: false, wouldRevive: rows.length, revived: rows.length };
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
