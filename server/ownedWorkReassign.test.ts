/**
 * Offboarding must move everything it says it moves.
 *
 * THE SEAM: `team.deactivate`, `team.delete` and `team.bulkDeactivate` each
 * reassigned leads, opportunities and live tasks — and each spelled the three
 * UPDATE statements out itself. Three more places DESCRIBE that work to the
 * admin about to click the button (the deactivate dialog, the delete dialog's
 * helper text, the bulk dialog), and those said "leads, opportunities, and
 * unfinished tasks" too.
 *
 * Both populations were wrong in the same direction. `accounts`, `contacts` and
 * `campaigns` all carry `ownerUserId`, none of them moved, and the dialogs did
 * not mention them — so an admin who reassigned a departing rep's work, exactly
 * as instructed, still left every account and contact that rep owned pointing
 * at a member who was about to be deleted.
 *
 * `@shared/ownedWork` is now the single list. The statements iterate it and the
 * dialog copy is GENERATED from it, so the promise and the behaviour cannot
 * drift apart — which is the only durable version of the `a172d7f` lesson that
 * a confirm dialog is a promise.
 *
 * The pure half is exercised for real. The DB half is source-scanned, bounded
 * per procedure, because there is no database here — the same verdict
 * senderFallback and approvalQueueRanking reached.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  OWNABLE_TABLES,
  describeOwnedWork,
  ownedWorkNounPhrase,
  summariseReassigned,
  totalOwnedWork,
  zeroOwnedWork,
} from "@shared/ownedWork";

const ROOT = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const admin = strip(read("server/routers/admin.ts"));

function windowBetween(src: string, startAnchor: string, endAnchor: string, minLen = 200): string {
  const at = src.indexOf(startAnchor);
  expect(at, `start anchor not found — assertions on this window would be meaningless: ${startAnchor}`).toBeGreaterThan(-1);
  const end = src.indexOf(endAnchor, at + startAnchor.length);
  expect(end, `end anchor not found after the start — the window would run to EOF: ${endAnchor}`).toBeGreaterThan(at);
  const w = src.slice(at, end);
  expect(w.length, `window too small to be the real block: ${startAnchor}`).toBeGreaterThan(minLen);
  return w;
}

/* ── The list itself ─────────────────────────────────────────────────────── */

