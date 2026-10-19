/**
 * WarmySender adapter — leads database (MCP) + email verification (REST).
 *
 * Verified 2026-09-14 against https://warmysender.com/api/v1/openapi.json and
 * the public docs: the REST API (35 paths) has NO leads endpoints. The leads
 * database is reachable ONLY through their MCP server —
 * POST https://warmysender.com/mcp, MCP Streamable HTTP (JSON-RPC 2.0) with
 * the same `ws_…` bearer key. So this adapter speaks JSON-RPC for leads and
 * plain REST for verification, and the spec's "use REST not MCP" instruction
 * is satisfied as far as the vendor makes possible.
 *
 * Billing model (docs): search_leads is FREE and returns masked emails;
 * save_leads / export_leads spend one unit per NEW record; re-acquiring a
 * held record is free; records without an email are never charged. Plan
 * allowance resets on the BILLING ANNIVERSARY and is paced at ≈ monthly/30
 * per day; purchased lead credits never expire and skip the daily pace.
 * The vendor exposes NO endpoint that reports the remaining LEAD allowance
 * (only verification has one) — the ledger tracks leads blind and learns
 * from refusals.
 *
 * Tool parameter names are only visible through `tools/list` with a real
 * key. validateCredentials() captures the search_leads / export_leads input
 * schemas into the credential's config; the argument builder reads them
 * (tolerant candidate-name lookup) and falls back to the documented filter
 * set. The manifest upgrades JobTitle from "approximated" to "supported"
 * only when a captured schema proves a native title parameter exists —
 * the spec's blocking question, answered mechanically at connection time
 * rather than by assumption.
 */
import type {
  AcquisitionResult,
  BudgetPeriod,
  BudgetSnapshot,
  CredentialValidationResult,
  ProspectRecord,
  ProspectSource,
  SearchContext,
  SourceCredentials,
  VendorFailure,
  VendorResult,
} from "../types";
import type { SearchCriteria, SourceCapabilities } from "@shared/prospectSources";
import { vendorFetch, classifyHttpFailure } from "../vendorHttp";
import { normalizeDomain } from "../../scraper/domain";
import { stripNameCredentials } from "../../enrichment/personName";
import { canonicalText } from "@shared/canonicalText";

/** JSON key comparison: one canonical rule (@shared/canonicalText), spaces dropped so first_name ≡ firstName. */
function keyNorm(s: string): string {
  return canonicalText(s).replace(/ /g, "");
}

export const WARMYSENDER_REST = "https://warmysender.com/api/v1";
export const WARMYSENDER_MCP = "https://warmysender.com/mcp";
export const WARMYSENDER_DOCS = "https://warmysender.com/documentation";

/** Plan allowances from the pricing page (monthly leads / monthly verifications). */
export const WARMYSENDER_PLAN_ALLOWANCES: Record<string, { leads: number; verification: number }> = {
  pro: { leads: 2000, verification: 600 },
  business: { leads: 5000, verification: 2500 },
  enterprise: { leads: 30000, verification: 10000 },
  ultimate: { leads: 60000, verification: 20000 },
};

/* ─── Config the credential row carries (non-secret) ───────────────────── */
export interface WarmySenderConfig {
  /** Day-of-month the subscription renews (1–28). Unknown → calendar month. */
  billingAnniversaryDay?: number;
  /** Monthly plan leads; defaults from the tier reported at validation. */
  monthlyLeadAllowance?: number;
  /** Purchased, non-expiring lead credits the user has told us about. */
  leadCreditBalance?: number;
  /** Discovered at validation. */
  scopes?: string[];
  tier?: string;
  toolSchemas?: Record<string, unknown>;
  /** The lead tools' own descriptions and output schemas, when tools/list gives them. */
  toolOutputSchemas?: Record<string, unknown>;
  toolDescriptions?: Record<string, string>;
  /** Numeric lead/credit fields get_workspace_info reported at the last validation. */
  workspaceLeadCounters?: Record<string, number>;
  toolNames?: string[];
  /** Keys of one masked search row (never values) — for field-mapping diagnosis. */
  sampleRowKeys?: string[];
}

function cfg(c: SourceCredentials): WarmySenderConfig {
  return (c.config ?? {}) as WarmySenderConfig;
}

/* ─── JSON-RPC over MCP Streamable HTTP ─────────────────────────────────── */

type JsonRpcResult = { ok: true; result: unknown } | VendorFailure;

/** In-process MCP session cache — one per key hash, refreshed on expiry. */
const sessions = new Map<string, { id: string | null; at: number }>();
const SESSION_TTL_MS = 25 * 60 * 1000;

function keyFingerprint(apiKey: string): string {
  // Never the key itself as a map key in memory dumps: a short hash suffices.
  let h = 0;
  for (let i = 0; i < apiKey.length; i++) h = (h * 31 + apiKey.charCodeAt(i)) | 0;
  return `${apiKey.length}:${h}`;
}

/** Parse an MCP HTTP response body which may be JSON or an SSE stream. */
export function parseMcpBody(text: string, contentType: string | null): unknown {
  const ct = (contentType ?? "").toLowerCase();
  if (ct.indexOf("text/event-stream") !== -1 || /^\s*(event|data):/m.test(text)) {
    const lines = text.split(/\r?\n/);
    let last: unknown = null;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.indexOf("data:") === 0) {
        const payload = line.slice(5).trim();
        if (!payload) continue;
        try {
          const j = JSON.parse(payload);
          if (j && typeof j === "object" && ("result" in j || "error" in j)) last = j;
        } catch { /* keep looking */ }
      }
    }
    return last;
  }
  try { return JSON.parse(text); } catch { return null; }
}

