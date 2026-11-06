/**
 * Accounts and Downstream organizations (Research phase 5).
 *
 * matchAccount: the account an organization already is in this workspace —
 * website domain first (the account's own, then its extra domains), then the
 * normalized name together with the state, since "Washington County" exists
 * in thirty states. downstreamAccountFor: what an import stored on the account
 * a prospect works at (its award and, for the seller, its fit), by the
 * prospect's company domain or name.
 */
import { and, eq, inArray } from "drizzle-orm";
import { accountDomains, accounts, downstreamLinks } from "../../../drizzle/schema";
import { getDb } from "../../db";
import { normalizeCompanyName, normalizeDomain } from "../company/normalize";
import { mostRelevantAward, storedAwards, type DownstreamAward } from "@shared/downstreamMap";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

export async function matchAccount(
  db: Db,
  workspaceId: number,
  org: { website?: string | null; name: string; state?: string | null },
): Promise<number | null> {
  const domain = normalizeDomain(org.website ?? "");
  if (domain) {
    const [a] = await db
      .select({ id: accounts.id })
      .from(accounts)
      .where(and(eq(accounts.workspaceId, workspaceId), eq(accounts.normalizedDomain, domain)))
      .limit(1);
    if (a) return a.id;
    const [d] = await db
      .select({ id: accountDomains.accountId })
      .from(accountDomains)
      .where(and(eq(accountDomains.workspaceId, workspaceId), eq(accountDomains.normalizedDomain, domain)))
      .limit(1);
    if (d) return d.id;
  }
  const name = normalizeCompanyName(org.name);
  if (!name) return null;
  const rows = await db
    .select({ id: accounts.id, hqState: accounts.hqState })
    .from(accounts)
    .where(and(eq(accounts.workspaceId, workspaceId), eq(accounts.normalizedName, name)))
    .limit(20);
  const state = (org.state ?? "").trim().toLowerCase();
  const sameState = rows.find((r) => (r.hqState ?? "").trim().toLowerCase() === state && state);
  if (sameState) return sameState.id;
  // A name with no state on either side is still the best match there is.
  const stateless = rows.find((r) => !(r.hqState ?? "").trim() && !state);
  return stateless?.id ?? null;
}

const CHUNK = 500;
const chunks = <T,>(xs: T[]): T[][] => Array.from({ length: Math.ceil(xs.length / CHUNK) }, (_, i) => xs.slice(i * CHUNK, (i + 1) * CHUNK));

/**
 * Which organizations matchAccount would find an account for, by the same
 * rules, in a few batched reads instead of one or three per row: the preview
 * counts new against matched for up to 10,000 rows (audit 2026-10-20, P109).
 * `known` maps an organization ref to the account an earlier import wrote it
 * to; that account, if it is still there, is its match.
 */
export async function existingAccountMatches(
  db: Db,
  workspaceId: number,
  orgs: { ref: string; website?: string | null; name: string; state?: string | null }[],
  known: Map<string, number>,
): Promise<Set<string>> {
  const matched = new Set<string>();
  const ids = Array.from(new Set(orgs.map((o) => known.get(o.ref)).filter((v): v is number => v != null)));
  const alive = new Set<number>();
  for (const part of chunks(ids)) {
    const rows = await db.select({ id: accounts.id }).from(accounts).where(and(eq(accounts.workspaceId, workspaceId), inArray(accounts.id, part)));
    for (const r of rows) alive.add(r.id);
  }
  for (const o of orgs) if (alive.has(known.get(o.ref) ?? -1)) matched.add(o.ref);

  const domainOf = new Map(orgs.map((o) => [o.ref, normalizeDomain(o.website ?? "")]));
  const domains = Array.from(new Set(orgs.filter((o) => !matched.has(o.ref)).map((o) => domainOf.get(o.ref)!).filter(Boolean)));
  const hitDomains = new Set<string>();
  for (const part of chunks(domains)) {
    const a = await db.select({ d: accounts.normalizedDomain }).from(accounts).where(and(eq(accounts.workspaceId, workspaceId), inArray(accounts.normalizedDomain, part)));
    const d = await db.select({ d: accountDomains.normalizedDomain }).from(accountDomains).where(and(eq(accountDomains.workspaceId, workspaceId), inArray(accountDomains.normalizedDomain, part)));
    for (const r of [...a, ...d]) if (r.d) hitDomains.add(r.d);
  }
  for (const o of orgs) if (!matched.has(o.ref) && hitDomains.has(domainOf.get(o.ref)!)) matched.add(o.ref);

  const nameOf = new Map(orgs.map((o) => [o.ref, normalizeCompanyName(o.name)]));
  const names = Array.from(new Set(orgs.filter((o) => !matched.has(o.ref)).map((o) => nameOf.get(o.ref)!).filter(Boolean)));
  const statesByName = new Map<string, string[]>();
  for (const part of chunks(names)) {
    const rows = await db.select({ n: accounts.normalizedName, s: accounts.hqState }).from(accounts).where(and(eq(accounts.workspaceId, workspaceId), inArray(accounts.normalizedName, part)));
    for (const r of rows) if (r.n) statesByName.set(r.n, [...(statesByName.get(r.n) ?? []), (r.s ?? "").trim().toLowerCase()]);
  }
  for (const o of orgs) {
    if (matched.has(o.ref)) continue;
    const states = statesByName.get(nameOf.get(o.ref)!);
    if (!states) continue;
    const state = (o.state ?? "").trim().toLowerCase();
    if (state ? states.includes(state) : states.includes("")) matched.add(o.ref);
  }
  return matched;
}

