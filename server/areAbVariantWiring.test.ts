/**
 * ARE A/B wiring — the join key, the label, and the claim.
 *
 * `performanceMetrics.getAbVariantStats` groups ARE sends by
 * `${stepIndex}:${variantKey}` and joins `are_ab_variants` on the same key for
 * the subject/hook labels. Three things were wrong with that seam, all silent:
 *
 *  1. **The key disagreed with itself.** The metadata upsert in
 *     routers/are/prospects.ts wrote the OPENER at a hardcoded `stepIndex: 1`,
 *     while the execution-queue rows for that same opener were keyed by the
 *     index the engine derived (0 for the 0-based sequences the campaign-skeleton
 *     prompt asks for). So the opener's real cell — the one holding every send —
 *     found no metadata and rendered with no subject or body preview, and the
 *     stored row minted a PHANTOM cell one step along showing the copy at 0
 *     sends. One variant, two cards, neither complete.
 *
 *  2. **`variantKey` was free text from an LLM.** `personalizeForProspect`'s
 *     JSON schema REQUIRED the model to return one, and neither of that call's
 *     prompts ever mentioned it — no A/B instruction, and the skeleton it was
 *     shown had no variantKey field. Whatever the model invented became a chart
 *     axis, so identical copy under two invented keys would split one sample in
 *     half and never reach sampleSufficient.
 *
 *  3. **The page claimed an experiment that has never run.** The tab said "The
 *     Sequence Agent generates two variants per step: Variant A uses a
 *     personalisation hook, Variant B uses a trigger event hook." Nothing has
 *     ever produced a variant B, and `hookType` was hardcoded to
 *     "personalisation" regardless of what the copy was built on. A reader
 *     compares two labels they were promised.
 *
 * The invariant these tests hold: ONE rule produces the key on both sides
 * (shared/areSequenceSteps.ts + shared/variantKeys.ts), and the UI may not name
 * a variant the engine cannot produce.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, sep } from "node:path";
import { DEFAULT_VARIANT_KEY, normalizeVariantKey } from "../shared/variantKeys";
import { normalizeSequence, stepIndexOf } from "../shared/areSequenceSteps";
import { computeVariantCells, variantCellKey } from "./services/performanceMetrics";

const ROOT = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

/**
 * Comment-stripped source. Non-negotiable in this file: every assertion below
 * looks for a pattern that this repo's own comments DESCRIBE while explaining
 * the bug — including the header above, which quotes the exact "two variants
 * per step" copy it is checking is gone.
 */
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/* ─── 1. The key rules are pure and total ────────────────────────────────── */

describe("normalizeVariantKey", () => {
  it("accepts a single letter, case- and whitespace-insensitively", () => {
    expect(normalizeVariantKey("A")).toBe("A");
    expect(normalizeVariantKey("b")).toBe("B");
    expect(normalizeVariantKey("  c \n")).toBe("C");
  });

  it("collapses anything a model might invent to the default bucket", () => {
    // Every one of these is a plausible LLM answer to a required `variantKey`
    // field it was given no instructions about. None is evidence that an
    // experiment ran, so none may become a chart axis of its own.
    for (const junk of ["v1", "variant-a", "opener", "A/B", "1", "", "   ", "AB"]) {
      expect(normalizeVariantKey(junk), junk).toBe(DEFAULT_VARIANT_KEY);
    }
  });

  it("survives non-strings (a JSON column can hold anything)", () => {
    for (const junk of [undefined, null, 1, {}, [], true]) {
      expect(normalizeVariantKey(junk)).toBe(DEFAULT_VARIANT_KEY);
    }
  });
});

describe("stepIndexOf", () => {
  it("prefers the step's own index, then the legacy seed shape, then position", () => {
    expect(stepIndexOf({ stepIndex: 0 }, 7)).toBe(0); // 0 must not fall through
    expect(stepIndexOf({ stepIndex: 3 }, 7)).toBe(3);
    expect(stepIndexOf({ step: 2 }, 7)).toBe(2);
    expect(stepIndexOf({}, 7)).toBe(7);
    expect(stepIndexOf(null, 4)).toBe(4);
    expect(stepIndexOf({ stepIndex: "2" }, 4)).toBe(4); // a string is not an index
  });
});

