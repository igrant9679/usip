/**
 * Migration 0141 — A/B attribution, DERIVED not counted.
 *
 * `sequence_ab_variants.openCount` / `replyCount` were written by nothing and
 * COULD NOT BE: a draft recorded its stepIndex but not which VARIANT supplied
 * its copy, so an open or a reply had no variant to count against. Both stayed
 * permanently 0, which made autoPromoteAbWinners score every variant identically
 * and promote the first by array order (made to decline instead in 899ca52).
 *
 * 0141 adds `email_drafts.abVariantId` and `email_drafts.firstReplyAt` — SOURCE
 * ROWS, not counters. Performance is computed on read by
 * performanceMetrics.getSequenceAbVariantStats.
 *
 * The counters were briefly written instead, earlier in this same session, and
 * that was the wrong call: the ARE side of this identical feature already treats
 * its counters as dead columns ("the A/B tab rendered permanent 0% bars for
 * months"), performanceMetrics' header states the rule — everything DERIVED from
 * source rows, do not add denormalised counters — and this repo has already moved
 * sidebar counters off write-time columns for the same reason. Two mechanisms for
 * one number is the "two screens disagree" bug this codebase keeps producing.
 *
 * Deriving also fixes what a counter could not: it counted drafts CREATED, and a
 * pending_review draft may never send.
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

describe("the source rows get written", () => {
  it("the engine records abVariantId in the SAME insert as the draft", () => {
    // A follow-up UPDATE could fail on its own and leave an unattributable
    // draft — silently incomplete attribution is the failure 0141 exists to end.
    const src = stripComments(read("server/sequenceEngine.ts"));
    const insert = src.slice(src.indexOf("insert(emailDrafts).values"));
    expect(insert.slice(0, 600)).toMatch(/abVariantId: chosenVariantId/);
  });

  it("the poller claims firstReplyAt atomically", () => {
    // Runs per inbound MESSAGE, so a four-message thread must not read as four
    // replies. `WHERE firstReplyAt IS NULL` makes the claim atomic when two
    // messages from one thread land in the same pass (shape from 1d9428e).
    const src = stripComments(read("server/inboundReplyPoller.ts"));
    expect(src).toMatch(/isNull\(emailDrafts\.firstReplyAt\)/);
    expect(src).toMatch(/firstReplyAt: new Date\(\)/);
  });

  it("the open handler selects abVariantId and openCount", () => {
    // Anchored on CODE, not a comment — an earlier version of this test anchored
    // on a `//` comment that stripComments had already removed, so indexOf
    // returned -1 and the assertion was meaningless.
    const src = stripComments(read("server/emailTracking.ts"));
    const idx = src.indexOf("emailDrafts.trackingToken, token");
    expect(idx).toBeGreaterThan(-1);
    const sel = src.slice(Math.max(0, idx - 500), idx + 100);
    expect(sel).toMatch(/abVariantId: emailDrafts\.abVariantId/);
    expect(sel).toMatch(/openCount: emailDrafts\.openCount/);
  });
});

describe("no counter is maintained alongside the derivation", () => {
  /**
   * The point of the rework. Two mechanisms for one number is exactly how the
   * ARE A/B tab ended up showing 0% bars for months while a counter column sat
   * next to it, and how sidebar counters drifted from their row-derived funnel.
   */
  const WRITERS = [
    "server/sequenceEngine.ts",
    "server/emailTracking.ts",
    "server/inboundReplyPoller.ts",
  ];

  for (const counter of ["sentCount", "openCount", "replyCount"] as const) {
    it(`nothing increments sequenceAbVariants.${counter}`, () => {
      const offenders = WRITERS.filter((f) =>
        new RegExp(`sequenceAbVariants\\.${counter}\\} \\+ 1`).test(stripComments(read(f))),
      );
      expect(
        offenders,
        offenders.length
          ? `\n\n${offenders.join(", ")} increments sequenceAbVariants.${counter}.\n` +
              `Those columns are dead — performance is derived by\n` +
              `performanceMetrics.getSequenceAbVariantStats. Maintaining a counter too\n` +
              `gives two answers to one question, which is how the ARE A/B tab showed 0%\n` +
              `bars for months.\n`
          : undefined,
      ).toEqual([]);
    });
  }
});