export type DownstreamAccountFacts = {
  accountId: number;
  award: DownstreamAward | null;
  fit: { product?: string; flags?: string[]; openingLine?: string } | null;
};

/** The Downstream facts on the account a prospect works at, or null. */
export async function downstreamAccountFor(
  workspaceId: number,
  company: { companyDomain?: string | null; companyName?: string | null; state?: string | null },
): Promise<DownstreamAccountFacts | null> {
  try {
    const db = await getDb();
    if (!db) return null;
    const id = await matchAccount(db, workspaceId, { website: company.companyDomain, name: company.companyName ?? "", state: company.state });
    if (id == null) return null;
    const [a] = await db
      .select({ customFields: accounts.customFields })
      .from(accounts)
      .where(and(eq(accounts.id, id), eq(accounts.workspaceId, workspaceId)))
      .limit(1);
    const cf = (a?.customFields && typeof a.customFields === "object" ? a.customFields : {}) as Record<string, unknown>;
    if (!cf.downstreamRef) return null;
    // A paused link's award and fit are kept but not used (audit 2026-10-20, P23).
    if ((await pausedDownstreamFilter(workspaceId))({ source: "downstream", sourceRef: String(cf.downstreamRef) })) return null;
    return {
      accountId: id,
      // Picked from every award the company has, by the current rule; older imports hold only downstreamAward.
      award: mostRelevantAward(storedAwards(cf.downstreamAwards)) ?? (cf.downstreamAward as DownstreamAward | undefined) ?? null,
      fit: (cf.downstreamFit as DownstreamAccountFacts["fit"] | undefined) ?? null,
    };
  } catch {
    return null;
  }
}

/**
 * Research imported through a PAUSED Downstream link is kept but not used:
 * not by the writers, targeting, or the ICP (Downstream's rule: "paused links
 * are ignored by the context composer and targeting but keep their data").
 * Returns a test for a sector's, persona's or account's (source, sourceRef):
 * every Downstream ref starts with its workspace id.
 */
export async function pausedDownstreamFilter(workspaceId: number): Promise<(s: { source?: string | null; sourceRef?: string | null }) => boolean> {
  const db = await getDb();
  if (!db) return () => false;
  const paused = await db
    .select({ id: downstreamLinks.downstreamWorkspaceId })
    .from(downstreamLinks)
    .where(and(eq(downstreamLinks.workspaceId, workspaceId), eq(downstreamLinks.status, "paused")));
  const prefixes = paused.map((p) => p.id);
  if (!prefixes.length) return () => false;
  return (s) => s.source === "downstream" && !!s.sourceRef && prefixes.some((p) => s.sourceRef === p || s.sourceRef!.startsWith(`${p}/`));
}

/** Does the workspace have an active Downstream link whose seller layer is its own? */
export async function hasSellerDownstreamLink(workspaceId: number): Promise<boolean> {
  try {
    const db = await getDb();
    if (!db) return false;
    const [row] = await db
      .select({ id: downstreamLinks.id })
      .from(downstreamLinks)
      .where(and(eq(downstreamLinks.workspaceId, workspaceId), eq(downstreamLinks.status, "active"), eq(downstreamLinks.useSellerMessaging, true)))
      .limit(1);
    return !!row;
  } catch {
    return false;
  }
}
