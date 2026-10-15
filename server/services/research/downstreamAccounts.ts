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
import { and, eq } from "drizzle-orm";
import { accountDomains, accounts, downstreamLinks } from "../../../drizzle/schema";
import { getDb } from "../../db";
import { normalizeCompanyName, normalizeDomain } from "../company/normalize";
import type { DownstreamAward } from "@shared/downstreamMap";

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
    return {
      accountId: id,
      award: (cf.downstreamAward as DownstreamAward | undefined) ?? null,
      fit: (cf.downstreamFit as DownstreamAccountFacts["fit"] | undefined) ?? null,
    };
  } catch {
    return null;
  }
}

/**
 * Sectors imported through a PAUSED Downstream link are kept but not used:
 * not by the writers, targeting, or the ICP (Downstream's rule: "paused links
 * are ignored by the context composer and targeting but keep their data").
 * Returns a test for a sector's (source, sourceRef).
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
