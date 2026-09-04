/**
 * campaignProposals — which NEW campaign should exist? (owner ask 2026-09-04:
 * "suggest new Sequences to be created based on analysis of the People").
 *
 * The best-fit router (campaignRouter.ts) answers "which existing campaign
 * fits this person". Its leftovers are the question this module answers:
 * people no active campaign clears MIN_FIT for are, by construction, demand
 * no campaign serves. So:
 *
 *   1. findUnplacedPeople — People with an email, not rejected, whom the
 *      router (the SAME routeProspects the sweep uses) places nowhere.
 *      Anyone a campaign or sequence already owns is excluded by the router.
 *   2. clusterPeople — pure: group them by industry × title family ×
 *      country; only clusters big enough to be worth a campaign survive.
 *   3. proposeForCluster — the model drafts a name, description, value
 *      proposition, targeting (the IcpOverrides shape the router scores
 *      against) and a copy mode; a deterministic draft stands in when the
 *      model is unavailable.
 *   4. Under the Campaign Routing dial: approval records a pending proposal
 *      for the Revenue Engine hub; auto creates the campaign at once —
 *      ACTIVE with batch approval, so the engine enriches and writes but a
 *      human still approves the first batch — and pushes the cluster in
 *      through the one write path (pushPeopleIntoCampaign).
 *
 * Guards: a dismissed proposal's people are not re-clustered for
 * DISMISS_COOLDOWN_DAYS; a pending proposal's people are not re-proposed; a
 * name that matches an active campaign is not proposed again.
 */
import { and, desc, eq, gte, inArray, ne, or, sql } from "drizzle-orm";
import { getDb } from "../db";
import { areCampaigns, campaignProposals, prospects, workspaceSettings } from "../../drizzle/schema";
import { invokeLLM } from "../_core/llm";
import { workspaceNotifyUserId } from "../_core/activeMembers";
import { routeProspects } from "./campaignRouter";

export const MIN_CLUSTER_SIZE = 8;
export const MAX_PENDING_PROPOSALS = 3;
export const MAX_CANDIDATES = 600;
export const DISMISS_COOLDOWN_DAYS = 30;

export interface ClusterPerson {
  id: number;
  title: string | null;
  seniority: string | null;
  functionalArea: string | null;
  industry: string | null;
  country: string | null;
  company: string | null;
}

export interface Cluster {
  key: string;
  industry: string | null;
  family: string | null;
  country: string | null;
  people: ClusterPerson[];
}

export interface ProposalDraft {
  name: string;
  description: string;
  valueProposition: string;
  targeting: { targetTitles: string[]; targetIndustries: string[]; targetGeographies: string[]; keywords: string[] };
  copyMode: "per_person" | "fixed";
  reasoning: string;
  usedModel: boolean;
}

const norm = (s: unknown) => String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
const cap = (s: string) => s.replace(/\b\w/g, (c) => c.toUpperCase());

/**
 * The job family a title belongs to — coarse on purpose. Two grants
 * directors at different nonprofits are one audience; "Director of Grants"
 * and "Grants Manager" must land in the same bucket for a cluster to form.
 * Order matters: the first rule that matches wins.
 */
const FAMILY_RULES: Array<[string, RegExp]> = [
  ["grants", /\bgrants?\b|\bawards?\b|\bsponsored (programs|research)\b/],
  ["finance", /\bcfo\b|\bfinanc|\bcontroller\b|\baccount(ing|ant)\b|\btreasur|\bbudget\b/],
  ["executive", /\bceo\b|\bpresident\b|\bexecutive director\b|\bfounder\b|\bowner\b|\bprincipal\b|\bchair\b/],
  ["development", /\bdevelopment\b|\bfundrais|\badvancement\b|\bphilanthrop|\bdonor\b/],
  ["operations", /\bcoo\b|\boperations?\b|\bprogram (director|manager|officer)\b|\bprograms?\b/],
  ["technology", /\bcio\b|\bcto\b|\btechnolog|\bit\b|\bengineer|\bdata\b|\bsoftware\b|\bsystems?\b/],
  ["compliance", /\bcompliance\b|\blegal\b|\bcounsel\b|\baudit|\brisk\b/],
  ["marketing", /\bmarketing\b|\bcommunications?\b|\bbrand\b|\bcontent\b/],
  ["sales", /\bsales\b|\brevenue\b|\bbusiness development\b|\bpartnerships?\b/],
  ["people", /\bhr\b|\bhuman resources\b|\bpeople\b|\btalent\b|\brecruit/],
  ["administration", /\badministrat|\boffice manager\b|\bassistant\b|\bcoordinator\b/],
];

