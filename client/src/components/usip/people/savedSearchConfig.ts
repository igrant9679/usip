/**
 * savedSearchConfig — the shape of a People saved search, and the two pure
 * functions that make a STORED one safe to apply.
 *
 * Plain .ts with no imports on purpose. peopleShared.tsx cannot be loaded from
 * a node test (its first JSX literal throws "React is not defined" under the
 * classic runtime), and the normalizer below is precisely the code that has to
 * be tested, so it lives where a test can reach it. peopleShared re-exports
 * everything here, so every existing import site is unchanged.
 *
 * A saved search stores the PAGE's UI state, not prospects.list's input: the
 * page translates on the way out (missingEmail → hasEmail:false, the promoted
 * tri-state → a boolean), so the vocabulary here is the one the removable
 * filter pills speak.
 */

/** Every column COLUMN_REGISTRY can render, in registry order. SOURCE OF TRUTH
 *  for ColumnKey — the union is derived from this tuple, so the two can never
 *  disagree. COLUMN_REGISTRY (peopleShared.tsx) and the zod enum in
 *  server/routers/savedSearches.ts mirror it; savedSearches.test.ts pins all
 *  three against each other. */
export const COLUMN_KEYS = [
  "name", "title", "velocityScore", "company", "emails", "phone",
  "actions", "links", "location", "employees", "industries", "keywords",
] as const;
export type ColumnKey = (typeof COLUMN_KEYS)[number];

/** Default displayed columns, in order. Industries/keywords stay available
 *  via Search settings → Fields (column customization), not the default view. */
export const DEFAULT_COLUMNS: ColumnKey[] = [
  "name", "title", "velocityScore", "company", "emails", "phone", "actions", "links", "location",
];

export const SORT_FIELD_VALUES = [
  "relevance", "name", "title", "emails", "company", "phone", "employees", "industries",
] as const;
export type SortField = (typeof SORT_FIELD_VALUES)[number];
export type SortDir = "asc" | "desc";

export type TierValue = "high" | "medium" | "low";
const TIER_VALUES: TierValue[] = ["high", "medium", "low"];
/** prospects.list types verificationStatus as an ENUM. A stored value outside
 *  it is not a cosmetic problem: tRPC rejects the whole list input and the
 *  People table renders an error instead of people. */
const VERIFICATION_VALUES = ["verified", "needs_review", "rejected"];

export type ViewFilters = {
  emailStatus?: string;
  hasEmail?: boolean;
  missingEmail?: boolean;
  verification?: string;
  promoted?: "all" | "promoted" | "not";
  enrolled?: "all" | "yes" | "no";
  search?: string;
  titleQ?: string;
  companyQ?: string;
  locationQ?: string;
  industryQ?: string;
  educationQ?: string;
  linkedinQ?: string;
  hasPhone?: boolean;
  hasLinkedin?: boolean;
  tiers?: TierValue[];
  seniorities?: string[];
};

export type ViewConfig = {
  columns: ColumnKey[];
  filters: ViewFilters;
  sort: { field: SortField; dir: SortDir };
};

export type SavedView = {
  id: string;
  name: string;
  /** The built-in "Default view" — not a row, cannot be renamed or deleted. */
  system?: boolean;
  config: ViewConfig;
};

export const SYSTEM_DEFAULT_VIEW: SavedView = {
  id: "default",
  name: "Default view",
  system: true,
  config: { columns: DEFAULT_COLUMNS, filters: {}, sort: { field: "relevance", dir: "desc" } },
};

/** Per-key caps, mirroring prospects.list's input schema (routers/prospects.ts)
 *  and the zod mirror in routers/savedSearches.ts. A value longer than the cap
 *  is TRUNCATED rather than dropped: dropping would silently widen the search
 *  the user saved. */
const TEXT_CAPS: Array<[keyof ViewFilters, number]> = [
  ["emailStatus", 40], ["verification", 40], ["search", 200], ["titleQ", 200],
  ["companyQ", 200], ["locationQ", 200], ["industryQ", 200], ["educationQ", 200],
  ["linkedinQ", 500],
];
const BOOL_KEYS: Array<keyof ViewFilters> = ["hasEmail", "missingEmail", "hasPhone", "hasLinkedin"];