async function mcpCall(
  c: SourceCredentials,
  method: string,
  params: Record<string, unknown> | undefined,
  endpointLabel: string,
  opts?: { fetchImpl?: typeof fetch; retryInit?: boolean },
): Promise<JsonRpcResult> {
  const apiKey = c.secrets.apiKey ?? "";
  if (!apiKey) return { ok: false, reason: "no_credentials", message: "No WarmySender API key" };
  const f = opts?.fetchImpl ?? fetch;
  const fp = keyFingerprint(apiKey);
  let session = sessions.get(fp);
  if (!session || Date.now() - session.at > SESSION_TTL_MS) {
    const init = await mcpRaw(f, apiKey, null, {
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "velocity", version: "1" } },
    }, c.workspaceId, "mcp.initialize");
    if (!init.ok) return init;
    session = { id: init.sessionId, at: Date.now() };
    sessions.set(fp, session);
    // The initialized notification has no id and expects no body.
    await mcpRaw(f, apiKey, session.id, { jsonrpc: "2.0", method: "notifications/initialized" }, c.workspaceId, "mcp.initialized").catch(() => null);
  }
  const res = await mcpRaw(f, apiKey, session.id, { jsonrpc: "2.0", id: Date.now() % 1e9, method, params: params ?? {} }, c.workspaceId, endpointLabel);
  if (!res.ok && res.status === 404 && opts?.retryInit !== false) {
    // A stale session id answers 404 per the MCP spec — re-initialize once.
    sessions.delete(fp);
    return mcpCall(c, method, params, endpointLabel, { ...opts, retryInit: false });
  }
  return res;
}

async function mcpRaw(
  f: typeof fetch,
  apiKey: string,
  sessionId: string | null,
  body: Record<string, unknown>,
  workspaceId: number,
  endpoint: string,
): Promise<({ ok: true; result: unknown; sessionId: string | null }) | VendorFailure> {
  const res = await vendorFetch<unknown>(WARMYSENDER_MCP, {
    workspaceId, source: "warmysender", endpoint, method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json, text/event-stream",
      ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
    },
    body, timeoutMs: 30_000, attempts: 3, fetchImpl: f,
    errorCode: (j) => mcpErrorCode(j),
    retryAfter: (j) => mcpRetryAfter(j),
  });
  if (!res.ok) return res;
  const parsed = res.json && typeof res.json === "object" && "raw" in (res.json as Record<string, unknown>)
    ? parseMcpBody(String((res.json as Record<string, unknown>).raw), res.headers.get("content-type"))
    : res.json;
  const sid = res.headers.get("mcp-session-id");
  if (!parsed || typeof parsed !== "object") {
    // Notifications answer 202 with no body — that is success.
    return { ok: true, result: null, sessionId: sid };
  }
  const j = parsed as Record<string, unknown>;
  if (j.error && typeof j.error === "object") {
    const err = j.error as Record<string, unknown>;
    const code = String(err.code ?? "");
    const msg = String(err.message ?? "MCP error");
    const data = (err.data && typeof err.data === "object" ? err.data : {}) as Record<string, unknown>;
    const token = String(data.code ?? data.error ?? "").toLowerCase();
    const reason =
      token === "insufficient_scope" || code === "-32001" ? "insufficient_scope"
      : code === "-32004" || /api key/i.test(msg) ? "unauthorized"
      : token === "rate_limited" || /rate limit/i.test(msg) ? "rate_limited"
      : token === "plan_upgrade_required" || /upgrade/i.test(msg) ? "plan_required"
      : token === "allowance_exhausted" || /allowance|credits? (left|remaining)|exhausted/i.test(msg) ? "budget_exhausted"
      : code === "-32602" ? "invalid_params"
      : "http";
    const ra = typeof data.retry_after_seconds === "number" ? data.retry_after_seconds : undefined;
    return { ok: false, reason, message: `${code} ${msg}`.trim(), ...(ra != null ? { retryAfterSeconds: ra } : {}) };
  }
  return { ok: true, result: j.result ?? null, sessionId: sid };
}

function mcpErrorCode(j: unknown): string | null {
  if (!j || typeof j !== "object") return null;
  const e = (j as Record<string, unknown>).error;
  if (e && typeof e === "object") {
    const d = (e as Record<string, unknown>).data;
    if (d && typeof d === "object" && typeof (d as Record<string, unknown>).code === "string") return (d as Record<string, unknown>).code as string;
    if (typeof (e as Record<string, unknown>).code === "number") return String((e as Record<string, unknown>).code);
  }
  return null;
}
function mcpRetryAfter(j: unknown): number | null {
  if (!j || typeof j !== "object") return null;
  const e = (j as Record<string, unknown>).error;
  const d = e && typeof e === "object" ? (e as Record<string, unknown>).data : null;
  const v = d && typeof d === "object" ? (d as Record<string, unknown>).retry_after_seconds : null;
  return typeof v === "number" ? v : null;
}

/**
 * tools/call result → the structured payload: structuredContent, else every
 * JSON text block (objects merged, the first block's keys winning), else the
 * first text. Not just the first block: WarmySender says agents get a
 * verification reminder when they save or export, and a prose block ahead of
 * the JSON would read as `{ text }` with no rows. 2026-10-19: some seventy
 * exports in a row came back ok with no rows we could read ("acquired 0").
 */
export function unwrapToolResult(result: unknown): unknown {
  if (!result || typeof result !== "object") return result;
  const r = result as Record<string, unknown>;
  if (r.isError) return { __error: true, ...r };
  if (r.structuredContent && typeof r.structuredContent === "object") return r.structuredContent;
  const content = Array.isArray(r.content) ? (r.content as Array<Record<string, unknown>>) : [];
  let merged: Record<string, unknown> | null = null;
  let list: unknown[] | null = null;
  let firstText: string | null = null;
  for (let i = 0; i < content.length; i++) {
    const c = content[i];
    if (!c || c.type !== "text" || typeof c.text !== "string") continue;
    if (firstText === null) firstText = c.text;
    let j: unknown;
    try { j = JSON.parse(c.text); } catch { continue; }
    if (Array.isArray(j)) { if (!list) list = j; }
    else if (j && typeof j === "object") merged = { ...(j as Record<string, unknown>), ...(merged ?? {}) };
  }
  if (merged) return merged;
  if (list) return list;
  if (firstText !== null) return { text: firstText };
  return r;
}

/** A tools/call result's shape — block kinds and JSON keys, never values — for a log line. */
export function describeToolResult(result: unknown): string {
  if (!result || typeof result !== "object") return `result ${result === null ? "null" : typeof result}`;
  const r = result as Record<string, unknown>;
  const keys = (o: unknown) => Object.keys(o && typeof o === "object" ? (o as Record<string, unknown>) : {}).slice(0, 12).join(", ");
  const parts: string[] = [];
  if (r.structuredContent && typeof r.structuredContent === "object") parts.push(`structuredContent {${keys(r.structuredContent)}}`);
  const content = Array.isArray(r.content) ? (r.content as Array<Record<string, unknown>>) : [];
  for (let i = 0; i < content.length; i++) {
    const c = content[i];
    if (!c || c.type !== "text" || typeof c.text !== "string") { parts.push(String(c?.type ?? "unknown block")); continue; }
    let j: unknown;
    try { j = JSON.parse(c.text); } catch { parts.push(`text (${c.text.length} chars, not JSON)`); continue; }
    parts.push(Array.isArray(j) ? `text JSON [${j.length}]` : `text JSON {${keys(j)}}`);
  }
  return parts.length ? parts.join("; ") : `keys {${keys(r)}}`;
}

