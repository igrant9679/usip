import { TRPCError } from "@trpc/server";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { accounts, contractAmendments, customers, qbrs, supportTickets } from "../../drizzle/schema";
import { recordAudit } from "../audit";
import { getDb } from "../db";
import { invokeLLM } from "../_core/llm";
import { router } from "../_core/trpc";
import { repProcedure, workspaceProcedure } from "../_core/workspace";

function calcHealth(c: { usageScore: number; engagementScore: number; supportScore: number; npsScore: number }) {
  const npsNorm = (c.npsScore + 100) / 2; // 0..100
  const score = Math.round(c.usageScore * 0.35 + c.engagementScore * 0.25 + c.supportScore * 0.2 + npsNorm * 0.2);
  const tier: "healthy" | "watch" | "at_risk" | "critical" = score >= 75 ? "healthy" : score >= 55 ? "watch" : score >= 35 ? "at_risk" : "critical";
  return { score, tier };
}

export const csRouter = router({
  list: workspaceProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) return [];
    const cs = await db.select().from(customers).where(eq(customers.workspaceId, ctx.workspace.id)).orderBy(customers.healthScore);
    const accs = await db.select().from(accounts).where(eq(accounts.workspaceId, ctx.workspace.id));
    const accMap = new Map(accs.map((a) => [a.id, a]));
    return cs.map((c) => ({ ...c, account: accMap.get(c.accountId) ?? null }));
  }),

  get: workspaceProcedure.input(z.object({ id: z.number() })).query(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const [c] = await db.select().from(customers).where(and(eq(customers.id, input.id), eq(customers.workspaceId, ctx.workspace.id)));
    if (!c) return null;
    const [a] = await db.select().from(accounts).where(eq(accounts.id, c.accountId));
    return { ...c, account: a ?? null };
  }),

  /** Aggregate KPIs: ARR, GRR, NRR (simplified), expansion potential, churn risk count. */
  kpis: workspaceProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) return null;
    const cs = await db.select().from(customers).where(eq(customers.workspaceId, ctx.workspace.id));
    const arr = cs.reduce((s, c) => s + Number(c.arr ?? 0), 0);
    const expansion = cs.reduce((s, c) => s + Number(c.expansionPotential ?? 0), 0);
    const atRisk = cs.filter((c) => c.healthTier === "at_risk" || c.healthTier === "critical").length;
    const renewing90 = cs.filter((c) => ["thirty", "sixty", "ninety", "at_risk"].includes(c.renewalStage)).length;
    const avgNps = cs.length === 0 ? 0 : Math.round(cs.reduce((s, c) => s + c.npsScore, 0) / cs.length);
    const promoters = cs.filter((c) => c.npsScore >= 50).length;
    const detractors = cs.filter((c) => c.npsScore <= 0).length;
    const npsBand = cs.length === 0 ? 0 : Math.round(((promoters - detractors) / cs.length) * 100);
    return { arr, expansion, atRisk, renewing90, avgNps, npsBand, total: cs.length };
  }),

  /** Renewals kanban grouped by renewalStage. */
  renewalsBoard: workspaceProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) return [];
    const cs = await db.select().from(customers).where(eq(customers.workspaceId, ctx.workspace.id));
    const accs = await db.select().from(accounts).where(eq(accounts.workspaceId, ctx.workspace.id));
    const accMap = new Map(accs.map((a) => [a.id, a]));
    return cs.map((c) => ({ ...c, account: accMap.get(c.accountId) ?? null }));
  }),

  updateHealthComponents: repProcedure
    .input(z.object({ id: z.number(), usage: z.number().int().min(0).max(100), engagement: z.number().int().min(0).max(100), support: z.number().int().min(0).max(100) }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const [c] = await db.select().from(customers).where(and(eq(customers.id, input.id), eq(customers.workspaceId, ctx.workspace.id)));
      if (!c) throw new TRPCError({ code: "NOT_FOUND" });
      const { score, tier } = calcHealth({ usageScore: input.usage, engagementScore: input.engagement, supportScore: input.support, npsScore: c.npsScore });
      await db.update(customers).set({ usageScore: input.usage, engagementScore: input.engagement, supportScore: input.support, healthScore: score, healthTier: tier }).where(eq(customers.id, input.id));
      return { score, tier };
    }),

  submitNps: repProcedure.input(z.object({ id: z.number(), score: z.number().int().min(-100).max(100) })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const [c] = await db.select().from(customers).where(and(eq(customers.id, input.id), eq(customers.workspaceId, ctx.workspace.id)));
    if (!c) throw new TRPCError({ code: "NOT_FOUND" });
    const hist: Array<{ month: number; score: number }> = Array.isArray(c.npsHistory) ? (c.npsHistory as any) : [];
    hist.push({ month: hist.length, score: input.score });
    const { score, tier } = calcHealth({ usageScore: c.usageScore, engagementScore: c.engagementScore, supportScore: c.supportScore, npsScore: input.score });
    await db.update(customers).set({ npsScore: input.score, npsHistory: hist.slice(-12), healthScore: score, healthTier: tier }).where(eq(customers.id, input.id));
    return { score, tier };
  }),

  /* ── Amendments ── */
  listAmendments: workspaceProcedure.input(z.object({ customerId: z.number() })).query(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) return [];
    return db.select().from(contractAmendments).where(and(eq(contractAmendments.customerId, input.customerId), eq(contractAmendments.workspaceId, ctx.workspace.id))).orderBy(desc(contractAmendments.effectiveAt));
  }),

  addAmendment: repProcedure.input(z.object({
    customerId: z.number(),
    type: z.enum(["upgrade", "downgrade", "addon", "renewal", "termination", "price_change"]),
    arrDelta: z.number(),
    effectiveAt: z.string(),
    notes: z.string().optional(),
  })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    await db.insert(contractAmendments).values({
      workspaceId: ctx.workspace.id,
      customerId: input.customerId,
      type: input.type,
      arrDelta: String(input.arrDelta),
      effectiveAt: new Date(input.effectiveAt),
      notes: input.notes,
      createdByUserId: ctx.user.id,
    });
    // Apply ARR delta to customer
    const [c] = await db.select().from(customers).where(eq(customers.id, input.customerId));
    if (c) {
      const newArr = Math.max(0, Number(c.arr) + input.arrDelta);
      await db.update(customers).set({ arr: String(newArr) }).where(eq(customers.id, c.id));
    }
    await recordAudit({ workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "create", entityType: "contract_amendment", after: input });
    return { ok: true };
  }),

  /* ── QBRs ── */
  listQbrs: workspaceProcedure.input(z.object({ customerId: z.number().optional() }).optional()).query(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) return [];
    let rows = await db.select().from(qbrs).where(eq(qbrs.workspaceId, ctx.workspace.id)).orderBy(desc(qbrs.scheduledAt));
    if (input?.customerId) rows = rows.filter((r) => r.customerId === input.customerId);
    return rows;
  }),

  scheduleQbr: repProcedure.input(z.object({ customerId: z.number(), scheduledAt: z.string() })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const r = await db.insert(qbrs).values({ workspaceId: ctx.workspace.id, customerId: input.customerId, scheduledAt: new Date(input.scheduledAt), status: "scheduled" });
    return { id: Number((r as any)[0]?.insertId ?? 0) };
  }),

  generateQbrPrep: repProcedure.input(z.object({ qbrId: z.number() })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const [q] = await db.select().from(qbrs).where(and(eq(qbrs.id, input.qbrId), eq(qbrs.workspaceId, ctx.workspace.id)));
    if (!q) throw new TRPCError({ code: "NOT_FOUND" });
    const [c] = await db.select().from(customers).where(eq(customers.id, q.customerId));
    const [a] = await db.select().from(accounts).where(eq(accounts.id, c?.accountId ?? 0));
    let prep: any = { wins: ["Adoption climbing"], risks: ["Champion stability"], asks: ["Identify expansion team"], agenda: ["Review usage", "Roadmap", "Asks"] };
    try {
      const out = await invokeLLM({
        messages: [
          { role: "system", content: "You prepare quarterly business review briefs. Output JSON only." },
          { role: "user", content: `Customer: ${a?.name}\nARR: $${c?.arr}\nHealth: ${c?.healthTier} (score ${c?.healthScore})\nNPS: ${c?.npsScore}\nUsage: ${c?.usageScore} Engagement: ${c?.engagementScore} Support: ${c?.supportScore}\n\nReturn JSON {wins:[string],risks:[string],asks:[string],agenda:[string]} — 3 items each.` },
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "qbr_prep",
            strict: true,
            schema: {
              type: "object",
              properties: {
                wins: { type: "array", items: { type: "string" } },
                risks: { type: "array", items: { type: "string" } },
                asks: { type: "array", items: { type: "string" } },
                agenda: { type: "array", items: { type: "string" } },
              },
              required: ["wins", "risks", "asks", "agenda"],
              additionalProperties: false,
            },
          },
        },
      });
      const content = out.choices?.[0]?.message?.content;
      const parsed = typeof content === "string" ? JSON.parse(content) : content;
      prep = parsed;
    } catch (e) {
      console.warn("[generateQbrPrep] LLM failed; using fallback", e);
    }
    await db.update(qbrs).set({ aiPrep: prep }).where(eq(qbrs.id, q.id));
    return { prep };
  }),

  completeQbr: repProcedure.input(z.object({ id: z.number(), notes: z.string().optional(), nextActions: z.array(z.string()).optional() })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    await db.update(qbrs).set({ status: "completed", completedAt: new Date(), notes: input.notes, nextActions: input.nextActions ?? [] }).where(and(eq(qbrs.id, input.id), eq(qbrs.workspaceId, ctx.workspace.id)));
    return { ok: true };
  }),

  /* ── Tickets ── */
  listTickets: workspaceProcedure.input(z.object({ customerId: z.number() })).query(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) return [];
    return db.select().from(supportTickets).where(and(eq(supportTickets.customerId, input.customerId), eq(supportTickets.workspaceId, ctx.workspace.id)));
  }),
});
