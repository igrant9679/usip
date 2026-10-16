/**
 * downstreamContract.ts — the file Downstream exports for Velocity (format
 * "downstream-velocity", version 2), from Downstream's
 * docs/velocity-integration.md (commit 6e3bd4f), adapted to zod 4
 * (z.record takes a key schema). Research module, phase 5.
 *
 * The file is external input: parse it with parseDownstreamFile below, which
 * enforces the limits and drops anything that looks like personal contact
 * data before a single field is used.
 */
import { z } from "zod";
import { looksPersonalValue } from "./researchShape";
const S = z.string(), L = z.array(z.string()), N = z.number();
// Unknown keys are dropped (z.object strips them), so newer Downstream files still parse.
const o = <T extends z.ZodRawShape>(shape: T) => z.object(shape);
const opt = <T extends z.ZodTypeAny>(x: T) => x.optional();
const Product = z.enum(['grantmaker', 'run', 'discover-raise']);
const Source = o({ title: S, url: S });
const TitleText = o({ title: opt(S), text: opt(S) });

const Seller = o({
  name: S,
  modules: z.array(o({ id: S, name: opt(S), tagline: opt(S), description: opt(S), fundedOrganizationNeed: opt(S) })),
  productFacts: L,
  positioning: opt(o({ whereWeWin: opt(L), principles: opt(z.array(TitleText)) })),
  messaging: opt(o({ principles: opt(z.array(TitleText)), sequence: opt(z.array(o({ step: opt(S), channel: opt(S), purpose: opt(S) }))), preflight: opt(L), funderEmailTemplate: opt(S) })),
  fitRules: opt(z.array(o({ product: Product, rule: S }))),
  priorityTiers: opt(z.array(o({ tier: N, name: S, who: S, howToWork: S }))),
  targetGroups: opt(z.array(o({ id: S, name: S, product: Product, definition: S, inCommon: L, pitch: S, whoToContact: S })))
});
const Funder = o({
  ref: S, name: S, shortName: S, active: z.boolean(), summary: opt(S), states: opt(L), countyCount: opt(N), established: opt(S), website: opt(S), applicationPortal: opt(S),
  fy2026Funding: opt(S), blocker: opt(S),
  programs: opt(z.array(o({ name: opt(S), purpose: opt(S), award: opt(S), match: opt(S), cycle: opt(S), url: opt(S) }))), applying: opt(L), eligible: opt(L), reporting: opt(L),
  programReporting: opt(z.array(o({ program: S, items: L }))), reportingCalendar: opt(S), closeoutDays: opt(N), successMetrics: opt(L), recipientTypes: opt(L), projectArchetypes: opt(L),
  distress: opt(o({ method: opt(S), matchEffect: opt(S), levels: opt(z.array(o({ level: opt(S), match: opt(S) }))), counts: opt(z.record(z.string(), N)), countsYear: opt(S) })),
  workedExample: opt(o({ title: opt(S), intro: opt(S), stages: z.array(o({ stage: opt(S), funderAsks: opt(S), granteeMust: opt(S), communityForceFit: opt(S) })), stillToAdd: opt(S) })),
  sources: opt(z.array(Source))
});
const Knowledge = o({
  overview: opt(o({ headline: opt(S), lede: opt(S), purposes: opt(z.array(TitleText)) })),
  glossary: opt(z.array(o({ term: S, definition: S, source: opt(S) }))),
  competitors: opt(z.array(o({ name: opt(S), category: opt(S), positioning: opt(S), pricing: opt(S), url: opt(S) }))),
  helperFees: opt(z.array(o({ model: opt(S), range: opt(S), source: opt(S) }))),
  helperRules: opt(L),
  fundingLifecycle: opt(o({ lede: opt(S), stages: opt(z.array(o({ title: S, question: opt(S), tasks: opt(L), module: opt(S) }))), thresholds: opt(z.array(o({ item: opt(S), value: opt(S), citation: opt(S) }))), policyChanges: opt(z.array(o({ date: opt(S), change: opt(S), impact: opt(S) }))) })),
  funders: opt(z.array(Funder))
});
const SegSeller = o({ leadWith: opt(L), avoid: opt(L), sampleOpeningLine: opt(S), moduleFit: opt(o({ discover: opt(S), raise: opt(S), run: opt(S), prove: opt(S) })), fitScore: opt(N.nullable()) });
const Segment = o({
  ref: S, revision: z.number().int().positive(), updatedAt: S.nullable(), name: S, shortName: S, tagline: S, summary: S,
  research: o({ status: z.enum(['draft', 'researched', 'verified']), asOf: S, owner: S, scores: o({ reach: opt(N), money: opt(N), pain: opt(N), access: opt(N) }) }),
  targeting: o({ titles: L, industries: L, geographies: L, keywords: L, employeeMin: N.nullable(), employeeMax: N.nullable(), organizationTypes: L, exclude: L }),
  buyerRoles: L, personaRefs: L,
  market: o({ painPoints: L, avoid: L, vocabulary: L,
    fundingPrograms: z.array(o({ name: S, agency: opt(S), flow: opt(S), purpose: opt(S), typicalAward: opt(S), url: opt(S) })),
    marketSize: opt(z.array(o({ value: opt(S), label: opt(S), source: opt(S) }))),
    moneyFlow: opt(o({ sources: opt(L), intermediaries: opt(z.array(o({ name: opt(S), role: opt(S), count: opt(S) }))), recipients: opt(z.array(o({ type: opt(S), approxCount: opt(S), notes: opt(S) }))) })),
    applying: opt(L), postAwardReporting: opt(L), currentHelpers: opt(L), policyWatch: opt(L), funderLink: opt(S) }),
  seller: opt(SegSeller),
  sources: z.array(Source)
});
const Persona = o({ ref: S, segmentRef: S, name: S, titles: opt(L), cares: opt(S), pains: opt(L), objections: opt(L), angle: opt(S), written: z.boolean() });
const Org = o({
  ref: S, revision: N, name: S, type: opt(S), segmentRef: opt(S), state: opt(S), county: opt(S), website: opt(S),
  profile: opt(o({ subtype: opt(S), countyDesignation: opt(S), funderRef: opt(S) })),
  award: opt(o({ funder: opt(S), program: opt(S), project: opt(S), amount: opt(S), year: opt(S), sourceUrl: opt(S),
    stage: opt(z.enum(['closing-out', 'ends-within-6-months', 'ends-in-6-12-months', 'active', 'starting-soon', 'ended', 'unknown'])), startDate: opt(S), endDate: opt(S), datesEstimated: opt(z.boolean()), title: opt(S), committedOutcomes: opt(L) })),
  status: opt(S),
  seller: opt(o({ fit: o({ product: Product, alsoFits: z.array(Product), flags: z.array(z.enum(['financial-distress', 'small-budget', 'size-unknown', 'very-small'])), reasons: L, openingLine: S }) }))
});
const FitCounts = o({ grantmaker: N, run: N, discoverRaise: N, discoverRaiseSmall: N });
const MarketStats = o({
  asOf: S, basis: S, organizations: N, realisticBuyers: N, manageSizableGrants: N, fileFederalAudit: N, auditFindings: N, auditFindingsSharePct: N.nullable(), fundedByCommission: N,
  sizableGrantsNoCommissionAwardPct: N.nullable(), federalSpendingPerYear: N, largest500SharePct: N, passOnToSubrecipients: N, passedOnPerYear: N, repeatGrantees: N, buyersWithEmailPct: N.nullable(),
  byPeerGroup: z.array(o({ id: S, name: S, organizations: N, realisticBuyers: N, manageSizableGrants: N, fileFederalAudit: N, auditFindingsSharePct: N.nullable(), fundedByCommission: N, fit: FitCounts })),
  byCommission: z.array(o({ ref: S, shortName: S, organizations: N, realisticBuyers: N, manageSizableGrants: N, auditFindingsSharePct: N.nullable(), fundedOrganizations: N, awardsListed: N, awardDollars: N })),
  tiers: opt(z.array(o({ tier: N, name: S, organizations: N, withEmail: N }))),
  pools: opt(z.array(o({ id: S, organizations: N })))
});
const File = o({
  format: z.literal('downstream-velocity'), version: z.literal(2), exportedAt: S,
  source: o({ app: z.literal('Downstream'), url: S, workspace: o({ id: S, name: S, kind: z.enum(['regional-authorities', 'generic']), tagline: opt(S) }), exportedBy: S }),
  audience: z.enum(['seller', 'market']), intendedFor: opt(S),
  contents: o({ segments: z.boolean(), personas: z.boolean(), knowledge: z.boolean(), organizations: z.boolean(), marketStats: z.boolean() }),
  seller: opt(Seller), knowledge: opt(Knowledge),
  segments: z.array(Segment), personas: z.array(Persona), organizations: z.array(Org),
  marketStats: opt(MarketStats)
});
export const DownstreamFile = File;
export type DownstreamFile = z.infer<typeof File>;
export type DownstreamSegment = z.infer<typeof Segment>;
export type DownstreamPersona = z.infer<typeof Persona>;
export type DownstreamOrg = z.infer<typeof Org>;
export type DownstreamKnowledge = z.infer<typeof Knowledge>;
export type DownstreamMarketStats = z.infer<typeof MarketStats>;
export type DownstreamFunder = z.infer<typeof Funder>;

