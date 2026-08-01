/**
 * Every SSE streaming route resolves auth the SAME way.
 *
 * There are five. Four are built on `runSSEStream`, which requires
 * `x-workspace-id` and 400s without it. The fifth, `/api/llm/stream`, carried
 * its own copy of the rule, and the copy had drifted:
 *
 *     if (Number.isFinite(workspaceId)) {  ...membership check...  }
 *
 * Omit the header and the membership check never runs. Worse, the request then
 * reached streamLLM with `workspaceId: undefined`, which is precisely the
 * signal to skip the workspace's own BYOK credentials and bill the platform
 * key — so any authenticated user, in any workspace, could drive arbitrary
 * provider/model/messages off-book. A conditional security check is not a
 * security check; it is a suggestion.
 *
 * `resolveStreamAuth` is now the one rule. These tests assert the behaviour
 * that was wrong, not just that the function is referenced.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const authenticateRequest = vi.fn();

/**
 * `getDb` used to be mocked to a flat `null`, which meant EVERY behavioural
 * test below stopped at "Database unavailable" and the membership branch was
 * never executed. Replacing `if (!member)` with `if (false)` — any
 * authenticated user streaming against any workspace, on the workspace's own
 * BYOK credentials, i.e. the e9121b9 hole reopened — passed the full suite at
 * 1608 green. Injectable now, so the 403 is reached and asserted.
 */
const h = vi.hoisted(() => ({ db: null as unknown }));

vi.mock("./_core/sdk", () => ({ sdk: { authenticateRequest: (...a: unknown[]) => authenticateRequest(...a) } }));
vi.mock("./db", () => ({ getDb: async () => h.db }));

/**
 * Minimal chainable fake of the drizzle select builder, which also RECORDS the
 * where clause.
 *
 * Returning rows regardless of the filter makes the fake blind to which columns
 * were actually compared: deleting `eq(workspaceMembers.workspaceId, workspaceId)`
 * — so a member of ANY workspace passes for ANY workspace — was invisible to
 * both this file and the whole suite. A drizzle condition exposes its column
 * references through `queryChunks`, so the filter can simply be read back.
 */
function fakeDb(rows: unknown[]) {
  const seen: string[] = [];
  const chain: any = {
    select: () => chain,
    from: () => chain,
    where: (cond: unknown) => {
      (function walk(n: any, d = 0) {
        if (!n || d > 10 || typeof n !== "object") return;
        if (n.name && n.table) seen.push(String(n.name));
        if (Array.isArray(n.queryChunks)) n.queryChunks.forEach((c: any) => walk(c, d + 1));
        if (Array.isArray(n)) n.forEach((c: any) => walk(c, d + 1));
      })(cond);
      return chain;
    },
    limit: async () => rows,
    filteredOn: seen,
  };
  return chain;
}

const ROOT = join(__dirname, "..");

function fakeRes() {
  const r = {
    code: 0,
    payload: undefined as unknown,
    status(c: number) { r.code = c; return r; },
    json(p: unknown) { r.payload = p; return r; },
  };
  return r;
}
const req = (headers: Record<string, string | string[]>) => ({ headers }) as never;

