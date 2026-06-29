/**
 * Prospect profile-image resolver.
 *
 * Profile pictures are OPTIONAL enrichment metadata. They may only originate
 * from a permitted source (an authorized enrichment provider, a CRM import, a
 * user upload, or a legally accessible image URL) — never scraped from
 * LinkedIn or any access-controlled surface.
 *
 * This module is the single place that decides whether a stored image may be
 * displayed. It is pure (no DB / no IO) so it can be unit-tested and reused by
 * the full-profile serializer. Search/list responses must NOT call it with the
 * intent to expose a URL — they strip the image fields entirely.
 */

export type ProfileImageSource =
  | "enrichment_provider"
  | "crm_import"
  | "user_uploaded"
  | "public_authorized_url";

export type ProfileImageStatus =
  | "unknown"
  | "available"
  | "unavailable"
  | "failed_to_load"
  | "removed"
  | "blocked_by_policy";

export const PROFILE_IMAGE_SOURCES: ProfileImageSource[] = [
  "enrichment_provider",
  "crm_import",
  "user_uploaded",
  "public_authorized_url",
];

export interface ProfileImagePerson {
  profileImageUrl?: string | null;
  profileImageSource?: ProfileImageSource | string | null;
  profileImageSourceUrl?: string | null;
  profileImageLastVerifiedAt?: Date | string | null;
  profileImageStatus?: ProfileImageStatus | string | null;
  /** Compliance signals. `verificationStatus === "rejected"` is Velocity's
   *  soft-delete/archive state for a prospect. */
  verificationStatus?: string | null;
  suppressed?: boolean;
  privacyRestricted?: boolean;
}

export interface ResolvedProfileImage {
  /** The permitted image URL, or null when the frontend should fall back to
   *  an initials avatar. */
  url: string | null;
  source_type: ProfileImageSource | null;
  status: ProfileImageStatus;
  last_verified_at: string | null;
}

function normStatus(s: unknown): ProfileImageStatus {
  const allowed: ProfileImageStatus[] = [
    "unknown", "available", "unavailable", "failed_to_load", "removed", "blocked_by_policy",
  ];
  return (allowed as string[]).includes(s as string) ? (s as ProfileImageStatus) : "unknown";
}

function normSource(s: unknown): ProfileImageSource | null {
  return (PROFILE_IMAGE_SOURCES as string[]).includes(s as string) ? (s as ProfileImageSource) : null;
}

/**
 * Decide whether a prospect's profile image may be shown, and return its
 * metadata (always) plus a usable `url` (only when permitted).
 *
 * Rules:
 *  - Suppressed / deleted (rejected) / privacy-restricted → never return a URL;
 *    surface `blocked_by_policy` so cached images stop displaying immediately.
 *  - `removed` / `blocked_by_policy` status → no URL.
 *  - A non-HTTPS or empty URL, or any status other than `available` → no URL.
 *  - Otherwise return the stored HTTPS URL.
 */
export function resolveProspectProfileImage(person: ProfileImagePerson): ResolvedProfileImage {
  const status = normStatus(person.profileImageStatus);
  const source_type = normSource(person.profileImageSource);
  const last_verified_at = person.profileImageLastVerifiedAt
    ? new Date(person.profileImageLastVerifiedAt).toISOString()
    : null;

  const policyBlocked =
    person.suppressed === true ||
    person.privacyRestricted === true ||
    person.verificationStatus === "rejected" ||
    status === "removed" ||
    status === "blocked_by_policy";

  if (policyBlocked) {
    // Reflect the block in the metadata so audits see why nothing shows.
    const reported: ProfileImageStatus =
      status === "removed" || status === "blocked_by_policy" ? status : "blocked_by_policy";
    return { url: null, source_type, status: reported, last_verified_at };
  }

  const url = person.profileImageUrl ?? null;
  if (url && status === "available" && /^https:\/\//i.test(url)) {
    return { url, source_type, status, last_verified_at };
  }

  // unknown / unavailable / failed_to_load, or a non-HTTPS url → initials fallback.
  return { url: null, source_type, status, last_verified_at };
}