export function titleFamily(title: string | null | undefined, functionalArea?: string | null): string | null {
  const t = norm(title);
  for (const [family, re] of FAMILY_RULES) if (t && re.test(t)) return family;
  const fa = norm(functionalArea);
  if (fa) for (const [family, re] of FAMILY_RULES) if (re.test(fa)) return family;
  return fa || null;
}

export function clusterKeyOf(p: ClusterPerson): string {
  const industry = norm(p.industry) || "-";
  const family = titleFamily(p.title, p.functionalArea) ?? "-";
  const country = norm(p.country) || "-";
  return `${industry}|${family}|${country}`;
}

/** Pure: group people into audiences big enough to be a campaign, largest first. */
export function clusterPeople(rows: ClusterPerson[], minSize = MIN_CLUSTER_SIZE): Cluster[] {
  const by = new Map<string, ClusterPerson[]>();
  for (const p of rows) {
    const k = clusterKeyOf(p);
    // A person with NO signal at all (no industry, no title family, no
    // country) cannot be an audience; a campaign for "-|-|-" targets nothing.
    if (k === "-|-|-") continue;
    by.set(k, [...(by.get(k) ?? []), p]);
  }
  const out: Cluster[] = [];
  for (const [key, people] of Array.from(by.entries())) {
    if (people.length < minSize) continue;
    const [industry, family, country] = key.split("|");
    out.push({
      key,
      industry: industry === "-" ? null : industry,
      family: family === "-" ? null : family,
      country: country === "-" ? null : country,
      people,
    });
  }
  return out.sort((a, b) => b.people.length - a.people.length || a.key.localeCompare(b.key));
}

/** The most common values of a field in a cluster, for the prompt and the fallback targeting. */
export function topValues(people: ClusterPerson[], pick: (p: ClusterPerson) => string | null | undefined, n = 5): Array<{ value: string; count: number }> {
  const counts = new Map<string, { value: string; count: number }>();
  for (const p of people) {
    const raw = String(pick(p) ?? "").trim();
    if (!raw) continue;
    const k = raw.toLowerCase();
    const cur = counts.get(k);
    if (cur) cur.count++; else counts.set(k, { value: raw, count: 1 });
  }
  return Array.from(counts.values()).sort((a, b) => b.count - a.count || a.value.localeCompare(b.value)).slice(0, n);
}

/** What a proposal looks like when the model is unavailable — honest, not clever. */
export function fallbackDraft(cluster: Cluster): ProposalDraft {
  const titles = topValues(cluster.people, (p) => p.title, 5).map((t) => t.value);
  const industry = cluster.industry ? cap(cluster.industry) : null;
  const family = cluster.family ? cap(cluster.family) : null;
  const country = cluster.country ? cap(cluster.country) : null;
  const who = [family ? `${family} leaders` : "Decision makers", industry ? `in ${industry}` : null, country ? `(${country})` : null].filter(Boolean).join(" ");
  return {
    name: who.slice(0, 200),
    description: `${cluster.people.length} people in the CRM share this profile and no active campaign targets them.`,
    valueProposition: "",
    targeting: {
      targetTitles: titles,
      targetIndustries: industry ? [industry] : [],
      targetGeographies: country ? [country] : [],
      keywords: [],
    },
    copyMode: "per_person",
    reasoning: `Deterministic draft: ${cluster.people.length} unplaced people cluster on ${[industry, family, country].filter(Boolean).join(" / ") || "shared attributes"}.`,
    usedModel: false,
  };
}

