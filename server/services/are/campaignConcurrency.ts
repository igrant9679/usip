/**
 * "Max Concurrent Campaigns" — the number the ARE Settings slider has always
 * saved and nothing has ever read (2026-09-20).
 *
 * The card's own copy is the specification: "The ARE will not START new
 * campaigns beyond this limit." So this bounds ACTIVE campaigns per workspace
 * and is consulted at the three ACTIVATION doors only — create-with-launch,
 * setStatus → active, and the proposal accept the routing cron drives. It is
 * deliberately NOT consulted inside runAreEngine's tick loop: freezing
 * campaigns that are already running, mid-sequence, because someone dragged a
 * slider is a worse outcome than the inert toggle this replaces.
 *
 * It is not a cap on prospects in flight — targetProspectCount, dailySendCap
 * and ENRICH_PER_TICK already bound that per campaign.
 *
 * Non-throwing on purpose: the three callers want different failures (two
 * TRPCErrors with different copy, one silent hold), so this returns the
 * numbers and lets each decide.
 */
import { and, eq, sql } from "drizzle-orm";
import { areCampaigns, workspaceSettings } from "../../../drizzle/schema";
import { getDb } from "../../db";

/** Matches drizzle/schema.ts workspaceSettings.areMaxConcurrentCampaigns. */
const DEFAULT_MAX_CONCURRENT = 5;

export interface CampaignHeadroom {
  active: number;
  max: number;
  hasRoom: boolean;
}

/**
 * How many campaigns this workspace is running, and how many it may run.
 *
 * With no database, or no settings row (getOrSeedSettings writes it lazily, so
 * a workspace can genuinely have none), this fails OPEN — a cap that cannot be
 * read must not become a lockout.
 */
export async function campaignHeadroom(workspaceId: number): Promise<CampaignHeadroom> {
  const db = await getDb();
  if (!db) return { active: 0, max: DEFAULT_MAX_CONCURRENT, hasRoom: true };
  try {
    // Only 'active' counts. A paused, draft, completed or archived campaign
    // sends nothing, so holding a slot against it would make the limit mean
    // "campaigns you have ever made" and lock a workspace out over history.
    // ix_arec_status (workspaceId, status) covers this predicate.
    const [row] = await db
      .select({ n: sql<number>`count(*)` })
      .from(areCampaigns)
      .where(and(eq(areCampaigns.workspaceId, workspaceId), eq(areCampaigns.status, "active")));
    const active = Number(row?.n ?? 0);

    const [s] = await db
      .select({ max: workspaceSettings.areMaxConcurrentCampaigns })
      .from(workspaceSettings)
      .where(eq(workspaceSettings.workspaceId, workspaceId))
      .limit(1);
    const max = Number(s?.max ?? DEFAULT_MAX_CONCURRENT);

    return { active, max, hasRoom: active < max };
  } catch (e) {
    console.error("[campaignHeadroom] lookup failed:", (e as Error).message);
    return { active: 0, max: DEFAULT_MAX_CONCURRENT, hasRoom: true };
  }
}

/**
 * The one sentence every caller shows. Centralised because a rep can hit this
 * (are.campaigns.setStatus is workspaceProcedure) while only an admin can
 * clear it (settings.updateAreSettings is adminWsProcedure) — telling a rep to
 * "raise the limit in ARE Settings" points them at a control they cannot open.
 * It also surfaces in the assistant's chat transcript, so it has to read as
 * English rather than as a developer message.
 */
export function campaignCapMessage(h: CampaignHeadroom): string {
  return `This workspace already has ${h.active} active campaign${h.active === 1 ? "" : "s"}, which is its limit of ${h.max}. Pause one, save this as a draft, or ask a workspace admin to raise Max Concurrent Campaigns in ARE Settings.`;
}
