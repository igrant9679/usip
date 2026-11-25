/**
 * prospectPool — one shared pool of prospect-source keys for every workspace
 * (owner 2026-11-25, chosen over lending keys one workspace at a time).
 *
 * The platform owner (users.role 'admin') names one POOL WORKSPACE. Each of
 * its prospect-source keys can be shared with every workspace, source by
 * source, each with:
 *   - a platform monthly CEILING: the vendor account's real monthly
 *     allowance, which the owner enters. Pool data used by any workspace
 *     counts against it (prospect_pool_usage), consumed together with the
 *     workspace's own allowance; once it is used up the source is
 *     unavailable from the pool until the month turns.
 *   - a public NUMBER and DESCRIPTION: members see "Source N" and the
 *     description, never the vendor's name (shared/sourceNames.ts).
 *
 * Key resolution everywhere (services/keyShares): the workspace's own key →
 * an explicit loan → the pool, when that source is shared → QuickEnrich's
 * environment key. Existing and new workspaces get the pool with no step of
 * their own; a workspace's own key always wins and is never counted. The
 * pool workspace itself uses its keys as its own.
 *
 * A failed read of the pool settings shares nothing (the rule every lent key
 * follows): a source with no other key is then simply not available.
 */
import { and, eq, inArray, lte, sql } from "drizzle-orm";
import { platformSettings, prospectPoolSources, prospectPoolUsage, workspaces } from "../../drizzle/schema";
import { getDb } from "../db";
import { affectedRowsOf } from "../_core/claim";
import { PROSPECT_DATABASE_SLUGS, type ProspectSourceSlug } from "@shared/prospectSources";
import { allowancePeriod } from "@shared/prospectAllowance";
import {
  DEFAULT_SOURCE_DESCRIPTION,
  anonSourceLabel,
  anonymizeVendorText,
  numberSources,
  type SourceName,
  type VendorLabel,
} from "@shared/sourceNames";

export const POOL_SETTING_KEY = "prospectPool";

export type PoolSource = {
  slug: string;
  shared: boolean;
  /** The vendor account's real monthly allowance; null = not entered (uncapped). */
  monthlyCeiling: number | null;
  /** The public number, "Source N": stored, or the seeded one. */
  number: number;
  /** The number as stored (null until the owner or the seeding sets one). */
  storedNumber: number | null;
  description: string;
};

export type PoolConfig = {
  poolWorkspaceId: number | null;
  /** The pool workspace is archived: it lends nothing. */
  poolArchived: boolean;
  sources: Record<string, PoolSource>;
};

const EMPTY: PoolConfig = { poolWorkspaceId: null, poolArchived: false, sources: {} };
const TTL_MS = 30_000;
let cache: { at: number; value: PoolConfig } | null = null;

/** Drop the cached settings (after a platform-owner change, and in tests). */
export function invalidatePoolCache(): void {
  cache = null;
}

function buildSources(rows: Array<typeof prospectPoolSources.$inferSelect>): Record<string, PoolSource> {
  const byslug = new Map(rows.map((r) => [r.slug, r]));
  const slugs = Array.from(new Set([...PROSPECT_DATABASE_SLUGS, ...rows.map((r) => r.slug)]));
  const numbers = numberSources(slugs, Object.fromEntries(rows.map((r) => [r.slug, { number: r.sourceNumber, ceiling: r.monthlyCeiling }])));
  const out: Record<string, PoolSource> = {};
  for (const slug of slugs) {
    const r = byslug.get(slug);
    out[slug] = {
      slug,
      shared: !!r?.shared,
      monthlyCeiling: r?.monthlyCeiling ?? null,
      number: numbers[slug],
      storedNumber: r?.sourceNumber ?? null,
      description: (r?.description ?? "").trim() || DEFAULT_SOURCE_DESCRIPTION,
    };
  }
  return out;
}

