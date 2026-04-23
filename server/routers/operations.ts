import { TRPCError } from "@trpc/server";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import {
  accounts,
  activities,
  audienceSegments,
  auditLog,
  campaignComponents,
  campaignStepStats,
  campaigns,
  contacts,
  emailDrafts,
  sendingAccounts,
  senderPools,
  sequences,
  dashboardWidgets,
  dashboards,
  notifications,
  opportunities,
  quoteLineItems,
  quotes,
  reportSchedules,
  scimEvents,
  scimProviders,
  socialAccounts,
  socialPosts,
  users,
  workflowRules,
  workflowRuns,
  workspaceMembers,
} from "../../drizzle/schema";
import { recordAudit } from "../audit";
import { getDb } from "../db";
import { invokeLLM } from "../_core/llm";
import { router } from "../_core/trpc";
import { adminWsProcedure, repProcedure, workspaceProcedure } from "../_core/workspace";
import { storagePut } from "../storage";

/* ----- Pure helpers (exported for tests) ----- */

export function computeQuoteTotals(
  lineItems: Array<{ quantity: number; unitPrice: number; discountPct: number }>,
) {
  const subtotal = lineItems.reduce((s, li) => s + li.quantity * li.unitPrice, 0);
  const discount = lineItems.reduce(
    (s, li) => s + li.quantity * li.unitPrice * (li.discountPct / 100),
    0,
  );
  const total = subtotal - discount;
  return { subtotal, discount, total };
}

export function evalConditions(
  spec: { all?: Array<{ field: string; op: string; value: any }>; any?: Array<{ field: string; op: string; value: any }> },
  payload: Record<string, any>,
): boolean {
  const cmp = (op: string, a: any, b: any) => {
    switch (op) {
      case "eq": return a === b;
      case "neq": return a !== b;
      case "gt": return Number(a) > Number(b);
      case "gte": return Number(a) >= Number(b);
      case "lt": return Number(a) < Number(b);
      case "lte": return Number(a) <= Number(b);
      case "contains": return String(a ?? "").toLowerCase().includes(String(b).toLowerCase());
      default: return false;
    }
  };
  if (spec.all && !spec.all.every((c) => cmp(c.op, payload[c.field], c.value))) return false;
  if (spec.any && !spec.any.some((c) => cmp(c.op, payload[c.field], c.value))) return false;
  return true;
}

export function canLaunchCampaign(checklist: Array<{ done: boolean; label: string }>): boolean {
  return checklist.every((x) => x.done);
}

/* ----- Workflow Automation ----- */

export const workflowsRouter = router({
  list: workspaceProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) return [];
    return db.select().from(workflowRules).where(eq(workflowRules.workspaceId, ctx.workspace.id)).orderBy(desc(workflowRules.updatedAt));
  }),

  get: workspaceProcedure.input(z.object({ id: z.number() })).query(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const [r] = await db.select().from(workflowRules).where(and(eq(workflowRules.id, input.id), eq(workflowRules.workspaceId, ctx.workspace.id)));
    return r ?? null;
  }),

  create: workspaceProcedure
    .input(z.object({
      name: z.string().min(1),
      description: z.string().optional(),
      enabled: z.boolean().default(true),
      triggerType: z.enum(["record_created", "record_updated", "stage_changed", "task_overdue", "nps_submitted", "signal_received", "field_equals", "schedule"]),
      triggerConfig: z.record(z.string(), z.any()),
      conditions: z.array(z.object({ field: z.string(), op: z.string(), value: z.any() })).default([]),
      actions: z.array(z.object({ type: z.string(), params: z.record(z.string(), z.any()) })).default([]),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const r = await db.insert(workflowRules).values({ ...input, workspaceId: ctx.workspace.id });
      return { id: Number((r as any)[0]?.insertId ?? 0) };
    }),

  update: workspaceProcedure.input(z.object({ id: z.number(), patch: z.record(z.string(), z.any()) })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    await db.update(workflowRules).set(input.patch).where(and(eq(workflowRules.id, input.id), eq(workflowRules.workspaceId, ctx.workspace.id)));
    return { ok: true };
  }),

  toggle: workspaceProcedure.input(z.object({ id: z.number(), enabled: z.boolean() })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    await db.update(workflowRules).set({ enabled: input.enabled }).where(and(eq(workflowRules.id, input.id), eq(workflowRules.workspaceId, ctx.workspace.id)));
    return { ok: true };
  }),

  delete: workspaceProcedure.input(z.object({ id: z.number() })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    await db.delete(workflowRules).where(and(eq(workflowRules.id, input.id), eq(workflowRules.workspaceId, ctx.workspace.id)));
    return { ok: true };
  }),

  /** Run history for a rule (last 50). */
  runs: workspaceProcedure.input(z.object({ ruleId: z.number().optional() }).optional()).query(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) return [];
    let rows = await db.select().from(workflowRuns).where(eq(workflowRuns.workspaceId, ctx.workspace.id)).orderBy(desc(workflowRuns.runAt)).limit(100);
    if (input?.ruleId) rows = rows.filter((r) => r.ruleId === input.ruleId);
    return rows;
  }),

  /** Manually fire a rule for demo / testing. */
  testFire: workspaceProcedure.input(z.object({ id: z.number() })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const [rule] = await db.select().from(workflowRules).where(and(eq(workflowRules.id, input.id), eq(workflowRules.workspaceId, ctx.workspace.id)));
    if (!rule) throw new TRPCError({ code: "NOT_FOUND" });
    await db.insert(workflowRuns).values({
      workspaceId: ctx.workspace.id, ruleId: rule.id, triggeredBy: "manual_test",
      status: "success", actionsRun: rule.actions,
    });
    await db.update(workflowRules).set({ fireCount: rule.fireCount + 1, lastFiredAt: new Date() }).where(eq(workflowRules.id, rule.id));
    await db.insert(notifications).values({
      workspaceId: ctx.workspace.id, userId: ctx.user.id, kind: "workflow_fired",
      title: `Rule fired: ${rule.name}`, body: "Manual test run completed.",
    });
    return { ok: true };
  }),
});

/* ───── Social Publishing ───────────────────────────────────────────── */