describe("the ownable-work list", () => {
  it("still contains the three tables this change added", () => {
    /**
     * FLOOR, and a pointed one. These three are the whole finding: they carry
     * ownerUserId, they were not being reassigned, and nothing told the admin.
     * Removing one silently restores the bug for that table.
     */
    const keys = OWNABLE_TABLES.map((t) => t.key);
    expect(keys).toContain("accounts");
    expect(keys).toContain("contacts");
    expect(keys).toContain("campaigns");
    expect(keys).toContain("meetings");
    expect(keys).toEqual([
      "leads", "opportunities", "accounts", "contacts", "campaigns", "areCampaigns",
      "sequences", "assignedSequences", "meetings", "tasks",
    ]);
  });

  it("covers BOTH campaign tables, which are different things", () => {
    /**
     * `campaigns` and `are_campaigns` are separate tables whose owner columns
     * share a name, and only the first was here. `are_campaigns` is the
     * autonomous engine — the one that sources strangers, mails them and
     * promotes the ones who reply — so its owner is the more consequential of
     * the two. Two near-identical names is exactly the shape that gets
     * half-covered.
     */
    const tables = OWNABLE_TABLES.map((t) => t.table);
    expect(tables).toContain("campaigns");
    expect(tables).toContain("are_campaigns");
  });

  it("a sequence's TWO owner columns are both covered", () => {
    /**
     * `ownerUserId` is who created or forked it; `assignedToUserId` is the rep
     * a manager handed it to. They move independently, so one entry each — and
     * `sequences.fork` makes every fork `private` and owned by the forking rep,
     * which is why this is the common shape of a rep's work rather than an edge
     * case. Covering only `ownerUserId` would leave every hand-assigned
     * sequence pointing at the leaver.
     */
    const seq = OWNABLE_TABLES.filter((t) => t.table === "sequences");
    expect(seq.map((t) => t.column).sort()).toEqual(["assignedToUserId", "ownerUserId"]);
    expect(seq.every((t) => t.scope === "all")).toBe(true);
  });

  it("scopes exactly the two tables where the PAST must not be rewritten", () => {
    /**
     * Reassigning a CLOSED lead is fine — it still belongs to somebody. A
     * closed task is history, and rewriting its owner rewrites who did the
     * work; a meeting that already happened is the same. Everything else is
     * `all`, and a table quietly gaining a scope would stop moving rows the
     * dialogs promise to move.
     */
    const byScope = (s: string) => OWNABLE_TABLES.filter((t) => t.scope === s).map((t) => t.key);
    expect(byScope("live_tasks")).toEqual(["tasks"]);
    expect(byScope("future_meetings")).toEqual(["meetings"]);
    expect(byScope("all")).toEqual([
      "leads", "opportunities", "accounts", "contacts", "campaigns", "areCampaigns",
      "sequences", "assignedSequences",
    ]);
  });

  it("every table AND column name is a bare identifier", () => {
    // Both are interpolated into SQL with sql.raw — they can never be anything
    // a caller supplies, and the shape is asserted on both sides.
    for (const t of OWNABLE_TABLES) {
      expect(t.table).toMatch(/^[a-z_]+$/);
      expect(t.column).toMatch(/^[a-zA-Z][a-zA-Z0-9_]*$/);
    }
  });

  it("keys are unique, and so is every (table, column) pair", () => {
    /**
     * The table alone is NO LONGER unique — `sequences` appears twice, once per
     * owner column. What must not repeat is the pair, because two entries
     * hitting the same column would run the same UPDATE twice and double-count
     * it, and `key` because it indexes the counts object the API returns.
     */
    expect(new Set(OWNABLE_TABLES.map((t) => t.key)).size).toBe(OWNABLE_TABLES.length);
    expect(new Set(OWNABLE_TABLES.map((t) => `${t.table}.${t.column}`)).size).toBe(OWNABLE_TABLES.length);
  });
});

/* ── The pure helpers, called for real ───────────────────────────────────── */

