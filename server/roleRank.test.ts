/**
 * One rank map, because a permission boundary is not a thing to copy.
 *
 * Five routers carried their own role hierarchy: companies.ts, scoring.ts and
 * linkedinEnrichment.ts each declared
 * `const RANK = { super_admin: 4, admin: 3, manager: 2, rep: 1 }`, while
 * are/scraper.ts and linkedinFinder.ts hard-compared
 * `role === "admin" || role === "super_admin"`. The canonical `ROLE_RANK` has
 * been in _core/workspace.ts the whole time.
 *
 * Honest verdict when found: all five AGREED. Duplication, not drift — the same
 * result as `startOfUtcDay` (six identical copies). What makes it worth
 * consolidating anyway is the failure mode: adding a role to the canonical map
 * without updating the copies silently DENIES the new role in five routers and
 * allows it everywhere else, which reads as a bug in the feature rather than in
 * the map.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, sep } from "node:path";
import {
  adminWsProcedure,
  isAdminRole,
  rankOf,
  repProcedure,
  requireMinRole,
  roleRank,
  superAdminProcedure,
} from "./_core/workspace";

const ROOT = join(__dirname, "..");
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("role helpers", () => {
  it("ranks the hierarchy", () => {
    expect(rankOf("super_admin")).toBeGreaterThan(rankOf("admin"));
    expect(rankOf("admin")).toBeGreaterThan(rankOf("manager"));
    expect(rankOf("manager")).toBeGreaterThan(rankOf("rep"));
  });

  it("denies an unknown role instead of comparing against undefined", () => {
    // `RANK[role] >= RANK.admin` with an unknown role compares undefined, which
    // is false by luck rather than by rule. rankOf makes it a rule.
    expect(rankOf("viewer")).toBe(0);
    expect(rankOf("")).toBe(0);
    expect(isAdminRole("viewer")).toBe(false);
  });

  it("treats admin and super_admin as admin, and nothing else", () => {
    expect(isAdminRole("super_admin")).toBe(true);
    expect(isAdminRole("admin")).toBe(true);
    expect(isAdminRole("manager")).toBe(false);
    expect(isAdminRole("rep")).toBe(false);
  });

  it("requireMinRole THROWS for an insufficient role and passes otherwise", () => {
    // The assertion that would have caught the worst moment of this change: a
    // refactor left one of these wrappers as `if (false) { throw }`, which is
    // valid TypeScript, compiles clean, and silently removes the check. A
    // source scan would not have seen it; calling the function does.
    expect(() => requireMinRole("rep", "admin", "nope")).toThrow(/nope/);
    expect(() => requireMinRole("manager", "admin", "nope")).toThrow();
    expect(() => requireMinRole("viewer", "manager", "nope")).toThrow();
    expect(() => requireMinRole("admin", "admin", "nope")).not.toThrow();
    expect(() => requireMinRole("super_admin", "manager", "nope")).not.toThrow();
    expect(() => requireMinRole("manager", "manager", "nope")).not.toThrow();
  });
});

describe("only one rank map", () => {
  function sourceFiles(dir: string): string[] {
    const out: string[] = [];
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules") continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) out.push(...sourceFiles(p));
      else if (/\.ts$/.test(e.name) && !/\.(test|spec)\.ts$/.test(e.name)) out.push(p);
    }
    return out;
  }

  const files = sourceFiles(join(ROOT, "server"))
    .map((f) => ({ rel: f.slice(ROOT.length + 1).split(sep).join("/"), src: stripComments(readFileSync(f, "utf8")) }));

  it("finds source to scan (guards the scanner itself)", () => {
    expect(files.length).toBeGreaterThan(150);
  });

  it("nothing else declares a role hierarchy", () => {
    const offenders = files
      .filter((f) => f.rel !== "server/_core/workspace.ts")
      .filter((f) => /super_admin:\s*\d/.test(f.src))
      .map((f) => f.rel);
    expect(
      offenders,
      offenders.length
        ? `\n\nA second role rank map in:\n  ${offenders.join("\n  ")}\n\n` +
            `Import rankOf / isAdminRole / requireMinRole from _core/workspace.\n` +
            `A role added to the canonical map and not to a copy is silently denied\n` +
            `in that router and allowed everywhere else.\n`
        : undefined,
    ).toEqual([]);
  });

  it("nothing hard-compares the admin roles", () => {
    const offenders = files
      .filter((f) => f.rel !== "server/_core/workspace.ts")
      .filter((f) => /role === "admin"\s*\|\|\s*role === "super_admin"/.test(f.src))
      .map((f) => f.rel);
    expect(
      offenders,
      offenders.length ? `\n\nHard-coded admin comparison in:\n  ${offenders.join("\n  ")}\n` : undefined,
    ).toEqual([]);
  });

  it("the five former copies now import the shared helpers", () => {
    for (const rel of [
      "server/routers/companies.ts",
      "server/routers/scoring.ts",
      "server/routers/linkedinEnrichment.ts",
      "server/routers/are/scraper.ts",
      "server/routers/linkedinFinder.ts",
    ]) {
      const f = files.find((x) => x.rel === rel);
      expect(f, rel).toBeDefined();
      expect(f!.src, rel).toMatch(/isAdminRole|requireMinRole/);
    }
  });
});

describe("the gate every workspace procedure sits behind", () => {
  /**
   * `roleAtLeast` is private, so it is reached through the procedures it
   * builds. The LAST middleware on each builder is the role check: .query()
   * and .mutation() append the resolver only when a procedure is finished,
   * and these are still builders. Throws rather than defaulting if tRPC's
   * internals move, so this cannot quietly start testing nothing.
   */
  const roleGate = (proc: unknown) => {
    const mw = (proc as { _def?: { middlewares?: unknown[] } })?._def?.middlewares;
    if (!Array.isArray(mw) || mw.length === 0) throw new Error("tRPC builder shape changed");
    return mw[mw.length - 1] as (o: { ctx: unknown; next: () => unknown }) => Promise<unknown>;
  };
  const asRole = (proc: unknown, role: unknown) =>
    roleGate(proc)({ ctx: { member: { role } }, next: () => "ADMITTED" });

  it("denies a role that is not in the hierarchy at all", async () => {
    /**
     * THE FAIL-OPEN BUG. The gate read `ROLE_RANK[ctx.member.role] < ROLE_RANK[min]`.
     * A role outside the map indexes to undefined, and `undefined < 3` is
     * FALSE — so the guard did not throw and the request was ADMITTED. Not
     * reachable while the column is an enum; reachable the moment a role is
     * added to the schema and not to the map, which is precisely the drift
     * this file exists to catch.
     */
    await expect(asRole(adminWsProcedure, "viewer")).rejects.toThrow(/Requires admin role/);
    await expect(asRole(repProcedure, "viewer")).rejects.toThrow(/Requires rep role/);
    await expect(asRole(repProcedure, "")).rejects.toThrow();
    await expect(asRole(repProcedure, undefined)).rejects.toThrow();
  });

  it("still admits the roles that should pass", async () => {
    // The other half, and the one that matters operationally: a fail-CLOSED
    // rewrite that locked everyone out would satisfy the test above.
    await expect(asRole(adminWsProcedure, "admin")).resolves.toBe("ADMITTED");
    await expect(asRole(adminWsProcedure, "super_admin")).resolves.toBe("ADMITTED");
    await expect(asRole(repProcedure, "rep")).resolves.toBe("ADMITTED");
    await expect(asRole(superAdminProcedure, "super_admin")).resolves.toBe("ADMITTED");
  });

  it("still refuses a real role that is merely too low", async () => {
    await expect(asRole(adminWsProcedure, "rep")).rejects.toThrow(/Requires admin role/);
    await expect(asRole(adminWsProcedure, "manager")).rejects.toThrow();
    await expect(asRole(superAdminProcedure, "admin")).rejects.toThrow();
  });
});

describe("roleRank", () => {
  it("ranks an unexpected role 0 rather than undefined", () => {
    /**
     * Typed to accept only real roles, so this is about the runtime behind the
     * type. routers/admin.ts decides privilege CHANGES with it —
     * `roleRank(input.role) > roleRank(ctx.member.role)` and
     * `roleRank(target.role) >= roleRank(ctx.member.role)` guard who may assign
     * which role and whom they may act on. undefined makes every one of those
     * comparisons false, which is ALLOW.
     */
    expect(roleRank("viewer" as never)).toBe(0);
    expect(roleRank(undefined as never)).toBe(0);
  });

  it("agrees with rankOf on every real role", () => {
    for (const r of ["super_admin", "admin", "manager", "rep"] as const) {
      expect(roleRank(r)).toBe(rankOf(r));
    }
  });
});
