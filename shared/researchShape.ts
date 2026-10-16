/**
 * researchShape.ts — the one shape for Research markets and sectors.
 *
 * A workspace researches any number of MARKETS (an industry or research area)
 * and, inside each, SECTORS (a group of organizations that buy alike). The
 * names were chosen because "Segments" is already Velocity's rule-based contact
 * lists (owner, 2026-10-14). The structure follows Downstream's segment
 * (github.com/igrant9679/downstream, docs/velocity-integration.md, file v2)
 * with its grant-specific facts made optional, so any industry fits and the
 * Phase 5 importer maps onto it field for field.
 *
 * Three writers will fill these: a person by hand (Phase 1), the AI research
 * engine (Phase 2) and the Downstream importer (Phase 5). All three go through
 * `cleanMarketContent` / `cleanSectorContent`, so the rules below hold whoever
 * wrote the record:
 *   - every string is trimmed and capped; lists are deduplicated
 *     case-insensitively and capped;
 *   - research holds organizations, never people: a value that looks like an
 *     email address or a phone number is dropped and reported back, so the
 *     caller can say what was removed.
 */

export const RESEARCH_STATUSES = ["draft", "researched", "verified"] as const;
export type ResearchStatus = (typeof RESEARCH_STATUSES)[number];

export const RESEARCH_SOURCES = ["manual", "ai", "downstream"] as const;
export type ResearchSource = (typeof RESEARCH_SOURCES)[number];

export const RESEARCH_STATUS_LABEL: Record<ResearchStatus, string> = {
  draft: "Draft",
  researched: "Researched",
  verified: "Verified",
};

/** The five 1–5 scores a sector is ranked by. Fit is against the workspace's own offer. */
export const SECTOR_SCORE_KEYS = ["reach", "money", "pain", "fit", "access"] as const;
export type SectorScoreKey = (typeof SECTOR_SCORE_KEYS)[number];
export const SECTOR_SCORE_LABEL: Record<SectorScoreKey, string> = {
  reach: "Reach",
  money: "Money",
  pain: "Pain",
  fit: "Fit",
  access: "Access",
};

export type ResearchSourceLink = { title: string; url: string };

export type MarketContent = {
  name: string;
  tagline: string;
  status: ResearchStatus;
  overview: { headline: string; lede: string };
  openQuestions: string[];
  suggestedSectors: { name: string; why: string }[];
  glossary: { term: string; definition: string; source: string }[];
  competitors: { name: string; category: string; positioning: string; pricing: string; url: string }[];
  sources: ResearchSourceLink[];
};

export type SectorTargeting = {
  titles: string[];
  industries: string[];
  geographies: string[];
  keywords: string[];
  employeeMin: number | null;
  employeeMax: number | null;
  organizationTypes: string[];
  /** Never-target words, matched inside title, company name and industry (Phase 4). */
  exclude: string[];
};

export type SectorContent = {
  name: string;
  shortName: string;
  tagline: string;
  summary: string;
  status: ResearchStatus;
  /** The date the research describes, YYYY-MM-DD, or "" when unknown. */
  asOf: string;
  scores: Record<SectorScoreKey, number | null>;
  buyers: { roles: string[]; painPoints: string[] };
  targeting: SectorTargeting;
  messaging: { leadWith: string[]; avoid: string[]; vocabulary: string[]; sampleOpening: string };
  facts: {
    marketSize: { value: string; label: string; source: string }[];
    moneyFlow: { sources: string[]; intermediaries: { name: string; role: string; count: string }[]; recipients: { type: string; approxCount: string; notes: string }[] };
    programs: { name: string; agency: string; flow: string; purpose: string; typicalAward: string; url: string }[];
    buying: string[];
    obligations: string[];
    helpers: string[];
    policyWatch: string[];
  };
  openQuestions: string[];
  sources: ResearchSourceLink[];
};

/* ── Limits ─────────────────────────────────────────────────────────────── */

const SHORT = 200;
const LINE = 600;
const LONG = 6000;
const LIST = 60;
const ROWS = 100;

/* ── Personal data ──────────────────────────────────────────────────────── */

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
/**
 * North American numbers with separators or as ten bare digits, and
 * international numbers written with a leading "+". Deliberately narrower than
 * "lots of digits": a market size ("$1,250,000"), a year range ("2020 - 2025")
 * or a count ("12,000 districts") must survive.
 */
const PHONE_NANP = /(?:^|[^\d])(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]\d{4}(?!\d)|(?:^|[^\d$,.])\d{10}(?![\d,.])/;
const PHONE_INTL = /\+\d{1,3}[\s.-]?\(?\d{1,4}\)?(?:[\s.-]?\d{2,4}){2,4}(?!\d)/;

