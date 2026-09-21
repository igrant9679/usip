/**
 * The audit log's CSV export (2026-09-20).
 *
 * WHAT WAS ACTUALLY WRONG, in three layers:
 *
 *   1. `audit.list` applied its entityType / actorUserId filters in JS AFTER
 *      `.limit(500)`. That returns "the matches inside the newest 500 rows",
 *      not "the newest 500 matching rows" — so on a busy workspace a filter for
 *      `lead` showed three entries and read as "almost nothing happened".
 *      teamRouter.getMemberActivityLog (server/routers/admin.ts) had always
 *      filtered auditLog in SQL; `list` was the outlier.
 *   2. The Export CSV button built the file IN THE BROWSER out of whatever rows
 *      `list` had returned. It therefore inherited bug 1, capped the export at
 *      the 500 rows on screen, omitted the before/after diff the page header
 *      promises, and escaped every field with `JSON.stringify` — which
 *      backslash-escapes rather than doubling quotes, so any value containing a
 *      quote produced a file Excel parses wrong.
 *   3. Because it was browser-built there was no server call to refuse, so the
 *      `export_data` permission could only HIDE the button.
 *
 * The export is now `audit.exportCsv`, rendered server-side and gated. The
 * gate itself is pinned in server/permissionEnforcement.test.ts alongside the
 * other server-rendered exports; this file pins the export's own shape.
 *
 * NOTHING pinned CSV export anywhere in this repo before today — not
 * reports.exportCsv, not are.prospects.exportRejections, not the four
 * browser-built exports still carrying the JSON.stringify escaper
 * (Contacts.tsx, Leads.tsx, Pipeline.tsx, ImportContacts.tsx). Those four
 * remain out of scope and unprotected; that is a follow-up, not an oversight.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..");
const OPS = readFileSync(join(ROOT, "server/routers/operations.ts"), "utf8");
const AUDIT_UI = readFileSync(join(ROOT, "client/src/pages/usip/Audit.tsx"), "utf8");

/** The helpers plus the whole router, bounded by the next exported router. */
const block = (() => {
  const from = OPS.indexOf("const AUDIT_EXPORT_CAP");
  const to = OPS.indexOf("export const notificationsRouter");
  expect(from, "the audit export helpers have moved — re-anchor this file").toBeGreaterThan(-1);
  expect(to, "notificationsRouter has moved — re-anchor this file").toBeGreaterThan(from);
  return OPS.slice(from, to);
})();

/** Just the exportCsv handler, for the assertions that must not be satisfied
 *  by something `list` happens to contain. */
const exportWindow = (() => {
  const at = block.indexOf("exportCsv: adminWsProcedure");
  expect(at, "audit.exportCsv not found — every assertion below would be vacuous").toBeGreaterThan(-1);
  return block.slice(at);
})();

