/**
 * `as never` writes cannot be checked by tsc, so they get checked here.
 *
 * THE CLASS. Drizzle inserts across this repo are cast `as never` to get past
 * type friction, and that cast switches off BOTH excess-property checking and
 * value checking. tsc is then blind to a column that does not exist
 * (`a278a39` — `prospects` had no `companyName`; it compiled and threw at
 * runtime), a string outside a mysqlEnum (`d3aefe0`), or a string longer than
 * its varchar. All three fail inside a cron or a public submit handler, with
 * the real reason on `e.cause` rather than `e.message`.
 *
 * ✅ THE SWEEP FOUND NOTHING, and that is recorded rather than assumed: 805 of
 * 961 drizzle write sites carry an inline object payload and every one is
 * clean. A sweep that finds nothing is a result (`d682552`) — the value of this
 * file is the NEXT one.
 *
 * 🔬 THE CHECKER IS PROVEN INSIDE THIS FILE, not by someone having run it once.
 * The synthetic cases below feed it a fabricated schema and source containing
 * each defect and require it to report them. Without that, "findings: 0" is
 * indistinguishable from a scanner that looks at nothing — the fourth vacuous
 * shape `scripts/guardAudit.mjs` hunts for.
 */
import { describe, it, expect } from "vitest";
import { join } from "path";
import {
  auditRepo,
  checkSource,
  objectAt,
  parseSchema,
  topLevelPairs,
} from "../scripts/asNeverAudit.mjs";

const ROOT = join(__dirname, "..");

/* ── The checker can see. Synthetic, so a green repo proves something ────── */

const FAKE_SCHEMA = `
export const widgets = mysqlTable(
  "widgets",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    name: varchar("name", { length: 10 }).notNull(),
    status: mysqlEnum("status", [
      "open",
      "closed", // the word "archived" appears only in this comment
    ]).default("open").notNull(),
    note: text("note"),
  },
);
`;

const { tables: FAKE } = parseSchema(FAKE_SCHEMA);

const check = (src: string) => checkSource("fake.ts", src, FAKE).findings;

describe("the checker catches each defect it claims to", () => {
  it("parsed the fake schema at all (floor)", () => {
    expect(FAKE.get("widgets")).toBeTruthy();
    expect([...FAKE.get("widgets")!.cols.keys()].sort())
      .toEqual(["id", "name", "note", "status", "workspaceId"]);
  });

  it("BAD ENUM — a value outside the enum", () => {
    const f = check(`db.insert(widgets).values({ status: "archived" } as never);`);
    expect(f.map((x) => x.kind)).toEqual(["BAD ENUM"]);
    expect(f[0]!.detail).toContain("archived");
  });

  it("TOO LONG — a literal past the varchar length", () => {
    const f = check(`db.insert(widgets).values({ name: "${"x".repeat(11)}" } as never);`);
    expect(f.map((x) => x.kind)).toEqual(["TOO LONG"]);
    expect(f[0]!.detail).toBe("11 > 10");
  });

  it("UNKNOWN COLUMN — a column the table does not have", () => {
    const f = check(`db.insert(widgets).values({ widgetName: "x" } as never);`);
    expect(f.map((x) => x.kind)).toEqual(["UNKNOWN COLUMN"]);
    expect(f[0]!.column).toBe("widgetName");
  });

  it("catches it on .set() too, not only .insert()", () => {
    const f = check(`db.update(widgets).set({ status: "nope" } as never).where(x);`);
    expect(f.map((x) => x.kind)).toEqual(["BAD ENUM"]);
  });

  it("resolves an ALIASED import", () => {
    /**
     * `emailTracking.ts` imports `workspaces as workspacesT`. Keying on the
     * identifier alone leaves every such write unchecked — the alias gap that
     * made an earlier scanner blind until a mutation found it.
     */
    const f = check(
      `import { widgets as w } from "../drizzle/schema";\n` +
      `db.insert(w).values({ status: "archived" } as never);`,
    );
    expect(f.map((x) => x.kind)).toEqual(["BAD ENUM"]);
  });

  it("accepts every legitimate value", () => {
    expect(check(`db.insert(widgets).values({ status: "open", name: "ok", note: "any length at all here" } as never);`))
      .toEqual([]);
  });
});

/* ── …and does not cry wolf ──────────────────────────────────────────────── */