export const socialRouter = router({
  listAccounts: workspaceProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) return [];
    return db.select().from(socialAccounts).where(eq(socialAccounts.workspaceId, ctx.workspace.id));
  }),

  /** Stub OAuth — flips connected=true and writes a fake token marker. */
  connectAccount: workspaceProcedure
    .input(z.object({ platform: z.enum(["linkedin", "twitter", "facebook", "instagram"]), handle: z.string().min(1), displayName: z.string().optional() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      await db.insert(socialAccounts).values({
        workspaceId: ctx.workspace.id, platform: input.platform, handle: input.handle, displayName: input.displayName ?? input.handle,
        connected: true, accessTokenStub: "stub_" + Math.random().toString(36).slice(2, 10), connectedAt: new Date(),
      });
      return { ok: true };
    }),

  disconnectAccount: workspaceProcedure.input(z.object({ id: z.number() })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    await db.update(socialAccounts).set({ connected: false, accessTokenStub: null, connectedAt: null }).where(and(eq(socialAccounts.id, input.id), eq(socialAccounts.workspaceId, ctx.workspace.id)));
    return { ok: true };
  }),

  listPosts: workspaceProcedure.input(z.object({ status: z.string().optional() }).optional()).query(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) return [];
    let rows = await db.select().from(socialPosts).where(eq(socialPosts.workspaceId, ctx.workspace.id)).orderBy(desc(socialPosts.scheduledFor));
    if (input?.status) rows = rows.filter((r) => r.status === input.status);
    return rows;
  }),

  createPost: repProcedure.input(z.object({
    socialAccountId: z.number(),
    platform: z.enum(["linkedin", "twitter", "facebook", "instagram"]),
    body: z.string().min(1),
    firstComment: z.string().optional(),
    scheduledFor: z.string().optional(),
    status: z.enum(["draft", "in_review", "scheduled"]).default("draft"),
    campaignId: z.number().optional(),
  })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const r = await db.insert(socialPosts).values({
      ...input,
      workspaceId: ctx.workspace.id,
      scheduledFor: input.scheduledFor ? new Date(input.scheduledFor) : null,
      authorUserId: ctx.user.id,
    });
    return { id: Number((r as any)[0]?.insertId ?? 0) };
  }),

  updatePost: repProcedure.input(z.object({ id: z.number(), patch: z.record(z.string(), z.any()) })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const patch: any = { ...input.patch };
    if (patch.scheduledFor && typeof patch.scheduledFor === "string") patch.scheduledFor = new Date(patch.scheduledFor);
    await db.update(socialPosts).set(patch).where(and(eq(socialPosts.id, input.id), eq(socialPosts.workspaceId, ctx.workspace.id)));
    return { ok: true };
  }),

  approvePost: repProcedure.input(z.object({ id: z.number() })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    await db.update(socialPosts).set({ status: "approved", approverUserId: ctx.user.id }).where(and(eq(socialPosts.id, input.id), eq(socialPosts.workspaceId, ctx.workspace.id)));
    return { ok: true };
  }),

  schedulePost: repProcedure.input(z.object({ id: z.number(), scheduledFor: z.string() })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    await db.update(socialPosts).set({ status: "scheduled", scheduledFor: new Date(input.scheduledFor) }).where(and(eq(socialPosts.id, input.id), eq(socialPosts.workspaceId, ctx.workspace.id)));
    return { ok: true };
  }),

  /** "Publish now" — stub that marks as published with random metrics. */
  publishNowStub: repProcedure.input(z.object({ id: z.number() })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const impressions = Math.floor(800 + Math.random() * 17000);
    const engagements = Math.floor(impressions * (0.02 + Math.random() * 0.05));
    const clicks = Math.floor(engagements * 0.4);
    await db.update(socialPosts).set({ status: "published", publishedAt: new Date(), impressions, engagements, clicks }).where(and(eq(socialPosts.id, input.id), eq(socialPosts.workspaceId, ctx.workspace.id)));
    return { ok: true, impressions, engagements, clicks };
  }),

  deletePost: repProcedure.input(z.object({ id: z.number() })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    await db.delete(socialPosts).where(and(eq(socialPosts.id, input.id), eq(socialPosts.workspaceId, ctx.workspace.id)));
    return { ok: true };
  }),

  /** AI generate variants of a post body. */
  generateVariants: repProcedure.input(z.object({ topic: z.string().min(4), platform: z.enum(["linkedin", "twitter", "facebook", "instagram"]), count: z.number().int().min(1).max(5).default(3) })).mutation(async ({ ctx, input }) => {
    let variants: string[] = [];
    try {
      const charLimit = input.platform === "twitter" ? 240 : input.platform === "linkedin" ? 800 : 500;
      const out = await invokeLLM({
        messages: [
          { role: "system", content: `You write ${input.platform} posts for a B2B SaaS audience. Output JSON only. Each variant under ${charLimit} characters.` },
          { role: "user", content: `Topic: ${input.topic}\n\nReturn JSON {variants: string[]} with ${input.count} variants.` },
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "post_variants",
            strict: true,
            schema: { type: "object", properties: { variants: { type: "array", items: { type: "string" } } }, required: ["variants"], additionalProperties: false },
          },
        },
      });
      const content = out.choices?.[0]?.message?.content;
      const parsed = typeof content === "string" ? JSON.parse(content) : content;
      variants = Array.isArray(parsed.variants) ? parsed.variants.slice(0, input.count) : [];
    } catch (e) {
      console.warn("[generateVariants] LLM failed", e);
      variants = Array.from({ length: input.count }, (_, i) => `${input.topic} — angle ${i + 1}: a sharper take goes here.`);
    }
    return { variants };
  }),

  /** Aggregate analytics. */
  analytics: workspaceProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) return null;
    const rows = await db.select().from(socialPosts).where(and(eq(socialPosts.workspaceId, ctx.workspace.id), eq(socialPosts.status, "published")));
    const byPlat: Record<string, { posts: number; impressions: number; engagements: number; clicks: number }> = {};
    for (const r of rows) {
      const p = (byPlat[r.platform] ||= { posts: 0, impressions: 0, engagements: 0, clicks: 0 });
      p.posts++; p.impressions += r.impressions; p.engagements += r.engagements; p.clicks += r.clicks;
    }
    const totalImp = rows.reduce((s, r) => s + r.impressions, 0);
    const totalEng = rows.reduce((s, r) => s + r.engagements, 0);
    return {
      totalPosts: rows.length,
      totalImpressions: totalImp,
      totalEngagements: totalEng,
      engagementRate: totalImp ? totalEng / totalImp : 0,
      byPlatform: byPlat,
    };
  }),
});

/* ───── Campaigns ───────────────────────────────────────────────────── */

