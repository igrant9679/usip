/**
 * campaignRouter — which ARE campaign fits this person best? (phase 3,
 * 2026-09-02)
 *
 * Nothing in the product ever evaluated a person against more than one
 * campaign: a prospect was bound to the campaign that created it, and
 * exclusivity was a first-writer race. The pieces of a router already
 * existed and had never been composed:
 *
 *   effective targeting per campaign  — services/are/effectiveIcp.ts
 *   deterministic 0-100 fit           — areEngine.scoreIcpMatch (string match)
 *   ownership check                   — services/are/queueIdentity.existingClaim
 *   the other engine's view           — services/crossEngineEnrollment.ts
 *   the one write path                — services/are/pushPeople.ts
 *
 * Decision rule (choosePick, pure, tested): score every active campaign
 * deterministically; drop those below MIN_FIT; if the leader is clear (gap
 * ≥ CLEAR_GAP) or alone, take it; otherwise ask the model to break the tie
 * among the top few with structured JSON. The model never sees campaigns
 * the deterministic pass already ruled out, and it can only choose among
 * the candidates it is given.
 *
 * Two triggers: manual ("Best-fit campaign ✦" in the Add to… menu) and the
 * cron sweep, which routes people who are in nothing yet under the house
 * Off / Approve / Auto dial — approval records a suggestion for a human,
 * auto enrolls through pushPeopleIntoCampaign.
 */
import { and, desc, eq, gte, inArray, isNull, ne, notInArray, or, sql } from "drizzle-orm";
import { getDb } from "../db";
import {
  areCampaigns, campaignRoutingSuggestions, icpProfiles, prospects, workspaceSettings, workspaces,
} from "../../drizzle/schema";
import { invokeLLM } from "../_core/llm";
import { scoreIcpMatch } from "../areEngine";
import { buildEffectiveIcp, scoringTargetsOf } from "./are/effectiveIcp";

export const MIN_FIT = 25;
export const CLEAR_GAP = 15;
export const TIEBREAK_TOP_K = 3;

export interface CandidateScore { campaignId: number; campaignName: string; fit: number }
export interface RoutePick {
  prospectId: number;
  campaignId: number | null;
  campaignName: string | null;
  fit: number;
  reasoning: string;
  alternatives: CandidateScore[];
  /** Why there is no pick, when campaignId is null. */
  skipReason?: string;
  /** Whether the model was consulted. */
  usedModel: boolean;
}

/**
 * Pure decision over deterministic scores. Returns the chosen candidate, or
 * `null` when nothing clears MIN_FIT, and whether the caller should ask the
 * model to break a tie among `contenders`.
 */
export function choosePick(scores: CandidateScore[]): { pick: CandidateScore | null; needsTiebreak: boolean; contenders: CandidateScore[] } {
  const eligible = scores.filter((s) => s.fit >= MIN_FIT).sort((a, b) => b.fit - a.fit || a.campaignId - b.campaignId);
  if (eligible.length === 0) return { pick: null, needsTiebreak: false, contenders: [] };
  if (eligible.length === 1) return { pick: eligible[0], needsTiebreak: false, contenders: eligible };
  const [top, second] = eligible;
  if (top.fit - second.fit >= CLEAR_GAP) return { pick: top, needsTiebreak: false, contenders: eligible.slice(0, TIEBREAK_TOP_K) };
  return { pick: top, needsTiebreak: true, contenders: eligible.slice(0, TIEBREAK_TOP_K) };
}

type PersonRow = Pick<typeof prospects.$inferSelect, "id" | "firstName" | "lastName" | "title" | "company" | "companyDomain" | "industry" | "city" | "state" | "country" | "email">;

function personRecord(p: PersonRow): Record<string, unknown> {
  return {
    title: p.title,
    industry: p.industry,
    geography: [p.city, p.state, p.country].filter(Boolean).join(", "),
    companyName: p.company,
    companyDomain: p.companyDomain,
  };
}

