/**
 * The health endpoint.
 *
 * Two things are worth guarding on a route this small. It is PUBLIC and
 * UNAUTHENTICATED, so the key set is pinned and any added field fails the
 * suite — the failure mode here is not a bug, it is someone reasonably adding
 * "just one more" diagnostic to an endpoint anyone can curl. And it has to be
 * registered ahead of the SPA catch-all, or it answers 200 with index.html:
 * the exact false positive it exists to eliminate.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Request, Response } from "express";
import { deployedCommit, healthPayload, registerHealthRoute } from "./health";

const read = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8");

const COMMIT_VARS = ["RAILWAY_GIT_COMMIT_SHA", "SOURCE_VERSION", "GIT_COMMIT_SHA"];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const v of COMMIT_VARS) {
    saved[v] = process.env[v];
    delete process.env[v];
  }
});
afterEach(() => {
  for (const v of COMMIT_VARS) {
    if (saved[v] === undefined) delete process.env[v];
    else process.env[v] = saved[v];
  }
});

describe("deployedCommit", () => {
  it("reports Railway's injected SHA", () => {
    process.env.RAILWAY_GIT_COMMIT_SHA = "80c7765abc";
    expect(deployedCommit()).toBe("80c7765abc");
  });

  it("prefers Railway's over the fallbacks", () => {
    process.env.RAILWAY_GIT_COMMIT_SHA = "railway";
    process.env.SOURCE_VERSION = "other";
    expect(deployedCommit()).toBe("railway");
  });

  it("falls back in order", () => {
    process.env.SOURCE_VERSION = "source";
    expect(deployedCommit()).toBe("source");
  });

  it("says 'unknown' rather than pretending an unlabelled build is something", () => {
    // Reporting "" or the string "undefined" would compare equal to nothing and
    // read as a deploy that never landed. An explicit unknown is checkable.
    expect(deployedCommit()).toBe("unknown");
  });

  it("treats an empty env var as absent", () => {
    process.env.RAILWAY_GIT_COMMIT_SHA = "";
    expect(deployedCommit()).toBe("unknown");
  });
});

describe("the payload leaks nothing", () => {
  it("returns exactly four keys, and no more", () => {
    /**
     * The assertion that matters. This route is unauthenticated, so every field
     * is public. If you are adding one, that is a decision — make it here.
     */
    expect(Object.keys(healthPayload()).sort()).toEqual(
      ["commit", "ok", "startedAt", "uptimeSeconds"].sort(),
    );
  });

  it("reports a whole-number uptime and a parseable start time", () => {
    const p = healthPayload();
    expect(p.ok).toBe(true);
    expect(Number.isInteger(p.uptimeSeconds)).toBe(true);
    expect(p.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(Number.isNaN(Date.parse(p.startedAt))).toBe(false);
  });

  it("reports the PROCESS start, not the time of the request", () => {
    /**
     * "It parses as a date" is true of `new Date().toISOString()` too, so the
     * first version of this test passed against a per-request timestamp — which
     * would make a container in a restart loop look like a long-lived healthy
     * process, the one thing uptime is consulted for. Clock moved rather than
     * slept on, so there is nothing to flake.
     */
    const far = new Date("2099-01-01T00:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(far);
    try {
      expect(healthPayload().startedAt).not.toBe(far.toISOString());
    } finally {
      vi.useRealTimers();
    }
  });

  it("never serialises a secret-shaped env var", () => {
    // Belt and braces on the key-set test: the VALUES must not carry anything
    // sensitive either, however the payload is later refactored.
    const body = JSON.stringify(healthPayload());
    for (const [k, v] of Object.entries(process.env)) {
      if (!v || v.length < 8) continue;
      if (!/KEY|SECRET|TOKEN|PASSWORD|DATABASE_URL|DSN/i.test(k)) continue;
      expect(body.includes(v), `health payload contains ${k}`).toBe(false);
    }
  });
});

describe("the route itself", () => {
  /** Minimal Express stand-in: capture the handler, then run it for real. */
  function mount() {
    const routes: Record<string, (req: Request, res: Response) => void> = {};
    registerHealthRoute({ get: (p: string, h: never) => { routes[p] = h; } } as never);
    return routes;
  }

  it("registers GET /api/health", () => {
    expect(Object.keys(mount())).toEqual(["/api/health"]);
  });

  it("answers with the payload and forbids caching", () => {
    // A cached health response can describe the build this one replaced, which
    // is precisely the question the endpoint answers.
    const res = { json: vi.fn(), setHeader: vi.fn() };
    mount()["/api/health"]({} as Request, res as unknown as Response);
    expect(res.setHeader).toHaveBeenCalledWith("Cache-Control", "no-store");
    expect(res.json).toHaveBeenCalledTimes(1);
    expect(res.json.mock.calls[0][0]).toMatchObject({ ok: true });
  });

  it("needs no request fields, so a bare prober works", () => {
    const res = { json: vi.fn(), setHeader: vi.fn() };
    expect(() => mount()["/api/health"](undefined as never, res as unknown as Response)).not.toThrow();
  });
});

describe("registration order", () => {
  const src = read("server/_core/index.ts");

  it("mounts before the SPA static handler", () => {
    /**
     * serveStatic ends in a catch-all that returns index.html, so a health
     * route registered after it answers 200 with an HTML page — passing every
     * naive uptime check while telling you nothing about the build.
     */
    const health = src.indexOf("registerHealthRoute(app)");
    const staticAt = src.indexOf("serveStatic(app)");
    expect(health, "health route not registered").toBeGreaterThan(-1);
    expect(staticAt, "serveStatic not found — re-anchor").toBeGreaterThan(-1);
    expect(health).toBeLessThan(staticAt);
  });

  it("mounts before the tRPC middleware too", () => {
    const health = src.indexOf("registerHealthRoute(app)");
    const trpc = src.indexOf('"/api/trpc"');
    expect(trpc, "tRPC mount not found — re-anchor").toBeGreaterThan(-1);
    expect(health).toBeLessThan(trpc);
  });
});