/* ─── Tolerant field mapping ────────────────────────────────────────────── */

function pick(row: Record<string, unknown>, names: string[]): unknown {
  for (let i = 0; i < names.length; i++) {
    const n = names[i];
    if (n in row && row[n] != null && row[n] !== "") return row[n];
  }
  // Case-insensitive fallback.
  const keys = Object.keys(row);
  for (let i = 0; i < names.length; i++) {
    const want = keyNorm(names[i]);
    for (let k = 0; k < keys.length; k++) {
      if (keyNorm(keys[k]) === want) {
        const v = row[keys[k]];
        if (v != null && v !== "") return v;
      }
    }
  }
  return undefined;
}
const str = (v: unknown): string | null => (v == null ? null : String(v).trim() || null);

/** A masked address ("j***@acme.com", "•••@acme.com") is not an email. */
export function looksMasked(email: string | null): boolean {
  if (!email) return false;
  if (/[*•●]/.test(email)) return true;
  const at = email.indexOf("@");
  if (at <= 0) return true;
  const local = email.slice(0, at);
  return /^[a-z]\.{2,}$/i.test(local) || /^x{2,}$/i.test(local);
}

/** Find the array of lead rows wherever the tool put it. */
export function extractLeadRows(payload: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(payload)) return payload as Array<Record<string, unknown>>;
  if (!payload || typeof payload !== "object") return [];
  const p = payload as Record<string, unknown>;
  const keys = ["leads", "results", "data", "items", "records", "contacts", "exported", "prospects", "rows"];
  for (let i = 0; i < keys.length; i++) {
    const v = p[keys[i]];
    if (Array.isArray(v)) return v as Array<Record<string, unknown>>;
    if (v && typeof v === "object") {
      const inner = extractLeadRows(v);
      if (inner.length) return inner;
    }
  }
  return [];
}

export function extractCursor(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  const pg = (p.pagination && typeof p.pagination === "object" ? p.pagination : p) as Record<string, unknown>;
  const v = pg.next_cursor ?? pg.nextCursor ?? pg.cursor ?? null;
  if (typeof v === "string" && v) return v;
  if (typeof pg.next_page === "number") return String(pg.next_page);
  if (pg.has_more === true && typeof pg.page === "number") return String(pg.page + 1);
  return null;
}

export function extractTotal(payload: unknown): number | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  const pg = (p.pagination && typeof p.pagination === "object" ? p.pagination : p) as Record<string, unknown>;
  const v = pg.total ?? pg.total_count ?? pg.totalCount ?? pg.count;
  return typeof v === "number" ? v : null;
}

/** Their lead row (5 contacts per business are possible) → our record(s). */
export function mapLeadRow(row: Record<string, unknown>): ProspectRecord[] {
  const contacts = Array.isArray(row.contacts) && (row.contacts as unknown[]).length > 0
    ? (row.contacts as Array<Record<string, unknown>>)
    : [row];
  const out: ProspectRecord[] = [];
  const companyName = str(pick(row, ["company", "company_name", "business_name", "name", "business"]));
  const website = str(pick(row, ["website", "domain", "company_domain", "url"]));
  const companyDomain = website ? normalizeDomain(website) : null;
  const industry = str(pick(row, ["industry", "category"]));
  const city = str(pick(row, ["city"]));
  const state = str(pick(row, ["state", "state_province", "region", "province"]));
  const country = str(pick(row, ["country", "country_code"]));
  const headcount = str(pick(row, ["employee_count", "employees", "company_size", "headcount"]));
  const businessPhone = str(pick(row, ["phone", "business_phone", "phone_number"]));
  for (let i = 0; i < contacts.length; i++) {
    const c = contacts[i];
    const fullName = str(pick(c, ["contact_name", "full_name", "name"]));
    let firstName = str(pick(c, ["first_name", "firstName"])) ?? "";
    let lastName = str(pick(c, ["last_name", "lastName"])) ?? "";
    if (!firstName && !lastName && fullName && c !== row) {
      const parts = fullName.split(/\s+/);
      firstName = parts[0] ?? "";
      lastName = parts.slice(1).join(" ");
    } else if (!firstName && !lastName && fullName && c === row && companyName && fullName !== companyName) {
      const parts = fullName.split(/\s+/);
      firstName = parts[0] ?? "";
      lastName = parts.slice(1).join(" ");
    }
    firstName = stripNameCredentials(firstName) ?? "";
    lastName = stripNameCredentials(lastName) ?? "";
    const rawEmail = str(pick(c, ["email", "work_email", "email_address"]));
    const masked = looksMasked(rawEmail);
    const id = str(pick(c, ["id", "lead_id", "contact_id", "leadId"])) ?? str(pick(row, ["id", "lead_id", "business_id"])) ?? "";
    const idSuffix = contacts.length > 1 && c !== row ? `#${i}` : "";
    if (!firstName && !lastName && !rawEmail && !pick(c, ["linkedin", "linkedin_url"])) continue;
    out.push({
      externalId: `${id}${idSuffix}`,
      firstName, lastName,
      jobTitle: str(pick(c, ["job_title", "title", "role", "position"])),
      seniority: str(pick(c, ["seniority"])),
      companyName, companyDomain,
      email: masked ? null : rawEmail,
      emailIsMasked: masked,
      emailVerifiedAt: null,
      mobilePhone: null, // coverage is business phones only (docs)
      businessPhone: str(pick(c, ["phone", "business_phone", "direct_phone"])) ?? businessPhone,
      linkedinUrl: str(pick(c, ["linkedin", "linkedin_url", "linkedinUrl"])),
      city, stateProvince: state, country, industry, headcount,
      rawSourcePayload: { ...row, ...(c !== row ? { contact: c } : {}), ...(masked && rawEmail ? { email_masked: rawEmail } : {}) },
    });
  }
  return out;
}

/* ─── Argument building from the captured schema ───────────────────────── */

