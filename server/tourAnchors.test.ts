/**
 * Guided-tour anchors: every spotlight target a seeded step names has to exist
 * in a page the app can actually render.
 *
 * 🪤 WHY THIS EXISTS, and why a naive grep produced a WRONG ticket. A ticket
 * filed 2026-09-19 claimed "15 dangling data-tour-id anchors" because it
 * grepped for the literal `data-tour-id="X"`. Twelve of those fifteen are
 * `page-*` ids synthesized at runtime by Shell.tsx's PageHeader
 * (`data-tour-id={pageKey ? \`page-${pageKey}\` : undefined}`) from the
 * `pageKey="…"` prop each page passes, and three are `chat-*` ids synthesized
 * by ChatAgents.tsx's Section (`data-tour-id={tourId}`). A resolver that does
 * not understand both bindings re-files that ticket every quarter. Exactly ONE
 * of the fifteen was genuinely dead — `page-contacts` — and this file exists so
 * the next one fails a build instead of being argued about.
 *
 * Two things that are NOT true and led the original ticket astray:
 *
 * (a) A dead anchor does not LOOK broken. TourEngine renders SpotlightOverlay
 *     for every step; a step whose target does not resolve gets a full dim and
 *     a centred card — pixel-identical to a deliberate `coach` step. Nothing
 *     visibly degrades, which is why `page-contacts` survived a month. The
 *     user-visible harm was the copy describing a retired page plus startTour
 *     navigating to /contacts and being bounced straight back out.
 *
 * (b) A file existing under client/src does not mean the app renders it.
 *     `pages/usip/Contacts.tsx` is orphaned — nothing imports it, App.tsx
 *     routes /contacts to a redirect — yet it still contains
 *     `pageKey="contacts"`. Harvesting anchors from every file on disk makes
 *     `page-contacts` resolve and this whole file pass on the bug it was
 *     written to catch. So the harvest walks the import graph from App.tsx
 *     and only trusts files the app can reach.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { TOURS } from "./seedHelpContent";

const ROOT = join(__dirname, "..");
const CLIENT = join(ROOT, "client", "src");
const read = (abs: string) => readFileSync(abs, "utf8");

/* ── The import graph, walked from App.tsx ──────────────────────────────── */

/** Mirrors the "@/" alias in tsconfig.json and vite.config.ts. */
function resolveSpec(fromFile: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = join(CLIENT, spec.slice(2));
  else if (spec.startsWith(".")) base = resolve(dirname(fromFile), spec);
  else return null; // node_modules, "@shared/…" — no anchors live there
  const candidates = [`${base}.tsx`, `${base}.ts`, join(base, "index.tsx"), join(base, "index.ts")];
  for (const c of candidates) if (existsSync(c) && statSync(c).isFile()) return c;
  return null;
}

/**
 * Files reachable from App.tsx, static and lazy imports alike.
 *
 * Deduped case-insensitively (Windows resolves `@/components/Usip/Shell` and
 * `@/components/usip/Shell` to one file) but the ORIGINAL casing is what comes
 * back, because these paths get read again by `anchorsIn`. Returning the
 * lowercased keys instead passes on Windows and harvests ZERO anchors on Linux
 * — every read throws ENOENT into the catch below, `available` comes back
 * empty, and every assertion in this file fails at once in CI while staying
 * green on the machine that wrote it.
 */
const reachable = (() => {
  const seen = new Map<string, string>();
  const stack = [join(CLIENT, "App.tsx")];
  while (stack.length) {
    const file = stack.pop()!;
    const key = file.toLowerCase();
    if (seen.has(key)) continue;
    seen.set(key, file);
    let src: string;
    try {
      src = read(file);
    } catch {
      continue;
    }
    const re = /from\s+"([^"]+)"|import\(\s*"([^"]+)"\s*\)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      const target = resolveSpec(file, m[1] ?? m[2]!);
      if (target) stack.push(target);
    }
  }
  return Array.from(seen.values());
})();

/** Lowercased, for comparing against paths from a directory walk. */
const reachableKeys = new Set(reachable.map((f) => f.toLowerCase()));

/** Every file under client/src, for the orphan check further down. */
const allClientFiles = (() => {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.tsx?$/.test(e.name)) out.push(p);
    }
  };
  walk(CLIENT);
  return out;
})();

/* ── The anchors the client can actually produce ────────────────────────── */

