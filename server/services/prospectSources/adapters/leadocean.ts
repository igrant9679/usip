/**
 * LeadOcean adapter — people search, then a lookup for the address.
 *
 * Read from https://api.leadocean.io/openapi.json and /llms-full.txt on
 * 2026-11-02; nothing here has yet run against a real key. Every field name
 * that matters below is in that spec, except the shape of
 * profile_data.profile_address, which the spec leaves as a bare object: the
 * reader takes a string or an object and anything else reads as "unknown".
 *
 * METERING, which shapes everything else. Each search row counts one record and
 * each lookup one more, so a person costs two. A `count=true, limit=1` call is
 * free, as are the account, usage and viewed-list endpoints. Hence:
 *
 *   - supportsFreePreview is false. search() returns alreadyCharged: false (the
 *     row is not the deliverable, acquire() still has an address to buy) and the
 *     row's cost in unitsSpent, which the executor adds to the lookups.
 *   - Before any page is bought, a free sizing call asks whether LeadOcean will
 *     apply every filter. It drops a company-side filter that matches more than
 *     50,000 employers and returns the rows anyway, unfiltered on it, so without
 *     this a state campaign could pay for a page of the whole country.
 *   - Rows are remembered in a viewed list per workspace (lists live on the
 *     LeadOcean ACCOUNT, and one key may serve several workspaces). That is what
 *     moves a campaign forward from tick to tick, not a stored cursor: LeadOcean
 *     says a cursor is a place in one walk, never to be kept. So search() walks
 *     its pages internally and always returns nextCursor: null. Nothing outside
 *     this file ever holds one.
 *
 * WHICH LOOKUP. Phone reveals are the tightest limit on some plans (AppSumo Tier
 * 3: 1,500 a month), and the spec does not mention them at all. It says
 * /v1/people/enrich with reveal_email returns every email AND phone we hold "at
 * no extra credit", which rules out nothing about a separate phone meter.
 * /v2/people/email/work answers with one address and no phone, so it cannot use
 * one, and it is the default. The full lookup runs only when the workspace asked
 * for phones or accepts a status that door never returns.
 *
 * LIMITS. The docs say a reached window is served at 1 request a minute
 * (X-Quota-State, meta.notice) and that one must "not retry into a pace";
 * AppSumo's FAQ says 429 with Retry-After. Both read as held: a failure with
 * `held: true`, or the rows already paid for plus a note. Neither reads as an
 * empty result, and neither trips the circuit breaker.
 */
import {
  LEADOCEAN_CAPABILITIES,
  LEADOCEAN_NEVER_ACCEPT,
  leadoceanAcceptedStatuses,
  leadoceanUsesFullLookup,
  type LeadoceanEmailStatus,
  type SearchCriteria,
} from "@shared/prospectSources";
import { usableEmailOrNull, usablePhoneOrNull } from "@shared/fieldHygiene";
import type {
  BudgetSnapshot,
  ProspectRecord,
  ProspectSource,
  SourceCredentials,
  VendorFailure,
} from "../types";
import { vendorFetch, type VendorFetchOk } from "../vendorHttp";
import { COUNTRY_CODES, regionCountry } from "../bridge";
import { normalizeDomain } from "../../scraper/domain";
import { stripNameCredentials } from "../../enrichment/personName";
import { parseTargetPlaces, placeFit, type TargetPlaces } from "../../placeFit";
import { meterUsedToday, recordSpend } from "../../spend";

export const LEADOCEAN_API = "https://api.leadocean.io";
export const LEADOCEAN_SITE = "https://leadocean.io";

/** Records one search() may walk through to fill its limit, bounded so a skip-ahead walk cannot hold a tick. */
const MAX_PAGES_PER_SEARCH = 5;
const PAGE_LIMIT = 100;

/* ─── Config the credential row carries (non-secret) ───────────────────── */

export interface LeadOceanConfig {
  acceptedEmailStatuses?: LeadoceanEmailStatus[];
  fetchPhones?: boolean;
  /** People pulled (search rows) per UTC day, per workspace. Absent = no cap. */
  dailyPeopleCap?: number;
  /** What LeadOcean said at the last test. Plan and limits are always read, never assumed. */
  plan?: string | null;
  searchView?: "full" | "thin" | null;
  scopes?: string[];
  requestsPerSecond?: number | null;
  records?: LeadOceanRecords | null;
  pace?: { search: LeadOceanWindow[]; enrich: LeadOceanWindow[]; paced: { kind: string | null; window: string | null; resetsAt: string | null } | null } | null;
  usage?: { period: string | null; used: number | null; resetsAt: string | null; searchToday: number; enrichToday: number } | null;
  /** Any numeric phone or reveal counter the account read carries: the spec names none. */
  phoneCounters?: Record<string, number>;
}

export interface LeadOceanRecords {
  ceiling: number | null;
  used: number | null;
  remaining: number | null;
  resetsAt: string | null;
  overLimit: boolean;
  whenOver: string | null;
}

export interface LeadOceanWindow {
  window: string;
  label: string;
  limit: number;
  used: number;
  resetsAt: string | null;
}

function cfg(c: SourceCredentials): LeadOceanConfig {
  return (c.config ?? {}) as LeadOceanConfig;
}

function dailyCapOf(c: SourceCredentials): number | null {
  const n = Number(cfg(c).dailyPeopleCap);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

/**
 * The viewed list this workspace reads and writes. Lists live on the account,
 * so without a name per workspace, two workspaces holding one LeadOcean key
 * would hide each other's prospects from each other.
 */
export function viewedSetFor(workspaceId: number): string {
  return `velocity-ws-${workspaceId}`;
}

/* ─── Reading what comes back ───────────────────────────────────────────── */

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});
const str = (v: unknown): string | null => {
  if (v == null || typeof v === "object") return null;
  return String(v).trim() || null;
};
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export function leadoceanErrorCode(json: unknown): string | null {
  const j = obj(json);
  const err = obj(j.error);
  return str(err.code) ?? str(obj(err.details).code) ?? str(j.code);
}

function metaOf(json: unknown): Json {
  return obj(obj(json).meta);
}

function unsupportedOf(meta: Json): string[] {
  const u = meta.unsupportedFilters;
  return Array.isArray(u) ? u.map((x) => String(x)) : [];
}