describe("performance is derived from source rows", () => {
  const src = stripComments(read("server/services/performanceMetrics.ts"));

  it("getSequenceAbVariantStats exists and reads email_drafts", () => {
    expect(src).toMatch(/export async function getSequenceAbVariantStats/);
    const fn = src.slice(src.indexOf("export async function getSequenceAbVariantStats"));
    expect(fn.slice(0, 1400)).toMatch(/\.from\(emailDrafts\)/);
    expect(fn.slice(0, 1400)).toMatch(/isNotNull\(emailDrafts\.abVariantId\)/);
  });

  it("counts only drafts that actually SENT", () => {
    // The old counter was bumped at draft creation, so it credited sends that
    // never happened — a suppressed recipient's draft being the obvious case.
    const fn = src.slice(src.indexOf("export async function getSequenceAbVariantStats"));
    expect(fn.slice(0, 1400)).toMatch(/status\} = 'sent'/);
  });

  it("counts drafts opened at least once, not raw pixel hits", () => {
    // Mail privacy proxies prefetch images, so summing openCount overstates
    // interest while "was it opened at all" stays meaningful. Same rule the ARE
    // version documents.
    const fn = src.slice(src.indexOf("export async function getSequenceAbVariantStats"));
    expect(fn.slice(0, 1400)).toMatch(/openCount\} > 0/);
  });

  it("counts one reply per draft via firstReplyAt", () => {
    const fn = src.slice(src.indexOf("export async function getSequenceAbVariantStats"));
    expect(fn.slice(0, 1400)).toMatch(/firstReplyAt\} IS NOT NULL/);
  });
});

describe("both readers use the one derivation", () => {
  const src = stripComments(read("server/routers/sequences.ts"));

  it("autoPromoteAbWinners scores from derived stats", () => {
    expect(src).toMatch(/getSequenceAbVariantStats\(/);
    // Anchored on a string unique to the PROMOTION call. An earlier version
    // anchored on "const stats = await getSequenceAbVariantStats", which matches
    // the `list` proc first — so the slice examined the wrong function entirely
    // and the assertion failed for a reason that had nothing to do with the code.
    const promote = src.slice(src.indexOf("group[0].workspaceId, group[0].sequenceId"));
    expect(promote.slice(0, 1500)).toMatch(/statFor\(v\)\.sent >= v\.minSendsForPromotion/);
    expect(promote.slice(0, 1500)).toMatch(/st\.replies > 0 \|\| st\.opens > 0/);
  });

  it("the promotion no longer reads the counter columns", () => {
    const promote = src.slice(src.indexOf("group[0].workspaceId, group[0].sequenceId"));
    expect(promote.slice(0, 1500)).not.toMatch(/v\.replyCount/);
    expect(promote.slice(0, 1500)).not.toMatch(/v\.sentCount/);
  });

  it("sequenceAb.list overlays the same derived numbers", () => {
    // So the A/B tab and the promotion decision cannot disagree — they read one
    // function. performanceMetrics is the ONE place metrics are computed.
    // sequences.ts has several `list: workspaceProcedure` procs, so anchor on the
    // overlay itself rather than the first one indexOf happens to find.
    expect(src).toMatch(/getSequenceAbVariantStats\(ctx\.workspace\.id, input\.sequenceId\)/);
    expect(src).toMatch(/sentCount: st\?\.sent \?\? 0/);
    expect(src).toMatch(/openCount: st\?\.opens \?\? 0/);
    expect(src).toMatch(/replyCount: st\?\.replies \?\? 0/);
  });
});
