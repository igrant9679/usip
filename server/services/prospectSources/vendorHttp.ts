/**
 * vendorHttp — the ONE outbound HTTP path for prospect-data vendors.
 *
 * Every vendor client in this repo used to hand-roll fetch + timeout with a
 * different error shape ({ok,error} here, a throw there, "" elsewhere) and no
 * retry, so a 429 on one vendor read as "not found" and a transient 503
 * became a permanent miss. This module gives every adapter:
 *
 *   - one classified failure vocabulary (types.VendorFailureReason);
 *   - retry with exponential backoff + jitter on transient failures, honouring
 *     Retry-After / retry_after_seconds when the vendor supplies one;
 *   - a per-call log line carrying workspace, source, endpoint, duration,
 *     status and units — and NEVER the credential or a response body with PII.
 *
 * Retries are bounded (3 attempts, ≤ ~8s total by default) so a waterfall
 * step cannot stall an engine tick; the circuit breaker (circuit.ts) handles
 * the "vendor is down for an hour" case above this layer.
 */
import type { VendorFailure, VendorFailureReason } from "./types";

export interface VendorCallLog {
  workspaceId: number;
  source: string;
  endpoint: string;
  durationMs: number;
  status: number | "network";
  ok: boolean;
  units?: number;
  reason?: VendorFailureReason;
}

/** Overridable for tests; production writes one console line per call. */
export let logVendorCall: (entry: VendorCallLog) => void = (e) => {
  console.log(
    `[vendor] ws=${e.workspaceId} ${e.source} ${e.endpoint} ${e.status} ${e.ok ? "ok" : `FAIL:${e.reason ?? "?"}`} ${e.durationMs}ms` +
    (e.units != null ? ` units=${e.units}` : ""),
  );
};
export function setVendorCallLogger(fn: typeof logVendorCall): void {
  logVendorCall = fn;
}

/** Classify an HTTP status + optional vendor error code into our vocabulary. */
export function classifyHttpFailure(status: number, code?: string | null): VendorFailureReason {
  const c = (code ?? "").toLowerCase();
  if (c === "insufficient_scope") return "insufficient_scope";
  if (c === "unauthorized" || status === 401) return "unauthorized";
  if (c === "plan_upgrade_required" || c === "verifier_access_required" && status === 402) return "plan_required";
  if (c === "allowance_exhausted" || c === "exceeds_today" || c === "prospect_limit_reached") return "budget_exhausted";
  if (c === "rate_limited" || c === "verification_rate_limited" || status === 429) return "rate_limited";
  if (c === "temporarily_unavailable" || status === 503 || status === 502 || status === 504 || status === 500) return "unavailable";
  if (c === "validation_error" || c === "invalid_params" || status === 400 || status === 422) return "invalid_params";
  if (status === 403) return "insufficient_scope";
  return "http";
}

export function isRetryable(reason: VendorFailureReason): boolean {
  return reason === "rate_limited" || reason === "unavailable";
}

/** Backoff for attempt n (0-based): 400ms, 1.2s, 3.6s … with ±25% jitter. */
export function backoffMs(attempt: number, base = 400, cap = 8000): number {
  const raw = Math.min(cap, base * Math.pow(3, attempt));
  const jitter = raw * 0.25 * (Math.random() * 2 - 1);
  return Math.max(50, Math.round(raw + jitter));
}

export interface VendorFetchOptions {
  workspaceId: number;
  source: string;
  /** Short label for the log line — never the full URL with query values. */
  endpoint: string;
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
  /** Max attempts including the first. */
  attempts?: number;
  /** Pull the vendor's error code out of a failed JSON body. */
  errorCode?: (json: unknown) => string | null | undefined;
  /** Pull retry-after seconds out of a failed JSON body. */
  retryAfter?: (json: unknown) => number | null | undefined;
  /** Test seam: replaces global fetch. */
  fetchImpl?: typeof fetch;
  /** Test seam: replaces the sleep between attempts. */
  sleep?: (ms: number) => Promise<void>;
}