const PARAM_CANDIDATES: Record<string, string[]> = {
  jobTitle: ["job_title", "jobTitle", "title", "role"],
  seniority: ["seniority", "seniority_level"],
  department: ["department"],
  industry: ["industry", "industries"],
  category: ["category", "categories"],
  country: ["country", "country_code"],
  stateProvince: ["state", "state_province", "region", "province"],
  city: ["city"],
  postalCode: ["postcode", "zip", "postal_code", "zip_code"],
  keyword: ["keyword", "keywords", "q", "query", "search"],
  hasEmail: ["has_email", "hasEmail", "email_only"],
  hasPhone: ["has_phone", "hasPhone", "phone_only"],
  hasLinkedin: ["has_linkedin"],
  limit: ["limit", "page_size", "per_page", "max_results"],
  cursor: ["cursor", "page", "offset"],
  leadIds: ["lead_ids", "ids", "leads", "leadIds", "contact_ids"],
};

function schemaProps(schema: unknown): Record<string, unknown> | null {
  if (!schema || typeof schema !== "object") return null;
  const s = schema as Record<string, unknown>;
  const props = (s.properties ?? (s.inputSchema && (s.inputSchema as Record<string, unknown>).properties)) as Record<string, unknown> | undefined;
  return props && typeof props === "object" ? props : null;
}

/** The parameter name the schema uses for a concept, or null when absent. */
export function paramNameFor(schema: unknown, concept: keyof typeof PARAM_CANDIDATES): string | null {
  const props = schemaProps(schema);
  const cands = PARAM_CANDIDATES[concept];
  if (!props) return null;
  for (let i = 0; i < cands.length; i++) if (cands[i] in props) return cands[i];
  const keys = Object.keys(props);
  for (let i = 0; i < cands.length; i++) {
    const want = keyNorm(cands[i]);
    for (let k = 0; k < keys.length; k++) if (keyNorm(keys[k]) === want) return keys[k];
  }
  return null;
}

function propType(schema: unknown, name: string): string | null {
  const props = schemaProps(schema);
  const p = props?.[name];
  if (!p || typeof p !== "object") return null;
  const t = (p as Record<string, unknown>).type;
  return typeof t === "string" ? t : Array.isArray(t) ? String(t[0]) : null;
}

/**
 * WarmySender refuses a text filter over its maxLength (255): 2026-10-16, a
 * county campaign's 22 job titles joined into one jobTitle string failed
 * every search. The schema's own limit when it states one, else 255.
 */
const DEFAULT_MAX_TEXT = 255;
function maxLengthFor(schema: unknown, name: string): number {
  const p = schemaProps(schema)?.[name];
  const m = p && typeof p === "object" ? (p as Record<string, unknown>).maxLength : undefined;
  return typeof m === "number" && m > 0 ? m : DEFAULT_MAX_TEXT;
}

/**
 * Likewise a page size over its maximum: 2026-10-16, a limit of 100 failed
 * every search once the text filters fit (search_leads allows 50). The
 * schema's own maximum when it states one, else 50.
 */
const DEFAULT_MAX_LIMIT = 50;
function maximumFor(schema: unknown, name: string): number {
  const p = schemaProps(schema)?.[name];
  const m = p && typeof p === "object" ? (p as Record<string, unknown>).maximum : undefined;
  return typeof m === "number" && m >= 1 ? m : DEFAULT_MAX_LIMIT;
}

/** Whole values, the first ones, as many as fit within max (a single over-long value is cut). */
export function fitJoin(values: string[], sep: string, max: number): string {
  let out = "";
  for (const v of values) {
    const next = out ? `${out}${sep}${v}` : v;
    if (next.length > max) return out || v.slice(0, max);
    out = next;
  }
  return out;
}

/**
 * Which text filters take a list. search_leads says so per parameter: state,
 * country, seniority, department and postalCode OR comma-separated values;
 * jobTitle, keyword, industry and city say nothing of the kind, and
 * jobTitle's rule is "each word you pass must start a word in the title".
 * 2026-10-18: a county campaign's titles went out as one comma-joined
 * jobTitle, which asks for one title holding every word of eleven titles,
 * and every search returned nobody. The parameter's own description decides;
 * without one, the concepts the captured schema ORs.
 */
const OR_CONCEPTS: Array<keyof typeof PARAM_CANDIDATES> = ["country", "stateProvince", "seniority", "department", "postalCode"];
function joinsAsOr(schema: unknown, name: string, concept: keyof typeof PARAM_CANDIDATES): boolean {
  const p = schemaProps(schema)?.[name];
  const d = p && typeof p === "object" ? (p as Record<string, unknown>).description : undefined;
  if (typeof d === "string" && d.trim()) return /[Cc]omma-separated[^.]*\bOR\b/.test(d);
  return OR_CONCEPTS.indexOf(concept) !== -1;
}

/** A list where the parameter ORs one, else the first value alone. */
function joinFor(schema: unknown, name: string, concept: keyof typeof PARAM_CANDIDATES, values: string[]): unknown {
  if (propType(schema, name) === "array") return values;
  const max = maxLengthFor(schema, name);
  return joinsAsOr(schema, name, concept) ? fitJoin(values, ", ", max) : values[0].slice(0, max);
}

/**
 * search_leads filters country by name ("United States", as its rows carry
 * it) where the bridge hands vendors ISO codes: 2026-10-18, the connection
 * probe's country "US" returned no rows for job title "Owner".
 */
const COUNTRY_NAMES: Record<string, string> = { US: "United States", CA: "Canada" };
function countryName(c: string): string {
  return COUNTRY_NAMES[c.trim().toUpperCase()] ?? c;
}

/**
 * Build search_leads arguments. With a captured schema every filter goes to
 * its native parameter and unsupported ones are folded into the keyword;
 * without one (never validated) the documented names are used. A filter
 * that takes no list carries its first value: planSearchLeadsCalls spreads
 * several titles over several calls.
 */
