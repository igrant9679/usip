/**
 * The membership site's door into Velocity (owner, 2026-11-26: "enable
 * sign-up via the website, with new subscriber/membership creation handled on
 * the front end … Give me the 'plumbing'"). The contract is
 * shared/membership.ts; docs/membership-api.md is the same thing written for
 * whoever builds the website side.
 *
 *   GET  /api/membership/plans        open. The plans and what each includes.
 *   POST /api/membership/provision    signed. A membership was sold: make its
 *                                     workspace and owner. Safe to send twice.
 *   POST /api/membership/update       signed. The plan changed, or the
 *                                     membership ended or came back.
 *   POST /api/membership/status       signed. What Velocity holds for one.
 *   POST /api/membership/activation   signed. A fresh first-sign-in link.
 *
 * SERVER TO SERVER ONLY. The signed routes are called by the website's
 * server, never by a browser: the secret must not reach a page. No CORS
 * headers are sent, so a browser on another origin cannot read an answer.
 *
 * THE SIGNATURE. HMAC-SHA256 of `${timestamp}.${rawBody}` under
 * MEMBERSHIP_API_SECRET, sent as `X-Velocity-Signature: sha256=<hex>` with
 * `X-Velocity-Timestamp: <unix seconds>`. The timestamp is inside what is
 * signed and must be within five minutes of now, so a captured request cannot
 * be sent again later; within those minutes the routes change nothing a
 * second time (provision finds its workspace; update sets the same values).
 *
 * FAILS CLOSED. With no secret set, or one too short to be a secret, every
 * signed route answers 503 and does nothing. Unlike the cron gate
 * (scheduledTaskAuth, fail-open on purpose), nothing depends on these routes
 * until the owner sets the secret on both sides, so there is nothing to keep
 * running by letting strangers in. The check runs BEFORE the body is looked
 * at and before the database is touched.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Express, Request, Response } from "express";
import rateLimit from "express-rate-limit";
import { rateLimitKey } from "./_core/clientIp";
import {
  MEMBERSHIP_MAX_SKEW_SECONDS, MEMBERSHIP_SECRET_ENV, MEMBERSHIP_SECRET_MIN_LENGTH, MEMBERSHIP_SIGNATURE_HEADER,
  MEMBERSHIP_TIMESTAMP_HEADER, membershipSigningPayload, membershipSiteUrl, parseExternalId, parseProvision,
  parseUpdate, publicPlans, selfServeMode,
} from "@shared/membership";

export type SignatureCheck = { ok: true } | { ok: false; status: number; code: string; error: string };

/** The hex HMAC a request with this timestamp and body must carry. Exported so a test signs the way a caller would. */
export function signMembershipRequest(secret: string, timestamp: string, rawBody: string): string {
  return createHmac("sha256", secret).update(membershipSigningPayload(timestamp, rawBody), "utf8").digest("hex");
}

/** Whether the deployment has a usable secret. */
export function membershipSecretOf(env: NodeJS.ProcessEnv = process.env): string | null {
  const s = (env[MEMBERSHIP_SECRET_ENV] ?? "").trim();
  return s.length >= MEMBERSHIP_SECRET_MIN_LENGTH ? s : null;
}

/** Pure: is this request signed by the holder of the secret, recently? */
export function checkMembershipSignature(a: {
  secret: string | null;
  timestamp: string | undefined;
  signature: string | undefined;
  rawBody: string;
  nowMs: number;
}): SignatureCheck {
  if (!a.secret) {
    return { ok: false, status: 503, code: "not_configured", error: `The membership API is not switched on: ${MEMBERSHIP_SECRET_ENV} is not set on this deployment.` };
  }
  const ts = (a.timestamp ?? "").trim();
  const sig = (a.signature ?? "").trim().toLowerCase();
  if (!/^\d{9,11}$/.test(ts) || !sig) {
    return { ok: false, status: 401, code: "unsigned", error: `Send ${MEMBERSHIP_TIMESTAMP_HEADER} (unix seconds) and ${MEMBERSHIP_SIGNATURE_HEADER} (sha256=<hex>).` };
  }
  if (Math.abs(a.nowMs / 1000 - Number(ts)) > MEMBERSHIP_MAX_SKEW_SECONDS) {
    return { ok: false, status: 401, code: "stale", error: "The timestamp is more than five minutes from this server's clock. Sign the request again." };
  }
  const given = sig.startsWith("sha256=") ? sig.slice(7) : sig;
  const expected = signMembershipRequest(a.secret, ts, a.rawBody);
  const g = Buffer.from(given, "utf8");
  const e = Buffer.from(expected, "utf8");
  if (g.length !== e.length || !timingSafeEqual(g, e)) {
    return { ok: false, status: 401, code: "bad_signature", error: "The signature does not match this body and timestamp." };
  }
  return { ok: true };
}