async function activeCampaignsWithTargets(workspaceId: number) {
  const db = await getDb();
  if (!db) return [];
  const campaigns = await db.select().from(areCampaigns)
    .where(and(eq(areCampaigns.workspaceId, workspaceId), eq(areCampaigns.status, "active")));
  if (campaigns.length === 0) return [];
  // The workspace's latest active ICP fills gaps. A campaign's own
  // icpProfileId — written at create and never read anywhere before phase 3
  // — wins when set, so a campaign pinned to an older profile scores
  // against the profile it was built for.
  const [latest] = await db.select().from(icpProfiles)
    .where(and(eq(icpProfiles.workspaceId, workspaceId), eq(icpProfiles.isActive, true)))
    .orderBy(desc(icpProfiles.id)).limit(1);
  const pinnedIds = Array.from(new Set(campaigns.map((c) => c.icpProfileId).filter((x): x is number => x != null)));
  const pinned = pinnedIds.length
    ? await db.select().from(icpProfiles).where(and(eq(icpProfiles.workspaceId, workspaceId), inArray(icpProfiles.id, pinnedIds)))
    : [];
  const pinnedById = new Map(pinned.map((p) => [p.id, p]));
  return campaigns.map((c) => {
    const base = (c.icpProfileId && pinnedById.get(c.icpProfileId)) || latest;
    const effective = buildEffectiveIcp(base, c.icpOverrides);
    return { id: c.id, name: c.name, targets: scoringTargetsOf(effective, c.icpOverrides), hasTargeting: effective !== null };
  }).filter((c) => c.hasTargeting);
}

/**
 * Route a set of People. Skips anyone a campaign or sequence already owns.
 * Read-only: returns picks; callers decide whether to suggest or enroll.
 */
export async function routeProspects(workspaceId: number, prospectIds: number[]): Promise<RoutePick[]> {
  const db = await getDb();
  if (!db || prospectIds.length === 0) return [];
  const people = await db.select({
    id: prospects.id, firstName: prospects.firstName, lastName: prospects.lastName, title: prospects.title,
    company: prospects.company, companyDomain: prospects.companyDomain, industry: prospects.industry,
    city: prospects.city, state: prospects.state, country: prospects.country, email: prospects.email,
  }).from(prospects).where(and(eq(prospects.workspaceId, workspaceId), inArray(prospects.id, prospectIds)));

  const campaigns = await activeCampaignsWithTargets(workspaceId);
  const { activeCampaignsForProspects, activeSequencesForProspects } = await import("./crossEngineEnrollment");
  const [owned, sequenced] = await Promise.all([
    activeCampaignsForProspects(workspaceId, people.map((p) => p.id)),
    activeSequencesForProspects(workspaceId, people.map((p) => p.id)),
  ]);

  const out: RoutePick[] = [];
  for (const p of people) {
    const base = { prospectId: p.id, alternatives: [] as CandidateScore[], usedModel: false };
    const ownedBy = owned.get(p.id)?.[0];
    if (ownedBy) { out.push({ ...base, campaignId: null, campaignName: null, fit: 0, reasoning: "", skipReason: `Already in "${ownedBy.campaignName}"` }); continue; }
    const inSeq = sequenced.get(p.id)?.[0];
    if (inSeq) { out.push({ ...base, campaignId: null, campaignName: null, fit: 0, reasoning: "", skipReason: `In the sequence "${inSeq.sequenceName}"` }); continue; }
    if (campaigns.length === 0) { out.push({ ...base, campaignId: null, campaignName: null, fit: 0, reasoning: "", skipReason: "No active campaign has targeting to score against" }); continue; }

    const rec = personRecord(p);
    const scores: CandidateScore[] = campaigns.map((c) => ({ campaignId: c.id, campaignName: c.name, fit: scoreIcpMatch(rec, c.targets) }));
    const { pick, needsTiebreak, contenders } = choosePick(scores);
    if (!pick) { out.push({ ...base, alternatives: scores, campaignId: null, campaignName: null, fit: 0, reasoning: "", skipReason: `No campaign scores ${MIN_FIT}+ for this person's title, industry, or location` }); continue; }

    if (!needsTiebreak) {
      out.push({ ...base, alternatives: scores, campaignId: pick.campaignId, campaignName: pick.campaignName, fit: pick.fit, reasoning: `Best deterministic fit (${pick.fit}/100) on title, industry and location; the next campaign scored ${contenders[1]?.fit ?? "—"}.` });
      continue;
    }

    // Close call: let the model choose among the contenders only.
    try {
      const res = await invokeLLM({
        workspaceId,
        messages: [
          { role: "system", content: "You route a B2B prospect to the single best-fitting outbound campaign. Choose ONLY among the candidates given. Return JSON." },
          { role: "user", content: `Prospect: ${p.firstName} ${p.lastName} — ${p.title ?? "unknown title"} at ${p.company ?? "unknown company"}${p.industry ? ` (${p.industry})` : ""}${rec.geography ? `, ${rec.geography}` : ""}.\n\nCandidates:\n${contenders.map((c, i) => { const camp = campaigns.find((x) => x.id === c.campaignId)!; return `${i + 1}. id=${c.campaignId} "${c.campaignName}" — titles: ${camp.targets.titles.join(", ") || "any"}; industries: ${camp.targets.industries.join(", ") || "any"}; locations: ${camp.targets.geos.join(", ") || "any"}; keywords: ${camp.targets.keywords.join(", ") || "none"} (deterministic fit ${c.fit})`; }).join("\n")}\n\nPick the campaignId whose audience this person most plausibly belongs to, a 0-100 fit, and one sentence of reasoning.` },
        ],
        outputSchema: {
          name: "campaign_pick",
          schema: {
            type: "object",
            properties: { campaignId: { type: "integer" }, fit: { type: "integer" }, reasoning: { type: "string" } },
            required: ["campaignId", "fit", "reasoning"],
            additionalProperties: false,
          },
        },
        max_tokens: 300,
      });
      const raw = res.choices?.[0]?.message?.content;
      const text = typeof raw === "string" ? raw : Array.isArray(raw) ? raw.map((part: any) => (typeof part?.text === "string" ? part.text : "")).join("") : "{}";
      const parsed = JSON.parse(text || "{}") as { campaignId?: number; fit?: number; reasoning?: string };
      const chosen = contenders.find((c) => c.campaignId === parsed.campaignId) ?? pick;
      const fit = Math.max(chosen.fit, Math.min(100, Math.max(0, Math.round(Number(parsed.fit ?? chosen.fit)))));
      out.push({ ...base, usedModel: true, alternatives: scores, campaignId: chosen.campaignId, campaignName: chosen.campaignName, fit, reasoning: String(parsed.reasoning ?? "").slice(0, 400) || `Model picked among ${contenders.length} close candidates.` });
    } catch (e) {
      console.error(`[campaignRouter] tiebreak failed for prospect ${p.id}:`, (e as Error)?.message ?? e);
      out.push({ ...base, alternatives: scores, campaignId: pick.campaignId, campaignName: pick.campaignName, fit: pick.fit, reasoning: `Best deterministic fit (${pick.fit}/100); the tiebreak model was unavailable.` });
    }
  }
  return out;
}