/** True when the text holds what looks like a personal email or phone number. */
export function looksPersonal(text: string): boolean {
  if (!text) return false;
  if (/mailto:/i.test(text) || /tel:/i.test(text)) return true;
  return EMAIL.test(text) || PHONE_NANP.test(text) || PHONE_INTL.test(text);
}

const isLink = (s: string) => /^https?:\/\//i.test(s);

/**
 * A link is judged as a link (2026-10-16): its digits are dates, report
 * numbers and document ids, so ten of them in a row are not a phone number
 * ("…/2026-05-27_R48958_6ead…1504746904…" is a real source). A link is
 * personal only when it holds an email address.
 */
export function looksPersonalValue(text: string): boolean {
  if (!text) return false;
  return isLink(text.trim()) ? EMAIL.test(text) : looksPersonal(text);
}

/* ── Cleaning ───────────────────────────────────────────────────────────── */

type Dropped = string[];

function clip(value: unknown, max: number, dropped: Dropped, where: string): string {
  const s = typeof value === "string" ? value.trim() : typeof value === "number" && Number.isFinite(value) ? String(value) : "";
  if (!s) return "";
  if (looksPersonalValue(s)) {
    dropped.push(where);
    return "";
  }
  return s.length > max ? s.slice(0, max).trimEnd() : s;
}

function list(value: unknown, max: number, dropped: Dropped, where: string, cap = LIST): string[] {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split("\n") : [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const s = clip(item, max, dropped, where);
    if (!s || seen.has(s.toLowerCase())) continue;
    seen.add(s.toLowerCase());
    out.push(s);
    if (out.length >= cap) break;
  }
  return out;
}

/** A list of objects: each field cleaned, rows with nothing in `key` dropped. */
function rows<F extends Record<string, number>>(
  value: unknown,
  fields: F,
  key: keyof F & string,
  dropped: Dropped,
  where: string,
): Record<keyof F & string, string>[] {
  type K = keyof F & string;
  if (!Array.isArray(value)) return [];
  const out: Record<K, string>[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const o = item as Record<string, unknown>;
    const row = {} as Record<K, string>;
    for (const f of Object.keys(fields) as K[]) row[f] = clip(o[f], fields[f], dropped, `${where}.${f}`);
    if (!row[key]) continue;
    out.push(row);
    if (out.length >= ROWS) break;
  }
  return out;
}

function url(value: unknown, dropped: Dropped, where: string): string {
  const s = clip(value, 1000, dropped, where);
  if (!s) return "";
  return /^https?:\/\//i.test(s) ? s : "";
}

function sources(value: unknown, dropped: Dropped): ResearchSourceLink[] {
  const out: ResearchSourceLink[] = [];
  const seen = new Set<string>();
  for (const r of rows(value, { title: LINE, url: 1000 }, "url", dropped, "sources")) {
    const u = url(r.url, dropped, "sources.url");
    if (!u || seen.has(u.toLowerCase())) continue;
    seen.add(u.toLowerCase());
    out.push({ title: r.title || u, url: u });
  }
  return out;
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

function status(v: unknown): ResearchStatus {
  return (RESEARCH_STATUSES as readonly string[]).includes(v as string) ? (v as ResearchStatus) : "draft";
}

function score(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  if (!Number.isFinite(n)) return null;
  return Math.min(5, Math.max(1, Math.round(n)));
}

function size(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v.replace(/,/g, "")) : NaN;
  if (!Number.isFinite(n) || n < 1) return null;
  return Math.min(10_000_000, Math.round(n));
}

/** YYYY-MM-DD for a real calendar day ("2026-02-30" is not one), else "". */
function isoDate(v: unknown): string {
  const s = typeof v === "string" ? v.trim() : v instanceof Date ? v.toISOString().slice(0, 10) : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return "";
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s ? s : "";
}

export type Cleaned<T> = { content: T; dropped: string[] };

export function cleanMarketContent(input: unknown): Cleaned<MarketContent> {
  const d: Dropped = [];
  const o = obj(input);
  const ov = obj(o.overview);
  const content: MarketContent = {
    name: clip(o.name, 160, d, "name"),
    tagline: clip(o.tagline, 300, d, "tagline"),
    status: status(o.status),
    overview: { headline: clip(ov.headline, LINE, d, "overview.headline"), lede: clip(ov.lede, LONG, d, "overview.lede") },
    openQuestions: list(o.openQuestions, LINE, d, "openQuestions"),
    suggestedSectors: rows(o.suggestedSectors, { name: 160, why: LINE }, "name", d, "suggestedSectors"),
    glossary: rows(o.glossary, { term: SHORT, definition: 2000, source: 1000 }, "term", d, "glossary"),
    competitors: rows(o.competitors, { name: SHORT, category: SHORT, positioning: 2000, pricing: LINE, url: 1000 }, "name", d, "competitors")
      .map((c) => ({ ...c, url: url(c.url, d, "competitors.url") })),
    sources: sources(o.sources, d),
  };
  return { content, dropped: d };
}