export const campaignsRouter = router({
  list: workspaceProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) return [];
    return db.select().from(campaigns).where(eq(campaigns.workspaceId, ctx.workspace.id)).orderBy(desc(campaigns.updatedAt));
  }),

  get: workspaceProcedure.input(z.object({ id: z.number() })).query(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const [row] = await db.select().from(campaigns).where(and(eq(campaigns.id, input.id), eq(campaigns.workspaceId, ctx.workspace.id)));
    return row ?? null;
  }),

  components: workspaceProcedure.input(z.object({ campaignId: z.number() })).query(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) return [];
    return db.select().from(campaignComponents).where(and(eq(campaignComponents.campaignId, input.campaignId), eq(campaignComponents.workspaceId, ctx.workspace.id)));
  }),

  /** Aggregated unified analytics across attached opps/social/sequences. */
  analytics: workspaceProcedure.input(z.object({ id: z.number() })).query(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) return null;
    const opps = await db.select().from(opportunities).where(and(eq(opportunities.workspaceId, ctx.workspace.id), eq(opportunities.campaignId, input.id)));
    const posts = await db.select().from(socialPosts).where(and(eq(socialPosts.workspaceId, ctx.workspace.id), eq(socialPosts.campaignId, input.id)));
    return {
      pipelineCount: opps.length,
      pipelineValue: opps.reduce((s, o) => s + Number(o.value), 0),
      wonValue: opps.filter((o) => o.stage === "won").reduce((s, o) => s + Number(o.value), 0),
      socialPosts: posts.length,
      socialImpressions: posts.reduce((s, p) => s + p.impressions, 0),
      socialEngagements: posts.reduce((s, p) => s + p.engagements, 0),
    };
  }),

  create: workspaceProcedure.input(z.object({
    name: z.string().min(1),
    objective: z.string().optional(),
    description: z.string().optional(),
    startsAt: z.string().optional(),
    endsAt: z.string().optional(),
    budget: z.number().min(0).default(0),
    targetSegment: z.string().optional(),
  })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const r = await db.insert(campaigns).values({
      ...input,
      workspaceId: ctx.workspace.id,
      ownerUserId: ctx.user.id,
      status: "planning",
      startsAt: input.startsAt ? new Date(input.startsAt) : null,
      endsAt: input.endsAt ? new Date(input.endsAt) : null,
      budget: String(input.budget),
      checklist: [
        { id: 1, label: "Owner assigned", done: true },
        { id: 2, label: "Budget approved", done: false },
        { id: 3, label: "Creative reviewed", done: false },
        { id: 4, label: "Tracking links generated", done: false },
        { id: 5, label: "Sequences enrolled", done: false },
      ],
    });
    return { id: Number((r as any)[0]?.insertId ?? 0) };
  }),

  update: workspaceProcedure.input(z.object({ id: z.number(), patch: z.record(z.string(), z.any()) })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const patch: any = { ...input.patch };
    if (patch.budget !== undefined) patch.budget = String(patch.budget);
    if (patch.startsAt && typeof patch.startsAt === "string") patch.startsAt = new Date(patch.startsAt);
    if (patch.endsAt && typeof patch.endsAt === "string") patch.endsAt = new Date(patch.endsAt);
    await db.update(campaigns).set(patch).where(and(eq(campaigns.id, input.id), eq(campaigns.workspaceId, ctx.workspace.id)));
    return { ok: true };
  }),

  /** Launch checklist enforcement: returns the checklist; refuses to launch if any not done. */
  launch: workspaceProcedure.input(z.object({ id: z.number() })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const [c] = await db.select().from(campaigns).where(and(eq(campaigns.id, input.id), eq(campaigns.workspaceId, ctx.workspace.id)));
    if (!c) throw new TRPCError({ code: "NOT_FOUND" });
    const checklist: Array<{ done: boolean; label: string }> = (c.checklist as any) ?? [];
    const incomplete = checklist.filter((x) => !x.done);
    if (incomplete.length > 0) {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: `Checklist incomplete: ${incomplete.map((x) => x.label).join(", ")}` });
    }
    await db.update(campaigns).set({ status: "live", startsAt: c.startsAt ?? new Date() }).where(eq(campaigns.id, c.id));
    return { ok: true };
  }),

  toggleChecklist: workspaceProcedure.input(z.object({ id: z.number(), itemId: z.number(), done: z.boolean() })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const [c] = await db.select().from(campaigns).where(and(eq(campaigns.id, input.id), eq(campaigns.workspaceId, ctx.workspace.id)));
    if (!c) throw new TRPCError({ code: "NOT_FOUND" });
    const checklist: Array<{ id: number; done: boolean; label: string }> = (c.checklist as any) ?? [];
    const next = checklist.map((x) => (x.id === input.itemId ? { ...x, done: input.done } : x));
    await db.update(campaigns).set({ checklist: next }).where(eq(campaigns.id, c.id));
    return { ok: true };
  }),

  attachComponent: workspaceProcedure.input(z.object({
    campaignId: z.number(),
    componentType: z.enum(["sequence", "social_post", "ad", "content", "event"]),
    componentId: z.number().optional(),
    label: z.string().min(1),
    notes: z.string().optional(),
  })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    await db.insert(campaignComponents).values({ ...input, workspaceId: ctx.workspace.id });
    return { ok: true };
  }),

  removeComponent: workspaceProcedure.input(z.object({ id: z.number() })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    await db.delete(campaignComponents).where(and(eq(campaignComponents.id, input.id), eq(campaignComponents.workspaceId, ctx.workspace.id)));
    return { ok: true };
  }),

  delete: workspaceProcedure.input(z.object({ id: z.number() })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    await db.delete(campaigns).where(and(eq(campaigns.id, input.id), eq(campaigns.workspaceId, ctx.workspace.id)));
    return { ok: true };
  }),

  /** Update outreach-specific fields (audience, sequence, sender, throttle, A/B) */
  updateOutreach: workspaceProcedure.input(z.object({
    id: z.number(),
    audienceType: z.enum(["contacts", "segment"]).optional(),
    audienceIds: z.array(z.number()).optional(),
    audienceSegmentId: z.number().nullable().optional(),
    sequenceId: z.number().nullable().optional(),
    senderType: z.enum(["account", "pool"]).optional(),
    sendingAccountId: z.number().nullable().optional(),
    senderPoolId: z.number().nullable().optional(),
    rotationStrategy: z.enum(["round_robin", "weighted", "random"]).optional(),
    throttlePerHour: z.number().min(1).max(1000).optional(),
    throttlePerDay: z.number().min(1).max(10000).optional(),
    abVariants: z.array(z.object({ label: z.string(), subjectLine: z.string(), weight: z.number() })).optional(),
  })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const { id, ...patch } = input;
    await db.update(campaigns).set(patch as any).where(and(eq(campaigns.id, id), eq(campaigns.workspaceId, ctx.workspace.id)));
    return { ok: true };
  }),

  /** Pause a live campaign */
  pause: workspaceProcedure.input(z.object({ id: z.number() })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    await db.update(campaigns).set({ status: "paused" }).where(and(eq(campaigns.id, input.id), eq(campaigns.workspaceId, ctx.workspace.id)));
    return { ok: true };
  }),

  /** Get per-step analytics for a campaign */
  getStepStats: workspaceProcedure.input(z.object({ campaignId: z.number() })).query(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const rows = await db.select().from(campaignStepStats)
      .where(and(eq(campaignStepStats.campaignId, input.campaignId), eq(campaignStepStats.workspaceId, ctx.workspace.id)))
      .orderBy(campaignStepStats.stepIndex);
    return rows;
  }),

  /** Get campaign with related sequence, sender, and audience segment */
  getWithDetails: workspaceProcedure.input(z.object({ id: z.number() })).query(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const [c] = await db.select().from(campaigns).where(and(eq(campaigns.id, input.id), eq(campaigns.workspaceId, ctx.workspace.id)));
    if (!c) throw new TRPCError({ code: "NOT_FOUND" });
    const [seq] = c.sequenceId ? await db.select({ id: sequences.id, name: sequences.name, status: sequences.status, enrolledCount: sequences.enrolledCount }).from(sequences).where(eq(sequences.id, c.sequenceId)) : [];
    const [acct] = c.sendingAccountId ? await db.select({ id: sendingAccounts.id, fromEmail: sendingAccounts.fromEmail, provider: sendingAccounts.provider }).from(sendingAccounts).where(eq(sendingAccounts.id, c.sendingAccountId)) : [];
    const [pool] = c.senderPoolId ? await db.select({ id: senderPools.id, name: senderPools.name, rotationStrategy: senderPools.rotationStrategy }).from(senderPools).where(eq(senderPools.id, c.senderPoolId)) : [];
    const [seg] = c.audienceSegmentId ? await db.select({ id: audienceSegments.id, name: audienceSegments.name }).from(audienceSegments).where(eq(audienceSegments.id, c.audienceSegmentId)) : [];
    return { ...c, sequence: seq ?? null, sendingAccount: acct ?? null, senderPool: pool ?? null, audienceSegment: seg ?? null };
  }),

  /** Overall analytics KPIs for a campaign (totals from the campaigns row) */
  getAnalytics: workspaceProcedure.input(z.object({ id: z.number() })).query(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const [c] = await db.select({
      totalSent: campaigns.totalSent,
      totalDelivered: campaigns.totalDelivered,
      totalOpened: campaigns.totalOpened,
      totalClicked: campaigns.totalClicked,
      totalReplied: campaigns.totalReplied,
      totalBounced: campaigns.totalBounced,
      totalUnsubscribed: campaigns.totalUnsubscribed,
    }).from(campaigns).where(and(eq(campaigns.id, input.id), eq(campaigns.workspaceId, ctx.workspace.id)));
    if (!c) throw new TRPCError({ code: "NOT_FOUND" });
    const openRate = c.totalDelivered > 0 ? Math.round((c.totalOpened / c.totalDelivered) * 100) : 0;
    const clickRate = c.totalOpened > 0 ? Math.round((c.totalClicked / c.totalOpened) * 100) : 0;
    const replyRate = c.totalDelivered > 0 ? Math.round((c.totalReplied / c.totalDelivered) * 100) : 0;
    const bounceRate = c.totalSent > 0 ? Math.round((c.totalBounced / c.totalSent) * 100) : 0;
     return { ...c, openRate, clickRate, replyRate, bounceRate };
  }),

  /** Add contacts or leads to a campaign's audience list */
  addAudience: workspaceProcedure
    .input(z.object({
      campaignId: z.number(),
      contactIds: z.array(z.number()).optional(),
      leadIds: z.array(z.number()).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const [c] = await db.select().from(campaigns).where(and(eq(campaigns.id, input.campaignId), eq(campaigns.workspaceId, ctx.workspace.id)));
      if (!c) throw new TRPCError({ code: "NOT_FOUND" });
      const existing: number[] = Array.isArray(c.audienceIds) ? (c.audienceIds as number[]) : [];
      const newIds = [...(input.contactIds ?? []), ...(input.leadIds ?? [])];
      const merged = Array.from(new Set([...existing, ...newIds]));
      await db.update(campaigns).set({ audienceType: "contacts", audienceIds: merged }).where(eq(campaigns.id, input.campaignId));
      return { added: merged.length - existing.length, total: merged.length };
    }),
});
/* ───── Custom Dashboards ─────────────────────────────────────────── */