describe("counting and describing owned work", () => {
  it("totals across every table, not the three it used to know about", () => {
    const owned = { ...zeroOwnedWork(), leads: 1, opportunities: 2, accounts: 4, contacts: 8, campaigns: 16, meetings: 32, tasks: 64 };
    expect(totalOwnedWork(owned)).toBe(127);
  });

  it("a member owning ONLY upcoming meetings still counts as owning work", () => {
    // The one that decides whether a prospect turns up to meet nobody.
    expect(totalOwnedWork({ ...zeroOwnedWork(), meetings: 1 })).toBe(1);
    expect(describeOwnedWork({ ...zeroOwnedWork(), meetings: 1 })).toBe("1 upcoming meeting");
    expect(describeOwnedWork({ ...zeroOwnedWork(), meetings: 4 })).toBe("4 upcoming meetings");
  });

  it("a member owning ONLY accounts still counts as owning work", () => {
    /**
     * The regression that matters. Under the old three-table count this
     * returned 0, so the delete guard never fired and the rows were left
     * pointing at a user about to be removed.
     */
    expect(totalOwnedWork({ ...zeroOwnedWork(), accounts: 12 })).toBe(12);
    expect(totalOwnedWork({ ...zeroOwnedWork(), contacts: 5 })).toBe(5);
    expect(totalOwnedWork({ ...zeroOwnedWork(), campaigns: 1 })).toBe(1);
  });

  it("ignores keys it does not own", () => {
    // A stale field from an older client must not inflate the total.
    expect(totalOwnedWork({ ...zeroOwnedWork(), leads: 2, proposals: 99 } as any)).toBe(2);
  });

  it("survives null/undefined rather than throwing at an admin", () => {
    expect(totalOwnedWork(null)).toBe(0);
    expect(totalOwnedWork(undefined)).toBe(0);
    expect(describeOwnedWork(null)).toBe("no owned work");
    expect(summariseReassigned(undefined)).toBe("nothing to move");
  });

  it("names every non-zero table in the refusal, and no zero ones", () => {
    const msg = describeOwnedWork({ ...zeroOwnedWork(), leads: 3, accounts: 1, tasks: 2 });
    expect(msg).toBe("3 leads, 1 account and 2 unfinished tasks");
    expect(msg).not.toContain("contact");
    expect(msg).not.toContain("campaign");
    expect(msg).not.toContain("0 ");
  });

  it("singularises, including the irregular one", () => {
    expect(describeOwnedWork({ ...zeroOwnedWork(), opportunities: 1 })).toBe("1 opportunity");
    expect(describeOwnedWork({ ...zeroOwnedWork(), opportunities: 2 })).toBe("2 opportunities");
    expect(describeOwnedWork({ ...zeroOwnedWork(), tasks: 1 })).toBe("1 unfinished task");
  });

  it("reads as English at one, two and three items", () => {
    expect(describeOwnedWork({ ...zeroOwnedWork(), leads: 1 })).toBe("1 lead");
    expect(describeOwnedWork({ ...zeroOwnedWork(), leads: 1, accounts: 1 })).toBe("1 lead and 1 account");
    expect(describeOwnedWork({ ...zeroOwnedWork(), leads: 1, accounts: 1, tasks: 1 }))
      .toBe("1 lead, 1 account and 1 unfinished task");
  });

  it("the dialog phrase names every table, so the promise is complete", () => {
    const phrase = ownedWorkNounPhrase();
    for (const t of OWNABLE_TABLES) {
      expect(phrase, `the confirm dialogs would not mention ${t.key}`).toContain(t.plural);
    }
    expect(phrase).toBe(
      "leads, opportunities, accounts, contacts, campaigns, autonomous campaigns, " +
      "sequences, assigned sequences, upcoming meetings and unfinished tasks",
    );
  });
});

/* ── The three procedures share one implementation ───────────────────────── */

const PROCEDURES: Array<{ what: string; start: string; end: string }> = [
  { what: "deactivate", start: "  deactivate: adminWsProcedure", end: "  reactivate: adminWsProcedure" },
  { what: "delete", start: "  delete: adminWsProcedure", end: "  bulkChangeRole: adminWsProcedure" },
  { what: "bulkDeactivate", start: "  bulkDeactivate: adminWsProcedure", end: "  updateNotifPrefs: workspaceProcedure" },
];

describe("all three offboarding paths reassign through the one helper", () => {
  it("checks all three (floor)", () => {
    expect(PROCEDURES.length).toBe(3);
  });

  for (const p of PROCEDURES) {
    it(`${p.what} calls reassignOwnedWork`, () => {
      const w = windowBetween(admin, p.start, p.end);
      expect(w).toMatch(/await reassignOwnedWork\(db, ctx\.workspace\.id, target\.userId, input\.reassignToUserId\)/);
    });

    it(`${p.what} has no hand-rolled reassignment of its own`, () => {
      /**
       * The anti-drift half, and the one that actually matters. Calling the
       * helper proves nothing if a private `UPDATE accounts SET ownerUserId`
       * survives beside it — that is how three copies became inconsistent in
       * the first place.
       */
      const w = windowBetween(admin, p.start, p.end);
      expect(w, `${p.what} still contains its own ownerUserId UPDATE`)
        .not.toMatch(/UPDATE\s+\w+\s+SET\s+ownerUserId/i);
    });
  }
});

