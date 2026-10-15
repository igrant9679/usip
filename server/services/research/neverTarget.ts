/**
 * A campaign's never-target words (Research phase 4): the ones saved on the
 * campaign (icpOverrides.exclude, copied from the sector when the campaign was
 * created from one, editable with the rest of its targeting), plus the live
 * words of the research sector it names, when that sector is Researched or
 * Verified. Discovery, scoring and screening all ask here, so a word added to
 * the sector reaches every stage of every campaign that uses it.
 */
import { and, eq, inArray } from "drizzle-orm";
import { researchSectors } from "../../../drizzle/schema";
import { getDb } from "../../db";
import { cleanSectorContent } from "@shared/researchShape";
import { cleanNeverTarget, neverTargetFromOverrides } from "@shared/researchTargeting";

type CampaignLike = { workspaceId: number; icpOverrides?: unknown; researchSectorId?: number | null };

export async function campaignNeverTarget(campaign: CampaignLike): Promise<string[]> {
  const own = neverTargetFromOverrides(campaign.icpOverrides);
  if (campaign.researchSectorId == null) return own;
  try {
    const db = await getDb();
    if (!db) return own;
    const [s] = await db
      .select({ targeting: researchSectors.targeting })
      .from(researchSectors)
      .where(and(
        eq(researchSectors.id, campaign.researchSectorId),
        eq(researchSectors.workspaceId, campaign.workspaceId),
        inArray(researchSectors.status, ["researched", "verified"]),
      ))
      .limit(1);
    if (!s) return own;
    const live = cleanSectorContent({ targeting: s.targeting }).content.targeting.exclude;
    return cleanNeverTarget([...own, ...live]);
  } catch {
    return own;
  }
}
