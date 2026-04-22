import { TRPCError } from "@trpc/server";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import {
  auditLog,
  campaignComponents,
  campaigns,
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
  workflowRules,
  workflowRuns,
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
    type: z.enum(["kpi", "bar", "line", "pie", "funnel", "table"]),
    title: z.string().min(1),
    config: z.record(z.string(), z.any()),
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
  resolveWidget: workspaceProcedure.input(z.object({ id: z.number() })).query(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) return null;
    const [w] = await db.select().from(dashboardWidgets).where(and(eq(dashboardWidgets.id, input.id), eq(dashboardWidgets.workspaceId, ctx.workspace.id)));
    if (!w) return null;
    return resolveWidgetData(ctx.workspace.id, w);
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

async function resolveWidgetData(workspaceId: number, w: { type: string; config: any; title: string }) {
  const db = await getDb();
  if (!db) return { type: w.type, title: w.title, value: null };
  const cfg = w.config ?? {};
  switch (cfg.metric) {
    case "pipeline_value": {
      const [r] = await db.select({ s: sql<string>`COALESCE(SUM(${opportunities.value}),0)` }).from(opportunities).where(and(eq(opportunities.workspaceId, workspaceId), sql`${opportunities.stage} NOT IN ('won','lost')`));
      return { type: w.type, title: w.title, value: Number(r?.s ?? 0), format: "currency" };
    }
    case "closed_won_qtr": {
      const [r] = await db.select({ s: sql<string>`COALESCE(SUM(${opportunities.value}),0)` }).from(opportunities).where(and(eq(opportunities.workspaceId, workspaceId), eq(opportunities.stage, "won")));
      return { type: w.type, title: w.title, value: Number(r?.s ?? 0), format: "currency" };
    }
    case "win_rate": {
      const all = await db.select().from(opportunities).where(eq(opportunities.workspaceId, workspaceId));
      const closed = all.filter((o) => o.stage === "won" || o.stage === "lost");
      const wr = closed.length === 0 ? 0 : (closed.filter((o) => o.stage === "won").length / closed.length) * 100;
      return { type: w.type, title: w.title, value: Math.round(wr), format: "percent" };
    }
    case "avg_deal": {
      const won = await db.select().from(opportunities).where(and(eq(opportunities.workspaceId, workspaceId), eq(opportunities.stage, "won")));
      const avg = won.length === 0 ? 0 : won.reduce((s, o) => s + Number(o.value), 0) / won.length;
      return { type: w.type, title: w.title, value: Math.round(avg), format: "currency" };
    }
  }
  if (w.type === "funnel") {
    const all = await db.select().from(opportunities).where(eq(opportunities.workspaceId, workspaceId));
    const stages = ["discovery", "qualified", "proposal", "negotiation", "won"];
    return { type: "funnel", title: w.title, series: stages.map((s) => ({ stage: s, count: all.filter((o) => o.stage === s).length, value: all.filter((o) => o.stage === s).reduce((sum, o) => sum + Number(o.value), 0) })) };
  }
  if (w.type === "bar" && cfg.metric === "closed_won") {
    const won = await db.select().from(opportunities).where(and(eq(opportunities.workspaceId, workspaceId), eq(opportunities.stage, "won")));
    const months = Array.from({ length: 6 }, (_, i) => {
      const d = new Date(); d.setMonth(d.getMonth() - (5 - i));
      return { label: d.toLocaleString("default", { month: "short" }), key: `${d.getFullYear()}-${d.getMonth()}` };
    });
    const out = months.map((m) => ({ label: m.label, value: 0 }));
    for (const o of won) {
      if (!o.closeDate) continue;
      const k = `${o.closeDate.getFullYear()}-${o.closeDate.getMonth()}`;
      const idx = months.findIndex((m) => m.key === k);
      if (idx >= 0) out[idx]!.value += Number(o.value);
    }
    return { type: "bar", title: w.title, series: out };
  }
  if (w.type === "table") {
    if (cfg.entity === "accounts") {
      const accs = await db.select().from(opportunities).where(eq(opportunities.workspaceId, workspaceId));
      const map = new Map<number, number>();
      for (const o of accs) map.set(o.accountId, (map.get(o.accountId) ?? 0) + Number(o.value));
      const top = Array.from(map.entries()).sort((a, b) => b[1] - a[1]).slice(0, cfg.limit ?? 5);
      return { type: "table", title: w.title, rows: top.map(([id, v]) => ({ id, value: v })) };
    }
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
