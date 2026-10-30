/**
 * Destructive task actions leave a trail (2026-10-30).
 *
 * `tasks.delete` is a hard delete that `/v2/tasks` calls, so any rep could
 * permanently destroy a task — and it recorded nothing, while `create`,
 * `complete`, `bulk` and the four approve-and-sends beside it all recorded an
 * entry. A reviewer could see who finished a task and never who destroyed one.
 * Found 2026-10-29 while checking a different claim, fixed on the owner's word.
 *
 * `attachments.delete` in the same file had the identical gap and is fixed with
 * it. `activities.delete` already did it correctly and is the pattern both now
 * follow — which is why the strongest test here is not about any one procedure
 * but about the FILE: every hard delete in it must be audited, so the next one
 * added cannot quietly skip it.
 *
 * Source pins, because this suite has no database. What they protect is
 * structural — the read before the delete, the row in `before`, the audit after
 * the delete — and that is visible in the source.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8").replace(/\r\n/g, "\n");

const router = read("server/routers/activities.ts");

/** The body of one tRPC procedure, from its name to the next one's. */
function procedure(src: string, name: string): string {
  const start = src.indexOf(`  ${name}: repProcedure`);
  if (start === -1) return "";
  const next = src.indexOf("\n  }),", start);
  return next === -1 ? src.slice(start) : src.slice(start, next);
}

describe("every hard delete in this router is audited", () => {
  it("has as many delete-audits as it has deletes", () => {
    /**
     * THE INVARIANT, and the reason this file exists. Counting rather than
     * naming procedures is deliberate: a test that pinned only `tasks.delete`
     * would pass while a NEW unaudited `db.delete` was added beside it, which
     * is exactly how the two gaps fixed here got in.
     */
    const deletes = (router.match(/db\.delete\(/g) ?? []).length;
    const audited = (router.match(/action: "delete"/g) ?? []).length;
    expect(deletes, "db.delete( call sites").toBeGreaterThan(0);
    expect(audited, "recordAudit action:delete calls").toBe(deletes);
  });

  it("names the three it knows about, so the count cannot drift silently", () => {
    // If a delete is removed rather than added, the count above still balances.
    // These pin which tables the audited deletes are for.
    for (const entity of ['entityType: "task"', 'entityType: "activity"', 'entityType: "attachment"']) {
      expect(router, entity).toContain(entity);
    }
  });
});

describe("the entry carries what the delete destroys", () => {
  for (const [name, table] of [["delete", "tasks"], ["delete", "attachments"]] as const) {
    void name;
    void table;
  }

  it("tasks.delete reads the row BEFORE deleting it and stores it as `before`", () => {
    const proc = procedure(router, "delete");
    expect(proc, "tasks.delete").toContain("const [doomed] = await db");
    expect(proc).toContain(".from(tasks)");
    // Order matters: after a hard delete there is nothing left to read, so a
    // `before` gathered afterwards would be empty and the entry would say that
    // something was deleted without saying what.
    const readAt = proc.indexOf("const [doomed]");
    const deleteAt = proc.indexOf("await db.delete(tasks)");
    const auditAt = proc.indexOf("action: \"delete\"");
    expect(readAt).toBeGreaterThan(-1);
    expect(deleteAt).toBeGreaterThan(readAt);
    expect(auditAt).toBeGreaterThan(deleteAt);
    expect(proc).toContain("before: doomed,");
    // The WHOLE row, not a hand-picked subset: this is the only record that
    // will survive.
    expect(proc).toContain(".select()");
    expect(proc).not.toMatch(/\.select\(\{/);
  });

  it("attachments.delete does the same, and says the stored file is left behind", () => {
    const att = router.slice(router.indexOf("Remove an attachment record"));
    expect(att).toContain("const [doomed] = await db");
    expect(att).toContain(".from(attachments)");
    expect(att).toContain('entityType: "attachment"');
    expect(att).toContain("before: doomed,");
    // The orphaned object is a known limit, written down where the next reader
    // will be standing rather than left to be discovered.
    // One line's worth: the sentence wraps in the source comment.
    expect(att).toContain("stored object behind `fileKey` is left where it is");
  });
});

describe("an attempt on a row that is not there is not a deletion", () => {
  it("records nothing when the id matches no row in this workspace", () => {
    const proc = procedure(router, "delete");
    const guard = proc.indexOf("if (!doomed) return { ok: true };");
    const deleteAt = proc.indexOf("await db.delete(tasks)");
    expect(guard, "the not-found guard").toBeGreaterThan(-1);
    // Before the delete, so a cross-tenant id writes no audit entry claiming a
    // deletion that never happened.
    expect(guard).toBeLessThan(deleteAt);
  });

  it("stays idempotent rather than throwing, unlike activities.delete", () => {
    /**
     * `activities.delete` throws NOT_FOUND for a missing row; this returns ok.
     * The difference is deliberate: /v2/tasks can fire a delete twice (a
     * double-click, a retry), and turning the second one into a visible error
     * would be a regression in behaviour for no gain in truthfulness — the
     * task is gone either way, and the first call recorded why.
     */
    const proc = procedure(router, "delete");
    expect(proc).toContain("if (!doomed) return { ok: true };");
    expect(proc).not.toContain('code: "NOT_FOUND"');
  });
});

describe("the WHERE clauses stay readable to the tenant-scope guard", () => {
  it("writes both predicates out rather than hoisting them into a variable", () => {
    /**
     * `tenantScope.test.ts` reads the ARGUMENT TEXT of `.where()`, so
     * `.where(scope)` is invisible to it and the statement stops being one it
     * protects — its own comment records a previous hoist that left the guard
     * green while the bug came back. My first version of this fix hoisted a
     * `const scope` for the select and the delete to share, and that guard
     * caught it (2026-10-30). The repetition below is deliberate.
     */
    for (const table of ["tasks", "attachments"]) {
      expect(router, table).toContain(
        `await db.delete(${table}).where(and(eq(${table}.id, input.id), eq(${table}.workspaceId, ctx.workspace.id)));`,
      );
    }
    expect(router).not.toMatch(/\.where\(scope\)/);
  });
});

describe("what this change did NOT do, pinned so nobody assumes otherwise", () => {
  it("leaves the delete hard — no soft-delete column was added", () => {
    // Recoverability needs a column and every read filtered, which is a product
    // decision. The audit entry is a record, not an undo.
    expect(read("drizzle/schema.ts")).not.toMatch(/tasks[\s\S]{0,400}deletedAt/);
    expect(router).toContain("this is still a hard delete, not a soft one");
  });

  it("leaves tasks.update and tasks.snooze unaudited, and does not pretend otherwise", () => {
    /**
     * Both are reversible state changes with no data loss, and `update` has no
     * caller anywhere in client/src (checked 2026-10-29). They were reported
     * rather than fixed here: the owner asked for the destructive gap. This
     * test exists so that "tasks are audited" is never read as more than it is
     * — if someone audits them later, it should fail and be deleted on purpose.
     */
    const update = procedure(router, "update");
    expect(update, "tasks.update").not.toContain("recordAudit");
  });
});