export const dashboardsRouter = router({
  list: workspaceProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) return [];
    return db.select().from(dashboards).where(eq(dashboards.workspaceId, ctx.workspace.id)).orderBy(desc(dashboards.updatedAt));
  }),

  get: workspaceProcedure.input(z.object({ id: z.number() })).query(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const [d] = await db.select().from(dashboards).where(and(eq(dashboards.id, input.id), eq(dashboards.workspaceId, ctx.workspace.id)));
    if (!d) return null;
    const widgets = await db.select().from(dashboardWidgets).where(eq(dashboardWidgets.dashboardId, d.id));
    return { ...d, widgets };
  }),

  create: workspaceProcedure.input(z.object({ name: z.string().min(1), description: z.string().optional() })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const r = await db.insert(dashboards).values({ ...input, workspaceId: ctx.workspace.id, ownerUserId: ctx.user.id, layout: [] });
    return { id: Number((r as any)[0]?.insertId ?? 0) };
  }),

  rename: workspaceProcedure.input(z.object({ id: z.number(), name: z.string().min(1), description: z.string().optional() })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    await db.update(dashboards).set({ name: input.name, description: input.description }).where(and(eq(dashboards.id, input.id), eq(dashboards.workspaceId, ctx.workspace.id)));
    return { ok: true };
  }),

  delete: workspaceProcedure.input(z.object({ id: z.number() })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    await db.delete(dashboardWidgets).where(eq(dashboardWidgets.dashboardId, input.id));
    await db.delete(dashboards).where(and(eq(dashboards.id, input.id), eq(dashboards.workspaceId, ctx.workspace.id)));
    return { ok: true };
  }),

  addWidget: workspaceProcedure.input(z.object({
    dashboardId: z.number(),
    type: z.enum([
      "kpi", "bar", "stacked_bar", "line", "area", "pie", "donut",
      "funnel", "scatter", "heatmap", "gauge", "single_value",
      "table", "leaderboard", "activity_feed", "goal_progress",
      "comparison", "pipeline_stage", "rep_performance", "email_health",
    ]),
    title: z.string().min(1),
    config: z.record(z.string(), z.any()),
    filters: z.record(z.string(), z.any()).optional(),
    position: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }).optional(),
  })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    await db.insert(dashboardWidgets).values({ ...input, workspaceId: ctx.workspace.id, position: input.position ?? { x: 0, y: 0, w: 4, h: 3 } });
    return { ok: true };
  }),

  updateWidget: workspaceProcedure.input(z.object({ id: z.number(), patch: z.record(z.string(), z.any()) })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    await db.update(dashboardWidgets).set(input.patch).where(and(eq(dashboardWidgets.id, input.id), eq(dashboardWidgets.workspaceId, ctx.workspace.id)));
    return { ok: true };
  }),

  saveLayout: workspaceProcedure.input(z.object({ dashboardId: z.number(), positions: z.array(z.object({ id: z.number(), x: z.number(), y: z.number(), w: z.number(), h: z.number() })) })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    for (const p of input.positions) {
      await db.update(dashboardWidgets).set({ position: { x: p.x, y: p.y, w: p.w, h: p.h } }).where(and(eq(dashboardWidgets.id, p.id), eq(dashboardWidgets.workspaceId, ctx.workspace.id)));
    }
    return { ok: true };
  }),

  deleteWidget: workspaceProcedure.input(z.object({ id: z.number() })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    await db.delete(dashboardWidgets).where(and(eq(dashboardWidgets.id, input.id), eq(dashboardWidgets.workspaceId, ctx.workspace.id)));
    return { ok: true };
  }),

  /** Resolve a widget config to data. Server computes the metrics. */
  resolveWidget: workspaceProcedure.input(z.object({
    id: z.number(),
    filters: z.object({
      dateFrom: z.string().optional(),
      dateTo: z.string().optional(),
      ownerUserId: z.number().optional(),
      stage: z.string().optional(),
      source: z.string().optional(),
    }).optional(),
  })).query(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) return null;
    const [w] = await db.select().from(dashboardWidgets).where(and(eq(dashboardWidgets.id, input.id), eq(dashboardWidgets.workspaceId, ctx.workspace.id)));
    if (!w) return null;
    // Merge widget-level saved filters with per-query override filters
    const mergedFilters = { ...(w.filters as any ?? {}), ...(input.filters ?? {}) };
    return resolveWidgetData(ctx.workspace.id, w, mergedFilters);
  }),

  /** Schedules. */
  listSchedules: workspaceProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) return [];
    return db.select().from(reportSchedules).where(eq(reportSchedules.workspaceId, ctx.workspace.id));
  }),

  createSchedule: workspaceProcedure.input(z.object({
    dashboardId: z.number(),
    frequency: z.enum(["daily", "weekly", "monthly"]),
    recipients: z.array(z.string().email()),
  })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    await db.insert(reportSchedules).values({ ...input, workspaceId: ctx.workspace.id, enabled: true });
    return { ok: true };
  }),

  toggleSchedule: workspaceProcedure.input(z.object({ id: z.number(), enabled: z.boolean() })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    await db.update(reportSchedules).set({ enabled: input.enabled }).where(and(eq(reportSchedules.id, input.id), eq(reportSchedules.workspaceId, ctx.workspace.id)));
    return { ok: true };
  }),

  /** Stub send-now. Marks lastSentAt. */
  sendScheduleNow: workspaceProcedure.input(z.object({ id: z.number() })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    await db.update(reportSchedules).set({ lastSentAt: new Date() }).where(and(eq(reportSchedules.id, input.id), eq(reportSchedules.workspaceId, ctx.workspace.id)));
    return { ok: true, sentAt: new Date() };
  }),

  deleteSchedule: workspaceProcedure.input(z.object({ id: z.number() })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    await db.delete(reportSchedules).where(and(eq(reportSchedules.id, input.id), eq(reportSchedules.workspaceId, ctx.workspace.id)));
    return { ok: true };
  }),
});

type WidgetFilters = {
  dateFrom?: string;
  dateTo?: string;
  ownerUserId?: number;
  stage?: string;
  source?: string;
};

/** Build a date range condition for opportunity.createdAt or closeDate */
function dateRange(from?: string, to?: string) {
  const conds: any[] = [];
  if (from) conds.push(sql`created_at >= ${new Date(from)}`);
  if (to) conds.push(sql`created_at <= ${new Date(to)}`);
  return conds;
}

