import { TRPCError } from "@trpc/server";
import { and, desc, eq, sql } from "drizzle-orm";
import { calendarDayFrom } from "../services/calendarDeadline";
import { z } from "zod";
import { accounts, contractAmendments, customers, qbrs, supportTickets } from "../../drizzle/schema";
import { recordAudit } from "../audit";
import { getDb } from "../db";
import { invokeLLM } from "../_core/llm";
import { router } from "../_core/trpc";
import { adminWsProcedure, managerProcedure, repProcedure, workspaceProcedure } from "../_core/workspace";
import { renewalStageFor, type RenewalStage } from "@shared/renewalStage";
// The one score → tier reading (R58), shared with the pages that colour it.
import { calcHealth } from "@shared/customerHealth";
import { affectedRowsOf } from "../_core/claim";

/**
 * 2026-09-20: renewalStage is DERIVED from contractEnd on the way out, because
 * nothing ever moved the stored column — wonToCustomer stamped "early" on every
 * new customer and that is where it stayed, so a renewal nine days out rendered
 * in the "Early" column and renewing90 was structurally 0.
 *
 * Applied at every read in this router, not just the board: `cs` is in
 * ALLOWED_GROUPS (services/assistantActionCatalog.ts), so cs.list, cs.get,
 * cs.kpis and cs.renewalsBoard all run as AI-Assistant read actions. A stage
 * the board fixes but the assistant does not is a worse bug than one that is
 * wrong everywhere.
 */
function withStage<T extends { renewalStage: string; contractEnd: Date | null }>(c: T) {
  return { ...c, renewalStage: renewalStageFor({ current: c.renewalStage, contractEnd: c.contractEnd }) };
}

/**
 * When a QBR is (audit 2026-10-20, U27): with a length, an instant and its
 * length; without, a calendar day as before. A time with no instant in it
 * ("2026-11-20" plus a length) is refused rather than read as midnight UTC.
 */
export function qbrWhen(scheduledAt: string, durationMinutes?: number): { scheduledAt: Date; durationMinutes: number | null } {
  if (durationMinutes != null) {
    const d = new Date(scheduledAt);
    if (!/T\d{2}:\d{2}/.test(scheduledAt) || Number.isNaN(d.getTime())) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "A QBR with a length needs a date and a time." });
    }
    return { scheduledAt: d, durationMinutes };
  }
  const day = calendarDayFrom(scheduledAt);
  if (!day) throw new TRPCError({ code: "BAD_REQUEST", message: "Pick the QBR's day." });
  return { scheduledAt: day, durationMinutes: null };
}

