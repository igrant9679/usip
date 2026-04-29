/**
 * aiFeatures.ts — AI capability gap router (Migration 0050)
 *
 * Procedures:
 *   cs.scoreChurnRisk         — AI churn-risk score for a customer
 *   cs.bulkScoreChurnRisk     — Score all customers in workspace
 *   leads.suggestNextAction   — AI next-action suggestion for a lead
 *   contacts.scoreRelStrength — AI relationship strength for a contact
 *   quotes.suggestPricing     — AI pricing recommendation for a quote
 *   workflows.generateSuggestions — AI workflow suggestions
 *   workflows.dismissSuggestion   — Dismiss a suggestion
 *   workflows.applySuggestion     — Apply suggestion → create workflow rule
 *   forecast.generateCommentary   — AI forecast narrative
 *   forecast.getCommentary        — Get latest commentary for period
 *   mailbox.triageThread          — AI triage label for an email thread
 *   mailbox.bulkTriage            — Triage multiple threads at once
 *   mailbox.getTriageLabels       — Get stored triage labels for account
 */

import { TRPCError } from "@trpc/server";
import { and, desc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { z } from "zod";
import {
  accounts,
  aiWorkflowSuggestions,
  contacts,
  customers,
  forecastAiCommentary,
  leads,
  mailboxAiTriage,
  opportunities,
  quotes,
  quoteLineItems,
  workflowRules,
  workspaceSettings,
  activities,
  emailDrafts,
  aiPipelineJobs,
} from "../../drizzle/schema";
import { getDb } from "../db";
import { invokeLLM } from "../_core/llm";
import { router } from "../_core/trpc";
import { adminWsProcedure, repProcedure, workspaceProcedure } from "../_core/workspace";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function churnLabelFromScore(score: number): string {
  if (score >= 75) return "critical";
  if (score >= 50) return "high";
  if (score >= 25) return "medium";
  return "low";
}

function relLabelFromScore(score: number): string {
  if (score >= 75) return "strong";
  if (score >= 50) return "active";
  if (score >= 25) return "warm";
  return "cold";
}

// ─── CS — Churn Risk ──────────────────────────────────────────────────────────

export const csAiRouter = router({
  /** Score churn risk for a single customer using AI */
  scoreChurnRisk: workspaceProcedure
    .input(z.object({ customerId: z.number().int() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      const [cust] = await db
        .select()
        .from(customers)
        .where(and(eq(customers.id, input.customerId), eq(customers.workspaceId, ctx.workspace.id)));
      if (!cust) throw new TRPCError({ code: "NOT_FOUND" });

      const [acct] = await db.select().from(accounts).where(eq(accounts.id, cust.accountId));

      // Build renewal context
      const daysToRenewal = cust.contractEnd
        ? Math.round((cust.contractEnd.getTime() - Date.now()) / 86400000)
        : null;

      const prompt = `You are a customer success AI. Assess churn risk for this customer and return JSON only.

Customer: ${acct?.name ?? "Unknown"}
ARR: $${Number(cust.arr ?? 0).toLocaleString()}
Health score: ${cust.healthScore}/100 (${cust.healthTier})
Usage score: ${cust.usageScore}/100
Engagement score: ${cust.engagementScore}/100
Support score: ${cust.supportScore}/100
NPS score: ${cust.npsScore} (-100 to +100)
Renewal stage: ${cust.renewalStage}
Days to renewal: ${daysToRenewal !== null ? daysToRenewal : "unknown"}
Tier: ${cust.tier}

Return JSON: { "churnRiskScore": <0-100>, "rationale": "<one sentence>" }
churnRiskScore: 0=no risk, 100=certain churn. Be calibrated — a healthy customer with good NPS should score <20.`;

      let score = 50;
      let rationale = "Insufficient data for AI assessment.";
      try {
        const res = await invokeLLM({
          messages: [{ role: "user", content: prompt }],
          response_format: { type: "json_object" },
          max_tokens: 120,
        });
        const parsed = JSON.parse(res.choices?.[0]?.message?.content ?? "{}");
        score = Math.max(0, Math.min(100, Math.round(Number(parsed.churnRiskScore ?? 50))));
        rationale = String(parsed.rationale ?? rationale).slice(0, 300);
      } catch {
        // Use heuristic fallback
        score = cust.healthScore < 35 ? 75 : cust.healthScore < 55 ? 45 : 15;
        rationale = `Heuristic: health score ${cust.healthScore}/100 (${cust.healthTier}).`;
      }

      const label = churnLabelFromScore(score);
      await db
        .update(customers)
        .set({ churnRiskScore: score, churnRiskLabel: label, churnRiskRationale: rationale, churnRiskScoredAt: new Date() })
        .where(eq(customers.id, cust.id));

      return { customerId: cust.id, churnRiskScore: score, churnRiskLabel: label, rationale };
    }),

  /** Bulk-score all customers in the workspace that haven't been scored in 7 days */
  bulkScoreChurnRisk: adminWsProcedure.mutation(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

    const sevenDaysAgo = new Date(Date.now() - 7 * 86400000);
    const toScore = await db
      .select()
      .from(customers)
      .where(
        and(
          eq(customers.workspaceId, ctx.workspace.id),
          sql`(${customers.churnRiskScoredAt} IS NULL OR ${customers.churnRiskScoredAt} < ${sevenDaysAgo})`,
        ),
      )
      .limit(50);

    let scored = 0;
    for (const cust of toScore) {
      try {
        const [acct] = await db.select().from(accounts).where(eq(accounts.id, cust.accountId));
        const daysToRenewal = cust.contractEnd
          ? Math.round((cust.contractEnd.getTime() - Date.now()) / 86400000)
          : null;
        const prompt = `Customer success AI. Churn risk JSON only.
Customer: ${acct?.name ?? "Unknown"}, ARR $${Number(cust.arr ?? 0).toLocaleString()}, health ${cust.healthScore}/100 (${cust.healthTier}), NPS ${cust.npsScore}, renewal stage ${cust.renewalStage}, days to renewal ${daysToRenewal ?? "unknown"}.
Return: { "churnRiskScore": <0-100>, "rationale": "<one sentence>" }`;
        const res = await invokeLLM({ messages: [{ role: "user", content: prompt }], response_format: { type: "json_object" }, max_tokens: 100 });
        const parsed = JSON.parse(res.choices?.[0]?.message?.content ?? "{}");
        const score = Math.max(0, Math.min(100, Math.round(Number(parsed.churnRiskScore ?? 50))));
        const label = churnLabelFromScore(score);
        await db.update(customers).set({ churnRiskScore: score, churnRiskLabel: label, churnRiskRationale: String(parsed.rationale ?? "").slice(0, 300), churnRiskScoredAt: new Date() }).where(eq(customers.id, cust.id));
        scored++;
      } catch { /* skip individual failures */ }
    }
    return { scored, total: toScore.length };
  }),
});

// ─── Leads — AI Next Action ───────────────────────────────────────────────────

export const leadsAiRouter = router({
  /** Suggest the next best action for a lead */
  suggestNextAction: workspaceProcedure
    .input(z.object({ leadId: z.number().int() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      const [lead] = await db
        .select()
        .from(leads)
        .where(and(eq(leads.id, input.leadId), eq(leads.workspaceId, ctx.workspace.id)));
      if (!lead) throw new TRPCError({ code: "NOT_FOUND" });

      // Pull recent activities for this lead
      const recentActivities = await db
        .select({ type: activities.type, subject: activities.subject, createdAt: activities.createdAt })
        .from(activities)
        .where(and(eq(activities.workspaceId, ctx.workspace.id), eq(activities.relatedType, "lead"), eq(activities.relatedId, lead.id)))
        .orderBy(desc(activities.createdAt))
        .limit(5);

      const daysSinceCreated = Math.round((Date.now() - lead.createdAt.getTime()) / 86400000);
      const lastActivity = recentActivities[0];
      const daysSinceActivity = lastActivity
        ? Math.round((Date.now() - lastActivity.createdAt.getTime()) / 86400000)
        : daysSinceCreated;

      const prompt = `You are a sales AI. Suggest the single best next action for this lead. Return JSON only.

Lead: ${lead.firstName} ${lead.lastName}, ${lead.title ?? "unknown title"} at ${lead.company ?? "unknown company"}
Source: ${lead.source ?? "unknown"}
Status: ${lead.status}
Score: ${lead.score}/100 (grade: ${lead.grade ?? "ungraded"})
Days since created: ${daysSinceCreated}
Days since last activity: ${daysSinceActivity}
Recent activities: ${recentActivities.map((a) => `${a.type}: ${a.subject ?? "(no subject)"}`).join("; ") || "none"}

Return: { "action": "call|email|linkedin|wait", "note": "<one sentence explaining why and what to say/do>" }`;

      let action = "email";
      let note = "Send a personalised follow-up email.";
      try {
        const res = await invokeLLM({
          messages: [{ role: "user", content: prompt }],
          response_format: { type: "json_object" },
          max_tokens: 150,
        });
        const parsed = JSON.parse(res.choices?.[0]?.message?.content ?? "{}");
        const validActions = ["call", "email", "linkedin", "wait"];
        action = validActions.includes(parsed.action) ? parsed.action : "email";
        note = String(parsed.note ?? note).slice(0, 300);
      } catch { /* use defaults */ }

      await db
        .update(leads)
        .set({ aiNextAction: action, aiNextActionNote: note, aiNextActionAt: new Date() })
        .where(eq(leads.id, lead.id));

      return { leadId: lead.id, action, note };
    }),
});

// ─── Contacts — Relationship Strength ────────────────────────────────────────

export const contactsAiRouter = router({
  /** Score relationship strength for a contact */
  scoreRelStrength: workspaceProcedure
    .input(z.object({ contactId: z.number().int() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      const [contact] = await db
        .select()
        .from(contacts)
        .where(and(eq(contacts.id, input.contactId), eq(contacts.workspaceId, ctx.workspace.id)));
      if (!contact) throw new TRPCError({ code: "NOT_FOUND" });

      // Pull recent activities
      const recentActivities = await db
        .select({ type: activities.type, subject: activities.subject, createdAt: activities.createdAt })
        .from(activities)
        .where(and(eq(activities.workspaceId, ctx.workspace.id), eq(activities.relatedType, "contact"), eq(activities.relatedId, contact.id)))
        .orderBy(desc(activities.createdAt))
        .limit(10);

      const totalInteractions = recentActivities.length;
      const lastActivity = recentActivities[0];
      const daysSinceLast = lastActivity
        ? Math.round((Date.now() - lastActivity.createdAt.getTime()) / 86400000)
        : 999;
      const emailCount = recentActivities.filter((a) => a.type === "email").length;
      const meetingCount = recentActivities.filter((a) => a.type === "meeting").length;

      const prompt = `You are a sales AI. Score the relationship strength with this contact. Return JSON only.

Contact: ${contact.firstName} ${contact.lastName}, ${contact.title ?? "unknown title"}
Total recent interactions (last 10): ${totalInteractions}
Emails: ${emailCount}, Meetings: ${meetingCount}
Days since last interaction: ${daysSinceLast}

Return: { "relStrengthScore": <0-100>, "label": "cold|warm|active|strong" }
0=no relationship, 100=very strong. cold=0-24, warm=25-49, active=50-74, strong=75-100.`;

      let score = 0;
      let label = "cold";
      try {
        const res = await invokeLLM({
          messages: [{ role: "user", content: prompt }],
          response_format: { type: "json_object" },
          max_tokens: 80,
        });
        const parsed = JSON.parse(res.choices?.[0]?.message?.content ?? "{}");
        score = Math.max(0, Math.min(100, Math.round(Number(parsed.relStrengthScore ?? 0))));
        const validLabels = ["cold", "warm", "active", "strong"];
        label = validLabels.includes(parsed.label) ? parsed.label : relLabelFromScore(score);
      } catch {
        // Heuristic fallback
        score = Math.min(100, totalInteractions * 8 + (daysSinceLast < 14 ? 20 : daysSinceLast < 30 ? 10 : 0));
        label = relLabelFromScore(score);
      }

      await db
        .update(contacts)
        .set({ relStrengthScore: score, relStrengthLabel: label, relStrengthAt: new Date() })
        .where(eq(contacts.id, contact.id));

      return { contactId: contact.id, relStrengthScore: score, relStrengthLabel: label };
    }),
});

// ─── Quotes — AI Pricing ──────────────────────────────────────────────────────

export const quotesAiRouter = router({
  /** Generate AI pricing recommendation for a quote */
  suggestPricing: workspaceProcedure
    .input(z.object({ quoteId: z.number().int() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      const [quote] = await db
        .select()
        .from(quotes)
        .where(and(eq(quotes.id, input.quoteId), eq(quotes.workspaceId, ctx.workspace.id)));
      if (!quote) throw new TRPCError({ code: "NOT_FOUND" });

      const lineItems = await db
        .select()
        .from(quoteLineItems)
        .where(eq(quoteLineItems.quoteId, quote.id));

      const totalValue = lineItems.reduce((s, li) => s + Number(li.lineTotal ?? 0), 0);
      const avgDiscount = lineItems.length > 0
        ? lineItems.reduce((s, li) => s + Number(li.discountPct ?? 0), 0) / lineItems.length
        : 0;

      // Get comparable won deals for this workspace
      const wonDeals = await db
        .select({ value: opportunities.value, winProb: opportunities.winProb })
        .from(opportunities)
        .where(and(eq(opportunities.workspaceId, ctx.workspace.id), eq(opportunities.stage, "won")))
        .orderBy(desc(opportunities.updatedAt))
        .limit(20);

      const avgWonValue = wonDeals.length > 0
        ? wonDeals.reduce((s, d) => s + Number(d.value ?? 0), 0) / wonDeals.length
        : totalValue;

      const prompt = `You are a sales pricing AI. Recommend a price range and max discount for this quote. Return JSON only.

Quote total: $${totalValue.toFixed(2)}
Average discount applied so far: ${avgDiscount.toFixed(1)}%
Line items: ${lineItems.map((li) => `${li.name} x${li.quantity} @ $${li.unitPrice}`).join("; ")}
Average won deal value in this workspace: $${avgWonValue.toFixed(2)}
Number of comparable won deals: ${wonDeals.length}

Return: { "priceMin": <number>, "priceMax": <number>, "discountCeil": <0-50 percent>, "rationale": "<one sentence>" }
priceMin/priceMax should bracket the recommended selling range. discountCeil is the max discount you'd recommend giving.`;

      let priceMin = totalValue * 0.9;
      let priceMax = totalValue * 1.1;
      let discountCeil = 15;
      let rationale = "Based on quote value and comparable deals.";

      try {
        const res = await invokeLLM({
          messages: [{ role: "user", content: prompt }],
          response_format: { type: "json_object" },
          max_tokens: 150,
        });
        const parsed = JSON.parse(res.choices?.[0]?.message?.content ?? "{}");
        priceMin = Math.max(0, Number(parsed.priceMin ?? priceMin));
        priceMax = Math.max(priceMin, Number(parsed.priceMax ?? priceMax));
        discountCeil = Math.max(0, Math.min(50, Number(parsed.discountCeil ?? discountCeil)));
        rationale = String(parsed.rationale ?? rationale).slice(0, 300);
      } catch { /* use defaults */ }

      await db
        .update(quotes)
        .set({
          aiPriceMin: String(priceMin.toFixed(2)),
          aiPriceMax: String(priceMax.toFixed(2)),
          aiDiscountCeil: String(discountCeil.toFixed(2)),
          aiPriceRationale: rationale,
          aiPriceScoredAt: new Date(),
        })
        .where(eq(quotes.id, quote.id));

      return { quoteId: quote.id, priceMin, priceMax, discountCeil, rationale };
    }),
});

// ─── Workflows — AI Suggestions ───────────────────────────────────────────────

export const workflowsAiRouter = router({
  /** Generate AI workflow suggestions based on workspace activity patterns */
  generateSuggestions: adminWsProcedure.mutation(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

    // Gather context: existing rules, recent runs, deal counts
    const existingRules = await db
      .select({ name: workflowRules.name, triggerType: workflowRules.triggerType, fireCount: workflowRules.fireCount })
      .from(workflowRules)
      .where(eq(workflowRules.workspaceId, ctx.workspace.id))
      .limit(20);

    const oppCounts = await db
      .select({ stage: opportunities.stage, count: sql<number>`COUNT(*)` })
      .from(opportunities)
      .where(eq(opportunities.workspaceId, ctx.workspace.id))
      .groupBy(opportunities.stage);

    const prompt = `You are a sales automation AI. Suggest 3 useful workflow automation rules for this sales team. Return JSON only.

Existing workflow rules: ${existingRules.map((r) => `"${r.name}" (trigger: ${r.triggerType}, fired ${r.fireCount}x)`).join("; ") || "none"}
Pipeline stage counts: ${oppCounts.map((o) => `${o.stage}: ${o.count}`).join(", ")}

Return a JSON array of exactly 3 suggestions:
[{
  "title": "<short rule name>",
  "description": "<one sentence explaining the value>",
  "triggerType": "record_created|record_updated|stage_changed|task_overdue|deal_stuck|schedule",
  "triggerConfig": {},
  "conditions": [],
  "actions": [{ "type": "notify_slack|send_email|create_task|update_field", "params": {} }]
}]

Make suggestions that are different from existing rules and address real sales pain points.`;

    let suggestions: Array<{
      title: string; description: string; triggerType: string;
      triggerConfig: object; conditions: object[]; actions: object[];
    }> = [];

    try {
      const res = await invokeLLM({
        messages: [{ role: "user", content: prompt }],
        response_format: { type: "json_object" },
        max_tokens: 800,
      });
      const content = res.choices?.[0]?.message?.content ?? "{}";
      // Handle both array and {suggestions: [...]} shapes
      const parsed = JSON.parse(content);
      const arr = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.suggestions) ? parsed.suggestions : []);
      suggestions = arr.slice(0, 3);
    } catch { /* return empty */ }

    if (suggestions.length === 0) return { created: 0 };

    // Dismiss old undismissed suggestions before inserting new ones
    await db
      .update(aiWorkflowSuggestions)
      .set({ dismissed: true })
      .where(and(eq(aiWorkflowSuggestions.workspaceId, ctx.workspace.id), eq(aiWorkflowSuggestions.dismissed, false)));

    for (const s of suggestions) {
      await db.insert(aiWorkflowSuggestions).values({
        workspaceId: ctx.workspace.id,
        title: String(s.title ?? "Untitled suggestion").slice(0, 200),
        description: String(s.description ?? "").slice(0, 500),
        triggerType: String(s.triggerType ?? "record_created").slice(0, 60),
        triggerConfig: s.triggerConfig ?? {},
        conditions: s.conditions ?? [],
        actions: s.actions ?? [],
      });
    }

    return { created: suggestions.length };
  }),

  /** List active (non-dismissed) suggestions */
  listSuggestions: workspaceProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) return [];
    return db
      .select()
      .from(aiWorkflowSuggestions)
      .where(and(eq(aiWorkflowSuggestions.workspaceId, ctx.workspace.id), eq(aiWorkflowSuggestions.dismissed, false)))
      .orderBy(desc(aiWorkflowSuggestions.generatedAt));
  }),

  /** Dismiss a suggestion */
  dismissSuggestion: workspaceProcedure
    .input(z.object({ id: z.number().int() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      await db
        .update(aiWorkflowSuggestions)
        .set({ dismissed: true })
        .where(and(eq(aiWorkflowSuggestions.id, input.id), eq(aiWorkflowSuggestions.workspaceId, ctx.workspace.id)));
      return { ok: true };
    }),

  /** Apply a suggestion — creates a workflow rule and marks suggestion as applied */
  applySuggestion: adminWsProcedure
    .input(z.object({ id: z.number().int() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      const [sug] = await db
        .select()
        .from(aiWorkflowSuggestions)
        .where(and(eq(aiWorkflowSuggestions.id, input.id), eq(aiWorkflowSuggestions.workspaceId, ctx.workspace.id)));
      if (!sug) throw new TRPCError({ code: "NOT_FOUND" });

      const validTriggers = ["record_created","record_updated","stage_changed","task_overdue","nps_submitted","signal_received","field_equals","schedule","deal_stuck"] as const;
      const triggerType = validTriggers.includes(sug.triggerType as any) ? sug.triggerType as typeof validTriggers[number] : "record_created";

      const [newRule] = await db.insert(workflowRules).values({
        workspaceId: ctx.workspace.id,
        name: sug.title,
        description: sug.description,
        triggerType,
        triggerConfig: sug.triggerConfig as object,
        conditions: sug.conditions as object,
        actions: sug.actions as object,
        enabled: true,
      }).$returningId();

      await db
        .update(aiWorkflowSuggestions)
        .set({ dismissed: true, appliedRuleId: newRule.id })
        .where(eq(aiWorkflowSuggestions.id, sug.id));

      return { ruleId: newRule.id };
    }),
});