describe("audit.exportCsv — the door", () => {
  it("is no wider than the read it exports", () => {
    expect(block).toMatch(/list: adminWsProcedure/);
    expect(block).toMatch(/exportCsv: adminWsProcedure/);
  });

  it("is a mutation, not a query", () => {
    // Deliberate, and not because "produce-a-file is always a mutation" — it is
    // not: are.prospects.exportRejections is a query. A multi-megabyte CSV has
    // no business sitting in the React Query cache keyed by its filters.
    expect(exportWindow).toMatch(/exportCsv: adminWsProcedure[\s\S]*?\.mutation\(/);
  });

  it("carries the export_data gate before it touches the database", () => {
    // The full permission story lives in server/permissionEnforcement.test.ts
    // (behavioural + the ENFORCEMENT map). Pinned here too so deleting the line
    // fails the file that describes the export.
    const gate = exportWindow.indexOf('checkPermission(ctx, "export_data")');
    expect(gate, "audit.exportCsv has lost its export_data gate").toBeGreaterThan(-1);
    expect(gate).toBeLessThan(exportWindow.indexOf("await getDb()"));
  });
});

describe("audit filters reach SQL", () => {
  it("both the list and the export build their WHERE from the same helper", () => {
    const uses = block.match(/auditWhere\(ctx\.workspace\.id/g) ?? [];
    expect(uses.length, "list and exportCsv must share one WHERE builder").toBeGreaterThanOrEqual(2);
  });

  it("the helper pushes entityType and actorUserId into the query", () => {
    expect(block).toMatch(/eq\(auditLog\.entityType, input\.entityType\)/);
    expect(block).toMatch(/eq\(auditLog\.actorUserId, input\.actorUserId\)/);
  });

  it("and nothing filters the rows again after the limit", () => {
    // THE BUG: `rows = rows.filter(...)` after `.limit(500)` returns the
    // matches inside the newest 500 rows, not the newest 500 matches. A
    // filtered view of a busy workspace showed three entries.
    expect(block).not.toMatch(/rows\s*=\s*rows\.filter\(/);
  });

  it("workspaceId is the first condition, always", () => {
    const at = block.indexOf("function auditWhere");
    expect(at).toBeGreaterThan(-1);
    expect(block.slice(at, at + 400)).toMatch(/const conds = \[eq\(auditLog\.workspaceId, workspaceId\)\]/);
  });

  it("entityType input is bounded by the column width", () => {
    // varchar(40): a longer value matches no stored row, so the export returns
    // zero and the admin reads it as "nothing happened".
    const inputs = block.match(/entityType: z\.string\(\)\.max\(40\)\.optional\(\)/g) ?? [];
    expect(inputs.length, "both list and exportCsv must bound entityType").toBeGreaterThanOrEqual(2);
  });
});

describe("the escaper", () => {
  // Re-declared rather than imported: it is module-local in operations.ts on
  // purpose (reports.ts holds pinned tsc errors, so exporting its copy means
  // editing those lines). These assert the BEHAVIOUR the source must have.
  const esc = (v: unknown) => {
    if (v == null) return "";
    const s = v instanceof Date ? v.toISOString() : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  it("doubles quotes rather than backslash-escaping them", () => {
    expect(esc('a"b')).toBe('"a""b"');
  });

  it("wraps commas and newlines", () => {
    expect(esc("a,b")).toBe('"a,b"');
    expect(esc("a\nb").startsWith('"')).toBe(true);
  });

  it("renders null as empty and a Date as ISO", () => {
    expect(esc(null)).toBe("");
    expect(esc(new Date("2026-01-02T03:04:05Z"))).toBe("2026-01-02T03:04:05.000Z");
  });

  it("and the source uses that form, not JSON.stringify", () => {
    expect(block).toContain(`s.replace(/"/g, '""')`);
    expect(AUDIT_UI, "the browser-built escaper is back").not.toContain("JSON.stringify(r[h]");
  });
});

describe("the file says what the page promises", () => {
  it("carries the before/after diff and the actor, not just ids", () => {
    for (const label of ['"Before"', '"After"', '"Actor"', '"IP"', '"User agent"']) {
      expect(exportWindow, `${label} column is missing`).toContain(label);
    }
    expect(exportWindow).toContain('key: "before"');
    expect(exportWindow).toContain('key: "after"');
  });

  it("names departed actors — the row a compliance export exists for", () => {
    // team.delete HARD-DELETES the membership row (server/routers/admin.ts;
    // server/_core/activeMembers.ts says so in as many words), so resolving
    // names through a workspaceMembers join renders every REMOVED member as
    // "User 42" — exactly the person the export is usually opened to find.
    // Asserted on the CODE, not the source text: the handler's own comment
    // names workspaceMembers in order to rule it out.
    expect(exportWindow).toContain("inArray(users.id, ids)");
    const code = exportWindow.replace(/^\s*\/\*[\s\S]*?\*\//gm, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code, "a workspaceMembers join anonymises deleted actors").not.toContain("workspaceMembers");
  });

  it("guards the empty id list", () => {
    // An empty inArray emits broken SQL. Reachable: a workspace whose matching
    // rows are all system-actor (actorUserId NULL). reports.ts carries the
    // same guard.
    expect(exportWindow).toContain("ids.length > 0");
  });

  it("returns an empty export rather than throwing with no database", () => {
    // Also what keeps operations.ts at zero of the pinned tsc errors: without
    // it every db call below is TS18047 'db is possibly null'.
    expect(exportWindow).toContain('if (!db) return { csv: "", rows: 0, total: 0, capped: false };');
  });

  it("audits itself, after the work is done", () => {
    expect(exportWindow).toContain("recordAudit(");
    expect(exportWindow).toContain('entityType: "data_export"');
    expect(exportWindow.indexOf("recordAudit(")).toBeGreaterThan(exportWindow.indexOf("const csv = auditToCsv"));
  });
});

describe("the cap is disclosed, and the diff is bounded", () => {
  it("the row ceiling is a pinned constant", () => {
    // Pinned so raising it is a deliberate act: `before`/`after` are unbounded
    // json columns holding whole record snapshots, and the whole CSV crosses
    // the wire as one tRPC response.
    expect(block).toContain("const AUDIT_EXPORT_CAP = 2000;");
    expect(exportWindow).toContain(".limit(AUDIT_EXPORT_CAP)");
  });

  it("and the caller is told when it bit", () => {
    expect(exportWindow).toMatch(/count\(\*\)/);
    expect(exportWindow).toMatch(/\.from\(auditLog\)\.where\(where\)/);
    expect(exportWindow).toContain("const capped = total > AUDIT_EXPORT_CAP;");
  });

  it("each diff field is truncated, with the truncation visible in the file", () => {
    expect(block).toContain("const AUDIT_JSON_MAX = 1000;");
    expect(exportWindow).toContain("auditJson(r.before)");
    expect(exportWindow).toContain("auditJson(r.after)");

    const AUDIT_JSON_MAX = 1000;
    const auditJson = (v: unknown): string => {
      if (v == null) return "";
      const s = JSON.stringify(v);
      return s.length > AUDIT_JSON_MAX ? `${s.slice(0, AUDIT_JSON_MAX)}…truncated` : s;
    };
    const big = auditJson({ note: "x".repeat(5000) });
    expect(big.length).toBeLessThanOrEqual(AUDIT_JSON_MAX + 12);
    expect(big.endsWith("…truncated")).toBe(true);
    expect(auditJson(null)).toBe("");
  });
});

describe("ES5 target", () => {
  it("operations.ts never spreads a Set or Map", () => {
    // TS2802 at this target. operations.ts holds ZERO of the 325 pinned tsc
    // errors, so one here breaks the baseline immediately. Array.from is fine.
    expect(OPS).not.toMatch(/\[\s*\.\.\.\s*new (Set|Map)\(/);
  });
});

describe("the Audit page", () => {
  it("sends the filters and lets the server find the rows", () => {
    expect(AUDIT_UI).toContain("exportCsv.mutate({ entityType: entityType || undefined, actorUserId })");
    expect(AUDIT_UI, "the browser-built export is back").not.toContain("downloadCsv(");
  });

  it("reports failures instead of swallowing them", () => {
    expect(AUDIT_UI).toContain("onError: (e) => toast.error(e.message)");
  });

  it("tells the user when the export was capped", () => {
    expect(AUDIT_UI).toContain("r.capped");
    expect(AUDIT_UI).toMatch(/r\.rows[\s\S]{0,120}r\.total/);
  });

  it("downloads the house way", () => {
    // The old helper had neither: no charset (Excel mangled non-ASCII) and no
    // revoke (the blob leaked for the life of the tab).
    expect(AUDIT_UI).toContain("text/csv;charset=utf-8");
    expect(AUDIT_UI).toContain("URL.revokeObjectURL(url)");
  });

  it("derives the entity filter from what the workspace recorded", () => {
    // The hardcoded list offered twelve types. Four of them — customer,
    // campaign, workflow_rule, social_post — are written by nothing at all, so
    // they always returned empty, while ~60 real types could not be selected.
    expect(AUDIT_UI).toContain("trpc.audit.entityTypes.useQuery");
    expect(AUDIT_UI).not.toContain('"workflow_rule"');
  });
});
