/**
 * A-Leads — prospect-source adapter (owner go-ahead 2026-11-25; AppSumo Tier 4
 * on the platform owner's account: 100,000 credits a month).
 *
 * Read from the vendor's documentation only (https://docs.a-leads.co/reference,
 * read 2026-11-25). No live call has been made: the fixtures in
 * aleadsSource.test.ts are shaped like the documented responses, and whether
 * the Tier 4 plan carries API access at all is still for the owner to confirm
 * in the A-Leads dashboard.
 *
 *   SEARCH   POST /advanced-search. No emails in search. The MCP docs charge
 *            one credit per search that returns results (the AppSumo page says
 *            searches are unlimited), so the preview is treated as billed: no
 *            overfetch, and it runs only where chosen.
 *   EMAIL    POST /find-email with first name, last name and the company
 *            WEBSITE, plus the row's `document_id`, which caches the result so
 *            asking again is free. One credit per success; a miss costs
 *            nothing. There is no work-email lookup by LinkedIn URL, so a
 *            person without a company website cannot get an address here.
 *   LIMITS   200 calls a minute, 600 an hour, 6,000 a day on every endpoint.
 *            The day's 6,000 are counted here (per key, per UTC day, in this
 *            process); past them a call is refused as rate-limited, which the
 *            executor reports to the circuit breaker, so the source rests
 *            instead of being called into a wall. A 429 from the vendor does
 *            the same.
 *   USAGE    no REST endpoint reports credits (only the OAuth MCP tool does),
 *            so credits are counted in Velocity's budget ledger for a
 *            workspace's own key, and in the platform ceiling for pool use.
 *
 * Every address it finds enters the queue unverified and goes through Reoon
 * with every other address before anyone is enrolled.
 */
import type { SearchCriteria, SourceCapabilities } from "@shared/prospectSources";
import { allowancePeriod } from "@shared/prospectAllowance";
import { usableEmailOrNull } from "@shared/fieldHygiene";
import type { BudgetPeriod, ProspectRecord, ProspectSource, SourceCredentials, VendorFailure } from "../types";
import { vendorFetch, type VendorFetchOk } from "../vendorHttp";
import { normalizeDomain } from "../../scraper/domain";
import { stripNameCredentials } from "../../enrichment/personName";
import { recordSpend } from "../../spend";

export const ALEADS_API = "https://api.a-leads.co/gateway/v1/search";
export const ALEADS_DOCS = "https://docs.a-leads.co/reference";
/** Every endpoint: 6,000 calls a day. */
export const ALEADS_DAILY_CALLS = 6_000;
/** Tier 4: 100,000 credits a month. */
export const ALEADS_DEFAULT_MONTHLY_CREDITS = 100_000;
const MAX_PAGES_PER_SEARCH = 4;

export const ALEADS_CAPABILITIES: SourceCapabilities = {
  supportedFilters: ["jobTitle", "seniority", "companyDomain", "technology"],
  // Departments and industries are the vendor's "experimental" filters, and a
  // place is matched against a raw address text.
  approximatedFilters: ["department", "industry", "country", "stateProvince", "city"],
  supportsFreePreview: false,
  returnsMaskedPreview: true,
  supportsMobilePhone: false,
  supportsVerification: false,
  maxBatchSize: 100,
  geographicCoverage: [],
};

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});
const str = (v: unknown): string | null => {
  const s = typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "";
  return s ? s : null;
};

export function aleadsErrorCode(json: unknown): string | null {
  const j = obj(json);
  return str(obj(j.error).code) ?? str(j.code) ?? str(j.error) ?? null;
}

/* ─── The day's calls ────────────────────────────────────────────────────── */

const calls = new Map<string, { day: string; n: number }>();
const dayOf = (now: Date) => now.toISOString().slice(0, 10);
const keyId = (apiKey: string) => apiKey.slice(-12);

