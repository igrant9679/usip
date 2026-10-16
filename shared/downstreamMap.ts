/**
 * Downstream export (v2) → Velocity's Research store (Research module, phase
 * 5). Pure functions, shared so the preview and the import agree:
 *
 *   Downstream workspace → a research MARKET (overview, glossary, competitors;
 *                          its funders and market statistics as extras)
 *   segment              → a research SECTOR (effective targeting, pains,
 *                          avoid rules, words, facts, sources, scores)
 *   persona              → a Velocity PERSONA in that sector
 *   organization         → an ACCOUNT carrying its award (a sourced hook)
 *
 * Each company narrows the market with its own link settings
 * (effectiveDownstreamTargeting). Seller layers — anything Downstream wrote
 * for CommunityForce's own product — are used only when the file's audience is
 * "seller" AND the link says it is this company's (sellerAllowed); otherwise
 * they are never stored or shown.
 */
import type { DownstreamFile, DownstreamOrg, DownstreamPersona, DownstreamSegment } from "./downstreamContract";
import { cleanMarketContent, cleanSectorContent, type MarketContent, type SectorContent, type SectorTargeting } from "./researchShape";
import { cleanNeverTarget } from "./researchTargeting";

/* ── Link settings ──────────────────────────────────────────────────────── */

export type DownstreamLinkSettings = {
  /** Places this company sells into; when set, REPLACES every segment's geographies. */
  territory: string[];
  /** Company size; when set, replaces the segment's. */
  employeeMin: number | null;
  employeeMax: number | null;
  /** Added to / removed from every segment's and persona's titles (removal ignores case). */
  addTitles: string[];
  removeTitles: string[];
  /** Never-target words, always ADDED to the segment's. */
  exclude: string[];
  /** Segment refs this company imports. Default: none ticked. */
  segments: string[];
};

export const DEFAULT_LINK_SETTINGS: DownstreamLinkSettings = { territory: [], employeeMin: null, employeeMax: null, addTitles: [], removeTitles: [], exclude: [], segments: [] };

const strs = (v: unknown, max = 200, cap = 200): string[] => {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const x of Array.isArray(v) ? v : []) {
    if (typeof x !== "string") continue;
    const s = x.trim().slice(0, max);
    if (!s || seen.has(s.toLowerCase())) continue;
    seen.add(s.toLowerCase());
    out.push(s);
    if (out.length >= cap) break;
  }
  return out;
};
const size = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 1 ? Math.round(v) : null);

export function cleanLinkSettings(v: unknown): DownstreamLinkSettings {
  const o = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  return {
    territory: strs(o.territory, 120, 50),
    employeeMin: size(o.employeeMin),
    employeeMax: size(o.employeeMax),
    addTitles: strs(o.addTitles, 120, 50),
    removeTitles: strs(o.removeTitles, 120, 50),
    exclude: cleanNeverTarget(o.exclude).slice(0, 50),
    segments: strs(o.segments, 300, 200),
  };
}

/** A segment's targeting after this company's settings. */
export function effectiveDownstreamTargeting(t: DownstreamSegment["targeting"], s: DownstreamLinkSettings): SectorTargeting {
  const remove = new Set(s.removeTitles.map((x) => x.toLowerCase()));
  const titles = strs([...t.titles.filter((x) => !remove.has(x.trim().toLowerCase())), ...s.addTitles], 120);
  return cleanSectorContent({
    targeting: {
      titles,
      industries: t.industries,
      geographies: s.territory.length ? s.territory : t.geographies,
      keywords: t.keywords,
      employeeMin: s.employeeMin ?? t.employeeMin,
      employeeMax: s.employeeMax ?? t.employeeMax,
      organizationTypes: t.organizationTypes,
      exclude: [...t.exclude, ...s.exclude],
    },
  }).content.targeting;
}

export function sellerAllowed(file: Pick<DownstreamFile, "audience">, useSellerMessaging: boolean): boolean {
  return file.audience === "seller" && useSellerMessaging === true;
}

/* ── Segment → sector ───────────────────────────────────────────────────── */

