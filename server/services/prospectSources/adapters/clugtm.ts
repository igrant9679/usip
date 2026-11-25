/**
 * CluGTM (formerly Cleanlist AI) — prospect-source adapter (owner go-ahead
 * 2026-11-25; AppSumo Tier 5 on the platform owner's account).
 *
 * Read from the vendor's documentation only (https://docs.clugtm.com/
 * api-reference-v2/introduction, read 2026-11-25). No live call has been made:
 * the fixtures in clugtmSource.test.ts are shaped like the documented
 * responses, so field names must be checked against the live API once the
 * owner adds the key.
 *
 *   SEARCH   POST /people/find. Free in credits (`credits_charged: 0`), at most
 *            25 rows a call, cursor-paged (`cursor: null` = the end). Titles
 *            match EXACTLY and case-sensitively, so each title goes as typed
 *            and in Title Case. No emails or phones in search, so this source
 *            hands over people, and emails come from its own enrichment.
 *            The AppSumo deal page says each search page counts against the
 *            monthly RECORDS, while the API says search is free: until that is
 *            measured, the preview is treated as billed (no overfetch, it runs
 *            only where chosen) and its rows are counted in Velocity.
 *   ENRICH   asynchronous, so it cannot sit inside a search: rows this source
 *            queues are enriched by the CLUGTM_ENRICH_JOB in the persisted job
 *            runner (services/jobs/runner): create a lead list once, POST
 *            /enrichment/person with enrichment_type "partial" (email only, one
 *            credit, refunded when nothing is found), then poll GET
 *            /enrichment/status/{workflow_id} from later slices. Never "full"
 *            or "phone_only".
 *   USAGE    no endpoint reports records remaining (GET /credits/balance
 *            reports credits only), so records are counted in Velocity's
 *            budget ledger for a workspace's own key, and in the platform
 *            ceiling for pool use.
 *   LIMITS   60 requests a minute per organization, 30 per key; 429 with
 *            Retry-After.
 *
 * Every email it finds goes through Reoon before it lands on a queue row
 * (invalid is dropped), and the engine's own checks still run before anyone
 * is enrolled.
 */
import { and, eq, isNull, or } from "drizzle-orm";
import type { SearchCriteria, SourceCapabilities } from "@shared/prospectSources";
import { allowancePeriod } from "@shared/prospectAllowance";
import { usableEmailOrNull } from "@shared/fieldHygiene";
import type { BudgetPeriod, ProspectRecord, ProspectSource, SourceCredentials, VendorFailure } from "../types";
import { vendorFetch, type VendorFetchOk } from "../vendorHttp";
import { recordSpend as recordLedgerSpend } from "../ledger";
import { normalizeDomain } from "../../scraper/domain";
import { stripNameCredentials } from "../../enrichment/personName";
import { recordSpend } from "../../spend";
import { bulkJobs, prospectQueue } from "../../../../drizzle/schema";
import { getDb } from "../../../db";
import { enqueueJob, registerJobKind, type BulkJob, type StepResult } from "../../jobs/runner";

export const CLUGTM_API = "https://api.cleanlist.ai/api/v2";
export const CLUGTM_DOCS = "https://docs.clugtm.com/api-reference-v2/introduction";
/** The vendor's page size: at most 25 rows come back per call, whatever `limit` says. */
export const CLUGTM_PAGE = 25;
const MAX_PAGES_PER_SEARCH = 4;
/** Tier 5: 25,000 records a month (also 10,000 a week and 5,000 per five hours). */
export const CLUGTM_DEFAULT_MONTHLY_RECORDS = 25_000;

export const CLUGTM_CAPABILITIES: SourceCapabilities = {
  supportedFilters: ["jobTitle", "seniority", "department", "industry", "headcountRange", "country", "stateProvince", "city"],
  approximatedFilters: [],
  // Billed until measured otherwise (see the header).
  supportsFreePreview: false,
  returnsMaskedPreview: true,
  supportsMobilePhone: false,
  supportsVerification: false,
  maxBatchSize: CLUGTM_PAGE * MAX_PAGES_PER_SEARCH,
  geographicCoverage: [],
};

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});
const str = (v: unknown): string | null => {
  const s = typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "";
  return s ? s : null;
};

/** The vendor's error code, from `{ error: { code } }` or `{ code }`. */
export function clugtmErrorCode(json: unknown): string | null {
  const j = obj(json);
  return str(obj(j.error).code) ?? str(j.code) ?? null;
}