/** A person's own place, however the vendor spells it. */
export function parseProfileAddress(value: unknown): { city: string | null; state: string | null; country: string | null; place: string } {
  const none = { city: null, state: null, country: null, place: "" };
  let text = typeof value === "string" ? value : null;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const a = value as Json;
    const city = str(a.city) ?? str(a.locality);
    const state = str(a.state) ?? str(a.region) ?? str(a.province) ?? str(a.state_province) ?? str(a.administrative_area);
    const country = str(a.country) ?? str(a.country_name) ?? str(a.country_code);
    if (city || state || country) {
      return { city, state, country, place: [city, state, country].filter(Boolean).join(", ") };
    }
    text = str(a.full) ?? str(a.formatted) ?? str(a.address) ?? str(a.raw) ?? str(a.text);
  }
  const parts = String(text ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return none;
  const place = parts.join(", ");
  const tail = parts[parts.length - 1];
  const country = COUNTRY_CODES[tail.toLowerCase()] ? tail : null;
  const rest = country ? parts.slice(0, -1) : parts;
  if (rest.length === 0) return { city: null, state: null, country, place };
  if (rest.length === 1) {
    return regionCountry(rest[0]) ? { city: null, state: rest[0], country, place } : { city: rest[0], state: null, country, place };
  }
  return { city: rest[0], state: rest[rest.length - 1], country, place };
}

export type PlaceCheck = "inside" | "outside" | "unknown";

/**
 * Is this person in the states searched? hqState only says where their employer
 * is headquartered. placeFit is the same reader the campaign's territory check
 * uses, so "West Virginia" is not Virginia and an unreadable place is `unknown`,
 * never `outside`.
 */
export function placeCheckOf(place: string, targets: TargetPlaces): PlaceCheck | null {
  const v = placeFit(place, targets);
  if (v === "no_targets") return null;
  return v === "inside" ? "inside" : v === "elsewhere" ? "outside" : "unknown";
}

/** A row's identity, the externalId carrying whether it was thin: acquire() is handed nothing else. */
export function externalIdFor(personId: string, thin: boolean): string {
  return `leadocean:${personId}${thin ? ":thin" : ""}`;
}

function parseExternalId(id: string): { personId: string; thin: boolean } | null {
  const m = /^leadocean:(\d+)(:thin)?$/.exec(id);
  return m ? { personId: m[1], thin: !!m[2] } : null;
}

function personIdOf(row: Json): string | null {
  return str(obj(obj(row.meta).source_ids).person_id) ?? str(row.person_id);
}

/**
 * One person row (a search row or an enriched record) mapped to ours. The email
 * is never set here: search rows carry only flags, and an enriched address goes
 * through the status check in addressFrom. A thin row has only role, place,
 * company and person_id, so its name stays blank until a lookup fills it.
 */
export function mapPersonRow(rowIn: unknown, opts?: { targets?: TargetPlaces | null; envelopeThin?: boolean }): ProspectRecord | null {
  const row = obj(rowIn);
  const personId = personIdOf(row);
  if (!personId) return null;
  const profile = obj(row.profile_data);
  const contact = obj(row.contact_data);
  const rowMeta = obj(row.meta);
  const experiences = Array.isArray(contact.contact_current_experiences) ? contact.contact_current_experiences : [];
  const exp = obj(experiences[0]);
  const employees = obj(exp.company_employees);
  const seniority = obj(exp.job_seniority);

  const fullName = str(profile.profile_full_name);
  let firstName = str(profile.profile_first_name) ?? "";
  let lastName = str(profile.profile_last_name) ?? "";
  if (!firstName && !lastName && fullName) {
    const parts = fullName.split(/\s+/);
    firstName = parts[0] ?? "";
    lastName = parts.slice(1).join(" ");
  }
  firstName = stripNameCredentials(firstName) ?? "";
  lastName = stripNameCredentials(lastName) ?? "";

  const thin = opts?.envelopeThin === true || str(rowMeta.view) === "thin" || (!fullName && !lastName && str(profile.profile_url) == null);
  const address = parseProfileAddress(profile.profile_address);
  const placeCheck = opts?.targets ? placeCheckOf(address.place, opts.targets) : null;
  const domain = str(exp.company_domain);
  const url = str(profile.profile_url);
  const headcount = num(employees.number_of_employees);

  return {
    externalId: externalIdFor(personId, thin),
    firstName,
    lastName,
    jobTitle: str(exp.job_title),
    seniority: str(seniority.job_level),
    companyName: str(exp.company_name),
    companyDomain: domain ? normalizeDomain(domain) : null,
    // Search publishes flags, never addresses. Masked until a lookup answers.
    email: null,
    emailIsMasked: true,
    emailVerifiedAt: null,
    mobilePhone: null,
    businessPhone: null,
    linkedinUrl: url && /linkedin\.com/i.test(url) ? url : null,
    city: address.city,
    stateProvince: address.state,
    country: address.country,
    industry: str(exp.company_industry),
    headcount: headcount != null ? String(headcount) : str(employees.number_of_employees_code),
    // A projection, never the row: it can hold a picture block, and the run
    // inspector needs only what decided the row's fate.
    rawSourcePayload: {
      personId,
      personGroupId: str(obj(rowMeta.source_ids).person_group_id),
      thin,
      hasEmail: typeof contact.has_email === "boolean" ? contact.has_email : null,
      emailStatus: str(contact.email_status),
      emailType: str(contact.email_type),
      hasPhone: typeof contact.has_phone === "boolean" ? contact.has_phone : null,
      address: address.place || null,
      ...(placeCheck ? { placeCheck } : {}),
    },
  };
}

function acceptedStatus(status: string | null, accepted: readonly string[]): boolean {
  if (!status) return false;
  if ((LEADOCEAN_NEVER_ACCEPT as readonly string[]).indexOf(status) !== -1) return false;
  return accepted.indexOf(status) !== -1;
}

/**
 * The address to take from an enriched record: the first (they come best first)
 * at the current employer with a status this workspace accepts. A former
 * employer's address (`work_other`) and a personal one are not what a campaign
 * is writing to, whatever their status.
 */
export function addressFrom(contactEmails: unknown, accepted: readonly string[]): { email: string; status: string; verifiedBatchDate: string | null } | null {
  if (!Array.isArray(contactEmails)) return null;
  for (let i = 0; i < contactEmails.length; i++) {
    const e = obj(contactEmails[i]);
    if (str(e.type) !== "work") continue;
    const status = str(e.status);
    if (!acceptedStatus(status, accepted)) continue;
    const email = usableEmailOrNull(e.email);
    if (email) return { email, status: status as string, verifiedBatchDate: str(e.verified_batch_date) };
  }
  return null;
}

/* ─── Paces and quotas ──────────────────────────────────────────────────── */

type Answer = { status: number; headers: Headers; json: unknown };