describe("normalizeSequence", () => {
  it("normalises the variant key of every step", () => {
    const steps = normalizeSequence([
      { stepIndex: 0, day: 0, channel: "email", subject: "s", body: "b", variantKey: "opener" },
      { stepIndex: 1, day: 3, channel: "EMAIL", subject: "s", body: "b", variantKey: "b" },
    ]);
    expect(steps.map((s) => s.variantKey)).toEqual(["A", "B"]);
  });

  it("still handles the legacy seed shape (step/waitDays, no variantKey)", () => {
    const steps = normalizeSequence([
      { step: 1, channel: "email", subject: "a", waitDays: 0 },
      { step: 2, channel: "linkedin", subject: "b", waitDays: 3 },
    ]);
    expect(steps.map((s) => s.stepIndex)).toEqual([1, 2]);
    expect(steps.map((s) => s.dayOffset)).toEqual([0, 3]);
    expect(steps.map((s) => s.channel)).toEqual(["email", "linkedin"]);
    expect(steps.every((s) => s.variantKey === DEFAULT_VARIANT_KEY)).toBe(true);
  });

  it("falls back to email for an unknown channel and clamps negative days", () => {
    const [s] = normalizeSequence([{ stepIndex: 0, day: -5, channel: "carrier-pigeon", body: "b" }]);
    expect(s.channel).toBe("email");
    expect(s.dayOffset).toBe(0);
  });

  it("returns [] for a non-array (generatedSequence is a nullable JSON column)", () => {
    expect(normalizeSequence(null)).toEqual([]);
    expect(normalizeSequence({ steps: [] })).toEqual([]);
  });
});

/* ─── 2. The two sides of the join agree ─────────────────────────────────── */

describe("A/B metadata lands on the cell holding the sends", () => {
  // A generated sequence exactly as personalizeForProspect returns it.
  const generated = [
    { stepIndex: 0, day: 0, channel: "email", subject: "Opener", body: "Body 0", variantKey: "A" },
    { stepIndex: 1, day: 3, channel: "email", subject: "Follow-up", body: "Body 1", variantKey: "A" },
  ];

  it("the metadata key equals the queue key for the same step", () => {
    // Queue side: what areEngine writes into messageContent, per step.
    const queued = normalizeSequence(generated);
    const sendCell = variantCellKey(queued[0].stepIndex, queued[0].variantKey);

    // Metadata side: what the upsert in routers/are/prospects.ts stores.
    const opener = generated[0];
    const metaCell = variantCellKey(stepIndexOf(opener, 0), normalizeVariantKey(opener.variantKey));

    expect(metaCell).toBe(sendCell);
  });

  it("a hardcoded step index is what produced the phantom card", () => {
    // The old code: `stepIndex: 1` beside the opener's copy. Documented as a
    // test so the shape is recognisable if it ever comes back — the two keys
    // differ, which is not a missing label but an EXTRA cell.
    const queued = normalizeSequence(generated);
    const sendCell = variantCellKey(queued[0].stepIndex, queued[0].variantKey);
    const oldMetaCell = variantCellKey(1, "A");
    expect(oldMetaCell).not.toBe(sendCell);
  });

  it("model-invented keys fold into one cell instead of splitting the sample", () => {
    // Same step, same copy, three keys a model could have emitted across three
    // prospects. Before normalisation this was three variants of ~1 send each,
    // none of them ever reaching MIN_VARIANT_SAMPLE.
    const sends = [
      { prospectQueueId: 1, stepIndex: 0, variantKey: "A", executedAt: "2026-07-01T10:00:00Z" },
      { prospectQueueId: 2, stepIndex: 0, variantKey: "v1", executedAt: "2026-07-01T10:00:00Z" },
      { prospectQueueId: 3, stepIndex: 0, variantKey: "variant-a", executedAt: "2026-07-01T10:00:00Z" },
    ];
    const cells = computeVariantCells(sends, []);
    expect([...cells.keys()]).toEqual(["0:A"]);
    expect(cells.get("0:A")?.sent).toBe(3);
  });

  it("a real second variant is still kept separate", () => {
    // Normalising must not collapse an actual A/B split if one is ever built.
    const cells = computeVariantCells(
      [
        { prospectQueueId: 1, stepIndex: 0, variantKey: "A", executedAt: null },
        { prospectQueueId: 2, stepIndex: 0, variantKey: "B", executedAt: null },
      ],
      [],
    );
    expect([...cells.keys()].sort()).toEqual(["0:A", "0:B"]);
  });
});

/* ─── 3. Source guards: one rule, used on both sides ─────────────────────── */

