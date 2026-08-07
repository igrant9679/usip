/**
 * QuickEnrich client — key resolution and the one call the app makes today.
 *
 * QuickEnrich (quickenrich.io) is a B2B contact database keyed on LinkedIn
 * URLs, being evaluated as a prospect SOURCE for ARE campaigns: their
 * contact-finder discovery endpoint is free and returns has_email/has_phone
 * flags without the values, so a sourcing funnel can know its hit rate before
 * spending. Email delivery is 1 credit only on success ($0.004/record).
 *
 * ⚠️ SURFACE IS DELIBERATELY MINIMAL. This module exports key resolution and a
 * connection test — nothing else, because nothing else has a caller yet. The
 * sourcing/enrichment functions arrive in the same commit as the engine pass
 * that consumes them (the dead-wiring rule: a finished feature with no caller
 * is this repo's dominant defect). When they do:
 *
 *   - a QuickEnrich-supplied address is NEVER send-safe on their word — their
 *     "email_verification_date" is a freshness claim about their database, not
 *     an independent check. Reoon power verification before
 *     promoteVerifiedProspect stays the gate, exactly as for pattern-derived
 *     addresses. QuickEnrich replaces the GUESSING step, not the verifying one.
 *   - spend goes behind a per-workspace daily cap column added with that pass.
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