const QUOTA_STATES = new Set(["paced", "over-limit"]);
const PACE_CODES = new Set(["fair_use_paced", "fair_use_throttled", "key_quota"]);
const PACE_RETRY_AFTER_SECONDS = 5;

function secondsUntil(iso: string | null): number | undefined {
  if (!iso) return undefined;
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return undefined;
  return Math.max(1, Math.ceil((at - Date.now()) / 1000));
}

/**
 * Told to wait rather than refused for rate? Retrying would be retrying into the
 * pace. Too-fast answers `Retry-After: 1`; a pace 60, a key's quota the seconds
 * to its reset. So a long wait reads as a pace even with no header or code to
 * say so, which is how AppSumo's FAQ describes it.
 */
function isPaceAnswer(a: Answer): boolean {
  if (a.status !== 429) return false;
  const code = leadoceanErrorCode(a.json);
  return QUOTA_STATES.has(String(a.headers.get("x-quota-state") ?? ""))
    || (code != null && PACE_CODES.has(code))
    || Number(a.headers.get("retry-after") ?? 0) > PACE_RETRY_AFTER_SECONDS;
}

/** When a successful answer's pace ends, in seconds. */
function paceSeconds(headers: Headers, json: unknown): number | undefined {
  const until = str(obj(metaOf(json).notice).resetsAt) ?? str(headers.get("x-quota-reset"));
  return until && until !== "never" ? secondsUntil(until) : undefined;
}

/** The pace a successful answer reports, in its headers (all doors) or meta.notice (all but the v2 doors). */
export function paceNoticeOf(headers: Headers, json: unknown): string | null {
  const state = String(headers.get("x-quota-state") ?? "");
  const notice = obj(metaOf(json).notice);
  const code = str(notice.code);
  if (!QUOTA_STATES.has(state) && !code) return null;
  const until = str(notice.resetsAt) ?? str(headers.get("x-quota-reset"));
  const kind = str(notice.kind);
  const what = kind ? `${kind} records` : state === "over-limit" || code === "fair_use_throttled" ? "this account's monthly records" : "records";
  return `LeadOcean has slowed ${what} to 1 request a minute${until && until !== "never" ? ` until ${until}` : ""}`;
}

function heldFailure(message: string, resetsAt: string | null, fallback?: number): VendorFailure {
  const seconds = secondsUntil(resetsAt) ?? fallback;
  return { ok: false, reason: "rate_limited", held: true, message, ...(seconds != null ? { retryAfterSeconds: seconds } : {}) };
}

/** Our vocabulary for an answer the shared classifier cannot read in LeadOcean's terms. */
function describeFailure(f: VendorFailure, a: Answer | null): VendorFailure {
  if (f.status === 402) {
    return { ...f, reason: "budget_exhausted", message: `LeadOcean says this account's records are spent (${f.message})` };
  }
  if (a && isPaceAnswer(a)) {
    const details = obj(obj(obj(a.json).error).details);
    const code = leadoceanErrorCode(a.json);
    const resetsAt = str(details.resetsAt) ?? str(obj(obj(a.json).error).resetsAt) ?? str(obj(a.json).resetsAt) ?? str(a.headers.get("x-key-limit-reset")) ?? str(a.headers.get("x-quota-reset"));
    const until = resetsAt && resetsAt !== "never" ? ` until ${resetsAt}` : "";
    return heldFailure(
      code === "key_quota"
        ? `LeadOcean is holding this key at its own cap${until}`
        : `LeadOcean has slowed this account to 1 request a minute${until}, so Velocity is holding off`,
      resetsAt === "never" ? null : resetsAt,
      f.retryAfterSeconds,
    );
  }
  return f;
}

/* ─── Filters ───────────────────────────────────────────────────────────── */

const SENIORITY: Record<string, string> = {
  owner: "owner", founder: "founder", "co-founder": "founder", cofounder: "founder",
  "c-level": "c_suite", "c level": "c_suite", "c-suite": "c_suite", "c suite": "c_suite", c_suite: "c_suite", cxo: "c_suite", chief: "c_suite", executive: "c_suite",
  partner: "partner", vp: "vp", "vice president": "vp", svp: "vp", evp: "vp", head: "head", director: "director",
  manager: "manager", senior: "senior", entry: "entry", "entry level": "entry", junior: "entry", intern: "intern",
};

/** The `job_function` enum, closed and case-sensitive (spec, 2026-11-02). */
const JOB_FUNCTIONS = [
  "Advertising & Marketing", "Art, Culture and Creative Professionals", "Construction", "Customer/Client Service", "Education",
  "Engineering", "Finance & Accounting", "General Business & Management", "Healthcare & Human Services", "Human Resources",
  "Information Technology", "Legal", "Manufacturing & Production", "Operations", "Other", "Public Administration & Safety",
  "Purchasing", "Research & Development", "Sales & Business Development", "Science", "Supply Chain & Logistics", "Writing/Editing",
];
const JOB_FUNCTION_ALIASES: Record<string, string> = { hr: "Human Resources", it: "Information Technology", "r&d": "Research & Development", support: "Customer/Client Service" };

function jobFunctionFor(department: string): string | null {
  const t = department.trim().toLowerCase();
  const alias = JOB_FUNCTION_ALIASES[t];
  if (alias) return alias;
  const exact = JOB_FUNCTIONS.find((f) => f.toLowerCase() === t);
  if (exact) return exact;
  return t.length >= 3 ? JOB_FUNCTIONS.find((f) => f.toLowerCase().includes(t)) ?? null : null;
}

/** The table first: "UK" is two letters and LeadOcean's list spells it GB. */
function countryCodeFor(value: string): string | null {
  const v = value.trim();
  const named = COUNTRY_CODES[v.toLowerCase()];
  if (named) return named;
  return /^[A-Za-z]{2}$/.test(v) ? v.toUpperCase() : null;
}

/** Values through a closed list: what it knows, what it does not. */
function through(values: string[], map: (v: string) => string | null): { sent: string[]; unknown: string[] } {
  const sent: string[] = [];
  const unknown: string[] = [];
  for (const v of values) {
    const m = map(v);
    if (m == null) unknown.push(v);
    else if (sent.indexOf(m) === -1) sent.push(m);
  }
  return { sent, unknown };
}

export interface BuiltFilters {
  filters: Json;
  /** Parts of the search that could not be sent, for the note. */
  notes: string[];
  /** Why nothing should be bought for this search. */
  refused: string | null;
}

