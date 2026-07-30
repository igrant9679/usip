/**
 * enrollmentDedupe.ts — stop the same PERSON being enrolled twice in one
 * sequence by the inbound surfaces.
 *
 * The outbound path already guards this: crm.ts's bulk enroll selects an
 * existing active enrollment for (sequenceId, contactId) and skips. The three
 * INBOUND surfaces did not:
 *
 *   routers/forms.ts         autoEnrollSequenceId on a web-form submit
 *   routers/landingPages.ts  autoEnrollSequenceId on a landing-page submit
 *   routers/chatAgents.ts    autoEnrollSequenceId when the chat agent captures
 *                            an email
 *
 * A contactId check would not have helped them, because each of those paths
 * INSERTS A NEW LEAD on every submission — no find-or-create by email. So a
 * person who fills the form twice gets two lead rows, two active enrollments,
 * and every step of the sequence twice. `enrollments` has no unique index
 * either (only ix_enr_seq / ix_enr_prospect), and sequenceEngine does not
 * deduplicate by recipient address at send time: it resolves `toEmail` per
 * enrollment and sends. Nothing downstream would catch it.
 *
 * Hence the dedupe key here is the EMAIL, not the lead id. That deliberately
 * leaves duplicate LEAD rows alone — lead matching is a product decision this
 * codebase is conservative about on purpose (see the opt-in matchOnNameCompany
 * on CSV import). Sending a stranger the same sequence twice is the harm worth
 * preventing, and it is preventable without touching lead identity.
 */
import { and, eq, isNotNull } from "drizzle-orm";
import { enrollments, leads } from "../../drizzle/schema";

/**
 * True if someone with this email already has an ACTIVE enrollment in this
 * sequence. Scoped to the workspace.
 *
 * Fails OPEN (returns false) on a missing email or a database error: a submitted
 * form that silently enrolls nobody is worse than a rare duplicate, and an empty
 * email cannot be sent to anyway.
 */
export async function hasActiveEnrollmentForEmail(
  db: any,
  workspaceId: number,
  sequenceId: number,
  email: string | null | undefined,
): Promise<boolean> {
  const addr = (email ?? "").trim().toLowerCase();
  if (!addr) return false;
  try {
    const rows = await db
      .select({ id: enrollments.id })
      .from(enrollments)
      .innerJoin(leads, eq(enrollments.leadId, leads.id))
      .where(
        and(
          eq(enrollments.workspaceId, workspaceId),
          eq(enrollments.sequenceId, sequenceId),
          eq(enrollments.status, "active"),
          isNotNull(enrollments.leadId),
          eq(leads.email, addr),
        ),
      )
      .limit(1);
    return rows.length > 0;
  } catch (e) {
    console.warn("[enrollmentDedupe] check failed, allowing enroll:", (e as Error).message);
    return false;
  }
}
