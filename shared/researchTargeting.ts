/**
 * Research drives targeting (Research module, phase 4; owner, 2026-10-14).
 *
 * Two pure pieces the server and the client share:
 *   - a sector's targeting (and a persona's titles) as a campaign's
 *     icpOverrides, so "Create campaign from sector" and "Find Prospects from
 *     a sector" start from the same search the research describes;
 *   - never-target words: short words or phrases that mark a person or
 *     company as off target. Matched case-insensitively as WHOLE words inside
 *     the title, the company name and the industry, so "intern" rejects an
 *     "Intern" but never an "International Sales Director".
 */
import type { SectorTargeting } from "./researchShape";

export type NeverTargetField = "title" | "company" | "industry";
export type NeverTargetHit = { word: string; field: NeverTargetField };

const norm = (s: string) => ` ${s.toLowerCase().replace(/[^a-z0-9&]+/g, " ").replace(/\s+/g, " ").trim()} `;

/** The never-target words in a list, cleaned and deduplicated. */
export function cleanNeverTarget(words: unknown): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const w of Array.isArray(words) ? words : []) {
    if (typeof w !== "string") continue;
    const n = norm(w).trim();
    if (n.length < 2 || seen.has(n)) continue;
    seen.add(n);
    out.push(w.trim());
  }
  return out;
}

/** The first never-target word found in the person, title first, or null. */
export function neverTargetHit(
  words: string[],
  person: { title?: string | null; company?: string | null; industry?: string | null },
): NeverTargetHit | null {
  if (!words.length) return null;
  const fields: [NeverTargetField, string | null | undefined][] = [["title", person.title], ["company", person.company], ["industry", person.industry]];
  for (const [field, value] of fields) {
    if (!value) continue;
    const hay = norm(value);
    for (const w of words) {
      const needle = norm(w);
      if (needle.trim().length >= 2 && hay.includes(needle)) return { word: w, field };
    }
  }
  return null;
}

export function neverTargetReason(hit: NeverTargetHit): string {
  const where = hit.field === "company" ? "company name" : hit.field;
  return `Never-target word "${hit.word}" in ${where}`;
}

/** The never-target words a campaign's icpOverrides carries (key `exclude`). */
export function neverTargetFromOverrides(icpOverrides: unknown): string[] {
  const o = icpOverrides && typeof icpOverrides === "object" ? (icpOverrides as Record<string, unknown>) : {};
  return cleanNeverTarget(o.exclude);
}

/**
 * A sector's targeting as a campaign's icpOverrides. A persona's own titles,
 * when it has any, are the narrower target and win over the sector's.
 */
export function overridesFromSector(t: SectorTargeting, personaTitles: string[] = []): Record<string, unknown> {
  const titles = personaTitles.length ? personaTitles : t.titles;
  return {
    targetTitles: titles,
    targetIndustries: t.industries,
    targetGeographies: t.geographies,
    keywords: t.keywords,
    ...(t.employeeMin != null ? { employeeMin: t.employeeMin } : {}),
    ...(t.employeeMax != null ? { employeeMax: t.employeeMax } : {}),
    exclude: cleanNeverTarget(t.exclude),
  };
}

/** Splits candidates into those to keep and those a never-target word rules out (with the word and where). */
export function dropNeverTarget<T extends Record<string, unknown>>(rows: T[], words: string[]): { kept: T[]; dropped: { row: T; hit: NeverTargetHit }[] } {
  if (!words.length) return { kept: rows, dropped: [] };
  const kept: T[] = [];
  const dropped: { row: T; hit: NeverTargetHit }[] = [];
  const s = (v: unknown) => (typeof v === "string" ? v : null);
  for (const row of rows) {
    const hit = neverTargetHit(words, { title: s(row.title), company: s(row.companyName) ?? s(row.company), industry: s(row.industry) });
    if (hit) dropped.push({ row, hit });
    else kept.push(row);
  }
  return { kept, dropped };
}