export function segmentToSector(seg: DownstreamSegment, settings: DownstreamLinkSettings, seller: boolean): SectorContent {
  const m = seg.market;
  const sl = seller ? seg.seller : undefined;
  return cleanSectorContent({
    name: seg.name,
    shortName: seg.shortName,
    tagline: seg.tagline,
    summary: seg.summary,
    status: seg.research.status,
    asOf: seg.research.asOf.slice(0, 10),
    scores: {
      reach: seg.research.scores.reach ?? null,
      money: seg.research.scores.money ?? null,
      pain: seg.research.scores.pain ?? null,
      access: seg.research.scores.access ?? null,
      // Fit is fit to the SELLER's product: only the seller layer knows it.
      fit: sl?.fitScore ?? null,
    },
    buyers: { roles: seg.buyerRoles, painPoints: m.painPoints },
    targeting: effectiveDownstreamTargeting(seg.targeting, settings),
    messaging: {
      leadWith: sl?.leadWith ?? [],
      avoid: [...m.avoid, ...(sl?.avoid ?? [])],
      vocabulary: m.vocabulary,
      sampleOpening: sl?.sampleOpeningLine ?? "",
    },
    facts: {
      marketSize: m.marketSize ?? [],
      moneyFlow: { sources: m.moneyFlow?.sources ?? [], intermediaries: m.moneyFlow?.intermediaries ?? [], recipients: m.moneyFlow?.recipients ?? [] },
      programs: m.fundingPrograms,
      buying: m.applying ?? [],
      obligations: m.postAwardReporting ?? [],
      helpers: m.currentHelpers ?? [],
      policyWatch: m.policyWatch ?? [],
    },
    openQuestions: [],
    sources: seg.sources,
  }).content;
}

/* ── Knowledge → market ─────────────────────────────────────────────────── */

export type DownstreamMarketExtras = {
  stats: Record<string, unknown> | null;
  funders: { ref: string; name: string; shortName: string; summary: string; website: string; programs: { name: string; purpose: string; award: string; url: string }[]; reportingCalendar: string; closeoutDays: number | null }[];
};

export function knowledgeToMarket(file: DownstreamFile, untickedSegments: DownstreamSegment[]): MarketContent {
  const k = file.knowledge;
  return cleanMarketContent({
    name: file.source.workspace.name,
    tagline: file.source.workspace.tagline ?? "",
    status: "researched",
    overview: { headline: k?.overview?.headline ?? "", lede: k?.overview?.lede ?? "" },
    glossary: k?.glossary ?? [],
    competitors: k?.competitors ?? [],
    // Segments this company did not import stay visible as suggestions.
    suggestedSectors: untickedSegments.map((s) => ({ name: s.name, why: `${s.tagline} (in the Downstream export; tick it on the next import to bring it in)` })),
    openQuestions: [],
    sources: [],
  }).content;
}

export function marketExtras(file: DownstreamFile, seller: boolean): DownstreamMarketExtras {
  const st = file.marketStats;
  let stats: Record<string, unknown> | null = null;
  if (st) {
    const { tiers, pools, ...rest } = st;
    stats = seller ? { ...rest, tiers, pools } : rest;
  }
  return {
    stats,
    funders: (file.knowledge?.funders ?? []).slice(0, 50).map((f) => ({
      ref: f.ref,
      name: f.name,
      shortName: f.shortName,
      summary: (f.summary ?? "").slice(0, 1000),
      website: f.website ?? "",
      programs: (f.programs ?? []).slice(0, 30).map((p) => ({ name: p.name ?? "", purpose: (p.purpose ?? "").slice(0, 400), award: p.award ?? "", url: p.url ?? "" })),
      reportingCalendar: (f.reportingCalendar ?? "").slice(0, 500),
      closeoutDays: f.closeoutDays ?? null,
    })),
  };
}

/* ── Persona → persona ──────────────────────────────────────────────────── */

export type ImportedPersona = {
  name: string;
  targetTitles: string[];
  targetIndustries: string[];
  targetGeographies: string[];
  keywords: string[];
  employeeMin: number | null;
  employeeMax: number | null;
  cares: string;
  pains: string[];
  objections: string[];
  angle: string;
  suggested: boolean;
};

export function personaFromDownstream(p: DownstreamPersona, sectorTargeting: SectorTargeting, settings: DownstreamLinkSettings): ImportedPersona {
  const remove = new Set(settings.removeTitles.map((x) => x.toLowerCase()));
  const own = (p.titles ?? []).filter((x) => !remove.has(x.trim().toLowerCase()));
  return {
    name: p.name.slice(0, 120),
    targetTitles: own.length ? strs([...own, ...settings.addTitles], 120) : sectorTargeting.titles,
    targetIndustries: sectorTargeting.industries,
    targetGeographies: sectorTargeting.geographies,
    keywords: sectorTargeting.keywords,
    employeeMin: sectorTargeting.employeeMin,
    employeeMax: sectorTargeting.employeeMax,
    cares: (p.cares ?? "").slice(0, 2000),
    pains: strs(p.pains, 600, 30),
    objections: strs(p.objections, 600, 30),
    angle: (p.angle ?? "").slice(0, 2000),
    suggested: p.written === false,
  };
}

/* ── Organization → account ─────────────────────────────────────────────── */

export type DownstreamAward = NonNullable<DownstreamOrg["award"]>;