export function buildSearchLeadsArgs(
  criteria: SearchCriteria,
  schema: unknown,
  limit: number,
  cursor: string | null,
): { args: Record<string, unknown>; foldedIntoKeyword: string[] } {
  const args: Record<string, unknown> = {};
  const folded: string[] = [];
  // The keyword is free text with no OR either: one phrase per concept, the
  // first keyword and the first value of each folded filter (eleven keywords
  // joined were some thirty words every lead had to hold).
  const keywordParts: string[] = criteria.keywords.slice(0, 1);
  const put = (concept: keyof typeof PARAM_CANDIDATES, values: string[], fallback: string) => {
    if (values.length === 0) return;
    const name = schema ? paramNameFor(schema, concept) : fallback;
    if (name) args[name] = joinFor(schema, name, concept, values);
    else { folded.push(concept); keywordParts.push(values[0]); }
  };
  put("jobTitle", criteria.jobTitles, "job_title");
  put("seniority", criteria.seniorities, "seniority");
  put("department", criteria.departments, "department");
  // No industry parameter: WarmySender's person rows carry no industry, so
  // any value matches nobody. 2026-10-19 previews: "County Administrator" in
  // VA/MD/NC found 28, adding industry "Government Administration" 0, and
  // "government" across the three states alone 0. Only a search with no
  // title and no keyword folds it into the keyword (which also searches
  // company and category), so it never narrows a title search again.
  if (criteria.industries.length && !criteria.jobTitles.length && !criteria.keywords.length) {
    folded.push("industry");
    keywordParts.push(criteria.industries[0]);
  }
  put("country", criteria.countries.map(countryName), "country");
  put("stateProvince", criteria.stateProvinces, "state");
  put("city", criteria.cities, "city");
  put("postalCode", criteria.postalCodes, "postcode");
  if (criteria.companyNames.length) { folded.push("companyName"); keywordParts.push(criteria.companyNames[0]); }
  if (criteria.companyDomains.length) { folded.push("companyDomain"); keywordParts.push(criteria.companyDomains[0]); }
  if (keywordParts.length) {
    const kw = (schema ? paramNameFor(schema, "keyword") : null) ?? "keyword";
    args[kw] = fitJoin(keywordParts, " ", maxLengthFor(schema, kw));
  }
  const he = (schema ? paramNameFor(schema, "hasEmail") : null) ?? "has_email";
  args[he] = criteria.hasEmail !== undefined ? criteria.hasEmail : true;
  if (criteria.hasPhone !== undefined) args[(schema ? paramNameFor(schema, "hasPhone") : null) ?? "has_phone"] = criteria.hasPhone;
  const lim = (schema ? paramNameFor(schema, "limit") : null) ?? "limit";
  args[lim] = Math.max(1, Math.min(maximumFor(schema, lim), limit));
  if (cursor) {
    const cur = (schema ? paramNameFor(schema, "cursor") : null) ?? "cursor";
    args[cur] = cur === "page" || cur === "offset" ? Number(cursor) : cursor;
  }
  return { args, foldedIntoKeyword: folded };
}

/** search_leads calls one search() makes when titles go one per call. */
export const MAX_TITLE_SEARCHES = 6;

