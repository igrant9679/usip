/**
 * Saved searches for the People picker (migration 0185).
 *
 * Two halves. The STRUCTURAL half pins the seams that were the actual defect:
 * the searches lived in `useState<SavedView[]>` so none survived a navigation,
 * a view carried COLUMNS ONLY so applying one never restored the query it was
 * saved from, and the picker kept naming a search after its filters had been
 * cleared. The BEHAVIOURAL half exercises normalizeViewConfig, which is the
 * only thing standing between a bad stored row and a People page that renders
 * nothing at all — a stale ColumnKey throws inside COLUMN_REGISTRY[key].label,
 * and an out-of-enum verification value makes prospects.list refuse the whole
 * input.
 *
 * Every source pin normalises CRLF first: six of the seven files this feature
 * touches are CRLF on disk.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  COLUMN_KEYS,
  DEFAULT_COLUMNS,
  SYSTEM_DEFAULT_VIEW,
  normalizeViewConfig,
  rowToSavedView,
  type ViewConfig,
} from "../client/src/components/usip/people/savedSearchConfig";

const ROOT = join(__dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
/** Same shape as server/tenantScope.test.ts — a rule about CODE that reads
 *  comments finds its own prose (this file's first run flagged the comment
 *  explaining the rule). */
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const router = read("server/routers/savedSearches.ts");
const people = read("client/src/pages/usip/People.tsx");
const menu = read("client/src/components/usip/people/DefaultViewMenu.tsx");
const config = read("client/src/components/usip/people/savedSearchConfig.ts");

const slice = (src: string, from: string, to: string) => {
  const a = src.indexOf(from);
  expect(a, `slice start not found: ${from}`).toBeGreaterThan(-1);
  const b = to ? src.indexOf(to, a + from.length) : -1;
  return src.slice(a, b > 0 ? b : src.length);
};

const PROCS = {
  list: slice(router, "list: workspaceProcedure", "save: workspaceProcedure"),
  save: slice(router, "save: workspaceProcedure", "remove: workspaceProcedure"),
  remove: slice(router, "remove: workspaceProcedure", "markApplied: workspaceProcedure"),
  markApplied: slice(router, "markApplied: workspaceProcedure", ""),
};

describe("the table is declared in both places", () => {
  it("drizzle/schema.ts and the raw migration agree", () => {
    const schema = read("drizzle/schema.ts");
    expect(schema).toContain("savedSearches = mysqlTable");
    expect(schema).toContain('"saved_searches"');
    // A schema-only table is a table that does not exist in production.
    const mig = read("server/_core/rawMigrations.ts");
    expect(mig).toContain('name: "0185_saved_searches.sql"');
    expect(mig).toContain("CREATE TABLE IF NOT EXISTS `saved_searches`");
    expect(mig).toContain("INDEX `ix_ss_ws_owner` (`workspaceId`, `ownerUserId`, `surface`)");
  });

  it("the router is mounted — an unmounted router is dead code with tests", () => {
    expect(read("server/routers.ts")).toContain("savedSearches: savedSearchesRouter");
  });
});

describe("a saved search is private to one user", () => {
  it("every procedure carries BOTH the workspace and the owner term", () => {
    // ownerUserId is the whole boundary: sharing is not built, so a read or a
    // write that forgets it hands one rep another rep's searches.
    for (const [name, src] of Object.entries(PROCS)) {
      expect(src, `${name}: workspaceId`).toContain("eq(savedSearches.workspaceId, ctx.workspace.id)");
      expect(src, `${name}: ownerUserId`).toContain("eq(savedSearches.ownerUserId, ctx.user.id)");
    }
  });

  it("no statement is keyed on the row id alone", () => {
    expect(router).not.toMatch(/\.where\(\s*eq\(savedSearches\.id,[^)]*\)\s*\)/);
  });

  it("the WHERE is written out, never hoisted into a variable", () => {
    // server/tenantScope.test.ts reads the ARGUMENT TEXT of .where(), so
    // `.where(scoped)` is a clause it cannot check — and the DRY move across
    // four near-identical predicates is exactly what tempts someone into it.
    expect(stripComments(router)).not.toMatch(/\.where\(\s*[A-Za-z_$][\w$]*\s*\)/);
  });
});

