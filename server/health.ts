/**
 * Deploy health / build identity.
 *
 * WHY THIS EXISTS: after pushing to main there was no way to confirm from
 * outside which commit Railway was actually serving. The app returning 200
 * proves something is up, not that it is the build you just pushed — so
 * "deployed" was an inference every time, and a failed or queued build looked
 * identical to a successful one.
 *
 * Deliberately unauthenticated: a health check that needs a session cannot be
 * used by an uptime prober, and the payload is three non-secret facts.
 *
 * ⚠️ WHAT MUST NEVER GO IN HERE. This endpoint is public and unauthenticated,
 * so it is a standing invitation to add "just one more" diagnostic field. It
 * returns the commit, the process start time and uptime — nothing else. No env
 * dump, no config, no DB status string, no version of anything installed, no
 * counts. Each of those is a small leak on its own and a map of the deployment
 * together. `health.test.ts` pins the exact key set and fails on any addition,
 * which is the point: adding a field should require deciding to.
 */
import type { Express, Request, Response } from "express";

/**
 * Railway injects RAILWAY_GIT_COMMIT_SHA on every deploy. The others are
 * fallbacks for a different host or a local run; "unknown" is honest rather
 * than pretending an unlabelled build is something.
 */
export function deployedCommit(): string {
  return (
    process.env.RAILWAY_GIT_COMMIT_SHA ||
    process.env.SOURCE_VERSION ||
    process.env.GIT_COMMIT_SHA ||
    "unknown"
  );
}

/** Fixed at module load, so it reports THIS process rather than the request. */
const STARTED_AT = new Date().toISOString();

export type HealthPayload = {
  ok: true;
  /** Full commit SHA of the running build, or "unknown". */
  commit: string;
  /** ISO timestamp this process booted. */
  startedAt: string;
  /** Whole seconds since boot — distinguishes a fresh deploy from a restart loop. */
  uptimeSeconds: number;
};

export function healthPayload(): HealthPayload {
  return {
    ok: true,
    commit: deployedCommit(),
    startedAt: STARTED_AT,
    uptimeSeconds: Math.floor(process.uptime()),
  };
}

export function registerHealthRoute(app: Express): void {
  app.get("/api/health", (_req: Request, res: Response) => {
    // no-store: an uptime prober behind a CDN must see this process, not a
    // cached answer from the build it replaced — which would defeat the one
    // question the endpoint exists to answer.
    res.setHeader("Cache-Control", "no-store");
    res.json(healthPayload());
  });
}