describe("resolveStreamAuth", () => {
  beforeEach(() => {
    authenticateRequest.mockReset();
    h.db = null; // the DB-unavailable tests below depend on this default
  });

  it("401s an unauthenticated caller", async () => {
    authenticateRequest.mockRejectedValue(new Error("no session"));
    const { resolveStreamAuth } = await import("./_core/streamHelpers");
    const res = fakeRes();
    expect(await resolveStreamAuth(req({}), res as never)).toBeNull();
    expect(res.code).toBe(401);
  });

  /** THE bug: this used to fall straight through to an unscoped stream. */
  it("400s an authenticated caller who omits x-workspace-id", async () => {
    authenticateRequest.mockResolvedValue({ id: 1 });
    const { resolveStreamAuth } = await import("./_core/streamHelpers");
    const res = fakeRes();
    expect(await resolveStreamAuth(req({}), res as never)).toBeNull();
    expect(res.code).toBe(400);
    expect(JSON.stringify(res.payload)).toMatch(/x-workspace-id/);
  });

  it("400s a non-numeric workspace header rather than coercing it", async () => {
    authenticateRequest.mockResolvedValue({ id: 1 });
    const { resolveStreamAuth } = await import("./_core/streamHelpers");
    for (const bad of ["", "abc", "NaN"]) {
      const res = fakeRes();
      expect(await resolveStreamAuth(req({ "x-workspace-id": bad }), res as never), bad).toBeNull();
      expect(res.code, bad).toBe(400);
    }
  });

  it("goes on to check membership once the header is valid", async () => {
    // getDb is mocked to null here, so reaching the DB step is the assertion:
    // it proves the header did NOT short-circuit the membership check.
    authenticateRequest.mockResolvedValue({ id: 1 });
    const { resolveStreamAuth } = await import("./_core/streamHelpers");
    const res = fakeRes();
    expect(await resolveStreamAuth(req({ "x-workspace-id": "7" }), res as never)).toBeNull();
    expect(res.code).toBe(500); // "Database unavailable" — i.e. it got that far
  });

  /**
   * THE GATE. Nothing reached this branch until the DB became injectable:
   * `if (!member)` → `if (false)` passed the whole suite at 1608 green.
   *
   * A 403 that is present, correctly ordered and unreachable is the shape that
   * has now slipped four mutations through this repo. The refusal has to be
   * OBSERVED, not located.
   */
  it("403s an authenticated caller who is NOT a member of that workspace", async () => {
    authenticateRequest.mockResolvedValue({ id: 1 });
    h.db = fakeDb([]); // the membership lookup finds nothing
    const { resolveStreamAuth } = await import("./_core/streamHelpers");
    const res = fakeRes();
    expect(
      await resolveStreamAuth(req({ "x-workspace-id": "7" }), res as never),
      "\n\nA non-member must get NOTHING back. Returning auth here hands the\n" +
        "caller another workspace's stream — and streamLLM then bills that\n" +
        "workspace's BYOK credentials for it.\n",
    ).toBeNull();
    expect(res.code).toBe(403);
  });

  /**
   * The other half. Without this, "always 403" would satisfy the test above —
   * a guard that only proves refusals passes on a route that refuses everyone,
   * which is a broken feature rather than a secure one.
   */
  it("returns the resolved auth for a real member", async () => {
    authenticateRequest.mockResolvedValue({ id: 42 });
    h.db = fakeDb([{ workspaceId: 7 }]);
    const { resolveStreamAuth } = await import("./_core/streamHelpers");
    const res = fakeRes();
    const auth = await resolveStreamAuth(req({ "x-workspace-id": "7" }), res as never);
    expect(auth).not.toBeNull();
    expect(auth!.userId).toBe(42);
    expect(auth!.workspaceId).toBe(7);
    expect(res.code).toBe(0); // nothing was refused
  });

  /**
   * The workspaceId that comes back must be the one the CALLER asked for and
   * was verified against — not whatever the row happened to carry. They are
   * equal in production, so only a disagreeing fake can tell the two apart.
   */
  it("returns the REQUESTED workspace, not the row's", async () => {
    authenticateRequest.mockResolvedValue({ id: 42 });
    h.db = fakeDb([{ workspaceId: 999 }]);
    const { resolveStreamAuth } = await import("./_core/streamHelpers");
    const res = fakeRes();
    const auth = await resolveStreamAuth(req({ "x-workspace-id": "7" }), res as never);
    expect(auth!.workspaceId).toBe(7);
  });

  /**
   * The membership lookup must compare all three columns.
   *
   * Dropping `eq(workspaceMembers.workspaceId, workspaceId)` leaves a query
   * that still runs, still returns a row, and still gates on it — while
   * asking only "is this user a member of ANYTHING". Every test above passes;
   * so did the full suite. The filter itself has to be read back.
   */
  it("scopes the membership lookup by user AND workspace AND not-deactivated", async () => {
    authenticateRequest.mockResolvedValue({ id: 42 });
    const db = fakeDb([{ workspaceId: 7 }]);
    h.db = db;
    const { resolveStreamAuth } = await import("./_core/streamHelpers");
    await resolveStreamAuth(req({ "x-workspace-id": "7" }), fakeRes() as never);

    expect(db.filteredOn.length, "the where clause was never inspected").toBeGreaterThan(0);
    for (const col of ["userId", "workspaceId", "deactivatedAt"]) {
      expect(
        db.filteredOn,
        `\n\nThe membership lookup no longer filters on ${col}.\n` +
          `Without workspaceId it asks "a member of anything?"; without\n` +
          `deactivatedAt a revoked member keeps streaming.\n`,
      ).toContain(col);
    }
  });
});

/**
 * Anti-drift. `/api/llm/stream` diverged by hand-rolling the rule; the way a
 * sixth route repeats that is by doing its own workspaceMembers lookup.
 * Comments are stripped first — the replacement comments in llmStreamRoute.ts
 * describe the old membership check in detail.
 */
describe("no streaming route rolls its own workspace check", () => {
  const stripped = (rel: string) =>
    readFileSync(join(ROOT, rel), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");

  const streamRoutes = readdirSync(join(ROOT, "server"))
    .filter((f) => /StreamRoute\.ts$/.test(f) && !/\.test\.ts$/.test(f))
    .map((f) => `server/${f}`);

  it("finds the streaming routes (guards the scanner itself)", () => {
    expect(streamRoutes.length).toBeGreaterThanOrEqual(5);
  });

  it("none of them queries workspaceMembers directly", () => {
    const offenders = streamRoutes.filter((rel) => stripped(rel).includes("workspaceMembers"));
    expect(
      offenders,
      offenders.length
        ? `\n\nThese routes check workspace membership themselves:\n  ${offenders.join("\n  ")}\n\n` +
            `Use resolveStreamAuth (or runSSEStream, which calls it). The last\n` +
            `hand-rolled copy made the check conditional on a header being present.\n`
        : undefined,
    ).toEqual([]);
  });

  it("each one resolves auth through the shared helper", () => {
    for (const rel of streamRoutes) {
      expect(stripped(rel), rel).toMatch(/resolveStreamAuth|runSSEStream/);
    }
  });

  it("no route makes its workspace check conditional on the header being present", () => {
    for (const rel of [...streamRoutes, "server/_core/streamHelpers.ts"]) {
      expect(stripped(rel), rel).not.toMatch(/if\s*\(\s*Number\.isFinite\(\s*workspaceId\s*\)\s*\)/);
    }
  });
});