const header = (req: Request, name: string): string | undefined => {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
};

/** True when the caller may proceed. On refusal the answer is already written: return at once. */
function requireSignature(req: Request, res: Response, route: string): boolean {
  const raw = (req as unknown as { rawBody?: Buffer }).rawBody;
  const check = checkMembershipSignature({
    secret: membershipSecretOf(),
    timestamp: header(req, MEMBERSHIP_TIMESTAMP_HEADER),
    signature: header(req, MEMBERSHIP_SIGNATURE_HEADER),
    rawBody: raw ? raw.toString("utf8") : "",
    nowMs: Date.now(),
  });
  if (check.ok) return true;
  if (check.status === 401) console.warn(`[membership] refused ${route}: ${check.code}`);
  res.status(check.status).json({ ok: false, code: check.code, error: check.error });
  return false;
}

/** The site's server is one caller; a real one never comes near this. */
const membershipLimiter = rateLimit({
  windowMs: 60_000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: rateLimitKey,
  handler: (_req: Request, res: Response) => {
    res.status(429).json({ ok: false, code: "rate_limited", error: "Too many membership calls from this address. Wait a minute." });
  },
  skip: () => process.env.NODE_ENV === "test",
});

/** Say a service failure the way it asked to be said; anything else is a plain 500 with no detail. */
async function answer(res: Response, route: string, run: () => Promise<Record<string, unknown>>): Promise<void> {
  const { MembershipError } = await import("./services/membership");
  try {
    res.json({ ok: true, ...(await run()) });
  } catch (e) {
    if (e instanceof MembershipError) {
      res.status(e.status).json({ ok: false, code: e.code, error: e.message });
      return;
    }
    console.error(`[membership] ${route} failed:`, e instanceof Error ? e.message : e);
    res.status(500).json({ ok: false, code: "failed", error: "Something went wrong on Velocity's side. Nothing was changed; try again." });
  }
}

export function registerMembershipRoutes(app: Express) {
  app.get("/api/membership/plans", membershipLimiter, (_req: Request, res: Response) => {
    res.setHeader("Cache-Control", "public, max-age=300");
    res.json({
      ok: true,
      plans: publicPlans(),
      // Whether someone can make their own Trial workspace inside the app, and where plans are bought.
      appSignUp: selfServeMode(process.env),
      membershipSiteUrl: membershipSiteUrl(process.env),
    });
  });

  app.post("/api/membership/provision", membershipLimiter, async (req: Request, res: Response) => {
    if (!requireSignature(req, res, "provision")) return;
    const parsed = parseProvision(req.body);
    if (!parsed.ok) { res.status(400).json({ ok: false, code: "invalid", error: parsed.error }); return; }
    await answer(res, "provision", async () => {
      const { provisionMembership } = await import("./services/membership");
      return provisionMembership(parsed.value);
    });
  });

  app.post("/api/membership/update", membershipLimiter, async (req: Request, res: Response) => {
    if (!requireSignature(req, res, "update")) return;
    const parsed = parseUpdate(req.body);
    if (!parsed.ok) { res.status(400).json({ ok: false, code: "invalid", error: parsed.error }); return; }
    await answer(res, "update", async () => {
      const { updateMembership } = await import("./services/membership");
      return updateMembership(parsed.value);
    });
  });

  app.post("/api/membership/status", membershipLimiter, async (req: Request, res: Response) => {
    if (!requireSignature(req, res, "status")) return;
    const id = parseExternalId((req.body ?? {}).externalId);
    if (!id.ok) { res.status(400).json({ ok: false, code: "invalid", error: id.error }); return; }
    await answer(res, "status", async () => {
      const { membershipState } = await import("./services/membership");
      return membershipState(id.value);
    });
  });

  app.post("/api/membership/activation", membershipLimiter, async (req: Request, res: Response) => {
    if (!requireSignature(req, res, "activation")) return;
    const id = parseExternalId((req.body ?? {}).externalId);
    if (!id.ok) { res.status(400).json({ ok: false, code: "invalid", error: id.error }); return; }
    await answer(res, "activation", async () => {
      const { reissueActivation } = await import("./services/membership");
      return reissueActivation(id.value);
    });
  });
}