/**
 * People the router places nowhere: with an email, not rejected, not owned
 * by any campaign or sequence, and below MIN_FIT for every active campaign.
 * `excludeIds` carries the people already covered by a pending or recently
 * dismissed proposal.
 */
export async function findUnplacedPeople(workspaceId: number, excludeIds: Set<number>, limit = MAX_CANDIDATES): Promise<ClusterPerson[]> {
  const db = await getDb();
  if (!db) return [];
  const rows = await db.select({
    id: prospects.id, title: prospects.title, seniority: prospects.seniority, functionalArea: prospects.functionalArea,
    industry: prospects.industry, country: prospects.country, company: prospects.company,
  }).from(prospects)
    .where(and(
      eq(prospects.workspaceId, workspaceId),
      or(sql`${prospects.verificationStatus} IS NULL`, ne(prospects.verificationStatus, "rejected")),
      sql`${prospects.email} IS NOT NULL AND ${prospects.email} <> ''`,
    ))
    .orderBy(desc(prospects.id))
    .limit(limit);
  const candidates = rows.filter((r) => !excludeIds.has(r.id));
  if (candidates.length === 0) return [];
  // The router's own verdict, so "unplaced" means exactly what the sweep
  // means by it. A person with a pick is the router's business, not ours;
  // one it skips as owned is already somewhere.
  const picks = await routeProspects(workspaceId, candidates.map((c) => c.id));
  const unplaced = new Set(picks.filter((p) => p.campaignId == null && !/^Already in|^In the sequence/.test(p.skipReason ?? "")).map((p) => p.prospectId));
  return candidates.filter((c) => unplaced.has(c.id));
}