const anchorsIn = (files: string[]) => {
  const found = new Set<string>();
  files.forEach((file) => {
    let src: string;
    try {
      src = read(file);
    } catch {
      return;
    }
    let m: RegExpExecArray | null;
    // Written literally on an element.
    const literal = /data-tour-id="([^"]+)"/g;
    while ((m = literal.exec(src))) found.add(m[1]!);
    // Synthesized by Shell.tsx's PageHeader from each page's pageKey prop.
    const pageKeyProp = /pageKey="([A-Za-z0-9-]+)"/g;
    while ((m = pageKeyProp.exec(src))) found.add(`page-${m[1]!}`);
    // Passed through by ChatAgents.tsx's Section and DetailShell. (An unquoted
    // `tourId={tour.id}` — HelpCenter's tour list — is correctly skipped: it is
    // a runtime value, not an anchor this file can resolve.)
    const tourIdProp = /tourId="([^"]+)"/g;
    while ((m = tourIdProp.exec(src))) found.add(m[1]!);
  });
  return found;
};

const available = anchorsIn(reachable);

const seededSteps = TOURS.flatMap((t) =>
  t.steps.map((s) => ({ tour: t.name, step: s.title, id: s.targetDataTourId, routeTo: s.routeTo ?? t.route })),
);

const HOW_ANCHORS_ARE_MADE =
  `\nBefore adding the anchor, check it is not already synthesized:\n` +
  `  · page-<pageKey>  comes from Shell.tsx's PageHeader —\n` +
  `      data-tour-id={pageKey ? \`page-\${pageKey}\` : undefined}\n` +
  `      so the fix is usually a pageKey="…" prop on that page's PageHeader.\n` +
  `  · chat-*          comes from ChatAgents.tsx's Section (data-tour-id={tourId}).\n` +
  `A grep for the literal id will NOT find either of those. That mistake is\n` +
  `what produced the "15 dangling anchors" ticket; only one was real.\n`;

describe("tour anchors — the scanner itself", () => {
  /**
   * Floors, so a regex that stops matching cannot make every assertion below
   * pass on empty sets. Set well under today's counts (~519 files, ~110
   * anchors, ~52 targets), not at them.
   */
  it("walked a real import graph and found real anchors", () => {
    expect(reachable.length, "the walk from App.tsx resolved almost nothing").toBeGreaterThan(200);
    expect(available.size, "no anchors harvested — a regex has gone stale").toBeGreaterThan(80);
    expect(seededSteps.filter((s) => s.id).length, "no seeded targets found").toBeGreaterThan(40);
  });

  /**
   * The floor above cannot catch a path-casing mistake on Windows, because
   * Windows reads `app.tsx` and `App.tsx` as the same file — so the harvest
   * stays at 110 here and collapses to 0 on Linux. This asserts the casing
   * directly, off the directory entries, and so fails on either platform.
   */
  it("every reachable path is spelled the way the disk spells it", () => {
    const miscased = reachable.filter((f) => !readdirSync(dirname(f)).includes(basename(f)));
    expect(
      miscased.slice(0, 10),
      miscased.length
        ? `\n\n${miscased.length} reachable path(s) do not match their real filename.\n` +
            `Windows resolves them anyway; Linux (CI, Railway) throws ENOENT, the read\n` +
            `is swallowed by a catch, and every anchor assertion below fails at once:\n  ` +
            miscased.slice(0, 10).join("\n  ")
        : undefined,
    ).toEqual([]);
  });

  it("both dynamic anchor factories still exist", () => {
    /**
     * Without this, deleting Shell.tsx's PageHeader binding would leave the
     * resolution check green for the wrong reason: the harvest reads
     * pageKey="…" off the PAGES, and the pages would still have it.
     */
    const shell = read(join(CLIENT, "components/usip/Shell.tsx"));
    expect(shell, "PageHeader stopped synthesizing page-* anchors").toContain(
      "data-tour-id={pageKey ? `page-${pageKey}` : undefined}",
    );
    const chat = read(join(CLIENT, "pages/usip/ChatAgents.tsx"));
    expect(chat, "Section stopped passing tourId through as an anchor").toContain("data-tour-id={tourId}");
  });

  it("ignores files the app cannot reach, which is the whole point", () => {
    const orphans = allClientFiles.filter((f) => !reachableKeys.has(f.toLowerCase()));
    expect(
      orphans.length,
      "nothing under client/src is unreachable — the graph walk is resolving too much",
    ).toBeGreaterThan(0);

    /**
     * The concrete case, guarded on the file still being there. pages/usip/
     * Contacts.tsx is orphaned — nothing imports it, App.tsx routes /contacts
     * to ContactRedirect — and it still carries `pageKey="contacts"`. A
     * directory-wide harvest makes `page-contacts` resolve, which is exactly
     * how the dead anchor survived review. It is kept rather than deleted
     * because server/leadsSegmentPlumbing.test.ts pins its
     * campaigns.addAudience / segments.addContacts calls as the legitimate
     * contact-keyed ones; if it is ever removed, this assertion stands down
     * and the orphan floor above is what remains.
     */
    const contactsPage = join(CLIENT, "pages/usip/Contacts.tsx");
    if (existsSync(contactsPage)) {
      expect(read(contactsPage), "Contacts.tsx no longer demonstrates the trap").toContain('pageKey="contacts"');
      expect(orphans.map((f) => f.toLowerCase())).toContain(contactsPage.toLowerCase());
      expect(anchorsIn([contactsPage]).has("page-contacts")).toBe(true);
      expect(available.has("page-contacts"), "an unreachable file leaked into the harvest").toBe(false);
    }
  });
});