/** The request's fields that say nothing about who the audience is. */
const NOT_AN_AUDIENCE = new Set(["order", "limit", "excludeViewed", "viewedSet", "emailStatus", "emailType", "hasPhone"]);

/**
 * SearchCriteria → the people-search body. Values go to LeadOcean as arrays,
 * where several values in one filter OR and filters AND. A filter with a closed
 * list that keeps none of its values is a refusal, not an omission: dropping it
 * would buy rows for a wider audience than the one asked for.
 */
export function buildSearchFilters(
  criteria: SearchCriteria,
  accepted: readonly string[],
  workspaceId: number,
  /** Lower-cased label → LeadOcean's exact spelling, or null when the list could not be read. */
  industryLabels: Map<string, string> | null,
): BuiltFilters {
  const notes: string[] = [];
  const filters: Json = {
    order: "stable",
    excludeViewed: true,
    viewedSet: viewedSetFor(workspaceId),
    emailStatus: [...accepted],
    emailType: ["work"],
  };
  const refuse = (message: string): BuiltFilters => ({ filters, notes, refused: message });

  if (criteria.jobTitles.length) filters.title = criteria.jobTitles;

  if (criteria.seniorities.length) {
    const s = through(criteria.seniorities, (v) => SENIORITY[v.trim().toLowerCase()] ?? null);
    if (s.sent.length === 0) return refuse(`LeadOcean has no seniority like ${s.unknown.join(", ")}.`);
    if (s.unknown.length) notes.push(`seniority not sent: ${s.unknown.join(", ")}`);
    filters.seniority = s.sent;
  }
  if (criteria.departments.length) {
    const d = through(criteria.departments, jobFunctionFor);
    if (d.sent.length === 0) return refuse(`LeadOcean has no job function like ${d.unknown.join(", ")}.`);
    if (d.unknown.length) notes.push(`department not sent: ${d.unknown.join(", ")}`);
    filters.jobFunction = d.sent;
  }
  if (criteria.industries.length) {
    // `industry` is a hard filter on a closed list; `companyKeywords` takes free
    // text and exact labels alike. They AND, so a mixed list cannot be split
    // between them: all exact labels go native, anything else goes as keywords.
    const exact = industryLabels ? criteria.industries.map((v) => industryLabels.get(v.trim().toLowerCase()) ?? null) : [];
    if (exact.length && exact.every((v): v is string => v != null)) filters.industry = exact;
    else filters.companyKeywords = criteria.industries;
  }

  if (criteria.countries.length) {
    const c = through(criteria.countries, countryCodeFor);
    if (c.sent.length === 0) return refuse(`LeadOcean filters on country codes, and ${c.unknown.join(", ")} is not one.`);
    if (c.unknown.length) notes.push(`country not sent: ${c.unknown.join(", ")}`);
    filters.country = c.sent;
  }
  if (criteria.stateProvinces.length) {
    // No person-level state exists. The employer's headquarters narrows the
    // search and the address check judges each person afterwards. hqCountry pins
    // an ambiguous value, and a person outside the state's country is not in it.
    filters.hqState = criteria.stateProvinces;
    const stateCountries = criteria.stateProvinces.map((s) => regionCountry(s)).filter((x): x is "US" | "CA" => x != null);
    const countries = Array.from(new Set<string>([...((filters.country as string[] | undefined) ?? []), ...stateCountries]));
    if (countries.length) {
      filters.hqCountry = countries;
      filters.country = countries;
    }
  }
  if (criteria.cities.length) filters.city = criteria.cities;
  if (criteria.companyNames.length) filters.companyName = criteria.companyNames;
  if (criteria.companyDomains.length) filters.domain = criteria.companyDomains;
  if (criteria.keywords.length) filters.keywords = criteria.keywords;
  if (criteria.technologies.length) filters.technologies = criteria.technologies;
  if (criteria.headcountRange?.min != null) filters.minEmployees = criteria.headcountRange.min;
  if (criteria.headcountRange?.max != null) filters.maxEmployees = criteria.headcountRange.max;
  if (criteria.hasPhone !== undefined) filters.hasPhone = criteria.hasPhone;
  if (criteria.hasEmail === false) notes.push("has email: this source only returns people with an address");

  if (!Object.keys(filters).some((k) => !NOT_AN_AUDIENCE.has(k))) {
    return refuse("Set a real filter: a search on presence alone would buy rows from LeadOcean's whole database.");
  }
  return { filters, notes, refused: null };
}

/* ─── The account read ──────────────────────────────────────────────────── */

function windowsOf(list: unknown): LeadOceanWindow[] {
  if (!Array.isArray(list)) return [];
  const out: LeadOceanWindow[] = [];
  for (const raw of list) {
    const w = obj(raw);
    const limit = num(w.limit);
    if (limit == null) continue;
    out.push({ window: str(w.window) ?? "?", label: str(w.windowLabel) ?? str(w.window) ?? "window", limit, used: num(w.used) ?? 0, resetsAt: str(w.resetsAt) });
  }
  return out;
}

/** Numeric phone or reveal counters, two levels deep, by path. The spec names none; a plan may carry one. */
function phoneCountersOf(account: Json): Record<string, number> {
  const out: Record<string, number> = {};
  const walk = (o: unknown, prefix: string, depth: number) => {
    if (!o || typeof o !== "object" || Array.isArray(o)) return;
    for (const [k, v] of Object.entries(o as Json)) {
      const path = prefix ? `${prefix}.${k}` : k;
      if (typeof v === "number" && /phone|reveal/i.test(path)) out[path] = v;
      else if (depth < 2) walk(v, path, depth + 1);
    }
  };
  walk(account, "", 0);
  return out;
}

/**
 * The facts worth keeping from /v1/account. An allowlist on purpose: the same
 * document holds the account holder's email and the key's id and prefix, and
 * credential config is readable by every member of the workspace.
 */
export function summarizeAccount(accountIn: unknown): Pick<LeadOceanConfig, "plan" | "searchView" | "scopes" | "requestsPerSecond" | "records" | "pace" | "phoneCounters"> {
  const a = obj(accountIn);
  const account = obj(a.account);
  const records = obj(a.records);
  const pace = a.pace && typeof a.pace === "object" ? obj(a.pace) : null;
  const paced = pace && pace.paced ? obj(pace.paced) : null;
  const view = str(obj(a.search).view);
  const scopes = obj(a.key).scopes;
  return {
    plan: str(account.plan) ?? str(obj(a.subscription).planSlug) ?? str(obj(a.grant).planSlug),
    searchView: view === "thin" || view === "full" ? view : null,
    scopes: Array.isArray(scopes) ? scopes.map((s) => String(s)) : [],
    requestsPerSecond: num(obj(a.rate).rps),
    records: {
      ceiling: num(records.ceiling),
      used: num(records.used),
      remaining: num(records.remaining),
      resetsAt: str(records.resetsAt),
      overLimit: records.overLimit === true,
      whenOver: str(records.whenOver),
    },
    pace: pace
      ? {
          search: windowsOf(pace.search),
          enrich: windowsOf(pace.enrich),
          paced: paced ? { kind: str(paced.kind), window: str(paced.windowLabel) ?? str(paced.window), resetsAt: str(paced.resetsAt) } : null,
        }
      : null,
    phoneCounters: phoneCountersOf(a),
  };
}

