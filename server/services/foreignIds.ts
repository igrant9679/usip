/**
 * Ids a caller may write ONTO a record, checked against the caller's workspace.
 *
 * 🔴 THE HOLE (audit 2026-10-20, C7). The CRM update procedures took
 * `patch: z.record(any)` and handed it to `.set()`. Their WHERE clauses were
 * workspace-scoped, so the row being edited was always the caller's — but the
 * patch could rewrite `workspaceId` (move the record into another tenant),
 * `id`, or point `accountId` / `ownerUserId` / `territoryId` at another
 * tenant's rows. The patch schemas are explicit now (crm.ts, activities.ts);
 * these are the checks for the foreign ids those schemas still allow.
 *
 * BAD_REQUEST rather than NOT_FOUND: the record being edited exists; what the
 * caller asked to link it to does not, here.
 */
import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import { accounts, contacts, crmPipelines, customers, sequences, territories } from "../../drizzle/schema";
import { isActiveMember } from "../_core/activeMembers";
import type { getDb } from "../db";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

const TABLES = { account: accounts, contact: contacts, pipeline: crmPipelines, territory: territories, customer: customers, sequence: sequences } as const;
export type ForeignKind = keyof typeof TABLES;

/** No-op for null/undefined (clearing a link is always allowed). */
export async function assertRowInWorkspace(
  db: Db,
  kind: ForeignKind,
  id: number | null | undefined,
  workspaceId: number,
): Promise<void> {
  if (id == null) return;
  const table = TABLES[kind];
  const [row] = await db
    .select({ id: table.id })
    .from(table)
    .where(and(eq(table.id, id), eq(table.workspaceId, workspaceId)))
    .limit(1);
  if (!row) throw new TRPCError({ code: "BAD_REQUEST", message: `That ${kind} is not in this workspace.` });
}

/**
 * An owner must be someone who works HERE now — not another workspace's user
 * and not a leaver, or the record is filed under a person who will never see
 * it. No-op for null/undefined.
 */
export async function assertOwnerInWorkspace(workspaceId: number, userId: number | null | undefined): Promise<void> {
  if (userId == null) return;
  if (!(await isActiveMember(workspaceId, userId))) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "The owner must be an active member of this workspace." });
  }
}
