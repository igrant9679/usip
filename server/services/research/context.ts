/**
 * The research context (Research module, phase 3; owner, 2026-10-14).
 *
 * Every AI writer that writes for or about a prospect gets a short block of
 * the workspace's own research on that prospect's market: what to never say,
 * the buyer persona, the sector's pains and words, what to lead with, and a
 * fact or two. It rides beside the sender's brand (services/brandContext):
 * the brand says who WE are; this says who THEY are.
 *
 * Which research applies, first match wins:
 *   1. the sector or persona the caller names;
 *   2. the ARE campaign's research sector, then its persona;
 *   3. the persona whose job titles match the prospect's title;
 *   4. the sector whose targeting titles, then industries, match.
 * Only sectors a person marked Researched or Verified are used (owner
 * decision: never a draft). Nothing matches → "" and the writer behaves
 * exactly as it did before Research existed.
 *
 * The block is trimmed to a budget per surface, lowest priority first, and an
 * avoid rule is never cut. Research holds no personal data (shared shape), so
 * nothing here can leak a person into a prompt.
 */
import { and, eq, inArray } from "drizzle-orm";
import { areCampaigns, personas, researchMarkets, researchSectors } from "../../../drizzle/schema";
import { getDb } from "../../db";
import { cleanPersonaResearch, cleanSectorContent, type SectorContent } from "@shared/researchShape";
import { icpLabels } from "@shared/icpShape";
import { pausedDownstreamFilter } from "./downstreamAccounts";

/** What the writer produces, which decides how much research it gets. */
export type ResearchSurface =
  | "outreach" // emails, LinkedIn messages, sequence steps, invites: the full selling block
  | "reply" // answers to someone who wrote in: persona, avoid, words, a little lead-with
  | "research" // dossiers, briefs, fit analysis for the rep: more facts, no copywriting
  | "voice" // the phone agent: short, spoken, no statistics
  | "judge"; // checking generated copy: the rules it must follow

export type ResearchUse = {
  surface: ResearchSurface;
  campaignId?: number | null;
  personaId?: number | null;
  sectorId?: number | null;
  prospectTitle?: string | null;
  industry?: string | null;
};

export type ResearchContext = {
  block: string;
  sectorId: number | null;
  personaId: number | null;
  matchedBy: "sector" | "campaign" | "persona" | "title" | "industry" | null;
  /** The sector's avoid rules plus the persona's objections are NOT rules; only avoid rules. */
  avoid: string[];
};

const EMPTY: ResearchContext = { block: "", sectorId: null, personaId: null, matchedBy: null, avoid: [] };

/* ── What a workspace has (cached briefly: writers run per prospect) ──── */

type PersonaRow = { id: number; name: string; sectorId: number | null; titles: string[]; cares: string; pains: string[]; objections: string[]; angle: string };
type SectorRow = { id: number; marketName: string; content: SectorContent };
type Snapshot = { at: number; sectors: Map<number, SectorRow>; personas: PersonaRow[] };

const CACHE_MS = 60_000;
const cache = new Map<number, Snapshot>();

export function __clearResearchContextCache(): void {
  cache.clear();
}

const USABLE = ["researched", "verified"] as const;

async function snapshot(workspaceId: number): Promise<Snapshot | null> {
  const hit = cache.get(workspaceId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit;
  const db = await getDb();
  if (!db) return null;
  const sectorRows = await db
    .select()
    .from(researchSectors)
    .where(and(eq(researchSectors.workspaceId, workspaceId), inArray(researchSectors.status, [...USABLE])));
  const marketIds = Array.from(new Set(sectorRows.map((s) => s.marketId)));
  const markets = marketIds.length
    ? await db
        .select({ id: researchMarkets.id, name: researchMarkets.name })
        .from(researchMarkets)
        .where(and(eq(researchMarkets.workspaceId, workspaceId), inArray(researchMarkets.id, marketIds)))
    : [];
  const marketName = new Map(markets.map((m) => [m.id, m.name]));
  const isPaused = await pausedDownstreamFilter(workspaceId);
  const sectors = new Map<number, SectorRow>();
  for (const s of sectorRows) {
    if (!marketName.has(s.marketId) || isPaused(s)) continue;
    sectors.set(s.id, { id: s.id, marketName: marketName.get(s.marketId)!, content: cleanSectorContent(s).content });
  }
  const personaRows = await db
    .select({
      id: personas.id,
      name: personas.name,
      sectorId: personas.sectorId,
      targetTitles: personas.targetTitles,
      cares: personas.cares,
      pains: personas.pains,
      objections: personas.objections,
      angle: personas.angle,
    })
    .from(personas)
    .where(eq(personas.workspaceId, workspaceId));
  const personaList: PersonaRow[] = personaRows.map((p) => {
    const r = cleanPersonaResearch(p).content;
    return { id: p.id, name: p.name, sectorId: p.sectorId ?? null, titles: icpLabels(p.targetTitles, "title"), ...r };
  });
  const snap = { at: Date.now(), sectors, personas: personaList };
  cache.set(workspaceId, snap);
  return snap;
}

/* ── Matching ───────────────────────────────────────────────────────────── */

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9& ]+/g, " ").replace(/\s+/g, " ").trim();

