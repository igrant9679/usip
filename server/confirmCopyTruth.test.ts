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

/**
 * Second claim from the same sweep. Campaigns' delete dialog says "This
 * permanently removes the campaign AND ITS SETUP." It deleted the campaigns row
 * only — `campaign_components` (which IS the setup: the sequence / social post
 * / ad / content / event components) and `campaign_step_stats` were left keyed
 * to a campaign id that no longer exists, and NOTHING anywhere deletes by
 * campaignId, so nothing would ever collect them.
 */
describe("campaigns.delete removes the setup it promises to", () => {
  const ops = strip(readFileSync(join(ROOT, "server/routers/operations.ts"), "utf8"));
  const campaignsUi = readFileSync(join(ROOT, "client/src/pages/usip/Campaigns.tsx"), "utf8");

  const del = (() => {
    const router = ops.slice(ops.indexOf("campaignsRouter = router("));
    const at = router.indexOf("delete: repProcedure");
    expect(at, "campaigns delete not found").toBeGreaterThan(0);
    const next = router.indexOf("updateOutreach:", at);
    expect(next, "could not bound the handler").toBeGreaterThan(at);
    return router.slice(at, next);
  })();

  it("the dialog still promises the setup goes too", () => {
    expect(campaignsUi).toMatch(/removes the campaign and its setup/i);
  });

  it("deletes campaign_components — the setup — in an executed statement", () => {
    expect(
      del,
      "\n\nThe dialog promises the setup is removed. campaign_components IS the\n" +
        "setup; leaving it behind orphans rows nothing will ever collect.\n",
    ).toMatch(/await db[\s\S]{0,80}?\.delete\(campaignComponents\)/);
  });

  it("deletes campaign_step_stats too", () => {
    expect(del).toMatch(/await db[\s\S]{0,80}?\.delete\(campaignStepStats\)/);
  });

  it("scopes both child deletes by workspace as well as campaign", () => {
    // A parent check is only a check when the CHILD is tied to that parent —
    // and both these tables carry their own workspaceId.
    expect(del).toMatch(/campaignComponents\.workspaceId/);
    expect(del).toMatch(/campaignStepStats\.workspaceId/);
  });

  it("verifies ownership BEFORE deleting anything, and USES the result", () => {
    /**
     * Bound to the query, not merely ordered before the deletes.
     *
     * A mutation replacing `const [owned] = await db.select(...)` with
     * `const owned = { id: input.id }` passed the first version — the select
     * text was still there, still ahead of the deletes, and completely
     * ignored. FOURTH time this session that presence-not-effect has slipped a
     * mutation through; the shape has to be assumed now, not discovered.
     */
    expect(
      del,
      "\n\n`owned` must be the RESULT of the workspace-scoped select — otherwise\n" +
        "the deletes below run on a caller-supplied id.\n",
    ).toMatch(/const \[owned\] = await db[\s\S]{0,120}?\.select\(\{ id: campaigns\.id \}\)/);
    const check = del.indexOf("const [owned]");
    expect(check).toBeGreaterThan(0);
    expect(check).toBeLessThan(del.indexOf(".delete("));
  });

  it("deletes children BEFORE the parent", () => {
    // A child delete that runs after the parent is gone has nothing left to
    // find it by — the shape recorded for tours.deleteTour and quotes.delete.
    const child = del.indexOf(".delete(campaignComponents)");
    const parent = del.indexOf(".delete(campaigns)");
    expect(child).toBeGreaterThan(0);
    expect(parent).toBeGreaterThan(0);
    expect(child).toBeLessThan(parent);
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
