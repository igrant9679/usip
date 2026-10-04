/**
 * plivo.ts — Plivo REST client and webhook signature checks.
 *
 * Plivo places the AI agents' outbound calls and answers calls to their
 * numbers (owner 2026-10-04: "Go with Think Fast 2.0 and Plivo"). Each
 * workspace brings its own account (Auth ID + Auth Token, AES-GCM like every
 * BYOK key). Velocity creates one Plivo Application per workspace whose
 * answer/hangup URLs point here, and assigns the agents' numbers to it, so
 * nobody pastes a webhook URL into Plivo's console.
 *
 * API facts used here (docs.plivo.com + plivo-node source, checked
 * 2026-10-04): JSON bodies, HTTP Basic auth; POST /Call/ answers with a
 * request_uuid (no CallUUID); DELETE /Call/{uuid}/ hangs up, and with NO uuid
 * hangs up EVERY live call on the account, hence the guard in hangupCall.
 */
import crypto from "crypto";
import { eq } from "drizzle-orm";
import { workspaceSettings } from "../../drizzle/schema";
import { getDb } from "../db";
import { tryDecryptSecret } from "../_core/crypto";
import { appBaseUrl } from "../appUrl";

const API = "https://api.plivo.com/v1/Account";

export type PlivoCreds = { authId: string; authToken: string };

export async function plivoCreds(workspaceId: number): Promise<PlivoCreds | null> {
  const db = await getDb();
  if (!db) return null;
  const [row] = await db
    .select({ id: workspaceSettings.plivoAuthId, enc: workspaceSettings.plivoAuthTokenEnc })
    .from(workspaceSettings)
    .where(eq(workspaceSettings.workspaceId, workspaceId))
    .limit(1);
  const authToken = tryDecryptSecret(row?.enc);
  return row?.id && authToken ? { authId: row.id, authToken } : null;
}

export class PlivoError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

