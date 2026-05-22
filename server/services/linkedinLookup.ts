/**
 * LinkedIn profile lookup — Unipile bridge + per-account rate limiting.
 *
 * Builds on the existing Unipile infrastructure:
 *   - unipile_accounts table (bridged accounts per workspace+user)
 *   - getLinkedInProfile(unipileAccountId, providerId) in server/lib/unipile
 *
 * What this service adds:
 *   1. extractLinkedInIdentifier() — pull the public slug from a profile URL
 *   2. account selection — own account for reps; full workspace pool for
 *      admins, with least-used auto-pick when none specified
 *   3. per-account daily rate limit (LinkedIn throttles individual accounts
 *      at ~80-150 profile views/day — we cap conservatively + log every
 *      lookup so the UI can show usage)
 */

import { and, eq, inArray, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { getDb } from "../db";
import {
  unipileAccounts,
  linkedinLookupLog,
  linkedinDailyUsage,
  workspaceMembers,
  users,
} from "../../drizzle/schema";
import {
  getLinkedInProfile,
  searchLinkedInPeople,
  type UnipileLinkedInSearchHit,
  type UnipileUserProfile,
} from "../lib/unipile";

/** UTC calendar date as "YYYY-MM-DD" — the daily-usage partition key. */
function utcDateKey(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Atomically reserve one lookup slot for an account against today's cap.
 * Concurrency-safe: the conditional UPDATE's affectedRows is the gate, so
 * N parallel lookups can't all pass a COUNT-then-check the way the old
 * code could (which risked blowing LinkedIn's per-account throttle and
 * getting the account flagged/banned).
 *
 * Returns true if a slot was reserved, false if the account is at cap.
 */
async function reserveSlot(unipileAccountId: string, cap: number): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  const day = utcDateKey();
  // Ensure the (account, day) counter row exists. No-op self-update on
  // conflict so concurrent first-requests don't throw a dup-key error.
  await db
    .insert(linkedinDailyUsage)
    .values({ unipileAccountId, usageDate: day, count: 0 } as never)
    .onDuplicateKeyUpdate({ set: { unipileAccountId } });
  // Atomic conditional increment — only succeeds while under cap.
  const [res] = await db.execute(
    sql`UPDATE \`linkedin_daily_usage\`
        SET \`count\` = \`count\` + 1
        WHERE \`unipile_account_id\` = ${unipileAccountId}
          AND \`usage_date\` = ${day}
          AND \`count\` < ${cap}`,
  );
  return ((res as { affectedRows?: number })?.affectedRows ?? 0) > 0;
}

/** Reverse a reservation when the downstream Unipile call fails. */
async function refundSlot(unipileAccountId: string): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db.execute(
    sql`UPDATE \`linkedin_daily_usage\`
        SET \`count\` = GREATEST(0, \`count\` - 1)
        WHERE \`unipile_account_id\` = ${unipileAccountId}
          AND \`usage_date\` = ${utcDateKey()}`,
  );
}

/**
 * Conservative daily cap per bridged LinkedIn account. LinkedIn's actual
 * throttle is fuzzy and account-age dependent (older accounts tolerate
 * more). 100/day keeps well clear of the danger zone for most accounts.
 * Surfaced as a constant so it's a one-line change to tune later, or to
 * lift into a per-workspace setting in a fast-follow.
 */
export const LINKEDIN_DAILY_CAP = 100;

export type BridgedAccount = {
  unipileAccountId: string;
  ownerUserId: number;
  ownerName: string | null;
  ownerEmail: string | null;
  displayName: string | null;
  status: string;
  /** Lookups performed through this account since UTC midnight. */
  usedToday: number;
  /** LINKEDIN_DAILY_CAP - usedToday, floored at 0. */
  remainingToday: number;
};

/* ─── URL → identifier ─────────────────────────────────────────────────── */

/**
 * Extract the public LinkedIn identifier from a profile URL.
 *   https://www.linkedin.com/in/jane-smith-1234/  → "jane-smith-1234"
 *   linkedin.com/in/janesmith                      → "janesmith"
 *   https://linkedin.com/sales/people/ABC,NAME...  → null (Sales Nav, unsupported)
 * Returns null if the URL isn't a recognizable /in/ profile URL.
 */