export async function proposeForCluster(workspaceId: number, cluster: Cluster, existingCampaignNames: string[]): Promise<ProposalDraft> {
  const fallback = fallbackDraft(cluster);
  const titles = topValues(cluster.people, (p) => p.title, 8);
  const companies = topValues(cluster.people, (p) => p.company, 6);
  const seniorities = topValues(cluster.people, (p) => p.seniority, 4);
  try {
    const res = await invokeLLM({
      workspaceId,
      messages: [
        { role: "system", content: "You design outbound B2B campaigns. Given an audience that no existing campaign targets, propose ONE campaign for it. Be specific to the audience; never invent facts about the sender. Return JSON only." },
        { role: "user", content:
          `Audience: ${cluster.people.length} people in the CRM.\n` +
          `Industry: ${cluster.industry ?? "mixed"}. Job family: ${cluster.family ?? "mixed"}. Country: ${cluster.country ?? "mixed"}.\n` +
          `Most common titles: ${titles.map((t) => `${t.value} (${t.count})`).join("; ") || "unknown"}.\n` +
          `Seniority: ${seniorities.map((t) => `${t.value} (${t.count})`).join("; ") || "unknown"}.\n` +
          `Example organisations: ${companies.map((c) => c.value).join("; ") || "unknown"}.\n` +
          `Existing campaigns (do NOT duplicate their audience or name): ${existingCampaignNames.join("; ") || "none"}.\n\n` +
          `Return: name (≤ 60 chars, names the audience), description (1–2 sentences), valueProposition (one sentence a first email could open with), ` +
          `targetTitles (3–6 title phrases the scorer can match), targetIndustries (1–3), targetGeographies (0–2), keywords (0–5), ` +
          `copyMode ("per_person" when the audience varies enough that each email should be written individually; "fixed" when one message fits everyone), ` +
          `reasoning (one sentence on why this is one campaign).` },
      ],
      outputSchema: {
        name: "campaign_proposal",
        schema: {
          type: "object",
          properties: {
            name: { type: "string" }, description: { type: "string" }, valueProposition: { type: "string" },
            targetTitles: { type: "array", items: { type: "string" } }, targetIndustries: { type: "array", items: { type: "string" } },
            targetGeographies: { type: "array", items: { type: "string" } }, keywords: { type: "array", items: { type: "string" } },
            copyMode: { type: "string", enum: ["per_person", "fixed"] }, reasoning: { type: "string" },
          },
          required: ["name", "description", "valueProposition", "targetTitles", "targetIndustries", "targetGeographies", "keywords", "copyMode", "reasoning"],
          additionalProperties: false,
        },
      },
      max_tokens: 700,
    });
    const raw = res.choices?.[0]?.message?.content;
    const text = typeof raw === "string" ? raw : Array.isArray(raw) ? raw.map((part: any) => (typeof part?.text === "string" ? part.text : "")).join("") : "{}";
    const parsed = JSON.parse(text || "{}") as Partial<Record<string, unknown>>;
    const arr = (v: unknown, n: number) => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean).slice(0, n) : []);
    const name = String(parsed.name ?? "").trim().slice(0, 200) || fallback.name;
    return {
      name,
      description: String(parsed.description ?? "").trim().slice(0, 1000) || fallback.description,
      valueProposition: String(parsed.valueProposition ?? "").trim().slice(0, 600),
      targeting: {
        targetTitles: arr(parsed.targetTitles, 6).length ? arr(parsed.targetTitles, 6) : fallback.targeting.targetTitles,
        targetIndustries: arr(parsed.targetIndustries, 3).length ? arr(parsed.targetIndustries, 3) : fallback.targeting.targetIndustries,
        targetGeographies: arr(parsed.targetGeographies, 2).length ? arr(parsed.targetGeographies, 2) : fallback.targeting.targetGeographies,
        keywords: arr(parsed.keywords, 5),
      },
      copyMode: parsed.copyMode === "fixed" ? "fixed" : "per_person",
      reasoning: String(parsed.reasoning ?? "").trim().slice(0, 600) || fallback.reasoning,
      usedModel: true,
    };
  } catch (e) {
    console.error(`[campaignProposals] model draft failed for cluster ${cluster.key}:`, (e as Error)?.message ?? e);
    return fallback;
  }
}

/** Ids covered by a pending proposal, or one dismissed inside the cooldown. */
async function coveredProspectIds(workspaceId: number): Promise<{ covered: Set<number>; pendingCount: number; pendingKeys: Set<string> }> {
  const db = await getDb();
  const covered = new Set<number>();
  const pendingKeys = new Set<string>();
  if (!db) return { covered, pendingCount: 0, pendingKeys };
  const since = new Date(Date.now() - DISMISS_COOLDOWN_DAYS * 24 * 60 * 60 * 1000);
  const rows = await db.select({ status: campaignProposals.status, prospectIds: campaignProposals.prospectIds, clusterKey: campaignProposals.clusterKey, decidedAt: campaignProposals.decidedAt })
    .from(campaignProposals)
    .where(and(eq(campaignProposals.workspaceId, workspaceId), or(eq(campaignProposals.status, "pending"), and(eq(campaignProposals.status, "dismissed"), gte(campaignProposals.decidedAt, since)))));
  let pendingCount = 0;
  for (const r of rows) {
    if (r.status === "pending") { pendingCount++; if (r.clusterKey) pendingKeys.add(r.clusterKey); }
    for (const id of (Array.isArray(r.prospectIds) ? r.prospectIds : []) as unknown[]) { const n = Number(id); if (Number.isFinite(n)) covered.add(n); }
  }
  return { covered, pendingCount, pendingKeys };
}

export interface GenerateResult { unplaced: number; clusters: number; created: number; skippedPending: number }

/**
 * Analyse People and record proposals (pending). `max` caps how many new
 * proposals one run may add; the hub is a review queue, not a firehose.
 */
