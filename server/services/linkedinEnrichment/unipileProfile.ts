/**
 * Unipile LinkedIn profile retrieval for the enrichment system.
 *
 * Thin wrapper over server/services/linkedinLookup (the existing, compliant
 * retrieval path) that returns Velocity's normalized profile shape plus a
 * typed outcome the batch importer + daily-check worker can act on.
 *
 * Everything routes through Unipile + the per-account daily rate limit +
 * audit log already implemented in linkedinLookup. There is NO direct
 * LinkedIn fetch, browser automation, or HTML parsing anywhere in this path.
 */
import { lookupProfile, searchLinkedInProfiles } from "../linkedinLookup";
import { getLinkedInProfile } from "../../lib/unipile";
import {
  mapUnipileProfileToVelocitySchema,
  mapSearchHitToProfile,
  validateLinkedInUrl,
  type VelocityLinkedInProfile,
} from "./mapper";

export type RetrieveStatus =
  | "enriched"
  | "invalid_url"
  | "source_unavailable"
  | "rate_limited"
  | "vendor_error"
  | "no_match";

export interface RetrieveOutcome {
  ok: boolean;
  status: RetrieveStatus;
  profile: VelocityLinkedInProfile | null;
  /** The Unipile account the lookup ran through (provenance). */
  viaAccountId: string | null;
  identifier: string | null;
  message: string;
  /**
   * The account limits held it (status "rate_limited"): nothing reached
   * LinkedIn. Stop, keep the item pending, try again after retryAfterMs (or
   * on a later tick when null). Never a reason to call a profile unavailable.
   */
  blocked?: { reason: string; retryAfterMs: number | null };
}

/**
 * Classify a lookupProfile failure that was NOT a hold (holds come typed, as
 * `blocked`). Until 2026-10-27 holds were guessed from the wording, and a
 * pacing or working-hours refusal ("…for this account…") read as a missing
 * account or a vendor error (audit P6/P7). "Not found" is the one answer that
 * says the profile itself is gone.
 */
function classify(message: string, hadIdentifier: boolean): RetrieveStatus {
  if (!hadIdentifier) return "invalid_url";
  if (/no linkedin accounts are bridged|haven't bridged|isn't available in this workspace pool/i.test(message)) return "source_unavailable";
  // A vendor throttle is a hold too, even though it reached LinkedIn.
  if (/\b429\b|too many requests/i.test(message)) return "rate_limited";
  if (/\b404\b|not found|no longer exists|does not exist/i.test(message)) return "no_match";
  return "vendor_error";
}

/**
 * Retrieve + map a LinkedIn profile by URL via the authorized Unipile account
 * pool (rate-limited, audited). `userId`/`isAdmin` decide which bridged
 * account(s) the lookup may use.
 */
export async function retrieveLinkedInProfileByUrl(opts: {
  workspaceId: number;
  userId: number;
  isAdmin: boolean;
  linkedinUrl: string;
  requestedAccountId?: string;
  /** A person enriching one record (2026-10-05): allowed while LinkedIn activity is switched off. */
  personInitiated?: boolean;
  /** Wait out a spacing hold up to this long (background paths). */
  waitMs?: number;
  /** What looked it up, for the spend report. */
  feature?: string;
}): Promise<RetrieveOutcome> {
  const res = await lookupProfile(opts);
  if (res.blocked) {
    return {
      ok: false,
      status: "rate_limited",
      profile: null,
      viaAccountId: res.viaAccountId,
      identifier: res.identifier,
      message: res.message,
      blocked: res.blocked,
    };
  }
  if (res.ok && res.profile) {
    return {
      ok: true,
      status: "enriched",
      profile: mapUnipileProfileToVelocitySchema(res.profile, opts.linkedinUrl),
      viaAccountId: res.viaAccountId,
      identifier: res.identifier,
      message: res.message,
    };
  }
  return {
    ok: false,
    status: classify(res.message, !!res.identifier),
    profile: null,
    viaAccountId: res.viaAccountId,
    identifier: res.identifier,
    message: res.message,
  };
}

/**
 * Authorized name/company lookup — used when a prospect has NO LinkedIn URL.
 * Runs Unipile's classic people-search over the prospect's available
 * identifiers (name + title + company + location) and maps the best hit. This
 * is the vendor's authorized search, NOT scraping.
 */
export async function retrieveByNameCompany(opts: {
  workspaceId: number;
  userId: number;
  isAdmin: boolean;
  prospect: {
    firstName?: string | null; lastName?: string | null; title?: string | null;
    company?: string | null; city?: string | null; state?: string | null; country?: string | null;
  };
  personInitiated?: boolean;
  /** Wait out a spacing hold up to this long (background paths). */
  waitMs?: number;
}): Promise<RetrieveOutcome> {
  const p = opts.prospect;
  const keywords = [
    [p.firstName, p.lastName].filter(Boolean).join(" "),
    p.title, p.company,
    [p.city, p.state, p.country].filter(Boolean).join(" "),
  ].map((s) => (s ?? "").trim()).filter(Boolean).join(" ").trim();

  if (keywords.length < 2) {
    return { ok: false, status: "invalid_url", profile: null, viaAccountId: null, identifier: null, message: "Insufficient identifiers for an authorized lookup" };
  }
  const res = await searchLinkedInProfiles({
    workspaceId: opts.workspaceId, userId: opts.userId, isAdmin: opts.isAdmin, keywords, limit: 3, source: "enrichment",
    personInitiated: opts.personInitiated, waitMs: opts.waitMs,
  });
  if (!res.ok) {
    // A policy refusal (paused, capped, paced, outside hours) reached no
    // vendor: a retry-later condition, never a verdict on the person.
    if (res.blocked) {
      return { ok: false, status: "rate_limited", profile: null, viaAccountId: res.viaAccountId, identifier: null, message: res.message, blocked: { reason: res.blocked, retryAfterMs: null } };
    }
    return { ok: false, status: classify(res.message, true), profile: null, viaAccountId: res.viaAccountId, identifier: null, message: res.message };
  }
  if (res.hits.length === 0) {
    return { ok: false, status: "no_match", profile: null, viaAccountId: res.viaAccountId, identifier: null, message: "No LinkedIn profile matched these identifiers" };
  }
  const best = res.hits[0];
  return {
    ok: true, status: "enriched",
    profile: mapSearchHitToProfile(best),
    viaAccountId: res.viaAccountId,
    identifier: validateLinkedInUrl(best.linkedinUrl ?? "").identifier,
    message: `Matched via name/company lookup — ${res.message}`,
  };
}

/**
 * Retrieve by a known public identifier/provider_id through a specific Unipile
 * account (used by the daily-check worker, which already knows the account a
 * prospect was enriched through). Maps the same way as the by-URL path.
 */
export async function retrieveLinkedInProfileByIdentifier(opts: {
  unipileAccountId: string;
  identifier: string;
}): Promise<RetrieveOutcome> {
  try {
    const raw = await getLinkedInProfile(opts.unipileAccountId, opts.identifier);
    return {
      ok: true,
      status: "enriched",
      profile: mapUnipileProfileToVelocitySchema(raw, `https://www.linkedin.com/in/${opts.identifier}`),
      viaAccountId: opts.unipileAccountId,
      identifier: opts.identifier,
      message: "ok",
    };
  } catch (e) {
    const message = (e as Error).message ?? "Unipile error";
    return {
      ok: false,
      status: /not found|404/i.test(message) ? "no_match" : "vendor_error",
      profile: null,
      viaAccountId: opts.unipileAccountId,
      identifier: opts.identifier,
      message: message.slice(0, 300),
    };
  }
}
