/**
 * ensureCustomerForWonOpp — when an opportunity reaches a won stage, the
 * account becomes a Customer (post-sale CS: health, renewals, QBRs).
 *
 * Shared by every code path that can move a deal to won — the kanban's
 * crm.setStage, pipelineAlerts.moveDealStage, the approval queue's
 * opportunityIntelligence.reviewStageChange and both proposal-accept paths —
 * so the funnel's Closed Won → Customer step fires consistently. Idempotent:
 * no-op if the account is already a customer (or has no account).
 */
import { and, eq } from "drizzle-orm";
import { customers } from "../../drizzle/schema";
import { activeOwnerOrNull } from "../_core/activeMembers";
import type { getDb } from "../db";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

export async function ensureCustomerForWonOpp(
  db: Db,
  workspaceId: number,
  opp: { accountId: number | null; value: string | null; ownerUserId: number | null },
  fallbackUserId: number,
): Promise<boolean> {
  if (!opp.accountId) return false;
  const [existing] = await db
    .select({ id: customers.id })
    .from(customers)
    .where(and(eq(customers.workspaceId, workspaceId), eq(customers.accountId, opp.accountId)))
    .limit(1);
  if (existing) return false;

  const start = new Date();
  const end = new Date(start.getTime() + 365 * 86400000);
  // 2026-09-20: this was `opp.ownerUserId ?? fallbackUserId`, so the fallback
  // only fired on a NULL owner — a departed rep's id is non-null and sailed
  // straight through into cmUserId. The account's entire post-sale life (health
  // checks, renewal stage, the QBR and renewal tasks) is keyed off the CSM, so
  // it was filed under someone who cannot sign in, and it looked handled.
  // Sharpest on proposals.acceptByToken, which has no session at all: the
  // client clicks Accept on a share link and the deal's stored owner is whoever
  // owned it months ago. Resolved here rather than at the five call sites
  // because this is the one place the id becomes a CSM. Every caller's
  // fallback is already an active member — the acting user, or
  // workspaceNotifyUserId on the session-less paths.
  const cmUserId = (await activeOwnerOrNull(workspaceId, opp.ownerUserId)) ?? fallbackUserId;
  await db.insert(customers).values({
    workspaceId,
    accountId: opp.accountId,
    arr: opp.value ?? "0",
    contractStart: start,
    contractEnd: end,
    cmUserId,
    renewalStage: "early",
  } as never);
  return true;
}
