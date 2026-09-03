/**
 * effectiveIcp — the ONE merge of a campaign's targeting over the workspace
 * ICP. Lived as a private function inside routers/are/prospects.ts until the
 * campaign router (phase 3, 2026-09-02) needed the same rule for N campaigns
 * at once; a second copy would have drifted. Pure: no DB, no LLM.
 *
 * Overrides win per-field; the ICP fills gaps and supplies anti-patterns.
 * Scoring only the global ICP once graded a nonprofit campaign's Executive
 * Directors against a B2B-tech profile — every on-audience prospect scored
 * 10-40 and screening auto-rejected them all. Returns null when there is
 * neither an ICP nor any override targeting.
 */
import type { icpProfiles } from "../../../drizzle/schema";

export type IcpProfileRow = typeof icpProfiles.$inferSelect;

export interface IcpOverrides {
  targetTitles?: string[];
  targetIndustries?: string[];
  targetGeographies?: string[];
  keywords?: string[];
  employeeMin?: number;
  employeeMax?: number;
}

export function buildEffectiveIcp(
  icp: IcpProfileRow | undefined,
  icpOverrides: unknown,
): IcpProfileRow | null {
  const ov = (icpOverrides ?? {}) as IcpOverrides;
  const hasOverrides =
    (ov.targetTitles?.length ?? 0) > 0 ||
    (ov.targetIndustries?.length ?? 0) > 0 ||
    (ov.targetGeographies?.length ?? 0) > 0;
  if (!icp && !hasOverrides) return null;
  return {
    ...(icp ?? {}),
    targetTitles: ov.targetTitles?.length ? ov.targetTitles : (icp?.targetTitles ?? []),
    targetIndustries: ov.targetIndustries?.length ? ov.targetIndustries : (icp?.targetIndustries ?? []),
    targetGeographies: ov.targetGeographies?.length ? ov.targetGeographies : (icp?.targetGeographies ?? []),
    targetCompanySizeMin: ov.employeeMin ?? icp?.targetCompanySizeMin ?? null,
    targetCompanySizeMax: ov.employeeMax ?? icp?.targetCompanySizeMax ?? null,
    antiPatterns: icp?.antiPatterns ?? [],
  } as IcpProfileRow;
}

/** The shape the deterministic scorer wants, derived from an effective ICP + overrides. */
export function scoringTargetsOf(icp: IcpProfileRow | null, icpOverrides: unknown): { titles: string[]; industries: string[]; geos: string[]; keywords: string[] } {
  const ov = (icpOverrides ?? {}) as IcpOverrides;
  const arr = (v: unknown): string[] => (Array.isArray(v) ? v.map(String).filter(Boolean) : []);
  return {
    titles: arr(icp?.targetTitles),
    industries: arr(icp?.targetIndustries),
    geos: arr(icp?.targetGeographies),
    keywords: arr(ov.keywords),
  };
}