function titlesKey(titles: string[]): string {
  const s = titles.join("|");
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/** "page:offset:key" → where the title walk resumes; a cursor made for other titles starts over. */
export function parseTitleCursor(cursor: string | null, titles: string[]): { page: number; offset: number } {
  const m = cursor ? /^(\d+):(\d+):([a-z0-9]+)$/.exec(cursor) : null;
  if (!m || m[3] !== titlesKey(titles)) return { page: 1, offset: 0 };
  const offset = Number(m[2]);
  return { page: Math.max(1, Number(m[1])), offset: offset < titles.length ? offset : 0 };
}

export interface SearchLeadsPlan {
  calls: Array<{ args: Record<string, unknown>; limit: number }>;
  foldedIntoKeyword: string[];
  /** Set when the titles go one per call: the walk the cursor continues. */
  titleWalk: { titles: string[]; page: number; offset: number } | null;
}

/**
 * The search_leads calls for one search(). Several titles where the title
 * filter takes one (see joinsAsOr) become one call per title, at most
 * MAX_TITLE_SEARCHES, sharing the page size; the cursor walks on through
 * the rest of the titles, then the next page of each. Otherwise one call.
 */
export function planSearchLeadsCalls(
  criteria: SearchCriteria,
  schema: unknown,
  limit: number,
  cursor: string | null,
): SearchLeadsPlan {
  const titleParam = schema ? paramNameFor(schema, "jobTitle") : "job_title";
  const titlesTakeList = !!titleParam && (propType(schema, titleParam) === "array" || joinsAsOr(schema, titleParam, "jobTitle"));
  const limName = (schema ? paramNameFor(schema, "limit") : null) ?? "limit";
  if (criteria.jobTitles.length <= 1 || titlesTakeList) {
    // A title walk's cursor (the campaign had several titles) is no vendor page.
    const b = buildSearchLeadsArgs(criteria, schema, limit, cursor && /^\d+:\d+:/.test(cursor) ? null : cursor);
    return { calls: [{ args: b.args, limit: Number(b.args[limName]) }], foldedIntoKeyword: b.foldedIntoKeyword, titleWalk: null };
  }
  const titles = criteria.jobTitles;
  const at = parseTitleCursor(cursor, titles);
  const window = titles.slice(at.offset, at.offset + MAX_TITLE_SEARCHES);
  const per = Math.max(1, Math.ceil(limit / window.length));
  let folded: string[] = [];
  const calls = window.map((t) => {
    const b = buildSearchLeadsArgs({ ...criteria, jobTitles: [t] }, schema, per, at.page > 1 ? String(at.page) : null);
    folded = b.foldedIntoKeyword;
    return { args: b.args, limit: Number(b.args[limName]) };
  });
  return { calls, foldedIntoKeyword: folded, titleWalk: { titles, page: at.page, offset: at.offset } };
}

/** A search_leads tool error as a classified failure, else null. */
function searchToolFailure(payload: unknown): VendorFailure | null {
  if (!payload || typeof payload !== "object" || !(payload as Record<string, unknown>).__error) return null;
  const msg = String(((payload as Record<string, unknown>).content as Array<Record<string, unknown>> | undefined)?.[0]?.text ?? "tool error");
  return { ok: false, reason: /scope/i.test(msg) ? "insufficient_scope" : /rate/i.test(msg) ? "rate_limited" : "http", message: msg.slice(0, 300) };
}

export function buildExportLeadsArgs(ids: string[], schema: unknown): Record<string, unknown> {
  const name = (schema ? paramNameFor(schema, "leadIds") : null) ?? "lead_ids";
  return { [name]: ids.map((id) => id.replace(/#\d+$/, "")) };
}

/* ─── Capabilities ──────────────────────────────────────────────────────── */

const BASE_CAPS: SourceCapabilities = {
  // Documented filter set (product page 2026-09): keyword, industry,
  // category, country, state, city, postcode, seniority, department,
  // has_email/has_phone. Job title is listed as a free-text filter on the
  // product page but absent from the MCP docs — approximated until a
  // captured schema proves the native parameter. Industry is approximated
  // whatever the schema says: its person rows carry none (see
  // buildSearchLeadsArgs).
  supportedFilters: ["keyword", "country", "stateProvince", "city", "postalCode", "seniority", "department", "hasEmail", "hasPhone"],
  approximatedFilters: ["jobTitle", "industry", "companyName", "companyDomain"],
  supportsFreePreview: true,
  returnsMaskedPreview: true,
  supportsMobilePhone: false,
  supportsVerification: true,
  maxBatchSize: DEFAULT_MAX_LIMIT,
  geographicCoverage: ["US", "CA"],
};

export function warmySenderCapabilities(c?: SourceCredentials | null): SourceCapabilities {
  const schema = c ? cfg(c).toolSchemas?.search_leads : null;
  if (!schema) return BASE_CAPS;
  const supported = BASE_CAPS.supportedFilters.slice();
  const approximated = BASE_CAPS.approximatedFilters.slice();
  const promote = (f: "jobTitle", concept: keyof typeof PARAM_CANDIDATES) => {
    if (paramNameFor(schema, concept)) {
      if (supported.indexOf(f) === -1) supported.push(f);
      const i = approximated.indexOf(f);
      if (i !== -1) approximated.splice(i, 1);
    }
  };
  promote("jobTitle", "jobTitle");
  // Filters the captured schema does NOT know fall to approximated (keyword).
  const demote = (f: typeof BASE_CAPS.supportedFilters[number], concept: keyof typeof PARAM_CANDIDATES) => {
    if (!paramNameFor(schema, concept)) {
      const i = supported.indexOf(f);
      if (i !== -1) supported.splice(i, 1);
      if (approximated.indexOf(f) === -1) approximated.push(f);
    }
  };
  demote("seniority", "seniority");
  demote("department", "department");
  demote("postalCode", "postalCode");
  return { ...BASE_CAPS, supportedFilters: supported, approximatedFilters: approximated };
}

/* ─── Budget periods ────────────────────────────────────────────────────── */

export function monthlyPeriodKeyForAnniversary(now: Date, day: number | undefined): { key: string; resetsAt: Date } {
  const d = day && day >= 1 && day <= 28 ? day : 1;
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  // Period starts on the anniversary day; before that day we are in the
  // period that started last month.
  const startThisMonth = new Date(Date.UTC(y, m, d));
  const start = now.getTime() >= startThisMonth.getTime() ? startThisMonth : new Date(Date.UTC(y, m - 1, d));
  const resetsAt = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, d));
  return { key: `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, "0")}`, resetsAt };
}

export const warmySenderBudgetPeriods: ProspectSource["budgetPeriods"] = ({ now, credentials }) => {
  const c = cfg(credentials);
  const tier = (c.tier ?? "").toLowerCase();
  const monthly = c.monthlyLeadAllowance ?? WARMYSENDER_PLAN_ALLOWANCES[tier]?.leads ?? null;
  const { key, resetsAt } = monthlyPeriodKeyForAnniversary(now, c.billingAnniversaryDay);
  const dayKey = now.toISOString().slice(0, 10);
  const nextDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  const periods: BudgetPeriod[] = [
    { bucket: "leads", granularity: "daily", periodKey: dayKey, unitsLimit: monthly != null ? Math.ceil(monthly / 30) : null, resetsAt: nextDay },
    { bucket: "leads", granularity: "monthly", periodKey: key, unitsLimit: monthly, resetsAt },
  ];
  if (c.leadCreditBalance != null && c.leadCreditBalance > 0) {
    periods.push({ bucket: "leads", granularity: "credits", periodKey: "all", unitsLimit: c.leadCreditBalance, resetsAt: null });
  }
  // Verification: the allowance endpoint is authoritative; the ledger only
  // mirrors local spend against the limits it reports (synced at refresh).
  const ver = c.tier ? WARMYSENDER_PLAN_ALLOWANCES[tier]?.verification ?? null : null;
  periods.push({ bucket: "verification", granularity: "daily", periodKey: dayKey, unitsLimit: ver != null ? Math.ceil(ver / 30) : null, resetsAt: nextDay });
  periods.push({ bucket: "verification", granularity: "monthly", periodKey: now.toISOString().slice(0, 7), unitsLimit: ver, resetsAt: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)) });
  return periods;
};

/* ─── REST helpers ──────────────────────────────────────────────────────── */

async function restGet<T>(c: SourceCredentials, path: string, endpoint: string, fetchImpl?: typeof fetch) {
  return vendorFetch<T>(`${WARMYSENDER_REST}${path}`, {
    workspaceId: c.workspaceId, source: "warmysender", endpoint,
    headers: { Authorization: `Bearer ${c.secrets.apiKey ?? ""}` }, fetchImpl,
  });
}

export interface WarmyMeResponse {
  apiKey?: { id?: string; name?: string; scopes?: string[] };
  workspace?: { id?: string };
  account_status?: string;
  can_send?: boolean;
}

export interface WarmyAllowance {
  can_verify_now?: boolean; access_source?: string;
  monthly_allowance?: number; monthly_used?: number; monthly_remaining?: number;
  daily_allowance?: number; daily_used?: number; daily_remaining?: number;
  credit_balance?: number; free_checks_remaining_today?: number; verifiable_now?: number;
  max_addresses_per_batch?: number;
}

/** Single-address verification (verification:write). Never throws. */
export async function warmySenderVerifyEmail(
  c: SourceCredentials,
  email: string,
  fetchImpl?: typeof fetch,
): Promise<VendorResult<{ status: "valid" | "invalid" | "risky" | "unknown"; reason: string; isCatchAll: boolean }>> {
  const res = await vendorFetch<{ data?: { status?: string; reason?: string; is_catch_all?: boolean } }>(`${WARMYSENDER_REST}/verification/verify`, {
    workspaceId: c.workspaceId, source: "warmysender", endpoint: "verification.verify", method: "POST",
    headers: { Authorization: `Bearer ${c.secrets.apiKey ?? ""}`, "Idempotency-Key": `v-${email.toLowerCase()}-${new Date().toISOString().slice(0, 10)}` },
    body: { email }, fetchImpl,
  });
  if (!res.ok) return res;
  const d = res.json?.data ?? {};
  const status = (["valid", "invalid", "risky", "unknown"].indexOf(String(d.status)) !== -1 ? d.status : "unknown") as "valid" | "invalid" | "risky" | "unknown";
  return { ok: true, status, reason: String(d.reason ?? ""), isCatchAll: !!d.is_catch_all };
}

