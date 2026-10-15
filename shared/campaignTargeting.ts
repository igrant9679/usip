/**
 * A Revenue Engine campaign's targeting, as the Settings tab edits it
 * (owner, 2026-10-15: "add a targeting editor to campaign Settings").
 *
 * The targeting lives in are_campaigns.icpOverrides, which
 * are.campaigns.update replaces whole. Lists there can be plain strings (the
 * New Campaign form, Create campaign from a sector) or weighted objects
 * copied from an ICP or persona, and the engine reads them through icpLabels.
 * So an edit writes back only the fields that changed, as plain labels; a
 * field left alone keeps its stored form, and keys this editor does not show
 * survive. An emptied field is removed, which lets discovery fall back to the
 * workspace's ICP for it, as a field the campaign never set always has.
 */
import { icpLabels } from "./icpShape";

export type CampaignTargeting = {
  titles: string[];
  industries: string[];
  places: string[];
  keywords: string[];
  /** Never-target words: whole-word matches on title, company and industry reject the person. */
  exclude: string[];
  employeeMin: number | null;
  employeeMax: number | null;
};

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** Plain, trimmed, case-insensitively unique strings. */
function strings(v: unknown): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const x of Array.isArray(v) ? v : []) {
    const s = typeof x === "string" ? x.trim() : "";
    if (!s || seen.has(s.toLowerCase())) continue;
    seen.add(s.toLowerCase());
    out.push(s.slice(0, 200));
  }
  return out;
}

function size(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

export function targetingFromOverrides(raw: unknown): CampaignTargeting {
  const o = obj(raw);
  return {
    titles: icpLabels(o.targetTitles, "title"),
    industries: icpLabels(o.targetIndustries, "industry"),
    places: icpLabels(o.targetGeographies, "geography"),
    keywords: strings(o.keywords),
    exclude: strings(o.exclude),
    employeeMin: size(o.employeeMin),
    employeeMax: size(o.employeeMax),
  };
}

const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

export function sameTargeting(a: CampaignTargeting, b: CampaignTargeting): boolean {
  return sameList(a.titles, b.titles) && sameList(a.industries, b.industries) && sameList(a.places, b.places)
    && sameList(a.keywords, b.keywords) && sameList(a.exclude, b.exclude)
    && a.employeeMin === b.employeeMin && a.employeeMax === b.employeeMax;
}

const LISTS = [
  ["titles", "targetTitles"],
  ["industries", "targetIndustries"],
  ["places", "targetGeographies"],
  ["keywords", "keywords"],
  ["exclude", "exclude"],
] as const;

/** The stored overrides with only the changed fields written back. */
export function overridesWithTargeting(raw: unknown, next: CampaignTargeting): Record<string, unknown> {
  const out = { ...obj(raw) };
  const before = targetingFromOverrides(raw);
  for (const [field, key] of LISTS) {
    const value = strings(next[field]);
    if (sameList(before[field], value)) continue;
    if (value.length) out[key] = value;
    else delete out[key];
  }
  for (const key of ["employeeMin", "employeeMax"] as const) {
    const value = size(next[key]);
    if (value === before[key]) continue;
    if (value == null) delete out[key];
    else out[key] = value;
  }
  return out;
}

/** What stops a save, or null. */
export function targetingProblem(t: CampaignTargeting): string | null {
  if (t.employeeMin != null && t.employeeMax != null && t.employeeMin > t.employeeMax) {
    return "The smallest company size is larger than the largest.";
  }
  return null;
}
