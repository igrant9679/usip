/**
 * ONE identity vocabulary for ARE queue prospects — dedup and campaign
 * exclusivity share it (owner directive, 2026-08-12: a prospect may belong
 * to only ONE ARE campaign at a time).
 *
 * Keys, strongest first:
 *   u:<linkedin slug>      extractLinkedInIdentifier — URL-shape tolerant, so
 *                          m.linkedin.com and trailing-junk variants of the
 *                          same profile collide like they should
 *   e:<email lowercased>
 *   n:<name@org>           canonicalText name + companyDomain-or-name — the
 *                          nameOrgDedupKey the engine's within-campaign dedup
 *                          already used (normalized EXACT match, never
 *                          edit-distance: two different people at one company
 *                          must not merge)
 *
 * Raw lowercased URLs are ALSO emitted alongside the slug so pre-existing
 * `u:`-keyed sets keep matching rows stored before slug-keying existed.
 */
import { and, eq } from "drizzle-orm";
import { prospectQueue } from "../../../drizzle/schema";
import { canonicalText } from "@shared/canonicalText";
import { extractLinkedInIdentifier } from "../linkedinLookup";
import { getDb } from "../../db";

export interface QueueIdentityShape {
  email?: unknown;
  linkedinUrl?: unknown;
  firstName?: unknown;
  lastName?: unknown;
  companyName?: unknown;
  companyDomain?: unknown;
}

export function nameOrgDedupKey(p: QueueIdentityShape): string | null {
  const norm = canonicalText;
  const name = `${norm(p.firstName)} ${norm(p.lastName)}`.trim();
  const org = norm(p.companyDomain) || norm(p.companyName);
  if (!name || !org) return null;
  return `n:${name}@${org}`;
}

/** Every identity key this row can be recognized by. */
export function queueIdentityKeys(p: QueueIdentityShape): string[] {
  const out: string[] = [];
  const email = String(p.email ?? "").trim().toLowerCase();
  if (email) out.push(`e:${email}`);
  const url = String(p.linkedinUrl ?? "").trim().toLowerCase();
  if (url) {
    out.push(`u:${url}`);
    const slug = extractLinkedInIdentifier(url);
    if (slug) out.push(`u:${slug}`);
  }
  const nk = nameOrgDedupKey(p);
  if (nk) out.push(nk);
  return out;
}

/**
 * Index of every queue prospect in the workspace, keyed by identity —
 * the exclusivity check's source of truth. On key collision the FIRST
 * (lowest-id) row wins, which keeps the answer stable across runs.
 */
export async function workspaceQueueIdentityIndex(
  workspaceId: number,
): Promise<Map<string, { rowId: number; campaignId: number | null }>> {
  const db = await getDb();
  const index = new Map<string, { rowId: number; campaignId: number | null }>();
  if (!db) return index;
  const rows = await db
    .select({
      id: prospectQueue.id,
      campaignId: prospectQueue.campaignId,
      email: prospectQueue.email,
      linkedinUrl: prospectQueue.linkedinUrl,
      firstName: prospectQueue.firstName,
      lastName: prospectQueue.lastName,
      companyName: prospectQueue.companyName,
      companyDomain: prospectQueue.companyDomain,
    })
    .from(prospectQueue)
    .where(and(eq(prospectQueue.workspaceId, workspaceId)))
    .orderBy(prospectQueue.id);
  for (const r of rows) {
    for (const k of queueIdentityKeys(r)) {
      if (!index.has(k)) index.set(k, { rowId: r.id, campaignId: r.campaignId });
    }
  }
  return index;
}

/**
 * The campaign a row's identity already belongs to, if any — the exclusivity
 * verdict. `null` means the person is unknown to the workspace queue.
 */
export function existingClaim(
  index: Map<string, { rowId: number; campaignId: number | null }>,
  p: QueueIdentityShape,
): { rowId: number; campaignId: number | null } | null {
  for (const k of queueIdentityKeys(p)) {
    const hit = index.get(k);
    if (hit) return hit;
  }
  return null;
}
