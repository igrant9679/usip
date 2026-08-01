/**
 * A confirm dialog is a promise. This pins one to the code that keeps it.
 *
 * THE SEAM: every `ConfirmButton` states what is about to happen — "will be
 * emailed", "permanently deleted", "cannot be undone". That text is the only
 * thing the user has to go on, and nothing tied it to the handler. 23 confirm
 * dialogs carry such a claim; 12 assert a side effect.
 *
 * 🔴 The one this commit fixes: Custom Fields' delete said "Deleting a custom
 * field definition removes its stored values from every record of this type.
 * This cannot be undone." `deleteDef` deleted the DEFINITION ROW ONLY —
 * nothing anywhere stripped the key from any record's customFields JSON.
 *
 * Both halves were false. The values survived in full, so an admin deleting a
 * field because it held something sensitive was told it was gone when it was
 * not; and recreating a field with the same fieldKey brought every old value
 * back, which is the opposite of "cannot be undone".
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..");
/** Line-leading block comments only — a `/*` inside a string is not a comment. */
const strip = (s: string) =>
  s.replace(/^\s*\/\*[\s\S]*?\*\//gm, "").replace(/^\s*\/\/.*$/gm, "");

const router = strip(readFileSync(join(ROOT, "server/routers/customFields.ts"), "utf8"));
const ui = readFileSync(join(ROOT, "client/src/pages/usip/CustomFields.tsx"), "utf8");

const deleteDef = (() => {
  const at = router.indexOf("deleteDef: adminWsProcedure");
  expect(at, "deleteDef not found — every assertion below would be vacuous").toBeGreaterThan(0);
  // Bounded at the next procedure, or the end of the router.
  const next = router.indexOf("getValues:", at);
  return next > at ? router.slice(at, next) : router.slice(at);
})();

describe("the dialog still makes the promise", () => {
  it("says the stored values are removed", () => {
    // If this copy is ever softened, the assertions below stop being the right
    // thing to demand — so the test fails and someone has to decide which half
    // of the pair is wrong.
    expect(ui).toMatch(/removes its stored values from every record/i);
  });
});

describe("deleteDef keeps it", () => {
  it("isolated the handler", () => {
    expect(deleteDef.length).toBeGreaterThan(400);
    expect(deleteDef).not.toContain("getValues:");
  });

  it("actually strips the values — in an EXECUTED statement", () => {
    /**
     * Bound to the awaited update, not merely present in the file.
     *
     * The first version asserted `toContain("JSON_REMOVE")`, and the headline
     * mutation — disabling the update so only the definition is deleted, i.e.
     * the exact production bug — PASSED, because the JSON_REMOVE text was still
     * sitting there in an unreachable closure. Third time this session a guard
     * checked that a token exists rather than that it runs.
     */
    expect(
      deleteDef,
      "\n\nThe confirm dialog promises the stored values are removed. Deleting\n" +
        "only the definition leaves them in every record, and recreating the\n" +
        "field with the same key brings them all back.\n",
    ).toMatch(/const res = await db[\s\S]{0,120}?\.update\(table\)[\s\S]{0,400}?JSON_REMOVE/);
  });

  it("reads the definition BEFORE deleting it", () => {
    // entityType + fieldKey are the only way to know which table and which key
    // to clear; deleting first makes that impossible.
    const read = deleteDef.indexOf("select({ entityType");
    const del = deleteDef.indexOf("delete(customFieldDefs)");
    expect(read).toBeGreaterThan(0);
    expect(del).toBeGreaterThan(0);
    expect(read).toBeLessThan(del);
  });

  it("strips values BEFORE deleting the definition", () => {
    /**
     * There is no `.transaction(` anywhere in this server. Strip-then-delete
     * fails visibly and retryably; delete-then-strip orphans values under a
     * definition that no longer exists, which nothing would ever clean up.
     */
    const strip_ = deleteDef.indexOf("JSON_REMOVE");
    const del = deleteDef.indexOf("delete(customFieldDefs)");
    expect(strip_).toBeLessThan(del);
  });

  it("scopes the value strip to the workspace", () => {
    expect(deleteDef).toMatch(/eq\(table\.workspaceId, ctx\.workspace\.id\)/);
  });

  it("binds the JSON path as a parameter, never interpolated into SQL", () => {
    // fieldKey is snake_case-validated at creation, but "it was validated on
    // the way in" is an argument about the past, not about this statement.
    expect(deleteDef).toMatch(/const path = `\$\."\$\{def\.fieldKey\}"`/);
    expect(deleteDef).toMatch(/JSON_REMOVE\(\$\{table\.customFields\}, \$\{path\}\)/);
  });

  it("only touches rows that actually have the key", () => {
    expect(deleteDef).toContain("JSON_CONTAINS_PATH");
  });
});

describe("every entity type can actually be cleared", () => {
  it("ENTITY_TABLE covers every ENTITY_TYPES member", () => {
    /**
     * A new entity type added to ENTITY_TYPES without a table here would delete
     * its definition and silently leave the values behind — the original bug,
     * reintroduced for one entity only and invisible everywhere else.
     */
    const types = (/const ENTITY_TYPES = \[([^\]]*)\]/.exec(router) || [])[1] ?? "";
    const declared = [...types.matchAll(/"([a-z]+)"/g)].map((m) => m[1]);
    expect(declared.length).toBeGreaterThanOrEqual(4);

    const mapping = (/const ENTITY_TABLE = \{([\s\S]*?)\} as const;/.exec(router) || [])[1] ?? "";
    const mapped = [...mapping.matchAll(/^\s*(\w+):/gm)].map((m) => m[1]);
    expect(
      declared.filter((t) => !mapped.includes(t)),
      "\n\nAn entity type with no ENTITY_TABLE entry deletes its definition and\n" +
        "leaves every stored value in place — the exact bug this commit fixes.\n",
    ).toEqual([]);
  });
});
