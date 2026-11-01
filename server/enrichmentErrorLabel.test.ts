/**
 * describeEnrichmentError — the stored machine reason vs what a person reads
 * (owner ask 2026-08-19: "quickenrich: no_match" → "Not in QuickEnrich", brown).
 *
 * Extended 2026-10-31, after F11's stall panel was found live on ws 2 campaign
 * 38 rendering this, twice, as its account of why the campaign was stuck:
 *
 *   1× Failed query: insert into `prospect_intelligence` (`id`,
 *   `prospectQueueId`, … `updatedAt`) values (default, ?, ?, …, defa
 *
 * Two separate faults met there. The panel printed the stored string verbatim,
 * so a column list crowded out the explanation; and the stored string had no
 * explanation in it to crowd out, because a Drizzle query error keeps the SQL
 * in its own message and the driver's complaint in `cause`, and the 800-byte
 * cap landed inside the VALUES list. The cap also cut mid-token, which is how
 * "defa" reached a user's screen.
 */
import { describe, it, expect } from "vitest";
import {
  ENRICHMENT_LABEL_CHARS,
  clipAtWordBoundary,
  describeEnrichmentError,
  enrichmentReasonFrom,
} from "../shared/enrichmentErrorLabel";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8").replace(/\r\n/g, "\n");