/** Record picks as suggestions (approval mode). One pending row per person. */
export async function recordSuggestions(workspaceId: number, picks: RoutePick[], source: "manual" | "sweep"): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const routable = picks.filter((p) => p.campaignId != null);
  if (routable.length === 0) return 0;
  const existing = await db.select({ prospectId: campaignRoutingSuggestions.prospectId }).from(campaignRoutingSuggestions)
    .where(and(eq(campaignRoutingSuggestions.workspaceId, workspaceId), eq(campaignRoutingSuggestions.status, "pending"), inArray(campaignRoutingSuggestions.prospectId, routable.map((p) => p.prospectId))));
  const pending = new Set(existing.map((e) => e.prospectId));
  const rows = routable.filter((p) => !pending.has(p.prospectId)).map((p) => ({
    workspaceId, prospectId: p.prospectId, campaignId: p.campaignId!, fit: p.fit, reasoning: p.reasoning,
    alternatives: p.alternatives.map((a) => ({ campaignId: a.campaignId, fit: a.fit })), status: "pending" as const, source,
  }));
  if (rows.length) await db.insert(campaignRoutingSuggestions).values(rows as never);
  return rows.length;
}

/** Enroll picks (auto mode, or an accepted suggestion) through the one write path. */
export async function applyPicks(workspaceId: number, picks: RoutePick[]): Promise<{ added: number; skipped: number }> {
  const { pushPeopleIntoCampaign } = await import("./are/pushPeople");
  let added = 0, skipped = 0;
  const byCampaign = new Map<number, RoutePick[]>();
  for (const p of picks) if (p.campaignId != null) byCampaign.set(p.campaignId, [...(byCampaign.get(p.campaignId) ?? []), p]);
  for (const [campaignId, group] of Array.from(byCampaign.entries())) {
    for (const p of group) {
      const r = await pushPeopleIntoCampaign(workspaceId, campaignId, [p.prospectId], { routing: { fit: p.fit, reasoning: p.reasoning } });
      added += r.added.length; skipped += r.skipped.length;
    }
  }
  return { added, skipped };
}