/** Count one call against the key's day; false once the day's 6,000 are used. */
export function takeAleadsCall(apiKey: string, now: Date = new Date()): boolean {
  const id = keyId(apiKey);
  const day = dayOf(now);
  const cur = calls.get(id);
  const n = cur && cur.day === day ? cur.n : 0;
  if (n >= ALEADS_DAILY_CALLS) return false;
  calls.set(id, { day, n: n + 1 });
  return true;
}

export function aleadsCallsToday(apiKey: string, now: Date = new Date()): number {
  const cur = calls.get(keyId(apiKey));
  return cur && cur.day === dayOf(now) ? cur.n : 0;
}

export function __resetAleadsCallsForTests(): void { calls.clear(); rows.clear(); }

function secondsToUtcMidnight(now: Date): number {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(1, Math.ceil((next - now.getTime()) / 1000));
}

/* ─── Search ─────────────────────────────────────────────────────────────── */

export function buildAdvancedSearchBody(criteria: SearchCriteria, page: number): Json {
  const f: Json = {};
  if (criteria.jobTitles.length) { f.job_title = criteria.jobTitles; f.job_title_match_mode = "smart"; }
  if (criteria.seniorities.length) f.member_management_level = criteria.seniorities;
  if (criteria.departments.length) f.experimental_member_department = criteria.departments;
  if (criteria.industries.length) f.experimental_industries = criteria.industries;
  const places = [...criteria.cities, ...criteria.stateProvinces, ...criteria.countries];
  if (places.length) f.member_location_raw_address = places;
  if (criteria.technologies.length) f.technologies_used = criteria.technologies;
  if (criteria.companyDomains.length) f.bulk_domains = criteria.companyDomains;
  return { advanced_filters: f, current_page: page, search_type: "total" };
}

/**
 * What an email lookup needs, kept from the search row: acquire() is handed
 * ids only. Process-local and short-lived, since a search and its lookups run
 * back to back in one waterfall.
 */
type LookupRow = { firstName: string; lastName: string; website: string | null; documentId: string | null; at: number };
const rows = new Map<string, LookupRow>();
const ROW_TTL_MS = 60 * 60_000;
const MAX_ROWS = 5_000;

function remember(id: string, r: Omit<LookupRow, "at">): void {
  if (rows.size >= MAX_ROWS) {
    const cutoff = Date.now() - ROW_TTL_MS;
    rows.forEach((v, k) => { if (v.at < cutoff) rows.delete(k); });
    if (rows.size >= MAX_ROWS) rows.delete(rows.keys().next().value as string);
  }
  rows.set(id, { ...r, at: Date.now() });
}

export function mapAdvancedRow(rowIn: unknown): ProspectRecord | null {
  const row = obj(rowIn);
  const memberId = str(row.member_id);
  const documentId = str(row.document_id);
  const id = documentId ?? memberId;
  let first = str(row.member_name_first);
  let last = str(row.member_name_last);
  if ((!first || !last) && str(row.member_full_name)) {
    const [f, ...rest] = String(row.member_full_name).trim().split(/\s+/);
    first = first ?? f ?? null;
    last = last ?? (rest.join(" ") || null);
  }
  if (!id || !first) return null;
  const name = stripNameCredentials(`${first} ${last ?? ""}`.trim()) ?? "";
  const [cleanFirst, ...cleanRest] = name.split(/\s+/);
  const website = str(row.website) ?? str(row.domain);
  const url = str(row.member_linkedin_url) ?? (str(row.member_linkedin_username) ? `https://www.linkedin.com/in/${str(row.member_linkedin_username)}` : null);
  const externalId = `aleads:${id}`;
  remember(externalId, { firstName: cleanFirst || first, lastName: cleanRest.join(" ") || last || "", website, documentId });
  return {
    externalId,
    firstName: cleanFirst || first,
    lastName: cleanRest.join(" ") || last || "",
    jobTitle: str(row.job_title),
    seniority: null,
    companyName: str(row.company_name),
    companyDomain: normalizeDomain(str(row.domain) ?? website),
    email: null,
    emailIsMasked: true,
    emailVerifiedAt: null,
    mobilePhone: null,
    businessPhone: null,
    linkedinUrl: url && /linkedin\.com/i.test(url) ? url : null,
    city: null,
    stateProvince: null,
    country: str(row.member_location_country),
    industry: null,
    headcount: str(row.size_range),
    rawSourcePayload: { memberId, documentId, website, phoneAvailable: row.phone_number_available === true },
  };
}

