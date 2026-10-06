/**
 * aiCalls.ts — the approval queue for outbound AI phone calls.
 *
 * Owner ask 2026-10-04: "It needs to be able to make outgoing calls, but
 * these need to be gated and not autonomous. They'll need to be approved,
 * in batches and/or 1 by 1. This needs to book meetings."
 *
 *   queue    — anyone queues people from People: one draft per person, with
 *              the number, the agent, and notes the agent will be told.
 *   approve  — a manager or above approves one or many drafts, confirming
 *              the people consented to AI calls (recorded: who, when).
 *   dialer   — services/aiCallDialer.ts places APPROVED calls only, inside
 *              each person's calling hours, never while outbound is paused.
 *
 * Nothing here dials. A draft is inert until a person approves it.
 */
import { TRPCError } from "@trpc/server";
import { and, desc, eq, gte, inArray, isNotNull, sql } from "drizzle-orm";
import { z } from "zod";
import {
  callSuppressions,
  prospects,
  users,
  voiceAgents,
  voiceCallRequests,
  voiceCalls,
  workspaces,
} from "../../drizzle/schema";
import { getDb } from "../db";
import { router } from "../_core/trpc";
import { adminWsProcedure, managerProcedure, workspaceProcedure } from "../_core/workspace";
import { rankOf, ROLE_RANK } from "@shared/roleRank";
import { callableNumber, timezoneForRegion } from "@shared/callingHours";
import { recordAudit } from "../audit";
import { configuredProposalOwner } from "../services/meetingScheduler";
import { getWorkspaceTimezone } from "../services/workspaceTimezone";
import { cleanNotes } from "../services/voiceCallScript";
import { placeCall, plivoCreds, plivoUrls } from "../services/plivo";
import { admitInboundCall } from "../services/voiceGuards";
import { OUTBOUND_TIME_LIMIT_SEC } from "../services/aiCallDialer";

/** Test calls per workspace in any 24 hours. */
export const MAX_TEST_CALLS_PER_DAY = 10;

async function requireDb() {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
  return db;
}

/** A person with one of these is already on the way to being called. */
const OPEN = ["draft", "approved", "dialing"] as const;

export type SkipReason = "no_callable_number" | "do_not_call" | "already_queued" | "not_found";