async function resolveWidgetData(
  workspaceId: number,
  w: { type: string; config: any; title: string },
  filters: WidgetFilters = {},
) {
  const db = await getDb();
  if (!db) return { type: w.type, title: w.title, value: null };
  const cfg = w.config ?? {};

  /* ── Helper: build base opportunity conditions with filters ── */
  const oppBase = () => {
    const conds: any[] = [eq(opportunities.workspaceId, workspaceId)];
    if (filters.ownerUserId) conds.push(eq(opportunities.ownerUserId, filters.ownerUserId));
    if (filters.stage) conds.push(eq(opportunities.stage, filters.stage as any));
    if (filters.dateFrom) conds.push(sql`${opportunities.createdAt} >= ${new Date(filters.dateFrom)}`);
    if (filters.dateTo) conds.push(sql`${opportunities.createdAt} <= ${new Date(filters.dateTo)}`);
    return and(...conds);
  };

  /* ── Helper: 6-month bucket array ── */
  const sixMonths = () => Array.from({ length: 6 }, (_, i) => {
    const d = new Date(); d.setMonth(d.getMonth() - (5 - i));
    return { label: d.toLocaleString("default", { month: "short" }), key: `${d.getFullYear()}-${d.getMonth()}` };
  });

  /* ═══════════════════════════════════════════════════════════
     KPI metrics (type = kpi | single_value | gauge)
  ═══════════════════════════════════════════════════════════ */
  if (w.type === "kpi" || w.type === "single_value" || w.type === "gauge") {
    switch (cfg.metric) {
      case "pipeline_value": {
        const [r] = await db.select({ s: sql<string>`COALESCE(SUM(${opportunities.value}),0)` })
          .from(opportunities).where(and(oppBase(), sql`${opportunities.stage} NOT IN ('won','lost')`));
        return { type: w.type, title: w.title, value: Number(r?.s ?? 0), format: "currency" };
      }
      case "closed_won_qtr": {
        const [r] = await db.select({ s: sql<string>`COALESCE(SUM(${opportunities.value}),0)` })
          .from(opportunities).where(and(oppBase(), eq(opportunities.stage, "won")));
        return { type: w.type, title: w.title, value: Number(r?.s ?? 0), format: "currency" };
      }
      case "revenue": {
        const [r] = await db.select({ s: sql<string>`COALESCE(SUM(${opportunities.value}),0)` })
          .from(opportunities).where(and(oppBase(), eq(opportunities.stage, "won")));
        return { type: w.type, title: w.title, value: Number(r?.s ?? 0), format: "currency" };
      }
      case "win_rate": {
        const all = await db.select().from(opportunities).where(oppBase());
        const closed = all.filter((o) => o.stage === "won" || o.stage === "lost");
        const wr = closed.length === 0 ? 0 : (closed.filter((o) => o.stage === "won").length / closed.length) * 100;
        return { type: w.type, title: w.title, value: Math.round(wr), format: "percent" };
      }
      case "avg_deal": {
        const won = await db.select().from(opportunities).where(and(oppBase(), eq(opportunities.stage, "won")));
        const avg = won.length === 0 ? 0 : won.reduce((s, o) => s + Number(o.value), 0) / won.length;
        return { type: w.type, title: w.title, value: Math.round(avg), format: "currency" };
      }
      case "sales_cycle_length": {
        const won = await db.select().from(opportunities)
          .where(and(oppBase(), eq(opportunities.stage, "won")));
        const withDates = won.filter((o) => o.closeDate);
        const avgDays = withDates.length === 0 ? 0 :
          withDates.reduce((s, o) => s + Math.max(0, Math.round((o.closeDate!.getTime() - o.createdAt.getTime()) / 86400000)), 0) / withDates.length;
        return { type: w.type, title: w.title, value: Math.round(avgDays), format: "days" };
      }
      case "activity_counts": {
        const actConds: any[] = [eq(activities.workspaceId, workspaceId)];
        if (filters.dateFrom) actConds.push(sql`${activities.occurredAt} >= ${new Date(filters.dateFrom)}`);
        if (filters.dateTo) actConds.push(sql`${activities.occurredAt} <= ${new Date(filters.dateTo)}`);
        const acts = await db.select().from(activities).where(and(...actConds));
        const calls = acts.filter((a) => a.type === "call").length;
        const emails = acts.filter((a) => a.type === "email").length;
        const meetings = acts.filter((a) => a.type === "meeting").length;
        return { type: w.type, title: w.title, value: acts.length, format: "number",
          breakdown: { calls, emails, meetings } };
      }
      case "meetings_booked": {
        const actConds: any[] = [eq(activities.workspaceId, workspaceId), eq(activities.type, "meeting")];
        if (filters.dateFrom) actConds.push(sql`${activities.occurredAt} >= ${new Date(filters.dateFrom)}`);
        if (filters.dateTo) actConds.push(sql`${activities.occurredAt} <= ${new Date(filters.dateTo)}`);
        const [r] = await db.select({ c: sql<number>`COUNT(*)` }).from(activities).where(and(...actConds));
        return { type: w.type, title: w.title, value: Number(r?.c ?? 0), format: "number" };
      }
      case "response_rate": {
        // Ratio of opportunities with at least one activity to total opportunities
        const all = await db.select().from(opportunities).where(oppBase());
        const withActivity = await db.select({ oppId: activities.relatedId })
          .from(activities)
          .where(and(eq(activities.workspaceId, workspaceId), eq(activities.relatedType, "opportunity")))
          .groupBy(activities.relatedId);
        const rate = all.length === 0 ? 0 : (withActivity.length / all.length) * 100;
        return { type: w.type, title: w.title, value: Math.round(rate), format: "percent" };
      }
      case "reply_rate": {
        // Ratio of won+lost opps to all opps (proxy for reply/engagement)
        const all = await db.select().from(opportunities).where(oppBase());
        const engaged = all.filter((o) => o.stage === "won" || o.stage === "negotiation" || o.stage === "proposal").length;
        const rate = all.length === 0 ? 0 : (engaged / all.length) * 100;
        return { type: w.type, title: w.title, value: Math.round(rate), format: "percent" };
      }
      default: {
        // Legacy fallback for old metrics
        const [r] = await db.select({ s: sql<string>`COALESCE(SUM(${opportunities.value}),0)` })
          .from(opportunities).where(and(oppBase(), sql`${opportunities.stage} NOT IN ('won','lost')`));
        return { type: w.type, title: w.title, value: Number(r?.s ?? 0), format: "currency" };
      }
    }
  }

  /* ═══════════════════════════════════════════════════════════
     Funnel / Pipeline Stage
  ═══════════════════════════════════════════════════════════ */
  if (w.type === "funnel" || w.type === "pipeline_stage") {
    const all = await db.select().from(opportunities).where(oppBase());
    const stages = ["discovery", "qualified", "proposal", "negotiation", "won"];
    return {
      type: w.type, title: w.title,
      series: stages.map((s) => ({
        stage: s,
        count: all.filter((o) => o.stage === s).length,
        value: all.filter((o) => o.stage === s).reduce((sum, o) => sum + Number(o.value), 0),
      })),
    };
  }

  /* ═══════════════════════════════════════════════════════════
     Bar / Line / Area / Stacked Bar (time-series)
  ═══════════════════════════════════════════════════════════ */
  if (["bar", "line", "area", "stacked_bar"].includes(w.type)) {
    const months = sixMonths();
    if (cfg.metric === "closed_won" || cfg.metric === "revenue") {
      const won = await db.select().from(opportunities)
        .where(and(oppBase(), eq(opportunities.stage, "won")));
      const out = months.map((m) => ({ label: m.label, value: 0 }));
      for (const o of won) {
        if (!o.closeDate) continue;
        const k = `${o.closeDate.getFullYear()}-${o.closeDate.getMonth()}`;
        const idx = months.findIndex((m) => m.key === k);
        if (idx >= 0) out[idx]!.value += Number(o.value);
      }
      return { type: w.type, title: w.title, series: out };
    }
    if (cfg.metric === "pipeline_created") {
      const all = await db.select().from(opportunities).where(oppBase());
      const out = months.map((m) => ({ label: m.label, value: 0 }));
      for (const o of all) {
        const k = `${o.createdAt.getFullYear()}-${o.createdAt.getMonth()}`;
        const idx = months.findIndex((m) => m.key === k);
        if (idx >= 0) out[idx]!.value += Number(o.value);
      }
      return { type: w.type, title: w.title, series: out };
    }
    if (cfg.metric === "activities") {
      const actConds: any[] = [eq(activities.workspaceId, workspaceId)];
      if (filters.dateFrom) actConds.push(sql`${activities.occurredAt} >= ${new Date(filters.dateFrom)}`);
      if (filters.dateTo) actConds.push(sql`${activities.occurredAt} <= ${new Date(filters.dateTo)}`);
      const acts = await db.select().from(activities).where(and(...actConds));
      const out = months.map((m) => ({ label: m.label, calls: 0, emails: 0, meetings: 0 }));
      for (const a of acts) {
        const k = `${a.occurredAt.getFullYear()}-${a.occurredAt.getMonth()}`;
        const idx = months.findIndex((m) => m.key === k);
        if (idx < 0) continue;
        if (a.type === "call") out[idx]!.calls++;
        else if (a.type === "email") out[idx]!.emails++;
        else if (a.type === "meeting") out[idx]!.meetings++;
      }
      return { type: w.type, title: w.title, series: out, keys: ["calls", "emails", "meetings"] };
    }
    // Default: closed-won by month
    const won = await db.select().from(opportunities)
      .where(and(oppBase(), eq(opportunities.stage, "won")));
    const out = months.map((m) => ({ label: m.label, value: 0 }));
    for (const o of won) {
      if (!o.closeDate) continue;
      const k = `${o.closeDate.getFullYear()}-${o.closeDate.getMonth()}`;
      const idx = months.findIndex((m) => m.key === k);
      if (idx >= 0) out[idx]!.value += Number(o.value);
    }
    return { type: w.type, title: w.title, series: out };
  }

  /* ═══════════════════════════════════════════════════════════
     Pie / Donut
  ═══════════════════════════════════════════════════════════ */
  if (w.type === "pie" || w.type === "donut") {
    if (cfg.metric === "stage_distribution") {
      const all = await db.select().from(opportunities).where(oppBase());
      const stages = ["discovery", "qualified", "proposal", "negotiation", "won", "lost"];
      return {
        type: w.type, title: w.title,
        series: stages.map((s) => ({ name: s, value: all.filter((o) => o.stage === s).length })).filter((s) => s.value > 0),
      };
    }
    // Default: win/loss ratio
    const all = await db.select().from(opportunities).where(oppBase());
    const won = all.filter((o) => o.stage === "won").length;
    const lost = all.filter((o) => o.stage === "lost").length;
    const open = all.length - won - lost;
    return { type: w.type, title: w.title, series: [{ name: "Won", value: won }, { name: "Lost", value: lost }, { name: "Open", value: open }].filter((s) => s.value > 0) };
  }

  /* ═══════════════════════════════════════════════════════════
     Scatter
  ═══════════════════════════════════════════════════════════ */
  if (w.type === "scatter") {
    const all = await db.select().from(opportunities).where(oppBase());
    return {
      type: w.type, title: w.title,
      series: all.slice(0, 50).map((o) => ({
        x: o.daysInStage,
        y: Number(o.value),
        name: o.name,
        stage: o.stage,
      })),
    };
  }

  /* ═══════════════════════════════════════════════════════════
     Heatmap (activity by day-of-week × hour)
  ═══════════════════════════════════════════════════════════ */
  if (w.type === "heatmap") {
    const actConds: any[] = [eq(activities.workspaceId, workspaceId)];
    if (filters.dateFrom) actConds.push(sql`${activities.occurredAt} >= ${new Date(filters.dateFrom)}`);
    if (filters.dateTo) actConds.push(sql`${activities.occurredAt} <= ${new Date(filters.dateTo)}`);
    const acts = await db.select().from(activities).where(and(...actConds));
    // Build 7×24 grid
    const grid: number[][] = Array.from({ length: 7 }, () => Array(24).fill(0));
    for (const a of acts) {
      const day = a.occurredAt.getDay();
      const hour = a.occurredAt.getHours();
      grid[day]![hour]++;
    }
    const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const series = grid.flatMap((row, d) => row.map((count, h) => ({ day: days[d]!, hour: h, count })));
    return { type: w.type, title: w.title, series };
  }

  /* ═══════════════════════════════════════════════════════════
     Table (top accounts by pipeline)
  ═══════════════════════════════════════════════════════════ */
  if (w.type === "table") {
    const accs = await db.select().from(opportunities).where(oppBase());
    const map = new Map<number, number>();
    for (const o of accs) map.set(o.accountId, (map.get(o.accountId) ?? 0) + Number(o.value));
    const top = Array.from(map.entries()).sort((a, b) => b[1] - a[1]).slice(0, cfg.limit ?? 5);
    // Fetch account names
    const accRows = await db.select({ id: accounts.id, name: accounts.name })
      .from(accounts).where(eq(accounts.workspaceId, workspaceId));
    const nameMap = new Map(accRows.map((a) => [a.id, a.name]));
    return { type: "table", title: w.title, rows: top.map(([id, v]) => ({ id, name: nameMap.get(id) ?? `Account #${id}`, value: v })) };
  }

  /* ═══════════════════════════════════════════════════════════
     Leaderboard (top reps by deals closed)
  ═══════════════════════════════════════════════════════════ */
  if (w.type === "leaderboard") {
    const won = await db.select().from(opportunities)
      .where(and(oppBase(), eq(opportunities.stage, "won")));
    const repMap = new Map<number, { count: number; value: number }>();
    for (const o of won) {
      if (!o.ownerUserId) continue;
      const cur = repMap.get(o.ownerUserId) ?? { count: 0, value: 0 };
      repMap.set(o.ownerUserId, { count: cur.count + 1, value: cur.value + Number(o.value) });
    }
    const memberRows = await db.select({ userId: workspaceMembers.userId, name: users.name })
      .from(workspaceMembers)
      .innerJoin(users, eq(users.id, workspaceMembers.userId))
      .where(eq(workspaceMembers.workspaceId, workspaceId));
    const nameMap = new Map(memberRows.map((m) => [m.userId, m.name ?? `User #${m.userId}`]));
    const rows = Array.from(repMap.entries())
      .sort((a, b) => b[1].value - a[1].value)
      .slice(0, cfg.limit ?? 10)
      .map(([uid, stats], rank) => ({ rank: rank + 1, name: nameMap.get(uid) ?? `Rep #${uid}`, ...stats }));
    return { type: "leaderboard", title: w.title, rows };
  }

  /* ═══════════════════════════════════════════════════════════
     Activity Feed (recent activities)
  ═══════════════════════════════════════════════════════════ */
  if (w.type === "activity_feed") {
    const actConds: any[] = [eq(activities.workspaceId, workspaceId)];
    if (filters.dateFrom) actConds.push(sql`${activities.occurredAt} >= ${new Date(filters.dateFrom)}`);
    if (filters.dateTo) actConds.push(sql`${activities.occurredAt} <= ${new Date(filters.dateTo)}`);
    const acts = await db.select().from(activities)
      .where(and(...actConds))
      .orderBy(desc(activities.occurredAt))
      .limit(cfg.limit ?? 20);
    return { type: "activity_feed", title: w.title, items: acts.map((a) => ({
      id: a.id, type: a.type, subject: a.subject ?? a.type,
      relatedType: a.relatedType, relatedId: a.relatedId,
      occurredAt: a.occurredAt.toISOString(),
    })) };
  }

  /* ═══════════════════════════════════════════════════════════
     Goal Progress (pipeline value vs target)
  ═══════════════════════════════════════════════════════════ */
  if (w.type === "goal_progress") {
    const target = Number(cfg.target ?? 1000000);
    const [r] = await db.select({ s: sql<string>`COALESCE(SUM(${opportunities.value}),0)` })
      .from(opportunities).where(and(oppBase(), sql`${opportunities.stage} NOT IN ('lost')`));
    const current = Number(r?.s ?? 0);
    return { type: "goal_progress", title: w.title, current, target, pct: Math.min(100, Math.round((current / target) * 100)) };
  }

  /* ═══════════════════════════════════════════════════════════
     Comparison (period-over-period)
  ═══════════════════════════════════════════════════════════ */
  if (w.type === "comparison") {
    const metric = cfg.metric ?? "revenue";
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const endOfLastMonth = new Date(now.getFullYear(), now.getMonth(), 0);

    const getVal = async (from: Date, to: Date) => {
      const conds: any[] = [
        eq(opportunities.workspaceId, workspaceId),
        eq(opportunities.stage, "won"),
        sql`${opportunities.closeDate} >= ${from}`,
        sql`${opportunities.closeDate} <= ${to}`,
      ];
      if (filters.ownerUserId) conds.push(eq(opportunities.ownerUserId, filters.ownerUserId));
      const [r] = await db.select({ s: sql<string>`COALESCE(SUM(${opportunities.value}),0)` })
        .from(opportunities).where(and(...conds));
      return Number(r?.s ?? 0);
    };

    const current = await getVal(startOfMonth, now);
    const previous = await getVal(startOfLastMonth, endOfLastMonth);
    const changePct = previous === 0 ? 100 : Math.round(((current - previous) / previous) * 100);
    return { type: "comparison", title: w.title, current, previous, changePct, metric, format: "currency" };
  }

  /* ═══════════════════════════════════════════════════════════
     Rep Performance (table of rep KPIs)
  ═══════════════════════════════════════════════════════════ */
  if (w.type === "rep_performance") {
    const allOpps = await db.select().from(opportunities).where(oppBase());
    const allActs = await db.select().from(activities).where(eq(activities.workspaceId, workspaceId));
    const memberRows = await db.select({ userId: workspaceMembers.userId, name: users.name })
      .from(workspaceMembers)
      .innerJoin(users, eq(users.id, workspaceMembers.userId))
      .where(eq(workspaceMembers.workspaceId, workspaceId));

    const rows = memberRows.map((m) => {
      const myOpps = allOpps.filter((o) => o.ownerUserId === m.userId);
      const myWon = myOpps.filter((o) => o.stage === "won");
      const myClosed = myOpps.filter((o) => o.stage === "won" || o.stage === "lost");
      const myActs = allActs.filter((a) => a.actorUserId === m.userId);
      const winRate = myClosed.length === 0 ? 0 : Math.round((myWon.length / myClosed.length) * 100);
      const revenue = myWon.reduce((s, o) => s + Number(o.value), 0);
      const pipeline = myOpps.filter((o) => !(["won", "lost"].includes(o.stage))).reduce((s, o) => s + Number(o.value), 0);
      return { name: m.name ?? `Rep #${m.userId}`, deals: myWon.length, revenue, pipeline, winRate, activities: myActs.length };
    }).filter((r) => r.deals > 0 || r.pipeline > 0 || r.activities > 0)
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, cfg.limit ?? 10);
    return { type: "rep_performance", title: w.title, rows };
  }

  /* ═══════════════════════════════════════════════════════════
     Email Health widget
  ═══════════════════════════════════════════════════════════ */
  if (w.type === "email_health") {
    const allContacts = await db.select().from(contacts).where(eq(contacts.workspaceId, workspaceId));
    const total = allContacts.length;
    const valid = allContacts.filter((c) => c.emailVerificationStatus === "valid").length;
    const acceptAll = allContacts.filter((c) => c.emailVerificationStatus === "accept_all").length;
    const risky = allContacts.filter((c) => c.emailVerificationStatus === "risky").length;
    const invalid = allContacts.filter((c) => c.emailVerificationStatus === "invalid").length;
    const unknown = allContacts.filter((c) => !c.emailVerificationStatus).length;
    const verifiedPct = total === 0 ? 0 : Math.round(((total - unknown) / total) * 100);
    return { type: "email_health", title: w.title, total, valid, acceptAll, risky, invalid, unknown, verifiedPct };
  }

  return { type: w.type, title: w.title, value: null };
}

