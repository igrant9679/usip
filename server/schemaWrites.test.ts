/**
 * Every insert/update writes columns that EXIST, with values the column accepts.
 *
 * THE CLASS: `.values({...} as never)` switches off the check that would have
 * caught a key the table does not have, an enum value outside its list, or a
 * string longer than its varchar. `as never` was added to get past unrelated
 * Drizzle typing friction and took this with it.
 *
 * And the failure is QUIET. Drizzle maps object keys to columns and silently
 * ignores anything it does not recognise — verified by building the SQL for an
 * insert carrying unknown keys: they never appear in the statement, and no
 * error is raised. So a phantom column is not a crash, it is data that was
 * never written and nobody was told.
 *
 * Found on the first run:
 *   · pipelineAlerts "add note" wrote `opportunityId` + `createdByUserId` to
 *     `activities`, which links by relatedType/relatedId and records the author
 *     in actorUserId. Both keys were dropped, so the note was attached to
 *     nothing and authored by nobody — it never appeared in the deal's feed.
 *   · prospects→contacts promotion wrote `functionalArea`, `industry` and
 *     `sourceProspectId`; none is a column on `contacts`. Behind `as never`,
 *     so tsc could not see it.
 *   · proposals wrote `isRead: false` to `notifications`, whose column is
 *     `readAt`. Harmless in effect — unread IS `readAt IS NULL` by default —
 *     but a claim about a table that was not true.
 *
 * The first two were ALREADY reported by tsc as TS2769 and sat unnoticed in a
 * 341-error backlog. That is the argument for a test: an error nobody can see
 * among hundreds is not a signal.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(__dirname, "..");

const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");

/** Split an object-literal body into top-level `key: value` pairs. */
function pairs(body: string): Array<{ key: string; value: string }> {
  const out: string[] = [];
  let depth = 0, cur = "";
  for (const ch of body) {
    if ("{[(".includes(ch)) depth++;
    if ("}])".includes(ch)) depth--;
    if (ch === "," && depth === 0) { out.push(cur); cur = ""; } else cur += ch;
  }
  out.push(cur);
  return out
    .map((e) => e.trim())
    .filter(Boolean)
    .map((e) => {
      const m = /^(\w+)\s*:\s*([\s\S]+)$/.exec(e);
      return m ? { key: m[1], value: m[2].trim() } : null;
    })
    .filter((x): x is { key: string; value: string } => x !== null);
}

function bracedFrom(s: string, openIdx: number): string | null {
  let depth = 0;
  for (let i = openIdx; i < s.length; i++) {
    if (s[i] === "{") depth++;
    else if (s[i] === "}") { depth--; if (depth === 0) return s.slice(openIdx + 1, i); }
  }
  return null;
}

interface Col { kind: string; values?: string[]; max?: number }

/* ── the schema ─────────────────────────────────────────────────────────── */

const schemaSrc = stripComments(readFileSync(join(ROOT, "drizzle/schema.ts"), "utf8"));
const tables = new Map<string, { sqlName: string; columns: Map<string, Col> }>();

