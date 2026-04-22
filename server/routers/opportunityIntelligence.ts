/**
 * Sprint 6 — Opportunity Intelligence cluster
 * Procedures:
 *   - getIntelligence(opportunityId)        — latest AI snapshot
 *   - generateIntelligence(opportunityId)   — run AI analysis (win prob, NBA, signals, email score, alt subjects, win story)
 *   - getStageHistory(opportunityId)        — ordered stage movement log
 *   - requestStageChange(opportunityId, toStage, note)  — rep submits approval request
 *   - reviewStageChange(approvalId, approved, reviewNote) — manager approves/rejects
 *   - listPendingApprovals()                — manager view of pending requests
 *   - getCoOwners(opportunityId)            — list co-owners
 *   - addCoOwner(opportunityId, userId)     — add co-owner
 *   - removeCoOwner(opportunityId, userId)  — remove co-owner
 */
import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq } from "drizzle-orm";
import { z } from "zod";
import {
  accounts,
  activities,
  contacts,
  opportunities,
  opportunityContactRoles,
  opportunityIntelligence,
  opportunityStageHistory,
  stageApprovals,
  workspaceMembers,
} from "../../drizzle/schema";
import { getDb } from "../db";
import { invokeLLM } from "../_core/llm";
import { router } from "../_core/trpc";
import { managerProcedure, repProcedure, workspaceProcedure } from "../_core/workspace";

/* ─── helpers ────────────────────────────────────────────────────────────── */

async function getOppContext(db: any, workspaceId: number, opportunityId: number) {
  const [opp] = await db
    .select()
    .from(opportunities)
    .where(and(eq(opportunities.id, opportunityId), eq(opportunities.workspaceId, workspaceId)));
  if (!opp) throw new TRPCError({ code: "NOT_FOUND", message: "Opportunity not found" });

  const [account] = opp.accountId
    ? await db.select().from(accounts).where(eq(accounts.id, opp.accountId))
    : [null];

  const roles = await db
    .select()
    .from(opportunityContactRoles)
    .where(eq(opportunityContactRoles.opportunityId, opportunityId));

  const contactIds = roles.map((r: any) => r.contactId);
  const contactRows = contactIds.length
    ? await db.select().from(contacts).where(and(eq(contacts.workspaceId, workspaceId)))
    : [];
  const oppContacts = contactRows.filter((c: any) => contactIds.includes(c.id));

  const recentActivities = await db
    .select()
    .from(activities)
    .where(and(eq(activities.workspaceId, workspaceId), eq(activities.relatedType, "opportunity"), eq(activities.relatedId, opportunityId)))
    .orderBy(desc(activities.occurredAt))
    .limit(10);

  return { opp, account, contacts: oppContacts, recentActivities };
}

/* ─── router ─────────────────────────────────────────────────────────────── */

