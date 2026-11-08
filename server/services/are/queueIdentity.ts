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
import { and, asc, eq, inArray, isNull, or, type SQL } from "drizzle-orm";
import { areCampaigns, prospectQueue } from "../../../drizzle/schema";
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
 *
 * Only rows whose campaign still exists (audit 2026-10-20, A18): a deleted
 * campaign's people stayed claimed by it forever and could never join another.
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
    .innerJoin(areCampaigns, and(eq(areCampaigns.id, prospectQueue.campaignId), eq(areCampaigns.workspaceId, workspaceId)))
    .where(and(eq(prospectQueue.workspaceId, workspaceId)))
    .orderBy(prospectQueue.id);
  for (const r of rows) {
    for (const k of queueIdentityKeys(r)) {
      if (!index.has(k)) index.set(k, { rowId: r.id, campaignId: r.campaignId });
    }
  }
  return index;
}

/* ── Stored identity columns (migration 0333, audit 2026-10-20, A34) ──────
 *
 * The index above reads the workspace's whole queue: once per discovery run
 * and once per manual save. prospect_queue now stores each row's keys in
 * three indexed columns, made by queueIdentityColumns from queueIdentityKeys
 * (still the one definition), so a check reads only the rows that share a key
 * with the people being checked.
 *
 *   identityEmail     the e: key            ix (workspaceId, identityEmail)
 *   identityLinkedin  the u: slug, or the   ix (workspaceId, identityLinkedin)
 *                     URL when it has none
 *   identityNameOrg   the n: key            ix (workspaceId, identityNameOrg)
 *   identityVersion   0 = not keyed yet     ix (workspaceId, identityVersion)
 *
 * Inserts write the columns. An update that changes who a row is
 * (withIdentityRekey) sets identityVersion back to 0; every lookup also reads
 * the rows at 0, so a row is never missed while unkeyed, and keys them on the
 * way out. The boot backfill keys the rest (backfillQueueIdentity).
 */

/** The fields a row is recognised by. A write to any of them re-keys the row. */
export const QUEUE_IDENTITY_FIELDS = ["email", "linkedinUrl", "firstName", "lastName", "companyName", "companyDomain"] as const;
export const QUEUE_IDENTITY_VERSION = 1;
const COL_EMAIL = 320, COL_LINKEDIN = 255, COL_NAMEORG = 400;

/** One row's stored keys, made from queueIdentityKeys. */
export function queueIdentityColumns(p: QueueIdentityShape): {
  identityEmail: string | null; identityLinkedin: string | null; identityNameOrg: string | null; identityVersion: number;
} {
  const keys = queueIdentityKeys(p);
  const email = keys.find((k) => k.startsWith("e:"))?.slice(2) ?? null;
  // u: keys come raw URL first, then its slug when it has one: keep the slug.
  const urls = keys.filter((k) => k.startsWith("u:")).map((k) => k.slice(2));
  const linkedin = urls.length ? urls[urls.length - 1] : null;
  const nameOrg = keys.find((k) => k.startsWith("n:"))?.slice(2) ?? null;
  return {
    identityEmail: email ? email.slice(0, COL_EMAIL) : null,
    identityLinkedin: linkedin ? linkedin.slice(0, COL_LINKEDIN) : null,
    identityNameOrg: nameOrg ? nameOrg.slice(0, COL_NAMEORG) : null,
    identityVersion: QUEUE_IDENTITY_VERSION,
  };
}

/** A prospect_queue update that changes an identity field is re-keyed on the next lookup. */
export function withIdentityRekey<T extends Record<string, unknown>>(patch: T): T {
  return QUEUE_IDENTITY_FIELDS.some((f) => f in patch) ? { ...patch, identityVersion: 0 } : patch;
}

/** The column values any of these shapes could match on. */
function lookupValues(shapes: QueueIdentityShape[]): { emails: string[]; linkedins: string[]; nameOrgs: string[] } {
  const emails = new Set<string>(), linkedins = new Set<string>(), nameOrgs = new Set<string>();
  for (const s of shapes) {
    for (const k of queueIdentityKeys(s)) {
      // Every u: key, URL and slug, since a stored row keeps whichever it had.
      if (k.startsWith("e:")) emails.add(k.slice(2).slice(0, COL_EMAIL));
      else if (k.startsWith("u:")) linkedins.add(k.slice(2).slice(0, COL_LINKEDIN));
      else if (k.startsWith("n:")) nameOrgs.add(k.slice(2).slice(0, COL_NAMEORG));
    }
  }
  return { emails: Array.from(emails), linkedins: Array.from(linkedins), nameOrgs: Array.from(nameOrgs) };
}

type ClaimRow = { id: number; campaignId: number | null } & Required<Pick<QueueIdentityShape, never>> & {
  email: string | null; linkedinUrl: string | null; firstName: string | null; lastName: string | null; companyName: string | null; companyDomain: string | null; identityVersion: number | null;
};

const LOOKUP_CHUNK = 400;
/** Unkeyed rows one lookup keys on its way out. */
export const KEY_ON_READ = 200;

/**
 * The queue identity index, for these people only (A34): the rows that share
 * a key with any of them, plus any row not keyed yet, read through the
 * indexes. Same shape and rules as workspaceQueueIdentityIndex — lowest id
 * wins a key — so existingClaim and classifyPushCandidate read it unchanged.
 *
 * `liveCampaignsOnly` (the default) leaves out rows whose campaign is gone,
 * as workspaceQueueIdentityIndex does (A18). The engine's discovery passes
 * false: it always counted every queue row in the workspace.
 */