for (const m of schemaSrc.matchAll(/export const (\w+) = mysqlTable\(\s*["'](\w+)["']\s*,\s*\{/g)) {
  const body = bracedFrom(schemaSrc, m.index! + m[0].length - 1);
  if (body === null) continue;
  const columns = new Map<string, Col>();
  /**
   * Brace-matched, NOT indentation-matched. Columns sit at 2 spaces in some
   * tables and 4 in others; the `^\s{2}(\w+):` regex I started with matched
   * nothing for every 4-space table and the scan reported 2967 phantom
   * findings. A broken parser looks exactly like a catastrophic bug.
   */
  for (const { key, value } of pairs(body)) {
    const def = value.replace(/\s+/g, " ").trim();
    const enumM = /mysqlEnum\(\s*["'][\w]+["']\s*,\s*\[([^\]]*)\]/.exec(def);
    if (enumM) {
      columns.set(key, { kind: "enum", values: [...enumM[1].matchAll(/["']([^"']+)["']/g)].map((x) => x[1]) });
      continue;
    }
    const vcM = /varchar\(\s*["'][\w]+["']\s*,\s*\{\s*length:\s*(\d+)/.exec(def);
    columns.set(key, vcM ? { kind: "varchar", max: Number(vcM[1]) } : { kind: "other" });
  }
  tables.set(m[1], { sqlName: m[2], columns });
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e === ".git" || e === "dist") continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) sourceFiles(p, out);
    else if (/\.tsx?$/.test(e) && !/\.test\.tsx?$/.test(e)) out.push(p);
  }
  return out;
}

const files = [...sourceFiles(join(ROOT, "server")), ...sourceFiles(join(ROOT, "shared"))];

interface Finding { at: string; table: string; key: string; value: string; why: string; cast: boolean }
const findings: Finding[] = [];
let sites = 0, literals = 0;

for (const f of files) {
  const rel = relative(ROOT, f).replace(/\\/g, "/");
  const raw = readFileSync(f, "utf8");
  const src = stripComments(raw);
  const re = /\.(insert|update)\((\w+)\)\s*(?:\n\s*)?\.(values|set)\(\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const t = tables.get(m[2]);
    if (!t) continue;
    const body = bracedFrom(src, m.index + m[0].length - 1);
    if (body === null) continue;
    sites++;
    // Located by a distinctive snippet, NOT by counting lines in the stripped
    // source — stripping block comments removes their newlines, so any line
    // number derived from it is wrong. Strip to decide, grep to locate.
    const at = `${rel} (near "${body.trim().slice(0, 40).replace(/\s+/g, " ")}…")`;
    const tail = src.slice(m.index + m[0].length + body.length, m.index + m[0].length + body.length + 30);
    const cast = /^\s*\}?\s*as never/.test(tail);

    for (const { key, value } of pairs(body)) {
      const col = t.columns.get(key);
      if (!col) {
        findings.push({ at, table: t.sqlName, key, value, cast, why: `no such column on \`${t.sqlName}\`` });
        continue;
      }
      // Only fixed strings can be measured. A template literal with ${...}
      // has no static length — treating its SOURCE length as the value's is
      // how `+1-555-${a}-${b}` was reported as 50 chars against varchar(40).
      const strM = /^(?:"([^"]*)"|'([^']*)'|`([^`${]*)`)$/.exec(value);
      if (!strM) continue;
      const lit = strM[1] ?? strM[2] ?? strM[3] ?? "";
      literals++;
      if (col.kind === "enum" && !col.values!.includes(lit)) {
        findings.push({ at, table: t.sqlName, key, value, cast, why: `"${lit}" not in enum [${col.values!.join("|")}]` });
      }
      if (col.kind === "varchar" && lit.length > col.max!) {
        findings.push({ at, table: t.sqlName, key, value, cast, why: `${lit.length} chars > varchar(${col.max})` });
      }
    }
  }
}

describe("the scanner itself", () => {
  it("parsed the schema", () => {
    expect(tables.size).toBeGreaterThan(150);
    const enums = [...tables.values()].reduce(
      (n, t) => n + [...t.columns.values()].filter((c) => c.kind === "enum").length, 0);
    expect(enums, "no enum columns parsed — the column parser has broken").toBeGreaterThan(100);
  });

  it("resolves columns that are known to exist", () => {
    // Without this, a parser that resolves nothing reports every write in the
    // codebase as targeting a column that does not exist.
    for (const [tv, col] of [
      ["prospectQueue", "sequenceStatus"], ["workspaceSettings", "timezone"],
      ["tasks", "status"], ["quotes", "status"], ["activities", "actorUserId"],
    ] as const) {
      expect(tables.get(tv)?.columns.has(col), `${tv}.${col} did not resolve`).toBe(true);
    }
  });

  it("found source and write sites to scan", () => {
    expect(files.length).toBeGreaterThan(150);
    expect(sites, "no insert/update sites found — the site pattern has gone stale").toBeGreaterThan(200);
    expect(literals, "no string literals checked").toBeGreaterThan(100);
  });
});

describe("no write targets a column that does not exist", () => {
  it("every key maps to a real column, and every literal fits it", () => {
    expect(
      findings.map((f) => `${f.at}\n      ${f.table}.${f.key} = ${f.value.slice(0, 60)}  →  ${f.why}${f.cast ? "   [as never]" : ""}`),
      findings.length
        ? `\n\nDrizzle silently DROPS a key it does not recognise — no error, no warning,\n` +
            `the value simply never reaches the INSERT. An enum or varchar violation does\n` +
            `the opposite and throws at runtime, with the reason in e.cause rather than\n` +
            `e.message.\n\n` +
            `Fix the key, or if the data genuinely belongs on that table, add the column\n` +
            `in a migration. Do not reach for \`as never\` — that is what hid these.\n`
        : undefined,
    ).toEqual([]);
  });
});
