/**
 * msgraph — Velocity's own Microsoft Graph OAuth + fetch layer.
 *
 * Exists because the product's Outlook connection rides Unipile, which
 * bridges MAIL only — OneNote (Notes.ReadWrite) and OneDrive
 * (Files.ReadWrite) need a first-party Azure app. Config is two env vars on
 * Railway (MS_GRAPH_CLIENT_ID / MS_GRAPH_CLIENT_SECRET, multi-tenant
 * "common" endpoint); every entry point fails CLOSED with a message naming
 * the missing var rather than half-working.
 *
 * Token model: the refresh token is the only credential persisted
 * (AES-256-GCM via _core/crypto). Access tokens live in a per-connection
 * in-memory cache and are refreshed on demand — a restart just refreshes
 * again. Microsoft rotates refresh tokens on use, so every refresh writes
 * the replacement back; dropping it would strand the connection within 90
 * days.
 */
import { SignJWT, jwtVerify } from "jose";
import { and, eq } from "drizzle-orm";
import { getDb } from "../db";
import { graphConnections, type GraphConnection } from "../../drizzle/schema";
import { encryptSecret, tryDecryptSecret } from "../_core/crypto";
import { appBaseUrl as publicAppOrigin } from "../appUrl";

// Calendars.ReadWrite was added BEFORE any connection existed, so no user
// ever needs an incremental re-consent — the first connect grants all four.
export const GRAPH_SCOPES = "offline_access User.Read Notes.ReadWrite Files.ReadWrite Calendars.ReadWrite";
const AUTH_BASE = "https://login.microsoftonline.com/common/oauth2/v2.0";
export const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

export function graphEnvConfigured(): boolean {
  return !!process.env.MS_GRAPH_CLIENT_ID && !!process.env.MS_GRAPH_CLIENT_SECRET;
}

export function graphRedirectUri(): string {
  return `${publicAppOrigin()}/api/graph/callback`;
}

function stateSecret(): Uint8Array {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error("JWT_SECRET is not set");
  return new TextEncoder().encode(s);
}

/** Short-lived signed state → the callback can trust userId/workspaceId
 *  without a session cookie surviving the Microsoft round-trip. */
export async function signOAuthState(payload: { userId: number; workspaceId: number }): Promise<string> {
  return new SignJWT({ u: payload.userId, w: payload.workspaceId, p: "msgraph" })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setExpirationTime(Math.floor(Date.now() / 1000) + 15 * 60)
    .sign(stateSecret());
}

export async function verifyOAuthState(state: string): Promise<{ userId: number; workspaceId: number } | null> {
  try {
    const { payload } = await jwtVerify(state, stateSecret(), { algorithms: ["HS256"] });
    if (payload.p !== "msgraph" || typeof payload.u !== "number" || typeof payload.w !== "number") return null;
    return { userId: payload.u, workspaceId: payload.w };
  } catch {
    return null;
  }
}

export async function buildAuthorizeUrl(state: string): Promise<string> {
  const q = new URLSearchParams({
    client_id: process.env.MS_GRAPH_CLIENT_ID ?? "",
    response_type: "code",
    redirect_uri: graphRedirectUri(),
    response_mode: "query",
    scope: GRAPH_SCOPES,
    state,
  });
  return `${AUTH_BASE}/authorize?${q}`;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

async function tokenRequest(body: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(`${AUTH_BASE}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.MS_GRAPH_CLIENT_ID ?? "",
      client_secret: process.env.MS_GRAPH_CLIENT_SECRET ?? "",
      ...body,
    }),
  });
  return (await res.json().catch(() => ({}))) as TokenResponse;
}

export async function exchangeCode(code: string): Promise<TokenResponse> {
  return tokenRequest({
    grant_type: "authorization_code",
    code,
    redirect_uri: graphRedirectUri(),
    scope: GRAPH_SCOPES,
  });
}

/** access-token cache: connectionId → { token, exp } */
const tokenCache = new Map<number, { token: string; exp: number }>();

export async function getAccessToken(conn: GraphConnection): Promise<string> {
  const cached = tokenCache.get(conn.id);
  if (cached && cached.exp > Date.now() + 60_000) return cached.token;

  const refresh = tryDecryptSecret(conn.refreshTokenEnc);
  if (!refresh) throw new Error("Microsoft connection has no usable refresh token — reconnect on Connected Accounts.");
  const res = await tokenRequest({ grant_type: "refresh_token", refresh_token: refresh, scope: GRAPH_SCOPES });
  if (!res.access_token) {
    // A dead refresh token means the connection is over (revoked, expired,
    // password reset). Mark it so the UI says "reconnect" instead of every
    // caller failing opaquely forever.
    const db = await getDb();
    if (db) {
      await db.update(graphConnections).set({ status: "error" }).where(eq(graphConnections.id, conn.id));
    }
    throw new Error(`Microsoft token refresh failed: ${res.error_description ?? res.error ?? "unknown"}`);
  }
  tokenCache.set(conn.id, { token: res.access_token, exp: Date.now() + (res.expires_in ?? 3600) * 1000 });
  // Microsoft ROTATES refresh tokens — persist the replacement or the
  // connection strands itself when the old one ages out.
  if (res.refresh_token && res.refresh_token !== refresh) {
    const db = await getDb();
    if (db) {
      await db.update(graphConnections)
        .set({ refreshTokenEnc: encryptSecret(res.refresh_token), status: "active" })
        .where(eq(graphConnections.id, conn.id));
    }
  }
  return res.access_token;
}

/** Authenticated Graph call. Returns the parsed JSON; throws with Graph's
 *  own error message on non-2xx (those messages are usually the diagnosis). */
export async function graphFetch<T = unknown>(
  conn: GraphConnection,
  path: string,
  init?: RequestInit & { rawBody?: Buffer | string },
): Promise<T> {
  const token = await getAccessToken(conn);
  const url = path.startsWith("http") ? path : `${GRAPH_BASE}${path}`;
  const res = await fetch(url, {
    ...init,
    body: (init?.rawBody ?? init?.body) as never,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init?.headers ?? {}),
    },
  });
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = (body as { error?: { message?: string } } | null)?.error?.message ?? `Graph HTTP ${res.status}`;
    throw new Error(msg);
  }
  return body as T;
}

export async function getConnection(workspaceId: number, userId: number): Promise<GraphConnection | null> {
  const db = await getDb();
  if (!db) return null;
  const [conn] = await db.select().from(graphConnections)
    .where(and(eq(graphConnections.workspaceId, workspaceId), eq(graphConnections.userId, userId)))
    .limit(1);
  return conn ?? null;
}

export function clearTokenCache(connectionId: number): void {
  tokenCache.delete(connectionId);
}
