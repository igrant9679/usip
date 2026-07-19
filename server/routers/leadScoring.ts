import { TRPCError } from "@trpc/server";
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import {
  accounts,
  activities,
  emailDrafts,
  emailReplies,
  emailSuppressions,
  enrollments,
  leadRoutingRules,
  leadScoreConfig,
  leadScoreHistory,
  leads,
  notifications,
} from "../../drizzle/schema";
import { recordAudit } from "../audit";
import { getDb } from "../db";
import {
  type AiFitOutput,
  composeScore,
  DEFAULT_SCORE_CONFIG,
  pickRoutingMatch,
  type RoutingPayload,
  type RoutingRule,
  type ScoreConfig,
  scoreAiFit,
  scoreBehavioral,
  scoreFirmographic,
  tierFor,
} from "../leadScoring";
import { invokeLLM } from "../_core/llm";
import { router } from "../_core/trpc";
import { adminWsProcedure, repProcedure, workspaceProcedure } from "../_core/workspace";
import { evalConditions } from "./operations";

/* ───────── helpers ───────── */

async function loadConfig(workspaceId: number): Promise<ScoreConfig> {
  const db = await getDb();
  if (!db) return DEFAULT_SCORE_CONFIG;
  const [row] = await db.select().from(leadScoreConfig).where(eq(leadScoreConfig.workspaceId, workspaceId));
  if (!row) return DEFAULT_SCORE_CONFIG;
  return {
    firmoOrgTypeWeight: row.firmoOrgTypeWeight,
    firmoTitleWeight: row.firmoTitleWeight,
    firmoCompletenessWeight: row.firmoCompletenessWeight,
    behavOpenPoints: row.behavOpenPoints,
    behavOpenMax: row.behavOpenMax,
    behavClickPoints: row.behavClickPoints,
    behavClickMax: row.behavClickMax,
    behavReplyPoints: row.behavReplyPoints,
    behavStepPoints: row.behavStepPoints,
    behavBouncePenalty: row.behavBouncePenalty,
    behavUnsubPenalty: row.behavUnsubPenalty,
    behavDecayPctPer30d: row.behavDecayPctPer30d,
    aiFitMax: row.aiFitMax,
    tierWarmMin: row.tierWarmMin,
    tierHotMin: row.tierHotMin,
    tierSalesReadyMin: row.tierSalesReadyMin,
  };
}