/* ─── Search ─────────────────────────────────────────────────────────────── */

const HEADCOUNT_BUCKETS: Array<[number, number, string]> = [
  [1, 10, "1-10"], [11, 50, "11-50"], [51, 200, "51-200"], [201, 500, "201-500"],
  [501, 1000, "501-1000"], [1001, 5000, "1001-5000"], [5001, 10000, "5001-10000"], [10001, Number.MAX_SAFE_INTEGER, "10001+"],
];

/** The vendor's headcount buckets that overlap a range. */
export function headcountBuckets(range: SearchCriteria["headcountRange"]): string[] {
  if (!range || (range.min == null && range.max == null)) return [];
  const lo = range.min ?? 1;
  const hi = range.max ?? Number.MAX_SAFE_INTEGER;
  return HEADCOUNT_BUCKETS.filter(([a, b]) => b >= lo && a <= hi).map(([, , label]) => label);
}

const titleCase = (s: string) => s.toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase());

/** Titles match exactly and case-sensitively: send each as typed and in Title Case. */
export function titleVariants(titles: string[]): string[] {
  const out: string[] = [];
  for (const t of titles) {
    const v = t.trim();
    if (!v) continue;
    for (const x of [v, titleCase(v)]) if (!out.includes(x)) out.push(x);
  }
  return out;
}

export function buildFindBody(criteria: SearchCriteria, limit: number, cursor: string | null): Json {
  const filters: Json = {};
  const titles = titleVariants(criteria.jobTitles);
  if (titles.length) filters.titles = titles;
  if (criteria.seniorities.length) filters.seniority = criteria.seniorities;
  if (criteria.departments.length) filters.departments = criteria.departments;
  if (criteria.industries.length) filters.company_industries = criteria.industries;
  const sizes = headcountBuckets(criteria.headcountRange);
  if (sizes.length) filters.company_headcount = sizes;
  if (criteria.countries.length) filters.location_country = criteria.countries;
  if (criteria.stateProvinces.length) filters.location_state = criteria.stateProvinces;
  if (criteria.cities.length) filters.location_city = criteria.cities;
  return { filters, limit: Math.max(1, Math.min(CLUGTM_PAGE, limit)), ...(cursor ? { cursor } : {}) };
}

/** "Austin, Texas, United States" → its parts, when it has three. */
function placeOf(location: string | null): { city: string | null; state: string | null; country: string | null } {
  const parts = (location ?? "").split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length >= 3) return { city: parts[0], state: parts[1], country: parts[parts.length - 1] };
  if (parts.length === 2) return { city: null, state: parts[0], country: parts[1] };
  return { city: null, state: null, country: parts[0] ?? null };
}

export function mapFindRow(rowIn: unknown): ProspectRecord | null {
  const row = obj(rowIn);
  const id = str(row.lead_id);
  let first = str(row.first_name);
  let last = str(row.last_name);
  if ((!first || !last) && str(row.full_name)) {
    const [f, ...rest] = String(row.full_name).trim().split(/\s+/);
    first = first ?? f ?? null;
    last = last ?? (rest.join(" ") || null);
  }
  if (!id || !first) return null;
  const name = stripNameCredentials(`${first} ${last ?? ""}`.trim()) ?? "";
  const [cleanFirst, ...cleanRest] = name.split(/\s+/);
  const url = str(row.linkedin_url);
  const place = placeOf(str(row.location));
  return {
    externalId: `clugtm:${id}`,
    firstName: cleanFirst || first,
    lastName: cleanRest.join(" ") || last || "",
    jobTitle: str(row.title),
    seniority: str(row.seniority),
    companyName: str(row.company),
    companyDomain: normalizeDomain(str(row.domain)),
    email: null,
    emailIsMasked: true,
    emailVerifiedAt: null,
    mobilePhone: null,
    businessPhone: null,
    linkedinUrl: url && /linkedin\.com/i.test(url) ? url : null,
    city: place.city,
    stateProvince: place.state,
    country: place.country,
    industry: null,
    headcount: null,
    rawSourcePayload: { leadId: id, location: str(row.location) },
  };
}

/* ─── Usage (counted in Velocity: no endpoint reports records) ───────────── */

function monthlyRecords(c: SourceCredentials): number {
  const n = Number(obj(c.config).monthlyLeadAllowance);
  return Number.isInteger(n) && n > 0 ? n : CLUGTM_DEFAULT_MONTHLY_RECORDS;
}