/** Why the account read says not to buy anything right now, or null. */
export function holdFromAccount(accountIn: unknown): VendorFailure | null {
  const s = summarizeAccount(accountIn);
  if (obj(obj(accountIn).account).suspended === true) {
    return { ok: false, reason: "insufficient_scope", message: "LeadOcean has suspended this account." };
  }
  const paced = s.pace?.paced;
  // Company search can be paced apart, and this source does not use it. A paced
  // lookup holds the search too: rows bought now could not be looked up.
  if (paced && paced.kind !== "company") {
    return heldFailure(
      `LeadOcean has slowed ${paced.kind === "enrich" ? "enrichment" : "search"} records to 1 request a minute${paced.window ? ` (${paced.window})` : ""}${paced.resetsAt ? ` until ${paced.resetsAt}` : ""}, so Velocity is holding off`,
      paced.resetsAt,
    );
  }
  if (s.records?.overLimit) {
    if (s.records.whenOver === "refused") return { ok: false, reason: "budget_exhausted", message: "LeadOcean says this account's records are spent." };
    return heldFailure(`This account is past its LeadOcean records${s.records.resetsAt ? ` until ${s.records.resetsAt}` : ""}, so Velocity is holding off`, s.records.resetsAt);
  }
  return null;
}

/**
 * Rows this account can still afford, on a plan that refuses past its records: a
 * person costs two, so half of what is left. Buying more would leave rows nobody
 * can look up. Null on a plan with no such number, or that slows instead.
 */
export function affordableRows(accountIn: unknown): number | null {
  const r = summarizeAccount(accountIn).records;
  return r?.whenOver === "refused" && r.remaining != null ? Math.floor(r.remaining / 2) : null;
}

/* ─── The industry list (public, free, no key) ──────────────────────────── */

/**
 * Looked up per term, not read whole: the list has 534 values and the endpoint
 * stops at 500 with a `truncated` flag (200 with no limit, checked 2026-11-02),
 * so a full read would quietly miss the last ones. Null is a remembered "not a
 * label", which is as useful as a hit.
 */
const INDUSTRY_TTL_MS = 24 * 60 * 60 * 1000;
const industryCache = new Map<string, { at: number; label: string | null }>();

export function __clearIndustryCacheForTests(): void {
  industryCache.clear();
}

/* ─── The adapter ───────────────────────────────────────────────────────── */

