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

import { and, eq, gte, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { getDb } from "../db";
import { unipileAccounts, linkedinLookupLog, workspaceMembers, users } from "../../drizzle/schema";
import { getLinkedInProfile, type UnipileUserProfile } from "../lib/unipile";

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

function utcMidnight(): Date {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

async function usedTodayFor(unipileAccountId: string): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const [row] = await db
    .select({ n: sql<number>`count(*)` })
    .from(linkedinLookupLog)
    .where(
      and(
        eq(linkedinLookupLog.unipileAccountId, unipileAccountId),
        eq(linkedinLookupLog.status, "ok"),
        gte(linkedinLookupLog.createdAt, utcMidnight()),
      ),
    );
  return Number(row?.n ?? 0);
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

  const out: BridgedAccount[] = [];
  for (const r of rows) {
    const used = await usedTodayFor(r.unipileAccountId);
    out.push({
      unipileAccountId: r.unipileAccountId,
      ownerUserId: r.ownerUserId,
      ownerName: r.ownerName ?? null,
      ownerEmail: r.ownerEmail ?? null,
      displayName: r.displayName ?? null,
      status: r.status,
      usedToday: used,
      remainingToday: Math.max(0, LINKEDIN_DAILY_CAP - used),
    });
  }
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

  // Rate-limit gate
  if (chosen.remainingToday <= 0) {
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

  // Do the lookup
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
