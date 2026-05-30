/**
 * ensureCustomerForWonOpp — when an opportunity reaches a won stage, the
 * account becomes a Customer (post-sale CS: health, renewals, QBRs).
 *
 * Shared by every code path that can move a deal to won (the kanban's
 * crm.setStage and pipelineAlerts.moveDealStage) so the funnel's
 * Closed Won → Customer step fires consistently. Idempotent: no-op if the
 * account is already a customer (or has no account).
 */
import { and, eq } from "drizzle-orm";
import { customers } from "../../drizzle/schema";
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
  await db.insert(customers).values({
    workspaceId,
    accountId: opp.accountId,
    arr: opp.value ?? "0",
    contractStart: start,
    contractEnd: end,
    cmUserId: opp.ownerUserId ?? fallbackUserId,
    renewalStage: "early",
  } as never);
  return true;
}