export function cleanSectorContent(input: unknown): Cleaned<SectorContent> {
  const d: Dropped = [];
  const o = obj(input);
  const sc = obj(o.scores);
  const b = obj(o.buyers);
  const t = obj(o.targeting);
  const m = obj(o.messaging);
  const f = obj(o.facts);
  const mf = obj(f.moneyFlow);
  let employeeMin = size(t.employeeMin);
  let employeeMax = size(t.employeeMax);
  if (employeeMin != null && employeeMax != null && employeeMin > employeeMax) [employeeMin, employeeMax] = [employeeMax, employeeMin];
  const scores = {} as Record<SectorScoreKey, number | null>;
  for (const k of SECTOR_SCORE_KEYS) scores[k] = score(sc[k]);
  const content: SectorContent = {
    name: clip(o.name, 160, d, "name"),
    shortName: clip(o.shortName, 60, d, "shortName"),
    tagline: clip(o.tagline, 300, d, "tagline"),
    summary: clip(o.summary, LONG, d, "summary"),
    status: status(o.status),
    asOf: isoDate(o.asOf),
    scores,
    buyers: { roles: list(b.roles, SHORT, d, "buyers.roles"), painPoints: list(b.painPoints, LINE, d, "buyers.painPoints") },
    targeting: {
      titles: list(t.titles, 120, d, "targeting.titles"),
      industries: list(t.industries, 120, d, "targeting.industries"),
      geographies: list(t.geographies, 120, d, "targeting.geographies"),
      keywords: list(t.keywords, 120, d, "targeting.keywords"),
      employeeMin,
      employeeMax,
      organizationTypes: list(t.organizationTypes, 120, d, "targeting.organizationTypes"),
      exclude: list(t.exclude, 80, d, "targeting.exclude"),
    },
    messaging: {
      leadWith: list(m.leadWith, LINE, d, "messaging.leadWith"),
      avoid: list(m.avoid, LINE, d, "messaging.avoid"),
      vocabulary: list(m.vocabulary, SHORT, d, "messaging.vocabulary"),
      sampleOpening: clip(m.sampleOpening, 2000, d, "messaging.sampleOpening"),
    },
    facts: {
      marketSize: rows(f.marketSize, { value: SHORT, label: LINE, source: 1000 }, "value", d, "facts.marketSize"),
      moneyFlow: {
        sources: list(mf.sources, LINE, d, "facts.moneyFlow.sources"),
        intermediaries: rows(mf.intermediaries, { name: SHORT, role: LINE, count: SHORT }, "name", d, "facts.moneyFlow.intermediaries"),
        recipients: rows(mf.recipients, { type: SHORT, approxCount: SHORT, notes: LINE }, "type", d, "facts.moneyFlow.recipients"),
      },
      programs: rows(f.programs, { name: SHORT, agency: SHORT, flow: LINE, purpose: LINE, typicalAward: SHORT, url: 1000 }, "name", d, "facts.programs")
        .map((p) => ({ ...p, url: url(p.url, d, "facts.programs.url") })),
      buying: list(f.buying, LINE, d, "facts.buying"),
      obligations: list(f.obligations, LINE, d, "facts.obligations"),
      helpers: list(f.helpers, LINE, d, "facts.helpers"),
      policyWatch: list(f.policyWatch, LINE, d, "facts.policyWatch"),
    },
    openQuestions: list(o.openQuestions, LINE, d, "openQuestions"),
    sources: sources(o.sources, d),
  };
  return { content, dropped: d };
}

export const emptyMarketContent = (name = ""): MarketContent => cleanMarketContent({ name }).content;
export const emptySectorContent = (name = ""): SectorContent => cleanSectorContent({ name }).content;

/* ── Version history ────────────────────────────────────────────────────── */

/** Readable names for the parts a version can change, in page order. */
export const RESEARCH_PART_LABEL: Record<string, string> = {
  name: "Name",
  shortName: "Short name",
  tagline: "Tagline",
  summary: "Summary",
  status: "Status",
  asOf: "As of",
  scores: "Scores",
  buyers: "Buyers and pains",
  targeting: "Targeting",
  messaging: "Messaging",
  facts: "Market facts",
  overview: "Overview",
  suggestedSectors: "Suggested sectors",
  glossary: "Glossary",
  competitors: "Competitors",
  openQuestions: "Open questions",
  sources: "Sources",
};

