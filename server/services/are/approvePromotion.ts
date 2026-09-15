/**
 * Approve-time company promotion (owner ask 2026-09-15).
 *
 * An approved ARE prospect already has a People row (personLink runs at
 * ingest), but their company reached the Companies page only when a reply or
 * meeting promoted them to a full contact. The owner wants the company there
 * at APPROVE time: approval is the human/AI judgment that this person is
 * worth pursuing, so their organization belongs in the account list.
 *
 * This goes through associateProspectToCompany — the SAME guarded matcher
 * every import uses (LinkedIn-first identity, mailbox-domain demotion,
 * nameVouchesForDomain, conflict holds) — never a bare account insert.
 * Contacts and Opportunities still wait for real engagement
 * (promoteProspectToCrm on positive reply / meeting_booked).
 *
 * Re-scan safety: the sweep predicate is `accountId IS NULL AND
 * companyMatchStatus IS NULL`. Association stamps companyMatchStatus on
 * every outcome (linked / needs_review / missing / conflict), so a person
 * whose company can never be resolved leaves the predicate after one
 * attempt instead of being re-read forever (the day-9 negative-cache
 * starvation, avoided by construction).
 */
import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { prospectQueue, prospects } from "../../../drizzle/schema";
import { getDb } from "../../db";
import { associateProspectToCompany } from "../company/associationService";
import { upsertPersonForRow, type QueuePersonShape } from "../personLink";

export interface ApprovePromotionSummary {
  scanned: number;
  linkedExisting: number;
  createdAccounts: number;
  needsReview: number;
  unresolved: number;
}

const EMPTY: ApprovePromotionSummary = { scanned: 0, linkedExisting: 0, createdAccounts: 0, needsReview: 0, unresolved: 0 };

/**
 * Ensure every approved queue row's person has a company association.
 * Targeted mode (queueIds) runs right after an approval and also links any
 * still-unlinked queue row to its person first; sweep mode (campaignId only)
 * is the engine's bounded catch-up. Best-effort: never throws.
 */
export async function promoteApprovedProspects(
  workspaceId: number,
  opts: { campaignId?: number; queueIds?: number[]; limit?: number } = {},
): Promise<ApprovePromotionSummary> {
  const summary: ApprovePromotionSummary = { ...EMPTY };
  try {
    const db = await getDb();
    if (!db) return summary;

    // Targeted approvals may include rows ingest has not linked yet — link
    // them through the one seam before the join below would exclude them.
    if (opts.queueIds && opts.queueIds.length > 0) {
      const unlinked = await db.select().from(prospectQueue)
        .where(and(
          eq(prospectQueue.workspaceId, workspaceId),
          inArray(prospectQueue.id, opts.queueIds),
          isNull(prospectQueue.personProspectId),
        ));
      for (let i = 0; i < unlinked.length; i++) {
        const r = unlinked[i];
        try {
          const res = await upsertPersonForRow(workspaceId, r as unknown as QueuePersonShape);
          if (res) {
            await db.update(prospectQueue).set({ personProspectId: res.personId } as never)
              .where(and(eq(prospectQueue.id, r.id), eq(prospectQueue.workspaceId, workspaceId)));
          }
        } catch { /* identity-less rows stay unlinked; the sweep never re-reads them */ }
      }
    }

    const conds = [
      eq(prospectQueue.workspaceId, workspaceId),
      isNotNull(prospectQueue.approvedAt),
      isNotNull(prospectQueue.personProspectId),
      isNull(prospects.accountId),
      isNull(prospects.companyMatchStatus),
    ];
    if (opts.campaignId) conds.push(eq(prospectQueue.campaignId, opts.campaignId));
    if (opts.queueIds && opts.queueIds.length > 0) conds.push(inArray(prospectQueue.id, opts.queueIds));

    const rows = await db
      .select({ personId: prospectQueue.personProspectId })
      .from(prospectQueue)
      .innerJoin(prospects, and(
        eq(prospects.id, prospectQueue.personProspectId),
        eq(prospects.workspaceId, prospectQueue.workspaceId),
      ))
      .where(and(...conds))
      .limit(Math.min(Math.max(opts.limit ?? 100, 1), 500));

    // Dedupe person ids without Set iteration (es5 target).
    const seen: Record<number, true> = {};
    const personIds: number[] = [];
    for (let i = 0; i < rows.length; i++) {
      const id = rows[i].personId;
      if (id != null && !seen[id]) { seen[id] = true; personIds.push(id); }
    }
    if (personIds.length === 0) return summary;

    const people = await db.select().from(prospects)
      .where(and(eq(prospects.workspaceId, workspaceId), inArray(prospects.id, personIds)));
    for (let i = 0; i < people.length; i++) {
      const p = people[i];
      summary.scanned++;
      const r = await associateProspectToCompany(
        {
          id: p.id, workspaceId: p.workspaceId, company: p.company, companyDomain: p.companyDomain,
          email: p.email, title: p.title, city: p.city, state: p.state, country: p.country,
          fieldProvenance: p.fieldProvenance,
        },
        { sourceType: "are_approval" },
      );
      if (r.status === "linked" && r.created) summary.createdAccounts++;
      else if (r.status === "linked") summary.linkedExisting++;
      else if (r.status === "needs_review") summary.needsReview++;
      else summary.unresolved++;
    }
    return summary;
  } catch (e) {
    console.error("[are.approvePromotion] failed:", (e as Error)?.message ?? e);
    return summary;
  }
}
