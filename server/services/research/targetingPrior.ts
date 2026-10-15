/**
 * The workspace's research as targeting (Research phase 4): the union of every
 * Researched or Verified sector's targeting, for the ICP fallback, and a short
 * summary of the same sectors that ICP inference reads as prior knowledge.
 */
import { and, eq, inArray } from "drizzle-orm";
import { researchSectors, workspaceSettings } from "../../../drizzle/schema";
import { getDb } from "../../db";
import { cleanSectorContent, type SectorContent } from "@shared/researchShape";
import { pausedDownstreamFilter } from "./downstreamAccounts";

export const ICP_FALLBACKS = ["inferred", "research", "merged"] as const;
export type IcpFallback = (typeof ICP_FALLBACKS)[number];

export function icpFallbackOf(v: unknown): IcpFallback {
  return (ICP_FALLBACKS as readonly string[]).includes(v as string) ? (v as IcpFallback) : "inferred";
}

export async function workspaceIcpFallback(workspaceId: number): Promise<IcpFallback> {
  const db = await getDb();
  if (!db) return "inferred";
  const [row] = await db
    .select({ v: workspaceSettings.icpFallback })
    .from(workspaceSettings)
    .where(eq(workspaceSettings.workspaceId, workspaceId))
    .limit(1);
  return icpFallbackOf(row?.v);
}

async function usableSectors(workspaceId: number): Promise<SectorContent[]> {
  const db = await getDb();
  if (!db) return [];
  const rows = await db
    .select()
    .from(researchSectors)
    .where(and(eq(researchSectors.workspaceId, workspaceId), inArray(researchSectors.status, ["researched", "verified"])));
  const isPaused = await pausedDownstreamFilter(workspaceId);
  return rows.filter((r) => !isPaused(r)).map((r) => cleanSectorContent(r).content);
}

export type ResearchTargeting = { titles: string[]; industries: string[]; geographies: string[]; keywords: string[]; employeeMin: number | null; employeeMax: number | null };

const union = (lists: string[][]) => {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const l of lists) for (const x of l) if (!seen.has(x.toLowerCase())) { seen.add(x.toLowerCase()); out.push(x); }
  return out;
};

/** Every usable sector's targeting, combined; sizes span the widest range given. */
export function combineTargeting(sectors: SectorContent[]): ResearchTargeting {
  const mins = sectors.map((s) => s.targeting.employeeMin).filter((n): n is number => n != null);
  const maxs = sectors.map((s) => s.targeting.employeeMax).filter((n): n is number => n != null);
  return {
    titles: union(sectors.map((s) => s.targeting.titles)),
    industries: union(sectors.map((s) => s.targeting.industries)),
    geographies: union(sectors.map((s) => s.targeting.geographies)),
    keywords: union(sectors.map((s) => s.targeting.keywords)),
    employeeMin: mins.length ? Math.min(...mins) : null,
    employeeMax: maxs.length ? Math.max(...maxs) : null,
  };
}

export async function researchTargeting(workspaceId: number): Promise<ResearchTargeting | null> {
  const sectors = await usableSectors(workspaceId).catch(() => []);
  return sectors.length ? combineTargeting(sectors) : null;
}

/** The research as a prompt section for ICP inference; "" when there is none. */
export function priorSection(sectors: SectorContent[]): string {
  if (!sectors.length) return "";
  const lines = sectors.slice(0, 12).map((s) => {
    const t = s.targeting;
    const parts = [
      t.titles.length ? `titles: ${t.titles.slice(0, 10).join(", ")}` : "",
      t.industries.length ? `industries: ${t.industries.slice(0, 6).join(", ")}` : "",
      t.geographies.length ? `places: ${t.geographies.slice(0, 6).join(", ")}` : "",
      t.employeeMin != null || t.employeeMax != null ? `size: ${t.employeeMin ?? 1}-${t.employeeMax ?? "any"} employees` : "",
      t.exclude.length ? `never target: ${t.exclude.slice(0, 8).join(", ")}` : "",
      s.buyers.painPoints.length ? `pains: ${s.buyers.painPoints.slice(0, 3).join("; ")}` : "",
    ].filter(Boolean);
    return `- ${s.name}${s.scores.fit != null ? ` (fit ${s.scores.fit}/5)` : ""}: ${parts.join(" | ")}`;
  });
  return [
    "## Your own market research (sectors marked Researched or Verified)",
    "Treat this as prior knowledge about who the company sells to. Where the deal data above is thin, lean on it; where the deals contradict it, follow the deals and say so in the rationale. Never-target words describe people to leave out (anti-patterns).",
    ...lines,
  ].join("\n");
}

export async function researchPriorForIcp(workspaceId: number): Promise<string> {
  return priorSection(await usableSectors(workspaceId).catch(() => []));
}

/** One targeting list for a campaign field left blank, under the workspace's ICP fallback. */
export function pickFallback(mode: IcpFallback, inferred: string[], researched: string[] | undefined | null): string[] {
  const r = researched ?? [];
  if (mode === "research") return r.length ? r : inferred;
  if (mode === "merged") return union([inferred, r]);
  return inferred;
}