/* ─── The adapter ───────────────────────────────────────────────────────── */

export function createWarmySenderSource(deps?: { fetchImpl?: typeof fetch }): ProspectSource {
  const f = deps?.fetchImpl;
  return {
    slug: "warmysender",
    displayName: "WarmySender",
    docsUrl: WARMYSENDER_DOCS,
    credentialMode: "table",
    acquisition: "on_demand",
    capabilities: warmySenderCapabilities,
    budgetPeriods: warmySenderBudgetPeriods,

    async validateCredentials(c) {
      const me = await restGet<WarmyMeResponse>(c, "/me", "me", f);
      if (!me.ok) {
        return { ok: false, message: `WarmySender rejected the key: ${me.message}`, terminal: me.reason === "unauthorized" };
      }
      const scopes = me.json?.apiKey?.scopes ?? [];
      const missing = ["leads:read", "leads:write"].filter((s) => scopes.indexOf(s) === -1);
      const discovered: Record<string, unknown> = { scopes, accountStatus: me.json?.account_status ?? null };
      // Capture tool schemas — the only place the leads parameter names live.
      const tools = await mcpCall(c, "tools/list", {}, "mcp.tools/list", { fetchImpl: f });
      if (tools.ok && tools.result && typeof tools.result === "object") {
        const list = (tools.result as Record<string, unknown>).tools;
        if (Array.isArray(list)) {
          const names: string[] = [];
          const schemas: Record<string, unknown> = {};
          // What the lead tools say they return: the export's answer is
          // documented nowhere else (2026-10-19).
          const outputs: Record<string, unknown> = {};
          const descriptions: Record<string, string> = {};
          for (let i = 0; i < list.length; i++) {
            const t = list[i] as Record<string, unknown>;
            if (typeof t.name !== "string") continue;
            names.push(t.name);
            if (["search_leads", "save_leads", "export_leads", "get_workspace_info"].indexOf(t.name) !== -1) {
              schemas[t.name] = t.inputSchema ?? null;
              if (t.outputSchema && typeof t.outputSchema === "object") outputs[t.name] = t.outputSchema;
              if (typeof t.description === "string") descriptions[t.name] = t.description.slice(0, 2000);
            }
          }
          discovered.toolNames = names;
          discovered.toolSchemas = schemas;
          discovered.toolOutputSchemas = outputs;
          discovered.toolDescriptions = descriptions;
          if (names.indexOf("search_leads") === -1) {
            return { ok: false, message: `Key accepted, but this key's MCP server exposes no search_leads tool (scopes: ${scopes.join(", ") || "none"}). Reissue the key with leads:read and leads:write.`, discovered, terminal: true };
          }
        }
      }
      // Tier → default allowances.
      const info = await mcpCall(c, "tools/call", { name: "get_workspace_info", arguments: {} }, "mcp.get_workspace_info", { fetchImpl: f });
      if (info.ok) {
        const payload = unwrapToolResult(info.result) as Record<string, unknown> | null;
        const tier = payload && (payload.subscription_tier ?? payload.tier ?? payload.plan ?? (payload.subscription && (payload.subscription as Record<string, unknown>).tier));
        if (typeof tier === "string") discovered.tier = tier.toLowerCase();
        discovered.workspaceLeadCounters = leadCounters(payload);
      }
      // One masked search, keys only, so a field rename is diagnosable later.
      const probe = await mcpCall(c, "tools/call", {
        name: "search_leads",
        arguments: buildSearchLeadsArgs({ ...emptyCriteriaLocal(), jobTitles: ["Owner"], countries: ["US"] }, discovered.toolSchemas ? (discovered.toolSchemas as Record<string, unknown>).search_leads : null, 3, null).args,
      }, "mcp.search_leads(probe)", { fetchImpl: f });
      if (probe.ok) {
        const rows = extractLeadRows(unwrapToolResult(probe.result));
        if (rows[0] && typeof rows[0] === "object") discovered.sampleRowKeys = Object.keys(rows[0]).slice(0, 40);
        discovered.probeRows = rows.length;
      } else if (probe.reason === "insufficient_scope") {
        return { ok: false, message: `Key accepted, but it lacks leads:read (${probe.message}).`, discovered, terminal: true };
      }
      const schema = (discovered.toolSchemas as Record<string, unknown> | undefined)?.search_leads ?? null;
      const titleParam = schema ? paramNameFor(schema, "jobTitle") : null;
      return {
        ok: missing.length === 0,
        message: missing.length
          ? `Key works but is missing scope${missing.length > 1 ? "s" : ""} ${missing.join(", ")} — searches will run, saving/exporting leads will not.`
          : `Key accepted${discovered.tier ? ` · ${discovered.tier} plan` : ""} · scopes: ${scopes.join(", ")}` +
            (titleParam ? ` · native title filter (${titleParam})` : " · no native title filter — titles are keyword-matched") +
            (typeof discovered.probeRows === "number" ? ` · probe returned ${discovered.probeRows} masked row${discovered.probeRows === 1 ? "" : "s"}` : ""),
        discovered,
        terminal: false,
      };
    },

    async search(criteria, c, limit, ctx) {
      const schema = cfg(c).toolSchemas?.search_leads ?? null;
      const plan = planSearchLeadsCalls(criteria, schema, Math.min(limit, BASE_CAPS.maxBatchSize), ctx.cursor ?? null);
      const records: ProspectRecord[] = [];
      const seen = new Set<string>();
      let done = 0;
      let more = false;
      let total: number | null = null;
      let vendorCursor: string | null = null;
      let firstKeys: string[] = [];
      for (let k = 0; k < plan.calls.length; k++) {
        const res = await mcpCall(c, "tools/call", { name: "search_leads", arguments: plan.calls[k].args }, "mcp.search_leads", { fetchImpl: f });
        const payload = res.ok ? unwrapToolResult(res.result) : null;
        const failure = !res.ok ? res : searchToolFailure(payload);
        if (failure) {
          // The first call speaks for the source (scope, rate limit, circuit);
          // a later one keeps what came back and the cursor resumes at it.
          if (done === 0) return failure;
          break;
        }
        done += 1;
        if (k === 0 && payload && typeof payload === "object") firstKeys = Object.keys(payload as Record<string, unknown>).slice(0, 12);
        const rows = extractLeadRows(payload);
        vendorCursor = extractCursor(payload);
        if (vendorCursor != null || rows.length >= plan.calls[k].limit) more = true;
        const t = extractTotal(payload);
        if (t != null) total = (total ?? 0) + t;
        // One person can hold two of the titles ("Deputy County Administrator").
        for (let i = 0; i < rows.length; i++) {
          for (const r of mapLeadRow(rows[i])) {
            if (r.externalId && seen.has(r.externalId)) continue;
            if (r.externalId) seen.add(r.externalId);
            records.push(r);
          }
        }
      }
      const walk = plan.titleWalk;
      let nextCursor = vendorCursor;
      const notes: string[] = [];
      if (walk) {
        const end = walk.offset + done;
        const key = titlesKey(walk.titles);
        nextCursor = end < walk.titles.length ? `${walk.page}:${end}:${key}` : more ? `${walk.page + 1}:0:${key}` : null;
        notes.push(`titles ${walk.offset + 1}–${end} of ${walk.titles.length}${walk.page > 1 ? ` (page ${walk.page})` : ""}, one per search`);
      }
      if (plan.foldedIntoKeyword.length) notes.push(`folded into keyword: ${plan.foldedIntoKeyword.join(", ")}`);
      // Keys only, never values: tells "nobody matched" from "rows we cannot find".
      if (records.length === 0) notes.push(`no rows; vendor total ${total ?? "not stated"}; payload keys ${firstKeys.join(", ") || "none"}`);
      return {
        ok: true,
        records: records.slice(0, limit),
        nextCursor,
        totalAvailable: total,
        alreadyCharged: false,
        unitsSpent: 0,
        ...(notes.length ? { note: notes.join("; ") } : {}),
      };
    },

    async acquire(externalIds, c, _ctx) {
      if (externalIds.length === 0) return { ok: true, records: [], unitsSpent: 0, failedExternalIds: [] };
      const schema = cfg(c).toolSchemas?.export_leads ?? null;
      const res = await mcpCall(c, "tools/call", { name: "export_leads", arguments: buildExportLeadsArgs(externalIds, schema) }, "mcp.export_leads", { fetchImpl: f });
      if (!res.ok) return res;
      const payload = unwrapToolResult(res.result) as Record<string, unknown>;
      if (payload && payload.__error) {
        const msg = String((payload.content as Array<Record<string, unknown>> | undefined)?.[0]?.text ?? "tool error");
        return { ok: false, reason: /scope/i.test(msg) ? "insufficient_scope" : /allowance|credit|limit/i.test(msg) ? "budget_exhausted" : "http", message: msg.slice(0, 300) };
      }
      const rows = extractLeadRows(payload);
      const records: ProspectRecord[] = [];
      for (let i = 0; i < rows.length; i++) records.push(...mapLeadRow(rows[i]));
      const got = new Set(records.map((r) => r.externalId.replace(/#\d+$/, "")));
      const failed = externalIds.filter((id) => !got.has(id.replace(/#\d+$/, "")));
      if (failed.length === externalIds.length) {
        // The vendor said ok and handed back none of the people asked for. It
        // charges one unit per NEW lead exported, so asking again blind may
        // pay for people we never receive: a terminal failure marks the key
        // invalid (Test connection clears it) and says what came back.
        const job = pick(payload && typeof payload === "object" ? payload : {}, ["job_id", "jobId"]);
        return {
          ok: false, reason: "not_implemented",
          message: `export_leads answered without any of the ${externalIds.length} lead${externalIds.length === 1 ? "" : "s"} asked for` +
            `${job != null ? " (it started a job; asynchronous exports are not read)" : ""}: ${describeToolResult(res.result)}. ` +
            "Check WarmySender → credits → Usage history before testing the connection again.",
        };
      }
      const charged = pick(payload ?? {}, ["units_spent", "charged", "credits_used", "new_leads", "spent", "units_used", "leads_used", "used"]);
      const unitsSpent = typeof charged === "number" ? charged : records.filter((r) => r.email && !r.emailIsMasked).length;
      return { ok: true, records, unitsSpent, failedExternalIds: failed } as AcquisitionResult & { ok: true };
    },

    async remainingBudget(c) {
      const out: BudgetSnapshot[] = [];
      const res = await restGet<{ data?: WarmyAllowance }>(c, "/verification/allowance", "verification.allowance", f);
      if (res.ok && res.json?.data) {
        const d = res.json.data;
        out.push({
          bucket: "verification",
          remaining: typeof d.verifiable_now === "number" ? d.verifiable_now : (typeof d.monthly_remaining === "number" ? d.monthly_remaining : null),
          limit: typeof d.monthly_allowance === "number" ? d.monthly_allowance : null,
          used: typeof d.monthly_used === "number" ? d.monthly_used : null,
          resetsAt: null,
          fundedBy: d.access_source ?? null,
        });
      }
      // Leads: the vendor publishes no allowance endpoint — reported as unknown
      // so the UI says "tracked locally" rather than inventing a number.
      out.push({ bucket: "leads", remaining: null, limit: null, used: null, resetsAt: null, fundedBy: null });
      return out;
    },
  };
}

/**
 * Lead and credit counters from get_workspace_info (numbers only, two levels
 * deep, keyed by path): the one place the vendor may say what saves and
 * exports have spent, since no endpoint reports it.
 */
export function leadCounters(payload: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  const walk = (o: unknown, prefix: string, depth: number) => {
    if (!o || typeof o !== "object" || Array.isArray(o)) return;
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
      const path = prefix ? `${prefix}.${k}` : k;
      if (typeof v === "number" && /lead|credit|allowance|export|save/i.test(path)) {
        if (Object.keys(out).length < 24) out[path] = v;
      } else if (depth < 2) walk(v, path, depth + 1);
    }
  };
  walk(payload, "", 0);
  return out;
}

function emptyCriteriaLocal(): SearchCriteria {
  return {
    jobTitles: [], seniorities: [], departments: [], industries: [], countries: [], stateProvinces: [],
    cities: [], postalCodes: [], companyNames: [], companyDomains: [], keywords: [], technologies: [],
  };
}

// Re-exported for the registry's classification of REST failures in tests.
export { classifyHttpFailure as _classifyHttpFailure };
