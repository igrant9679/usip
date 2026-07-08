/**
 * Unipile → Velocity LinkedIn profile mapper + URL normalization.
 *
 * Pure functions only (no DB, no network) so they're trivially testable and
 * reusable by the batch importer, the daily-check worker, and the matcher.
 *
 * COMPLIANCE: this module only *maps* data the authorized Unipile account
 * already returned. It never fetches LinkedIn directly and never parses
 * LinkedIn HTML — the only retrieval path is Unipile (see ./unipileProfile.ts,
 * which wraps server/services/linkedinLookup). Fields Unipile didn't return
 * stay null; enrichment is optional metadata.
 */
import { extractLinkedInIdentifier } from "../linkedinLookup";
import type { UnipileUserProfile } from "../../lib/unipile";

/** Normalized internal LinkedIn profile shape persisted by the enrichment service. */
export interface VelocityLinkedInProfile {
  profileUrl: string;
  identifier: string | null;
  publicId: string | null;
  fullName: string | null;
  firstName: string | null;
  lastName: string | null;
  headline: string | null;
  location: string | null;
  industry: string | null;
  profileImageUrl: string | null;
  summaryAbout: string | null;
  currentTitle: string | null;
  currentCompanyName: string | null;
  currentCompanyLinkedinUrl: string | null;
  currentCompanyDomain: string | null;
  currentCompanyStartDate: string | null; // YYYY-MM-DD
  connectionDegree: string | null;
  experience: Array<{
    company: string | null;
    title: string | null;
    location: string | null;
    start: string | null;
    end: string | null;
    current: boolean;
  }>;
  education: Array<{
    school: string | null;
    degree: string | null;
    fieldOfStudy: string | null;
    start: string | null;
    end: string | null;
  }>;
  skills: string[];
  languages: string[];
}

/* ─────────────────────────── URL normalization ────────────────────────── */

export interface UrlValidation {
  valid: boolean;
  /** Canonical https://www.linkedin.com/in/{identifier} (or null when invalid). */
  normalizedUrl: string | null;
  identifier: string | null;
  /** Human-readable reason when invalid. */
  error: string | null;
}

/**
 * Validate + normalize a submitted LinkedIn profile URL.
 *
 * Rules (per the feature spec):
 *  - must be present, HTTPS-able, and look like a LinkedIn /in/ profile URL;
 *  - tracking params + fragments are dropped;
 *  - host/identifier casing normalized to the canonical public path;
 *  - the ORIGINAL url is preserved by the caller (stored separately for audit).
 */
export function validateLinkedInUrl(raw: string): UrlValidation {
  const input = (raw ?? "").trim();
  if (!input) return { valid: false, normalizedUrl: null, identifier: null, error: "URL is empty" };

  // A bare http:// link is rejected — we require https for compliance.
  if (/^http:\/\//i.test(input)) {
    return { valid: false, normalizedUrl: null, identifier: null, error: "URL must be HTTPS" };
  }

  const identifier = extractLinkedInIdentifier(input);
  if (!identifier) {
    return {
      valid: false,
      normalizedUrl: null,
      identifier: null,
      error: "Not a recognizable LinkedIn /in/ profile URL (Sales Navigator URLs aren't supported)",
    };
  }
  // Canonical form — lowercased host, no query/fragment, preserved slug.
  const normalizedUrl = `https://www.linkedin.com/in/${identifier}`;
  return { valid: true, normalizedUrl, identifier, error: null };
}

/** Convenience: canonical URL or null. */
export function normalizeLinkedInUrl(raw: string): string | null {
  return validateLinkedInUrl(raw).normalizedUrl;
}

/* ─────────────────────────── profile mapping ──────────────────────────── */

const str = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length ? t : null;
};

/**
 * Map a Unipile people-SEARCH hit (name/company lookup path) to the normalized
 * profile shape. Lower fidelity than a full profile fetch — search hits carry
 * name/headline/company/location/photo but no structured experience/skills —
 * but enough to enrich + match when a prospect has no LinkedIn URL.
 */
export function mapSearchHitToProfile(hit: {
  name?: string; firstName?: string; lastName?: string; headline?: string;
  location?: string; company?: string; linkedinUrl?: string;
  profilePictureUrl?: string | null; networkDistance?: string;
}): VelocityLinkedInProfile {
  const v = validateLinkedInUrl(hit.linkedinUrl ?? "");
  const fullName = str(hit.name) ?? ([str(hit.firstName), str(hit.lastName)].filter(Boolean).join(" ") || null);
  return {
    profileUrl: v.normalizedUrl ?? str(hit.linkedinUrl) ?? "",
    identifier: v.identifier,
    publicId: null,
    fullName,
    firstName: str(hit.firstName),
    lastName: str(hit.lastName),
    headline: str(hit.headline),
    location: str(hit.location),
    industry: null,
    profileImageUrl: str(hit.profilePictureUrl),
    summaryAbout: null,
    currentTitle: str(hit.headline),
    currentCompanyName: str(hit.company),
    currentCompanyLinkedinUrl: null,
    currentCompanyDomain: null,
    currentCompanyStartDate: null,
    connectionDegree: str(hit.networkDistance),
    experience: [],
    education: [],
    skills: [],
    languages: [],
  };
}

