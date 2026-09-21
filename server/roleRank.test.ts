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
import * as ts from "typescript";
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

/* ────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS A PARSER AND NOT A REGEX.
 *
 * The rule — "nothing declares a second role hierarchy, and nothing hand-writes
 * the admin check" — is about SYNTAX, and it was expressed as a text pattern
 * three times, each narrower than the rule:
 *
 *   1. /role === "admin" \|\| role === "super_admin"/ — matched only a literal
 *      `role`, so Team.tsx's `myRole === …` was invisible.
 *   2. A backreference fixed the identifier, and found 3 real offenders in
 *      routers/prospects.ts. The character class still had no `?`, so every
 *      `me.data?.role` / `current?.role` form stayed invisible — SIXTEEN client
 *      files, while this suite reported a clean repo.
 *   3. Widening the class again would have left `"admin" === role`, `==`,
 *      line-broken operands and bracket access.
 *
 * Each time the test passed, which is the dangerous part: a detector that
 * cannot see is indistinguishable from a repo that is clean. So the detectors
 * below walk the TypeScript AST — operand order, whitespace, line breaks,
 * optional chaining and bracket access stop mattering because the tree is the
 * same shape either way — and the FIXTURES further down assert the detectors
 * still fire. A future narrowing fails those, loudly, instead of going quiet.
 * ──────────────────────────────────────────────────────────────────────────── */

const parse = (rel: string, code: string) =>
  ts.createSourceFile(rel, code, ts.ScriptTarget.Latest, true, /\.tsx$/.test(rel) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);

const eachNode = (node: ts.Node, fn: (n: ts.Node) => void) => {
  fn(node);
  node.forEachChild((c) => eachNode(c, fn));
};

const lineOf = (sf: ts.SourceFile, n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
const squash = (s: string) => s.replace(/\s+/g, "");

/** `a || b || c` as a flat list, however the tree nested it. */
function orOperands(node: ts.Expression): ts.Expression[] {
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
    return [...orOperands(node.left), ...orOperands(node.right)];
  }
  return [node];
}

/** `x === "admin"` or `"admin" === x`, loose or strict. */
function equalityToLiteral(n: ts.Expression, sf: ts.SourceFile): { subject: string; literal: string } | null {
  if (!ts.isBinaryExpression(n)) return null;
  const k = n.operatorToken.kind;
  if (k !== ts.SyntaxKind.EqualsEqualsEqualsToken && k !== ts.SyntaxKind.EqualsEqualsToken) return null;
  const litNode = ts.isStringLiteral(n.left) ? n.left : ts.isStringLiteral(n.right) ? n.right : null;
  if (!litNode) return null;
  const subject = litNode === n.left ? n.right : n.left;
  if (ts.isStringLiteral(subject)) return null; // "a" === "b", not a role check
  return { subject: squash(subject.getText(sf)), literal: litNode.text };
}

/** Any `||` chain that tests ONE subject against both admin role names. */
export function findHardAdminCompares(rel: string, code: string): string[] {
  const sf = parse(rel, code);
  const hits: string[] = [];
  eachNode(sf, (n) => {
    if (!ts.isBinaryExpression(n) || n.operatorToken.kind !== ts.SyntaxKind.BarBarToken) return;
    // Only the outermost || of a chain, so one expression reports once.
    const p = n.parent;
    if (p && ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.BarBarToken) return;
    const bySubject = new Map<string, Set<string>>();
    for (const part of orOperands(n)) {
      const eq = equalityToLiteral(part, sf);
      if (!eq) continue;
      if (!bySubject.has(eq.subject)) bySubject.set(eq.subject, new Set());
      bySubject.get(eq.subject)!.add(eq.literal);
    }
    bySubject.forEach((lits, subject) => {
      if (lits.has("admin") && lits.has("super_admin")) hits.push(`${rel}:${lineOf(sf, n)} — ${subject}`);
    });
  });
  return hits;
}

