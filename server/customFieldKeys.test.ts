/**
 * The `customFields` JSON blob has two populations of writers, and nothing
 * separated them.
 *
 * Four tables carry the column — accounts, contacts, leads, opportunities — and
 * besides the admin-defined Custom Fields feature, application code parks
 * control data in the same blob:
 *
 *   unipile.ts               writes { linkedinUrl, location } onto a lead
 *   socialAutopilot.ts       reads $.linkedinUrl to pick LinkedIn invite targets
 *   opportunityIntelligence  read/writes coOwners (a list of user ids)
 *   imports.ts               writes importTag / importSource / importId
 *   scoring/*                resolves technologies, intentTopics, hiringSignals,
 *                            websiteKeywords, recentFunding, … as score inputs
 *
 * `setValues` took `z.record(z.string(), z.any())` and used the definitions ONLY
 * to check `required` — so any key at all could be written. And `createDef`'s
 * snake_case rule happily accepts `technologies`, which the scoring engine
 * reads: a collision that does not merely overwrite a value but moves a lead
 * score, or enrolls a lead into automated LinkedIn outreach.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, sep } from "node:path";
import {
  RESERVED_CUSTOM_FIELD_KEYS,
  canonicalCustomFieldKey,
  reservedCustomFieldKey,
} from "@shared/customFieldKeys";

const ROOT = join(__dirname, "..");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...sourceFiles(p));
    else if (/\.ts$/.test(e.name) && !/\.(test|spec)\.ts$/.test(e.name)) out.push(p);
  }
  return out;
}

const SERVER_FILES = sourceFiles(join(ROOT, "server"));
const SERVER_SRC = SERVER_FILES.map((f) => readFileSync(f, "utf8")).join("\n");

describe("reservedCustomFieldKey", () => {
  it("matches regardless of case or separators", () => {
    // fieldResolver tries blob[field] ?? blob[camel(field)]; priorityService
    // looks only for camelCase. An exact-match reservation would be side-
    // stepped by simply typing the other spelling.
    for (const spelling of ["hiringSignals", "hiring_signals", "Hiring_Signals", "HIRINGSIGNALS"]) {
      expect(reservedCustomFieldKey(spelling)?.key, spelling).toBe("hiringSignals");
    }
  });

  it("reserves the snake_case-legal one an admin would plausibly type", () => {
    // `technologies` passes createDef's /^[a-z][a-z0-9_]*$/ unchanged.
    expect(reservedCustomFieldKey("technologies")).not.toBeNull();
  });

  it("names the owning feature, so the refusal is actionable", () => {
    expect(reservedCustomFieldKey("linkedin_url")?.owner).toMatch(/Autopilot|LinkedIn/);
  });

  it("leaves ordinary field names alone", () => {
    for (const ok of ["account_tier", "renewal_date", "csat", "region", "notes"]) {
      expect(reservedCustomFieldKey(ok), ok).toBeNull();
    }
  });

  it("does not throw on rubbish input", () => {
    expect(reservedCustomFieldKey("")).toBeNull();
    expect(canonicalCustomFieldKey("")).toBe("");
  });
});

/**
 * Staleness, in the direction that actually rots: an allowlist entry outliving
 * the code that justified it. Every reserved key must still be referenced by
 * server source, or the reservation is blocking a name for no reason.
 */
describe("the reserved list has no stale entries", () => {
  it("finds source to scan (guards the scanner itself)", () => {
    expect(SERVER_FILES.length).toBeGreaterThan(50);
    expect(SERVER_SRC.length).toBeGreaterThan(100_000);
  });

  it("every reserved key is still used somewhere in server/", () => {
    const stale = Object.keys(RESERVED_CUSTOM_FIELD_KEYS).filter((k) => !SERVER_SRC.includes(k));
    expect(
      stale,
      stale.length
        ? `\n\nReserved but no longer referenced — drop the entry:\n  ${stale.join("\n  ")}\n`
        : undefined,
    ).toEqual([]);
  });
});