/* ───── Quotes (CPQ) ──────────────────────────────────────────────── */

export const quotesRouter = router({
  list: workspaceProcedure.input(z.object({ opportunityId: z.number().optional() }).optional()).query(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) return [];
    let rows = await db.select().from(quotes).where(eq(quotes.workspaceId, ctx.workspace.id)).orderBy(desc(quotes.createdAt));
    if (input?.opportunityId) rows = rows.filter((r) => r.opportunityId === input.opportunityId);
    return rows;
  }),

  get: workspaceProcedure.input(z.object({ id: z.number() })).query(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const [q] = await db.select().from(quotes).where(and(eq(quotes.id, input.id), eq(quotes.workspaceId, ctx.workspace.id)));
    if (!q) return null;
    const lis = await db.select().from(quoteLineItems).where(eq(quoteLineItems.quoteId, q.id));
    return { ...q, lineItems: lis };
  }),

  create: workspaceProcedure.input(z.object({
    opportunityId: z.number(),
    expiresInDays: z.number().int().min(1).max(180).default(30),
    notes: z.string().optional(),
    terms: z.string().optional(),
    lineItems: z.array(z.object({
      productId: z.number().optional(),
      name: z.string().min(1),
      description: z.string().optional(),
      quantity: z.number().int().min(1),
      unitPrice: z.number().min(0),
      discountPct: z.number().min(0).max(100).default(0),
    })).min(1),
  })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

    const subtotal = input.lineItems.reduce((s, li) => s + li.quantity * li.unitPrice, 0);
    const discountTotal = input.lineItems.reduce((s, li) => s + li.quantity * li.unitPrice * (li.discountPct / 100), 0);
    const taxTotal = 0;
    const total = subtotal - discountTotal + taxTotal;
    const num = `Q-${Date.now()}`;

    const r = await db.insert(quotes).values({
      workspaceId: ctx.workspace.id,
      opportunityId: input.opportunityId,
      quoteNumber: num,
      status: "draft",
      expiresAt: new Date(Date.now() + input.expiresInDays * 86400000),
      subtotal: String(subtotal),
      discountTotal: String(discountTotal),
      taxTotal: String(taxTotal),
      total: String(total),
      notes: input.notes,
      terms: input.terms,
      createdByUserId: ctx.user.id,
    });
    const id = Number((r as any)[0]?.insertId ?? 0);

    for (const li of input.lineItems) {
      await db.insert(quoteLineItems).values({
        workspaceId: ctx.workspace.id,
        quoteId: id,
        productId: li.productId ?? null,
        name: li.name,
        description: li.description,
        quantity: li.quantity,
        unitPrice: String(li.unitPrice),
        discountPct: String(li.discountPct),
        lineTotal: String(li.quantity * li.unitPrice * (1 - li.discountPct / 100)),
      });
    }
    return { id, quoteNumber: num };
  }),

  /** Generate a real PDF via pdfkit and store in S3. */
  generatePdf: workspaceProcedure.input(z.object({ id: z.number() })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const [q] = await db.select().from(quotes).where(and(eq(quotes.id, input.id), eq(quotes.workspaceId, ctx.workspace.id)));
    if (!q) throw new TRPCError({ code: "NOT_FOUND" });
    const lis = await db.select().from(quoteLineItems).where(eq(quoteLineItems.quoteId, q.id));

    // Lazy-import to keep cold start light; pdfkit is CJS so we destructure .default.
    const { default: PDFDocument } = await import("pdfkit");
    const buf: Buffer = await new Promise((resolve, reject) => {
      const doc = new PDFDocument({ size: "LETTER", margin: 48 });
      const chunks: Buffer[] = [];
      doc.on("data", (c: Buffer) => chunks.push(c));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      // Header
      doc.fillColor("#0F1F1B").fontSize(24).font("Helvetica-Bold").text("USIP", { continued: false });
      doc.fontSize(11).font("Helvetica").fillColor("#666").text(`Quote ${q.quoteNumber}`);
      doc.moveUp(2);
      const status = q.status.toUpperCase();
      const exp = q.expiresAt ? new Date(q.expiresAt).toLocaleDateString() : "—";
      doc.fontSize(10).fillColor("#666").text(`Status: ${status}`, { align: "right" }).text(`Expires: ${exp}`, { align: "right" });
      doc.moveDown(0.5);
      doc.strokeColor("#14B89A").lineWidth(2).moveTo(48, doc.y).lineTo(564, doc.y).stroke();
      doc.moveDown(1);

      // Line items header
      const tableTop = doc.y;
      const colX = { item: 48, qty: 320, unit: 380, disc: 450, total: 510 };
      doc.fillColor("#fff").rect(48, tableTop, 516, 22).fill("#0F1F1B");
      doc.fillColor("#fff").fontSize(9).font("Helvetica-Bold");
      doc.text("ITEM", colX.item + 6, tableTop + 7);
      doc.text("QTY", colX.qty, tableTop + 7, { width: 50, align: "right" });
      doc.text("UNIT", colX.unit, tableTop + 7, { width: 60, align: "right" });
      doc.text("DISC.", colX.disc, tableTop + 7, { width: 50, align: "right" });
      doc.text("TOTAL", colX.total, tableTop + 7, { width: 54, align: "right" });
      let y = tableTop + 28;

      doc.font("Helvetica").fontSize(10).fillColor("#0F1F1B");
      for (const li of lis) {
        doc.fillColor("#0F1F1B").text(li.name, colX.item + 6, y, { width: 260 });
        if (li.description) {
          doc.fillColor("#666").fontSize(8).text(li.description, colX.item + 6, doc.y, { width: 260 });
          doc.fontSize(10).fillColor("#0F1F1B");
        }
        const rowH = Math.max(20, doc.y - y);
        doc.text(String(li.quantity), colX.qty, y, { width: 50, align: "right" });
        doc.text(`$${Number(li.unitPrice).toLocaleString()}`, colX.unit, y, { width: 60, align: "right" });
        doc.text(`${Number(li.discountPct).toFixed(1)}%`, colX.disc, y, { width: 50, align: "right" });
        doc.font("Helvetica-Bold").text(`$${Number(li.lineTotal).toLocaleString()}`, colX.total, y, { width: 54, align: "right" });
        doc.font("Helvetica");
        y += rowH + 4;
        doc.strokeColor("#eee").lineWidth(0.5).moveTo(48, y - 2).lineTo(564, y - 2).stroke();
      }

      // Totals
      doc.y = y + 16;
      const labelX = 380, valX = 510, valW = 54;
      const totalsRow = (label: string, value: string, bold = false) => {
        if (bold) doc.font("Helvetica-Bold").fontSize(13).fillColor("#0F1F1B");
        else doc.font("Helvetica").fontSize(10).fillColor("#0F1F1B");
        const ty = doc.y;
        doc.text(label, labelX, ty, { width: 120 });
        doc.text(value, valX, ty, { width: valW, align: "right" });
        doc.moveDown(0.3);
      };
      totalsRow("Subtotal", `$${Number(q.subtotal).toLocaleString()}`);
      totalsRow("Discount", `−$${Number(q.discountTotal).toLocaleString()}`);
      totalsRow("Tax", `$${Number(q.taxTotal).toLocaleString()}`);
      doc.strokeColor("#0F1F1B").lineWidth(1.5).moveTo(labelX, doc.y).lineTo(564, doc.y).stroke();
      doc.moveDown(0.3);
      totalsRow("Total", `$${Number(q.total).toLocaleString()}`, true);

      // Notes & Terms
      if (q.notes) {
        doc.moveDown(1.5).font("Helvetica-Bold").fontSize(10).fillColor("#0F1F1B").text("Notes", 48);
        doc.font("Helvetica").fontSize(10).fillColor("#444").text(q.notes, 48, doc.y, { width: 516 });
      }
      if (q.terms) {
        doc.moveDown(0.8).font("Helvetica-Bold").fontSize(10).fillColor("#0F1F1B").text("Terms", 48);
        doc.font("Helvetica").fontSize(10).fillColor("#444").text(q.terms, 48, doc.y, { width: 516 });
      }

      doc.end();
    });

    const key = `ws-${ctx.workspace.id}/quotes/${q.quoteNumber}.pdf`;
    const put = await storagePut(key, buf, "application/pdf");
    await db.update(quotes).set({ pdfFileKey: put.key, pdfUrl: put.url }).where(eq(quotes.id, q.id));
    return { url: put.url };
  }),

  send: workspaceProcedure.input(z.object({ id: z.number() })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    await db.update(quotes).set({ status: "sent", sentAt: new Date() }).where(and(eq(quotes.id, input.id), eq(quotes.workspaceId, ctx.workspace.id)));
    return { ok: true };
  }),

  setStatus: workspaceProcedure.input(z.object({ id: z.number(), status: z.enum(["draft", "sent", "accepted", "rejected", "expired"]) })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    await db.update(quotes).set({ status: input.status }).where(and(eq(quotes.id, input.id), eq(quotes.workspaceId, ctx.workspace.id)));
    return { ok: true };
  }),

  delete: workspaceProcedure.input(z.object({ id: z.number() })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    await db.delete(quoteLineItems).where(eq(quoteLineItems.quoteId, input.id));
    await db.delete(quotes).where(and(eq(quotes.id, input.id), eq(quotes.workspaceId, ctx.workspace.id)));
    return { ok: true };
  }),
});