/** An object literal keyed by the role names with NUMERIC values: a rank map. */
export function findRankMaps(rel: string, code: string): string[] {
  const sf = parse(rel, code);
  const hits: string[] = [];
  eachNode(sf, (n) => {
    if (!ts.isObjectLiteralExpression(n)) return;
    const ranks = new Map<string, boolean>();
    for (const prop of n.properties) {
      if (!ts.isPropertyAssignment(prop) || !prop.name) continue;
      if (!ts.isIdentifier(prop.name) && !ts.isStringLiteral(prop.name)) continue;
      ranks.set(prop.name.text, ts.isNumericLiteral(prop.initializer));
    }
    // Numeric values are what make it a HIERARCHY; a role -> label or
    // role -> colour map is not a second source of truth about rank.
    const roleKeys = ["super_admin", "admin", "rep"];
    if (roleKeys.every((k) => ranks.get(k) === true)) hits.push(`${rel}:${lineOf(sf, n)}`);
  });
  return hits;
}

describe("only one rank map", () => {
  function sourceFiles(dir: string): string[] {
    const out: string[] = [];
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name === "dist") continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) out.push(...sourceFiles(p));
      else if (/\.tsx?$/.test(e.name) && !/\.(test|spec)\.tsx?$/.test(e.name)) out.push(p);
    }
    return out;
  }

  /** The one file allowed to declare the hierarchy. */
  const CANONICAL = "shared/roleRank.ts";

  const files = [join(ROOT, "server"), join(ROOT, "client", "src"), join(ROOT, "shared")]
    .flatMap(sourceFiles)
    .map((f) => ({ rel: f.slice(ROOT.length + 1).split(sep).join("/"), src: readFileSync(f, "utf8") }));

  it("finds source on BOTH sides to scan (guards the scanner itself)", () => {
    // Separate floors: one number over the union would stay green if the
    // client half stopped being walked, which is how three client copies
    // survived the first consolidation.
    expect(files.filter((f) => f.rel.startsWith("server/")).length).toBeGreaterThan(150);
    expect(files.filter((f) => f.rel.startsWith("client/")).length).toBeGreaterThan(100);
    expect(files.some((f) => f.rel === CANONICAL)).toBe(true);
  });

  it("nothing else declares a role hierarchy", () => {
    const offenders = files
      .filter((f) => f.rel !== CANONICAL)
      .flatMap((f) => findRankMaps(f.rel, f.src));
    expect(
      offenders,
      offenders.length
        ? `\n\nA second role rank map in:\n  ${offenders.join("\n  ")}\n\n` +
            `Import rankOf / isAdminRole / requireMinRole from @shared/roleRank.\n` +
            `A role added to the canonical map and not to a copy is silently denied\n` +
            `in that file and allowed everywhere else.\n`
        : undefined,
    ).toEqual([]);
  });

  it("nothing hand-writes the admin check", () => {
    const offenders = files
      .filter((f) => f.rel !== CANONICAL)
      .flatMap((f) => findHardAdminCompares(f.rel, f.src));
    expect(
      offenders,
      offenders.length
        ? `\n\nHand-written admin comparison in:\n  ${offenders.join("\n  ")}\n\n` +
            `Use isAdminRole(role) from @shared/roleRank — same result for every\n` +
            `input, and it moves with the hierarchy.\n`
        : undefined,
    ).toEqual([]);
  });

  /* ── The detectors have to be able to SEE. ─────────────────────────────────
   * Without these, "no offenders" means either a clean repo or a blind
   * detector, and this suite has twice reported the second as the first.
   * Every entry is a form that really appeared, or that a plausible next
   * narrowing would drop. */

  const MUST_BE_CAUGHT: ReadonlyArray<readonly [string, string]> = [
    ["bare identifier (the v1 blind spot was everything else)", `const a = role === "admin" || role === "super_admin";`],
    ["a different variable name", `const a = myRole === "admin" || myRole === "super_admin";`],
    ["optional chaining — the v2 blind spot, 16 files", `const a = me.data?.role === "admin" || me.data?.role === "super_admin";`],
    ["a deep optional path", `const a = x?.y?.member?.role === "admin" || x?.y?.member?.role === "super_admin";`],
    ["a dotted path", `const a = ctx.member.role === "admin" || ctx.member.role === "super_admin";`],
    ["bracket access", `const a = m["role"] === "admin" || m["role"] === "super_admin";`],
    ["reversed operands", `const a = "admin" === role || "super_admin" === role;`],
    ["reversed literal order", `const a = role === "super_admin" || role === "admin";`],
    ["loose equality", `const a = role == "admin" || role == "super_admin";`],
    ["buried in a longer || chain", `const a = other || role === "admin" || role === "super_admin";`],
    ["split across lines", `const a =\n  role === "admin" ||\n  role === "super_admin";`],
    ["extra spacing", `const a = role    ===   "admin"   ||   role === "super_admin";`],
  ];

  it.each(MUST_BE_CAUGHT)("catches: %s", (_label, code) => {
    expect(findHardAdminCompares("fixture.ts", code)).toHaveLength(1);
  });

  const MUST_BE_IGNORED: ReadonlyArray<readonly [string, string]> = [
    ["the shared helper", `const a = isAdminRole(role);`],
    ["two different subjects", `const a = role === "admin" || other === "super_admin";`],
    ["a single comparison", `const a = role === "admin";`],
    ["non-admin roles", `const a = role === "manager" || role === "rep";`],
    ["string literals either side", `const a = "admin" === "super_admin";`],
  ];

  it.each(MUST_BE_IGNORED)("does not fire on: %s", (_label, code) => {
    expect(findHardAdminCompares("fixture.ts", code)).toEqual([]);
  });

  it("catches a rank map however it is written", () => {
    const forms = [
      `const R = { super_admin: 4, admin: 3, manager: 2, rep: 1 };`,
      `const R = { "super_admin": 4, "admin": 3, "manager": 2, "rep": 1 };`,
      `const R = { rep: 1, manager: 2, admin: 3, super_admin: 4 };`,
      `const R: Record<string, number> = {\n  super_admin : 4,\n  admin: 3,\n  manager: 2,\n  rep: 1,\n};`,
    ];
    for (const f of forms) expect(findRankMaps("fixture.ts", f), f).toHaveLength(1);
  });

  it("does not call a role-to-label map a hierarchy", () => {
    // Team.tsx legitimately maps roles to tones; that is not a second source
    // of truth about RANK, and flagging it would push the next author to
    // silence the rule rather than obey it.
    const tone = `const T = { super_admin: "danger", admin: "warning", manager: "info", rep: "muted" };`;
    expect(findRankMaps("fixture.ts", tone)).toEqual([]);
  });

  it("every former copy now imports the shared helpers", () => {
    for (const rel of [
      "server/routers/companies.ts",
      "server/routers/scoring.ts",
      "server/routers/linkedinEnrichment.ts",
      "server/routers/are/scraper.ts",
      "server/routers/linkedinFinder.ts",
      "client/src/pages/usip/Team.tsx",
      "client/src/pages/usip/CompanyProfile.tsx",
      "client/src/components/usip/scoring/ProspectScoringPanel.tsx",
    ]) {
      const f = files.find((x) => x.rel === rel);
      expect(f, rel).toBeDefined();
      expect(f!.src, rel).toMatch(/isAdminRole|requireMinRole|rankOf/);
    }
  });

  it("the client reaches the hierarchy through @shared, not a local copy", () => {
    for (const rel of [
      "client/src/pages/usip/Team.tsx",
      "client/src/pages/usip/CompanyProfile.tsx",
      "client/src/components/usip/scoring/ProspectScoringPanel.tsx",
    ]) {
      const f = files.find((x) => x.rel === rel);
      expect(f!.src, rel).toContain('from "@shared/roleRank"');
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