export function createLeadOceanSource(deps?: { fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void> }): ProspectSource {
  const call = async <T,>(
    c: SourceCredentials,
    endpoint: string,
    method: "GET" | "POST" | "DELETE",
    path: string,
    body?: unknown,
    attempts = 2,
  ): Promise<VendorFetchOk<T> | VendorFailure> => {
    const seen: { answer: Answer | null } = { answer: null };
    const res = await vendorFetch<T>(`${LEADOCEAN_API}${path}`, {
      workspaceId: c.workspaceId, source: "leadocean", endpoint, method,
      headers: { "x-api-key": c.secrets.apiKey ?? "" },
      ...(body !== undefined ? { body } : {}),
      timeoutMs: 30_000, attempts, fetchImpl: deps?.fetchImpl, sleep: deps?.sleep,
      errorCode: leadoceanErrorCode,
      noRetry: (a) => { seen.answer = a; return isPaceAnswer(a); },
    });
    return res.ok ? res : describeFailure(res, seen.answer);
  };

  const readAccount = async (c: SourceCredentials) => call<{ data?: unknown }>(c, "account", "GET", "/v1/account");

  /** Each term's exact label, or null for the whole list when it cannot be read (they then go as keywords). */
  const industryLabels = async (c: SourceCredentials, terms: string[]): Promise<Map<string, string> | null> => {
    const labels = new Map<string, string>();
    for (const term of terms) {
      const key = term.trim().toLowerCase();
      let hit = industryCache.get(key);
      if (!hit || Date.now() - hit.at >= INDUSTRY_TTL_MS) {
        const res = await vendorFetch<{ data?: { values?: unknown[] } }>(`${LEADOCEAN_API}/v1/enums/industry?q=${encodeURIComponent(term.trim())}&limit=50`, {
          workspaceId: c.workspaceId, source: "leadocean", endpoint: "enums.industry", attempts: 1, timeoutMs: 15_000, fetchImpl: deps?.fetchImpl, sleep: deps?.sleep,
        });
        const values = res.ok ? res.json?.data?.values : null;
        if (!Array.isArray(values)) return null;
        hit = { at: Date.now(), label: values.map(String).find((v) => v.toLowerCase() === key) ?? null };
        industryCache.set(key, hit);
      }
      if (hit.label) labels.set(key, hit.label);
    }
    return labels;
  };

  /** Free. A row that is delivered is paid for: asking for it again would only buy it twice. */
  const markViewed = async (c: SourceCredentials, ids: string[]): Promise<boolean> => {
    if (ids.length === 0) return true;
    const res = await call(c, "viewed.add", "POST", "/v1/people/viewed", { ids, set: viewedSetFor(c.workspaceId) });
    return res.ok;
  };

  /** Free. People whose lookup never ran must be findable again, or they are lost. */
  const forgetViewed = async (c: SourceCredentials, ids: string[]): Promise<boolean> => {
    if (ids.length === 0) return true;
    const res = await call(c, "viewed.remove", "DELETE", "/v1/people/viewed", { ids, set: viewedSetFor(c.workspaceId) });
    return res.ok;
  };

  const spend = (c: SourceCredentials, campaignId: number | null | undefined, meter: "search_records" | "lookups", quantity: number) =>
    recordSpend({
      workspaceId: c.workspaceId, vendor: "leadocean", meter, quantity,
      keySource: "workspace", feature: campaignId ? "are.discovery" : "sourceSearch",
    });

  return {
    slug: "leadocean",
    displayName: "LeadOcean",
    docsUrl: LEADOCEAN_SITE,
    credentialMode: "table",
    acquisition: "on_demand",
    writeOnlyKey: true,
    capabilities: () => LEADOCEAN_CAPABILITIES,
    // A people cap per UTC day, read from the spend ledger the adapter writes:
    // the budget ledger only holds units for an acquiring run, and here a
    // preview spends too. Nothing is hard-coded for any plan.
    budgetPeriods: () => [],

    /** Only the free reads. It runs on every save and six-hourly, so it must never buy a row. */
    async validateCredentials(c) {
      const res = await readAccount(c);
      if (!res.ok) {
        return {
          ok: false,
          message: `LeadOcean could not confirm this key: ${res.message}`,
          terminal: res.reason === "unauthorized" || res.reason === "insufficient_scope",
          transient: res.reason === "unavailable" || res.reason === "rate_limited",
        };
      }
      const summary = summarizeAccount(res.json?.data);
      const discovered: LeadOceanConfig = { ...summary };
      const usage = await call<{ data?: unknown }>(c, "usage", "GET", "/v1/usage");
      if (usage.ok) {
        const u = obj(usage.json?.data);
        const today = new Date().toISOString().slice(0, 10);
        const daily = Array.isArray(u.daily) ? u.daily.map(obj).filter((d) => str(d.day) === today) : [];
        discovered.usage = {
          period: str(u.period),
          used: num(u.used),
          resetsAt: str(u.resetsAt),
          searchToday: daily.reduce((n, d) => n + (num(d.search) ?? 0), 0),
          enrichToday: daily.reduce((n, d) => n + (num(d.enrich) ?? 0), 0),
        };
        if (!discovered.plan) discovered.plan = str(obj(u.plan).slug);
      }
      if (obj(obj(res.json?.data).account).suspended === true) {
        return { ok: false, message: "LeadOcean has suspended this account.", discovered: discovered as Record<string, unknown>, terminal: true };
      }
      const missing = ["search", "enrich"].filter((s) => (summary.scopes ?? []).indexOf(s) === -1);
      if ((summary.scopes ?? []).length > 0 && missing.length > 0) {
        return { ok: false, message: `This key is missing the ${missing.join(" and ")} scope${missing.length > 1 ? "s" : ""}. Create one with both at app.leadocean.io/keys.`, discovered: discovered as Record<string, unknown>, terminal: true };
      }
      const recordsLine = summary.records?.remaining != null
        ? `${summary.records.remaining.toLocaleString()} records left`
        : summary.records?.used != null ? `${summary.records.used.toLocaleString()} records used this period` : null;
      return {
        ok: true,
        message: ["Key accepted", discovered.plan ? `${discovered.plan} plan` : null, recordsLine, summary.searchView === "thin" ? "search rows are thin on this plan" : null].filter(Boolean).join(" · "),
        discovered: discovered as Record<string, unknown>,
        terminal: false,
      };
    },

    async search(criteria, c, limit, ctx) {
      const accepted = leadoceanAcceptedStatuses(cfg(c).acceptedEmailStatuses);
      const built = buildSearchFilters(criteria, accepted, c.workspaceId, criteria.industries.length ? await industryLabels(c, criteria.industries) : null);
      if (built.refused) return { ok: false, reason: "invalid_params", message: built.refused };

      let want = Math.max(1, Math.floor(limit));
      const cap = dailyCapOf(c);
      if (cap != null) {
        const used = await meterUsedToday(c.workspaceId, "leadocean", "search_records");
        if (used >= cap) return { ok: false, reason: "budget_exhausted", message: `this workspace's daily cap on people pulled from LeadOcean is reached (${used}/${cap})` };
        want = Math.min(want, cap - used);
      }

      // What the account says first, free: a pace is held before a row is bought.
      const account = await readAccount(c);
      if (!account.ok) {
        // A key the account read refuses would be refused by the page too. Any
        // other failure says nothing about the page, whose answer will classify.
        if (account.reason === "unauthorized" || account.reason === "insufficient_scope") return account;
      } else {
        const hold = holdFromAccount(account.json?.data);
        if (hold) return hold;
        const affordable = affordableRows(account.json?.data);
        if (affordable === 0) return { ok: false, reason: "budget_exhausted", message: "LeadOcean has fewer records left on this account than the two a person costs." };
        if (affordable != null) want = Math.min(want, affordable);
      }

      const notes = built.notes.slice();
      // Free, and the only way to learn a filter would be dropped before paying
      // for rows that ignore it. A withheld total is not by itself a refusal: a
      // large viewed list withholds it too, and that drops no filter.
      const sizing = await call<{ meta?: Json }>(c, "people.search(count)", "POST", "/v1/people/search", { ...built.filters, count: true, limit: 1 });
      if (!sizing.ok) return sizing;
      const sizingMeta = metaOf(sizing.json);
      const dropped = unsupportedOf(sizingMeta);
      if (dropped.length > 0) {
        const why = str(obj(sizingMeta.totalWithheld).message);
        return {
          ok: false,
          reason: "invalid_params",
          message: `LeadOcean would not apply ${dropped.join(", ")}, so the rows would not be filtered on it. Nothing was bought. ${why ?? "Narrow the employer side with an industry or a company size."}`,
        };
      }
      // Documented free. If it ever is not, the ledger must say what it cost.
      let units = sizingMeta.countOnly === true ? 0 : (num(sizingMeta.credits) ?? 0);
      if (units > 0) await spend(c, ctx.campaignId, "search_records", units);
      const total = num(sizingMeta.total);
      if (total === 0) {
        return { ok: true, records: [], nextCursor: null, totalAvailable: 0, alreadyCharged: false, unitsSpent: units, note: [...notes, "nobody matched; nothing was bought"].join("; ") };
      }

      const targets = criteria.stateProvinces.length ? parseTargetPlaces(criteria.stateProvinces) : null;
      const records: ProspectRecord[] = [];
      const groups = new Set<string>();
      const counts: Record<PlaceCheck, number> = { inside: 0, outside: 0, unknown: 0 };
      let noAddress = 0;
      let cursor: string | null = null;
      let restarted = false;
      let thinSeen = false;
      let viewedFailed = 0;
      let unreadable = 0;
      let unreadableKeys: string[] = [];
      // Rows delivered, not rows kept: the limit and the cap count what is billed,
      // and a row dropped below was billed all the same.
      let delivered = 0;
      let skippedAhead = false;

      for (let page = 0; page < MAX_PAGES_PER_SEARCH && delivered < want; page++) {
        const res: VendorFetchOk<{ data?: unknown[]; meta?: Json }> | VendorFailure = await call<{ data?: unknown[]; meta?: Json }>(
          c, "people.search", "POST", "/v1/people/search",
          { ...built.filters, limit: Math.min(PAGE_LIMIT, want - delivered), ...(cursor ? { cursor } : {}) },
        );
        if (!res.ok) {
          // The snapshot this walk was reading was retired. People already paid
          // for are in the viewed list, so starting over cannot bill them twice.
          const gone = res.status === 410 && cursor != null && !restarted;
          if (gone) { restarted = true; cursor = null; notes.push("LeadOcean retired this walk's snapshot; restarted"); continue; }
          if (records.length === 0) return { ...res, unitsSpent: units };
          notes.push(`stopped after page ${page}: ${res.message}`);
          break;
        }
        // An answer with no list in it is not "nobody": it is not an answer.
        if (!Array.isArray(res.json?.data)) {
          if (records.length === 0) return { ok: false, reason: "unavailable", message: "LeadOcean answered a search without a list of people", unitsSpent: units };
          notes.push("stopped: LeadOcean answered a page without a list of people");
          break;
        }
        const rows = res.json.data;
        const meta = metaOf(res.json);
        delivered += rows.length;
        if (meta.walkCapped === true) skippedAhead = true;
        const billed = num(meta.credits) ?? rows.length;
        units += billed;
        if (billed > 0) await spend(c, ctx.campaignId, "search_records", billed);

        const unapplied = unsupportedOf(meta);
        if (unapplied.length > 0) notes.push(`LeadOcean did not apply ${unapplied.join(", ")} on this page, so these rows are not filtered on it`);
        const envelopeThin = str(meta.view) === "thin";

        const ids: string[] = [];
        for (const row of rows) {
          const rec = mapPersonRow(row, { targets, envelopeThin });
          if (!rec) {
            // Paid for, and useless. Keys only, never values: this is how a
            // renamed field gets told apart from a search that found nobody.
            unreadable += 1;
            unreadableKeys = Object.keys(obj(row)).slice(0, 12);
            continue;
          }
          const raw = rec.rawSourcePayload;
          ids.push(String(raw.personId));
          if (raw.thin) thinSeen = true;
          // Two records of one person: the row is paid for, the second lookup need not be.
          const group = raw.personGroupId ? String(raw.personGroupId) : null;
          if (group && groups.has(group)) continue;
          if (group) groups.add(group);
          // The flags say a lookup would find nothing to take: no second charge.
          // Enrichment re-checks each address, because search's status is an upper bound.
          const status = raw.emailStatus ? String(raw.emailStatus) : null;
          if (raw.hasEmail === false || (status && !acceptedStatus(status, accepted))) { noAddress += 1; continue; }
          const check = raw.placeCheck as PlaceCheck | undefined;
          if (check) counts[check] += 1;
          records.push(rec);
        }
        if (!(await markViewed(c, ids))) viewedFailed += ids.length;

        const pace = paceNoticeOf(res.headers, res.json);
        if (pace) { notes.push(pace); break; }
        if (meta.depthCapped === true) { notes.push("reached LeadOcean's depth cap for one search; narrow the filters to reach further"); break; }
        cursor = str(meta.nextCursor);
        if (!cursor) break;
      }
      // Each search starts over from the lowest id, so people already seen are
      // skipped again every time. Past a point that can use up the whole walk.
      if (skippedAhead && delivered < want && cursor) notes.push("LeadOcean was still skipping people this workspace has already seen when the walk stopped, so this search reached fewer than it could; narrow the filters to reach further");

      if (unreadable) notes.push(`${unreadable} row${unreadable === 1 ? "" : "s"} with no person id, not usable (row keys: ${unreadableKeys.join(", ") || "none"})`);
      if (targets) notes.push(`place check: ${counts.inside} inside, ${counts.outside} outside, ${counts.unknown} unknown`);
      if (noAddress) notes.push(`${noAddress} row${noAddress === 1 ? "" : "s"} with no address you accept, not looked up`);
      if (thinSeen) notes.push("this plan returns thin rows, so a name comes only with a lookup");
      if (viewedFailed) notes.push(`could not remember ${viewedFailed} row${viewedFailed === 1 ? "" : "s"} as viewed, so a later search may bill them again`);
      return {
        ok: true,
        records: records.slice(0, want),
        // Never a cursor: see the file header.
        nextCursor: null,
        totalAvailable: total,
        alreadyCharged: false,
        unitsSpent: units,
        ...(notes.length ? { note: notes.join("; ") } : {}),
      };
    },

    async acquire(externalIds, c, ctx) {
      if (externalIds.length === 0) return { ok: true, records: [], unitsSpent: 0, failedExternalIds: [] };
      const accepted = leadoceanAcceptedStatuses(cfg(c).acceptedEmailStatuses);
      const fetchPhones = cfg(c).fetchPhones === true;
      const fullLookup = leadoceanUsesFullLookup(accepted, fetchPhones);
      const records: ProspectRecord[] = [];
      const failed: string[] = [];
      const paidMiss: string[] = [];
      let units = 0;
      let stop: VendorFailure | null = null;
      const pace: { message: string | null; seconds?: number } = { message: null };
      let stoppedAt = externalIds.length;
      // One at a time and at once, so the ledger holds what was billed if this
      // batch dies partway: a deploy does not wait for a hundred lookups.
      const bill = async (n: number) => {
        units += n;
        if (n > 0) await spend(c, ctx?.campaignId, "lookups", n);
      };
      const notePace = (headers: Headers, json: unknown) => {
        pace.message = paceNoticeOf(headers, json);
        pace.seconds = pace.message ? paceSeconds(headers, json) : undefined;
      };

      for (let i = 0; i < externalIds.length; i++) {
        const id = externalIds[i];
        const parsed = parseExternalId(id);
        if (!parsed) { failed.push(id); continue; }

        let identity: ProspectRecord | null = null;
        let address: { email: string; status: string; verifiedBatchDate: string | null } | null = null;
        const phones: { mobile: string | null; business: string | null } = { mobile: null, business: null };
        let lookup = "work_email";

        // A thin row has no name, and the work-email door answers with an
        // address alone. Ask who it is without revealing contact points first:
        // the flags may already say the second charge would find nothing.
        if (fullLookup || parsed.thin) {
          const res = await call<{ data?: unknown; meta?: Json }>(c, "people.enrich", "POST", "/v1/people/enrich", { person_id: parsed.personId, reveal_email: fullLookup });
          if (!res.ok) {
            if (res.status === 404) { failed.push(id); continue; }
            stop = res; stoppedAt = i; break;
          }
          await bill(num(metaOf(res.json).credits) ?? 1);
          notePace(res.headers, res.json);
          identity = mapPersonRow(res.json?.data);
          const contact = obj(obj(res.json?.data).contact_data);
          if (fullLookup) {
            lookup = "enrich";
            address = addressFrom(contact.contact_emails, accepted);
            if (fetchPhones && Array.isArray(contact.contact_phones)) {
              for (const raw of contact.contact_phones) {
                const p = obj(raw);
                const phone = usablePhoneOrNull(p.phone);
                if (!phone) continue;
                if (str(p.type) === "mobile") phones.mobile = phones.mobile ?? phone;
                else phones.business = phones.business ?? phone;
              }
            }
          } else if (contact.has_email === false || (str(contact.email_status) && !acceptedStatus(str(contact.email_status), accepted))) {
            failed.push(id);
            paidMiss.push(id);
            if (pace.message) { stoppedAt = i + 1; break; }
            continue;
          }
          // Who they are, but not yet their address, and the door is slowed now.
          if (pace.message && !fullLookup) { stoppedAt = i; break; }
        }

        if (!fullLookup) {
          const res = await call<{ data?: unknown }>(c, "people.email.work", "POST", "/v2/people/email/work", { contact_id: parsed.personId });
          if (!res.ok) {
            if (res.status === 404) { failed.push(id); continue; }
            stop = res; stoppedAt = i; break;
          }
          // One record per call, including an answer of null. This door has no meta.
          await bill(1);
          notePace(res.headers, res.json);
          const data = obj(res.json?.data);
          const status = str(data.status);
          const email = usableEmailOrNull(data.email);
          if (email && acceptedStatus(status, accepted)) address = { email, status: status as string, verifiedBatchDate: str(data.verified_batch_date) };
        }

        if (address) {
          records.push({
            externalId: id,
            firstName: identity?.firstName ?? "", lastName: identity?.lastName ?? "",
            jobTitle: identity?.jobTitle ?? null, seniority: identity?.seniority ?? null,
            companyName: identity?.companyName ?? null, companyDomain: identity?.companyDomain ?? null,
            email: address.email, emailIsMasked: false,
            // A status is LeadOcean's, and a batch date is not a time for this
            // address: Velocity's own gate decides what can be mailed.
            emailVerifiedAt: null,
            mobilePhone: phones.mobile,
            businessPhone: phones.business,
            linkedinUrl: identity?.linkedinUrl ?? null,
            city: identity?.city ?? null, stateProvince: identity?.stateProvince ?? null, country: identity?.country ?? null,
            industry: identity?.industry ?? null, headcount: identity?.headcount ?? null,
            rawSourcePayload: { lookup, emailStatus: address.status, verifiedBatchDate: address.verifiedBatchDate },
          });
        } else {
          failed.push(id);
          paidMiss.push(id);
        }
        if (pace.message) { stoppedAt = i + 1; break; }
      }

      const unprocessed = externalIds.slice(stoppedAt);
      let givenBack = true;
      if (unprocessed.length > 0) {
        failed.push(...unprocessed);
        givenBack = await forgetViewed(c, unprocessed.map((id) => parseExternalId(id)?.personId).filter((x): x is string => !!x));
      }
      const stillViewed = givenBack ? "" : `; ${unprocessed.length} could not be given back to the viewed list, so a later search will not find them`;
      // Nothing to show for it, so the failure is the answer, with what it cost.
      if (stop && records.length === 0 && paidMiss.length === 0) return { ...stop, message: `${stop.message}${stillViewed}`, unitsSpent: units };
      const why = pace.message ?? stop?.message ?? null;
      const holdSeconds = pace.message ? pace.seconds : stop?.retryAfterSeconds;
      return {
        ok: true,
        records,
        unitsSpent: units,
        failedExternalIds: failed,
        ...(paidMiss.length ? { paidMissExternalIds: paidMiss } : {}),
        ...(why ? { note: `${why}${unprocessed.length && givenBack ? `; ${unprocessed.length} held for later` : ""}${stillViewed}` } : {}),
        ...(pace.message || stop?.held ? { hold: { message: why as string, ...(holdSeconds != null ? { retryAfterSeconds: holdSeconds } : {}) } } : {}),
      };
    },

    async remainingBudget(c) {
      const out: BudgetSnapshot[] = [];
      const cap = dailyCapOf(c);
      const used = cap != null ? await meterUsedToday(c.workspaceId, "leadocean", "search_records") : null;
      const capLeft = cap != null && used != null ? Math.max(0, cap - used) : null;
      const account = await readAccount(c);
      const summary = account.ok ? summarizeAccount(account.json?.data) : null;
      const records = summary?.records ?? null;
      // A fair-use plan has no number to run out of, and a paid one past its
      // records is slowed rather than refused: only a refusal is zero left.
      const refused = records?.whenOver === "refused";
      const vendorLeft = refused && records?.overLimit ? 0 : refused ? records?.remaining ?? null : null;
      const remaining = capLeft != null && vendorLeft != null ? Math.min(capLeft, vendorLeft) : capLeft ?? vendorLeft;
      const nextUtcDay = () => { const n = new Date(); return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate() + 1)).toISOString(); };
      out.push({
        bucket: "leads",
        remaining,
        limit: cap ?? (refused ? records?.ceiling ?? null : null),
        used: used ?? records?.used ?? null,
        resetsAt: cap != null ? nextUtcDay() : records?.resetsAt ?? null,
        fundedBy: cap != null ? "your daily cap on people pulled" : refused ? "your LeadOcean records" : "no daily cap set",
      });
      const windows = (kind: BudgetSnapshot["bucket"], label: string, list: LeadOceanWindow[] | undefined) => {
        for (const w of list ?? []) {
          out.push({ bucket: kind, remaining: Math.max(0, w.limit - w.used), limit: w.limit, used: w.used, resetsAt: w.resetsAt, fundedBy: `${label} · ${w.label}` });
        }
      };
      windows("leads", "LeadOcean search pace", summary?.pace?.search);
      windows("lookups", "LeadOcean enrichment pace", summary?.pace?.enrich);
      return out;
    },

    estimateAcquireUnits(externalId, c) {
      const fullLookup = leadoceanUsesFullLookup(leadoceanAcceptedStatuses(cfg(c).acceptedEmailStatuses), cfg(c).fetchPhones === true);
      return !fullLookup && parseExternalId(externalId)?.thin ? 2 : 1;
    },
  };
}
