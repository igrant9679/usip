/**
 * asNeverAudit — find writes whose literal values cannot survive the column.
 *
 * WHY THIS EXISTS. Drizzle inserts across this repo are cast `as never` to get
 * past type friction, and that cast switches off BOTH excess-property checking
 * and value checking. tsc then sees nothing wrong with:
 *
 *   · a column that does not exist on the table   (a278a39 — `prospects` had no
 *     `companyName`; the insert compiled and threw at runtime)
 *   · a string outside a mysqlEnum                (d3aefe0)
 *   · a string longer than the varchar it targets
 *
 * All three fail at RUNTIME, inside a cron or a public submit handler, where
 * the real reason is on `e.cause` rather than `e.message`.
 *
 *   node scripts/asNeverAudit.mjs          # scan, human-readable
 *   node scripts/asNeverAudit.mjs --json   # machine-readable
 *
 * ⚠️ WHAT IT CANNOT SEE, stated because a scanner that looks exhaustive and
 * isn't is worse than one whose blind spot is written down:
 *   · payloads built into a variable first, `.values(rows)` or `.values([...])`
 *   · raw `db.execute(sql\`INSERT …\`)`
 *   · a table chosen at runtime (`db.update(table)` in customFields.ts and
 *     workflowEngine.ts, resolved from entityType)
 * `summarise()` reports those counts so the coverage is a number, not a claim.
 */
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

/* ── Schema ──────────────────────────────────────────────────────────────── */

/** Column builders the schema actually uses. Enumerated, not guessed: */
const COLUMN_KINDS = "int|bigint|varchar|text|mysqlEnum|boolean|timestamp|json|date|decimal";

/**
 * Parse `drizzle/schema.ts` into tableVar → { physical, cols }.
 *
 * `phantomEnumValues` records anything a comment-blind parser would have picked
 * up. `tasks.status` ends `"draft", // … autopilot "approval" mode` and a bare
 * quote-scan lifts `approval` out of that comment as a SEVENTH value — the trap
 * 9f2e78f hit with its own schema parser. A phantom makes the check too
 * PERMISSIVE: the bad write sails through here and MySQL rejects it.
 */
export function parseSchema(schemaSrc) {
  const tables = new Map();
  const phantomEnumValues = [];
  const starts = [];
  const tableRe = /export const (\w+) = mysqlTable\(\s*\n?\s*"([a-z0-9_]+)"/g;
  let m;
  while ((m = tableRe.exec(schemaSrc)) !== null) {
    starts.push({ varName: m[1], physical: m[2], at: m.index });
  }

  for (let i = 0; i < starts.length; i++) {
    const s = starts[i];
    const body = schemaSrc.slice(s.at, i + 1 < starts.length ? starts[i + 1].at : schemaSrc.length);
    const cols = new Map();
    const colRe = new RegExp(`^\\s{2,}(\\w+):\\s*(${COLUMN_KINDS})\\(`, "gm");
    let c;
    while ((c = colRe.exec(body)) !== null) {
      const name = c[1];
      const kind = c[2];
      const rest = body.slice(c.index + c[0].length);
      if (kind === "mysqlEnum") {
        const arr = /^\s*"[^"]*",\s*\[([\s\S]*?)\]/.exec(rest);
        if (arr) {
          const clean = arr[1].replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
          const values = [...clean.matchAll(/"([^"]*)"/g)].map((x) => x[1]);
          const raw = [...arr[1].matchAll(/"([^"]*)"/g)].map((x) => x[1]);
          for (const v of raw) {
            if (!values.includes(v)) phantomEnumValues.push(`${s.physical}.${name}: ${v}`);
          }
          cols.set(name, { kind, values });
          continue;
        }
      }
      if (kind === "varchar") {
        const len = /^\s*"[^"]*",\s*\{\s*length:\s*(\d+)/.exec(rest);
        cols.set(name, { kind, length: len ? Number(len[1]) : undefined });
        continue;
      }
      cols.set(name, { kind });
    }
    tables.set(s.varName, { physical: s.physical, cols });
  }
  return { tables, phantomEnumValues };
}

/* ── Source parsing ──────────────────────────────────────────────────────── */

/**
 * Skip a string/template starting at a quote, handling `${…}` interpolation —
 * which can contain braces, nested templates and object literals.
 *
 * ⚖️ DEFENCE IN DEPTH, not the thing that fixed the false positives. Replacing
 * this with a naive backtick-to-backtick skip still yields ZERO findings on the
 * current codebase (measured, not assumed): the structural key guard in
 * `topLevelPairs` is what actually suppresses them. It is kept because that
 * guard is the only thing standing between a nested template and a phantom
 * column, and one line of correctness is cheaper than finding out which input
 * breaks the assumption.
 */