/* ── Parsing (limits + personal-data scrub) ────────────────────────────── */


export const DOWNSTREAM_LIMITS = { bytes: 15 * 1024 * 1024, segments: 200, personas: 1000, organizations: 10_000, string: 4000 };

export type ParsedDownstream =
  | { ok: true; file: DownstreamFile; dropped: string[] }
  | { ok: false; error: string };

/**
 * Identifiers (ref, segmentRef, …Ref, id) are opaque: an organization ref like
 * "…/prospects/7353593813e9" holds ten digits in a row and is no phone
 * number. Blanking one would merge organizations on re-import (2026-10-16:
 * 14 of CommunityForce's 2,086 were hit).
 */
const IDENTIFIER_KEY = /^(id|ref)$|Ref$/;

/** Trims and caps every string; removes (and lists) anything that looks like an email or phone number. */
function scrub(node: unknown, path: string, dropped: string[], key = ""): unknown {
  if (typeof node === "string") {
    const s = node.trim().slice(0, DOWNSTREAM_LIMITS.string);
    if (s && !IDENTIFIER_KEY.test(key) && looksPersonalValue(s)) { dropped.push(path); return ""; }
    return s;
  }
  if (Array.isArray(node)) {
    const out: unknown[] = [];
    node.forEach((x, i) => {
      const v = scrub(x, `${path}[${i}]`, dropped, key);
      if (!(typeof x === "string" && v === "")) out.push(v);
    });
    return out;
  }
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) out[k] = scrub(v, path ? `${path}.${k}` : k, dropped, k);
    return out;
  }
  return node;
}

