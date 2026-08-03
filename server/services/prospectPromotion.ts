/**
 * Promoting a cleaned prospect into the CRM.
 *
 * THE MISSING LINK in the import → clean → enrol chain. CSV import writes
 * `contacts`; the enrichment sweeper only ever reads `prospects` and
 * `prospect_queue`; segment→sequence rules only ever read `contacts`. So an
 * imported list was never cleaned, and a cleaned prospect never became
 * something a campaign could enrol.
 *
 * `promoteProspectToCrm` (routers/are/execution.ts) does not fit: it takes a
 * `prospectQueueId` + `campaignId`, reads `prospect_queue`, and is triggered by
 * a POSITIVE REPLY — a deliberate product rule from 2026-07-18. This is the
 * other direction: a row in the People list that now has a verified address.
 * The two share their account/contact matching (services/crmMatching) rather
 * than their trigger, because identity is the part that must not drift.
 *
 * PROMOTE ON A VERIFIED EMAIL ONLY (owner's decision, 2026-08-02). That single
 * rule also answers "may an unverified row reach a campaign?" — it cannot,
 * because only promoted rows become contacts and only contacts are enrolled.
 */
import { and, eq } from "drizzle-orm";
import { contacts, prospects } from "../../drizzle/schema";
import { getDb } from "../db";
import { findContactByEmail, findOrCreateAccount } from "./crmMatching";

/**
 * Reoon's verdict, as stored on `prospects.emailStatus`.
 *
 * Only `valid` promotes. `accept_all` is a domain that accepts everything —
 * it tells you nothing about whether the person exists — and `risky` covers
 * role accounts, disposables and full inboxes. Mailing either is how a warmed
 * domain gets burned, and this list feeds campaigns that send automatically.
 *
 * One definition, exported, so widening it later is a decision made once and
 * not a condition quietly copied with an extra status bolted on.
 */
export const PROMOTABLE_EMAIL_STATUSES = ["valid"] as const;

export function isPromotableEmailStatus(status: string | null | undefined): boolean {
  return !!status && (PROMOTABLE_EMAIL_STATUSES as readonly string[]).includes(status);
}

export type PromotionOutcome =
  | { promoted: true; contactId: number; accountId: number; alreadyLinked: boolean }
  | { promoted: false; reason: "not_found" | "no_email" | "not_verified" | "no_company" | "db_unavailable" };

/**
 * Promote one `prospects` row to an account + contact, if it has earned it.
 *
 * IDEMPOTENT. A prospect already carrying `linkedContactId` returns that
 * contact and creates nothing — the sweeper may reach the same row again on a
 * later pass, and a promotion that ran twice would put the same person in the
 * CRM twice and then into a campaign twice.
 */
export async function promoteVerifiedProspect(
  workspaceId: number,
  prospectId: number,
  opts: { ownerUserId?: number } = {},
): Promise<PromotionOutcome> {
  const db = await getDb();
  if (!db) return { promoted: false, reason: "db_unavailable" };

  const [p] = await db
    .select()
    .from(prospects)
    .where(and(eq(prospects.id, prospectId), eq(prospects.workspaceId, workspaceId)))
    .limit(1);
  if (!p) return { promoted: false, reason: "not_found" };

  // Already promoted — return the existing link rather than making a second.
  if (p.linkedContactId) {
    const accountId = p.accountId ?? 0;
    return { promoted: true, contactId: p.linkedContactId, accountId, alreadyLinked: true };
  }

  if (!p.email) return { promoted: false, reason: "no_email" };
  if (!isPromotableEmailStatus(p.emailStatus)) return { promoted: false, reason: "not_verified" };

  /**
   * A contact with no company is a row nobody can route, score or enrol
   * against an account. The sweeper's own candidate query requires a
   * companyDomain, so in the intended flow this never trips — it is here so a
   * hand-made call cannot create orphans.
   */
  const companyName = (p.company ?? "").trim();
  if (!companyName && !p.companyDomain) return { promoted: false, reason: "no_company" };

  const accountId = await findOrCreateAccount(db, workspaceId, {
    companyName: companyName || p.companyDomain!,
    companyDomain: p.companyDomain,
    industry: p.industry,
    ownerUserId: opts.ownerUserId,
  });

  // Match an existing contact before creating one: the same person may already
  // be in the CRM from an earlier import or a reply.
  let contactId = await findContactByEmail(db, workspaceId, p.email);
  if (!contactId) {
    const [created] = await db
      .insert(contacts)
      .values({
        workspaceId,
        accountId,
        firstName: p.firstName ?? "Unknown",
        lastName: p.lastName ?? "Prospect",
        title: p.title ?? undefined,
        email: p.email,
        phone: p.phone ?? undefined,
        linkedinUrl: p.linkedinUrl ?? undefined,
        city: p.city ?? undefined,
        seniority: p.seniority ?? undefined,
        companyName: companyName || undefined,
        companyDomain: p.companyDomain ?? undefined,
        ownerUserId: opts.ownerUserId,
      })
      .$returningId();
    contactId = created.id;
  }

  // Write the link back BEFORE returning, so a crash between here and the
  // caller cannot leave a contact that no prospect points at — which would
  // promote the same person again on the next sweep.
  await db
    .update(prospects)
    .set({ linkedContactId: contactId, accountId })
    .where(and(eq(prospects.id, prospectId), eq(prospects.workspaceId, workspaceId)));

  return { promoted: true, contactId, accountId, alreadyLinked: false };
}