export function skipString(src, i) {
  const q = src[i];
  i++;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "\\") { i += 2; continue; }
    if (q === "`" && ch === "$" && src[i + 1] === "{") {
      let d = 1; i += 2;
      while (i < src.length && d > 0) {
        const c = src[i];
        if (c === "`" || c === '"' || c === "'") { i = skipString(src, i); continue; }
        if (c === "{") d++;
        else if (c === "}") d--;
        i++;
      }
      continue;
    }
    if (ch === q) return i + 1;
    i++;
  }
  return i;
}

/** Balanced-brace slice starting at `open` (index of `{`). */
export function objectAt(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === "`" || ch === '"' || ch === "'") { i = skipString(src, i) - 1; continue; }
    if (ch === "/" && src[i + 1] === "/") { while (i < src.length && src[i] !== "\n") i++; continue; }
    if (ch === "/" && src[i + 1] === "*") { i = src.indexOf("*/", i) + 1; continue; }
    if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) return src.slice(open, i + 1); }
  }
  return null;
}

/**
 * Top-level `key: value` pairs of an object literal.
 *
 * A key is only recognised when the preceding significant character is `{` or
 * `,` — the structural positions a property can start at.
 *
 * 🔴 THIS GUARD IS WHAT MAKES THE SCAN USABLE. Without it the first draft
 * reported 94 findings, nearly all of them CSS properties lifted out of email
 * HTML — `notifications.margin`, `notifications.color` — because anything
 * shaped like `word:` was treated as a column. With it: 0.
 */
export function topLevelPairs(objSrc) {
  const pairs = [];
  let depth = 0;
  let prev = "";
  for (let i = 0; i < objSrc.length; i++) {
    const ch = objSrc[i];
    if (ch === "`" || ch === '"' || ch === "'") { i = skipString(objSrc, i) - 1; prev = '"'; continue; }
    if (ch === "/" && objSrc[i + 1] === "/") { while (i < objSrc.length && objSrc[i] !== "\n") i++; continue; }
    if (ch === "/" && objSrc[i + 1] === "*") { i = objSrc.indexOf("*/", i) + 1; continue; }
    if (ch === "{" || ch === "[" || ch === "(") { depth++; prev = ch; continue; }
    if (ch === "}" || ch === "]" || ch === ")") { depth--; prev = ch; continue; }
    if (/\s/.test(ch)) continue;
    if (depth === 1 && (prev === "{" || prev === ",")) {
      const km = /^(\w+)\s*:\s*/.exec(objSrc.slice(i));
      if (km) {
        const valStart = i + km[0].length;
        const lit = /^"([^"]*)"|^'([^']*)'/.exec(objSrc.slice(valStart));
        pairs.push({ key: km[1], literal: lit ? (lit[1] ?? lit[2]) : null });
        i = valStart - 1;
        prev = ":";
        continue;
      }
    }
    prev = ch;
  }
  return pairs;
}

/**
 * Local identifier → schema export name, from the file's own imports.
 *
 * `emailTracking.ts` imports `workspaces as workspacesT` and more. Keying on
 * the identifier alone leaves every such write unchecked — the alias gap that
 * made an earlier scanner blind until a mutation found it.
 */
export function aliasMap(src) {
  const map = new Map();
  for (const m of src.matchAll(/from\s+"[^"]*drizzle\/schema"/g)) {
    const open = src.lastIndexOf("{", m.index);
    if (open === -1) continue;
    for (const spec of src.slice(open + 1, src.indexOf("}", open)).split(",")) {
      const as = /^\s*(\w+)\s+as\s+(\w+)\s*$/.exec(spec);
      if (as) map.set(as[2], as[1]);
    }
  }
  for (const m of src.matchAll(/const\s*\{([^}]*)\}\s*=\s*await import\("[^"]*drizzle\/schema"\)/g)) {
    for (const spec of m[1].split(",")) {
      const as = /^\s*(\w+)\s*:\s*(\w+)\s*$/.exec(spec);
      if (as) map.set(as[2], as[1]);
    }
  }
  return map;
}

/* ── The check ───────────────────────────────────────────────────────────── */