export async function generateProposals(workspaceId: number, opts: { source?: "sweep" | "manual"; max?: number } = {}): Promise<GenerateResult> {
  const db = await getDb();
  const out: GenerateResult = { unplaced: 0, clusters: 0, created: 0, skippedPending: 0 };
  if (!db) return out;
  const { covered, pendingCount, pendingKeys } = await coveredProspectIds(workspaceId);
  const room = Math.max(0, (opts.max ?? MAX_PENDING_PROPOSALS) - pendingCount);
  if (room === 0) { out.skippedPending = pendingCount; return out; }

  const unplaced = await findUnplacedPeople(workspaceId, covered);
  out.unplaced = unplaced.length;
  const clusters = clusterPeople(unplaced).filter((c) => !pendingKeys.has(c.key));
  out.clusters = clusters.length;
  if (clusters.length === 0) return out;

  const existing = await db.select({ name: areCampaigns.name }).from(areCampaigns)
    .where(and(eq(areCampaigns.workspaceId, workspaceId), ne(areCampaigns.status, "archived" as never)));
  const existingNames = existing.map((e) => e.name);
  const taken = new Set(existingNames.map(norm));

  for (const cluster of clusters.slice(0, room)) {
    const draft = await proposeForCluster(workspaceId, cluster, existingNames);
    if (taken.has(norm(draft.name))) continue; // a campaign by that name already exists
    await db.insert(campaignProposals).values({
      workspaceId,
      status: "pending",
      source: opts.source ?? "sweep",
      name: draft.name,
      description: draft.description,
      valueProposition: draft.valueProposition || null,
      targeting: draft.targeting,
      copyMode: draft.copyMode,
      reasoning: draft.reasoning,
      clusterKey: cluster.key,
      prospectIds: cluster.people.map((p) => p.id),
      size: cluster.people.length,
    } as never);
    taken.add(norm(draft.name));
    out.created++;
  }
  return out;
}

export async function listPendingProposals(workspaceId: number, limit = 10) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(campaignProposals)
    .where(and(eq(campaignProposals.workspaceId, workspaceId), eq(campaignProposals.status, "pending")))
    .orderBy(desc(campaignProposals.size), desc(campaignProposals.id))
    .limit(limit);
}

export async function countPendingProposals(workspaceId: number): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const [r] = await db.select({ n: sql<number>`count(*)` }).from(campaignProposals)
    .where(and(eq(campaignProposals.workspaceId, workspaceId), eq(campaignProposals.status, "pending")));
  return Number(r?.n ?? 0);
}

/**
 * Accept: create the campaign — ACTIVE with batch approval, no discovery
 * sources (it exists to absorb the people it was proposed for; the owner
 * can add sources later) — and push the cluster in through the one write
 * path. Returns what happened, per person, the way the wizard does.
 */