describe("the A/B metadata upsert derives its key", () => {
  const src = stripComments(read("server/routers/are/prospects.ts"));

  it("there is exactly one areAbVariants insert to anchor on", () => {
    // Trap this repo has hit twice: indexOf on a non-unique string examines the
    // wrong function entirely and the assertion means nothing.
    const hits = src.match(/insert\(areAbVariants\)/g) ?? [];
    expect(hits.length).toBe(1);
  });

  /**
   * THE INSERT MUST RUN, not merely be shaped correctly.
   *
   * Every other assertion in this describe block reads the columns and the
   * helpers inside the insert. Prefixing it with `if (false)` keeps all of
   * them true — the row is never written, `are_ab_variants` stays empty, and
   * the A/B tab compares A against A, which is the 9e33965 bug this file was
   * written for. That mutation passed.
   *
   * Checked at the LINE level: the statement must begin with `await`, so no
   * condition can sit in front of it. The one legitimate guard is the
   * `if (opener)` block around it, which is a null check on the step, not a
   * switch on the write.
   */
  it("the insert is an executed statement, not a disabled one", () => {
    const line = src.split("\n").find((l) => l.includes("await db.insert(areAbVariants)"));
    expect(line, "the areAbVariants insert has moved or been renamed").toBeDefined();
    expect(
      line!.trim(),
      "\n\nThe insert must be the whole statement. Anything in front of it —\n" +
        "`if (false)`, a flag, a short-circuit — leaves every column assertion\n" +
        "in this file true while are_ab_variants stays empty and the A/B tab\n" +
        "compares a variant against itself.\n",
    ).toMatch(/^await db\.insert\(areAbVariants\)/);
  });

  it("nothing short-circuits the surrounding block", () => {
    const start = src.indexOf("await db.insert(areAbVariants)");
    const block = src.slice(Math.max(0, start - 600), start);
    expect(block.length).toBeGreaterThan(200); // floor: real code above it
    // `if (opener)` is the intended guard; a literal-false one is not.
    expect(block).not.toMatch(/if\s*\(\s*false\s*\)/);
    expect(block).toMatch(/if\s*\(opener\)/);
  });

  it("keys the row by the step, not by a literal", () => {
    const start = src.indexOf("insert(areAbVariants)");
    const block = src.slice(start, start + 700);
    expect(block.length).toBeGreaterThan(200); // floor: the slice found real code
    expect(block).toMatch(/stepIndex:\s*stepIndexOf\(/);
    expect(block).not.toMatch(/stepIndex:\s*\d/);
    expect(block).toMatch(/variantKey:\s*normalizeVariantKey\(/);
  });

  it("labels the row with the hook the copy was actually built on", () => {
    const start = src.indexOf("insert(areAbVariants)");
    const block = src.slice(start, start + 700);
    // hookType was hardcoded "personalisation" for every row regardless of
    // whether the hook was a trigger event or a pain signal.
    expect(block).not.toMatch(/hookType:\s*"/);
    expect(src).toMatch(/primaryHookOf\(intel\)/);
  });

  it("does not ask the model for a variantKey it will overwrite", () => {
    // The field is gone from the personalizer's JSON schema; a required field
    // the prompts never explain is a value invented, not assigned.
    const schemaStart = src.indexOf('name: "personalized_sequence"');
    expect(schemaStart).toBeGreaterThan(-1);
    const schema = src.slice(schemaStart, schemaStart + 900);
    expect(schema).not.toMatch(/variantKey/);
    expect(schema).toMatch(/required:\s*\[[^\]]*"body"/); // floor: right block
  });
});

describe("every messageContent writer goes through the shared rule", () => {
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

  const writers = sourceFiles(join(ROOT, "server"))
    .map((f) => ({ rel: f.slice(ROOT.length + 1).split(sep).join("/"), src: stripComments(readFileSync(f, "utf8")) }))
    .filter((f) => /messageContent:\s*\{/.test(f.src));

  it("finds the writers (guards the scanner itself)", () => {
    // areEngine's enroll phase and the step-edit path in prospects.ts. A scan
    // that finds nothing looks exactly like a repo with no problem.
    expect(writers.map((w) => w.rel).sort()).toEqual([
      "server/areEngine.ts",
      "server/routers/are/prospects.ts",
    ]);
  });

  it("each writer imports the shared variant/step rule", () => {
    // Matched as an IMPORT, not a mention: several comments in these files name
    // the module while explaining the bug.
    for (const w of writers) {
      expect(w.src, w.rel).toMatch(
        /import\s*\{[^}]*\}\s*from\s*"@shared\/(variantKeys|areSequenceSteps)"/,
      );
    }
  });
});

describe("the metrics reader normalises both sides of the join", () => {
  const src = stripComments(read("server/services/performanceMetrics.ts"));

  it("normalises the send key and the stored-metadata key with one helper", () => {
    expect(src).toMatch(/import\s*\{[^}]*normalizeVariantKey[^}]*\}\s*from\s*"@shared\/variantKeys"/);
    // The stored row's key is built once and used for BOTH the phantom-cell
    // seeding and the metadata map — building it twice is how they drifted.
    const uses = src.match(/storedKey\(/g) ?? [];
    expect(uses.length).toBeGreaterThanOrEqual(2);
    expect(src).toMatch(/const storedKey = \(r: [^)]*\) =>\s*\n?\s*cellKey\(Number\(r\.stepIndex\), normalizeVariantKey\(r\.variantKey\)\)/);
  });
});

/* ─── 4. The UI may not name a variant the engine cannot produce ─────────── */

/**
 * Files allowed to write a literal variant key other than through
 * shared/variantKeys.ts, with the reason. Explicit, not heuristic: a test that
 * infers "this one looks fine" agrees with itself by construction.
 */
const LITERAL_VARIANT_KEY_ALLOWED: Record<string, string> = {
  "server/seedAreDemo.ts":
    "Demo campaign fixture: 2 steps × A/B. Not produced by the engine, and its " +
    "counter columns are dead — the seeded rows now render at 0 sends because the " +
    "tab derives from are_execution_queue, which this seeder does not write.",
};

describe("no engine path invents a variant key", () => {
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

  const files = sourceFiles(join(ROOT, "server"));

  it("finds source to scan (guards the scanner itself)", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it('variantKey: "<literal>" appears only where explicitly allowed', () => {
    const offenders: string[] = [];
    for (const f of files) {
      const rel = f.slice(ROOT.length + 1).split(sep).join("/");
      if (rel in LITERAL_VARIANT_KEY_ALLOWED) continue;
      stripComments(readFileSync(f, "utf8"))
        .split("\n")
        .forEach((line, i) => {
          if (/variantKey:\s*["'`]/.test(line)) offenders.push(`${rel}:${i + 1}`);
        });
    }
    expect(
      offenders,
      offenders.length
        ? `\n\nHardcoded variant key(s):\n  ${offenders.join("\n  ")}\n\n` +
            `Assign through shared/variantKeys.ts. A variant label is a value THIS\n` +
            `system assigns — and if a second variant is now genuinely produced, the\n` +
            `A/B tab's copy has to stop saying it isn't.\n`
        : undefined,
    ).toEqual([]);
  });

  it("the allowlist has no stale entries", () => {
    // An allowlist with no staleness check is the "attempt marker" class:
    // entries outlive the code they excuse and the next offender inherits an
    // exemption nobody granted.
    const stale = Object.keys(LITERAL_VARIANT_KEY_ALLOWED).filter(
      (rel) => !/variantKey:\s*["'`]/.test(stripComments(read(rel))),
    );
    expect(
      stale,
      stale.length ? `\n\nAllowlisted but no longer writes a literal variant key — drop it:\n  ${stale.join("\n  ")}\n` : undefined,
    ).toEqual([]);
  });
});

describe("the step-performance tab does not promise an experiment", () => {
  const src = stripComments(read("client/src/pages/usip/ARECampaignDetail.tsx"));

  it("still renders the tab (floor for the scan below)", () => {
    expect(src).toMatch(/value="ab"/);
    expect(src).toMatch(/Step performance/);
  });

  it("makes no claim that two variants are generated", () => {
    // The exact copy that shipped: "The Sequence Agent generates two variants
    // per step: Variant A uses a personalisation hook, Variant B uses a trigger
    // event hook." Every clause of it described a mechanism that did not exist.
    for (const claim of [/two variants/i, /Variant B uses/i, /A\/B Variants/]) {
      expect(src, String(claim)).not.toMatch(claim);
    }
  });

  it("labels steps 1-based, the same as every other step table", () => {
    // The page showed the opener as "Step 0" in the sequence viewer and the same
    // step as "Step 1" on this tab — one page, two numbering schemes.
    // 2026-08-17: the tab went from one card per step (`v`) to one card per
    // dispatch grouped under a step header — the label moved to the header
    // and is still 1-based. Same intent, new variable.
    expect(src).toMatch(/Step \{stepIndex \+ 1\}/);
    expect(src).toMatch(/\(s\.stepIndex \?\? s\.step \?\? idx\) \+ 1/);
  });
});
