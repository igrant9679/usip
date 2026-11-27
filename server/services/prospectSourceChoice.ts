/**
 * prospectSourceChoice — one prospect-database source per workspace on a
 * membership plan (owner 2026-11-25): "only allow workspaces to select/use 1
 * prospect data source at a time, but they can change which one at any
 * time … Choose the default that has the highest limits."
 *
 * SCOPE. Only workspaces ON A PLAN are single-source. A workspace with no plan
 * (the platform owner's own, existing client workspaces) keeps its waterfall
 * exactly as it was, so live campaigns are not disturbed: singleSourceFor
 * returns null for it and every caller leaves its source list alone.
 *
 * WHAT IT GOVERNS. Finding people: Revenue Engine discovery, Find prospects,
 * Source search and the Search box / Elsie lookups use ONLY the chosen
 * prospect database. Email lookups (enrichment) are unchanged and still
 * count. Channels that belong to the member (their own LinkedIn account, the
 * internal CRM, news) and Google Business are unchanged.
 *
 * THE DEFAULT, when `workspace_settings.prospectSource` is NULL: the shared
 * pool source with the highest platform monthly ceiling that is not used up
 * and that this workspace can run, ties broken by its number, Apollo last
 * (with the owner's seed: LeadOcean); with no ceilings set, the first
 * prospect database in the workspace's own checking order (its primary).
 */
import { eq } from "drizzle-orm";
import { workspaceSettings } from "../../drizzle/schema";
import { getDb } from "../db";
import { PROSPECT_DATABASE_SLUGS, isProspectDatabase, type ProspectSourceSlug } from "@shared/prospectSources";
import { fullSourceOrder } from "@shared/areSources";
import { planDailyCap } from "@shared/prospectAllowance";
import { anonSourceLabel } from "@shared/sourceNames";
import { membershipPlanOf, allowanceFor, dailyUsedToday, keyOriginDetail, type KeyOriginDetail } from "./prospectAllowance";
import { poolConfig, poolUsedThisMonth } from "./prospectPool";
import { ALWAYS_LAST_SOURCES } from "./prospectPoolSeed";

async function storedChoice(workspaceId: number): Promise<{ choice: string | null; order: unknown }> {
  const db = await getDb();
  if (!db) return { choice: null, order: null };
  const [row] = await db
    .select({ choice: workspaceSettings.prospectSource, order: workspaceSettings.areSourceOrder })
    .from(workspaceSettings)
    .where(eq(workspaceSettings.workspaceId, workspaceId))
    .limit(1);
  return { choice: row?.choice ?? null, order: row?.order ?? null };
}

/**
 * The default source for a workspace that has not chosen one. Only a source
 * this workspace can run counts (a pool source the pool workspace holds no key
 * for is skipped), and Apollo, which reveals no contacts, only when no other
 * ceilinged source has room.
 */
export async function defaultSourceFor(workspaceId: number, order?: unknown): Promise<ProspectSourceSlug> {
  const cfg = await poolConfig();
  const ceilinged = Object.values(cfg.sources).filter((s) => s.shared && isProspectDatabase(s.slug) && s.monthlyCeiling != null);
  if (ceilinged.length > 0) {
    const withRoom: typeof ceilinged = [];
    for (const s of ceilinged) {
      const from = await keyOriginDetail(workspaceId, s.slug as ProspectSourceSlug).catch(() => "none" as const);
      if (from === "none") continue;
      if (from === "pool" && (await poolUsedThisMonth(s.slug)) >= (s.monthlyCeiling ?? 0)) continue;
      withRoom.push(s);
    }
    const lastly = (slug: string) => (ALWAYS_LAST_SOURCES.includes(slug) ? 1 : 0);
    withRoom.sort((a, b) => (lastly(a.slug) - lastly(b.slug)) || ((b.monthlyCeiling ?? 0) - (a.monthlyCeiling ?? 0)) || (a.number - b.number));
    if (withRoom[0]) return withRoom[0].slug as ProspectSourceSlug;
  }
  const own = order === undefined ? (await storedChoice(workspaceId)).order : order;
  const first = fullSourceOrder(own).find((id) => isProspectDatabase(id));
  return (first ?? PROSPECT_DATABASE_SLUGS[0]) as ProspectSourceSlug;
}

/**
 * The one prospect database this workspace finds people through, or null
 * when it is on no plan (then nothing changes: its waterfall runs as before).
 * An unreadable plan also reads as null here: the allowance holds refuse
 * shared data in that case on their own, and own keys keep working.
 */
