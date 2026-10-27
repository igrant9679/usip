/**
 * Bundle budget — the JavaScript a first visit downloads (audit 2026-10-20,
 * Phase 4 gate: "first load under 1.5 MB of JavaScript").
 *
 *   node scripts/bundleBudget.mjs [dist/public]
 *
 * The audit found one 6.9 MB script (10 MB by Phase 4) that every visit
 * downloaded, the sign-in page included: App.tsx imported all 114 pages.
 * Pages are now chunks loaded by route (client/src/lib/lazyChunk.ts), and this
 * check keeps it that way. It measures, from the built files:
 *
 *   - the entry: the script index.html loads, with its static imports. This is
 *     the sign-in page's whole download. Budget ENTRY_MAX.
 *   - each route: the entry plus one chunk the entry imports on demand, with
 *     that chunk's static imports. This is what a signed-in first visit to that
 *     page downloads. Budget ROUTE_MAX.
 *
 * CI runs it after `vite build` and fails the build over either budget.
 */
import fs from "node:fs";
import path from "node:path";

export const ENTRY_MAX = 600 * 1024;
export const ROUTE_MAX = 1.5 * 1024 * 1024;

// `import{a as b}from"./x.js"` and `import"./x.js"` at the top level of a chunk.
const STATIC_IMPORT = /(?:^|[;\n}])\s*import\s*(?:[\w*{}\s,$]+from\s*)?["'](\.\/[^"']+\.js)["']/g;
// `import("./x.js")`, how the entry loads a route chunk.
const DYNAMIC_IMPORT = /import\(\s*["'](\.\/[^"']+\.js)["']\s*\)/g;

/** Measure a vite build folder (the one holding index.html). */
export function measureBuild(dir) {
  const html = fs.readFileSync(path.join(dir, "index.html"), "utf8");
  const m = html.match(/<script[^>]*type="module"[^>]*src="\/?([^"]+\.js)"/);
  if (!m) throw new Error(`no module script in ${path.join(dir, "index.html")}`);
  const entry = m[1];
  const read = (f) => fs.readFileSync(path.join(dir, f), "utf8");
  const size = (f) => fs.statSync(path.join(dir, f)).size;

  const closure = (start) => {
    const seen = new Set();
    const queue = [start];
    while (queue.length) {
      const f = queue.shift();
      if (seen.has(f)) continue;
      seen.add(f);
      for (const [, rel] of read(f).matchAll(STATIC_IMPORT)) queue.push(path.posix.join(path.posix.dirname(f), rel));
    }
    return seen;
  };
  const total = (files) => [...files].reduce((n, f) => n + size(f), 0);

  const entryFiles = closure(entry);
  const routeChunks = new Set();
  for (const f of entryFiles) {
    for (const [, rel] of read(f).matchAll(DYNAMIC_IMPORT)) routeChunks.add(path.posix.join(path.posix.dirname(f), rel));
  }
  const routes = [...routeChunks]
    .map((chunk) => ({ chunk, bytes: total(new Set([...entryFiles, ...closure(chunk)])) }))
    .sort((a, b) => b.bytes - a.bytes);
  return { entry, entryBytes: total(entryFiles), routes };
}

/** What is over budget, as lines for the CI log. Empty when everything fits. */
export function overBudget(result, { entryMax = ENTRY_MAX, routeMax = ROUTE_MAX } = {}) {
  const out = [];
  if (result.entryBytes > entryMax) out.push(`entry ${result.entry}: ${kb(result.entryBytes)} > ${kb(entryMax)}`);
  for (const r of result.routes) if (r.bytes > routeMax) out.push(`route ${r.chunk}: ${kb(r.bytes)} > ${kb(routeMax)}`);
  return out;
}

const kb = (n) => `${(n / 1024).toFixed(0)} KB`;

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("bundleBudget.mjs")) {
  const dir = process.argv[2] ?? "dist/public";
  const result = measureBuild(dir);
  console.log(`entry ${result.entry}: ${kb(result.entryBytes)} (budget ${kb(ENTRY_MAX)})`);
  console.log(`${result.routes.length} route chunks; largest first visits:`);
  for (const r of result.routes.slice(0, 8)) console.log(`  ${kb(r.bytes).padStart(8)}  ${r.chunk}`);
  const over = overBudget(result);
  if (over.length) {
    const shown = over.slice(0, 20);
    if (over.length > shown.length) shown.push(`… and ${over.length - shown.length} more`);
    console.error(`\nOver budget (route budget ${kb(ROUTE_MAX)}):\n  ${shown.join("\n  ")}`);
    process.exit(1);
  }
  if (result.routes.length < 50) {
    // App.tsx has 112 lazy pages. Far fewer means pages went back to eager
    // imports (or the regexes stopped matching the build): either way the
    // routes above were not measured.
    console.error(`\nOnly ${result.routes.length} route chunks found; expected the lazy pages from App.tsx.`);
    process.exit(1);
  }
  console.log("\nWithin budget.");
}