/* ───── Audit / Notifications / SCIM ─────────────────────────────── */

export const auditRouter = router({
  list: adminWsProcedure.input(z.object({ entityType: z.string().optional(), limit: z.number().int().min(1).max(500).default(100) }).optional()).query(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) return [];
    let rows = await db.select().from(auditLog).where(eq(auditLog.workspaceId, ctx.workspace.id)).orderBy(desc(auditLog.createdAt)).limit(input?.limit ?? 100);
    if (input?.entityType) rows = rows.filter((r) => r.entityType === input.entityType);
    return rows;
  }),
});

export const notificationsRouter = router({
  list: workspaceProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) return [];
    return db.select().from(notifications).where(and(eq(notifications.workspaceId, ctx.workspace.id), eq(notifications.userId, ctx.user.id))).orderBy(desc(notifications.createdAt)).limit(50);
  }),

  unreadCount: workspaceProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) return 0;
    const [r] = await db.select({ c: sql<number>`count(*)` }).from(notifications).where(and(eq(notifications.workspaceId, ctx.workspace.id), eq(notifications.userId, ctx.user.id), sql`${notifications.readAt} IS NULL`));
    return Number(r?.c ?? 0);
  }),

  markRead: workspaceProcedure.input(z.object({ id: z.number() })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    await db.update(notifications).set({ readAt: new Date() }).where(and(eq(notifications.id, input.id), eq(notifications.workspaceId, ctx.workspace.id), eq(notifications.userId, ctx.user.id)));
    return { ok: true };
  }),

  markAllRead: workspaceProcedure.mutation(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    await db.update(notifications).set({ readAt: new Date() }).where(and(eq(notifications.workspaceId, ctx.workspace.id), eq(notifications.userId, ctx.user.id), sql`${notifications.readAt} IS NULL`));
    return { ok: true };
  }),
});