export function parseDownstreamFile(text: string): ParsedDownstream {
  const bytes = new TextEncoder().encode(text).length;
  if (bytes > DOWNSTREAM_LIMITS.bytes) return { ok: false, error: `The file is ${(bytes / 1048576).toFixed(1)} MB; the limit is 15 MB.` };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: "This is not a JSON file. Use Export for Velocity in Downstream." };
  }
  const head = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  if (head.format !== "downstream-velocity") return { ok: false, error: "This is not a Downstream export for Velocity (its format is not downstream-velocity)." };
  if (head.version !== 2) return { ok: false, error: `This export is version ${String(head.version)}; Velocity reads version 2. Export it again from Downstream.` };
  const parsed = DownstreamFile.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".") || "(file)"}: ${i.message}`).join("; ");
    return { ok: false, error: `The export does not match version 2: ${issues}` };
  }
  const f = parsed.data;
  if (f.segments.length > DOWNSTREAM_LIMITS.segments) return { ok: false, error: `The export has ${f.segments.length} segments; the limit is ${DOWNSTREAM_LIMITS.segments}.` };
  if (f.personas.length > DOWNSTREAM_LIMITS.personas) return { ok: false, error: `The export has ${f.personas.length} personas; the limit is ${DOWNSTREAM_LIMITS.personas}.` };
  if (f.organizations.length > DOWNSTREAM_LIMITS.organizations) return { ok: false, error: `The export has ${f.organizations.length} organizations; the limit is ${DOWNSTREAM_LIMITS.organizations}.` };
  const dropped: string[] = [];
  const file = scrub(f, "", dropped) as DownstreamFile;
  return { ok: true, file, dropped };
}