/** The top-level parts that differ between two versions, in page order. */
export function changedParts(before: unknown, after: unknown): string[] {
  const a = obj(before);
  const b = obj(after);
  const out: string[] = [];
  for (const key of Object.keys(RESEARCH_PART_LABEL)) {
    if (!(key in a) && !(key in b)) continue;
    if (JSON.stringify(a[key] ?? null) !== JSON.stringify(b[key] ?? null)) out.push(key);
  }
  return out;
}

/* ── Personas ───────────────────────────────────────────────────────────── */

/** What the AI writers will need about a buyer, beyond who to search for. */
export type PersonaResearch = { cares: string; pains: string[]; objections: string[]; angle: string };

export function cleanPersonaResearch(input: unknown): Cleaned<PersonaResearch> {
  const d: Dropped = [];
  const o = obj(input);
  return {
    content: {
      cares: clip(o.cares, 2000, d, "cares"),
      pains: list(o.pains, LINE, d, "pains", 30),
      objections: list(o.objections, LINE, d, "objections", 30),
      angle: clip(o.angle, 2000, d, "angle"),
    },
    dropped: d,
  };
}

/* ── Accepting an AI research draft, part by part ───────────────────────── */

/** The parts of a sector draft a person can take or leave. Status is never one: a person sets it. */
export const SECTOR_RUN_PARTS = ["summary", "scores", "buyers", "targeting", "messaging", "facts", "openQuestions", "sources"] as const;
export const MARKET_RUN_PARTS = ["overview", "suggestedSectors", "glossary", "competitors", "openQuestions", "sources"] as const;
export type SectorRunPart = (typeof SECTOR_RUN_PARTS)[number];
export type MarketRunPart = (typeof MARKET_RUN_PARTS)[number];

export const RUN_PART_LABEL: Record<string, string> = {
  summary: "Summary and tagline",
  overview: "Overview and tagline",
  scores: "Scores",
  buyers: "Buyers and pains",
  targeting: "Targeting",
  messaging: "Messaging",
  facts: "Market facts",
  suggestedSectors: "Suggested sectors",
  glossary: "Glossary",
  competitors: "Competitors",
  openQuestions: "Open questions",
  sources: "Sources (added to the ones you have)",
};

/** Sources from both, the current ones first, each link once. */
function unionSources(a: ResearchSourceLink[], b: ResearchSourceLink[]): ResearchSourceLink[] {
  const seen = new Set<string>();
  const out: ResearchSourceLink[] = [];
  for (const s of [...a, ...b]) {
    const k = s.url.trim().toLowerCase();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
}

/**
 * The sector after taking the chosen parts of a draft. Every taken part
 * replaces the current one (the run was asked to check and correct it),
 * except sources, which are added to. Name and status stay the person's.
 */
export function mergeSectorParts(current: SectorContent, draft: SectorContent, parts: readonly string[]): SectorContent {
  const take = new Set(parts.filter((p) => (SECTOR_RUN_PARTS as readonly string[]).includes(p)));
  const next: SectorContent = { ...current };
  if (take.has("summary")) {
    next.tagline = draft.tagline || current.tagline;
    next.summary = draft.summary || current.summary;
    next.shortName = current.shortName || draft.shortName;
  }
  if (take.has("scores")) next.scores = draft.scores;
  if (take.has("buyers")) next.buyers = draft.buyers;
  if (take.has("targeting")) next.targeting = draft.targeting;
  if (take.has("messaging")) next.messaging = draft.messaging;
  if (take.has("facts")) next.facts = draft.facts;
  if (take.has("openQuestions")) next.openQuestions = draft.openQuestions;
  if (take.has("sources")) next.sources = unionSources(current.sources, draft.sources);
  if (take.size > 0 && draft.asOf) next.asOf = draft.asOf;
  return next;
}

export function mergeMarketParts(current: MarketContent, draft: MarketContent, parts: readonly string[]): MarketContent {
  const take = new Set(parts.filter((p) => (MARKET_RUN_PARTS as readonly string[]).includes(p)));
  const next: MarketContent = { ...current };
  if (take.has("overview")) {
    next.tagline = draft.tagline || current.tagline;
    next.overview = draft.overview;
  }
  if (take.has("suggestedSectors")) next.suggestedSectors = draft.suggestedSectors;
  if (take.has("glossary")) next.glossary = draft.glossary;
  if (take.has("competitors")) next.competitors = draft.competitors;
  if (take.has("openQuestions")) next.openQuestions = draft.openQuestions;
  if (take.has("sources")) next.sources = unionSources(current.sources, draft.sources);
  return next;
}