/** Pull a company name/url/domain off the polymorphic current_company field. */
function currentCompany(p: UnipileUserProfile): { name: string | null; url: string | null; domain: string | null } {
  const c = p.current_company;
  if (typeof c === "string") return { name: str(c), url: null, domain: null };
  if (c && typeof c === "object") {
    return { name: str(c.name), url: str(c.linkedin_url), domain: str(c.domain) };
  }
  return { name: null, url: null, domain: null };
}

/** Normalize a date-ish string to YYYY-MM-DD, or null if it can't be parsed safely.
 *  LinkedIn sends "00" month/day segments for partial dates (e.g. "2013-00" for a
 *  year-only start date) — those must clamp to 01, or MySQL's strict mode rejects
 *  the DATE and the whole enrichment insert fails. */
function toDateOnly(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  // Accept "2021", "2021-03", "2021-03-01", ISO datetimes.
  const m = s.match(/^(\d{4})(?:-(\d{1,2}))?(?:-(\d{1,2}))?/);
  if (!m) return null;
  const y = Number(m[1]);
  if (y < 1900 || y > 2100) return null; // vendor noise like "0000"
  let mo = Number(m[2] ?? "1");
  if (!(mo >= 1 && mo <= 12)) mo = 1;
  let d = Number(m[3] ?? "1");
  if (!(d >= 1 && d <= 31)) d = 1;
  // Day overflowing the month (e.g. Apr 31) would still be rejected — clamp to 01.
  if (new Date(Date.UTC(y, mo - 1, d)).getUTCMonth() !== mo - 1) d = 1;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${y}-${pad(mo)}-${pad(d)}`;
}

/**
 * Map a Unipile profile + the URL it was fetched for into Velocity's shape.
 * `fetchedForUrl` seeds profileUrl/identifier when the profile response omits
 * its own public URL (common on classic LinkedIn responses).
 */
export function mapUnipileProfileToVelocitySchema(
  p: UnipileUserProfile,
  fetchedForUrl?: string,
): VelocityLinkedInProfile {
  const fullName = str(p.name) ?? ([str(p.first_name), str(p.last_name)].filter(Boolean).join(" ") || null);
  let firstName = str(p.first_name);
  let lastName = str(p.last_name);
  if (!firstName && !lastName && fullName) {
    const sp = fullName.lastIndexOf(" ");
    firstName = sp === -1 ? fullName : fullName.slice(0, sp);
    lastName = sp === -1 ? null : fullName.slice(sp + 1);
  }

  const publicUrl = str(p.public_profile_url);
  const fetched = fetchedForUrl ? validateLinkedInUrl(fetchedForUrl) : null;
  const identifier =
    str(p.public_identifier) ?? (publicUrl ? validateLinkedInUrl(publicUrl).identifier : null) ?? fetched?.identifier ?? null;
  const profileUrl =
    (publicUrl ? validateLinkedInUrl(publicUrl).normalizedUrl : null) ??
    (identifier ? `https://www.linkedin.com/in/${identifier}` : null) ??
    fetched?.normalizedUrl ??
    str(fetchedForUrl) ??
    "";

  const company = currentCompany(p);

  const experience = (p.work_experience ?? []).map((e) => {
    const name = str(e.company) ?? str(e.company_name);
    return {
      company: name,
      title: str(e.title) ?? str(e.position),
      location: str(e.location),
      start: toDateOnly(e.start),
      end: toDateOnly(e.end),
      current: e.current === true || (str(e.end) === null && !!name),
    };
  });

  // Prefer the explicit current_company; else the first work_experience marked current.
  const currentExp = experience.find((e) => e.current) ?? experience[0];
  const currentCompanyName = company.name ?? currentExp?.company ?? null;
  const currentTitle = str(p.headline) ?? str(p.occupation) ?? currentExp?.title ?? null;
  const currentCompanyStartDate = experience.find((e) => e.company === currentCompanyName && e.current)?.start ?? null;

  const education = (p.education ?? []).map((e) => ({
    school: str(e.school),
    degree: str(e.degree),
    fieldOfStudy: str(e.field_of_study),
    start: toDateOnly(e.start),
    end: toDateOnly(e.end),
  }));

  const skills = (p.skills ?? [])
    .map((s) => (typeof s === "string" ? str(s) : str(s?.name)))
    .filter((s): s is string => !!s);

  const languages = (p.languages ?? [])
    .map((l) => (typeof l === "string" ? str(l) : str(l?.name)))
    .filter((l): l is string => !!l);

  return {
    profileUrl,
    identifier,
    publicId: str(p.member_urn) ?? str(p.public_identifier) ?? null,
    fullName,
    firstName,
    lastName,
    headline: str(p.headline),
    location: str(p.location),
    industry: str(p.industry),
    profileImageUrl: str(p.profile_picture_url),
    summaryAbout: str(p.summary),
    currentTitle,
    currentCompanyName,
    currentCompanyLinkedinUrl: company.url ?? null,
    currentCompanyDomain: company.domain ?? null,
    currentCompanyStartDate,
    connectionDegree: p.network_distance != null ? String(p.network_distance) : null,
    experience,
    education,
    skills,
    languages,
  };
}