export function clugtmPeriods(c: SourceCredentials, now: Date = new Date()): BudgetPeriod[] {
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return [{ bucket: "leads", granularity: "monthly", periodKey: allowancePeriod(now), unitsLimit: monthlyRecords(c), resetsAt: next }];
}

/** Rows a search returned, on a workspace's own key: pool use is held against the platform ceiling instead. */
async function countRecords(c: SourceCredentials, rows: number, meter: "search_records" | "enrichments", feature: string): Promise<void> {
  if (rows <= 0) return;
  if (!c.origin || c.origin === "own") await recordLedgerSpend(c.workspaceId, "clugtm", meter === "enrichments" ? "lookups" : "leads", rows, clugtmPeriods(c));
  await recordSpend({ workspaceId: c.workspaceId, vendor: "clugtm", meter, quantity: rows, keySource: c.origin && c.origin !== "own" ? "shared" : "workspace", feature });
}

/* ─── The adapter ────────────────────────────────────────────────────────── */

type Deps = { fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void> };

export function clugtmCall<T>(deps: Deps | undefined, c: SourceCredentials, endpoint: string, method: "GET" | "POST", path: string, body?: unknown): Promise<VendorFetchOk<T> | VendorFailure> {
  return vendorFetch<T>(`${CLUGTM_API}${path}`, {
    workspaceId: c.workspaceId, source: "clugtm", endpoint, method,
    headers: { Authorization: `Bearer ${c.secrets.apiKey ?? ""}` },
    ...(body !== undefined ? { body } : {}),
    timeoutMs: 30_000, attempts: 2, fetchImpl: deps?.fetchImpl, sleep: deps?.sleep,
    errorCode: clugtmErrorCode,
  });
}

export function createClugtmSource(deps?: Deps): ProspectSource {
  return {
    slug: "clugtm",
    displayName: "CluGTM",
    docsUrl: CLUGTM_DOCS,
    credentialMode: "table",
    // Search hands over people; emails come from the asynchronous enrichment job.
    acquisition: "none",
    writeOnlyKey: true,
    capabilities: () => CLUGTM_CAPABILITIES,
    budgetPeriods: ({ now, credentials }) => clugtmPeriods(credentials, now),

    async validateCredentials(c) {
      if (!c.secrets.apiKey) return { ok: false, message: "No CluGTM API key", terminal: true };
      const res = await clugtmCall<Json>(deps, c, "whoami", "GET", "/whoami");
      if (!res.ok) {
        const terminal = res.reason === "unauthorized" || res.reason === "insufficient_scope";
        return { ok: false, message: res.message, terminal, transient: !terminal };
      }
      const j = obj(res.json);
      const scopes = Array.isArray(j.scopes) ? j.scopes.map(String) : [];
      const tier = str(j.tier) ?? str(obj(j.data).tier);
      return { ok: true, message: `Key accepted${tier ? ` — ${tier}` : ""}${scopes.length ? ` — scopes: ${scopes.join(", ")}` : ""}`, discovered: { scopes, tier } };
    },

    async search(criteria, c, limit, ctx) {
      const want = Math.max(1, Math.min(limit, CLUGTM_CAPABILITIES.maxBatchSize));
      const records: ProspectRecord[] = [];
      let cursor = ctx.cursor ?? null;
      let total: number | null = null;
      let rowsSeen = 0;
      for (let page = 0; page < MAX_PAGES_PER_SEARCH && records.length < want; page++) {
        const res = await clugtmCall<Json>(deps, c, "people.find", "POST", "/people/find", buildFindBody(criteria, want - records.length, cursor));
        if (!res.ok) {
          await countRecords(c, rowsSeen, "search_records", ctx.campaignId ? "are.discovery" : "sourceSearch");
          if (records.length > 0) break; // what came back still counts
          return res;
        }
        const j = obj(res.json);
        const rows = Array.isArray(j.results) ? j.results : [];
        rowsSeen += rows.length;
        total = typeof j.total === "number" ? j.total : total;
        for (const r of rows) {
          const rec = mapFindRow(r);
          if (rec && records.length < want) records.push(rec);
        }
        cursor = str(j.cursor);
        if (!cursor || rows.length === 0) break;
      }
      await countRecords(c, rowsSeen, "search_records", ctx.campaignId ? "are.discovery" : "sourceSearch");
      return {
        ok: true, records, nextCursor: cursor, totalAvailable: total,
        alreadyCharged: false, unitsSpent: rowsSeen,
        note: records.length === 0 ? "no rows matched (titles match exactly; try the title as people write it)" : undefined,
      };
    },

    async acquire(externalIds) {
      // Never inside a search: enrichment is asynchronous (CLUGTM_ENRICH_JOB).
      return { ok: true, records: [], unitsSpent: 0, failedExternalIds: externalIds };
    },

    async remainingBudget() {
      // Records remaining are not reported by the vendor; the ledger holds them.
      return [];
    },
  };
}