async function aggregateBehavior(workspaceId: number, leadId: number) {
  const db = await getDb();
  if (!db) return { opens: 0, clicks: 0, replies: 0, completedSteps: 0, bounces: 0, unsubscribes: 0, daysSinceLastEngagement: 999 };

  // Real engagement, not a stub model.
  //
  // This used to FABRICATE every behavioural input:
  //   opens   = sentDrafts.length          (every send counted as an open)
  //   clicks  = sentDrafts.length / 3      (invented outright)
  //   replies = drafts whose aiPrompt TEXT contained the word "reply"
  //
  // So a prospect who ignored everything scored identically to one who read
  // and clicked every message — and the tracking pixel's real counters
  // (emailDrafts.openCount / clickCount, maintained by server/emailTracking.ts)
  // were never consulted despite existing all along. That matters more now
  // that a lead's score can auto-enrol them in a sequence: fabricated
  // engagement would have started real outreach.
  const drafts = await db.select().from(emailDrafts).where(and(eq(emailDrafts.workspaceId, workspaceId), eq(emailDrafts.toLeadId, leadId)));
  const sentDrafts = drafts.filter((d) => d.status === "sent");
  const opens = sentDrafts.reduce((n, d) => n + (d.openCount ?? 0), 0);
  const clicks = sentDrafts.reduce((n, d) => n + (d.clickCount ?? 0), 0);
  const bounces = drafts.filter((d) => d.bouncedAt != null).length;

  // Replies come from the emailReplies table the inbound poller writes, not
  // from pattern-matching the outbound draft's own prompt text.
  const replyRows = await db
    .select({ receivedAt: emailReplies.receivedAt })
    .from(emailReplies)
    .where(and(eq(emailReplies.workspaceId, workspaceId), eq(emailReplies.leadId, leadId)));
  const replies = replyRows.length;

  // Activity-row signals (calls/meetings count as engagement, replies as a stronger signal).
  const acts = await db
    .select()
    .from(activities)
    .where(and(eq(activities.workspaceId, workspaceId), eq(activities.relatedType, "lead"), eq(activities.relatedId, leadId)))
    .orderBy(desc(activities.occurredAt));
  const replyActs = acts.filter((a) => a.type === "email" && (a.subject ?? "").toLowerCase().includes("re:")).length;
  // Recency now considers the prospect's OWN actions (opening, clicking,
  // replying), not just rep-logged activity and send timestamps — previously
  // someone could be actively reading every email and still look stale.
  const engagementTimes = [
    acts[0]?.occurredAt ?? null,
    sentDrafts[sentDrafts.length - 1]?.sentAt ?? null,
    ...sentDrafts.map((d) => d.lastOpenedAt ?? null),
    ...sentDrafts.map((d) => d.lastClickedAt ?? null),
    ...replyRows.map((r) => r.receivedAt ?? null),
  ]
    .filter((t): t is Date => !!t)
    .map((t) => new Date(t).getTime());
  const lastTs = engagementTimes.length > 0 ? Math.max(...engagementTimes) : null;
  const daysSinceLastEngagement = lastTs ? Math.max(0, Math.floor((Date.now() - lastTs) / 86400000)) : 999;

  // Unsubscribes were hardcoded to 0, so opting out never dented a lead's
  // score — they could keep climbing toward "sales ready" (and now toward
  // auto-enrolment) after asking not to be contacted. email_suppressions is
  // the real record.
  let unsubscribes = 0;
  const [leadRow] = await db
    .select({ email: leads.email })
    .from(leads)
    .where(and(eq(leads.workspaceId, workspaceId), eq(leads.id, leadId)))
    .limit(1);
  if (leadRow?.email) {
    const sup = await db
      .select({ id: emailSuppressions.id })
      .from(emailSuppressions)
      .where(and(
        eq(emailSuppressions.workspaceId, workspaceId),
        eq(emailSuppressions.email, leadRow.email),
        inArray(emailSuppressions.reason, ["unsubscribe", "spam_complaint"]),
      ))
      .limit(1);
    unsubscribes = sup.length;
  }

  // Sequence step completion (proxy: enrollments.currentStep)
  const enr = await db.select().from(enrollments).where(and(eq(enrollments.workspaceId, workspaceId), eq(enrollments.leadId, leadId)));
  const completedSteps = enr.reduce((s, e) => s + (e.currentStep ?? 0), 0);

  return {
    opens,
    clicks,
    // replyActs catches replies logged as activities (e.g. a rep noting one
    // manually) that never came through the inbound poller.
    replies: replies + replyActs,
    completedSteps,
    bounces,
    unsubscribes,
    daysSinceLastEngagement,
  };
}

async function fetchAiFit(lead: typeof leads.$inferSelect): Promise<AiFitOutput | null> {
  try {
    const out = await invokeLLM({
      messages: [
        { role: "system", content: "You assess B2B lead/product fit. Output JSON only." },
        {
          role: "user",
          content: `Assess fit on a 0..1 scale.\n\nLead: ${lead.firstName} ${lead.lastName}\nTitle: ${lead.title ?? ""}\nCompany: ${lead.company ?? ""}\nSource: ${lead.source ?? ""}`,
        },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "lead_fit",
          strict: true,
          schema: {
            type: "object",
            properties: {
              fit_score: { type: "number" },
              pain_points: { type: "array", items: { type: "string" } },
              recommended_products: { type: "array", items: { type: "string" } },
              objection_risks: { type: "array", items: { type: "string" } },
            },
            required: ["fit_score", "pain_points", "recommended_products", "objection_risks"],
            additionalProperties: false,
          },
        },
      },
    });
    const content = out.choices?.[0]?.message?.content;
    const parsed = typeof content === "string" ? JSON.parse(content) : content;
    return parsed as AiFitOutput;
  } catch (e) {
    console.warn("[leadScoring] AI fit failed", e);
    // Heuristic fallback so behavior is deterministic without LLM.
    const t = (lead.title ?? "").toLowerCase();
    const fit = /chief|cxo|cmo|cro|cfo|ceo|founder/.test(t) ? 0.85
      : /vp|vice president|head of/.test(t) ? 0.7
      : /director/.test(t) ? 0.55
      : /manager/.test(t) ? 0.4 : 0.25;
    return { fit_score: fit, pain_points: [], recommended_products: [], objection_risks: [] };
  }
}

