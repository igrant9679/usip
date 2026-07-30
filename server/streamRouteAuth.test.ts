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

vi.mock("./_core/sdk", () => ({ sdk: { authenticateRequest: (...a: unknown[]) => authenticateRequest(...a) } }));
vi.mock("./db", () => ({ getDb: async () => null }));

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
