/**
 * Migration 0141 — A/B attribution.
 *
 * `sequence_ab_variants.openCount` / `replyCount` were written by nothing and
 * COULD NOT BE: a draft recorded its stepIndex but not which VARIANT supplied
 * its copy, so an open or a reply had no variant to count against. Both stayed
 * permanently 0, which made autoPromoteAbWinners score every variant identically
 * and promote the first one by array order (made to decline instead in 899ca52).
 *
 * 0141 adds `email_drafts.abVariantId` to close the attribution gap, and
 * `email_drafts.firstReplyAt` so replyCount counts one reply per draft rather
 * than one per inbound message.
 *
 * The last test here is the one that would have caught the original bug: it
 * asserts each counter has a writer at all.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("migration 0141 is declared in both places", () => {
  it("rawMigrations has the 0141 block", () => {
    // The repo convention: every migration goes in BOTH drizzle/schema.ts AND
    // rawMigrations.ts. rawMigrations is what actually runs against prod.
    const src = read("server/_core/rawMigrations.ts");
    expect(src).toContain("0141_ab_variant_attribution.sql");
    expect(src).toMatch(/ALTER TABLE `email_drafts` ADD COLUMN `abVariantId` int NULL/);
    expect(src).toMatch(/ALTER TABLE `email_drafts` ADD COLUMN `firstReplyAt` timestamp NULL/);
    expect(src).toMatch(/CREATE INDEX `ix_ed_ab_variant`/);
  });

  it("drizzle/schema.ts declares both columns", () => {
    // Drizzle selects every column it knows about, so a column missing here is
    // invisible to the ORM even once it exists in the database.
    const src = read("drizzle/schema.ts");
    expect(src).toMatch(/abVariantId: int\("abVariantId"\)/);
    expect(src).toMatch(/firstReplyAt: timestamp\("firstReplyAt"\)/);
  });
});

describe("the engine records which variant it used", () => {
  const src = stripComments(read("server/sequenceEngine.ts"));

  it("writes abVariantId onto the draft", () => {
    expect(src).toMatch(/abVariantId: chosenVariantId/);
  });

  it("writes it in the SAME insert as the draft, not a follow-up update", () => {
    // A second statement could fail independently and leave an unattributable
    // draft — the attribution would then be silently incomplete, which is the
    // failure mode this migration exists to end.
    const insert = src.slice(src.indexOf("insert(emailDrafts).values"));
    expect(insert.slice(0, 600)).toMatch(/abVariantId: chosenVariantId/);
  });
});

describe("open attribution counts unique opens", () => {
  const src = stripComments(read("server/emailTracking.ts"));

  it("bumps the variant openCount atomically", () => {
    expect(src).toMatch(/sequenceAbVariants\.openCount\} \+ 1/);
  });

  it("only counts the FIRST open of a draft", () => {
    /**
     * The draft's own openCount deliberately counts every hit — this file's
     * header says raw curiosity is preserved. A variant RATE needs one open per
     * recipient, or one enthusiastic re-opener outweighs ten different people
     * and openCount/sentCount can exceed 100%.
     */
    expect(src).toMatch(/draft\.abVariantId && \(draft\.openCount \?\? 0\) === 0/);
  });

  it("selects the columns it needs to make that decision", () => {
    // Reading abVariantId/openCount off a projection that never selected them
    // yields undefined, and the guard above would then never fire.
    //
    // Anchored on CODE, not a comment: the first version searched for the
    // "Look up the draft by tracking token" comment, which stripComments had
    // already removed, so indexOf returned -1 and the slice was meaningless.
    const selIdx = src.indexOf("emailDrafts.trackingToken, token");
    expect(selIdx).toBeGreaterThan(-1);
    const sel = src.slice(Math.max(0, selIdx - 500), selIdx + 100);
    expect(sel).toMatch(/abVariantId: emailDrafts\.abVariantId/);
    expect(sel).toMatch(/openCount: emailDrafts\.openCount/);
  });
});

describe("reply attribution counts one reply per draft", () => {
  const src = stripComments(read("server/inboundReplyPoller.ts"));

  it("claims firstReplyAt before bumping, atomically", () => {
    // This function runs per inbound MESSAGE. A four-message thread against one
    // send would otherwise count four replies. `WHERE firstReplyAt IS NULL`
    // makes the claim atomic so only one caller proceeds — same
    // claim-before-act shape as the duplicate-send fix in 1d9428e.
    expect(src).toMatch(/isNull\(emailDrafts\.firstReplyAt\)/);
    expect(src).toMatch(/firstReplyAt: new Date\(\)/);
  });

  it("bumps replyCount only when the claim succeeded", () => {
    const block = src.slice(src.indexOf("isNull(emailDrafts.firstReplyAt)"));
    expect(block.slice(0, 600)).toMatch(/claimed > 0/);
    expect(block.slice(0, 600)).toMatch(/sequenceAbVariants\.replyCount\} \+ 1/);
  });

  it("imports sql, which a bundler would not catch", () => {
    expect(read("server/inboundReplyPoller.ts")).toMatch(
      /import \{[^}]*\bsql\b[^}]*\} from "drizzle-orm"/,
    );
  });
});

describe("every A/B counter has a writer", () => {
  /**
   * THE GUARD THAT WOULD HAVE CAUGHT THE ORIGINAL BUG.
   *
   * sentCount had a writer; openCount and replyCount had none, for as long as
   * the feature existed. Nothing failed — the promotion just scored everything 0
   * and picked by array order. A counter that is read but never written is
   * invisible unless something asserts the write exists.
   */
  const COUNTERS = ["sentCount", "openCount", "replyCount"] as const;
  const WRITERS = [
    "server/sequenceEngine.ts",
    "server/emailTracking.ts",
    "server/inboundReplyPoller.ts",
  ];

  it("finds source to scan (guards the scanner itself)", () => {
    expect(WRITERS.every((f) => read(f).length > 0)).toBe(true);
  });

  for (const counter of COUNTERS) {
    it(`sequenceAbVariants.${counter} is incremented somewhere`, () => {
      const found = WRITERS.some((f) =>
        new RegExp(`sequenceAbVariants\\.${counter}\\} \\+ 1`).test(stripComments(read(f))),
      );
      expect(
        found,
        `\n\nNothing increments sequenceAbVariants.${counter}. autoPromoteAbWinners\n` +
          `divides by sentCount and ranks on openCount/replyCount, so an unwritten\n` +
          `counter makes every variant score identically and the "winner" becomes\n` +
          `whichever happens to be first in the array.\n`,
      ).toBe(true);
    });
  }
});
