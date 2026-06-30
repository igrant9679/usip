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
import { lookupProfile } from "../linkedinLookup";
import { getLinkedInProfile } from "../../lib/unipile";
import {
  mapUnipileProfileToVelocitySchema,
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
}

/** Classify a lookupProfile failure message into a typed status. */
function classify(message: string, hadIdentifier: boolean): RetrieveStatus {
  if (!hadIdentifier) return "invalid_url";
  if (/cap|limit/i.test(message)) return "rate_limited";
  if (/bridged|connect|account/i.test(message)) return "source_unavailable";
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
}): Promise<RetrieveOutcome> {
  const res = await lookupProfile(opts);
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