export const aiCallsRouter = router({
  list: workspaceProcedure
    .input(z.object({ status: z.enum(["open", "draft", "approved", "dialing", "done", "rejected", "skipped", "all"]).default("open") }).optional())
    .query(async ({ ctx, input }) => {
      const db = await requireDb();
      const status = input?.status ?? "open";
      const where =
        status === "all"
          ? eq(voiceCallRequests.workspaceId, ctx.workspace.id)
          : and(
              eq(voiceCallRequests.workspaceId, ctx.workspace.id),
              status === "open" ? inArray(voiceCallRequests.status, [...OPEN]) : eq(voiceCallRequests.status, status),
            );
      const rows = await db.select().from(voiceCallRequests).where(where).orderBy(desc(voiceCallRequests.createdAt)).limit(500);
      const agentIds = Array.from(new Set(rows.map((r) => r.agentId)));
      const userIds = Array.from(new Set(rows.flatMap((r) => [r.approvedByUserId, r.createdByUserId, r.ownerUserId]).filter((v): v is number => v != null)));
      const callIds = rows.map((r) => r.voiceCallId).filter((v): v is number => v != null);
      const [agents, people, calls] = await Promise.all([
        agentIds.length ? db.select({ id: voiceAgents.id, name: voiceAgents.name, plivoNumber: voiceAgents.plivoNumber, status: voiceAgents.status }).from(voiceAgents).where(and(eq(voiceAgents.workspaceId, ctx.workspace.id), inArray(voiceAgents.id, agentIds))) : [],
        userIds.length ? db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, userIds)) : [],
        callIds.length ? db.select({ id: voiceCalls.id, status: voiceCalls.status, durationSec: voiceCalls.durationSec, result: voiceCalls.result, meetingId: voiceCalls.meetingId, outcome: voiceCalls.outcome }).from(voiceCalls).where(and(eq(voiceCalls.workspaceId, ctx.workspace.id), inArray(voiceCalls.id, callIds))) : [],
      ]);
      const agentById = new Map(agents.map((a) => [a.id, a]));
      const nameById = new Map(people.map((u) => [u.id, u.name]));
      const callById = new Map(calls.map((c) => [c.id, c]));
      return rows.map((r) => ({
        ...r,
        agent: agentById.get(r.agentId) ?? null,
        ownerName: r.ownerUserId != null ? (nameById.get(r.ownerUserId) ?? null) : null,
        approvedByName: r.approvedByUserId != null ? (nameById.get(r.approvedByUserId) ?? null) : null,
        createdByName: r.createdByUserId != null ? (nameById.get(r.createdByUserId) ?? null) : null,
        call: r.voiceCallId != null ? (callById.get(r.voiceCallId) ?? null) : null,
      }));
    }),

  /** Queue people for an AI call. Creates drafts; nothing dials. */
  queue: workspaceProcedure
    .input(z.object({
      prospectIds: z.array(z.number().int()).min(1).max(200),
      agentId: z.number().int(),
      callNotes: z.string().max(1500).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await requireDb();
      const wsId = ctx.workspace.id;
      const [agent] = await db.select().from(voiceAgents)
        .where(and(eq(voiceAgents.id, input.agentId), eq(voiceAgents.workspaceId, wsId))).limit(1);
      if (!agent) throw new TRPCError({ code: "NOT_FOUND", message: "Agent not found" });
      if (agent.purpose !== "outbound_outreach") {
        throw new TRPCError({ code: "BAD_REQUEST", message: `${agent.name} is a call-back agent; choose an outreach agent to place calls.` });
      }
      if (!agent.plivoNumber) {
        throw new TRPCError({ code: "BAD_REQUEST", message: `${agent.name} has no Plivo number to call from. Connect one in Settings → Voice agents.` });
      }

      const ids = Array.from(new Set(input.prospectIds));
      const people = await db.select({
        id: prospects.id, firstName: prospects.firstName, lastName: prospects.lastName, company: prospects.company,
        email: prospects.email, phone: prospects.phone, state: prospects.state, country: prospects.country,
      }).from(prospects).where(and(eq(prospects.workspaceId, wsId), inArray(prospects.id, ids)));
      const byId = new Map(people.map((p) => [p.id, p]));

      const open = await db.select({ prospectId: voiceCallRequests.prospectId }).from(voiceCallRequests)
        .where(and(eq(voiceCallRequests.workspaceId, wsId), inArray(voiceCallRequests.prospectId, ids), inArray(voiceCallRequests.status, [...OPEN])));
      const alreadyOpen = new Set(open.map((o) => o.prospectId));

      const numbers = people.map((p) => callableNumber(p.phone)).filter((n): n is string => !!n);
      const suppressed = new Set(
        numbers.length
          ? (await db.select({ phone: callSuppressions.phone }).from(callSuppressions)
              .where(and(eq(callSuppressions.workspaceId, wsId), inArray(callSuppressions.phone, numbers)))).map((s) => s.phone)
          : [],
      );

      const wsTz = await getWorkspaceTimezone(wsId);
      const ownerUserId = (await configuredProposalOwner(wsId)) ?? agent.ownerUserId ?? ctx.user.id;
      const notes = input.callNotes ? cleanNotes(input.callNotes) || null : null;

      const skipped: { prospectId: number; name: string; reason: SkipReason }[] = [];
      const rows: (typeof voiceCallRequests.$inferInsert)[] = [];
      for (const id of ids) {
        const p = byId.get(id);
        if (!p) { skipped.push({ prospectId: id, name: `#${id}`, reason: "not_found" }); continue; }
        const name = `${p.firstName ?? ""} ${p.lastName ?? ""}`.trim() || `#${id}`;
        const to = callableNumber(p.phone);
        if (!to) { skipped.push({ prospectId: id, name, reason: "no_callable_number" }); continue; }
        if (suppressed.has(to)) { skipped.push({ prospectId: id, name, reason: "do_not_call" }); continue; }
        if (alreadyOpen.has(id)) { skipped.push({ prospectId: id, name, reason: "already_queued" }); continue; }
        rows.push({
          workspaceId: wsId,
          agentId: agent.id,
          prospectId: id,
          toNumber: to,
          personName: name.slice(0, 160),
          company: p.company?.slice(0, 200) ?? null,
          email: p.email ?? null,
          timezone: timezoneForRegion(p.state, p.country) ?? wsTz,
          callNotes: notes,
          ownerUserId,
          status: "draft",
          createdByUserId: ctx.user.id,
        });
      }
      if (rows.length) await db.insert(voiceCallRequests).values(rows);
      await recordAudit({ workspaceId: wsId, actorUserId: ctx.user.id, action: "create", entityType: "ai_call_request", entityId: null, after: { queued: rows.length, skipped: skipped.length, agentId: agent.id } });
      return { queued: rows.length, skipped };
    }),

  /** Edit a draft before it is approved. */
  update: workspaceProcedure
    .input(z.object({ id: z.number().int(), callNotes: z.string().max(1500).nullable().optional(), agentId: z.number().int().optional() }))
    .mutation(async ({ ctx, input }) => {
      const db = await requireDb();
      const [r] = await db.select().from(voiceCallRequests)
        .where(and(eq(voiceCallRequests.id, input.id), eq(voiceCallRequests.workspaceId, ctx.workspace.id))).limit(1);
      if (!r) throw new TRPCError({ code: "NOT_FOUND" });
      if (r.status !== "draft") throw new TRPCError({ code: "BAD_REQUEST", message: "Only a call waiting for approval can be edited." });
      if (r.createdByUserId !== ctx.user.id && rankOf(ctx.member.role) < ROLE_RANK.manager) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Only the person who queued this call, or a manager, can edit it." });
      }
      const patch: Partial<typeof voiceCallRequests.$inferInsert> = {};
      if (input.callNotes !== undefined) patch.callNotes = input.callNotes ? cleanNotes(input.callNotes) || null : null;
      if (input.agentId !== undefined) {
        const [a] = await db.select({ id: voiceAgents.id, purpose: voiceAgents.purpose, plivoNumber: voiceAgents.plivoNumber })
          .from(voiceAgents).where(and(eq(voiceAgents.id, input.agentId), eq(voiceAgents.workspaceId, ctx.workspace.id))).limit(1);
        if (!a || a.purpose !== "outbound_outreach" || !a.plivoNumber) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Choose an outreach agent with a Plivo number." });
        }
        patch.agentId = a.id;
      }
      if (Object.keys(patch).length) await db.update(voiceCallRequests).set(patch).where(eq(voiceCallRequests.id, r.id));
      return { ok: true };
    }),

  /**
   * Approve calls, one or many. Manager or above, and the approver confirms
   * the people consented to AI calls: US law treats an AI voice as an
   * "artificial voice", which needs prior consent for mobiles. Recorded on
   * each row and in the audit log.
   */
  approve: managerProcedure
    .input(z.object({ ids: z.array(z.number().int()).min(1).max(200), consentConfirmed: z.literal(true) }))
    .mutation(async ({ ctx, input }) => {
      const db = await requireDb();
      const ids = Array.from(new Set(input.ids));
      const drafts = await db.select({ id: voiceCallRequests.id }).from(voiceCallRequests)
        .where(and(eq(voiceCallRequests.workspaceId, ctx.workspace.id), inArray(voiceCallRequests.id, ids), eq(voiceCallRequests.status, "draft")));
      const draftIds = drafts.map((d) => d.id);
      if (draftIds.length) {
        const now = new Date();
        await db.update(voiceCallRequests).set({
          status: "approved",
          statusReason: null,
          approvedByUserId: ctx.user.id,
          approvedAt: now,
          consentConfirmedByUserId: ctx.user.id,
          consentConfirmedAt: now,
        }).where(and(eq(voiceCallRequests.workspaceId, ctx.workspace.id), inArray(voiceCallRequests.id, draftIds), eq(voiceCallRequests.status, "draft")));
      }
      await recordAudit({ workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "update", entityType: "ai_call_request", entityId: null, after: { approved: draftIds, consentConfirmed: true } });
      return { approved: draftIds.length, notDraft: ids.length - draftIds.length };
    }),

  /** Reject drafts, or take back approved calls that have not dialed yet. */
  reject: workspaceProcedure
    .input(z.object({ ids: z.array(z.number().int()).min(1).max(200), reason: z.string().max(200).optional() }))
    .mutation(async ({ ctx, input }) => {
      const db = await requireDb();
      const ids = Array.from(new Set(input.ids));
      const isManager = rankOf(ctx.member.role) >= ROLE_RANK.manager;
      const rows = await db.select({ id: voiceCallRequests.id, status: voiceCallRequests.status, createdByUserId: voiceCallRequests.createdByUserId })
        .from(voiceCallRequests)
        .where(and(eq(voiceCallRequests.workspaceId, ctx.workspace.id), inArray(voiceCallRequests.id, ids), inArray(voiceCallRequests.status, ["draft", "approved"])));
      // A rep may withdraw their own drafts; taking back an approval is a manager's.
      const allowed = rows.filter((r) => isManager || (r.status === "draft" && r.createdByUserId === ctx.user.id)).map((r) => r.id);
      if (allowed.length) {
        await db.update(voiceCallRequests).set({ status: "rejected", statusReason: input.reason?.slice(0, 200) || "Rejected" })
          .where(and(eq(voiceCallRequests.workspaceId, ctx.workspace.id), inArray(voiceCallRequests.id, allowed), inArray(voiceCallRequests.status, ["draft", "approved"])));
      }
      await recordAudit({ workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "update", entityType: "ai_call_request", entityId: null, after: { rejected: allowed } });
      return { rejected: allowed.length, notAllowed: ids.length - allowed.length };
    }),

  /**
   * Test call (owner ask 2026-10-05: "a way to 'Test' a call any time"): an
   * outreach agent calls a number right away, outside calling hours and
   * without the approval queue. Admins only, 10 a day per workspace, never to
   * a do-not-call number, and through the same spend limits as real calls.
   * The agent treats the tester as the person called (their name and email),
   * so a booking invites them and nothing about a prospect is used.
   */
  testCall: adminWsProcedure
    .input(z.object({
      agentId: z.number().int(),
      toNumber: z.string().max(40),
      /** Play this person (2026-10-06): their role, company, research and history; your phone and email. */
      asProspectId: z.number().int().positive().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await requireDb();
      const wsId = ctx.workspace.id;
      if (input.asProspectId) {
        const [p] = await db.select({ id: prospects.id }).from(prospects)
          .where(and(eq(prospects.id, input.asProspectId), eq(prospects.workspaceId, wsId))).limit(1);
        if (!p) throw new TRPCError({ code: "NOT_FOUND", message: "That person is not in this workspace." });
      }
      const [agent] = await db.select().from(voiceAgents)
        .where(and(eq(voiceAgents.id, input.agentId), eq(voiceAgents.workspaceId, wsId))).limit(1);
      if (!agent || agent.purpose !== "outbound_outreach" || !agent.plivoNumber) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Choose an outreach agent with a Plivo number." });
      }
      if (agent.status !== "active") throw new TRPCError({ code: "BAD_REQUEST", message: `${agent.name} is paused.` });
      const to = callableNumber(input.toNumber);
      if (!to) throw new TRPCError({ code: "BAD_REQUEST", message: "Enter a North American phone number." });
      const [dnc] = await db.select({ id: callSuppressions.id }).from(callSuppressions)
        .where(and(eq(callSuppressions.workspaceId, wsId), eq(callSuppressions.phone, to))).limit(1);
      if (dnc) throw new TRPCError({ code: "BAD_REQUEST", message: "That number is on the do-not-call list." });
      const [{ n } = { n: 0 }] = await db.select({ n: sql<number>`count(*)` }).from(voiceCalls)
        .where(and(eq(voiceCalls.workspaceId, wsId), isNotNull(voiceCalls.testedByUserId), gte(voiceCalls.startedAt, new Date(Date.now() - 24 * 60 * 60 * 1000))));
      if (Number(n) >= MAX_TEST_CALLS_PER_DAY) {
        throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: `That's ${MAX_TEST_CALLS_PER_DAY} test calls in the last 24 hours; try again later.` });
      }
      const admission = await admitInboundCall(wsId, null);
      if (!admission.ok) throw new TRPCError({ code: "BAD_REQUEST", message: admission.reason.replace(/^Not answered: /, "") });
      const creds = await plivoCreds(wsId);
      if (!creds) throw new TRPCError({ code: "BAD_REQUEST", message: "Connect Plivo first (Settings → Voice agents)." });

      const ins = await db.insert(voiceCalls).values({
        workspaceId: wsId,
        agentId: agent.id,
        direction: "outbound",
        provider: "plivo",
        toNumber: to,
        fromNumber: agent.plivoNumber,
        status: "queued",
        userId: ctx.user.id,
        testedByUserId: ctx.user.id,
        testAsProspectId: input.asProspectId ?? null,
        startedAt: new Date(),
      });
      const rowId = Number((ins as any)[0]?.insertId ?? (ins as any)?.insertId ?? 0);
      const [ws] = await db.select({ name: workspaces.name }).from(workspaces).where(eq(workspaces.id, wsId)).limit(1);
      const urls = plivoUrls(wsId, rowId);
      try {
        await placeCall(creds, { from: agent.plivoNumber, to, answerUrl: urls.answer, hangupUrl: urls.hangup, timeLimit: OUTBOUND_TIME_LIMIT_SEC, callerName: ws?.name ?? undefined });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await db.update(voiceCalls).set({ status: "failed", outcome: msg.slice(0, 500), endedAt: new Date(), durationSec: 0 }).where(eq(voiceCalls.id, rowId));
        throw new TRPCError({ code: "BAD_REQUEST", message: msg });
      }
      await recordAudit({ workspaceId: wsId, actorUserId: ctx.user.id, action: "create", entityType: "ai_test_call", entityId: rowId, after: { agentId: agent.id, to, asProspectId: input.asProspectId ?? null } });
      return { callId: rowId, to };
    }),

  /* ── do-not-call list ───────────────────────────────────────────────── */

  suppressions: workspaceProcedure.query(async ({ ctx }) => {
    const db = await requireDb();
    return db.select().from(callSuppressions).where(eq(callSuppressions.workspaceId, ctx.workspace.id)).orderBy(desc(callSuppressions.createdAt)).limit(1000);
  }),

  addSuppression: workspaceProcedure
    .input(z.object({ phone: z.string().max(40), prospectId: z.number().int().optional() }))
    .mutation(async ({ ctx, input }) => {
      const phone = callableNumber(input.phone);
      if (!phone) throw new TRPCError({ code: "BAD_REQUEST", message: "Not a North American phone number." });
      await suppressNumber(ctx.workspace.id, phone, "manual", input.prospectId ?? null, ctx.user.id);
      return { ok: true, phone };
    }),

  removeSuppression: managerProcedure
    .input(z.object({ id: z.number().int() }))
    .mutation(async ({ ctx, input }) => {
      const db = await requireDb();
      await db.delete(callSuppressions).where(and(eq(callSuppressions.id, input.id), eq(callSuppressions.workspaceId, ctx.workspace.id)));
      await recordAudit({ workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "delete", entityType: "call_suppression", entityId: input.id });
      return { ok: true };
    }),
});

/**
 * Never call this number again, in this workspace. Idempotent. Any call to
 * it still waiting (draft or approved) is skipped at once.
 */
export async function suppressNumber(
  workspaceId: number,
  phone: string,
  reason: "asked_on_call" | "manual",
  prospectId: number | null,
  userId: number | null,
): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db.insert(callSuppressions).values({ workspaceId, phone, reason, prospectId, createdByUserId: userId })
    .onDuplicateKeyUpdate({ set: { reason } });
  await db.update(voiceCallRequests).set({ status: "skipped", statusReason: "Number is on the do-not-call list" })
    .where(and(eq(voiceCallRequests.workspaceId, workspaceId), eq(voiceCallRequests.toNumber, phone), inArray(voiceCallRequests.status, ["draft", "approved"])));
}