describe("the delete guard counts the same set it reassigns", () => {
  const del = windowBetween(admin, "  delete: adminWsProcedure", "  bulkChangeRole: adminWsProcedure");

  it("counts through the shared helper, not a private query", () => {
    expect(del).toMatch(/const owned = await countOwnedWork\(db, ctx\.workspace\.id, target\.userId\)/);
    expect(del).not.toMatch(/SELECT COUNT\(\*\) AS n FROM (leads|opportunities|accounts|contacts|campaigns|tasks)/i);
  });

  it("the refusal is gated on the shared total, and describes what it found", () => {
    // Pinned as a STATEMENT: `if (false && totalOwnedWork(owned) > 0)` would
    // satisfy a bare presence check while every delete sailed through.
    expect(del).toMatch(/if \(totalOwnedWork\(owned\) > 0\) \{/);
    expect(del).toMatch(/if \(!input\.reassignToUserId\) \{[\s\S]{0,200}?describeOwnedWork\(owned\)/);
  });

  it("refuses BEFORE it reassigns or deletes anything", () => {
    const guardAt = del.search(/if \(totalOwnedWork\(owned\) > 0\) \{/);
    const moveAt = del.search(/await reassignOwnedWork\(/);
    const delAt = del.search(/\.delete\(workspaceMembers\)/);
    expect(guardAt).toBeGreaterThan(-1);
    expect(moveAt).toBeGreaterThan(guardAt);
    expect(delAt).toBeGreaterThan(guardAt);
  });
});

describe("the COUNT reads the same column it will move", () => {
  /**
   * 🔴 ADDED AFTER A MUTATION PASSED. Everything below pins the UPDATE's
   * column; nothing pinned the COUNT's, so hardcoding it back to `ownerUserId`
   * went unnoticed — and that is the disarmed-guard bug one level down. A rep
   * who OWNS nothing but has sequences ASSIGNED to them would count as owning
   * zero, the delete refusal would not fire, and the assignments would be left
   * pointing at a member who no longer exists.
   */
  const countFn = windowBetween(admin, "async function countOwnedWork(", "async function reassignOwnedWork(");

  it("matches on the entry's own column", () => {
    expect(countFn).toMatch(/AND \$\{sql\.raw\(`\\`\$\{safeColumn\(o\.column\)\}\\``\)\} = \$\{userId\}/);
    expect(countFn).not.toMatch(/AND ownerUserId = /);
  });

  it("applies the entry's own scope and workspace", () => {
    expect(countFn).toMatch(/WHERE workspaceId = \$\{workspaceId\}/);
    expect(countFn).toMatch(/\$\{scopeCondition\(o\.scope, now\)\}/);
  });
});

describe("the identifier validators are real", () => {
  /**
   * `safeTable` / `safeColumn` are defence in depth — both values come from a
   * frozen array — but a check nothing verifies is a check that rots. Pinned as
   * STATEMENTS: `if (false) throw` left the function present and the guard gone.
   */
  const fns = windowBetween(admin, "function safeTable(", "function scopeCondition(", 200);

  it("safeTable refuses anything that is not a bare table name", () => {
    expect(fns).toMatch(/if \(!\/\^\[a-z_\]\+\$\/\.test\(t\)\) throw new Error\(/);
  });

  it("safeColumn refuses anything that is not a bare column name", () => {
    expect(fns).toMatch(/if \(!\/\^\[a-zA-Z\]\[a-zA-Z0-9_\]\*\$\/\.test\(c\)\) throw new Error\(/);
  });
});

describe("the helper itself", () => {
  const fn = windowBetween(admin, "async function reassignOwnedWork(", "function safeTable(");

  it("iterates the shared list rather than naming tables inline", () => {
    expect(fn).toMatch(/for \(const o of OWNABLE_TABLES\)/);
    expect(fn).toMatch(/sql\.raw\(`\\`\$\{safeTable\(o\.table\)\}\\``\)/);
  });

  it("scopes every statement to the workspace AND the outgoing owner", () => {
    // Dropping workspaceId would reassign that user's rows in EVERY workspace
    // they belong to — the streamRouteAuth finding, applied to a bulk UPDATE.
    expect(fn).toMatch(/WHERE workspaceId = \$\{workspaceId\} AND \$\{sql\.raw\(`\\`\$\{safeColumn\(o\.column\)\}\\``\)\} = \$\{fromUserId\}/);
  });

  it("matches and sets the SAME column", () => {
    /**
     * The pair that has to agree. Setting `ownerUserId` while matching on
     * `assignedToUserId` would hand the wrong rows to the new member and leave
     * the assignment untouched — and with two entries per table it is now a
     * mistake the shape of the code invites.
     */
    const sets = [...fn.matchAll(/SET \$\{sql\.raw\(`\\`\$\{safeColumn\(o\.column\)\}\\``\)\} = \$\{toUserId\}/g)];
    expect(sets.length, "the SET no longer uses the entry's own column").toBe(1);
    expect(fn).not.toMatch(/SET ownerUserId =/);
  });

  it("applies each table's own scope, from the shared list", () => {
    expect(fn).toMatch(/\$\{scopeCondition\(o\.scope, now\)\}/);
  });

  it("the future_meetings scope really restricts to future AND live", () => {
    /**
     * 🔴 ADDED AFTER TWO MUTATIONS PASSED. Everything above proved the scope is
     * APPLIED; nothing proved what it CONTAINS, so gutting this branch — the
     * one thing stopping past meetings being reassigned — went unnoticed.
     * Presence of a call is not the presence of a condition.
     *
     * Both terms are pinned because each alone is a different wrong answer:
     * without the status test, cancelled and completed meetings move; without
     * the date bound, last quarter's meetings are re-attributed to someone who
     * was not in them.
     */
    const scope = windowBetween(admin, `case "future_meetings":`, "const RESET_ON_REASSIGN", 100);
    expect(scope).toMatch(/AND status IN \(\$\{sql\.join\(liveMeetingStatuses\(\)/);
    expect(scope).toMatch(/AND \(scheduledAt IS NULL OR scheduledAt >= \$\{now\}\)/);
  });

  it("the date bound is a bound parameter, not MySQL NOW()", () => {
    // NOW() reads the session timezone. This repo has already shipped a cron
    // that compared times in a zone nobody chose (d682552).
    const scope = windowBetween(admin, "function scopeCondition(", "const RESET_ON_REASSIGN", 200);
    expect(scope).not.toMatch(/\bNOW\(\)/);
    expect(scope).toMatch(/\$\{now\}/);
  });

  it("resets the calendar linkage when a meeting changes hands", () => {
    /**
     * The honest half. Moving ownerUserId does not move the provider calendar
     * event or the invite already in the attendee's inbox — both still belong
     * to the person leaving. A row that kept `inviteSent = 1` would be telling
     * the new host the meeting is on their calendar when it is not.
     */
    expect(fn).toMatch(/\$\{RESET_ON_REASSIGN\[o\.key\] \?\? sql``\}/);
    const reset = windowBetween(admin, "const RESET_ON_REASSIGN", "};", 60);
    expect(reset).toMatch(/meetings: sql`, calendarEventId = NULL, calendarAccountId = NULL, inviteSent = 0`/);
  });

  it("every reset key is an ENTRY that is actually reassigned", () => {
    /**
     * Keyed by `key`, not `table`. `sequences` appears twice, so a reset keyed
     * on the table name would fire on both passes — and a reset for something
     * not in the list at all is dead code that reads as coverage.
     */
    const reset = windowBetween(admin, "const RESET_ON_REASSIGN", "};", 60);
    const keys = [...reset.matchAll(/^\s*(\w+):\s*sql`/gm)].map((m) => m[1]!);
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) {
      expect(OWNABLE_TABLES.map((t) => t.key), `${k} is reset but never reassigned`).toContain(k);
    }
  });

  it("counts rows actually affected, not the length of the list", () => {
    expect(fn).toMatch(/out\[o\.key\] = Number\(res\?\.affectedRows \?\? 0\)/);
  });
});

/* ── The dialogs promise exactly what the code does ──────────────────────── */

describe("the confirm dialogs are generated from the same list", () => {
  const ui = read("client/src/pages/usip/Team.tsx");

  it("all three dialogs call ownedWorkNounPhrase()", () => {
    /**
     * FLOOR of three: deactivate, delete-helper-text, bulk. A hardcoded
     * sentence in any of them is a promise that stops tracking the code the
     * moment a table is added — which is precisely how this bug shipped.
     */
    const uses = (ui.match(/ownedWorkNounPhrase\(\)/g) ?? []).length;
    expect(uses, "a dialog is describing owned work in its own words").toBe(3);
    expect(ui).toMatch(/^import \{[^}]*ownedWorkNounPhrase[^}]*\} from "@shared\/ownedWork";$/m);
  });

  it("no dialog restates the old three-table list", () => {
    // The exact sentences that were wrong, so re-introducing one fails here.
    expect(ui).not.toMatch(/leads,\s*opportunities,?\s*and unfinished tasks/i);
    expect(ui).not.toMatch(/leads,\s*opportunities,\s*or open tasks/i);
  });

  it("every dialog opens with the reassign picker already filled", () => {
    /**
     * The set of ownable things is long enough that any long-tenured member
     * trips the "choose someone to reassign to" gate, so an empty picker on
     * every open turns a safety rail into an obstacle. Each site that OPENS one
     * of the three dialogs must seed the state from `defaultReassignFor`.
     *
     * The old shape is asserted absent rather than the new one merely present:
     * `setDeleteTarget(m); setDeleteReassignTo(null)` would leave the picker
     * blank again and still satisfy a count of `defaultReassignFor` uses
     * elsewhere in the file.
     */
    expect(ui).toMatch(/const defaultReassignFor = \(target: any\): number \| null =>/);
    const uses = (ui.match(/defaultReassignFor\(/g) ?? []).length;
    expect(uses, "a dialog-opening site no longer seeds the picker").toBeGreaterThanOrEqual(5);

    // `(?!null)` matters: closing a dialog legitimately nulls BOTH — the
    // onOpenChange and Cancel handlers do exactly that, and the first version
    // of this assertion flagged them.
    expect(ui, "a delete site reopened with an empty picker")
      .not.toMatch(/setDeleteTarget\((?!null)[^)]*\);\s*setDeleteReassignTo\(null\)/);
    expect(ui, "a deactivate site reopened with an empty picker")
      .not.toMatch(/setDeactivateTarget\((?!null)[^)]*\);\s*setReassignTo\(null\)/);
  });

  it("the default is never an option the picker would hide", () => {
    /**
     * A pre-filled value that is not among the <option>s renders as a blank
     * select, which reads as broken. Two exclusions exist and both are pinned:
     * the actor cannot be the target (the server refuses that outright), and
     * for BULK the actor must not be inside the current selection, because that
     * picker hides everyone selected.
     */
    expect(ui).toMatch(/if \(!me \|\| \(target && target\.userId === me\)\) return null;/);
    expect(ui).toMatch(/return mine && !mine\.deactivatedAt \? me : null;/);
    expect(ui).toMatch(/setBulkReassignTo\(mine && !selected\.has\(mine\.memberId\) \? fallback : null\)/);
  });

  it("the success toast totals through the shared helper", () => {
    // It used to read `.leads + .opportunities + .tasks`, which would have kept
    // reporting three of six — telling an admin 4 items moved when 4,000 had.
    expect(ui).toMatch(/totalOwnedWork\(res\.reassigned\)/);
    expect(ui).not.toMatch(/reassigned\.leads \+ /);
  });
});
