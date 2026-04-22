import { TRPCError } from "@trpc/server";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { z } from "zod";
import {
  activities,
  emailDrafts,
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

  // Pull email draft activity (proxy for sends/opens/clicks/replies in this build).
  const drafts = await db.select().from(emailDrafts).where(and(eq(emailDrafts.workspaceId, workspaceId), eq(emailDrafts.toLeadId, leadId)));
  const sentDrafts = drafts.filter((d) => d.status === "sent");
  const opens = sentDrafts.length; // 1 open per sent in stub model
  const clicks = Math.floor(sentDrafts.length / 3);
  const replies = sentDrafts.filter((d) => (d.aiPrompt ?? "").toLowerCase().includes("reply")).length;

  // Activity-row signals (calls/meetings count as engagement, replies as a stronger signal).
  const acts = await db
    .select()
    .from(activities)
    .where(and(eq(activities.workspaceId, workspaceId), eq(activities.relatedType, "lead"), eq(activities.relatedId, leadId)))
    .orderBy(desc(activities.occurredAt));
  const replyActs = acts.filter((a) => a.type === "email" && (a.subject ?? "").toLowerCase().includes("re:")).length;
  const lastTs = acts[0]?.occurredAt ?? sentDrafts[sentDrafts.length - 1]?.sentAt ?? null;
  const daysSinceLastEngagement = lastTs ? Math.max(0, Math.floor((Date.now() - new Date(lastTs).getTime()) / 86400000)) : 999;

  // Sequence step completion (proxy: enrollments.currentStep)
  const enr = await db.select().from(enrollments).where(and(eq(enrollments.workspaceId, workspaceId), eq(enrollments.leadId, leadId)));
  const completedSteps = enr.reduce((s, e) => s + (e.currentStep ?? 0), 0);

  return {
    opens,
    clicks,
    replies: replies + replyActs,
    completedSteps,
    bounces: 0,
    unsubscribes: 0,
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