// ─── Forecast — AI Commentary ─────────────────────────────────────────────────

export const forecastAiRouter = router({
  /** Generate AI forecast commentary for the current period */
  generateCommentary: workspaceProcedure.mutation(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

    const now = new Date();
    const periodLabel = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

    // Gather pipeline data
    const oppRows = await db
      .select({ stage: opportunities.stage, value: opportunities.value, winProb: opportunities.winProb, closeDate: opportunities.closeDate })
      .from(opportunities)
      .where(eq(opportunities.workspaceId, ctx.workspace.id));

    const totalPipeline = oppRows.reduce((s, o) => s + Number(o.value ?? 0), 0);
    const weightedForecast = oppRows.reduce((s, o) => s + Number(o.value ?? 0) * (Number(o.winProb ?? 0) / 100), 0);
    const closingThisMonth = oppRows.filter((o) => {
      if (!o.closeDate) return false;
      const d = new Date(o.closeDate);
      return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
    });
    const closingValue = closingThisMonth.reduce((s, o) => s + Number(o.value ?? 0), 0);
    const stageCounts = oppRows.reduce((acc, o) => { acc[o.stage] = (acc[o.stage] ?? 0) + 1; return acc; }, {} as Record<string, number>);
    const atRisk = oppRows.filter((o) => o.winProb !== null && Number(o.winProb) < 30 && Number(o.value ?? 0) > 0).length;

    const prompt = `You are a sales analytics AI. Write a concise forecast commentary for this month. Return JSON only.

Period: ${periodLabel}
Total pipeline value: $${totalPipeline.toLocaleString()}
Weighted forecast: $${Math.round(weightedForecast).toLocaleString()}
Deals closing this month: ${closingThisMonth.length} worth $${closingValue.toLocaleString()}
At-risk deals (win prob <30%): ${atRisk}
Stage breakdown: ${Object.entries(stageCounts).map(([s, c]) => `${s}: ${c}`).join(", ")}

Return: {
  "commentary": "<2-3 sentence narrative suitable for a sales manager — include specific numbers, key risks, and one recommended action>",
  "highlights": [
    { "label": "<metric name>", "value": "<formatted value>", "sentiment": "positive|neutral|negative" }
  ]
}
Include 3-4 highlights covering the most important metrics.`;

    let commentary = "Unable to generate commentary at this time.";
    let highlights: Array<{ label: string; value: string; sentiment: string }> = [];

    try {
      const res = await invokeLLM({
        messages: [{ role: "user", content: prompt }],
        response_format: { type: "json_object" },
        max_tokens: 400,
      });
      const parsed = JSON.parse(res.choices?.[0]?.message?.content ?? "{}");
      commentary = String(parsed.commentary ?? commentary).slice(0, 1000);
      highlights = Array.isArray(parsed.highlights) ? parsed.highlights.slice(0, 6) : [];
    } catch { /* use defaults */ }

    // Upsert: delete old for this period, insert new
    await db
      .delete(forecastAiCommentary)
      .where(and(eq(forecastAiCommentary.workspaceId, ctx.workspace.id), eq(forecastAiCommentary.periodLabel, periodLabel)));

    await db.insert(forecastAiCommentary).values({
      workspaceId: ctx.workspace.id,
      periodLabel,
      commentary,
      highlights,
    });

    return { periodLabel, commentary, highlights };
  }),

  /** Get the latest commentary for the current period */
  getCommentary: workspaceProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) return null;
    const now = new Date();
    const periodLabel = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    const [row] = await db
      .select()
      .from(forecastAiCommentary)
      .where(and(eq(forecastAiCommentary.workspaceId, ctx.workspace.id), eq(forecastAiCommentary.periodLabel, periodLabel)))
      .orderBy(desc(forecastAiCommentary.generatedAt))
      .limit(1);
    return row ?? null;
  }),
});

