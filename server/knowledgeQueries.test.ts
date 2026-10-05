/**
 * ARE sequences and meeting proposals get the knowledge-base passages too
 * (owner ask 2026-10-05). What they search with is what is specific to the
 * person: here, that it finds the right passage.
 */
import { describe, expect, it } from "vitest";
import { areKnowledgeQuery, proposalKnowledgeQuery } from "./services/knowledgeQueries";
import { buildIndex, searchIndex } from "./services/knowledgeText";

const index = buildIndex([
  { id: 1, title: "Pricing", page: 2, content: "Enterprise plan: $2,400 per year, unlimited reviewers, SSO." },
  { id: 2, title: "Review workflows", page: 4, content: "Automated application review replaces spreadsheets: reviewers score online, scores roll up instantly, conflicts of interest are flagged." },
  { id: 3, title: "Security", page: 6, content: "SOC 2 Type II audited annually; data encrypted at rest and in transit." },
  { id: 4, title: "Fellowships", page: 3, content: "Fellowship programs: multi-stage applications, recommender letters, interview scheduling." },
]);

describe("areKnowledgeQuery", () => {
  const q = areKnowledgeQuery(
    { industry: "Higher education", title: "Director of Scholarships" },
    { companyOneLiner: "University foundation running 40 scholarship programs." },
    [{ signal: "Manual application review in spreadsheets", evidence: "Job post for a review coordinator" }, {}],
    "Their reviewers still score in spreadsheets",
    ["Focus on review workflow automation", ""],
  );

  it("is made of what is specific to this person and campaign", () => {
    expect(q.split("\n")).toEqual([
      "Higher education",
      "Director of Scholarships",
      "University foundation running 40 scholarship programs.",
      "Manual application review in spreadsheets Job post for a review coordinator",
      "Their reviewers still score in spreadsheets",
      "Focus on review workflow automation",
    ]);
  });

  it("finds the passage about their pain first", () => {
    expect(searchIndex(index, q)[0].id).toBe(2);
  });

  it("is capped", () => {
    expect(areKnowledgeQuery({}, {}, [{ signal: "x".repeat(9000) }], "", []).length).toBe(6000);
  });
});

describe("proposalKnowledgeQuery", () => {
  it("a reply asking about price finds the pricing page", () => {
    const q = proposalKnowledgeQuery({ descriptor: "replied: what does the enterprise plan cost and do you support SSO?", company: "Acme University" });
    expect(searchIndex(index, q)[0].id).toBe(1);
  });

  it("a fellowship director finds the fellowship page", () => {
    const q = proposalKnowledgeQuery({ descriptor: "Director of Fellowships, industry Higher education", company: "State University" });
    expect(searchIndex(index, q)[0].id).toBe(4);
  });

  it("nothing known, nothing searched", () => {
    expect(proposalKnowledgeQuery({})).toBe("");
  });
});