async function call<T = any>(creds: PlivoCreds, method: "GET" | "POST" | "DELETE", path: string, body?: Record<string, unknown>): Promise<T> {
  const url = `${API}/${encodeURIComponent(creds.authId)}/${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Basic ${Buffer.from(`${creds.authId}:${creds.authToken}`).toString("base64")}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return {} as T;
  const text = await res.text().catch(() => "");
  let data: any = null;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text.slice(0, 200) }; }
  if (!res.ok) {
    const msg = typeof data?.error === "string" ? data.error : typeof data?.message === "string" ? data.message : `HTTP ${res.status}`;
    throw new PlivoError(`Plivo: ${msg}`, res.status);
  }
  return data as T;
}

/** Connection test: the account itself (401 on bad credentials). */
export async function getAccount(creds: PlivoCreds): Promise<{ name?: string; cash_credits?: string; account_type?: string }> {
  return call(creds, "GET", "");
}

/** The account's voice numbers, as E.164. */
export async function listNumbers(creds: PlivoCreds): Promise<{ number: string; alias: string | null; appAssigned: string | null; voiceEnabled: boolean }[]> {
  const out: { number: string; alias: string | null; appAssigned: string | null; voiceEnabled: boolean }[] = [];
  for (let offset = 0; offset < 200; offset += 20) {
    const page = await call<{ objects?: any[]; meta?: { total_count?: number } }>(creds, "GET", `Number/?limit=20&offset=${offset}`);
    for (const n of page.objects ?? []) {
      const digits = String(n.number ?? "").replace(/\D/g, "");
      if (!digits) continue;
      out.push({
        number: `+${digits}`,
        alias: n.alias ?? null,
        appAssigned: typeof n.application === "string" ? n.application : null,
        voiceEnabled: n.voice_enabled !== false,
      });
    }
    if (!page.objects || page.objects.length < 20) break;
  }
  return out;
}

/** The webhook URLs for one workspace. The signature covers the whole URL, query included. */
export function plivoUrls(workspaceId: number, callRowId?: number) {
  const base = appBaseUrl();
  const q = `ws=${workspaceId}${callRowId ? `&call=${callRowId}` : ""}`;
  return {
    answer: `${base}/api/voice/plivo/answer?${q}`,
    hangup: `${base}/api/voice/plivo/hangup?${q}`,
  };
}

/**
 * Create (or bring up to date) the workspace's Plivo Application, whose
 * answer/hangup URLs are Velocity's. hangup_url is set explicitly: left out,
 * Plivo posts hangups to the answer URL.
 */
export async function ensureApplication(workspaceId: number, creds: PlivoCreds, existingAppId: string | null): Promise<string> {
  const urls = plivoUrls(workspaceId);
  const body = { answer_url: urls.answer, answer_method: "POST", hangup_url: urls.hangup, hangup_method: "POST" };
  if (existingAppId) {
    try {
      await call(creds, "POST", `Application/${encodeURIComponent(existingAppId)}/`, body);
      return existingAppId;
    } catch (e) {
      if (!(e instanceof PlivoError && e.status === 404)) throw e;
    }
  }
  const created = await call<{ app_id?: string }>(creds, "POST", "Application/", { app_name: `velocity_ws_${workspaceId}`, ...body });
  if (!created.app_id) throw new PlivoError("Plivo did not return an application id", 500);
  return String(created.app_id);
}

/** Point a number at the application: its calls now come to Velocity. */
export async function assignNumber(creds: PlivoCreds, e164: string, appId: string): Promise<void> {
  const digits = e164.replace(/\D/g, "");
  if (!digits) throw new PlivoError("No number given", 400);
  await call(creds, "POST", `Number/${digits}/`, { app_id: appId });
}

export type PlaceCall = {
  from: string;
  to: string;
  answerUrl: string;
  hangupUrl: string;
  /** Seconds from answer; Plivo hangs up at this point whatever Velocity does. */
  timeLimit: number;
  ringTimeout?: number;
  callerName?: string;
};

/**
 * Dial. machine_detection "hangup": Plivo ends the call itself when it hears
 * voicemail and reports Machine=true to the hangup URL. Velocity does not
 * leave AI voicemails.
 */
export async function placeCall(creds: PlivoCreds, p: PlaceCall): Promise<{ requestUuid: string }> {
  const res = await call<{ request_uuid?: string }>(creds, "POST", "Call/", {
    from: p.from.replace(/[^\d+]/g, ""),
    to: p.to.replace(/[^\d+]/g, ""),
    answer_url: p.answerUrl,
    answer_method: "POST",
    hangup_url: p.hangupUrl,
    hangup_method: "POST",
    time_limit: p.timeLimit,
    ring_timeout: p.ringTimeout ?? 30,
    machine_detection: "hangup",
    machine_detection_time: 3500,
    ...(p.callerName ? { caller_name: p.callerName.slice(0, 50) } : {}),
  });
  return { requestUuid: String(res.request_uuid ?? "") };
}

/**
 * Hang up ONE call. Refuses an empty uuid: Plivo's DELETE /Call/ with no
 * uuid disconnects every live call on the account.
 */
export async function hangupCall(creds: PlivoCreds, callUuid: string | null | undefined): Promise<void> {
  const uuid = String(callUuid ?? "").trim();
  if (!uuid || !/^[A-Za-z0-9-]+$/.test(uuid)) return;
  await call(creds, "DELETE", `Call/${uuid}/`).catch(() => {});
}

/* ── Signature V3 (plivo-node lib/utils/v3Security.js, reimplemented) ──── */

/**
 * The string Plivo signs for a POST: the URL without query, then "?" and the
 * sorted decoded query, then "." and the sorted body params as key+value with
 * no separators; or "?" + params when there is no query. Then "." + nonce.
 */
export function v3BaseString(url: string, params: Record<string, unknown>, nonce: string): string {
  // Exactly the URL string Plivo was given, up to the query; the query is
  // decoded and re-sorted, as the SDK does.
  const raw = url.split("#")[0];
  const qi = raw.indexOf("?");
  const base = qi >= 0 ? raw.slice(0, qi) : raw;
  const query: [string, string][] = [];
  new URLSearchParams(qi >= 0 ? raw.slice(qi + 1) : "").forEach((v, k) => query.push([k, v]));
  const qKeys = Array.from(new Set(query.map(([k]) => k))).sort();
  const sortedQuery = qKeys
    .flatMap((k) => query.filter(([kk]) => kk === k).map(([, v]) => v).sort().map((v) => `${k}=${v}`))
    .join("&");
  const pKeys = Object.keys(params).sort();
  const paramString = pKeys
    .map((k) => {
      const v = params[k];
      return Array.isArray(v) ? v.map(String).sort().map((x) => `${k}${x}`).join("") : `${k}${String(v ?? "")}`;
    })
    .join("");
  const hasParams = pKeys.length > 0;
  let s = base;
  if (sortedQuery || hasParams) s += `?${sortedQuery}`;
  if (sortedQuery && hasParams) s += ".";
  s += paramString;
  return `${s}.${nonce}`;
}

export function v3Signature(url: string, params: Record<string, unknown>, nonce: string, authToken: string): string {
  return crypto.createHmac("sha256", authToken).update(v3BaseString(url, params, nonce)).digest("base64");
}

/** True when any comma-separated signature in the header matches. Constant-time compare. */
export function verifyV3(url: string, params: Record<string, unknown>, nonce: string, header: string, authToken: string): boolean {
  if (!nonce || !header || !authToken) return false;
  const expected = Buffer.from(v3Signature(url, params, nonce, authToken));
  return header.split(",").some((sig) => {
    const got = Buffer.from(sig.trim());
    return got.length === expected.length && crypto.timingSafeEqual(got, expected);
  });
}

/**
 * Nonces seen recently. Plivo sends no timestamp; it says the nonce is
 * unique per request, so a repeated nonce is a replay.
 */
const seenNonces = new Map<string, number>();
const NONCE_TTL_MS = 30 * 60 * 1000;
export function nonceIsFresh(nonce: string, nowMs = Date.now()): boolean {
  if (seenNonces.size > 5000) {
    seenNonces.forEach((exp, n) => { if (exp < nowMs) seenNonces.delete(n); });
  }
  const exp = seenNonces.get(nonce);
  if (exp && exp > nowMs) return false;
  seenNonces.set(nonce, nowMs + NONCE_TTL_MS);
  return true;
}
export function __resetNoncesForTests(): void {
  seenNonces.clear();
}

/* ── Stream tokens: who may open the audio socket ─────────────────────── */

/**
 * Plivo's WebSocket signing is not documented consistently enough to rely on
 * (which URL it signs varies between its own SDKs), so the stream URL
 * carries Velocity's own token: an HMAC over the call row and an expiry,
 * minted only after a signed answer request. Good for 2 minutes, one call.
 */
function tokenKey(): string {
  const k = process.env.ENCRYPTION_KEY || process.env.JWT_SECRET || "";
  if (!k && process.env.NODE_ENV === "production") throw new Error("No server secret for stream tokens");
  return `plivo-stream:${k || "dev-only"}`;
}

export function mintStreamToken(callRowId: number, nowMs = Date.now()): string {
  const exp = Math.floor(nowMs / 1000) + 120;
  const mac = crypto.createHmac("sha256", tokenKey()).update(`${callRowId}.${exp}`).digest("base64url");
  return `${exp}.${mac}`;
}

export function checkStreamToken(callRowId: number, token: string, nowMs = Date.now()): boolean {
  const [expStr, mac] = String(token ?? "").split(".");
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || !mac || exp * 1000 < nowMs) return false;
  const want = Buffer.from(crypto.createHmac("sha256", tokenKey()).update(`${callRowId}.${exp}`).digest("base64url"));
  const got = Buffer.from(mac);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

/** The <Stream> answer: two-way G.711 audio to Velocity's relay. */
export function streamXml(callRowId: number, nowMs = Date.now()): string {
  const base = appBaseUrl().replace(/^http/, "ws");
  const url = `${base}/api/voice/plivo/stream?c=${callRowId}&t=${encodeURIComponent(mintStreamToken(callRowId, nowMs))}`;
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n<Response>` +
    `<Stream bidirectional="true" keepCallAlive="true" contentType="audio/x-mulaw;rate=8000">` +
    `${url.replace(/&/g, "&amp;")}</Stream></Response>`
  );
}

/** A polite refusal when a call cannot be taken. */
export function hangupXml(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<Response><Hangup/></Response>`;
}