/* ─── Asynchronous enrichment, in the persisted job runner ───────────────── */

export const CLUGTM_ENRICH_JOB = "clugtm.enrich";
/** Rows taken into one job pass, and polls per slice (30 requests a minute per key). */
const ROWS_PER_PASS = 25;
const POLLS_PER_SLICE = 10;
/** Between polling passes. */
export const CLUGTM_POLL_EVERY_MS = 15_000;
/** A workflow still unfinished after this many polls is given up. */
const MAX_POLLS = 40;

/** Written on a queue row CluGTM could not find an address for, so no later job asks again. */
export const MISS_PREFIX = "clugtm: ";

/** Note a miss on the row (only where no other enrichment note is there). */
async function noteMiss(workspaceId: number, queueId: number, note: string): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db.update(prospectQueue).set({ enrichmentError: `${MISS_PREFIX}${note}`.slice(0, 500) } as never)
    .where(and(eq(prospectQueue.id, queueId), eq(prospectQueue.workspaceId, workspaceId), isNull(prospectQueue.enrichmentError)));
}

export type ClugtmItem = { queueId: number; workflowId: string | null; polls: number; state: "new" | "pending" | "done" | "missed" | "failed"; note?: string };
export type ClugtmJobPayload = { items?: ClugtmItem[]; leadListId?: string | null; nextPollAt?: number };

let jobDeps: Deps & { now?: () => number } = {};
/** Test seam: the job's HTTP, sleep and clock. */
export function __setClugtmJobDepsForTests(d: typeof jobDeps): void { jobDeps = d; }

/** Start (or keep) the workspace's one enrichment job after this source queued people. */
export async function enqueueClugtmEnrichment(workspaceId: number): Promise<void> {
  try {
    await enqueueJob({ workspaceId, userId: null, kind: CLUGTM_ENRICH_JOB, payload: { items: [] } satisfies ClugtmJobPayload, total: 0, oneAtATime: true });
  } catch (e) {
    console.error(`[clugtm] could not queue enrichment for workspace ${workspaceId}:`, (e as Error)?.message);
  }
}

async function savePayload(jobId: number, payload: ClugtmJobPayload): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db.update(bulkJobs).set({ payload: payload as never }).where(eq(bulkJobs.id, jobId));
}

