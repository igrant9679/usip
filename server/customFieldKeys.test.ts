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
  undefinedCustomFieldKeys,
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
    /**
     * MUTATION-VERIFIED. The previous version of this test asserted that
     * `defs.map((d) => d.fieldKey)` and `Object.keys(input.values)` appeared
     * in the handler. Changing `if (defined.has(key)) continue;` to
     * `if (defined.has(key) || true) continue;` — which disables the allowlist
     * completely and restores the a278a39 hole — left both strings in place,
     * and the FULL SUITE stayed green at 1601 passed.
     *
     * The decision now lives in a pure function and is tested by CALLING it
     * (below). What is left here is the wiring: the handler must route its
     * keys through that function and throw, because a perfect helper nothing
     * calls is the dead-wiring class this repo keeps finding.
     */
    const setValues = src.slice(src.indexOf("setValues:"));
    expect(src.indexOf("setValues:"), "setValues handler not found").toBeGreaterThan(0);
    expect(setValues.length).toBeGreaterThan(400);
    expect(setValues).toMatch(
      /for \(const key of undefinedCustomFieldKeys\(input\.values, defined\)\)/,
    );
    /**
     * The loop body must REFUSE, unconditionally.
     *
     * Written first as `expect(loop).toMatch(/throw new TRPCError/)`, which a
     * mutation to `if (0) throw new TRPCError({` walked straight through — the
     * token was still present and the refusal was dead. That is the exact
     * defect this whole re-audit is about, reproduced inside the fix for it.
     * So the STATEMENT is pinned, not the token: loop → clash → bare throw,
     * with nothing in between to switch it off.
     */
    expect(
      setValues,
      "\n\nThe refusal must be an unconditional `throw` in the loop body. A throw\n" +
        "behind an `if`, or a `console.warn` in its place, detects the bad key\n" +
        "and writes it anyway.\n",
    ).toMatch(
      /for \(const key of undefinedCustomFieldKeys\(input\.values, defined\)\) \{\s*const clash = reservedCustomFieldKey\(key\);\s*throw new TRPCError\(\{/,
    );
    // `defined` must come from the workspace's own definitions, not a literal.
    expect(setValues).toMatch(/const defined = new Set\(defs\.map\(\(d\) => d\.fieldKey\)\)/);
  });

  it("imports the helper it calls — a free identifier ships and throws at runtime", () => {
    // esbuild bundles an undeclared identifier happily; tsc is the only thing
    // that catches it, and this repo carries ~341 pre-existing tsc errors that
    // make a new one easy to miss. Fourth instance of this trap (e9121b9).
    expect(src).toMatch(
      /import\s*\{[^}]*\bundefinedCustomFieldKeys\b[^}]*\}\s*from\s*"@shared\/customFieldKeys"/,
    );
  });
});

describe("undefinedCustomFieldKeys — the allowlist itself", () => {
  it("returns the keys the workspace never defined", () => {
    expect(
      undefinedCustomFieldKeys({ tier: "gold", linkedinUrl: "x" }, new Set(["tier"])),
    ).toEqual(["linkedinUrl"]);
  });

  it("accepts a payload that is entirely defined", () => {
    expect(undefinedCustomFieldKeys({ tier: "gold" }, new Set(["tier", "region"]))).toEqual([]);
  });

  it("refuses EVERY key when the workspace has no definitions", () => {
    // The mutation that survived made this case return [] — every engine-owned
    // key writable on a workspace that has defined no custom fields at all.
    expect(
      undefinedCustomFieldKeys({ linkedinUrl: "x", intentTopics: ["a"] }, new Set()),
    ).toEqual(["linkedinUrl", "intentTopics"]);
  });

  it("names the engine-owned keys specifically, since those steer a feature", () => {
    // Each of these moves something: linkedinUrl picks Social Autopilot's
    // invite targets, coOwners fabricates ownership, the scoring keys move a
    // lead score. a278a39 lists them in full.
    for (const key of ["linkedinUrl", "coOwners", "technologies", "intentTopics"]) {
      expect(undefinedCustomFieldKeys({ [key]: 1 }, new Set(["tier"]))).toEqual([key]);
    }
  });

  it("matches EXACTLY — a defined `firstName` does not license writing `first_name`", () => {
    // The key checked has to be the key written, or setValues stores a
    // spelling no reader looks for. Deliberately NOT canonicalised; the
    // reasoning is recorded on the function.
    expect(undefinedCustomFieldKeys({ first_name: "a" }, new Set(["firstName"]))).toEqual([
      "first_name",
    ]);
  });

  it("does not treat an inherited property as defined", () => {
    // `{}.constructor` is truthy on any object literal, so a membership test
    // written as `key in obj` rather than a Set would let `constructor` and
    // `toString` through. Set.has has no prototype chain — asserted so a
    // refactor back to a plain object is caught here.
    expect(undefinedCustomFieldKeys({ constructor: 1, toString: 2 }, new Set(["tier"]))).toEqual([
      "constructor",
      "toString",
    ]);
  });
});