export async function acceptProposal(workspaceId: number, proposalId: number, actorUserId: number | null): Promise<{ campaignId: number | null; added: number; skipped: number }> {
  const db = await getDb();
  if (!db) return { campaignId: null, added: 0, skipped: 0 };
  const [p] = await db.select().from(campaignProposals)
    .where(and(eq(campaignProposals.id, proposalId), eq(campaignProposals.workspaceId, workspaceId), eq(campaignProposals.status, "pending"))).limit(1);
  if (!p) throw new Error("Proposal not found or already decided");

  // A campaign needs a present owner: the person accepting, or — for the
  // sweep — the workspace's active owner. No active owner, no campaign
  // (departed-owner cascade: nothing new may be filed under someone gone).
  const ownerUserId = actorUserId ?? (await workspaceNotifyUserId(workspaceId));
  if (!ownerUserId) throw new Error("No active workspace owner to own the new campaign");
  const [row] = await db.insert(areCampaigns).values({
    workspaceId,
    name: p.name,
    description: [p.description, p.valueProposition ? `Value proposition: ${p.valueProposition}` : null].filter(Boolean).join("\n\n") || null,
    autonomyMode: "batch_approval",
    icpOverrides: p.targeting ?? {},
    prospectSources: [],
    targetProspectCount: Math.max(1, p.size),
    dailySendCap: 50,
    channelsEnabled: { email: true, linkedin: false, sms: false, voice: false },
    sequenceTemplate: "standard_7step",
    stepGapDays: 7,
    goalType: "reply",
    signalToOpportunityEnabled: false,
    copyMode: p.copyMode,
    ownerUserId,
    status: "active",
    startedAt: new Date(),
  } as never).$returningId();
  const campaignId = row.id;

  const ids = (Array.isArray(p.prospectIds) ? p.prospectIds : []).map(Number).filter((n) => Number.isFinite(n));
  const { pushPeopleIntoCampaign } = await import("./are/pushPeople");
  let added = 0, skipped = 0;
  for (let i = 0; i < ids.length; i += 100) {
    const r = await pushPeopleIntoCampaign(workspaceId, campaignId, ids.slice(i, i + 100), { generateSequence: true });
    added += r.added.length; skipped += r.skipped.length;
  }

  await db.update(campaignProposals)
    .set({ status: "accepted", decidedAt: new Date(), decidedBy: actorUserId, createdCampaignId: campaignId } as never)
    .where(and(eq(campaignProposals.id, proposalId), eq(campaignProposals.workspaceId, workspaceId)));
  return { campaignId, added, skipped };
}

export async function dismissProposal(workspaceId: number, proposalId: number, actorUserId: number | null): Promise<{ campaignId: null; added: 0; skipped: 0 }> {
  const db = await getDb();
  if (!db) return { campaignId: null, added: 0, skipped: 0 };
  await db.update(campaignProposals)
    .set({ status: "dismissed", decidedAt: new Date(), decidedBy: actorUserId } as never)
    .where(and(eq(campaignProposals.id, proposalId), eq(campaignProposals.workspaceId, workspaceId), eq(campaignProposals.status, "pending")));
  return { campaignId: null, added: 0, skipped: 0 };
}

/**
 * Cron entry, under the Campaign Routing dial: for every workspace with it
 * on, propose campaigns for the unplaced; in auto, create them at once.
 */
export async function runCampaignProposalsAllWorkspaces(): Promise<{ workspaces: number; proposed: number; created: number }> {
  const db = await getDb();
  const out = { workspaces: 0, proposed: 0, created: 0 };
  if (!db) return out;
  const rows = await db.select().from(workspaceSettings).where(ne(workspaceSettings.campaignRoutingMode, "off"));
  const { archivedWorkspaceIds } = await import("../_core/workspaceArchive");
  const archivedWs = await archivedWorkspaceIds();
  for (const ws of rows) {
    if (archivedWs.has(ws.workspaceId)) continue; // archived workspaces are frozen
    try {
      const r = await generateProposals(ws.workspaceId, { source: "sweep" });
      if (r.created === 0) continue;
      out.workspaces++;
      out.proposed += r.created;
      if (ws.campaignRoutingMode === "auto") {
        const pending = await listPendingProposals(ws.workspaceId, MAX_PENDING_PROPOSALS);
        for (const p of pending) {
          if (p.source !== "sweep") continue; // a human's manual run stays theirs to decide
          const a = await acceptProposal(ws.workspaceId, p.id, null);
          if (a.campaignId) out.created++;
        }
      }
      console.log(`[CampaignProposals] ws ${ws.workspaceId} (${ws.campaignRoutingMode}): ${r.unplaced} unplaced → ${r.clusters} clusters → ${r.created} proposed`);
    } catch (e) {
      console.error(`[CampaignProposals] ws ${ws.workspaceId} failed:`, e);
    }
  }
  return out;
}

// Referenced so the import stays honest until per-person overrides need it.
void inArray;