/* ─── Usage (counted in Velocity: no REST credits endpoint) ──────────────── */

function monthlyCredits(c: SourceCredentials): number {
  const n = Number(obj(c.config).monthlyLeadAllowance);
  return Number.isInteger(n) && n > 0 ? n : ALEADS_DEFAULT_MONTHLY_CREDITS;
}

export function aleadsPeriods(c: SourceCredentials, now: Date = new Date()): BudgetPeriod[] {
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return [{ bucket: "leads", granularity: "monthly", periodKey: allowancePeriod(now), unitsLimit: monthlyCredits(c), resetsAt: next }];
}

/* ─── The adapter ────────────────────────────────────────────────────────── */

type Deps = { fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void>; now?: () => Date };

export function createAleadsSource(deps?: Deps): ProspectSource {
  const now = () => deps?.now?.() ?? new Date();
  const call = async <T,>(c: SourceCredentials, endpoint: string, path: string, body: unknown): Promise<VendorFetchOk<T> | VendorFailure> => {
    const apiKey = c.secrets.apiKey ?? "";
    if (!takeAleadsCall(apiKey, now())) {
      return { ok: false, reason: "rate_limited", message: `the day's ${ALEADS_DAILY_CALLS.toLocaleString("en-US")} calls are used`, retryAfterSeconds: secondsToUtcMidnight(now()) };
    }
    return vendorFetch<T>(`${ALEADS_API}${path}`, {
      workspaceId: c.workspaceId, source: "aleads", endpoint, method: "POST",
      headers: { "x-api-key": apiKey }, body,
      timeoutMs: 30_000, attempts: 2, fetchImpl: deps?.fetchImpl, sleep: deps?.sleep,
      errorCode: aleadsErrorCode,
    });
  };
  const spend = (c: SourceCredentials, meter: "searches" | "emails", quantity: number, feature: string) =>
    recordSpend({ workspaceId: c.workspaceId, vendor: "aleads", meter, quantity, keySource: c.origin && c.origin !== "own" ? "shared" : "workspace", feature });

  return {
    slug: "aleads",
    displayName: "A-Leads",
    docsUrl: ALEADS_DOCS,
    credentialMode: "table",
    acquisition: "on_demand",
    writeOnlyKey: true,
    capabilities: () => ALEADS_CAPABILITIES,
    budgetPeriods: ({ now: at, credentials }) => aleadsPeriods(credentials, at),

    async validateCredentials(c) {
      if (!c.secrets.apiKey) return { ok: false, message: "No A-Leads API key", terminal: true };
      // A search that matches nobody: it proves the key and, returning no
      // results, is not charged.
      const res = await call<Json>(c, "advanced_search.check", "/advanced-search", {
        advanced_filters: { job_title: ["velocity key check zq"], job_title_match_mode: "exact" }, current_page: 1, search_type: "total",
      });
      if (!res.ok) {
        const terminal = res.reason === "unauthorized" || res.reason === "insufficient_scope" || res.reason === "plan_required";
        return { ok: false, message: res.message, terminal, transient: !terminal };
      }
      return { ok: true, message: "Key accepted" };
    },

    async search(criteria, c, limit, ctx) {
      const want = Math.max(1, Math.min(limit, ALEADS_CAPABILITIES.maxBatchSize));
      const records: ProspectRecord[] = [];
      let page = Math.max(1, Number(ctx.cursor) || 1);
      let total: number | null = null;
      let searches = 0;
      let more = false;
      for (let i = 0; i < MAX_PAGES_PER_SEARCH && records.length < want; i++, page++) {
        const res = await call<Json>(c, "advanced_search", "/advanced-search", buildAdvancedSearchBody(criteria, page));
        if (!res.ok) {
          if (searches > 0) await spend(c, "searches", searches, ctx.campaignId ? "are.discovery" : "sourceSearch");
          if (records.length > 0) break;
          return res;
        }
        const j = obj(res.json);
        const data = Array.isArray(j.data) ? j.data : [];
        if (data.length > 0) searches++;
        total = Number(obj(j.meta_data).total_count) || total;
        for (const r of data) {
          const rec = mapAdvancedRow(r);
          if (rec && records.length < want) records.push(rec);
        }
        more = data.length > 0 && (total == null || page * data.length < total);
        if (!more) break;
      }
      if (searches > 0) await spend(c, "searches", searches, ctx.campaignId ? "are.discovery" : "sourceSearch");
      return { ok: true, records, nextCursor: more ? String(page + 1) : null, totalAvailable: total, alreadyCharged: false, unitsSpent: searches };
    },

    async acquire(externalIds, c, ctx) {
      const out: ProspectRecord[] = [];
      const failed: string[] = [];
      let units = 0;
      let note: string | undefined;
      let hold: { message: string; retryAfterSeconds?: number } | undefined;
      for (const id of externalIds) {
        const r = rows.get(id);
        // No website, no lookup: A-Leads finds work emails by name and website only.
        if (!r || !r.website || !r.lastName) { failed.push(id); continue; }
        const res = await call<Json>(c, "find_email", "/find-email", {
          data: { first_name: r.firstName, last_name: r.lastName, website: r.website, ...(r.documentId ? { document_id: r.documentId } : {}) },
        });
        if (!res.ok) {
          if (res.reason === "rate_limited") {
            // Nothing delivered: a failure, which the circuit breaker counts.
            if (out.length === 0) return { ...res, unitsSpent: units };
            hold = { message: res.message, retryAfterSeconds: res.retryAfterSeconds };
            failed.push(...externalIds.slice(externalIds.indexOf(id)));
            break;
          }
          if (out.length === 0 && (res.reason === "unauthorized" || res.reason === "insufficient_scope" || res.reason === "plan_required" || res.reason === "budget_exhausted")) {
            return { ...res, unitsSpent: units };
          }
          failed.push(id);
          note = res.message;
          continue;
        }
        const resp = obj(obj(obj(res.json).data).response);
        const email = usableEmailOrNull(str(resp.email));
        const ok = (str(resp.result) ?? "").toLowerCase() === "ok";
        if (!email || !ok) { failed.push(id); continue; } // a miss costs nothing
        units++;
        out.push({
          externalId: id, firstName: r.firstName, lastName: r.lastName,
          jobTitle: null, seniority: null, companyName: null, companyDomain: normalizeDomain(r.website),
          email, emailIsMasked: false, emailVerifiedAt: null,
          mobilePhone: null, businessPhone: null, linkedinUrl: null,
          city: null, stateProvince: null, country: null, industry: null, headcount: null,
          rawSourcePayload: { quality: str(resp.quality), result: str(resp.result), catchAllStatus: str(resp.catch_all_status) },
        });
      }
      if (units > 0) await spend(c, "emails", units, ctx.campaignId ? "are.discovery" : "sourceSearch");
      return { ok: true, records: out, unitsSpent: units, failedExternalIds: failed, ...(note ? { note } : {}), ...(hold ? { hold } : {}) };
    },

    async remainingBudget() {
      // No REST endpoint reports credits; the ledger holds them.
      return [];
    },
  };
}