export const opportunityIntelligenceRouter = router({
  /** Get the latest intelligence snapshot for an opportunity */
  getIntelligence: workspaceProcedure
    .input(z.object({ opportunityId: z.number() }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) return null;
      const rows = await db
        .select()
        .from(opportunityIntelligence)
        .where(and(eq(opportunityIntelligence.opportunityId, input.opportunityId), eq(opportunityIntelligence.workspaceId, ctx.workspace.id)))
        .orderBy(desc(opportunityIntelligence.generatedAt))
        .limit(1);
      return rows[0] ?? null;
    }),

  /** Run AI analysis and persist a new intelligence snapshot */
  generateIntelligence: repProcedure
    .input(z.object({ opportunityId: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      const { opp, account, contacts: oppContacts, recentActivities } = await getOppContext(db, ctx.workspace.id, input.opportunityId);

      const contextSummary = [
        `Opportunity: ${opp.name}`,
        `Stage: ${opp.stage}`,
        `Value: $${opp.value}`,
        `Close date: ${opp.closeDate ? new Date(opp.closeDate).toDateString() : "not set"}`,
        `Days in stage: ${opp.daysInStage}`,
        account ? `Account: ${account.name} (${account.industry ?? "unknown industry"}, ${account.employeeBand ?? "unknown size"})` : "",
        `Contacts: ${oppContacts.map((c: any) => `${c.firstName} ${c.lastName} (${c.title ?? "unknown"})`).join(", ") || "none"}`,
        `Recent activities: ${recentActivities.map((a: any) => `${a.type}: ${a.subject ?? a.body?.slice(0, 60) ?? ""}`).join("; ") || "none"}`,
        opp.nextStep ? `Next step: ${opp.nextStep}` : "",
        opp.aiNote ? `AI note: ${opp.aiNote}` : "",
      ].filter(Boolean).join("\n");

      let result: any = {};
      try {
        const out = await invokeLLM({
          messages: [
            {
              role: "system",
              content: `You are a B2B sales intelligence AI. Analyze the opportunity context and return a structured JSON assessment. Be specific and actionable.`,
            },
            {
              role: "user",
              content: contextSummary,
            },
          ],
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "opportunity_intelligence",
              strict: true,
              schema: {
                type: "object",
                properties: {
                  winProbability: { type: "number", description: "0-100 win probability" },
                  winProbabilityRationale: { type: "string" },
                  nextBestActions: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        action: { type: "string" },
                        priority: { type: "string", enum: ["high", "medium", "low"] },
                        rationale: { type: "string" },
                      },
                      required: ["action", "priority", "rationale"],
                      additionalProperties: false,
                    },
                  },
                  conversationSignals: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        signal: { type: "string" },
                        sentiment: { type: "string", enum: ["positive", "neutral", "negative"] },
                      },
                      required: ["signal", "sentiment"],
                      additionalProperties: false,
                    },
                  },
                  actionItems: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        item: { type: "string" },
                        owner: { type: "string" },
                        dueDate: { type: "string" },
                      },
                      required: ["item", "owner", "dueDate"],
                      additionalProperties: false,
                    },
                  },
                  emailEffectivenessScore: { type: "number", description: "0-100" },
                  altSubjectLines: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        subject: { type: "string" },
                        rationale: { type: "string" },
                      },
                      required: ["subject", "rationale"],
                      additionalProperties: false,
                    },
                  },
                  winStory: { type: "string", description: "Short narrative of how this deal could be won" },
                },
                required: ["winProbability", "winProbabilityRationale", "nextBestActions", "conversationSignals", "actionItems", "emailEffectivenessScore", "altSubjectLines", "winStory"],
                additionalProperties: false,
              },
            },
          },
        });
        const content = out.choices?.[0]?.message?.content;
        result = typeof content === "string" ? JSON.parse(content) : content;
      } catch {
        result = {
          winProbability: opp.winProb,
          winProbabilityRationale: "AI analysis unavailable — using existing win probability",
          nextBestActions: [],
          conversationSignals: [],
          actionItems: [],
          emailEffectivenessScore: 50,
          altSubjectLines: [],
          winStory: "",
        };
      }

      const [inserted] = await db.insert(opportunityIntelligence).values({
        workspaceId: ctx.workspace.id,
        opportunityId: input.opportunityId,
        winProbability: String(Math.round(result.winProbability ?? opp.winProb)),
        winProbabilityRationale: result.winProbabilityRationale ?? "",
        nextBestActions: result.nextBestActions ?? [],
        conversationSignals: result.conversationSignals ?? [],
        actionItems: result.actionItems ?? [],
        emailEffectivenessScore: String(Math.round(result.emailEffectivenessScore ?? 50)),
        altSubjectLines: result.altSubjectLines ?? [],
        winStory: result.winStory ?? "",
        outreachSequenceSuggestion: null,
      });

      // Update opportunity winProb
      await db
        .update(opportunities)
        .set({ winProb: Math.round(result.winProbability ?? opp.winProb) })
        .where(eq(opportunities.id, input.opportunityId));

      return result;
    }),

  /** Get stage history for an opportunity */
  getStageHistory: workspaceProcedure
    .input(z.object({ opportunityId: z.number() }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) return [];
      return db
        .select()
        .from(opportunityStageHistory)
        .where(and(eq(opportunityStageHistory.opportunityId, input.opportunityId), eq(opportunityStageHistory.workspaceId, ctx.workspace.id)))
        .orderBy(asc(opportunityStageHistory.createdAt));
    }),

  /** Rep requests a stage change (requires manager approval) */
  requestStageChange: repProcedure
    .input(z.object({ opportunityId: z.number(), toStage: z.string(), note: z.string().optional() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      const [opp] = await db
        .select()
        .from(opportunities)
        .where(and(eq(opportunities.id, input.opportunityId), eq(opportunities.workspaceId, ctx.workspace.id)));
      if (!opp) throw new TRPCError({ code: "NOT_FOUND" });

      if (opp.stage === input.toStage) throw new TRPCError({ code: "BAD_REQUEST", message: "Opportunity is already in that stage" });

      await db.insert(stageApprovals).values({
        workspaceId: ctx.workspace.id,
        opportunityId: input.opportunityId,
        requestedByUserId: ctx.user.id,
        fromStage: opp.stage,
        toStage: input.toStage,
        note: input.note ?? null,
      });

      return { ok: true };
    }),

  /** Manager approves or rejects a stage-change request */
  reviewStageChange: managerProcedure
    .input(z.object({ approvalId: z.number(), approved: z.boolean(), reviewNote: z.string().optional() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      const [approval] = await db
        .select()
        .from(stageApprovals)
        .where(and(eq(stageApprovals.id, input.approvalId), eq(stageApprovals.workspaceId, ctx.workspace.id)));
      if (!approval) throw new TRPCError({ code: "NOT_FOUND" });
      if (approval.status !== "pending") throw new TRPCError({ code: "BAD_REQUEST", message: "Approval already reviewed" });

      await db
        .update(stageApprovals)
        .set({ status: input.approved ? "approved" : "rejected", approverUserId: ctx.user.id, reviewNote: input.reviewNote ?? null })
        .where(eq(stageApprovals.id, input.approvalId));

      if (input.approved) {
        // Apply stage change
        await db
          .update(opportunities)
          .set({ stage: approval.toStage as any, daysInStage: 0 })
          .where(eq(opportunities.id, approval.opportunityId));

        // Write stage history
        await db.insert(opportunityStageHistory).values({
          workspaceId: ctx.workspace.id,
          opportunityId: approval.opportunityId,
          fromStage: approval.fromStage,
          toStage: approval.toStage,
          changedByUserId: ctx.user.id,
          note: `Approved by manager. ${input.reviewNote ?? ""}`.trim(),
        });
      }

      return { ok: true };
    }),

  /** List pending stage-change approvals for this workspace (manager+) */
  listPendingApprovals: managerProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) return [];
    return db
      .select()
      .from(stageApprovals)
      .where(and(eq(stageApprovals.workspaceId, ctx.workspace.id), eq(stageApprovals.status, "pending")))
      .orderBy(desc(stageApprovals.createdAt));
  }),

  /** List co-owners for an opportunity (stored in opportunityContactRoles with role='user' and isPrimary=false — we repurpose a join table) */
  // We use a simpler approach: co-owners are workspace members stored in a JSON field on the opportunity
  // For now we expose a lightweight procedure that reads/writes coOwners JSON on the opportunity
  getCoOwners: workspaceProcedure
    .input(z.object({ opportunityId: z.number() }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) return [];
      const [opp] = await db
        .select()
        .from(opportunities)
        .where(and(eq(opportunities.id, input.opportunityId), eq(opportunities.workspaceId, ctx.workspace.id)));
      if (!opp) return [];
      const coOwnerIds: number[] = (opp.customFields as any)?.coOwners ?? [];
      if (!coOwnerIds.length) return [];
      const members = await db
        .select()
        .from(workspaceMembers)
        .where(eq(workspaceMembers.workspaceId, ctx.workspace.id));
      return members.filter((m) => coOwnerIds.includes(m.userId));
    }),

  addCoOwner: repProcedure
    .input(z.object({ opportunityId: z.number(), userId: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const [opp] = await db
        .select()
        .from(opportunities)
        .where(and(eq(opportunities.id, input.opportunityId), eq(opportunities.workspaceId, ctx.workspace.id)));
      if (!opp) throw new TRPCError({ code: "NOT_FOUND" });
      const existing: Record<string, any> = (opp.customFields as any) ?? {};
      const coOwners: number[] = existing.coOwners ?? [];
      if (!coOwners.includes(input.userId)) coOwners.push(input.userId);
      await db.update(opportunities).set({ customFields: { ...existing, coOwners } }).where(eq(opportunities.id, input.opportunityId));
      return { ok: true };
    }),

  removeCoOwner: repProcedure
    .input(z.object({ opportunityId: z.number(), userId: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const [opp] = await db
        .select()
        .from(opportunities)
        .where(and(eq(opportunities.id, input.opportunityId), eq(opportunities.workspaceId, ctx.workspace.id)));
      if (!opp) throw new TRPCError({ code: "NOT_FOUND" });
      const existing: Record<string, any> = (opp.customFields as any) ?? {};
      const coOwners: number[] = (existing.coOwners ?? []).filter((id: number) => id !== input.userId);
      await db.update(opportunities).set({ customFields: { ...existing, coOwners } }).where(eq(opportunities.id, input.opportunityId));
      return { ok: true };
    }),
});