function startOfUtcDay(): Date { const d = new Date(); d.setUTCHours(0, 0, 0, 0); return d; }

/**
 * Cron entry: for every workspace with routing on, route people who are in
 * nothing yet (no active campaign, no active sequence, no pending
 * suggestion), newest first, up to the daily cap.
 */
export async function runCampaignRoutingAllWorkspaces(): Promise<{ workspaces: number; routed: number; suggested: number; enrolled: number }> {
  const db = await getDb();
  const out = { workspaces: 0, routed: 0, suggested: 0, enrolled: 0 };
  if (!db) return out;
  const rows = await db.select().from(workspaceSettings).where(ne(workspaceSettings.campaignRoutingMode, "off"));
  const { archivedWorkspaceIds } = await import("../_core/workspaceArchive");
  const archivedWs = await archivedWorkspaceIds();
  const dayStart = startOfUtcDay();
  for (const ws of rows) {
    if (archivedWs.has(ws.workspaceId)) continue; // archived workspaces are frozen
    try {
      const mode = ws.campaignRoutingMode as "approval" | "auto";
      const cap = ws.campaignRoutingDailyCap ?? 25;
      const [today] = await db.select({ n: sql<number>`count(*)` }).from(campaignRoutingSuggestions)
        .where(and(eq(campaignRoutingSuggestions.workspaceId, ws.workspaceId), eq(campaignRoutingSuggestions.source, "sweep"), gte(campaignRoutingSuggestions.createdAt, dayStart)));
      const remaining = cap - Number(today?.n ?? 0);
      if (remaining <= 0) continue;

      // Candidates: real people with an email, not rejected/archived, no
      // pending suggestion. Ownership by an engine is checked inside
      // routeProspects (it returns a skipReason rather than a pick).
      const pendingIds = (await db.select({ prospectId: campaignRoutingSuggestions.prospectId }).from(campaignRoutingSuggestions)
        .where(and(eq(campaignRoutingSuggestions.workspaceId, ws.workspaceId), eq(campaignRoutingSuggestions.status, "pending")))).map((r) => r.prospectId);
      const candidates = await db.select({ id: prospects.id }).from(prospects)
        .where(and(
          eq(prospects.workspaceId, ws.workspaceId),
          // "Archived" on People IS verificationStatus = rejected
          // (prospects.archive sets exactly that) — one predicate covers both.
          or(isNull(prospects.verificationStatus), ne(prospects.verificationStatus, "rejected")),
          sql`${prospects.email} IS NOT NULL AND ${prospects.email} <> ''`,
          pendingIds.length ? notInArray(prospects.id, pendingIds) : sql`true`,
        ))
        .orderBy(desc(prospects.id))
        .limit(Math.min(remaining * 4, 200));
      if (candidates.length === 0) continue;

      const picks = await routeProspects(ws.workspaceId, candidates.map((c) => c.id));
      const routable = picks.filter((p) => p.campaignId != null).slice(0, remaining);
      out.workspaces++;
      out.routed += routable.length;
      if (routable.length === 0) continue;
      if (mode === "auto") {
        const r = await applyPicks(ws.workspaceId, routable);
        out.enrolled += r.added;
        // Keep an accepted record so the daily cap and the audit trail see it.
        await db.insert(campaignRoutingSuggestions).values(routable.map((p) => ({
          workspaceId: ws.workspaceId, prospectId: p.prospectId, campaignId: p.campaignId!, fit: p.fit, reasoning: p.reasoning,
          alternatives: p.alternatives.map((a) => ({ campaignId: a.campaignId, fit: a.fit })), status: "accepted" as const, source: "sweep" as const, decidedAt: new Date(),
        })) as never);
      } else {
        out.suggested += await recordSuggestions(ws.workspaceId, routable, "sweep");
      }
      await db.update(workspaceSettings).set({ campaignRoutingLastRunAt: new Date() } as never)
        .where(eq(workspaceSettings.workspaceId, ws.workspaceId));
      console.log(`[CampaignRouting] ws ${ws.workspaceId} (${mode}): routed ${routable.length}`);
    } catch (e) {
      console.error(`[CampaignRouting] ws ${ws.workspaceId} failed:`, e);
    }
  }
  return out;
}

// `workspaces` is imported for future per-workspace naming in logs; keep the
// import honest by referencing it.
void workspaces;