describe("the checker does not report things that are fine", () => {
  it("ignores non-literal values it cannot evaluate", () => {
    expect(check(`db.insert(widgets).values({ status: someVar, name: fn() } as never);`)).toEqual([]);
  });

  it("does not read keys out of nested objects", () => {
    // `colour` belongs to the nested payload, not to widgets.
    expect(check(`db.insert(widgets).values({ note: JSON.stringify({ colour: "red" }) } as never);`)).toEqual([]);
  });

  it("does not read CSS out of a template literal", () => {
    /**
     * 🪤 THE FIRST DRAFT REPORTED 94 FINDINGS, nearly all CSS properties lifted
     * out of email HTML — `notifications.margin`, `notifications.color` —
     * because anything shaped like `word:` was treated as a column.
     *
     * ⚖️ The fix was the STRUCTURAL KEY GUARD (a key must follow `{` or `,`),
     * not the template-literal handling. Measured, not assumed: replacing
     * `skipString`'s `${…}` handling with a naive backtick-to-backtick skip
     * still yields zero findings across the repo, so that mutation is
     * EQUIVALENT on today's corpus. It is kept as defence in depth and recorded
     * here so nobody re-chases it as a blind guard.
     */
    const src =
      "db.insert(widgets).values({ note: `<p style=\"margin-bottom: 4px; color: #333\">${x}</p>` } as never);";
    expect(check(src)).toEqual([]);
  });

  it("does not treat a comment inside the payload as a column", () => {
    expect(check(`db.insert(widgets).values({\n  // status: "archived"\n  status: "open",\n} as never);`)).toEqual([]);
  });

  it("skips a write to a table it cannot resolve rather than guessing", () => {
    expect(check(`db.insert(somethingDynamic).values({ anything: "at all" } as never);`)).toEqual([]);
  });
});

/* ── Comment-blind enum parsing ──────────────────────────────────────────── */

describe("enum values come from the array, never from a comment", () => {
  it("the fake enum excludes the word that appears only in a comment", () => {
    expect(FAKE.get("widgets")!.cols.get("status")!.values).toEqual(["open", "closed"]);
  });

  it("tasks.status has SIX values — `approval` is a comment, not a value", () => {
    /**
     * The real instance, and the trap 9f2e78f recorded when its own schema
     * parser hit it: `"draft", // … autopilot "approval" mode`. A phantom makes
     * the check too PERMISSIVE — the bad write sails through here and MySQL
     * rejects it at runtime.
     */
    const { tables, phantomEnumValues } = parseSchema(
      require("fs").readFileSync(join(ROOT, "drizzle/schema.ts"), "utf8"),
    );
    const status = tables.get("tasks")!.cols.get("status")!;
    expect(status.values).toEqual(["open", "done", "cancelled", "in_progress", "snoozed", "draft"]);
    expect(status.values).not.toContain("approval");
    // …and the parser says out loud what it dropped.
    expect(phantomEnumValues).toContain("tasks.status: approval");
  });
});

/* ── Primitives ──────────────────────────────────────────────────────────── */

describe("the parsing primitives", () => {
  it("objectAt returns a balanced slice across nested braces and templates", () => {
    const src = 'x({ a: { b: 1 }, c: `${ { d: 2 } }`, e: 3 })';
    expect(objectAt(src, src.indexOf("{"))).toBe('{ a: { b: 1 }, c: `${ { d: 2 } }`, e: 3 }');
  });

  it("topLevelPairs takes only depth-1 keys", () => {
    const pairs = topLevelPairs('{ a: "x", nested: { b: "y" }, c: fn(), d: "z" }');
    expect(pairs.map((p) => p.key)).toEqual(["a", "nested", "c", "d"]);
    expect(pairs.find((p) => p.key === "a")!.literal).toBe("x");
    expect(pairs.find((p) => p.key === "c")!.literal).toBeNull();
  });
});

/* ── The repo itself ─────────────────────────────────────────────────────── */

describe("no live instance of the class", () => {
  const result = auditRepo(ROOT);

  it("scanned a real repo (floors)", () => {
    /**
     * Without these an empty walk reports a clean codebase. The floors are set
     * well under today's numbers (181 tables / 805 checked) so ordinary growth
     * does not trip them, but a broken glob or a schema-parse failure does.
     */
    expect(result.tables).toBeGreaterThan(150);
    expect(result.checked).toBeGreaterThan(700);
    expect(result.drizzleSites).toBeGreaterThan(result.checked);
  });

  it("finds nothing — and that is the whole result", () => {
    expect(
      result.findings,
      result.findings.length
        ? `\n\nA write cannot survive its column:\n` +
          result.findings.map((f: any) => `  ${f.kind} ${f.table}.${f.column} ${f.detail}\n    ${f.file}`).join("\n") +
          `\n\n\`as never\` hides these from tsc; they throw at runtime, in a cron or\n` +
          `a public handler, with the reason on e.cause rather than e.message.\n`
        : undefined,
    ).toEqual([]);
  });

  it("states its own blind spots rather than implying full coverage", () => {
    /**
     * A scanner that looks exhaustive and isn't is worse than one whose limit
     * is written down (a278a39's staleness check made the same argument). The
     * uncheckable sites are counted, not ignored: variable payloads, the
     * `.values([...])` array form, raw `db.execute(sql\`INSERT …\`)`, and the
     * two genuinely dynamic `db.update(table)` sites.
     */
    expect(result.notCheckable).toBeGreaterThan(0);
    expect(result.unresolvedTableVars.length).toBeGreaterThan(0);
    // Coverage is a number, and it should not quietly collapse.
    expect(result.checked / result.drizzleSites).toBeGreaterThan(0.75);
  });
});
