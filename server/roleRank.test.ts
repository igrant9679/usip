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
import { isAdminRole, rankOf, requireMinRole } from "./_core/workspace";

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