/** Check one file's inline write payloads. Pure: takes source, returns findings. */
export function checkSource(rel, src, tables) {
  const findings = [];
  let checked = 0;
  const alias = aliasMap(src);
  const callRe = /\.(insert|update)\((\w+)\)\s*\n?\s*\.(values|set)\(\s*\{/g;
  let m;
  while ((m = callRe.exec(src)) !== null) {
    const table = tables.get(alias.get(m[2]) ?? m[2]);
    if (!table) continue;
    const obj = objectAt(src, src.indexOf("{", m.index + m[0].length - 1));
    if (!obj) continue;
    checked++;
    for (const { key, literal } of topLevelPairs(obj)) {
      const col = table.cols.get(key);
      if (!col) {
        findings.push({ file: rel, table: table.physical, column: key, kind: "UNKNOWN COLUMN", detail: "" });
        continue;
      }
      if (literal == null) continue;
      if (col.kind === "mysqlEnum" && col.values && !col.values.includes(literal)) {
        findings.push({ file: rel, table: table.physical, column: key, kind: "BAD ENUM",
          detail: `"${literal}" not in [${col.values.join(", ")}]` });
      }
      if (col.kind === "varchar" && col.length && literal.length > col.length) {
        findings.push({ file: rel, table: table.physical, column: key, kind: "TOO LONG",
          detail: `${literal.length} > ${col.length}` });
      }
    }
  }
  return { findings, checked };
}

/* ── Repo driver ─────────────────────────────────────────────────────────── */

export function serverFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(join(root, dir))) {
      const rel = `${dir}/${name}`;
      if (statSync(join(root, rel)).isDirectory()) { walk(rel); continue; }
      if (!name.endsWith(".ts") || name.endsWith(".test.ts")) continue;
      out.push(rel);
    }
  };
  walk("server");
  return out;
}

export function auditRepo(root) {
  const { tables, phantomEnumValues } = parseSchema(readFileSync(join(root, "drizzle/schema.ts"), "utf8"));
  const findings = [];
  let checked = 0;
  let drizzleSites = 0;
  const unresolvedTableVars = [];

  for (const rel of serverFiles(root)) {
    const src = readFileSync(join(root, rel), "utf8");
    const alias = aliasMap(src);

    /**
     * Denominator is DRIZZLE sites only. A bare `.update(x)` count is
     * meaningless — `hmac.update(raw)` and every incremental-digest call match
     * the same shape and inflated the first version's total by ~150.
     */
    for (const m of src.matchAll(/\.(insert|update)\((\w+)\)(\s*\n?\s*\.(values|set)\()?/g)) {
      const resolved = tables.get(alias.get(m[2]) ?? m[2]);
      if (!resolved && !m[3]) continue;
      drizzleSites++;
      if (!resolved) unresolvedTableVars.push(`${m[2]} (${rel})`);
    }

    const r = checkSource(rel, src, tables);
    findings.push(...r.findings);
    checked += r.checked;
  }

  return {
    tables: tables.size,
    phantomEnumValues,
    drizzleSites,
    checked,
    unresolvedTableVars: [...new Set(unresolvedTableVars)],
    notCheckable: drizzleSites - checked - new Set(unresolvedTableVars).size,
    findings,
  };
}

/* ── CLI ─────────────────────────────────────────────────────────────────── */

const isMain = process.argv[1] && process.argv[1].endsWith("asNeverAudit.mjs");
if (isMain) {
  const root = process.cwd();
  const r = auditRepo(root);
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(r, null, 2));
  } else {
    console.log(`tables parsed:            ${r.tables}`);
    console.log(`drizzle write sites:      ${r.drizzleSites}`);
    console.log(`  checked (inline object): ${r.checked}`);
    console.log(`  not checkable:           ${r.notCheckable}  (variable payload / array form / raw SQL)`);
    console.log(`  dynamic table var:       ${r.unresolvedTableVars.length}`);
    for (const u of r.unresolvedTableVars) console.log(`     ${u}`);
    if (r.phantomEnumValues.length) {
      console.log(`\nphantom enum values a comment-blind parser would accept:`);
      for (const p of r.phantomEnumValues) console.log(`   ${p}`);
    }
    console.log(`\nfindings: ${r.findings.length}`);
    for (const f of r.findings) {
      console.log(`  ${f.kind.padEnd(15)} ${f.table}.${f.column}  ${f.detail}`);
      console.log(`  ${" ".repeat(15)} ${f.file}`);
    }
  }
  process.exit(r.findings.length > 0 ? 1 : 0);
}
