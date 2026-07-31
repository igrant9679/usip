/**
 * The ARE enrichment pass pays an LLM to find trigger events and pain signals,
 * and all of it stayed in `prospect_intelligence` — keyed by prospectQueueId,
 * which no CRM surface joins on.
 *
 * 🔴 WHAT WAS NOT BUILT, AND WHY. The obvious wiring — feed that intelligence
 * into the priority score — would have been INERT. The only link from a queue
 * row to a priority-scored entity is `prospectQueue.linkedContactId`, and that
 * is written by exactly one function, `promoteProspectToCrm`, on a POSITIVE
 * SIGNAL. It is a deliberate product rule (chosen 2026-07-18: "promote on a
 * positive signal, not on discovery"), and the schema comment says the same:
 * "created after positive reply". So intelligence could only ever reach a
 * contact who had ALREADY REPLIED — whose engagement component is already
 * maximal and whose prioritisation is moot. Code that looks wired, passes its
 * tests, and changes nothing.
 *
 * What IS real is the carry-over below: promotion is the one moment the code
 * holds both records, so the enrichment stops being stranded. The keys written
 * are the ones intentScoreFromRow reads, and they are RESERVED in
 * @shared/customFieldKeys precisely so an engine can own them.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { intentKeysFromIntelligence } from "./routers/are/execution";
import { reservedCustomFieldKey } from "@shared/customFieldKeys";

const ROOT = join(__dirname, "..");

describe("intentKeysFromIntelligence", () => {
  it("returns null when the record carries nothing usable", () => {
    expect(intentKeysFromIntelligence({})).toBeNull();
    expect(intentKeysFromIntelligence({ triggerEvents: [], painSignals: [], recentNews: [] })).toBeNull();
    // Absent, not zero — the scorer treats a missing key as unmeasured.
    expect(intentKeysFromIntelligence({ triggerEvents: null, painSignals: "nonsense" })).toBeNull();
  });

  it("maps pain signals and trigger types into intentTopics", () => {
    const out = intentKeysFromIntelligence({
      painSignals: [{ signal: "manual reporting", strength: 3 }],
      triggerEvents: [{ type: "new CRO hired", description: "..." }],
    })!;
    expect(out.intentTopics).toEqual(["manual reporting", "new CRO hired"]);
  });

  it("dedupes and drops blanks", () => {
    const out = intentKeysFromIntelligence({
      painSignals: [{ signal: "churn" }, { signal: "churn" }, { signal: "   " }, { signal: 42 }],
      triggerEvents: [{ type: "churn" }],
    })!;
    expect(out.intentTopics).toEqual(["churn"]);
  });

  it("caps the list so one noisy enrichment cannot bloat the row", () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ signal: `s${i}` }));
    const out = intentKeysFromIntelligence({ painSignals: many })!;
    expect((out.intentTopics as string[]).length).toBe(20);
  });

  it("passes recentNews through when there is any", () => {
    const news = [{ headline: "Series B", url: "https://x" }];
    expect(intentKeysFromIntelligence({ recentNews: news })!.recentNews).toEqual(news);
  });

  /**
   * The important restraint. `triggerEvents[].type` is free text — the
   * enrichment JSON schema declares it `{ type: "string" }` with NO enum — so
   * classifying one as a funding round means string-matching an LLM's prose.
   * Absent beats guessed: the scorer counts only keys that are present.
   */
  it("never fabricates the semantic signals it cannot verify", () => {
    const out = intentKeysFromIntelligence({
      triggerEvents: [
        { type: "raised Series B funding" },
        { type: "hired 40 engineers" },
        { type: "new CEO appointed" },
      ],
    })!;
    for (const guessed of ["recentFunding", "hiringSignals", "recentExecChange", "websiteKeywords"]) {
      expect(out, guessed).not.toHaveProperty(guessed);
    }
    // They land as topics, which is the claim the data actually supports.
    expect((out.intentTopics as string[]).length).toBe(3);
  });

  it("only emits keys the scorer reads AND the reservation list owns", () => {
    const out = intentKeysFromIntelligence({
      painSignals: [{ signal: "x" }],
      recentNews: [{ headline: "y" }],
    })!;
    for (const k of Object.keys(out)) {
      // If an engine writes it, a custom field must not be able to collide
      // with it — that is what a278a39 reserved these names for.
      expect(reservedCustomFieldKey(k), k).not.toBeNull();
    }
  });
});

describe("the carry-over is wired into promotion", () => {
  const src = readFileSync(join(ROOT, "server/routers/are/execution.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  it("promoteProspectToCrm calls it (a mapper with no caller is the bug it fixes)", () => {
    const fn = src.slice(src.indexOf("export async function promoteProspectToCrm"));
    expect(fn).toContain("intentKeysFromIntelligence");
  });

  it("MERGES rather than overwriting the customFields blob", () => {
    // Admin-defined custom field values live in the same blob; a bare
    // `.set({ customFields: intentKeys })` would erase them.
    expect(src).toMatch(/\{ \.\.\.current, \.\.\.intentKeys \}/);
  });

  /**
   * Anchored on the bare identifier: the declaration is
   * `const [intelForContact] = ...`, and slicing from an indexOf that misses
   * returns -1 → the LAST CHARACTER of the file, so both assertions below were
   * silently inspecting a newline and passing nothing. Assert the anchor was
   * found before using it.
   */
  const carryBlock = (() => {
    const at = src.indexOf("intelForContact");
    expect(at, "carry-over block not found — the rest of this describe is vacuous").toBeGreaterThan(0);
    return src.slice(at, at + 1600);
  })();

  it("scopes the intelligence read and the contact write by workspace", () => {
    expect(carryBlock).toContain("prospectIntelligence.workspaceId");
    expect(carryBlock).toContain("contacts.workspaceId");
  });

  it("never fails the promotion when the carry-over throws", () => {
    // A positive reply must still create the contact.
    expect(carryBlock).toMatch(/catch \(e\)/);
  });
});