export const scimRouter = router({
  listProviders: adminWsProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) return [];
    return db.select().from(scimProviders).where(eq(scimProviders.workspaceId, ctx.workspace.id));
  }),

  createProvider: adminWsProcedure.input(z.object({ name: z.string().min(1) })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const token = "scim_" + Math.random().toString(36).slice(2, 16) + Math.random().toString(36).slice(2, 8);
    await db.insert(scimProviders).values({ ...input, workspaceId: ctx.workspace.id, bearerToken: token, enabled: true });
    return { ok: true, bearerToken: token };
  }),

  toggleProvider: adminWsProcedure.input(z.object({ id: z.number(), enabled: z.boolean() })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    await db.update(scimProviders).set({ enabled: input.enabled }).where(and(eq(scimProviders.id, input.id), eq(scimProviders.workspaceId, ctx.workspace.id)));
    return { ok: true };
  }),

  rotateToken: adminWsProcedure.input(z.object({ id: z.number() })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const token = "scim_" + Math.random().toString(36).slice(2, 16) + Math.random().toString(36).slice(2, 8);
    await db.update(scimProviders).set({ bearerToken: token }).where(and(eq(scimProviders.id, input.id), eq(scimProviders.workspaceId, ctx.workspace.id)));
    return { ok: true, bearerToken: token };
  }),

  events: adminWsProcedure.input(z.object({ providerId: z.number().optional() }).optional()).query(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) return [];
    let rows = await db.select().from(scimEvents).where(eq(scimEvents.workspaceId, ctx.workspace.id)).orderBy(desc(scimEvents.receivedAt)).limit(50);
    if (input?.providerId) rows = rows.filter((r) => r.providerId === input.providerId);
    return rows;
  }),

  deleteProvider: adminWsProcedure.input(z.object({ id: z.number() })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    await db.delete(scimProviders).where(and(eq(scimProviders.id, input.id), eq(scimProviders.workspaceId, ctx.workspace.id)));
    return { ok: true };
  }),
});
