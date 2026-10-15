/**
 * Research reports (owner, 2026-10-15: "I should be able to see a full set of
 * reports like you see in the Downstream app"). Read-only views over the
 * research a workspace already holds: a market's overview, the sector
 * scorecard, side by side, messaging, funders and programs, competitors,
 * glossary, sources and accuracy, open questions, briefs and results.
 *
 * Everything here is pure, computed from MarketContent and SectorContent, so
 * the reports never disagree with the research pages they summarise.
 */
import {
  SECTOR_SCORE_KEYS,
  type MarketContent, type ResearchSourceLink, type ResearchStatus, type SectorContent, type SectorScoreKey,
} from "./researchShape";

export type ReportSector = { id: number; content: SectorContent };

/* ── The scorecard ──────────────────────────────────────────────────────── */

export type ScoreWeights = Record<SectorScoreKey, number>;
export const WEIGHT_CHOICES = [0, 1, 2, 3] as const;
export const DEFAULT_WEIGHTS: ScoreWeights = { reach: 1, money: 1, pain: 1, fit: 1, access: 1 };

export function cleanWeights(raw: unknown): ScoreWeights {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const out = { ...DEFAULT_WEIGHTS };
  for (const k of SECTOR_SCORE_KEYS) {
    const n = Number(o[k]);
    if ((WEIGHT_CHOICES as readonly number[]).includes(n)) out[k] = n;
  }
  return out;
}

/**
 * A sector's score out of 100: its 1 to 5 scores averaged by weight. A score
 * nobody set is left out rather than counted as zero; with none set (or every
 * weight zero) there is no score.
 */
export function weightedScore(scores: Partial<Record<SectorScoreKey, number | null>>, weights: ScoreWeights): number | null {
  let sum = 0;
  let max = 0;
  for (const k of SECTOR_SCORE_KEYS) {
    const s = scores[k];
    const w = weights[k];
    if (s == null || !w) continue;
    sum += s * w;
    max += 5 * w;
  }
  return max ? Math.round((sum / max) * 100) : null;
}

/** Highest score first; sectors with no score last, by name. */
export function scorecard(sectors: ReportSector[], weights: ScoreWeights): (ReportSector & { score: number | null })[] {
  return sectors
    .map((s) => ({ ...s, score: weightedScore(s.content.scores, weights) }))
    .sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || a.content.name.localeCompare(b.content.name));
}

/* ── Overview ───────────────────────────────────────────────────────────── */

/** The figure a sector card leads with: its first market-size figure that has a value. */
export function headlineFigure(s: SectorContent): { value: string; label: string } | null {
  const f = s.facts.marketSize.find((m) => m.value.trim());
  return f ? { value: f.value, label: f.label } : null;
}

export function statusCounts(sectors: ReportSector[]): Record<ResearchStatus, number> {
  const out: Record<ResearchStatus, number> = { draft: 0, researched: 0, verified: 0 };
  for (const s of sectors) out[s.content.status]++;
  return out;
}

/* ── Funders and programs ───────────────────────────────────────────────── */

export type ProgramRow = SectorContent["facts"]["programs"][number] & { sectors: string[] };

/**
 * Every program the sectors name, once each (the same program named in two
 * sectors is one row listing both), grouped by the agency that runs it.
 */
export function programsByAgency(sectors: ReportSector[]): { agency: string; programs: ProgramRow[] }[] {
  const byKey = new Map<string, ProgramRow>();
  for (const s of sectors) {
    for (const p of s.content.facts.programs) {
      if (!p.name.trim()) continue;
      const key = `${p.agency.trim().toLowerCase()}|${p.name.trim().toLowerCase()}`;
      const row = byKey.get(key);
      if (row) { if (!row.sectors.includes(s.content.name)) row.sectors.push(s.content.name); }
      else byKey.set(key, { ...p, sectors: [s.content.name] });
    }
  }
  const groups = new Map<string, ProgramRow[]>();
  for (const p of Array.from(byKey.values())) {
    const agency = p.agency.trim() || "Agency not named";
    groups.set(agency, [...(groups.get(agency) ?? []), p]);
  }
  return Array.from(groups.entries())
    .map(([agency, programs]) => ({ agency, programs: programs.sort((a, b) => a.name.localeCompare(b.name)) }))
    .sort((a, b) => (a.agency === "Agency not named" ? 1 : b.agency === "Agency not named" ? -1 : b.programs.length - a.programs.length || a.agency.localeCompare(b.agency)));
}

/** Who passes the money on, across sectors, once each by name. */
export function intermediaries(sectors: ReportSector[]): { name: string; role: string; count: string; sectors: string[] }[] {
  const byName = new Map<string, { name: string; role: string; count: string; sectors: string[] }>();
  for (const s of sectors) {
    for (const i of s.content.facts.moneyFlow.intermediaries) {
      if (!i.name.trim()) continue;
      const key = i.name.trim().toLowerCase();
      const row = byName.get(key);
      if (row) { if (!row.sectors.includes(s.content.name)) row.sectors.push(s.content.name); }
      else byName.set(key, { ...i, sectors: [s.content.name] });
    }
  }
  return Array.from(byName.values()).sort((a, b) => b.sectors.length - a.sectors.length || a.name.localeCompare(b.name));
}

/* ── Sources, accuracy and open questions ───────────────────────────────── */

export type PageSources = { kind: "market" | "sector"; id: number; name: string; status: ResearchStatus; sources: number };

/** How many sources each page cites, and how many distinct links in all. */
export function sourceCounts(market: { id: number; content: MarketContent }, sectors: ReportSector[]): { pages: PageSources[]; distinct: number } {
  const links = new Set<string>();
  const add = (list: ResearchSourceLink[]) => { for (const l of list) if (l.url.trim()) links.add(l.url.trim().toLowerCase().replace(/\/+$/, "")); };
  add(market.content.sources);
  const pages: PageSources[] = [{ kind: "market", id: market.id, name: market.content.name, status: market.content.status, sources: market.content.sources.length }];
  for (const s of sectors) {
    add(s.content.sources);
    pages.push({ kind: "sector", id: s.id, name: s.content.name, status: s.content.status, sources: s.content.sources.length });
  }
  return { pages, distinct: links.size };
}

export type OpenQuestion = { kind: "market" | "sector"; id: number; name: string; question: string };

export function openQuestions(market: { id: number; content: MarketContent }, sectors: ReportSector[]): OpenQuestion[] {
  return [
    ...market.content.openQuestions.map((question) => ({ kind: "market" as const, id: market.id, name: market.content.name, question })),
    ...sectors.flatMap((s) => s.content.openQuestions.map((question) => ({ kind: "sector" as const, id: s.id, name: s.content.name, question }))),
  ];
}

/* ── Competitors ────────────────────────────────────────────────────────── */

export function competitorsByCategory(market: MarketContent): { category: string; competitors: MarketContent["competitors"] }[] {
  const groups = new Map<string, MarketContent["competitors"]>();
  for (const c of market.competitors) {
    const cat = c.category.trim() || "Other";
    groups.set(cat, [...(groups.get(cat) ?? []), c]);
  }
  return Array.from(groups.entries())
    .map(([category, competitors]) => ({ category, competitors }))
    .sort((a, b) => (a.category === "Other" ? 1 : b.category === "Other" ? -1 : b.competitors.length - a.competitors.length || a.category.localeCompare(b.category)));
}
