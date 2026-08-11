/**
 * Reoon Email Verifier — shared client.
 *
 * Extracted from server/routers/emailVerification.ts so the scraper service
 * can verify pattern-generated email candidates without going through tRPC.
 *
 * Endpoints used:
 *   GET  /api/v1/verify                       — single-email (power mode)
 *   POST /api/v1/create-bulk-verification-task — async bulk
 *   GET  /api/v1/get-result-bulk-verification-task — poll bulk
 *   GET  /api/v1/check-account-balance        — quota check
 *
 * Pricing reminder (caller's responsibility): power-mode verification costs
 * 1 daily credit each. Plan caps are 4,500/day; respect that when batching.
 */

export type VerificationStatus =
  | "valid"
  | "accept_all"
  | "risky"
  | "invalid"
  | "unknown";

const REOON_BASE = "https://emailverifier.reoon.com/api/v1";

/** Reoon raw status → USIP normalized status. */
export function reoonStatusToUsip(reoonStatus: string): VerificationStatus {
  switch (reoonStatus) {
    case "safe":
      return "valid";
    case "catch_all":
      return "accept_all";
    case "role_account":
    case "disposable":
    case "inbox_full":
      return "risky";
    case "invalid":
    case "disabled":
    case "spamtrap":
      return "invalid";
    default:
      return "unknown";
  }
}

export const VERIFICATION_BADGE: Record<
  VerificationStatus,
  { label: string; color: string; bg: string }
> = {
  valid: { label: "Valid", color: "text-green-700", bg: "bg-green-100" },
  accept_all: { label: "Accept-All", color: "text-yellow-700", bg: "bg-yellow-100" },
  risky: { label: "Risky", color: "text-orange-700", bg: "bg-orange-100" },
  invalid: { label: "Invalid", color: "text-red-700", bg: "bg-red-100" },
  unknown: { label: "Unknown", color: "text-gray-500", bg: "bg-gray-100" },
};

export type ReoonVerifyResult = {
  email: string;
  status: string;
  overall_score: number;
  is_safe_to_send: boolean;
  is_valid_syntax: boolean;
  is_disposable: boolean;
  is_role_account: boolean;
  is_catch_all: boolean;
  is_deliverable: boolean;
  mx_accepts_mail: boolean;
};

export type ReoonBulkCreateResult = {
  status: string;
  task_id: number;
  count_submitted: number;
  count_duplicates_removed: number;
  count_processing: number;
};

export type ReoonBulkResult = {
  task_id: string;
  status: string;
  count_total: number;
  count_checked: number;
  progress_percentage: number;
  results?: Record<
    string,
    { status: string; is_safe_to_send: boolean; is_deliverable: boolean }
  >;
};

export type ReoonBalance = {
  api_status: string;
  remaining_daily_credits: number;
  remaining_instant_credits: number;
  status: string;
};

/** Read REOON_API_KEY from env. Throws a plain Error so callers can wrap. */
export function getReoonApiKey(): string {
  const key = process.env.REOON_API_KEY;
  if (!key) throw new Error("REOON_API_KEY not configured.");
  return key;
}

/**
 * The Reoon key for a workspace: its own BYOK column first, the process-wide
 * env var second, "" when neither is set.
 *
 * Migration 0131 made this per-workspace. The env fallback is not legacy
 * politeness — it is what lets an already-deployed instance keep verifying
 * while nobody has pasted a key into Settings yet. **Every** Reoon call site
 * must go through here: a key entered in Settings that only some of the app
 * honours is worse than no field at all.
 *
 * Returns "" rather than throwing — callers report `reoon_key_missing` as a
 * skip reason, and a missing key is a configuration state, not an exception.
 */
export async function getReoonKey(workspaceId?: number | null): Promise<string> {
  if (workspaceId) {
    try {
      const { getDb } = await import("../db");
      const { tryDecryptSecret } = await import("../_core/crypto");
      const { workspaceSettings } = await import("../../drizzle/schema");
      const { eq } = await import("drizzle-orm");
      const db = await getDb();
      if (db) {
        const [row] = await db
          .select({ enc: workspaceSettings.reoonApiKeyEnc, enabled: workspaceSettings.reoonVerificationEnabled })
          .from(workspaceSettings)
          .where(eq(workspaceSettings.workspaceId, workspaceId))
          .limit(1);
        // Reoon is the FINAL verification step and it is OPTIONAL (owner
        // ask 2026-08-11, migration 0157). Toggled off ⇒ behave exactly as
        // key-absent everywhere: candidates carry no verdict, are never
        // marked valid, never promote, never auto-send. This is the ONE
        // choke point — a toggle only some call sites honoured would be
        // the inert-settings bug all over again.
        if (row && row.enabled === false) return "";
        const plaintext = tryDecryptSecret(row?.enc);
        if (plaintext) return plaintext;
      }
    } catch (e) {
      console.error("[reoon] workspace key lookup failed:", (e as Error).message);
    }
  }
  return process.env.REOON_API_KEY ?? "";
}

export type ReoonMode = "power" | "quick";

/**
 * Single-email verification.
 *
 *   mode=power — Full SMTP probe; ~3–8s; consumes `daily_credits` (limited).
 *   mode=quick — Cached + syntax + MX + role-account/disposable checks;
 *                <1s; consumes `instant_credits` (cheap & abundant).
 *
 * Use quick as a pre-filter to drop obviously-invalid candidates, then
 * power on survivors. See server/services/scraper/index.ts for usage.
 */
export async function reoonVerifySingle(
  email: string,
  apiKey: string,
  mode: ReoonMode = "power",
): Promise<ReoonVerifyResult> {
  const timeoutMs = mode === "quick" ? 15_000 : 90_000;
  const url = `${REOON_BASE}/verify?email=${encodeURIComponent(email)}&key=${apiKey}&mode=${mode}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`Reoon API error: ${res.status}`);
  return (await res.json()) as ReoonVerifyResult;
}

export async function reoonCreateBulkTask(
  emails: string[],
  apiKey: string,
): Promise<ReoonBulkCreateResult> {
  const res = await fetch(`${REOON_BASE}/create-bulk-verification-task/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: `USIP bulk ${Date.now()}`, emails, key: apiKey }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Reoon bulk create error: ${res.status}`);
  return (await res.json()) as ReoonBulkCreateResult;
}

export async function reoonGetBulkResult(
  taskId: string,
  apiKey: string,
): Promise<ReoonBulkResult> {
  const url = `${REOON_BASE}/get-result-bulk-verification-task/?key=${apiKey}&task_id=${taskId}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`Reoon bulk result error: ${res.status}`);
  return (await res.json()) as ReoonBulkResult;
}

export async function reoonCheckBalance(apiKey: string): Promise<ReoonBalance> {
  const url = `${REOON_BASE}/check-account-balance/?key=${apiKey}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`Reoon balance error: ${res.status}`);
  return (await res.json()) as ReoonBalance;
}
