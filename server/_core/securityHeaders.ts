/**
 * Response headers every page and API answer carries.
 *
 * 🔴 THE GAP (audit 2026-10-20, "also urgent", verified with curl): no
 * Content-Security-Policy, no frame-ancestors or X-Frame-Options, no HSTS, no
 * nosniff, no Referrer-Policy, and `X-Powered-By: Express` announced the stack.
 * Without a framing rule any site could put the signed-in app in an invisible
 * frame and steer clicks into it — and the Manus runtime that shipped then
 * would take orders from that frame.
 *
 * FRAMING: refused everywhere except the pages a VISITOR sees, which customers
 * put on their own sites — the chat agent (/c/, the widget's iframe), public
 * forms (/f/), booking pages (/b/) and landing pages (/l/). None of them acts
 * with a member's session: the session cookie is SameSite=Lax, so a browser
 * does not send it into another site's frame at all.
 *
 * The CSP is deliberately narrow — framing, <base> and plugins. A script-src
 * policy needs every inline script and third-party origin the app loads
 * accounted for first, and a wrong one is an outage, not a hardening.
 */
import type { NextFunction, Request, Response } from "express";

const EMBEDDABLE = ["/c/", "/f/", "/b/", "/l/"];

export function isEmbeddablePath(path: string): boolean {
  return EMBEDDABLE.some((p) => path.startsWith(p));
}

function isHttps(req: Request): boolean {
  if (req.protocol === "https") return true;
  const fwd = req.headers["x-forwarded-proto"];
  const v = Array.isArray(fwd) ? fwd[0] : fwd;
  return typeof v === "string" && v.split(",")[0].trim().toLowerCase() === "https";
}

export function securityHeaders(req: Request, res: Response, next: NextFunction): void {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  // One year, this host only: includeSubDomains would bind every other
  // subdomain of the owner's domain to HTTPS, which is not this app's call.
  if (isHttps(req)) res.setHeader("Strict-Transport-Security", "max-age=31536000");
  const embeddable = isEmbeddablePath(req.path);
  res.setHeader(
    "Content-Security-Policy",
    `frame-ancestors ${embeddable ? "*" : "'none'"}; base-uri 'self'; object-src 'none'`,
  );
  if (!embeddable) res.setHeader("X-Frame-Options", "DENY");
  next();
}
