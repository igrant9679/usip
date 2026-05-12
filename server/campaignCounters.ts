/**
 * campaignCounters.ts — increment campaigns.total* aggregates from the
 * various send / engagement / reply / bounce code paths.
 *
 * Drafts don't directly reference a campaign — the link goes
 * draft → sequenceId → campaigns where campaigns.sequenceId matches.
 * We bump every live/scheduled campaign that points at the sequence
 * (typically just one) so the campaign analytics view shows real data
 * instead of zeros.
 *
 * Audit reference: before this module, campaigns.totalSent / totalOpened
 * / totalClicked / totalReplied / totalBounced were defined on the
 * schema and read by the analytics queries, but no code ever wrote to
 * them. The "campaign performance" UI was reading from a permanently
 * empty table.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { campaigns } from "../drizzle/schema";
import { getDb } from "./db";

export type CampaignCounter =
  | "totalSent"
  | "totalDelivered"
  | "totalOpened"
  | "totalClicked"
  | "totalReplied"
  | "totalBounced";

/**
 * Bump a campaign counter by N (default 1) for every live/scheduled
 * campaign whose sequenceId matches. Idempotent in spirit but NOT in
 * effect — call once per discrete event. Silently no-ops when no
 * campaign owns the sequence.
 */
export async function bumpCampaignCounter(
  workspaceId: number,
  sequenceId: number,
  field: CampaignCounter,
  by = 1,
): Promise<void> {
  if (!sequenceId) return;
  const db = await getDb();
  if (!db) return;
  try {
    // Raw SQL increment — Drizzle's typed update doesn't expose column
    // arithmetic cleanly, and we want this race-safe under concurrent
    // tracking events.
    const col = sql.identifier(field);
    await db
      .update(campaigns)
      .set({ [field]: sql`${col} + ${by}` as unknown as number })
      .where(
        and(
          eq(campaigns.workspaceId, workspaceId),
          eq(campaigns.sequenceId, sequenceId),
          inArray(campaigns.status, ["live", "scheduled"]),
        ),
      );
  } catch (err) {
    // Don't let a counter-bump failure abort the parent operation
    // (send / track / reply). Just log.
    console.error(
      `[campaignCounters] failed to bump ${field} for sequence ${sequenceId}:`,
      err,
    );
  }
}
