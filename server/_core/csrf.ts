/**
 * Cross-site request forgery: three locks, each for a different hole.
 *
 * 🔴 THE HOLE (audit 2026-10-20, C3). The session cookie went out
 * `SameSite=None`, so the browser attached it to requests that ANY website
 * started. tRPC v11 parses `multipart/form-data` bodies, and a form post is a
 * "simple" request that needs no CORS preflight — so a page on any domain
 * could submit a hidden form to /api/trpc and run a mutation as whoever was
 * signed in. The mutations with no input were the easiest: archive the
 * workspace, approve every proposed meeting, disconnect Graph.
 *
 *   1. `SameSite=Lax` on the cookie (`_core/cookies.ts`). The browser stops
 *      sending it on cross-site POSTs at all. This is the lock that matters.
 *   2. JSON only on /api/trpc writes. The app's own client always sends
 *      `application/json`, and a JSON body cannot be sent cross-origin without
 *      a preflight this server never answers. Form and text bodies get 415.
 *   3. An Origin check on cookie-carrying writes. `Lax` treats every subdomain
 *      of a site as "same site", so a page on some other subdomain would still
 *      get the cookie attached; the Origin header says where the page really
 *      is. A request with no Origin is let through — browsers send one on
 *      every cross-origin POST, so its absence means a server-to-server call
 *      (webhooks, SCIM), which carries no session cookie anyway.
 */
import type { NextFunction, Request, Response } from "express";
import { COOKIE_NAME } from "@shared/const";
import { appBaseUrl } from "../appUrl";

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function firstHeader(v: string | string[] | undefined): string {
  return (Array.isArray(v) ? v[0] : v ?? "").trim();
}

/** The hosts a same-origin request can name: this request's own, and the app's public one. */
function ownHosts(req: Request): Set<string> {
  const hosts = new Set<string>();
  const host = firstHeader(req.headers.host).toLowerCase();
  if (host) hosts.add(host);
  // The edge may rewrite Host on its way in; the original is then here.
  for (const h of firstHeader(req.headers["x-forwarded-host"]).split(",")) {
    const t = h.trim().toLowerCase();
    if (t) hosts.add(t);
  }
  try {
    hosts.add(new URL(appBaseUrl()).host.toLowerCase());
  } catch {
    /* no configured origin — the request's own host still counts */
  }
  return hosts;
}

/**
 * `true` when the Origin header names this app, `false` when it names anything
 * else (including the literal "null" a sandboxed frame sends), `null` when
 * there is no Origin header at all.
 */
export function originVerdict(req: Request): boolean | null {
  const origin = firstHeader(req.headers.origin);
  if (!origin) return null;
  let host: string;
  try {
    host = new URL(origin).host.toLowerCase();
  } catch {
    return false;
  }
  return ownHosts(req).has(host);
}

function carriesSession(req: Request): boolean {
  const cookie = firstHeader(req.headers.cookie);
  return cookie.split(";").some((c) => c.trim().startsWith(`${COOKIE_NAME}=`));
}

/** Shaped like a tRPC error so the app's client shows the message instead of failing to parse. */
function refuse(res: Response, status: number, message: string): void {
  res.status(status).json({ error: { message, code: -32600, data: { code: status === 415 ? "UNSUPPORTED_MEDIA_TYPE" : "FORBIDDEN", httpStatus: status } } });
}

/**
 * Mounted on /api/trpc, before the tRPC adapter. Reads are untouched: tRPC
 * refuses a mutation sent as GET on its own.
 */
export function trpcCsrfGuard(req: Request, res: Response, next: NextFunction): void {
  if (!WRITE_METHODS.has(req.method)) return next();
  const type = firstHeader(req.headers["content-type"]).toLowerCase();
  if (!type.startsWith("application/json")) {
    return refuse(res, 415, "Requests to this API must be sent as JSON.");
  }
  if (originVerdict(req) === false) {
    return refuse(res, 403, "Cross-site request refused.");
  }
  next();
}

/**
 * Mounted on every route, ahead of all of them: a write that carries the
 * session cookie must come from this app's own pages. Writes without the
 * cookie (webhooks, the public widget endpoints, SCIM's bearer token) are not
 * this guard's business.
 */
export function crossSiteCookieWriteGuard(req: Request, res: Response, next: NextFunction): void {
  if (!WRITE_METHODS.has(req.method)) return next();
  if (!carriesSession(req)) return next();
  if (originVerdict(req) === false) {
    return refuse(res, 403, "Cross-site request refused.");
  }
  next();
}