/** The pool settings, read at most every 30 seconds. A failed read is no pool. */
export async function poolConfig(): Promise<PoolConfig> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.value;
  try {
    const db = await getDb();
    if (!db) return EMPTY;
    const [setting] = await db.select({ value: platformSettings.value }).from(platformSettings)
      .where(eq(platformSettings.settingKey, POOL_SETTING_KEY)).limit(1);
    const id = Number((setting?.value as { workspaceId?: unknown } | null)?.workspaceId);
    const poolWorkspaceId = Number.isInteger(id) && id > 0 ? id : null;
    let poolArchived = false;
    if (poolWorkspaceId) {
      const [w] = await db.select({ archivedAt: workspaces.archivedAt }).from(workspaces).where(eq(workspaces.id, poolWorkspaceId)).limit(1);
      poolArchived = !w || !!w.archivedAt;
    }
    const rows = await db.select().from(prospectPoolSources);
    const value: PoolConfig = { poolWorkspaceId, poolArchived, sources: buildSources(rows) };
    cache = { at: Date.now(), value };
    return value;
  } catch (e) {
    console.error("[prospectPool] settings unreadable; nothing is shared until they can be read:", (e as Error)?.message);
    return { ...EMPTY, sources: buildSources([]) };
  }
}

/** The workspace that lends `workspaceId` this source from the pool, or null. */
export async function poolLenderFor(workspaceId: number, slug: string): Promise<number | null> {
  if (!workspaceId) return null;
  const cfg = await poolConfig();
  if (!cfg.poolWorkspaceId || cfg.poolArchived || cfg.poolWorkspaceId === workspaceId) return null;
  return cfg.sources[slug]?.shared ? cfg.poolWorkspaceId : null;
}

/* ─── The platform ceiling ──────────────────────────────────────────────── */

async function poolUsedIn(slug: string, period: string): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const [row] = await db.select({ used: prospectPoolUsage.used }).from(prospectPoolUsage)
    .where(and(eq(prospectPoolUsage.slug, slug), eq(prospectPoolUsage.period, period))).limit(1);
  return Number(row?.used ?? 0);
}

/** Pool data used this month for one source, across every workspace. */
export async function poolUsedThisMonth(slug: string, at: Date = new Date()): Promise<number> {
  return poolUsedIn(slug, allowancePeriod(at));
}

/**
 * Take up to `n` units of a source's monthly platform ceiling; returns how
 * many. A conditional UPDATE (`used <= ceiling − take`) that re-reads after a
 * lost race, so the counter never passes the ceiling. With no ceiling set the
 * use is still counted and the whole ask granted.
 */
export async function tryConsumePool(slug: string, n: number, ceiling: number | null, period: string = allowancePeriod()): Promise<number> {
  const want = Math.floor(Number(n) || 0);
  if (want <= 0) return 0;
  const db = await getDb();
  if (!db) return 0;
  await db.insert(prospectPoolUsage).values({ slug, period, used: 0 }).onDuplicateKeyUpdate({ set: { slug } });
  if (ceiling == null) {
    await db.update(prospectPoolUsage).set({ used: sql`${prospectPoolUsage.used} + ${want}` })
      .where(and(eq(prospectPoolUsage.slug, slug), eq(prospectPoolUsage.period, period)));
    return want;
  }
  for (let attempt = 0; attempt < 5; attempt++) {
    const used = await poolUsedIn(slug, period);
    const take = Math.min(want, ceiling - used);
    if (take <= 0) return 0;
    const res = await db.update(prospectPoolUsage).set({ used: sql`${prospectPoolUsage.used} + ${take}` })
      .where(and(eq(prospectPoolUsage.slug, slug), eq(prospectPoolUsage.period, period), lte(prospectPoolUsage.used, ceiling - take)));
    if (affectedRowsOf(res) > 0) return take;
  }
  return 0;
}

/** Give back pool units held and not delivered. Never below zero. */
export async function refundPool(slug: string, k: number, period: string = allowancePeriod()): Promise<void> {
  const back = Math.floor(Number(k) || 0);
  if (back <= 0) return;
  const db = await getDb();
  if (!db) return;
  const { gte, lt } = await import("drizzle-orm");
  const res = await db.update(prospectPoolUsage).set({ used: sql`${prospectPoolUsage.used} + ${-back}` })
    .where(and(eq(prospectPoolUsage.slug, slug), eq(prospectPoolUsage.period, period), gte(prospectPoolUsage.used, back)));
  if (affectedRowsOf(res) === 0) {
    await db.update(prospectPoolUsage).set({ used: 0 })
      .where(and(eq(prospectPoolUsage.slug, slug), eq(prospectPoolUsage.period, period), lt(prospectPoolUsage.used, back)));
  }
}