describe("tour anchors — every seeded step targets something that exists", () => {
  it("seedHelpContent.ts TOURS", () => {
    const dangling = seededSteps
      .filter((s) => s.id && !available.has(s.id))
      .map((s) => `"${s.tour}" → "${s.step}" → ${s.id} (route ${s.routeTo})`);
    expect(
      dangling,
      dangling.length
        ? `\n\nSeeded tour step(s) spotlighting an anchor no reachable page renders:\n  ${dangling.join("\n  ")}\n` +
            HOW_ANCHORS_ARE_MADE
        : undefined,
    ).toEqual([]);
  });

  it("seedTours.ts DEMO_TOURS", () => {
    // Read as text rather than imported: seedTours.ts pulls in ./db at module
    // load, and DEMO_TOURS is not exported.
    const src = read(join(ROOT, "server/seedTours.ts"));
    const ids = [...src.matchAll(/targetDataTourId: "([^"]+)"/g)].map((m) => m[1]!);
    expect(ids.length, "no targets found in seedTours.ts — the pattern has gone stale").toBeGreaterThan(5);
    const dangling = [...new Set(ids.filter((id) => !available.has(id)))];
    expect(
      dangling,
      dangling.length
        ? `\n\nLegacy demo tour step(s) with no anchor:\n  ${dangling.join("\n  ")}\n` + HOW_ANCHORS_ARE_MADE
        : undefined,
    ).toEqual([]);
  });
});

/* ── ROUTE_PAGE_KEYS, the mapping that decides which tour a page offers ──── */

const elsie = read(join(CLIENT, "components/usip/Elsie.tsx"));
const routePageKeys = (() => {
  // No assertions here — this runs at collection time, where a failure reads
  // as a suite-level crash rather than a named test. The floor below is what
  // reports a table that stopped being found.
  const start = elsie.indexOf("const ROUTE_PAGE_KEYS");
  const end = elsie.indexOf("export function pageKeyForRoute");
  if (start < 0 || end < start) return [] as ReadonlyArray<readonly [string, string]>;
  return [...elsie.slice(start, end).matchAll(/\["([^"]+)",\s*"([^"]+)"\]/g)].map((m) => [m[1]!, m[2]!] as const);
})();

