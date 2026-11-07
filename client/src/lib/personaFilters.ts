/**
 * Search and filters for the Personas page (audit 2026-10-20, U18). Pure, so
 * the page and its test read the same rules.
 */
import { icpLabels } from "@shared/icpShape";
import { personaResearchCompleteness } from "@shared/researchShape";

export type PersonaFilter = {
  /** Words that must each appear in the name, description, titles, industries, places, keywords or sector. */
  q: string;
  /** Any sector, personas in no sector, or one sector's id. */
  sector: "any" | "none" | number;
  research: "any" | "complete" | "partial" | "none";
  use: "any" | "used" | "unused";
};

export const NO_PERSONA_FILTER: PersonaFilter = { q: "", sector: "any", research: "any", use: "any" };

export type PersonaLike = {
  name: string;
  description?: string | null;
  targetTitles?: unknown;
  targetIndustries?: unknown;
  targetGeographies?: unknown;
  keywords?: unknown;
  sectorId?: number | null;
  cares?: string | null;
  pains?: unknown;
  objections?: unknown;
  angle?: string | null;
  campaignCount?: number;
};

export function isFiltering(f: PersonaFilter): boolean {
  return f.q.trim() !== "" || f.sector !== "any" || f.research !== "any" || f.use !== "any";
}

export function filterPersonas<T extends PersonaLike>(list: T[], f: PersonaFilter, sectorName: Map<number, string> = new Map()): T[] {
  const words = f.q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return list.filter((p) => {
    if (f.sector === "none" && p.sectorId != null) return false;
    if (typeof f.sector === "number" && p.sectorId !== f.sector) return false;
    if (f.research !== "any" && personaResearchCompleteness(p).level !== f.research) return false;
    const used = (p.campaignCount ?? 0) > 0;
    if (f.use === "used" && !used) return false;
    if (f.use === "unused" && used) return false;
    if (words.length === 0) return true;
    const hay = [
      p.name,
      p.description ?? "",
      ...icpLabels(p.targetTitles as never, "title"),
      ...icpLabels(p.targetIndustries as never, "industry"),
      ...icpLabels(p.targetGeographies as never, "geography"),
      ...(Array.isArray(p.keywords) ? (p.keywords as unknown[]).map(String) : []),
      p.sectorId != null ? sectorName.get(p.sectorId) ?? "" : "",
    ].join(" ").toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}
