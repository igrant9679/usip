/**
 * QuickEnrich client — key resolution and the one call the app makes today.
 *
 * QuickEnrich (quickenrich.io) is a B2B contact database keyed on LinkedIn
 * URLs, being evaluated as a prospect SOURCE for ARE campaigns: their
 * contact-finder discovery endpoint is free and returns has_email/has_phone
 * flags without the values, so a sourcing funnel can know its hit rate before
 * spending. Email delivery is 1 credit only on success ($0.004/record).
 *
 * CONSUMERS (each function here exists because one of these calls it):
 *   - quickenrich.test (router) → quickenrichTestKey
 *   - the enrichment sweep's QuickEnrich pass → quickenrichFindEmailByLinkedIn,
 *     for queue rows a pattern can never reach (LinkedIn URL, no domain).
 *
 * Two invariants the sweep pass holds, recorded where the client lives:
 *   - a QuickEnrich-supplied address is NEVER send-safe on their word — their
 *     "email_verification_date" is a freshness claim about their database, not
 *     an independent check. Reoon power verification before
 *     promoteVerifiedProspect stays the gate, exactly as for pattern-derived
 *     addresses. QuickEnrich replaces the GUESSING step, not the verifying one.
 *   - spend rides the sweep's existing daily cap (one attempt = at most one
 *     credit, charged only on delivery). There is no balance check because
 *     their API publishes no balance endpoint — the cap is the only brake, and
 *     saying so here beats implying a safety net that does not exist.
 */
import { eq } from "drizzle-orm";
import { workspaceSettings } from "../../drizzle/schema";
import { getDb } from "../db";
import { tryDecryptSecret } from "../_core/crypto";

export const QUICKENRICH_BASE = "https://app.quickenrich.io";

/**
 * Workspace key first, env fallback, "" when neither — the exact contract of
 * getReoonKey/getApolloKey, so every integration answers "which key am I on?"
 * the same way and the settings card can honestly report the source.
 */
export async function getQuickEnrichKey(workspaceId?: number | null): Promise<string> {
  if (workspaceId) {
    try {
      const db = await getDb();
      if (db) {
        const [row] = await db
          .select({ enc: workspaceSettings.quickenrichApiKeyEnc })
          .from(workspaceSettings)
          .where(eq(workspaceSettings.workspaceId, workspaceId))
          .limit(1);
        const key = tryDecryptSecret(row?.enc);
        if (key) return key;
      }
    } catch (e) {
      console.error("[quickenrich] key lookup failed, falling back to env:", (e as Error).message);
    }
  }
  return process.env.QUICKENRICH_API_KEY ?? "";
}

export type QuickEnrichTestResult = {
  ok: boolean;
  /** HTTP status from their API — surfaced so "invalid key" (401) reads differently from "their API is down" (5xx). */
  status: number;
  /** Rows on page 1 of the probe search, when the response shape was recognisable. */
  sampleRows: number | null;
  message: string;
};

/**
 * Prove the key works, without spending anything.
 *
 * Their docs publish no balance endpoint (unlike Reoon), so the cheapest
 * honest test is a real call to the one endpoint documented as costing 0
 * credits: contact-finder. A minimal single-filter query establishes that the
 * key authenticates and the account is live. A 401/403 is a bad key; anything
 * 2xx proves the connection regardless of how many rows match.
 */
export type QuickEnrichLookup = {
  /** The address their database returned, or null on any kind of miss. */
  email: string | null;
  /** Why null, when it is: distinguishes "not in their DB" from "call failed". */
  reason: "found" | "no_match" | "http_error" | "network_error" | "unrecognised_shape";
};

/** Track whether we've already dumped one unrecognised body this process — one
 *  sample is diagnosis, one per row is log spam across a 25-row sweep. */
let loggedUnrecognisedShape = false;

/**
 * Look up an email by LinkedIn URL — the one query their database is keyed on,
 * and the reason this vendor fits this backlog: the stuck rows have a LinkedIn
 * URL and nothing else usable. 1 credit, charged by them only when an email is
 * returned. Never throws: a sweep must not abort on row 7 of 25.
 *
 * ⚠️ ENVELOPE IS INFERRED. Their docs name the fields (email, first/last,
 * title…) but not the wrapper, so this recognises the common shapes and treats
 * an unrecognised 200 as a MISS after logging one raw sample — the
 * producer/consumer field-drift class, handled by admitting uncertainty at the
 * read instead of trusting a guessed schema.
 */
export async function quickenrichFindEmailByLinkedIn(
  apiKey: string,
  linkedinUrl: string,
): Promise<QuickEnrichLookup> {
  try {
    const res = await fetch(
      `${QUICKENRICH_BASE}/api/employees/search?linkedin_url=${encodeURIComponent(linkedinUrl)}`,
      {
        headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (res.status === 404) return { email: null, reason: "no_match" };
    if (!res.ok) return { email: null, reason: "http_error" };

    let json: unknown;
    try {
      json = await res.json();
    } catch {
      return { email: null, reason: "unrecognised_shape" };
    }

    // Common envelopes: bare object, {data: {...}}, {data: [...]}, {results: [...]}.
    const j = json as Record<string, unknown>;
    const candidates: unknown[] = [
      j,
      j.data,
      Array.isArray(j.data) ? j.data[0] : undefined,
      Array.isArray(j.results) ? j.results[0] : undefined,
      Array.isArray(j.employees) ? j.employees[0] : undefined,
    ];
    for (const c of candidates) {
      if (!c || typeof c !== "object") continue;
      const rec = c as Record<string, unknown>;
      const email = [rec.email, rec.work_email, rec.professional_email]
        .find((v): v is string => typeof v === "string" && v.includes("@"));
      if (email) return { email: email.trim().toLowerCase(), reason: "found" };
    }
    // A 200 with no recognisable address is a miss ("has no email for this
    // person") unless the shape is entirely alien — then say so, once.
    const keys = Object.keys(j);
    if (keys.length > 0 && !("data" in j) && !("results" in j) && !("employees" in j) && !("email" in j)) {
      if (!loggedUnrecognisedShape) {
        loggedUnrecognisedShape = true;
        console.warn("[quickenrich] unrecognised response shape, keys:", keys.slice(0, 12).join(","));
      }
      return { email: null, reason: "unrecognised_shape" };
    }
    return { email: null, reason: "no_match" };
  } catch {
    return { email: null, reason: "network_error" };
  }
}

export async function quickenrichTestKey(apiKey: string): Promise<QuickEnrichTestResult> {
  try {
    const res = await fetch(`${QUICKENRICH_BASE}/api/employees/contact-finder`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ filters: { title: { include: ["CEO"] } }, page: 1 }),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, status: res.status, sampleRows: null, message: "QuickEnrich rejected that key." };
    }
    if (!res.ok) {
      return { ok: false, status: res.status, sampleRows: null, message: `QuickEnrich answered HTTP ${res.status}.` };
    }
    let sampleRows: number | null = null;
    try {
      const json = (await res.json()) as Record<string, unknown>;
      const rows = [json.data, json.results, json.items, json].find(Array.isArray);
      if (rows) sampleRows = rows.length;
    } catch {
      /* a 2xx with an unparseable body still proves the key authenticates */
    }
    return { ok: true, status: res.status, sampleRows, message: "Connected." };
  } catch (e) {
    return { ok: false, status: 0, sampleRows: null, message: `Could not reach QuickEnrich: ${(e as Error).message}` };
  }
}