describe("save returns a usable id", () => {
  it("destructures the mysql2 result tuple", () => {
    // `await db.insert(...)` resolves to [ResultSetHeader, FieldPacket[]], so
    // reading .insertId straight off it yields undefined → 0, and the picker
    // snaps back to "Default view" the instant a search is created.
    expect(PROCS.save).toContain("const [res] = await db.insert(savedSearches)");
    expect(PROCS.save).not.toMatch(/const res = await db\.insert\(savedSearches\)/);
    expect(PROCS.save).toContain("Number((res as any).insertId)");
  });

  it("an id on the input overwrites instead of creating a duplicate", () => {
    expect(PROCS.save).toContain("id: z.number().int().optional()");
    expect(PROCS.save).toContain(".update(savedSearches)");
  });
});

describe("a search stores the query, not just the columns", () => {
  it("ViewConfig carries columns, filters and sort", () => {
    // Columns-only is what made "my saved search" show different people every
    // time: the filters and the sort were never captured at all.
    expect(config).toMatch(/columns:\s*ColumnKey\[\]/);
    expect(config).toMatch(/filters:\s*ViewFilters/);
    expect(config).toMatch(/sort:\s*\{\s*field:\s*SortField/);
  });

  it("the filter vocabulary is exactly the page's pill vocabulary", () => {
    // NOT a subset of prospects.list's input, which is a different vocabulary
    // on purpose (People.tsx translates missingEmail → hasEmail:false and the
    // promoted tri-state → a boolean). The real invariant: a filter the page
    // can show as a removable pill is a filter a search can store.
    const schemaKeys = new Set<string>();
    const schemaSrc = slice(router, "const viewFiltersSchema", "const viewConfigSchema");
    for (const m of schemaSrc.matchAll(/\n\s+(\w+):\s*z\./g)) schemaKeys.add(m[1]);

    const pillSrc = slice(people, "const appliedFilters = useMemo", "const removeFilter =");
    const pillKeys = new Set<string>();
    for (const m of pillSrc.matchAll(/id: "(\w+)"/g)) pillKeys.add(m[1]);
    if (/id: `tier:\$\{/.test(pillSrc)) pillKeys.add("tiers");
    if (/id: `sen:\$\{/.test(pillSrc)) pillKeys.add("seniorities");

    expect(schemaKeys.size).toBeGreaterThan(10); // guards the two scanners
    expect(Array.from(pillKeys).sort()).toEqual(Array.from(schemaKeys).sort());
  });

  it("the three column-key lists cannot drift apart", () => {
    // savedSearchConfig owns the tuple (ColumnKey is derived from it); the
    // registry renders them; the zod enum decides what can be saved. A column
    // present in one and missing from another is either an unsavable column or
    // a stored key with no renderer.
    const registry = new Set<string>();
    for (const m of read("client/src/components/usip/people/peopleShared.tsx")
      .matchAll(/\n {2}(\w+): \{\n {4}key: "(\w+)",/g)) registry.add(m[2]);
    const serverKeys = new Set<string>();
    const serverList = slice(router, "const COLUMN_KEYS", "] as const;");
    for (const m of serverList.matchAll(/"(\w+)"/g)) serverKeys.add(m[1]);

    expect(registry.size).toBe(COLUMN_KEYS.length);
    expect(Array.from(registry).sort()).toEqual(Array.from(COLUMN_KEYS).sort());
    expect(Array.from(serverKeys).sort()).toEqual(Array.from(COLUMN_KEYS).sort());
  });
});

describe("the People page reads its searches from the server", () => {
  it("no in-memory list survives", () => {
    expect(people).toContain("trpc.savedSearches.list.useQuery");
    expect(people).toContain("trpc.savedSearches.save.useMutation");
    expect(people).toContain("trpc.savedSearches.remove.useMutation");
    expect(people).not.toMatch(/useState<SavedView\[\]>/);
  });

  it("applying one restores filters, text, sort and paging — not just columns", () => {
    const applyView = slice(people, "const applyView = (v: SavedView", "const createSavedSearch");
    expect(applyView).toContain("setVisibleColumns(v.config.columns)");
    expect(applyView).toContain("setSortField(");
    expect(applyView).toContain("setSortDir(");
    expect(applyView).toContain("new Set(");
    // setQText DIRECTLY: the server query reads qText, which is written by a
    // 300 ms debounce. Without the direct write the table shows the PREVIOUS
    // search's people for a third of a second and then flips.
    expect(applyView).toContain("setQText(");
  });

  it("a deep link beats the remembered search", () => {
    // Data Health's "Fix now" cards land on ?missingEmail=1 / ?emailStatus=…
    // and the /contacts/:id redirect on ?q=<name>. Restoring last-applied over
    // the top shows a different population than the card that sent them here.
    const seed = slice(people, "const [viewRestored, setViewRestored] = useState(", "// ── view state ──");
    expect(seed).toContain('urlParams?.get("missingEmail")');
    expect(seed).toContain('urlParams?.get("emailStatus")');
    expect(seed).toContain('urlParams?.get("q")');
  });

  it("clearing filters stops the picker claiming a search it is not showing", () => {
    expect(slice(people, "const removeFilter = (id: string)", "const clearAll =")).toContain('setActiveViewId("default")');
    expect(slice(people, "const clearAll = ()", "// changing a server filter")).toContain('setActiveViewId("default")');
  });

  it("a saved search can be updated and deleted, not only created", () => {
    // Delete-and-recreate as the only edit path loses every column tweak made
    // while the search is active — the same complaint one level down.
    expect(menu).toContain("onRemove");
    expect(menu).toContain("onUpdate");
    expect(people).toContain("onRemove={removeSavedSearch}");
    expect(people).toContain("onUpdate={updateSavedSearch}");
    expect(people).toContain("saveView.mutate({ id: Number(v.id)");
  });

  it("the decorative tabs are gone with the fields that fed them", () => {
    // starred / scope were never settable and the table carries neither, so
    // "Starred", "Assigned to you" and "Shared" were structurally empty tabs.
    expect(menu).not.toContain('label: "Starred"');
    expect(menu).not.toContain('label: "Assigned to you"');
    expect(menu).not.toContain("v.scope");
    expect(menu).not.toContain("v.starred");
  });

  it("every new mutation declares how it fails", () => {
    // Belt-and-braces over server/clientMutationErrors.test.ts's repo sweep.
    for (const proc of ["save", "remove"]) {
      const m = slice(people, `trpc.savedSearches.${proc}.useMutation`, "});");
      expect(m, proc).toContain("onError:");
    }
    expect(slice(people, "trpc.savedSearches.markApplied.useMutation", "\n"))
      .toContain("meta: { silentError: true }");
  });

  it("serialising the two Sets does not add a TS2802 to the pinned baseline", () => {
    const fn = slice(people, "const currentViewConfig = ()", "const applyView =");
    expect(fn).toContain("Array.from(tiers)");
    expect(fn).toContain("Array.from(seniorities)");
    expect(fn).not.toContain("[...tiers");
    expect(fn).not.toContain("[...seniorities");
  });
});

/* ─── the normalizer: the only guard between a bad row and a blank page ──── */

const full: ViewConfig = {
  columns: ["name", "title", "emails"],
  filters: {
    emailStatus: "valid", hasEmail: true, missingEmail: true, verification: "needs_review",
    promoted: "promoted", enrolled: "yes", search: "jane", titleQ: "vp", companyQ: "acme",
    locationQ: "london", industryQ: "saas", educationQ: "mit", linkedinQ: "in/jane",
    hasPhone: true, hasLinkedin: true, tiers: ["high", "low"], seniorities: ["vp", "c-level"],
  },
  sort: { field: "company", dir: "asc" },
};

describe("normalizeViewConfig survives anything the database hands back", () => {
  it("a full, valid config round-trips unchanged", () => {
    expect(normalizeViewConfig(full)).toEqual(full);
    expect(normalizeViewConfig(JSON.stringify(full))).toEqual(full); // mysql2 sometimes returns JSON as a string
  });

  it("an unknown column key is dropped", () => {
    const out = normalizeViewConfig({ ...full, columns: ["name", "retiredKey", "title"] });
    expect(out.columns).toEqual(["name", "title"]);
  });

  it("a config whose columns are ALL unknown falls back to the defaults", () => {
    // The crash case: COLUMN_REGISTRY[key].label throws on an unknown key and
    // blanks the whole table, on every load, unfixable from the UI because the
    // server enum then refuses the re-save.
    const out = normalizeViewConfig({ ...full, columns: ["gone", "alsoGone"] });
    expect(out.columns).toEqual(DEFAULT_COLUMNS);
    expect(out.columns).not.toBe(DEFAULT_COLUMNS); // a copy: the Fields panel edits this array
  });

  it("a duplicate column key is collapsed", () => {
    expect(normalizeViewConfig({ ...full, columns: ["name", "name", "title"] }).columns)
      .toEqual(["name", "title"]);
  });

  it("an unknown sort field falls back to relevance/desc", () => {
    expect(normalizeViewConfig({ ...full, sort: { field: "nope", dir: "sideways" } }).sort)
      .toEqual({ field: "relevance", dir: "desc" });
  });

  it("out-of-enum filter values are dropped rather than passed to prospects.list", () => {
    // An unknown verificationStatus or tier makes the LIST QUERY's input
    // invalid, so the page renders its error state instead of people.
    const out = normalizeViewConfig({
      ...full,
      filters: { ...full.filters, verification: "pending", tiers: ["high", "enormous"], promoted: "maybe" },
    });
    expect(out.filters.verification).toBeUndefined();
    expect(out.filters.tiers).toEqual(["high"]);
    expect(out.filters.promoted).toBeUndefined();
  });

  it("an over-long text filter is truncated to the cap prospects.list enforces", () => {
    const out = normalizeViewConfig({ ...full, filters: { titleQ: "x".repeat(500) } });
    expect(out.filters.titleQ).toHaveLength(200);
  });

  it("unknown filter keys never reach the strict server schema", () => {
    const out = normalizeViewConfig({ ...full, filters: { search: "ok", notAFilter: "boom" } });
    expect(Object.keys(out.filters)).toEqual(["search"]);
  });

  it("null, undefined, a bare string and an array all yield a usable config", () => {
    for (const bad of [null, undefined, "{}", "not json", 7, [], { columns: null, filters: 3, sort: "x" }]) {
      const out = normalizeViewConfig(bad);
      expect(out.columns).toEqual(DEFAULT_COLUMNS);
      expect(out.filters).toEqual({});
      expect(out.sort).toEqual({ field: "relevance", dir: "desc" });
    }
  });
});

describe("rowToSavedView", () => {
  it("stringifies the numeric id so the 'default' sentinel still compares", () => {
    const v = rowToSavedView({ id: 42, name: "Q4 VPs", config: full });
    expect(v.id).toBe("42");
    expect(v.system).toBeUndefined();
    expect(v.config).toEqual(full);
  });

  it("the system default is a view like any other, and is not a row", () => {
    expect(SYSTEM_DEFAULT_VIEW.id).toBe("default");
    expect(SYSTEM_DEFAULT_VIEW.system).toBe(true);
    expect(SYSTEM_DEFAULT_VIEW.config.columns).toEqual(DEFAULT_COLUMNS);
  });
});
