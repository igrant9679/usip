/**
 * Rate limiting for the UNAUTHENTICATED, LLM-backed public endpoints.
 *
 * `chatAgents.send` is reachable by anyone: no session, no login, just the
 * agent slug — which is published in the widget script on every page carrying
 * the chat bubble. Each call runs a model turn on the workspace's own API key.
 *
 * `MAX_MESSAGES` bounds one conversation at 60 turns, but nothing bounded how
 * many CONVERSATIONS a caller could start: post with no token, get a fresh
 * session and another model call, repeat. The cost lands on the workspace and
 * is invisible until the bill arrives. express-rate-limit was already a
 * dependency here, applied to password login and registration only — the tRPC
 * route had none at all.
 *
 * Scoped deliberately narrowly:
 *  - Only paths naming a public LLM procedure are limited. Authenticated app
 *    traffic shares `/api/trpc` and must not be throttled by this.
 *  - Keyed on the FIRST hop of x-forwarded-for, matching the existing auth
 *    limiters. That is the client as seen past our own proxy — it does NOT
 *    separate visitors sharing one corporate NAT, who share a bucket. The
 *    ceiling is set high enough that this only matters for a site sending
 *    hundreds of chat messages a minute from one egress IP, which is a nicer
 *    problem than the one being fixed.
 *  - The ceiling is far above human use. A visitor types a message every ten
 *    or twenty seconds; nobody legitimately sends 20 in a minute. Hitting this
 *    means automation, and 429 is the correct answer to automation here.
 */
import rateLimit from "express-rate-limit";
import type { Express, Request, Response, NextFunction } from "express";

/** Same shape as the auth limiters — first hop of x-forwarded-for, else socket. */
const ipKey = (req: Request) =>
  ((req.headers["x-forwarded-for"] as string) ?? req.socket?.remoteAddress ?? "unknown")
    .split(",")[0]
    .trim();

/**
 * Procedures that are BOTH public and cost money per call. Matched as a
 * substring of the tRPC path, which carries the procedure name (and may carry
 * several, comma-separated, when the client batches).
 */
const METERED_PUBLIC_PROCEDURES = ["chatAgents.send"];

export const publicLlmLimiter = rateLimit({
  windowMs: 60_000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: ipKey,
  handler: (_req: Request, res: Response) => {
    // Shaped like a tRPC error so the widget surfaces it instead of hanging.
    res.status(429).json({
      error: { message: "You're sending messages very quickly — please wait a moment.", code: -32029 },
    });
  },
  skip: () => process.env.NODE_ENV === "test",
});

/** True when this tRPC request targets a metered public procedure. */
export function isMeteredPublicPath(path: string): boolean {
  return METERED_PUBLIC_PROCEDURES.some((p) => path.includes(p));
}

/**
 * Mount BEFORE the tRPC middleware. A pass-through for everything else, so
 * signed-in users are unaffected.
 */
export function registerPublicRateLimits(app: Express): void {
  app.use("/api/trpc", (req: Request, res: Response, next: NextFunction) => {
    if (isMeteredPublicPath(req.path ?? "")) return publicLlmLimiter(req, res, next);
    return next();
  });
}