/** The length of the longest of `titles` found in `title` (word-bounded), or 0. */
export function titleMatchLength(title: string, titles: string[]): number {
  const t = ` ${norm(title)} `;
  let best = 0;
  for (const raw of titles) {
    const x = norm(raw);
    if (x.length < 3) continue;
    if (t.includes(` ${x} `) && x.length > best) best = x.length;
  }
  return best;
}

const hasResearch = (p: PersonaRow) => !!(p.cares || p.angle || p.pains.length || p.objections.length);

/* ── The block ──────────────────────────────────────────────────────────── */

type Item = { priority: number; text: string; keep?: boolean };

const BUDGET: Record<ResearchSurface, number> = { outreach: 2600, reply: 1600, research: 3600, voice: 900, judge: 1600 };

export function formatResearchBlock(args: { surface: ResearchSurface; marketName: string; sector: SectorContent | null; persona: PersonaRow | null }): string {
  const { surface, sector, persona } = args;
  const items: Item[] = [];
  const list = (xs: string[], n: number) => xs.slice(0, n).map((x) => `- ${x}`).join("\n");
  const avoid = sector?.messaging.avoid ?? [];
  if (avoid.length) items.push({ priority: 0, keep: true, text: `Never say or imply:\n${list(avoid, 12)}` });
  if (persona) {
    const lines = [`The buyer: ${persona.name}`];
    if (persona.cares) lines.push(`- Cares about: ${persona.cares}`);
    if (persona.pains.length) lines.push(`- Pains: ${persona.pains.slice(0, 5).join("; ")}`);
    if (persona.objections.length && surface !== "voice") lines.push(`- Objections to expect: ${persona.objections.slice(0, 4).join("; ")}`);
    if (persona.angle) lines.push(`- The angle that works: ${persona.angle}`);
    items.push({ priority: 1, text: lines.join("\n") });
  }
  if (sector) {
    const s = sector;
    if (surface === "research" && s.summary) items.push({ priority: 2, text: `About this sector: ${s.summary.slice(0, 700)}` });
    if (s.buyers.painPoints.length && surface !== "judge") items.push({ priority: 3, text: `What this sector struggles with:\n${list(s.buyers.painPoints, surface === "voice" ? 3 : 6)}` });
    if (s.messaging.vocabulary.length) items.push({ priority: 4, text: `Words they use: ${s.messaging.vocabulary.slice(0, 14).join(", ")}` });
    if (s.messaging.leadWith.length && surface !== "voice" && surface !== "research") {
      items.push({ priority: 5, text: `Lead with:\n${list(s.messaging.leadWith, surface === "reply" ? 2 : 4)}` });
    }
    if (s.messaging.sampleOpening && surface === "outreach") {
      items.push({ priority: 7, text: `An opening line to adapt, never to copy: ${s.messaging.sampleOpening}` });
    }
    if (surface === "research") {
      if (s.facts.buying.length) items.push({ priority: 5, text: `How they buy:\n${list(s.facts.buying, 4)}` });
      if (s.facts.obligations.length) items.push({ priority: 6, text: `What they must comply with:\n${list(s.facts.obligations, 3)}` });
      if (s.facts.policyWatch.length) items.push({ priority: 7, text: `Changes to watch:\n${list(s.facts.policyWatch, 3)}` });
    }
    const facts = s.facts.marketSize.filter((f) => f.value);
    if (facts.length && (surface === "outreach" || surface === "research")) {
      const n = surface === "research" ? 3 : 2;
      items.push({
        priority: 6,
        text: `Market facts you may cite (sector-wide, never as this prospect's own figures):\n${facts.slice(0, n).map((f) => `- ${f.value} ${f.label}${f.source ? ` (${f.source})` : ""}`).join("\n")}`,
      });
    }
  }
  if (!items.length) return "";

  const head = surface === "judge"
    ? "## Rules from your market research"
    : `## The prospect's market (your research${args.marketName ? `: ${args.marketName}` : ""}${sector?.name ? ` › ${sector.name}` : ""})\nUse it to make the writing specific; do not recite it.`;
  // Lowest priority goes first when over budget; avoid rules never go.
  const budget = BUDGET[surface];
  const kept = items.slice().sort((a, b) => a.priority - b.priority);
  const size = () => head.length + kept.reduce((n, i) => n + i.text.length + 2, 0);
  while (size() > budget) {
    let drop = -1;
    for (let i = kept.length - 1; i >= 0; i--) if (!kept[i].keep) { drop = i; break; }
    if (drop < 0) break;
    kept.splice(drop, 1);
  }
  return [head, ...kept.map((i) => i.text)].join("\n\n");
}

