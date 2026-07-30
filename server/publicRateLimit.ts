/**
 * Rate limiting for the UNAUTHENTICATED public endpoints — two ceilings, for
 * two different costs: model spend, and abuse of the public write paths.
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

/**
 * Public procedures that WRITE, and whose abuse costs something other than
 * model spend. No login, no token, just the public slug:
 *
 *  - `bookingLinks.book` creates a meeting AND emails a calendar invite to an
 *    address the caller supplies. That is both calendar vandalism (a rep's
 *    horizon filled with junk) and a mail amplifier pointed at strangers.
 *    Slot re-validation bounds it to genuinely open times, so it is not
 *    unlimited — but "only as many junk meetings as you have free slots" is
 *    not a control.
 *  - `forms.submit` / `landingPages.submit` mint leads. Unbounded, they fill
 *    the CRM with rubbish the autonomous engines then act on.
 *
 * A separate, tighter ceiling from the LLM one: a person books once and
 * submits a form once. Ten a minute is already far past human.
 */
const PUBLIC_WRITE_PROCEDURES = [
  "bookingLinks.book",
  "forms.submit",
  "landingPages.submit",
];

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

export const publicWriteLimiter = rateLimit({
  windowMs: 60_000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: ipKey,
  handler: (_req: Request, res: Response) => {
    res.status(429).json({
      error: { message: "Too many submissions from this address — please wait a moment.", code: -32029 },
    });
  },
  skip: () => process.env.NODE_ENV === "test",
});

/** True when this tRPC request targets a public procedure that costs model spend. */
export function isMeteredPublicPath(path: string): boolean {
  return METERED_PUBLIC_PROCEDURES.some((p) => path.includes(p));
}

/** True when this tRPC request targets a public procedure that WRITES. */
export function isPublicWritePath(path: string): boolean {
  return PUBLIC_WRITE_PROCEDURES.some((p) => path.includes(p));
}

/**
 * The `/api/scheduled/*` cron endpoints.
 *
 * `requireScheduledSecret` gates them, but it FAILS OPEN when
 * SCHEDULED_TASK_SECRET is unset — deliberately, because the external
 * scheduler is the only trigger for two of the three. While it is unset this
 * ceiling is the only thing standing between an anonymous caller and a run
 * that mails clients and walks every workspace.
 *
 * A real scheduler hits these once a day. Ten a minute leaves that untouched.
 */
export const scheduledTaskLimiter = rateLimit({
  windowMs: 60_000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: ipKey,
  handler: (_req: Request, res: Response) => {
    res.status(429).json({ ok: false, error: "Too many scheduled-task calls from this address." });
  },
  skip: () => process.env.NODE_ENV === "test",
});

/**
 * Mount BEFORE the tRPC middleware AND before the route handlers being limited.
 *
 * ⚠️ Express runs middleware in REGISTRATION order. This used to be called at
 * index.ts:127, after registerEmailTrackingRoutes at :112 — fine while it only
 * touched /api/trpc (mounted later still), but a limiter registered after
 * `app.post("/api/scheduled/...")` never runs at all. It would have looked
 * mounted, reported nothing, and limited nothing: dead middleware, the same
 * shape as the dead wiring swept out of this repo already. The call site moved
 * up with the routes, and `_core/index.test.ts` fails if it drifts back down.
 */
export function registerPublicRateLimits(app: Express): void {
  app.use("/api/scheduled", (req: Request, res: Response, next: NextFunction) =>
    scheduledTaskLimiter(req, res, next),
  );
  app.use("/api/trpc", (req: Request, res: Response, next: NextFunction) => {
    const path = req.path ?? "";
    // Model spend first: it is the tighter concern and the higher ceiling.
    if (isMeteredPublicPath(path)) return publicLlmLimiter(req, res, next);
    if (isPublicWritePath(path)) return publicWriteLimiter(req, res, next);
    return next();
  });
}