export async function queueIdentityIndexFor(
  workspaceId: number,
  shapes: QueueIdentityShape[],
  opts: { liveCampaignsOnly?: boolean } = {},
): Promise<Map<string, { rowId: number; campaignId: number | null }>> {
  const index = new Map<string, { rowId: number; campaignId: number | null }>();
  const db = await getDb();
  if (!db) return index;
  const { emails, linkedins, nameOrgs } = lookupValues(shapes);
  const live = opts.liveCampaignsOnly !== false;
  const cols = {
    id: prospectQueue.id, campaignId: prospectQueue.campaignId, email: prospectQueue.email, linkedinUrl: prospectQueue.linkedinUrl,
    firstName: prospectQueue.firstName, lastName: prospectQueue.lastName, companyName: prospectQueue.companyName,
    companyDomain: prospectQueue.companyDomain, identityVersion: prospectQueue.identityVersion,
  };
  const read = (match: SQL) => {
    const q = db.select(cols).from(prospectQueue);
    const joined = live
      ? q.innerJoin(areCampaigns, and(eq(areCampaigns.id, prospectQueue.campaignId), eq(areCampaigns.workspaceId, workspaceId)))
      : q;
    return joined.where(and(eq(prospectQueue.workspaceId, workspaceId), match)).orderBy(asc(prospectQueue.id)) as unknown as Promise<ClaimRow[]>;
  };
  const byId = new Map<number, ClaimRow>();
  // Rows not keyed yet: read whole, and keyed below. None once the backfill has run.
  // (NOT NULL DEFAULT 0 in MySQL; the null arm is for a row written by
  // anything that skipped the default.)
  for (const r of await read(or(eq(prospectQueue.identityVersion, 0), isNull(prospectQueue.identityVersion))!)) byId.set(r.id, r);
  if (emails.length + linkedins.length + nameOrgs.length > 0) {
    const n = Math.max(emails.length, linkedins.length, nameOrgs.length);
    for (let i = 0; i < n; i += LOOKUP_CHUNK) {
      const ors: SQL[] = [];
      const e = emails.slice(i, i + LOOKUP_CHUNK), l = linkedins.slice(i, i + LOOKUP_CHUNK), no = nameOrgs.slice(i, i + LOOKUP_CHUNK);
      if (e.length) ors.push(inArray(prospectQueue.identityEmail, e));
      if (l.length) ors.push(inArray(prospectQueue.identityLinkedin, l));
      if (no.length) ors.push(inArray(prospectQueue.identityNameOrg, no));
      if (!ors.length) continue;
      for (const r of await read(ors.length === 1 ? ors[0] : or(...ors)!)) byId.set(r.id, r);
    }
  }
  const rows = Array.from(byId.values()).sort((a, b) => a.id - b.id);
  for (const r of rows) {
    for (const k of queueIdentityKeys(r)) {
      if (!index.has(k)) index.set(k, { rowId: r.id, campaignId: r.campaignId });
    }
  }
  // Key some of the unkeyed rows this read found, so later lookups read them
  // by index. A few per call: the boot backfill keys the bulk, and a request
  // must not pay for a whole queue's writes.
  await keyRows(workspaceId, rows.filter((r) => Number(r.identityVersion ?? 0) === 0).slice(0, KEY_ON_READ));
  return index;
}

async function keyRows(workspaceId: number, rows: ClaimRow[]): Promise<number> {
  const db = await getDb();
  if (!db || rows.length === 0) return 0;
  let n = 0;
  for (const r of rows) {
    try {
      await db.update(prospectQueue).set(queueIdentityColumns(r))
        // Only if no write re-keyed it meanwhile with other fields: still at 0.
        .where(and(eq(prospectQueue.id, r.id), eq(prospectQueue.workspaceId, workspaceId), or(eq(prospectQueue.identityVersion, 0), isNull(prospectQueue.identityVersion))));
      n++;
    } catch (e) {
      console.error("[queueIdentity] could not key a row:", (e as Error)?.message ?? e);
    }
  }
  return n;
}

/**
 * Key every queue row not keyed yet (A34), a batch at a time. Idempotent:
 * only rows at identityVersion 0, and a row is keyed from its own fields, so
 * a second run finds nothing. Runs once after each boot.
 */
export async function backfillQueueIdentity(opts: { batch?: number; maxBatches?: number } = {}): Promise<{ keyed: number }> {
  const db = await getDb();
  if (!db) return { keyed: 0 };
  const batch = opts.batch ?? 1000;
  let keyed = 0;
  for (let b = 0; b < (opts.maxBatches ?? 50); b++) {
    const rows = await db.select({
      id: prospectQueue.id, workspaceId: prospectQueue.workspaceId, campaignId: prospectQueue.campaignId, email: prospectQueue.email,
      linkedinUrl: prospectQueue.linkedinUrl, firstName: prospectQueue.firstName, lastName: prospectQueue.lastName,
      companyName: prospectQueue.companyName, companyDomain: prospectQueue.companyDomain, identityVersion: prospectQueue.identityVersion,
    }).from(prospectQueue).where(or(eq(prospectQueue.identityVersion, 0), isNull(prospectQueue.identityVersion))).orderBy(asc(prospectQueue.id)).limit(batch);
    if (rows.length === 0) break;
    const byWs = new Map<number, ClaimRow[]>();
    for (const r of rows) byWs.set(r.workspaceId, [...(byWs.get(r.workspaceId) ?? []), r as ClaimRow]);
    let done = 0;
    for (const [ws, rs] of Array.from(byWs.entries())) done += await keyRows(ws, rs);
    keyed += done;
    if (rows.length < batch || done === 0) break;
  }
  return { keyed };
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