// ─── Mailbox — AI Triage ──────────────────────────────────────────────────────

const TRIAGE_LABELS = ["urgent", "follow_up", "fyi", "no_action"] as const;
type TriageLabel = typeof TRIAGE_LABELS[number];

export const mailboxAiRouter = router({
  /** Triage a single email thread */
  triageThread: workspaceProcedure
    .input(z.object({
      accountId: z.number().int(),
      threadId: z.string(),
      subject: z.string(),
      snippet: z.string(),
      fromEmail: z.string(),
      fromName: z.string().optional(),
      bodyPreview: z.string().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      const prompt = `You are an email triage AI for a sales rep. Classify this email thread. Return JSON only.

From: ${input.fromName ?? input.fromEmail} <${input.fromEmail}>
Subject: ${input.subject}
Preview: ${(input.bodyPreview ?? input.snippet).slice(0, 400)}

Classify as one of: urgent, follow_up, fyi, no_action
- urgent: needs immediate response (prospect reply, complaint, time-sensitive request)
- follow_up: needs a response but not urgent (question, soft interest, referral)
- fyi: informational, no action needed (newsletters, receipts, auto-replies)
- no_action: spam, marketing, or completely irrelevant

Return: { "label": "urgent|follow_up|fyi|no_action", "confidence": <50-99>, "rationale": "<one sentence>" }`;

      let label: TriageLabel = "fyi";
      let confidence = 70;
      let rationale = "Classified by heuristic.";

      try {
        const res = await invokeLLM({
          messages: [{ role: "user", content: prompt }],
          response_format: { type: "json_object" },
          max_tokens: 100,
        });
        const parsed = JSON.parse(res.choices?.[0]?.message?.content ?? "{}");
        label = TRIAGE_LABELS.includes(parsed.label) ? parsed.label : "fyi";
        confidence = Math.max(50, Math.min(99, Math.round(Number(parsed.confidence ?? 70))));
        rationale = String(parsed.rationale ?? rationale).slice(0, 200);
      } catch { /* use defaults */ }

      // Upsert triage record
      await db
        .insert(mailboxAiTriage)
        .values({ workspaceId: ctx.workspace.id, accountId: input.accountId, threadId: input.threadId, triageLabel: label, confidence, rationale })
        .onDuplicateKeyUpdate({ set: { triageLabel: label, confidence, rationale, labelledAt: new Date() } });

      return { threadId: input.threadId, label, confidence, rationale };
    }),

  /** Bulk triage multiple threads */
  bulkTriage: workspaceProcedure
    .input(z.object({
      accountId: z.number().int(),
      threads: z.array(z.object({
        threadId: z.string(),
        subject: z.string(),
        snippet: z.string(),
        fromEmail: z.string(),
        fromName: z.string().optional(),
      })).max(20),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      const threadList = input.threads.map((t, i) =>
        `${i + 1}. From: ${t.fromName ?? t.fromEmail} | Subject: ${t.subject} | Preview: ${t.snippet.slice(0, 150)}`
      ).join("\n");

      const prompt = `You are an email triage AI. Classify each email thread. Return JSON only.

${threadList}

Return a JSON array with one entry per thread (same order):
[{ "threadId": "<id>", "label": "urgent|follow_up|fyi|no_action", "confidence": <50-99> }]

Labels: urgent=needs immediate reply, follow_up=needs reply soon, fyi=informational, no_action=spam/irrelevant`;

      const results: Array<{ threadId: string; label: TriageLabel; confidence: number }> = [];

      try {
        const res = await invokeLLM({
          messages: [{ role: "user", content: prompt }],
          response_format: { type: "json_object" },
          max_tokens: 500,
        });
        const parsed = JSON.parse(res.choices?.[0]?.message?.content ?? "{}");
        const arr = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.results) ? parsed.results : []);
        for (const item of arr) {
          const label: TriageLabel = TRIAGE_LABELS.includes(item.label) ? item.label : "fyi";
          const confidence = Math.max(50, Math.min(99, Math.round(Number(item.confidence ?? 70))));
          results.push({ threadId: String(item.threadId), label, confidence });
        }
      } catch { /* return empty */ }

      // Upsert all results
      for (const r of results) {
        await db
          .insert(mailboxAiTriage)
          .values({ workspaceId: ctx.workspace.id, accountId: input.accountId, threadId: r.threadId, triageLabel: r.label, confidence: r.confidence })
          .onDuplicateKeyUpdate({ set: { triageLabel: r.label, confidence: r.confidence, labelledAt: new Date() } });
      }

      return { triaged: results.length, results };
    }),

  /** Get stored triage labels for an account */
  getTriageLabels: workspaceProcedure
    .input(z.object({ accountId: z.number().int(), threadIds: z.array(z.string()).max(100).optional() }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) return [];
      const where = input.threadIds?.length
        ? and(
            eq(mailboxAiTriage.workspaceId, ctx.workspace.id),
            eq(mailboxAiTriage.accountId, input.accountId),
            inArray(mailboxAiTriage.threadId, input.threadIds),
          )
        : and(eq(mailboxAiTriage.workspaceId, ctx.workspace.id), eq(mailboxAiTriage.accountId, input.accountId));
      return db.select().from(mailboxAiTriage).where(where).limit(200);
    }),
});

