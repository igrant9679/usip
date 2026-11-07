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
import { accounts, audienceSegments, contacts, crmPipelines, customers, leads, opportunities, proposals, prospects, senderPools, sendingAccounts, sequences, territories } from "../../drizzle/schema";
import { isActiveMember } from "../_core/activeMembers";
import type { getDb } from "../db";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

const TABLES = { account: accounts, contact: contacts, pipeline: crmPipelines, territory: territories, customer: customers, sequence: sequences, segment: audienceSegments, "sending account": sendingAccounts, "sender pool": senderPools, lead: leads, deal: opportunities, person: prospects, proposal: proposals } as const;
export type ForeignKind = keyof typeof TABLES;

/** A task's relatedType, as the kinds above. A mailbox thread's id is its mailbox's. */
const RELATED_KINDS: Record<string, ForeignKind> = {
  account: "account", contact: "contact", lead: "lead", opportunity: "deal", prospect: "person",
  customer: "customer", proposal: "proposal", mailbox_thread: "sending account",
};

/**
 * The record a task is about (audit 2026-10-20, R73): a type this knows, and
 * an id that is that kind's row in this workspace. Both were stored as given,
 * so a task could point at another tenant's deal or at a type nothing reads.
 * No-op when neither is set.
 */
export async function assertRelatedInWorkspace(
  db: Db,
  relatedType: string | null | undefined,
  relatedId: number | null | undefined,
  workspaceId: number,
): Promise<void> {
  if (relatedType == null && relatedId == null) return;
  // Own keys only: "constructor" is on every object.
  const kind = relatedType != null && Object.prototype.hasOwnProperty.call(RELATED_KINDS, relatedType) ? RELATED_KINDS[relatedType] : undefined;
  if (!kind) throw new TRPCError({ code: "BAD_REQUEST", message: "A task can be about an account, contact, lead, deal, person, customer, proposal or mailbox thread." });
  await assertRowInWorkspace(db, kind, relatedId, workspaceId);
}

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
 * The read-time half of `assertRowInWorkspace`, for the public submit paths
 * (audit 2026-10-20, G4). Forms, landing pages and chat agents store an
 * auto-enrol sequence id, checked when it is saved; a row saved before that
 * check existed can still name another workspace's sequence, and a public
 * submission must not enrol anyone into it. False on any doubt, a failed read
 * included: an enrolment that does not happen is the safe miss here.
 */
export async function sequenceInWorkspace(db: Db, workspaceId: number, sequenceId: number | null | undefined): Promise<boolean> {
  if (sequenceId == null) return false;
  try {
    const [row] = await db
      .select({ id: sequences.id })
      .from(sequences)
      .where(and(eq(sequences.id, sequenceId), eq(sequences.workspaceId, workspaceId)))
      .limit(1);
    return !!row;
  } catch {
    return false;
  }
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