/** The identifier CluGTM matches on: a LinkedIn URL, else name and company domain or name. */
export function enrichIdentifier(row: { firstName: string | null; lastName: string | null; linkedinUrl: string | null; companyName: string | null; companyDomain: string | null }): Json | null {
  if (row.linkedinUrl && /linkedin\.com\/in\//i.test(row.linkedinUrl)) return { linkedin_url: row.linkedinUrl };
  if (row.firstName && row.lastName && (row.companyDomain || row.companyName)) {
    return { first_name: row.firstName, last_name: row.lastName, ...(row.companyDomain ? { domain: row.companyDomain } : { company_name: row.companyName }) };
  }
  return null;
}

/** Reoon's word on an address, when the workspace has a key: invalid is dropped, anything else kept. */
async function passesReoon(workspaceId: number, email: string): Promise<boolean> {
  try {
    const { getReoonKey, reoonVerifySingle, reoonStatusToUsip } = await import("../../reoon");
    const key = await getReoonKey(workspaceId);
    if (!key) return true; // the engine's final checks still run before enrollment
    const v = await reoonVerifySingle(email, key, "power", { workspaceId, feature: "clugtm.enrich" });
    return reoonStatusToUsip(v.status) !== "invalid";
  } catch {
    return true;
  }
}

export async function stepClugtmEnrichment(job: BulkJob, payloadIn: ClugtmJobPayload, budgetMs: number): Promise<StepResult> {
  const now = jobDeps.now ?? Date.now;
  const until = now() + budgetMs;
  const db = await getDb();
  if (!db) return { cursor: job.resumeFrom, done: 0, failures: [], finished: false, message: "database unavailable" };
  const { getSource } = await import("../registry");
  const { loadCredentials } = await import("../credentials");
  const c = await loadCredentials(job.workspaceId, getSource("clugtm"));
  if (!c) return { cursor: job.resumeFrom, done: 0, failures: [{ id: "clugtm", error: "no key for this source" }], finished: true, message: "No key for this source" };
  const payload: ClugtmJobPayload = { items: [...(payloadIn.items ?? [])], leadListId: payloadIn.leadListId ?? null, nextPollAt: payloadIn.nextPollAt ?? 0 };
  const items = payload.items!;
  const failures: StepResult["failures"] = [];
  let done = 0;

  // 1. Take in this source's staged rows that have no address yet.
  const known = new Set(items.map((i) => i.queueId));
  const open = items.filter((i) => i.state === "new" || i.state === "pending").length;
  if (open < ROWS_PER_PASS) {
    const rows = await db.select({ id: prospectQueue.id, note: prospectQueue.enrichmentError }).from(prospectQueue).where(and(
      eq(prospectQueue.workspaceId, job.workspaceId),
      eq(prospectQueue.sourceType, "clugtm" as never),
      eq(prospectQueue.sequenceStatus, "sourcing"),
      or(isNull(prospectQueue.email), eq(prospectQueue.email, "")),
    )).limit(ROWS_PER_PASS * 4);
    for (const r of rows) {
      // Asked before and found nothing: not paid for again.
      if (String(r.note ?? "").startsWith(MISS_PREFIX)) continue;
      if (items.filter((i) => i.state === "new" || i.state === "pending").length >= ROWS_PER_PASS) break;
      if (!known.has(r.id)) items.push({ queueId: r.id, workflowId: null, polls: 0, state: "new" });
    }
  }

  // 2. One lead list, kept for the job's life.
  if (items.some((i) => i.state === "new") && !payload.leadListId) {
    const res = await clugtmCall<Json>(jobDeps, c, "lead_lists.create", "POST", "/lead-lists", { name: "Velocity enrichment" });
    if (!res.ok) {
      return { cursor: job.resumeFrom, done: 0, failures: [{ id: "lead-list", error: res.message }], finished: res.reason === "unauthorized" || res.reason === "insufficient_scope", message: `Could not create a lead list: ${res.message}` };
    }
    const j = obj(res.json);
    payload.leadListId = str(j.id) ?? str(j.lead_list_id) ?? str(obj(j.data).id);
    if (!payload.leadListId) return { cursor: job.resumeFrom, done: 0, failures: [{ id: "lead-list", error: "no list id in the answer" }], finished: true, message: "No lead list id" };
    await savePayload(job.id, payload);
  }

  // 3. Submit each new row, counted against the allowance like every email lookup.
  const { holdAllowance } = await import("../../prospectAllowance");
  for (const item of items) {
    if (item.state !== "new" || now() >= until) continue;
    const [row] = await db.select({
      firstName: prospectQueue.firstName, lastName: prospectQueue.lastName, linkedinUrl: prospectQueue.linkedinUrl,
      companyName: prospectQueue.companyName, companyDomain: prospectQueue.companyDomain, email: prospectQueue.email,
    }).from(prospectQueue).where(and(eq(prospectQueue.id, item.queueId), eq(prospectQueue.workspaceId, job.workspaceId))).limit(1);
    if (!row || row.email) { item.state = "done"; item.note = row ? "already has an address" : "row gone"; continue; }
    const ident = enrichIdentifier(row);
    if (!ident) { item.state = "failed"; item.note = "no LinkedIn URL, and no name with a company"; failures.push({ id: item.queueId, error: item.note }); await noteMiss(job.workspaceId, item.queueId, item.note); continue; }
    const person = { linkedinUrl: row.linkedinUrl, firstName: row.firstName, lastName: row.lastName, companyName: row.companyName };
    const hold = await holdAllowance(job.workspaceId, "clugtm", 1, { apiKey: c.secrets.apiKey, person });
    if (hold.granted <= 0) { item.state = "failed"; item.note = hold.reason ?? "no allowance left"; failures.push({ id: item.queueId, error: item.note }); continue; }
    const res = await clugtmCall<Json>(jobDeps, c, "enrichment.person", "POST", "/enrichment/person", {
      lead_list_id: payload.leadListId, enrichment_type: "partial", ...ident,
    });
    if (!res.ok) {
      await hold.settle(0);
      if (res.reason === "rate_limited") break; // the next slice tries again
      item.state = "failed"; item.note = res.message; failures.push({ id: item.queueId, error: res.message });
      continue;
    }
    const j = obj(res.json);
    item.workflowId = str(j.workflow_id) ?? str(obj(j.data).workflow_id);
    if (!item.workflowId) { await hold.settle(0); item.state = "failed"; item.note = "no workflow id"; failures.push({ id: item.queueId, error: item.note }); continue; }
    item.state = "pending";
    // The person is counted once, ever; a lookup for someone already counted is free.
    await hold.settle([person]);
    await savePayload(job.id, payload);
  }

  // 4. Poll, paced: at most POLLS_PER_SLICE a slice, a pass every CLUGTM_POLL_EVERY_MS.
  const waitMs = (payload.nextPollAt ?? 0) - now();
  if (items.some((i) => i.state === "pending") && waitMs > 0 && now() + waitMs < until) await (jobDeps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(waitMs);
  if (items.some((i) => i.state === "pending") && now() >= (payload.nextPollAt ?? 0)) {
    let polled = 0;
    for (const item of items) {
      if (item.state !== "pending" || polled >= POLLS_PER_SLICE || now() >= until) continue;
      polled++;
      item.polls++;
      const res = await clugtmCall<Json>(jobDeps, c, "enrichment.status", "GET", `/enrichment/status/${encodeURIComponent(item.workflowId!)}`);
      if (!res.ok) {
        if (res.reason === "rate_limited") break;
        if (item.polls >= MAX_POLLS) { item.state = "failed"; item.note = res.message; failures.push({ id: item.queueId, error: res.message }); }
        continue;
      }
      const j = obj(res.json);
      const status = (str(j.status) ?? str(obj(j.data).status) ?? "").toLowerCase();
      if (["pending", "queued", "running", "processing", "in_progress"].includes(status) || !status) {
        if (item.polls >= MAX_POLLS) { item.state = "failed"; item.note = "still unfinished"; failures.push({ id: item.queueId, error: item.note }); }
        continue;
      }
      if (["failed", "error", "cancelled", "canceled"].includes(status)) { item.state = "missed"; item.note = status; await noteMiss(job.workspaceId, item.queueId, `lookup ${status}`); continue; }
      const result = obj(Array.isArray(j.results) ? j.results[0] : (j.result ?? obj(j.data).result ?? j.data));
      const email = usableEmailOrNull(str(result.email));
      const emailStatus = (str(result.email_status) ?? "").toLowerCase();
      if (!email || (emailStatus && emailStatus !== "valid")) { item.state = "missed"; item.note = email ? `email_status ${emailStatus}` : "no address found"; await noteMiss(job.workspaceId, item.queueId, item.note); continue; }
      await countRecords(c, 1, "enrichments", "are.enrichment");
      if (!(await passesReoon(job.workspaceId, email))) { item.state = "missed"; item.note = "Reoon: invalid"; await noteMiss(job.workspaceId, item.queueId, "address failed verification"); continue; }
      // Land the address; the engine's admit step promotes the row from 'sourcing'.
      await db.update(prospectQueue).set({ email, enrichedAt: new Date() } as never).where(and(
        eq(prospectQueue.id, item.queueId), eq(prospectQueue.workspaceId, job.workspaceId),
        or(isNull(prospectQueue.email), eq(prospectQueue.email, "")),
      ));
      item.state = "done";
      done++;
    }
    payload.nextPollAt = now() + CLUGTM_POLL_EVERY_MS;
  }

  // Keep the payload small: finished items older than this pass are dropped from it.
  payload.items = items.filter((i) => i.state === "new" || i.state === "pending").concat(items.filter((i) => i.state !== "new" && i.state !== "pending").slice(-50));
  await savePayload(job.id, payload);
  const pending = payload.items.filter((i) => i.state === "new" || i.state === "pending").length;
  return {
    cursor: job.resumeFrom + done,
    done,
    failures,
    finished: pending === 0,
    message: pending === 0 ? "Every queued person was looked up" : `${pending} lookup${pending === 1 ? "" : "s"} still running`,
  };
}

registerJobKind<ClugtmJobPayload>(CLUGTM_ENRICH_JOB, { step: stepClugtmEnrichment });