// ─── Email Auto-Send Settings ─────────────────────────────────────────────────

export const emailAutoSendRouter = router({
  /** Get auto-send settings */
  getAutoSendSettings: workspaceProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) return null;
    const [settings] = await db
      .select({
        aiAutoSendEnabled: workspaceSettings.aiAutoSendEnabled,
        aiAutoSendScoreMin: workspaceSettings.aiAutoSendScoreMin,
        aiAutoSendConfidenceMin: workspaceSettings.aiAutoSendConfidenceMin,
      })
      .from(workspaceSettings)
      .where(eq(workspaceSettings.workspaceId, ctx.workspace.id));
    return settings ?? { aiAutoSendEnabled: false, aiAutoSendScoreMin: 70, aiAutoSendConfidenceMin: 75 };
  }),

  /** Update auto-send settings */
  updateAutoSendSettings: adminWsProcedure
    .input(z.object({
      aiAutoSendEnabled: z.boolean(),
      aiAutoSendScoreMin: z.number().int().min(0).max(100),
      aiAutoSendConfidenceMin: z.number().int().min(0).max(100),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      await db
        .insert(workspaceSettings)
        .values({ workspaceId: ctx.workspace.id, ...input } as any)
        .onDuplicateKeyUpdate({ set: input });
      return { ok: true };
    }),
});