function asRecord(v: unknown): Record<string, any> {
  // mysql2 hands a JSON column back parsed on some driver versions and as a
  // string on others, and a hand-edited row can be anything at all.
  let src = v;
  if (typeof src === "string") {
    try { src = JSON.parse(src); } catch { src = null; }
  }
  return src && typeof src === "object" && !Array.isArray(src) ? (src as Record<string, any>) : {};
}

function stringsOf(v: unknown, cap: number, max: number): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  v.forEach((x) => {
    if (typeof x === "string" && x && out.length < max) out.push(x.slice(0, cap));
  });
  return out;
}

/**
 * THE DEFENCE AGAINST A BAD STORED ROW (2026-09-20).
 *
 * `config` arrives from the database as `unknown`. Two failure modes are fatal
 * rather than cosmetic, and neither is fixable from the UI once it happens:
 *   · one retired ColumnKey makes People.tsx's `COLUMN_REGISTRY[key].label`
 *     throw, blanking the whole table for that user on every load;
 *   · one out-of-enum `verification` / `tiers` value makes prospects.list
 *     refuse the input, so the page renders its error state instead of people.
 * Anything unrecognised is dropped here, and an empty result falls back to the
 * system default rather than to nothing.
 */
export function normalizeViewConfig(raw: unknown): ViewConfig {
  const obj = asRecord(raw);

  const seen = Array.isArray(obj.columns) ? obj.columns : [];
  const columns: ColumnKey[] = [];
  seen.forEach((k: unknown) => {
    if (typeof k !== "string") return;
    if ((COLUMN_KEYS as readonly string[]).indexOf(k) < 0) return;
    if (columns.indexOf(k as ColumnKey) >= 0) return; // a duplicate key breaks the table's React keys
    columns.push(k as ColumnKey);
  });

  const rawSort = asRecord(obj.sort);
  const field = (SORT_FIELD_VALUES as readonly string[]).indexOf(rawSort.field) >= 0
    ? (rawSort.field as SortField)
    : "relevance";

  const rawF = asRecord(obj.filters);
  const filters: ViewFilters = {};
  TEXT_CAPS.forEach(([key, cap]) => {
    const v = rawF[key];
    if (typeof v === "string" && v) (filters as Record<string, any>)[key] = v.slice(0, cap);
  });
  if (filters.verification && VERIFICATION_VALUES.indexOf(filters.verification) < 0) delete filters.verification;
  BOOL_KEYS.forEach((key) => {
    if (rawF[key] === true) (filters as Record<string, any>)[key] = true;
  });
  if (rawF.promoted === "promoted" || rawF.promoted === "not") filters.promoted = rawF.promoted;
  if (rawF.enrolled === "yes" || rawF.enrolled === "no") filters.enrolled = rawF.enrolled;
  const tiers = stringsOf(rawF.tiers, 40, 3).filter((t) => TIER_VALUES.indexOf(t as TierValue) >= 0) as TierValue[];
  if (tiers.length) filters.tiers = tiers;
  const seniorities = stringsOf(rawF.seniorities, 40, 12);
  if (seniorities.length) filters.seniorities = seniorities;

  return {
    // .slice() so a restored view never hands the shared DEFAULT_COLUMNS array
    // to setVisibleColumns, where the Fields panel would edit it in place.
    columns: columns.length ? columns : DEFAULT_COLUMNS.slice(),
    filters,
    sort: { field, dir: rawSort.dir === "asc" ? "asc" : "desc" },
  };
}

/** A saved_searches row → the picker's view. The id is stringified so the
 *  `"default"` sentinel and DefaultViewMenu's id comparisons keep working. */
export function rowToSavedView(row: { id: number | string; name: string; config: unknown }): SavedView {
  return { id: String(row.id), name: row.name, config: normalizeViewConfig(row.config) };
}