describe("describeEnrichmentError", () => {
  it("no_match in QuickEnrich is information, not a fault", () => {
    // 2026-10-31: these three expectations gained `detail`. The old reasoning
    // — that the label and tone were the whole of the answer — expired when
    // the label became a CLASS rather than the raw text: something has to
    // still carry the stored string for the tooltip, and callers must not have
    // to keep hold of it themselves to show it.
    expect(describeEnrichmentError("quickenrich: no_match")).toEqual({ label: "Not in QuickEnrich", tone: "info", detail: "quickenrich: no_match" });
    expect(describeEnrichmentError("QuickEnrich: NO_MATCH")).toEqual({ label: "Not in QuickEnrich", tone: "info", detail: "QuickEnrich: NO_MATCH" });
    // The brown class must live in client code (Tailwind scans client/, not shared/).
    const page = read("client/src/pages/usip/ARECampaignDetail.tsx");
    expect(page).toMatch(/info: "text-\[#8B5A2B\]/);
  });
  it("a transient QuickEnrich transport failure reads as transient", () => {
    const raw = "quickenrich: timeout — transport failure, will retry";
    expect(describeEnrichmentError(raw)).toEqual({ label: "QuickEnrich unavailable — will retry", tone: "warn", detail: raw });
  });
  it("other QuickEnrich reasons are named, other errors stay red verbatim", () => {
    expect(describeEnrichmentError("quickenrich: rate_limited")).toEqual({ label: "QuickEnrich: rate limited", tone: "warn", detail: "quickenrich: rate_limited" });
    expect(describeEnrichmentError("LinkedIn profile unavailable")).toEqual({ label: "LinkedIn profile unavailable", tone: "error", detail: "LinkedIn profile unavailable" });
    expect(describeEnrichmentError("")).toBeNull();
    expect(describeEnrichmentError(null)).toBeNull();
  });
});

/**
 * The failure a person can act on (2026-10-31).
 *
 * The test fixture is built rather than pasted, so it stays the shape of a
 * Drizzle error — a long parenthesised column list and no reason — without
 * pinning one day's column set.
 */
const COLUMNS = Array.from({ length: 80 }, (_, i) => "`field" + i + "`").join(", ");
const QUERY = "Failed query: insert into `prospect_intelligence` (" + COLUMNS + ") values (default, ?, ?, default)";

describe("an enrichment failure renders as a class, with the evidence on hover", () => {
  it("is long enough to be the problem it was", () => {
    // If the fixture stops being longer than the stored cap, the two tests
    // below stop testing what they are named for.
    expect(QUERY.length).toBeGreaterThan(800);
  });

  it("reads as a class rather than a column list, and keeps the whole string", () => {
    const d = describeEnrichmentError(QUERY)!;
    expect(d.tone).toBe("error");
    expect(d.label).toBe("The database rejected the write — only the query was recorded, not the reason");
    // The specific thing that reached the panel: SQL, as the explanation.
    expect(d.label).not.toContain("insert into");
    expect(d.label).not.toContain("`");
    expect(d.label).not.toContain("default");
    // Not discarded — moved. A tooltip or a details view still has all of it.
    expect(d.detail).toBe(QUERY);
  });

  it("keeps the driver's reason when there is one, ahead of the SQL", () => {
    // The chain order IS the fix: outermost-first, the cap ate this sentence.
    const err = new Error(QUERY, { cause: new Error("Data too long for column 'summary' at row 1") });
    const chain = enrichmentReasonFrom(err);
    expect(chain.startsWith("Data too long for column 'summary' at row 1")).toBe(true);
    expect(chain).toContain("Failed query:");

    const stored = clipAtWordBoundary(chain, 800);
    expect(stored.startsWith("Data too long for column 'summary' at row 1")).toBe(true);
    // And the label is then the reason, not the generic database class: the
    // generic one is only for when nothing better was recorded.
    expect(describeEnrichmentError(stored)!.label).toBe("Data too long for column 'summary' at row 1");
  });

  it("walks at most a few causes, and repeats no message twice", () => {
    const inner = new Error("boom");
    const outer = new Error("boom", { cause: inner });
    expect(enrichmentReasonFrom(outer)).toBe("boom");
    expect(enrichmentReasonFrom("not an Error")).toBe("not an Error");
    expect(enrichmentReasonFrom(null)).toBe("");
    // Deep enough to be useful, bounded so a cyclic-ish chain cannot run away.
    let deep: Error = new Error("level0");
    for (let i = 1; i < 10; i++) deep = new Error("level" + i, { cause: deep });
    expect(enrichmentReasonFrom(deep).split(" — ")).toHaveLength(5);
  });
});

describe("a clip lands on a word boundary or does not happen", () => {
  const WORDS = "alpha bravo charlie delta echo foxtrot golf hotel india juliet";

  it("is a line of a list, and the limit cannot quietly become a paragraph", () => {
    // The number is a judgement and may change; what must not change is its
    // order of magnitude. Raised to 900 it reinstates the dump this exists to
    // stop, which every other assertion here would still pass, because they
    // measure against the constant.
    expect(ENRICHMENT_LABEL_CHARS).toBeGreaterThanOrEqual(60);
    expect(ENRICHMENT_LABEL_CHARS).toBeLessThanOrEqual(160);
  });

  it("leaves a string that already fits exactly alone", () => {
    expect(clipAtWordBoundary(WORDS, WORDS.length)).toBe(WORDS);
    expect(clipAtWordBoundary(WORDS, WORDS.length + 50)).toBe(WORDS);
    expect(clipAtWordBoundary("", 10)).toBe("");
    expect(clipAtWordBoundary(null, 10)).toBe("");
  });

  it("cuts only where the original has whitespace", () => {
    // Asserted as a property at every limit, not at one hand-picked number:
    // an off-by-one comparator that lands inside a word fails here whatever
    // the limit happens to be.
    for (let limit = 1; limit <= WORDS.length; limit++) {
      const clipped = clipAtWordBoundary(WORDS, limit);
      if (clipped === "" || clipped === WORDS) continue;
      expect(clipped.endsWith("…"), "limit " + limit).toBe(true);
      const kept = clipped.slice(0, -1);
      expect(WORDS.startsWith(kept), "limit " + limit).toBe(true);
      expect(kept.length, "limit " + limit).toBeLessThanOrEqual(limit);
      // The character the original continues with is whitespace, so `kept`
      // ends on a whole word rather than part of one.
      expect(WORDS[kept.length], "limit " + limit).toBe(" ");
    }
  });

  it("takes as many whole words as fit, not just the first", () => {
    expect(clipAtWordBoundary(WORDS, 40)).toBe("alpha bravo charlie delta echo foxtrot…");
    expect(clipAtWordBoundary(WORDS, WORDS.length - 1)).toBe("alpha bravo charlie delta echo foxtrot golf hotel india…");
  });

  it("says so rather than showing half of one long token", () => {
    const token = "x".repeat(200);
    expect(clipAtWordBoundary(token, ENRICHMENT_LABEL_CHARS)).toBe("");
    const d = describeEnrichmentError(token)!;
    expect(d.label).toBe("Enrichment failed — the recorded reason is not readable text");
    expect(d.label).not.toContain("xxxx");
    expect(d.detail).toBe(token);
  });

  it("never returns a label longer than a line, or one with a newline in it", () => {
    const nasty = [
      QUERY,
      "x".repeat(400),
      "first line, which is the useful one\nsecond line\n    at Object.<anonymous> (/app/server/x.ts:1:1)",
      "quickenrich: no_match",
      "A ".repeat(300),
      "  padded  ",
    ];
    for (const raw of nasty) {
      const d = describeEnrichmentError(raw);
      expect(d, raw.slice(0, 30)).not.toBeNull();
      // +1 for the ellipsis a clip adds.
      expect(d!.label.length, raw.slice(0, 30)).toBeLessThanOrEqual(ENRICHMENT_LABEL_CHARS + 1);
      expect(d!.label, raw.slice(0, 30)).not.toMatch(/[\r\n]/);
      expect(d!.detail, raw.slice(0, 30)).toBe(raw.trim());
    }
  });

  it("shows the first line, which is the explanation, not the stack under it", () => {
    const d = describeEnrichmentError("Model returned no JSON\n    at parseLlmJson (/app/server/routers/are/llmJson.ts:14:9)")!;
    expect(d.label).toBe("Model returned no JSON");
    expect(d.detail).toContain("at parseLlmJson");
  });
});

describe("both ends are wired to it", () => {
  it("the writer stores a reason rather than a statement, cut on whitespace", () => {
    const prospects = read("server/routers/are/prospects.ts");
    expect(prospects).toContain("const reason = clipAtWordBoundary(enrichmentReasonFrom(err), 800);");
    // The exact expression that stored 800 characters of column list.
    expect(prospects).not.toContain("(err instanceof Error ? err.message : String(err)).slice(0, 800)");
    // The rate-limit branch embeds the reason in a sentence; it cut mid-token too.
    expect(prospects).toContain("clipAtWordBoundary(reason, 300)");
    expect(prospects).not.toContain("reason.slice(0, 300)");
  });

  it("the F11 panel puts the label on the line and the detail on hover", () => {
    const panel = read("client/src/components/usip/are/CampaignStallPanel.tsx");
    expect(panel).toContain("title={d?.detail}");
    expect(panel).toContain('{d?.label ?? "No reason recorded"}');
    // It must read the describer rather than the raw field.
    expect(panel).toContain("describeEnrichmentError(r.reason)");
    expect(panel).not.toContain("{r.reason}");
  });

  it("the prospect row reads the same detail, so the two cannot drift", () => {
    const page = read("client/src/pages/usip/ARECampaignDetail.tsx");
    expect(page).toContain("title={e.detail}");
    expect(page).not.toContain("title={p.enrichmentError}");
  });
});