export const csRouter = router({
  list: workspaceProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) return [];
    const cs = await db.select().from(customers).where(eq(customers.workspaceId, ctx.workspace.id)).orderBy(customers.healthScore);
    const accs = await db.select().from(accounts).where(eq(accounts.workspaceId, ctx.workspace.id));
    const accMap = new Map(accs.map((a) => [a.id, a]));
    return cs.map((c) => ({ ...withStage(c), account: accMap.get(c.accountId) ?? null }));
  }),

  get: workspaceProcedure.input(z.object({ id: z.number() })).query(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const [c] = await db.select().from(customers).where(and(eq(customers.id, input.id), eq(customers.workspaceId, ctx.workspace.id)));
    if (!c) return null;
    // Scoped (audit 2026-10-20, C8): a customer row made from a won deal on a
    // foreign accountId handed that other tenant's account to this page.
    const [a] = await db.select().from(accounts).where(and(eq(accounts.id, c.accountId), eq(accounts.workspaceId, ctx.workspace.id)));
    return { ...withStage(c), account: a ?? null };
  }),

  /** Aggregate KPIs: ARR, GRR, NRR (simplified), expansion potential, churn risk count. */
  kpis: workspaceProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) return null;
    const all = await db.select().from(customers).where(eq(customers.workspaceId, ctx.workspace.id));
    // A churned customer is not ARR, expansion or a risk any more (R58): their
    // contract counted in every figure here after it ended.
    const cs = all.filter((c) => withStage(c).renewalStage !== "churned");
    const arr = cs.reduce((s, c) => s + Number(c.arr ?? 0), 0);
    const expansion = cs.reduce((s, c) => s + Number(c.expansionPotential ?? 0), 0);
    const atRisk = cs.filter((c) => c.healthTier === "at_risk" || c.healthTier === "critical").length;
    // Counted off the DERIVED stage — the stored column never moved, so this
    // read 0 in every real workspace while contracts expired (2026-09-20).
    const renewing90 = cs.filter((c) => ["thirty", "sixty", "ninety", "at_risk"].includes(withStage(c).renewalStage)).length;
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
    return cs.map((c) => ({ ...withStage(c), account: accMap.get(c.accountId) ?? null }));
  }),

  /**
   * Set one or more health components. Each is optional (R58): the page sent
   * all three from the detail it had loaded, so moving Usage wrote back an
   * Engagement value another slider (or person) had just changed. What isn't
   * sent keeps its stored value.
   */
  updateHealthComponents: repProcedure
    .input(z.object({
      id: z.number(),
      usage: z.number().int().min(0).max(100).optional(),
      engagement: z.number().int().min(0).max(100).optional(),
      support: z.number().int().min(0).max(100).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const [c] = await db.select().from(customers).where(and(eq(customers.id, input.id), eq(customers.workspaceId, ctx.workspace.id)));
      if (!c) throw new TRPCError({ code: "NOT_FOUND" });
      const next = {
        usageScore: input.usage ?? c.usageScore,
        engagementScore: input.engagement ?? c.engagementScore,
        supportScore: input.support ?? c.supportScore,
      };
      const { score, tier } = calcHealth({ ...next, npsScore: c.npsScore });
      await db.update(customers).set({ ...next, healthScore: score, healthTier: tier }).where(and(eq(customers.id, input.id), eq(customers.workspaceId, ctx.workspace.id)));
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
    await db.update(customers).set({ npsScore: input.score, npsHistory: hist.slice(-12), healthScore: score, healthTier: tier }).where(and(eq(customers.id, input.id), eq(customers.workspaceId, ctx.workspace.id)));
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
    // Validate the customer belongs to THIS workspace before writing anything.
    // customerId is caller-controlled; without this check the amendment insert
    // and the ARR update below could target another tenant's customer.
    const [c] = await db.select().from(customers).where(and(eq(customers.id, input.customerId), eq(customers.workspaceId, ctx.workspace.id)));
    if (!c) throw new TRPCError({ code: "NOT_FOUND", message: "Customer not found" });
    await db.insert(contractAmendments).values({
      workspaceId: ctx.workspace.id,
      customerId: input.customerId,
      type: input.type,
      arrDelta: String(input.arrDelta),
      effectiveAt: calendarDayFrom(input.effectiveAt) ?? new Date(),
      notes: input.notes,
      createdByUserId: ctx.user.id,
    });
    // Apply ARR delta to customer (workspace-scoped)
    const newArr = Math.max(0, Number(c.arr) + input.arrDelta);
    /**
     * 2026-09-20: an amendment now moves the CONTRACT DATES too, which is the
     * only way `renewed` and `churned` are ever reached — every other stage is
     * derived from contractEnd, and nothing else in the product records an
     * outcome. Before this, a renewal amendment adjusted ARR and left the
     * contract ending on the same day it always had.
     *
     * The new term is the customer's OWN term (contractEnd − contractStart),
     * not a hardcoded 365 days: contract_amendments has no term field, but the
     * two date columns already encode it, and rolling a two-year customer
     * forward by a year would silently convert them to annual.
     *
     * The stage is DERIVED from the new end date rather than set to "early":
     * input.effectiveAt is caller-supplied and routinely back-dated (seed.ts
     * writes amendments 30-200 days in the past), so the rolled contractEnd can
     * legitimately land inside 90 days or still in the past.
     */
    const eff = calendarDayFrom(input.effectiveAt) ?? new Date();
    const termMs = c.contractStart && c.contractEnd ? c.contractEnd.getTime() - c.contractStart.getTime() : 365 * 86400000;
    const patch: { arr: string; contractStart?: Date; contractEnd?: Date; renewalStage?: RenewalStage } = { arr: String(newArr) };
    if (input.type === "renewal") {
      const newStart = c.contractEnd ?? eff;
      const newEnd = new Date(newStart.getTime() + termMs);
      patch.contractStart = newStart;
      patch.contractEnd = newEnd;
      patch.renewalStage = renewalStageFor({ current: "early", contractEnd: newEnd });
    } else if (input.type === "termination") {
      patch.contractEnd = eff;
      patch.renewalStage = "churned";
    }
    await db.update(customers).set(patch).where(and(eq(customers.id, c.id), eq(customers.workspaceId, ctx.workspace.id)));
    await recordAudit({
      workspaceId: ctx.workspace.id,
      actorUserId: ctx.user.id,
      action: "create",
      entityType: "contract_amendment",
      entityId: c.id,
      before: { arr: c.arr, contractStart: c.contractStart, contractEnd: c.contractEnd, renewalStage: c.renewalStage },
      after: { ...input, arr: patch.arr, contractStart: patch.contractStart, contractEnd: patch.contractEnd, renewalStage: patch.renewalStage },
    });
    return { ok: true };
  }),

  /* ── QBRs ── */
  listQbrs: workspaceProcedure.input(z.object({ customerId: z.number().optional() }).optional()).query(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) return [];
    // One customer's in SQL, not every QBR filtered here.
    return db.select().from(qbrs)
      .where(and(eq(qbrs.workspaceId, ctx.workspace.id), input?.customerId ? eq(qbrs.customerId, input.customerId) : undefined))
      .orderBy(desc(qbrs.scheduledAt));
  }),

  /**
   * A day ("YYYY-MM-DD"), or a time with a length (audit 2026-10-20, U27): a
   * QBR could only be put on a day, with no time and so no calendar invite.
   * With `durationMinutes`, `scheduledAt` must be an instant.
   */
  scheduleQbr: repProcedure.input(z.object({
    customerId: z.number(),
    scheduledAt: z.string(),
    durationMinutes: z.number().int().min(15).max(480).optional(),
  })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    // The customer must be this workspace's (audit 2026-10-20, C8): the QBR
    // used to store any customerId, and generateQbrPrep then read that
    // customer — health, ARR, NPS and the account name — across tenants.
    const [c] = await db.select({ id: customers.id }).from(customers)
      .where(and(eq(customers.id, input.customerId), eq(customers.workspaceId, ctx.workspace.id)));
    if (!c) throw new TRPCError({ code: "NOT_FOUND", message: "Customer not found" });
    const when = qbrWhen(input.scheduledAt, input.durationMinutes);
    const r = await db.insert(qbrs).values({ workspaceId: ctx.workspace.id, customerId: input.customerId, ...when, status: "scheduled" });
    return { id: Number((r as any)[0]?.insertId ?? 0) };
  }),

  /** Move a scheduled QBR to another day or time (U27), e.g. an overdue one. */
  rescheduleQbr: repProcedure.input(z.object({
    id: z.number().int().positive(),
    scheduledAt: z.string(),
    durationMinutes: z.number().int().min(15).max(480).nullable().optional(),
  })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const [q] = await db.select({ id: qbrs.id, status: qbrs.status }).from(qbrs)
      .where(and(eq(qbrs.id, input.id), eq(qbrs.workspaceId, ctx.workspace.id)));
    if (!q) throw new TRPCError({ code: "NOT_FOUND" });
    if (q.status !== "scheduled") throw new TRPCError({ code: "BAD_REQUEST", message: "Only a scheduled QBR can be moved." });
    const when = qbrWhen(input.scheduledAt, input.durationMinutes ?? undefined);
    await db.update(qbrs).set(when).where(and(eq(qbrs.id, input.id), eq(qbrs.workspaceId, ctx.workspace.id)));
    return { ok: true };
  }),

  generateQbrPrep: repProcedure.input(z.object({ qbrId: z.number() })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const [q] = await db.select().from(qbrs).where(and(eq(qbrs.id, input.qbrId), eq(qbrs.workspaceId, ctx.workspace.id)));
    if (!q) throw new TRPCError({ code: "NOT_FOUND" });
    // Both reads scoped (C8), so a QBR stored before scheduleQbr checked its
    // customer still cannot read another tenant's.
    const [c] = await db.select().from(customers).where(and(eq(customers.id, q.customerId), eq(customers.workspaceId, ctx.workspace.id)));
    if (!c) throw new TRPCError({ code: "NOT_FOUND", message: "Customer not found" });
    const [a] = await db.select().from(accounts).where(and(eq(accounts.id, c.accountId), eq(accounts.workspaceId, ctx.workspace.id)));
    // No canned fallback (audit 2026-10-20, R74): when the model failed, this
    // saved "Adoption climbing" / "Champion stability" as the customer's AI
    // prep and the page announced "AI prep generated". Made-up wins about a
    // real customer are worse than none, so a failure saves nothing and says so.
    let prep: { wins: string[]; risks: string[]; asks: string[]; agenda: string[] } | null = null;
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
      const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "") : []);
      if (parsed && typeof parsed === "object") {
        prep = { wins: list(parsed.wins), risks: list(parsed.risks), asks: list(parsed.asks), agenda: list(parsed.agenda) };
      }
    } catch (e) {
      console.warn("[generateQbrPrep] LLM failed; nothing saved", e);
    }
    if (!prep) {
      throw new TRPCError({ code: "SERVICE_UNAVAILABLE", message: "The AI couldn't write this prep right now, so nothing was saved. Try again in a minute." });
    }
    await db.update(qbrs).set({ aiPrep: prep }).where(and(eq(qbrs.id, q.id), eq(qbrs.workspaceId, ctx.workspace.id)));
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

  /**
   * Delete a single customer record (the CS overlay) along with its QBRs,
   * support tickets, and contract amendments. The underlying accounts row
   * stays intact — only the customer-success overlay is removed.
   */
  // A manager's, and on the record: any rep could delete a customer with its QBRs,
  // tickets and amendments, and nothing said who (audit 2026-10-20, R11).
  delete: managerProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const [before] = await db.select().from(customers)
        .where(and(eq(customers.id, input.id), eq(customers.workspaceId, ctx.workspace.id)));
      if (!before) throw new TRPCError({ code: "NOT_FOUND", message: "Customer not found" });
      // Cascade delete child rows first so FK constraints don't trip.
      await db
        .delete(qbrs)
        .where(and(eq(qbrs.customerId, input.id), eq(qbrs.workspaceId, ctx.workspace.id)));
      await db
        .delete(supportTickets)
        .where(and(eq(supportTickets.customerId, input.id), eq(supportTickets.workspaceId, ctx.workspace.id)));
      await db
        .delete(contractAmendments)
        .where(and(eq(contractAmendments.customerId, input.id), eq(contractAmendments.workspaceId, ctx.workspace.id)));
      await db
        .delete(customers)
        .where(and(eq(customers.id, input.id), eq(customers.workspaceId, ctx.workspace.id)));
      await recordAudit({
        workspaceId: ctx.workspace.id,
        actorUserId: ctx.user.id,
        action: "delete",
        entityType: "customer",
        entityId: input.id,
        before,
      });
      return { ok: true };
    }),

  /**
   * Reset all customer-success data for the workspace — purges every
   * customer, QBR, support ticket, and contract amendment. The underlying
   * accounts (and contacts / opportunities) are untouched.
   */
  clearAll: adminWsProcedure.mutation(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const wsId = ctx.workspace.id;
    const existing = await db.select({ id: customers.id }).from(customers).where(eq(customers.workspaceId, wsId));
    await db.delete(qbrs).where(eq(qbrs.workspaceId, wsId));
    await db.delete(supportTickets).where(eq(supportTickets.workspaceId, wsId));
    await db.delete(contractAmendments).where(eq(contractAmendments.workspaceId, wsId));
    const res = await db.delete(customers).where(eq(customers.workspaceId, wsId));
    const deleted = affectedRowsOf(res);
    await recordAudit({
      workspaceId: wsId,
      actorUserId: ctx.user.id,
      action: "delete",
      entityType: "customer_success",
      before: { customers: existing.length },
    });
    return { ok: true, deletedCustomers: deleted };
  }),
});
