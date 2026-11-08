/**
 * Record a customer's renewal or churn (audit 2026-10-20, F36 and U26).
 *
 * A renewal was a free-form "amendment" with a typed ARR delta, and a churn
 * the same with a termination type and whatever delta someone typed, so the
 * Renewals board had no plain way to say "they renewed at $X until then" or
 * "they left on this day, for this reason". These two write the outcome in
 * one step:
 *
 *   renewal — the new term (start, end) and the new ARR; the amendment
 *             records the ARR change; the renewal stage follows the new end
 *             date (a renewed customer starts the next term's ladder, as
 *             cs.addAmendment's renewal does); a churn on record is cleared,
 *             since a customer who renews has not churned.
 *   churn   — the day and the reason; the stage becomes churned (a human
 *             outcome the derivation never overwrites), the contract ends that
 *             day, and the amendment records the ARR lost. The stored arr is
 *             kept as the ARR that churned.
 *
 * Every ARR figure reads these rows through customerArrTotals in
 * services/dealMetrics — the deal-and-revenue module — so the Customers KPIs
 * and the company page move with them.
 */
import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import { contractAmendments, customers } from "../../drizzle/schema";
import { recordAudit } from "../audit";
import type { getDb } from "../db";
import { calendarDayFrom } from "./calendarDeadline";
import { renewalStageFor } from "@shared/renewalStage";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

const DAY_MS = 86_400_000;

async function customerOrThrow(db: Db, workspaceId: number, customerId: number) {
  const [c] = await db.select().from(customers).where(and(eq(customers.id, customerId), eq(customers.workspaceId, workspaceId)));
  if (!c) throw new TRPCError({ code: "NOT_FOUND", message: "Customer not found" });
  return c;
}

export async function recordCustomerRenewal(db: Db, input: {
  workspaceId: number;
  customerId: number;
  actorUserId: number;
  /** The ARR of the new term. */
  newArr: number;
  /** "YYYY-MM-DD". Left out: the day the old term ended, else today. */
  termStart?: string | null;
  /** "YYYY-MM-DD", after the start. */
  termEnd: string;
  notes?: string | null;
}) {
  const c = await customerOrThrow(db, input.workspaceId, input.customerId);
  if (!Number.isFinite(input.newArr) || input.newArr < 0) throw new TRPCError({ code: "BAD_REQUEST", message: "Enter the new ARR (0 or more)." });
  const start = calendarDayFrom(input.termStart ?? null) ?? c.contractEnd ?? calendarDayFrom(new Date().toISOString().slice(0, 10))!;
  const end = calendarDayFrom(input.termEnd);
  if (!end) throw new TRPCError({ code: "BAD_REQUEST", message: "Pick the day the new term ends." });
  if (end.getTime() - start.getTime() < DAY_MS) throw new TRPCError({ code: "BAD_REQUEST", message: "The new term must end after it starts." });
  const before = { arr: c.arr, contractStart: c.contractStart, contractEnd: c.contractEnd, renewalStage: c.renewalStage, churnedAt: c.churnedAt, churnReason: c.churnReason };
  const arrDelta = Math.round((input.newArr - Number(c.arr ?? 0)) * 100) / 100;
  await db.insert(contractAmendments).values({
    workspaceId: input.workspaceId,
    customerId: c.id,
    type: "renewal",
    arrDelta: String(arrDelta),
    effectiveAt: start,
    notes: (input.notes?.trim() || `Renewed to ${end.toISOString().slice(0, 10)} at ${input.newArr}`).slice(0, 2000),
    createdByUserId: input.actorUserId,
  });
  const patch = {
    arr: String(input.newArr),
    contractStart: start,
    contractEnd: end,
    renewalStage: renewalStageFor({ current: "early", contractEnd: end }),
    churnedAt: null,
    churnReason: null,
  };
  await db.update(customers).set(patch as never).where(and(eq(customers.id, c.id), eq(customers.workspaceId, input.workspaceId)));
  await recordAudit({
    workspaceId: input.workspaceId, actorUserId: input.actorUserId, action: "update", entityType: "customer", entityId: c.id,
    before, after: { ...patch, recorded: "renewal", arrDelta },
  });
  return { ok: true as const, arrDelta, renewalStage: patch.renewalStage };
}

export async function recordCustomerChurn(db: Db, input: {
  workspaceId: number;
  customerId: number;
  actorUserId: number;
  /** "YYYY-MM-DD": the day they left. */
  churnedOn: string;
  reason: string;
}) {
  const c = await customerOrThrow(db, input.workspaceId, input.customerId);
  if (c.renewalStage === "churned") throw new TRPCError({ code: "BAD_REQUEST", message: "This customer is already recorded as churned. Record a renewal to bring them back." });
  const day = calendarDayFrom(input.churnedOn);
  if (!day) throw new TRPCError({ code: "BAD_REQUEST", message: "Pick the day they churned." });
  const reason = input.reason.replace(/\s+/g, " ").trim().slice(0, 200);
  if (!reason) throw new TRPCError({ code: "BAD_REQUEST", message: "Say why they churned." });
  const arr = Number(c.arr ?? 0);
  const before = { arr: c.arr, contractEnd: c.contractEnd, renewalStage: c.renewalStage };
  await db.insert(contractAmendments).values({
    workspaceId: input.workspaceId,
    customerId: c.id,
    type: "termination",
    arrDelta: String(-arr),
    effectiveAt: day,
    notes: `Churned: ${reason}`,
    createdByUserId: input.actorUserId,
  });
  const patch = { contractEnd: day, renewalStage: "churned" as const, churnedAt: day, churnReason: reason };
  await db.update(customers).set(patch as never).where(and(eq(customers.id, c.id), eq(customers.workspaceId, input.workspaceId)));
  await recordAudit({
    workspaceId: input.workspaceId, actorUserId: input.actorUserId, action: "update", entityType: "customer", entityId: c.id,
    before, after: { ...patch, recorded: "churn", churnedArr: arr },
  });
  return { ok: true as const, churnedArr: arr };
}