/** Whether a pool source has room this month: true with no ceiling set. */
export async function poolHasRoom(slug: string): Promise<boolean> {
  const cfg = await poolConfig();
  const c = cfg.sources[slug]?.monthlyCeiling ?? null;
  if (c == null) return true;
  return (await poolUsedThisMonth(slug)) < c;
}

/* ─── Names ─────────────────────────────────────────────────────────────── */

/** The registry's true names, read lazily (the registry imports this module's callers). */
async function trueNames(): Promise<Record<string, string>> {
  const { listSources } = await import("./prospectSources/registry");
  return Object.fromEntries(listSources().map((s) => [s.slug, s.displayName]));
}

/**
 * What each source is called for this viewer: the platform owner reads the
 * vendor's name, everyone else "Source N" and the description.
 */
export async function sourceNamesFor(viewer: { platformOwner: boolean }): Promise<SourceName[]> {
  const cfg = await poolConfig();
  const names = viewer.platformOwner ? await trueNames() : {};
  return Object.values(cfg.sources)
    .sort((a, b) => a.number - b.number)
    .map((s) => ({
      slug: s.slug,
      number: s.number,
      label: viewer.platformOwner ? (names[s.slug] ?? s.slug) : anonSourceLabel(s.number),
      description: s.description,
    }));
}

/** "Source N" for one slug, as every member reads it. */
export async function memberSourceLabel(slug: string): Promise<string> {
  const cfg = await poolConfig();
  const s = cfg.sources[slug];
  return s ? anonSourceLabel(s.number) : slug;
}

/** Every vendor's spelling and its "Source N", for text that reaches members. */
export async function memberVendorLabels(): Promise<VendorLabel[]> {
  const cfg = await poolConfig();
  let names: Record<string, string> = {};
  try { names = await trueNames(); } catch { /* the known spellings still apply */ }
  return Object.values(cfg.sources).map((s) => ({ slug: s.slug, displayName: names[s.slug] ?? null, label: anonSourceLabel(s.number) }));
}

/**
 * A sentence as members may read it: every vendor's name replaced by its
 * "Source N". The sinks of member-facing server text call this (engine and
 * run logs, notes, notification bodies). Never throws: on a failed read the
 * names are replaced by the seeded numbers.
 */
export async function forMembers(text: string): Promise<string> {
  try {
    return anonymizeVendorText(text, await memberVendorLabels());
  } catch {
    return anonymizeVendorText(text, Object.values(buildSources([])).map((s) => ({ slug: s.slug, label: anonSourceLabel(s.number) })));
  }
}

/* ─── The platform owner's settings ─────────────────────────────────────── */

/** Name (or clear, with null) the pool workspace. */
export async function setPoolWorkspace(workspaceId: number | null): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");
  const value = { workspaceId };
  const [existing] = await db.select({ k: platformSettings.settingKey }).from(platformSettings)
    .where(eq(platformSettings.settingKey, POOL_SETTING_KEY)).limit(1);
  if (existing) await db.update(platformSettings).set({ value }).where(eq(platformSettings.settingKey, POOL_SETTING_KEY));
  else await db.insert(platformSettings).values({ settingKey: POOL_SETTING_KEY, value });
  invalidatePoolCache();
}

export type PoolSourcePatch = { shared?: boolean; monthlyCeiling?: number | null; number?: number | null; description?: string | null };

/**
 * Change one pool source. Once any ceiling is set and no number has been
 * stored yet, every source is numbered in descending ceiling order (the
 * seeding), so Source 1 is the default; after that numbers change only when
 * the owner changes them.
 */