export type ImportedAccount = {
  name: string;
  website: string;
  state: string;
  county: string;
  type: string;
  segmentRef: string;
  award: DownstreamAward | null;
  profile: { subtype: string; countyDesignation: string; funderRef: string } | null;
  /** Seller only. */
  fit: { product: string; alsoFits: string[]; flags: string[]; reasons: string[]; openingLine: string } | null;
};

export function accountFromDownstream(o: DownstreamOrg, seller: boolean): ImportedAccount {
  return {
    name: o.name.slice(0, 200),
    website: o.website ?? "",
    state: o.state ?? "",
    county: o.county ?? "",
    type: o.type ?? "",
    segmentRef: o.segmentRef ?? "",
    award: o.award ?? null,
    profile: o.profile ? { subtype: o.profile.subtype ?? "", countyDesignation: o.profile.countyDesignation ?? "", funderRef: o.profile.funderRef ?? "" } : null,
    fit: seller && o.seller?.fit ? { ...o.seller.fit, openingLine: o.seller.fit.openingLine } : null,
  };
}

const STAGE_NOTE: Record<string, string> = {
  "closing-out": "the project has ended and its final reports are due",
  "ends-within-6-months": "the project ends within six months",
  "ends-in-6-12-months": "the project ends in six to twelve months",
  active: "the project is under way",
  "starting-soon": "the project is about to start",
  ended: "the project has ended",
};

/**
 * The award as a one-line hook for the writer, and where it came from. It is
 * a FACT about the organization from a public source, so it is phrased as one
 * and carries its link; the writer adapts it, it never pretends to know more.
 */
export function awardHook(a: DownstreamAward | null | undefined): { hook: string; sourceUrl: string } | null {
  if (!a || !(a.funder || a.program) || !(a.project || a.title)) return null;
  const who = a.funder || a.program;
  const what = a.project || a.title;
  const amount = a.amount ? `${a.amount} ` : "";
  const year = a.year ? ` (${a.year})` : "";
  const prog = a.program && a.funder ? ` through ${a.program}` : "";
  const stage = a.stage && STAGE_NOTE[a.stage] ? `; ${STAGE_NOTE[a.stage]}${a.datesEstimated ? " (dates estimated)" : ""}` : "";
  return { hook: `${who} awarded ${amount}for ${what}${prog}${year}${stage}`.slice(0, 400), sourceUrl: a.sourceUrl ?? "" };
}

/* ── Every award a company has (2026-10-16) ─────────────────────────────── */

/**
 * Downstream lists an organization once per award, so one company can come
 * from several rows (Kawerak, Inc. from six). The company keeps every award,
 * each with the row it came from, so a re-import replaces rather than repeats.
 */
export type StoredAward = DownstreamAward & { ref: string };

/** Live awards first: one ending soon is the strongest reason to talk. */
const LIVE_RANK: Record<string, number> = {
  "ends-within-6-months": 5,
  active: 4,
  "closing-out": 3,
  "ends-in-6-12-months": 3,
  "starting-soon": 2,
};
const yearOf = (a: DownstreamAward) => Number(String(a.year ?? "").match(/\d{4}/)?.[0] ?? 0);
const amountOf = (a: DownstreamAward) => Number(String(a.amount ?? "").replace(/[^0-9.]/g, "")) || 0;
const MAX_AWARDS = 50;

/** Newest fiscal year first, then the largest. */
function byRecency(a: DownstreamAward, b: DownstreamAward): number {
  return yearOf(b) - yearOf(a) || amountOf(b) - amountOf(a);
}

/**
 * The award a company's copy leads with: a live one (ending within six
 * months, then active, then closing out or ending within a year, then
 * starting soon), then the most recent fiscal year, then the largest.
 */
export function mostRelevantAward<T extends DownstreamAward>(awards: T[]): T | null {
  if (!awards.length) return null;
  return [...awards].sort((a, b) => (LIVE_RANK[b.stage ?? ""] ?? 0) - (LIVE_RANK[a.stage ?? ""] ?? 0) || byRecency(a, b))[0];
}

/** The company's awards with this row's award added (or replaced), newest first. */
export function withAward(existing: unknown, ref: string, award: DownstreamAward | null): StoredAward[] {
  const list = (Array.isArray(existing) ? existing : [])
    .filter((x): x is StoredAward => !!x && typeof x === "object" && typeof (x as StoredAward).ref === "string" && (x as StoredAward).ref !== ref);
  if (award) list.push({ ...award, ref });
  return list.sort(byRecency).slice(0, MAX_AWARDS);
}

/** Whether the company already holds this row's award. */
export function hasAward(existing: unknown, ref: string): boolean {
  return Array.isArray(existing) && existing.some((x) => !!x && typeof x === "object" && (x as StoredAward).ref === ref);
}
