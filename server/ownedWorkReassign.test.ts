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
    expect(keys).toEqual(["leads", "opportunities", "accounts", "contacts", "campaigns", "tasks"]);
  });

  it("only tasks is status-filtered", () => {
    // Reassigning a CLOSED lead is fine — it still belongs to somebody. A closed
    // task is history, and rewriting its owner rewrites who did the work.
    const live = OWNABLE_TABLES.filter((t) => t.liveOnly).map((t) => t.key);
    expect(live).toEqual(["tasks"]);
  });

  it("every table name is a bare identifier", () => {
    // These are interpolated into SQL with sql.raw — they can never be anything
    // a caller supplies, and the shape is asserted on both sides.
    for (const t of OWNABLE_TABLES) expect(t.table).toMatch(/^[a-z_]+$/);
  });

  it("keys and table names line up, and nothing is duplicated", () => {
    expect(new Set(OWNABLE_TABLES.map((t) => t.key)).size).toBe(OWNABLE_TABLES.length);
    expect(new Set(OWNABLE_TABLES.map((t) => t.table)).size).toBe(OWNABLE_TABLES.length);
  });
});

/* ── The pure helpers, called for real ───────────────────────────────────── */

describe("counting and describing owned work", () => {
  it("totals across every table, not the three it used to know about", () => {
    const owned = { ...zeroOwnedWork(), leads: 1, opportunities: 2, accounts: 4, contacts: 8, campaigns: 16, tasks: 32 };
    expect(totalOwnedWork(owned)).toBe(63);
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
    expect(totalOwnedWork({ ...zeroOwnedWork(), leads: 2, meetings: 99 } as any)).toBe(2);
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
    expect(phrase).toBe("leads, opportunities, accounts, contacts, campaigns and unfinished tasks");
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

describe("the helper itself", () => {
  const fn = windowBetween(admin, "async function reassignOwnedWork(", "function safeTable(");

  it("iterates the shared list rather than naming tables inline", () => {
    expect(fn).toMatch(/for \(const o of OWNABLE_TABLES\)/);
    expect(fn).toMatch(/sql\.raw\(`\\`\$\{safeTable\(o\.table\)\}\\``\)/);
  });

  it("scopes every statement to the workspace AND the outgoing owner", () => {
    // Dropping workspaceId would reassign that user's rows in EVERY workspace
    // they belong to — the streamRouteAuth finding, applied to a bulk UPDATE.
    expect(fn).toMatch(/WHERE workspaceId = \$\{workspaceId\} AND ownerUserId = \$\{fromUserId\}/);
  });

  it("applies the live-task filter to exactly the tables that ask for it", () => {
    expect(fn).toMatch(/\$\{o\.liveOnly \? sql`AND \$\{liveTaskStatuses\(\)\}` : sql``\}/);
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

  it("the success toast totals through the shared helper", () => {
    // It used to read `.leads + .opportunities + .tasks`, which would have kept
    // reporting three of six — telling an admin 4 items moved when 4,000 had.
    expect(ui).toMatch(/totalOwnedWork\(res\.reassigned\)/);
    expect(ui).not.toMatch(/reassigned\.leads \+ /);
  });
});