export async function setPoolSource(slug: ProspectSourceSlug | string, patch: PoolSourcePatch): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");
  const set: Record<string, unknown> = {};
  if (patch.shared !== undefined) set.shared = patch.shared;
  if (patch.monthlyCeiling !== undefined) set.monthlyCeiling = patch.monthlyCeiling;
  if (patch.number !== undefined) set.sourceNumber = patch.number;
  if (patch.description !== undefined) set.description = patch.description ? patch.description.trim().slice(0, 255) : null;
  const [existing] = await db.select({ slug: prospectPoolSources.slug }).from(prospectPoolSources)
    .where(eq(prospectPoolSources.slug, slug)).limit(1);
  if (existing) {
    if (Object.keys(set).length) await db.update(prospectPoolSources).set(set).where(eq(prospectPoolSources.slug, slug));
  } else {
    await db.insert(prospectPoolSources).values({ slug, shared: false, ...set } as never);
  }
  // The seeding: numbers follow the ceilings, once.
  const rows = await db.select().from(prospectPoolSources);
  if (rows.some((r) => r.monthlyCeiling != null) && rows.every((r) => r.sourceNumber == null)) {
    const slugs = Array.from(new Set([...PROSPECT_DATABASE_SLUGS, ...rows.map((r) => r.slug)]));
    const seeded = numberSources(slugs, Object.fromEntries(rows.map((r) => [r.slug, { ceiling: r.monthlyCeiling }])));
    const have = new Set(rows.map((r) => r.slug));
    for (const s of slugs) {
      if (have.has(s)) await db.update(prospectPoolSources).set({ sourceNumber: seeded[s] }).where(eq(prospectPoolSources.slug, s));
      else await db.insert(prospectPoolSources).values({ slug: s, shared: false, sourceNumber: seeded[s] } as never);
    }
  }
  invalidatePoolCache();
}

export type PoolOverviewRow = PoolSource & { trueName: string; usedThisMonth: number; poolHasKey: boolean };

/** The platform owner's view: the pool workspace and, per source, its true name, switch, ceiling and use. */
export async function poolOverview(): Promise<{ poolWorkspaceId: number | null; poolWorkspaceName: string | null; poolArchived: boolean; sources: PoolOverviewRow[] }> {
  invalidatePoolCache();
  const cfg = await poolConfig();
  const names = await trueNames();
  const db = await getDb();
  let poolWorkspaceName: string | null = null;
  if (db && cfg.poolWorkspaceId) {
    const [w] = await db.select({ name: workspaces.name }).from(workspaces).where(inArray(workspaces.id, [cfg.poolWorkspaceId])).limit(1);
    poolWorkspaceName = w?.name ?? null;
  }
  const { ownKeyKinds } = await import("./keyShares");
  const own = cfg.poolWorkspaceId ? await ownKeyKinds(cfg.poolWorkspaceId).catch(() => new Set<string>()) : new Set<string>();
  const rows: PoolOverviewRow[] = [];
  for (const s of Object.values(cfg.sources).sort((a, b) => a.number - b.number)) {
    rows.push({ ...s, trueName: names[s.slug] ?? s.slug, usedThisMonth: await poolUsedThisMonth(s.slug), poolHasKey: own.has(s.slug as never) || (await poolTableKey(cfg.poolWorkspaceId, s.slug)) });
  }
  return { poolWorkspaceId: cfg.poolWorkspaceId, poolWorkspaceName, poolArchived: cfg.poolArchived, sources: rows };
}

/** Whether the pool workspace keeps a credential row for a table-mode source (a source added later). */
async function poolTableKey(poolWorkspaceId: number | null, slug: string): Promise<boolean> {
  if (!poolWorkspaceId) return false;
  const { prospectSourceCredentials } = await import("../../drizzle/schema");
  const db = await getDb();
  if (!db) return false;
  const [r] = await db.select({ status: prospectSourceCredentials.status, enc: prospectSourceCredentials.credentialsEnc })
    .from(prospectSourceCredentials)
    .where(and(eq(prospectSourceCredentials.workspaceId, poolWorkspaceId), eq(prospectSourceCredentials.sourceSlug, slug))).limit(1);
  return !!r && r.status !== "revoked" && !!r.enc;
}

/* ─── Who may read the true names ───────────────────────────────────────── */

/** The platform owner (users.role 'admin') is the one reader of vendors' true names. */
export function isPlatformOwner(user: { role?: string | null } | null | undefined): boolean {
  return user?.role === "admin";
}

/**
 * A value as members may read it: every string in it with vendor names
 * replaced by "Source N". Object keys and strings that ARE a source slug are
 * left alone (the client keys its lookups on slugs); only prose changes.
 * The platform owner reads the value as it is.
 */
export async function forViewer<T>(value: T, viewer: { platformOwner: boolean }): Promise<T> {
  if (viewer.platformOwner) return value;
  let labels: VendorLabel[];
  try { labels = await memberVendorLabels(); } catch { return value; }
  const slugs = new Set(labels.map((l) => l.slug));
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return slugs.has(v) ? v : anonymizeVendorText(v, labels);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object" && !(v instanceof Date)) {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = walk(x);
      return out;
    }
    return v;
  };
  return walk(value) as T;
}