describe("ROUTE_PAGE_KEYS", () => {
  it("found the table (guards the scanner)", () => {
    expect(routePageKeys.length).toBeGreaterThan(30);
  });

  it("has no duplicate route prefix", () => {
    /**
     * This is the check that kills the whole class. `pageKeyForRoute` keeps
     * `best` on a STRICT `prefix.length > best.len`, so two rows with the same
     * prefix are not a harmless duplicate — the FIRST one wins and the second
     * is unreachable, with no warning anywhere. That is how /v2/people mapped
     * to "contacts" instead of "people" (2026-09-20): Elsie auto-offered a tour
     * of a retired page, the Help drawer's page-filtered article list came back
     * empty, the assistant fell back to generic starters, and the drawer chip
     * read "contacts" on the People page.
     */
    const byPrefix = new Map<string, string[]>();
    routePageKeys.forEach(([prefix, key]) => {
      const got = byPrefix.get(prefix);
      if (got) got.push(key);
      else byPrefix.set(prefix, [key]);
    });
    const dupes: string[] = [];
    byPrefix.forEach((keys, prefix) => {
      if (keys.length > 1) dupes.push(`${prefix} → ${keys.join(", ")} (only "${keys[0]}" is reachable)`);
    });
    expect(
      dupes,
      dupes.length
        ? `\n\nDuplicate route prefix(es) in ROUTE_PAGE_KEYS:\n  ${dupes.join("\n  ")}\n\n` +
            `pageKeyForRoute uses a strict \`>\` on prefix length, so the first entry\n` +
            `silently shadows the rest. Keep one row per prefix.\n`
        : undefined,
    ).toEqual([]);
  });

  it("the People page maps to the People tour", () => {
    // The regression pin for 2026-09-20, kept as the concrete case because it
    // is the one a reader can check by hand.
    expect(elsie).toContain('["/v2/people", "people"]');
    expect(elsie, "the shadowing row is back").not.toContain('["/v2/people", "contacts"]');
  });

  /**
   * Tours whose pageKey no route can produce. These four are offered by
   * something other than "the user is on that page" — first-run onboarding and
   * the Help Center's own list — so they are declared rather than dropped.
   */
  const UNROUTED_TOUR_PAGE_KEYS = new Set(["elsie", "first-run", "inbound-meetings", "workspaces"]);

  it("every tour's pageKey is one pageKeyForRoute can return", () => {
    // seedTours.ts's DEMO_TOURS are deliberately excluded: they store ROUTES
    // in pageKey ("/leads", "/renewals") and can never be matched. See the
    // comment above DEMO_TOURS for why that is left alone.
    const producible = new Set(routePageKeys.map(([, key]) => key));
    const stranded = TOURS.filter((t) => !producible.has(t.pageKey) && !UNROUTED_TOUR_PAGE_KEYS.has(t.pageKey)).map(
      (t) => `"${t.name}" → pageKey "${t.pageKey}" (route ${t.route})`,
    );
    expect(
      stranded,
      stranded.length
        ? `\n\nTour(s) with a pageKey no route maps to:\n  ${stranded.join("\n  ")}\n\n` +
            `tours.getRecommended filters on eq(tours.pageKey, …) with whatever\n` +
            `pageKeyForRoute returned, so Elsie can never offer these on their own\n` +
            `page. Either add the row to ROUTE_PAGE_KEYS in Elsie.tsx or declare the\n` +
            `key in UNROUTED_TOUR_PAGE_KEYS with a note saying what offers it.\n`
        : undefined,
    ).toEqual([]);
  });

  it("UNROUTED_TOUR_PAGE_KEYS has no stale entries", () => {
    const producible = new Set(routePageKeys.map(([, key]) => key));
    const nowRoutable: string[] = [];
    UNROUTED_TOUR_PAGE_KEYS.forEach((k) => {
      if (producible.has(k)) nowRoutable.push(k);
    });
    expect(
      nowRoutable,
      nowRoutable.length
        ? `\n\nDeclared unrouted but now in ROUTE_PAGE_KEYS — drop them:\n  ${nowRoutable.join("\n  ")}\n`
        : undefined,
    ).toEqual([]);
  });
});

describe("the retired Contacts page leaves no tour behind", () => {
  /**
   * Asserted over the imported TOURS array rather than the source text on
   * purpose: seedHelpContent.ts legitimately says "contacts" in article and
   * step prose, so a `not.toContain("contacts")` over the file would fail on
   * copy that is perfectly correct.
   */
  it("no tour named for it", () => {
    expect(TOURS.map((t) => t.name)).not.toContain("Contacts and Accounts");
  });

  it("no step still spotlights page-contacts", () => {
    expect(seededSteps.map((s) => s.id)).not.toContain("page-contacts");
  });

  it("no tour or step routes to /contacts or /accounts", () => {
    // Both redirect away on mount (App.tsx → ContactRedirect / AccountRedirect),
    // so a tour pointed at either bounces the user out of its own first step.
    const dead = ["/contacts", "/accounts"];
    const bad = TOURS.flatMap((t) => [
      ...(dead.includes(t.route) ? [`"${t.name}" route ${t.route}`] : []),
      ...t.steps
        .filter((s) => s.routeTo && dead.includes(s.routeTo))
        .map((s) => `"${t.name}" → "${s.title}" routeTo ${s.routeTo}`),
    ]);
    expect(bad).toEqual([]);
  });
});