async function recomputeOne(workspaceId: number, leadId: number) {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
  const [lead] = await db.select().from(leads).where(and(eq(leads.id, leadId), eq(leads.workspaceId, workspaceId)));
  if (!lead) throw new TRPCError({ code: "NOT_FOUND" });
  const cfg = await loadConfig(workspaceId);

  const firmo = scoreFirmographic(lead, cfg);
  const behaviorInput = await aggregateBehavior(workspaceId, leadId);
  const behav = scoreBehavioral(behaviorInput, cfg);
  const aiFitJson = await fetchAiFit(lead);
  const ai = scoreAiFit(aiFitJson, cfg);
  const breakdown = composeScore({ firmo, behav, aiFit: ai, cfg });

  const grade: "A" | "B" | "C" | "D" =
    breakdown.tier === "sales_ready" ? "A" : breakdown.tier === "hot" ? "B" : breakdown.tier === "warm" ? "C" : "D";

  const previousTotal = lead.score ?? 0;
  await db.update(leads).set({ score: breakdown.total, grade, scoreReasons: breakdown.reasons }).where(eq(leads.id, leadId));
  await db.insert(leadScoreHistory).values({
    workspaceId,
    leadId,
    firmographic: breakdown.firmographic,
    behavioral: breakdown.behavioral,
    aiFit: breakdown.aiFit,
    total: breakdown.total,
    tier: breakdown.tier,
    aiFitPayload: aiFitJson as any,
  });

  // Threshold-cross notification → assigned owner only (when admin-enabled).
  const [cfgRow] = await db.select().from(leadScoreConfig).where(eq(leadScoreConfig.workspaceId, workspaceId));
  const notifyEnabled = cfgRow?.notifyOnSalesReady ?? true;
  if (notifyEnabled && lead.ownerUserId && previousTotal < cfg.tierSalesReadyMin && breakdown.total >= cfg.tierSalesReadyMin) {
    await db.insert(notifications).values({
      workspaceId,
      userId: lead.ownerUserId,
      kind: "system",
      title: `Lead is Sales Ready: ${lead.firstName} ${lead.lastName}`,
      body: `Score crossed ${cfg.tierSalesReadyMin} (${previousTotal} → ${breakdown.total}). ${lead.company ?? ""}`,
      relatedType: "lead",
      relatedId: leadId,
    });
  }

  // Auto-enrol into any active sequence whose enrollmentTrigger is a
  // score_threshold this lead has now crossed.
  //
  // sequenceEngine.autoEnrollByTriggers was fully implemented AND unit-tested,
  // but its only caller in the entire repo was its own test file — so scores
  // were computed, stored, displayed and sorted on, and never actually started
  // any outreach. This is the score → sequence handoff that was missing.
  //
  // Fire-and-forget: scoring must not fail because enrolment did. The function
  // is idempotent (it checks for an existing enrolment first), so re-scoring
  // the same lead never double-enrols.
  void import("../sequenceEngine")
    .then((m) => m.autoEnrollByTriggers({
      kind: "score_threshold",
      workspaceId,
      leadId,
      score: breakdown.total,
    }))
    .catch((e) => console.error(`[LeadScoring] auto-enroll failed for lead ${leadId}:`, e));

  return { ...breakdown, grade, aiFit: aiFitJson };
}

/* ───────── tRPC router ───────── */