/* ── The one entry point ────────────────────────────────────────────────── */

export async function researchContextFor(workspaceId: number, use: ResearchUse): Promise<ResearchContext> {
  try {
    const snap = await snapshot(workspaceId);
    if (!snap || (snap.sectors.size === 0 && !snap.personas.some(hasResearch))) return EMPTY;

    let sectorId: number | null = null;
    let persona: PersonaRow | null = null;
    let matchedBy: ResearchContext["matchedBy"] = null;
    const personaById = (id: number | null | undefined) => (id != null ? snap.personas.find((p) => p.id === id) ?? null : null);

    if (use.sectorId != null && snap.sectors.has(use.sectorId)) { sectorId = use.sectorId; matchedBy = "sector"; }
    if (use.personaId != null) { persona = personaById(use.personaId); if (persona) matchedBy ??= "persona"; }

    if (use.campaignId != null && (sectorId == null || persona == null)) {
      const db = await getDb();
      const [c] = db
        ? await db
            .select({ sectorId: areCampaigns.researchSectorId, personaId: areCampaigns.personaId })
            .from(areCampaigns)
            .where(and(eq(areCampaigns.id, use.campaignId), eq(areCampaigns.workspaceId, workspaceId)))
            .limit(1)
        : [];
      if (c) {
        if (sectorId == null && c.sectorId != null && snap.sectors.has(c.sectorId)) { sectorId = c.sectorId; matchedBy = "campaign"; }
        if (persona == null) { persona = personaById(c.personaId); if (persona) matchedBy ??= "campaign"; }
      }
    }

    // The prospect's title picks the persona (one with research), and through it the sector.
    if (persona == null && use.prospectTitle) {
      let best = 0;
      for (const p of snap.personas) {
        if (!hasResearch(p)) continue;
        if (sectorId != null && p.sectorId !== sectorId) continue;
        const len = titleMatchLength(use.prospectTitle, p.titles);
        if (len > best) { best = len; persona = p; }
      }
      if (persona) matchedBy ??= "title";
    }
    if (sectorId == null && persona?.sectorId != null && snap.sectors.has(persona.sectorId)) {
      sectorId = persona.sectorId;
      matchedBy ??= "persona";
    }
    if (sectorId == null && use.prospectTitle) {
      let best = 0;
      for (const s of Array.from(snap.sectors.values())) {
        const len = titleMatchLength(use.prospectTitle, s.content.targeting.titles);
        if (len > best) { best = len; sectorId = s.id; }
      }
      if (sectorId != null) matchedBy = matchedBy ?? "title";
    }
    if (sectorId == null && use.industry) {
      for (const s of Array.from(snap.sectors.values())) {
        if (titleMatchLength(use.industry, s.content.targeting.industries) > 0) { sectorId = s.id; matchedBy = matchedBy ?? "industry"; break; }
      }
    }

    const sector = sectorId != null ? snap.sectors.get(sectorId) ?? null : null;
    if (!sector && !persona) return EMPTY;
    const block = formatResearchBlock({ surface: use.surface, marketName: sector?.marketName ?? "", sector: sector?.content ?? null, persona });
    return { block, sectorId: sector?.id ?? null, personaId: persona?.id ?? null, matchedBy, avoid: sector?.content.messaging.avoid ?? [] };
  } catch (e) {
    // Research makes copy better; its absence must never stop a writer.
    console.warn("[research] context failed:", e instanceof Error ? e.message : e);
    return EMPTY;
  }
}

/** Puts the block at the end of the first system message (or a new one), like the sender's brand. */
export function appendResearch<M extends { role: string; content: unknown }>(messages: M[], block: string): M[] {
  if (!block) return messages;
  const i = messages.findIndex((m) => m.role === "system" && typeof m.content === "string");
  if (i === -1) return [{ role: "system", content: block } as unknown as M, ...messages];
  const out = messages.slice();
  out[i] = { ...out[i], content: `${out[i].content as string}\n\n${block}` };
  return out;
}

export async function withResearch<M extends { role: string; content: unknown }>(workspaceId: number, use: ResearchUse, messages: M[]): Promise<M[]> {
  const ctx = await researchContextFor(workspaceId, use);
  return appendResearch(messages, ctx.block);
}