export interface VendorFetchOk<T> {
  ok: true;
  status: number;
  json: T;
  headers: Headers;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Fetch with classification + bounded retry. Resolves to a typed success or
 * a VendorFailure; never throws for HTTP outcomes. A body that is not JSON
 * is returned as `{ raw: string }` so a vendor's HTML error page is still a
 * classified failure rather than a crash.
 */
export async function vendorFetch<T = unknown>(
  url: string,
  opts: VendorFetchOptions,
): Promise<VendorFetchOk<T> | VendorFailure> {
  const attempts = Math.max(1, opts.attempts ?? 3);
  const f = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? defaultSleep;
  let last: VendorFailure = { ok: false, reason: "unavailable", message: "no attempt made" };
  for (let attempt = 0; attempt < attempts; attempt++) {
    const t0 = Date.now();
    let res: Response;
    try {
      res = await f(url, {
        method: opts.method ?? "GET",
        headers: {
          Accept: "application/json",
          ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...(opts.headers ?? {}),
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000),
      });
    } catch (e) {
      last = { ok: false, reason: "unavailable", message: `network: ${(e as Error)?.message ?? String(e)}` };
      logVendorCall({ workspaceId: opts.workspaceId, source: opts.source, endpoint: opts.endpoint, durationMs: Date.now() - t0, status: "network", ok: false, reason: "unavailable" });
      if (attempt < attempts - 1) await sleep(backoffMs(attempt));
      continue;
    }
    const durationMs = Date.now() - t0;
    let json: unknown = null;
    const text = await res.text().catch(() => "");
    if (text) {
      try { json = JSON.parse(text); } catch { json = { raw: text }; }
    }
    if (res.ok) {
      logVendorCall({ workspaceId: opts.workspaceId, source: opts.source, endpoint: opts.endpoint, durationMs, status: res.status, ok: true });
      return { ok: true, status: res.status, json: json as T, headers: res.headers };
    }
    const code = opts.errorCode ? opts.errorCode(json) : defaultErrorCode(json);
    const reason = classifyHttpFailure(res.status, code);
    const headerRetry = Number(res.headers.get("retry-after") ?? "");
    const bodyRetry = opts.retryAfter ? opts.retryAfter(json) : defaultRetryAfter(json);
    const retryAfterSeconds = Number.isFinite(headerRetry) && headerRetry > 0
      ? headerRetry
      : (bodyRetry != null && bodyRetry > 0 ? bodyRetry : undefined);
    last = {
      ok: false,
      reason,
      status: res.status,
      message: `${res.status}${code ? ` ${code}` : ""}${defaultMessage(json) ? ` — ${defaultMessage(json)}` : ""}`,
      ...(retryAfterSeconds != null ? { retryAfterSeconds } : {}),
    };
    logVendorCall({ workspaceId: opts.workspaceId, source: opts.source, endpoint: opts.endpoint, durationMs, status: res.status, ok: false, reason });
    if (!isRetryable(reason) || attempt >= attempts - 1) return last;
    // Rate limits say how long to wait; cap it so one call can't hold a
    // tick for a minute — beyond that the circuit breaker is the right tool.
    const wait = retryAfterSeconds != null ? Math.min(retryAfterSeconds * 1000, 10_000) : backoffMs(attempt);
    await sleep(wait);
  }
  return last;
}

function defaultErrorCode(json: unknown): string | null {
  if (!json || typeof json !== "object") return null;
  const j = json as Record<string, unknown>;
  const err = j.error;
  if (err && typeof err === "object" && typeof (err as Record<string, unknown>).code === "string") {
    return (err as Record<string, unknown>).code as string;
  }
  if (typeof j.code === "string") return j.code;
  if (typeof j.error === "string") return j.error;
  return null;
}

function defaultRetryAfter(json: unknown): number | null {
  if (!json || typeof json !== "object") return null;
  const j = json as Record<string, unknown>;
  const err = (j.error && typeof j.error === "object" ? j.error : j) as Record<string, unknown>;
  const v = err.retry_after_seconds ?? err.retryAfterSeconds;
  return typeof v === "number" ? v : null;
}

function defaultMessage(json: unknown): string {
  if (!json || typeof json !== "object") return "";
  const j = json as Record<string, unknown>;
  const err = j.error;
  if (err && typeof err === "object" && typeof (err as Record<string, unknown>).message === "string") {
    return String((err as Record<string, unknown>).message).slice(0, 200);
  }
  if (typeof j.message === "string") return j.message.slice(0, 200);
  return "";
}