export const leadScoringRouter = router({
  /** Get current config (creates default row lazily). */
  getConfig: workspaceProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) return DEFAULT_SCORE_CONFIG;
    let [row] = await db.select().from(leadScoreConfig).where(eq(leadScoreConfig.workspaceId, ctx.workspace.id));
    if (!row) {
      await db.insert(leadScoreConfig).values({ workspaceId: ctx.workspace.id });
      [row] = await db.select().from(leadScoreConfig).where(eq(leadScoreConfig.workspaceId, ctx.workspace.id));
    }
    return row ?? DEFAULT_SCORE_CONFIG;
  }),

  saveConfig: adminWsProcedure
    .input(z.object({
      firmoOrgTypeWeight: z.number().int().min(0).max(40),
      firmoTitleWeight: z.number().int().min(0).max(40),
      firmoCompletenessWeight: z.number().int().min(0).max(40),
      behavOpenPoints: z.number().int().min(0).max(50),
      behavOpenMax: z.number().int().min(0).max(50),
      behavClickPoints: z.number().int().min(0).max(50),
      behavClickMax: z.number().int().min(0).max(50),
      behavReplyPoints: z.number().int().min(0).max(50),
      behavStepPoints: z.number().int().min(0).max(20),
      behavBouncePenalty: z.number().int().min(-50).max(0),
      behavUnsubPenalty: z.number().int().min(-50).max(0),
      behavDecayPctPer30d: z.number().int().min(0).max(100),
      aiFitMax: z.number().int().min(0).max(50),
      tierWarmMin: z.number().int().min(0).max(100),
      tierHotMin: z.number().int().min(0).max(100),
      tierSalesReadyMin: z.number().int().min(0).max(100),
      notifyOnSalesReady: z.boolean(),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const [exists] = await db.select().from(leadScoreConfig).where(eq(leadScoreConfig.workspaceId, ctx.workspace.id));
      if (exists) {
        await db.update(leadScoreConfig).set(input).where(eq(leadScoreConfig.workspaceId, ctx.workspace.id));
      } else {
        await db.insert(leadScoreConfig).values({ ...input, workspaceId: ctx.workspace.id });
      }
      await recordAudit({ workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "update", entityType: "lead_score_config", after: input });
      return { ok: true };
    }),

  /** Recompute one lead, return the breakdown. */
  recompute: repProcedure.input(z.object({ leadId: z.number() })).mutation(async ({ ctx, input }) => {
    return recomputeOne(ctx.workspace.id, input.leadId);
  }),

  /** Recompute all leads in this workspace. Synchronous but bounded by row count. */
  recomputeAll: adminWsProcedure.mutation(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const rows = await db.select({ id: leads.id }).from(leads).where(eq(leads.workspaceId, ctx.workspace.id));
    let ok = 0;
    let fail = 0;
    for (const r of rows) {
      try { await recomputeOne(ctx.workspace.id, r.id); ok++; } catch { fail++; }
    }
    await recordAudit({ workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "update", entityType: "lead_score_config", after: { recomputed: ok, failed: fail } });
    return { recomputed: ok, failed: fail };
  }),

  /** Read-only breakdown for the lead detail panel: current components + 90-day history. */
  breakdown: workspaceProcedure.input(z.object({ leadId: z.number() })).query(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const [lead] = await db.select().from(leads).where(and(eq(leads.id, input.leadId), eq(leads.workspaceId, ctx.workspace.id)));
    if (!lead) throw new TRPCError({ code: "NOT_FOUND" });
    const cfg = await loadConfig(ctx.workspace.id);

    const firmo = scoreFirmographic(lead, cfg);
    const behaviorInput = await aggregateBehavior(ctx.workspace.id, input.leadId);
    const behav = scoreBehavioral(behaviorInput, cfg);

    // 90-day history
    const cutoff = new Date(Date.now() - 90 * 86400000);
    const history = await db
      .select()
      .from(leadScoreHistory)
      .where(and(eq(leadScoreHistory.workspaceId, ctx.workspace.id), eq(leadScoreHistory.leadId, input.leadId), gte(leadScoreHistory.computedAt, cutoff)))
      .orderBy(leadScoreHistory.computedAt);

    return {
      cfg,
      tier: tierFor(lead.score ?? 0, cfg),
      total: lead.score ?? 0,
      grade: lead.grade,
      reasons: (lead.scoreReasons as string[] | null) ?? [],
      firmographic: { value: firmo.value, max: cfg.firmoOrgTypeWeight + cfg.firmoTitleWeight + cfg.firmoCompletenessWeight, reasons: firmo.reasons },
      behavioral: { value: behav.value, max: 30, reasons: behav.reasons, raw: behaviorInput },
      aiFit: { value: lead.score ? Math.max(0, (lead.score ?? 0) - firmo.value - Math.max(0, behav.value)) : 0, max: cfg.aiFitMax },
      history: history.map((h) => ({ at: h.computedAt, total: h.total, firmographic: h.firmographic, behavioral: h.behavioral, aiFit: h.aiFit, tier: h.tier })),
    };
  }),
});

/* ───────── Routing ───────── */