/**
 * The other direction: a NEW engine key written into the blob without being
 * reserved.
 *
 * ⚠️ Deliberately PARTIAL, and saying so beats implying otherwise. It reads
 * `customFields: { … }` object literals and `JSON_EXTRACT(…,'$.key')`, which
 * catches the writers. It cannot catch the scoring reads, which go through an
 * alias (`const cf = row.customFields; cf.intentTopics`) — those are enumerated
 * by hand in the module. A scanner that looked exhaustive and was not would be
 * worse than one whose blind spot is written down.
 */
describe("no unreserved engine key is written into the blob", () => {
  /** Keys appearing in a `customFields: { … }` literal. */
  function literalWrittenKeys(): { key: string; file: string }[] {
    const found: { key: string; file: string }[] = [];
    for (const f of SERVER_FILES) {
      const src = readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      const rel = f.slice(ROOT.length + 1).split(sep).join("/");
      // `customFields: {` AND `customFields: url ? {` — unipile.ts guards its
      // literal with a ternary, and the first version of this pattern missed
      // it entirely. The floor assertion below is the only reason that was
      // noticed rather than being read as "no other writers exist".
      const re = /customFields:\s*(?:[^{;\n]{0,80}\?\s*)?\{/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src)) !== null) {
        // Brace-match the literal rather than slicing to the next `}` — these
        // objects contain nested ones.
        let depth = 0;
        let i = m.index + m[0].length - 1;
        const start = i + 1;
        for (; i < src.length; i++) {
          if (src[i] === "{") depth++;
          else if (src[i] === "}") { depth--; if (depth === 0) break; }
        }
        const body = src.slice(start, i);
        for (const km of body.matchAll(/(?:^|[{,])\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/g)) {
          found.push({ key: km[1], file: rel });
        }
      }
    }
    return found;
  }

  /** Keys read via JSON_EXTRACT(customFields, '$.key'). */
  function jsonExtractKeys(): { key: string; file: string }[] {
    const found: { key: string; file: string }[] = [];
    for (const f of SERVER_FILES) {
      const src = readFileSync(f, "utf8");
      const rel = f.slice(ROOT.length + 1).split(sep).join("/");
      for (const m of src.matchAll(/customFields[^)]*?'\$\.([A-Za-z0-9_]+)'/g)) {
        found.push({ key: m[1], file: rel });
      }
    }
    return found;
  }

  const written = literalWrittenKeys();
  const extracted = jsonExtractKeys();

  it("finds the known writers (floor — a scan that finds nothing must fail)", () => {
    const files = new Set(written.map((w) => w.file));
    expect(files).toContain("server/routers/unipile.ts");
    expect(files).toContain("server/routers/imports.ts");
    expect(extracted.map((e) => e.key)).toContain("linkedinUrl");
  });

  it("every key an engine writes or extracts is reserved", () => {
    const offenders = [...written, ...extracted]
      .filter((w) => !reservedCustomFieldKey(w.key))
      .map((w) => `${w.file}: ${w.key}`);
    expect(
      [...new Set(offenders)],
      offenders.length
        ? `\n\nEngine-owned keys missing from RESERVED_CUSTOM_FIELD_KEYS:\n  ${[...new Set(offenders)].join("\n  ")}\n\n` +
            `Add them to @shared/customFieldKeys, or an admin can define a custom\n` +
            `field with the same name and silently steer the engine that reads it.\n`
        : undefined,
    ).toEqual([]);
  });
});

/** Both enforcement points must stay wired. Comments stripped — they name both. */
describe("the router enforces it", () => {
  const src = readFileSync(join(ROOT, "server/routers/customFields.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  it("createDef refuses a reserved name", () => {
    const createDef = src.slice(src.indexOf("createDef:"), src.indexOf("updateDef:"));
    expect(createDef.length).toBeGreaterThan(200);
    expect(createDef).toContain("reservedCustomFieldKey");
  });

  it("setValues writes only DEFINED keys", () => {
    const setValues = src.slice(src.indexOf("setValues:"));
    expect(setValues.length).toBeGreaterThan(400);
    // The definitions must be used as an allowlist, not only for `required`.
    expect(setValues).toMatch(/defs\.map\(\(d\) => d\.fieldKey\)/);
    expect(setValues).toMatch(/Object\.keys\(input\.values\)/);
  });
});
