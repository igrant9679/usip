import { describe, it, expect } from "vitest";
import { selectKnowledge, formatKnowledge, type KnowledgeEntry } from "./chatKnowledge";

const e = (o: Partial<KnowledgeEntry> & { id: number }): KnowledgeEntry => ({
  title: "", body: "", enabled: true, sortOrder: 0, ...o,
});

const CORPUS: KnowledgeEntry[] = [
  e({ id: 1, title: "What happens on the audit call?", body: "We walk through your current process and map what is automatable.", sortOrder: 0 }),
  e({ id: 2, title: "How long does an engagement take?", body: "Most run six to eight weeks depending on scope.", sortOrder: 1 }),
  e({ id: 3, title: "Do you work with grant reporting?", body: "Yes — funder formats and reporting deadlines are a common starting point.", sortOrder: 2 }),
  e({ id: 4, title: "Which tools do you integrate with?", body: "Salesforce, Raiser's Edge and most CRMs with an API.", sortOrder: 3 }),
];

describe("selectKnowledge", () => {
  it("ranks the entry the visitor actually asked about first", () => {
    expect(selectKnowledge(CORPUS, "what happens on the audit call?")[0].id).toBe(1);
    expect(selectKnowledge(CORPUS, "do you handle grant reporting for funders?")[0].id).toBe(3);
  });

  it("weights a title match above a body mention", () => {
    // "reporting" appears in entry 3's title and body; "process" only in 1's body.
    expect(selectKnowledge(CORPUS, "reporting")[0].id).toBe(3);
  });

  /**
   * The rule the whole file exists for: an agent handed no facts invents. Never
   * return nothing, even when the question matches nothing we have written.
   */
  it("still returns entries when nothing matches", () => {
    const picked = selectKnowledge(CORPUS, "do you sell insurance in Portugal");
    expect(picked.length).toBeGreaterThan(0);
    expect(picked[0].id).toBe(1); // falls back to the admin's own ordering
  });

  it("respects the limit and pads with sortOrder after the matches", () => {
    const picked = selectKnowledge(CORPUS, "audit call", 3);
    expect(picked).toHaveLength(3);
    expect(picked[0].id).toBe(1);
    expect(new Set(picked.map((p) => p.id)).size).toBe(3); // no duplicates
  });

  it("ignores disabled entries entirely", () => {
    const corpus = [e({ id: 9, title: "Secret pricing", body: "internal only", enabled: false })];
    expect(selectKnowledge(corpus, "pricing")).toEqual([]);
  });

  it("is not thrown off by stopwords alone", () => {
    // A query of pure stopwords matches nothing, so ordering decides.
    expect(selectKnowledge(CORPUS, "what is the it and of")[0].id).toBe(1);
  });

  it("is stable regardless of the order rows come back from the database", () => {
    const a = selectKnowledge([...CORPUS].reverse(), "integrate tools").map((x) => x.id);
    const b = selectKnowledge(CORPUS, "integrate tools").map((x) => x.id);
    expect(a).toEqual(b);
  });

  it("is empty-safe", () => {
    expect(selectKnowledge([], "anything")).toEqual([]);
    expect(selectKnowledge(CORPUS, "", 0)).toEqual([]);
  });
});

describe("formatKnowledge", () => {
  it("renders question/answer pairs", () => {
    const out = formatKnowledge([CORPUS[0]]);
    expect(out).toContain("Q: What happens on the audit call?");
    expect(out).toContain("A: We walk through");
  });

  it("stops at the character budget so one long answer cannot crowd out the chat", () => {
    const long = e({ id: 5, title: "Long", body: "x".repeat(5000) });
    expect(formatKnowledge([CORPUS[0], long], 300).length).toBeLessThanOrEqual(300);
    expect(formatKnowledge([CORPUS[0], long], 300)).toContain("audit call");
  });

  it("returns empty string for no entries, so the caller omits the block", () => {
    expect(formatKnowledge([])).toBe("");
  });
});