export const leadRoutingRouter = router({
  list: workspaceProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) return [];
    return db.select().from(leadRoutingRules).where(eq(leadRoutingRules.workspaceId, ctx.workspace.id)).orderBy(leadRoutingRules.priority);
  }),

  save: adminWsProcedure
    .input(z.object({
      id: z.number().optional(),
      name: z.string().min(1),
      priority: z.number().int().min(1).max(1000),
      enabled: z.boolean(),
      conditions: z.any(),
      strategy: z.enum(["round_robin", "geography", "industry", "direct"]),
      targetUserIds: z.array(z.number()).default([]),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      if (input.id) {
        await db.update(leadRoutingRules).set({
          name: input.name, priority: input.priority, enabled: input.enabled,
          conditions: input.conditions, strategy: input.strategy, targetUserIds: input.targetUserIds,
        }).where(and(eq(leadRoutingRules.id, input.id), eq(leadRoutingRules.workspaceId, ctx.workspace.id)));
        return { id: input.id };
      }
      const r = await db.insert(leadRoutingRules).values({
        workspaceId: ctx.workspace.id,
        name: input.name, priority: input.priority, enabled: input.enabled,
        conditions: input.conditions, strategy: input.strategy, targetUserIds: input.targetUserIds, rrCursor: 0,
      });
      return { id: Number((r as any)[0]?.insertId ?? 0) };
    }),

  remove: adminWsProcedure.input(z.object({ id: z.number() })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    await db.delete(leadRoutingRules).where(and(eq(leadRoutingRules.id, input.id), eq(leadRoutingRules.workspaceId, ctx.workspace.id)));
    return { ok: true };
  }),

  reorder: adminWsProcedure.input(z.object({ orderedIds: z.array(z.number()) })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    await Promise.all(input.orderedIds.map((id, idx) =>
      db.update(leadRoutingRules).set({ priority: (idx + 1) * 10 }).where(and(eq(leadRoutingRules.id, id), eq(leadRoutingRules.workspaceId, ctx.workspace.id)))
    ));
    return { ok: true };
  }),

  /** Manually run all routing rules against a specific lead (debugging tool). */
  applyToLead: repProcedure.input(z.object({ leadId: z.number() })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const [lead] = await db.select().from(leads).where(and(eq(leads.id, input.leadId), eq(leads.workspaceId, ctx.workspace.id)));
    if (!lead) throw new TRPCError({ code: "NOT_FOUND" });
    const owner = await routeLeadOwner(ctx.workspace.id, {
      title: lead.title, company: lead.company, source: lead.source, score: lead.score ?? 0,
      industry: null, country: null, state: null, city: null,
    });
    if (owner != null) {
      await db.update(leads).set({ ownerUserId: owner }).where(eq(leads.id, lead.id));
      await recordAudit({ workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "update", entityType: "lead", entityId: lead.id, after: { ownerUserId: owner, routed: true } });
    }
    return { ownerUserId: owner };
  }),
});

/**
 * Public helper: choose an owner for a new/imported lead. Side-effect: advances
 * the round-robin cursor on the matched rule.
 */
export async function routeLeadOwner(workspaceId: number, payload: RoutingPayload): Promise<number | null> {
  const db = await getDb();
  if (!db) return null;

  // The routing-rule builder offers industry / country / state conditions, but
  // ALL THREE call sites passed null for them (leads have no such columns), so
  // any rule using those conditions could never match — it silently never
  // fired, with nothing to tell the admin who built it.
  //
  // Leads don't carry that data, but the matching Account does: accounts have
  // `industry` and `region` (which is where CSV import now puts state +
  // country). Enrich here rather than at each call site so all three paths
  // — CRM lead create, webform submit, landing-page submit — benefit alike.
  if (payload.company && (!payload.industry || (!payload.country && !payload.state))) {
    try {
      const [acct] = await db
        .select({ industry: accounts.industry, region: accounts.region })
        .from(accounts)
        .where(and(eq(accounts.workspaceId, workspaceId), eq(accounts.name, payload.company)))
        .limit(1);
      if (acct) {
        payload = {
          ...payload,
          industry: payload.industry ?? acct.industry ?? null,
          // region is a free-text "State, Country" string; expose it to BOTH
          // condition fields so either spelling of a rule can match it.
          country: payload.country ?? acct.region ?? null,
          state: payload.state ?? acct.region ?? null,
        };
      }
    } catch (e) {
      // Enrichment is a bonus — never fail routing because of it.
      console.error("[leadRouting] account enrichment failed:", (e as Error)?.cause ?? e);
    }
  }

  const rows = await db.select().from(leadRoutingRules).where(eq(leadRoutingRules.workspaceId, workspaceId));
  const rules: RoutingRule[] = rows.map((r) => ({
    id: r.id,
    enabled: r.enabled,
    priority: r.priority,
    conditions: (r.conditions as any) ?? {},
    strategy: r.strategy,
    targetUserIds: (r.targetUserIds as number[] | null) ?? [],
    rrCursor: r.rrCursor,
  }));
  const m = pickRoutingMatch(rules, payload, evalConditions);
  if (!m) return null;
  if (m.newCursor !== undefined) {
    await db.update(leadRoutingRules).set({ rrCursor: m.newCursor, matchCount: sql`${leadRoutingRules.matchCount} + 1`, lastMatchedAt: new Date() }).where(eq(leadRoutingRules.id, m.ruleId));
  } else {
    await db.update(leadRoutingRules).set({ matchCount: sql`${leadRoutingRules.matchCount} + 1`, lastMatchedAt: new Date() }).where(eq(leadRoutingRules.id, m.ruleId));
  }
  return m.ownerUserId;
}