export async function singleSourceFor(workspaceId: number): Promise<{ slug: ProspectSourceSlug; chosen: boolean } | null> {
  try {
    const plan = await membershipPlanOf(workspaceId);
    if (!plan) return null;
    const { choice, order } = await storedChoice(workspaceId);
    if (isProspectDatabase(choice)) return { slug: choice, chosen: true };
    return { slug: await defaultSourceFor(workspaceId, order), chosen: false };
  } catch (e) {
    console.error(`[prospectSourceChoice] could not read workspace ${workspaceId}'s plan or source; its source list is left as it is:`, (e as Error)?.message);
    return null;
  }
}

/**
 * A source list with the single-source rule applied: every prospect database
 * but the chosen one dropped, and the chosen one put where the first of them
 * stood (so a campaign that sources from any prospect database sources from
 * the chosen one). Lists with no prospect database (discovery off, LinkedIn
 * only) are left as they are. Null rule = the list unchanged.
 */
export function applySingleSource<T extends string>(list: readonly T[], single: { slug: string } | null): T[] {
  if (!single) return [...list];
  const at = list.findIndex((id) => isProspectDatabase(id));
  if (at === -1) return [...list];
  const rest = list.filter((id) => !isProspectDatabase(id));
  rest.splice(Math.min(at, rest.length), 0, single.slug as T);
  return rest;
}

export type SourceChoice = {
  slug: ProspectSourceSlug;
  /** "Source N", always, for every viewer of this list. */
  label: string;
  description: string;
  number: number;
  /** Whose key it runs on here: the workspace's own key, a loan, the pool, or none. */
  keyFrom: KeyOriginDetail;
  /** Whether it has room this month: the plan's month, today's cap, and the pool's ceiling. */
  hasRoom: boolean;
  /** Why not, when it has none. */
  roomNote: string | null;
  chosen: boolean;
  isDefault: boolean;
};

/** The choices Settings → Data sources offers a workspace on a plan, with room this month. */
export async function sourceChoices(workspaceId: number): Promise<{ onPlan: boolean; current: ProspectSourceSlug | null; chosen: boolean; choices: SourceChoice[] }> {
  const plan = await membershipPlanOf(workspaceId);
  const cfg = await poolConfig();
  const single = plan ? await singleSourceFor(workspaceId) : null;
  const def = plan ? await defaultSourceFor(workspaceId) : null;
  const allowance = plan ? await allowanceFor(workspaceId) : { plan: null };
  const choices: SourceChoice[] = [];
  for (const slug of PROSPECT_DATABASE_SLUGS) {
    const s = cfg.sources[slug];
    if (!s) continue;
    const keyFrom = await keyOriginDetail(workspaceId, slug).catch(() => "none" as const);
    if (keyFrom === "none") continue;
    let hasRoom = true;
    let roomNote: string | null = null;
    if (keyFrom !== "own") {
      if (keyFrom === "pool" && s.monthlyCeiling != null && (await poolUsedThisMonth(slug)) >= s.monthlyCeiling) {
        hasRoom = false; roomNote = "used up for this month";
      } else if (allowance.plan && allowance.remaining <= 0) {
        hasRoom = false; roomNote = "your plan's prospect data for this month is used up";
      } else if (plan && (await dailyUsedToday(workspaceId, slug)) >= planDailyCap(plan)) {
        hasRoom = false; roomNote = "today's limit is reached";
      }
    }
    choices.push({
      slug, label: anonSourceLabel(s.number), description: s.description, number: s.number, keyFrom,
      hasRoom, roomNote, chosen: single?.chosen === true && single.slug === slug, isDefault: def === slug,
    });
  }
  choices.sort((a, b) => a.number - b.number);
  return { onPlan: !!plan, current: single?.slug ?? null, chosen: single?.chosen ?? false, choices };
}

/** Choose (or, with null, go back to the default) this workspace's one prospect database. */
export async function setProspectSource(workspaceId: number, slug: ProspectSourceSlug | null): Promise<void> {
  if (slug !== null && !isProspectDatabase(slug)) throw new Error(`"${String(slug)}" is not a prospect source`);
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");
  const [existing] = await db.select({ workspaceId: workspaceSettings.workspaceId }).from(workspaceSettings)
    .where(eq(workspaceSettings.workspaceId, workspaceId)).limit(1);
  if (existing) await db.update(workspaceSettings).set({ prospectSource: slug }).where(eq(workspaceSettings.workspaceId, workspaceId));
  else await db.insert(workspaceSettings).values({ workspaceId, prospectSource: slug });
}