export function extractLinkedInIdentifier(input: string): string | null {
  const s = input.trim();
  // Already a bare slug?
  if (/^[a-z0-9][a-z0-9-]{1,98}[a-z0-9]$/i.test(s) && !s.includes(".")) {
    return s;
  }
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
  } catch {
    return null;
  }
  if (!/(^|\.)linkedin\.com$/i.test(url.hostname)) return null;
  const m = url.pathname.match(/\/in\/([^/?#]+)/i);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]).replace(/\/+$/, "") || null;
  } catch {
    return m[1] || null;
  }
}

/* ─── Daily usage ──────────────────────────────────────────────────────── */

/**
 * Today's usage for a SET of accounts in ONE query (fixes the prior N+1
 * where listUsableAccounts ran a COUNT per account). Reads the
 * linkedin_daily_usage counter — authoritative for the cap — not the
 * append-only audit log. Missing rows = 0 used.
 */
async function usageForAccounts(
  unipileAccountIds: string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (unipileAccountIds.length === 0) return out;
  const db = await getDb();
  if (!db) return out;
  const day = utcDateKey();
  const rows = await db
    .select({
      id: linkedinDailyUsage.unipileAccountId,
      count: linkedinDailyUsage.count,
    })
    .from(linkedinDailyUsage)
    .where(
      and(
        inArray(linkedinDailyUsage.unipileAccountId, unipileAccountIds),
        eq(linkedinDailyUsage.usageDate, day),
      ),
    );
  for (const r of rows) out.set(r.id, r.count);
  return out;
}

/* ─── Account pool ─────────────────────────────────────────────────────── */

/**
 * List the LinkedIn-bridged accounts the caller is allowed to use.
 *   - Regular reps: only their own bridged LinkedIn account(s)
 *   - Admins / super_admins: every LinkedIn account bridged in the workspace
 * Each entry carries today's usage so the UI can show a rate meter and the
 * auto-picker can choose the least-used.
 */
export async function listUsableAccounts(opts: {
  workspaceId: number;
  userId: number;
  isAdmin: boolean;
}): Promise<BridgedAccount[]> {
  const db = await getDb();
  if (!db) return [];

  const rows = await db
    .select({
      unipileAccountId: unipileAccounts.unipileAccountId,
      ownerUserId: unipileAccounts.userId,
      displayName: unipileAccounts.displayName,
      status: unipileAccounts.status,
      ownerName: users.name,
      ownerEmail: users.email,
    })
    .from(unipileAccounts)
    .leftJoin(users, eq(users.id, unipileAccounts.userId))
    .where(
      and(
        eq(unipileAccounts.workspaceId, opts.workspaceId),
        eq(unipileAccounts.provider, "LINKEDIN"),
        opts.isAdmin ? undefined : eq(unipileAccounts.userId, opts.userId),
      ),
    );

  // Single batched usage read instead of one COUNT per account.
  const usage = await usageForAccounts(rows.map((r) => r.unipileAccountId));
  const out: BridgedAccount[] = rows.map((r) => {
    const used = usage.get(r.unipileAccountId) ?? 0;
    return {
      unipileAccountId: r.unipileAccountId,
      ownerUserId: r.ownerUserId,
      ownerName: r.ownerName ?? null,
      ownerEmail: r.ownerEmail ?? null,
      displayName: r.displayName ?? null,
      status: r.status,
      usedToday: used,
      remainingToday: Math.max(0, LINKEDIN_DAILY_CAP - used),
    };
  });
  // Most headroom first — both for the UI list and the auto-picker.
  out.sort((a, b) => b.remainingToday - a.remainingToday);
  return out;
}

/* ─── Lookup orchestration ─────────────────────────────────────────────── */

export type LookupResult = {
  ok: boolean;
  identifier: string | null;
  /** The Unipile account the lookup ran through (for UI display). */
  viaAccountId: string | null;
  profile: UnipileUserProfile | null;
  message: string;
};

/**
 * Resolve a LinkedIn URL → profile via the chosen (or auto-picked) bridged
 * account, enforcing the per-account daily cap. Always logs the attempt.
 */
export async function lookupProfile(opts: {
  workspaceId: number;
  userId: number;
  isAdmin: boolean;
  linkedinUrl: string;
  /** Explicit account to route through. Admins only; reps ignore this. */
  requestedAccountId?: string;
}): Promise<LookupResult> {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

  const identifier = extractLinkedInIdentifier(opts.linkedinUrl);
  if (!identifier) {
    return {
      ok: false,
      identifier: null,
      viaAccountId: null,
      profile: null,
      message:
        "Couldn't parse a LinkedIn profile URL. Use a public profile link like https://linkedin.com/in/jane-smith (Sales Navigator URLs aren't supported).",
    };
  }

  const pool = await listUsableAccounts(opts);
  if (pool.length === 0) {
    return {
      ok: false,
      identifier,
      viaAccountId: null,
      profile: null,
      message: opts.isAdmin
        ? "No LinkedIn accounts are bridged in this workspace. Connect one from Connected Accounts."
        : "You haven't bridged a LinkedIn account yet. Connect yours from Connected Accounts.",
    };
  }

  // Account selection:
  //   - admin + explicit request → that account (must be in the pool)
  //   - otherwise → least-used account with headroom
  let chosen: BridgedAccount | undefined;
  if (opts.isAdmin && opts.requestedAccountId) {
    chosen = pool.find((a) => a.unipileAccountId === opts.requestedAccountId);
    if (!chosen) {
      return {
        ok: false,
        identifier,
        viaAccountId: null,
        profile: null,
        message: "Requested LinkedIn account isn't available in this workspace pool.",
      };
    }
  } else {
    chosen = pool.find((a) => a.remainingToday > 0) ?? pool[0];
  }

  // Rate-limit gate — ATOMIC reserve. Concurrent lookups on the same
  // account can't all slip past (the old `remainingToday <= 0` read-check
  // had a TOCTOU window that risked blowing LinkedIn's per-account
  // throttle and getting the account flagged).
  const reserved = await reserveSlot(chosen.unipileAccountId, LINKEDIN_DAILY_CAP);
  if (!reserved) {
    await db.insert(linkedinLookupLog).values({
      workspaceId: opts.workspaceId,
      requestedByUserId: opts.userId,
      unipileAccountId: chosen.unipileAccountId,
      accountOwnerUserId: chosen.ownerUserId,
      targetUrl: opts.linkedinUrl,
      targetIdentifier: identifier,
      status: "blocked",
      error: `Daily cap of ${LINKEDIN_DAILY_CAP} reached for this account`,
    } as never);
    return {
      ok: false,
      identifier,
      viaAccountId: chosen.unipileAccountId,
      profile: null,
      message: opts.isAdmin
        ? `That account hit its daily cap (${LINKEDIN_DAILY_CAP}). Pick another from the pool or wait for the UTC-midnight reset.`
        : `You've hit today's LinkedIn lookup cap (${LINKEDIN_DAILY_CAP}). Resets at midnight UTC.`,
    };
  }

  // Slot reserved. Do the lookup; refund the slot if the Unipile call
  // fails so a failed request doesn't permanently consume daily capacity.
  try {
    const profile = await getLinkedInProfile(chosen.unipileAccountId, identifier);
    await db.insert(linkedinLookupLog).values({
      workspaceId: opts.workspaceId,
      requestedByUserId: opts.userId,
      unipileAccountId: chosen.unipileAccountId,
      accountOwnerUserId: chosen.ownerUserId,
      targetUrl: opts.linkedinUrl,
      targetIdentifier: identifier,
      status: "ok",
    } as never);
    return {
      ok: true,
      identifier,
      viaAccountId: chosen.unipileAccountId,
      profile,
      message: `Fetched via ${chosen.displayName ?? chosen.ownerName ?? "bridged account"}`,
    };
  } catch (e) {
    const msg = (e as Error).message;
    // The Unipile call failed — give the reserved slot back so a transient
    // error doesn't permanently burn daily capacity for this account.
    await refundSlot(chosen.unipileAccountId);
    await db.insert(linkedinLookupLog).values({
      workspaceId: opts.workspaceId,
      requestedByUserId: opts.userId,
      unipileAccountId: chosen.unipileAccountId,
      accountOwnerUserId: chosen.ownerUserId,
      targetUrl: opts.linkedinUrl,
      targetIdentifier: identifier,
      status: "error",
      error: msg.slice(0, 1000),
    } as never);
    return {
      ok: false,
      identifier,
      viaAccountId: chosen.unipileAccountId,
      profile: null,
      message: `LinkedIn lookup failed: ${msg.slice(0, 200)}`,
    };
  }
}

/* ─── People search ────────────────────────────────────────────────────── */

export type SearchHit = {
  name: string;
  firstName: string;
  lastName: string;
  headline: string;
  location: string;
  company: string;
  linkedinUrl: string;
  profilePictureUrl: string | null;
  networkDistance: string;
};

export type SearchResult = {
  ok: boolean;
  viaAccountId: string | null;
  hits: SearchHit[];
  message: string;
};

/** Pull a company name off a hit whose company field may be a string or object. */
function companyOf(h: UnipileLinkedInSearchHit): string {
  const c = h.current_company ?? h.company;
  if (!c) return "";
  return typeof c === "string" ? c : (c.name ?? "");
}

function mapSearchHit(h: UnipileLinkedInSearchHit): SearchHit {
  let firstName = h.first_name ?? "";
  let lastName = h.last_name ?? "";
  const fullName = (h.name ?? `${firstName} ${lastName}`).trim();
  if (!firstName && !lastName && fullName) {
    const sp = fullName.lastIndexOf(" ");
    firstName = sp === -1 ? fullName : fullName.slice(0, sp);
    lastName = sp === -1 ? "" : fullName.slice(sp + 1);
  }
  const linkedinUrl =
    h.public_profile_url ??
    h.profile_url ??
    (h.public_identifier
      ? `https://www.linkedin.com/in/${h.public_identifier}`
      : "");
  return {
    name: fullName,
    firstName,
    lastName,
    headline: h.headline ?? h.title ?? h.occupation ?? "",
    location: h.location ?? "",
    company: companyOf(h),
    linkedinUrl,
    profilePictureUrl: h.profile_picture_url ?? null,
    networkDistance: String(h.network_distance ?? ""),
  };
}

/**
 * Search LinkedIn people through a bridged account. `keywords` is built by the
 * caller from the structured search form (name / title / location / industry /
 * company size). Routes through the chosen / least-used account.
 */
export async function searchLinkedInProfiles(opts: {
  workspaceId: number;
  userId: number;
  isAdmin: boolean;
  keywords: string;
  limit: number;
  /** Explicit account to route through. Admins only. */
  requestedAccountId?: string;
}): Promise<SearchResult> {
  const keywords = opts.keywords.trim();
  if (keywords.length < 2) {
    return {
      ok: false,
      viaAccountId: null,
      hits: [],
      message: "Enter at least one search criterion (name, title, location, …).",
    };
  }

  const pool = await listUsableAccounts(opts);
  if (pool.length === 0) {
    return {
      ok: false,
      viaAccountId: null,
      hits: [],
      message: opts.isAdmin
        ? "No LinkedIn accounts are bridged in this workspace. Connect one from Connected Accounts."
        : "You haven't bridged a LinkedIn account yet. Connect yours from Connected Accounts.",
    };
  }

  let chosen: BridgedAccount | undefined;
  if (opts.isAdmin && opts.requestedAccountId) {
    chosen = pool.find((a) => a.unipileAccountId === opts.requestedAccountId);
    if (!chosen) {
      return {
        ok: false,
        viaAccountId: null,
        hits: [],
        message: "Requested LinkedIn account isn't available in this workspace pool.",
      };
    }
  } else {
    chosen = pool[0]; // listUsableAccounts is sorted most-headroom first
  }

  try {
    const { items } = await searchLinkedInPeople(chosen.unipileAccountId, {
      keywords,
      limit: opts.limit,
    });
    const hits = items.map(mapSearchHit).filter((h) => h.name.length > 0);
    return {
      ok: true,
      viaAccountId: chosen.unipileAccountId,
      hits,
      message:
        hits.length > 0
          ? `Found ${hits.length} profile${hits.length === 1 ? "" : "s"} via ${chosen.displayName ?? chosen.ownerName ?? "bridged account"}`
          : "No LinkedIn profiles matched those criteria. Try broadening the search.",
    };
  } catch (e) {
    const msg = (e as Error).message;
    return {
      ok: false,
      viaAccountId: chosen.unipileAccountId,
      hits: [],
      message: `LinkedIn search failed: ${msg.slice(0, 200)}`,
    };
  }
}
