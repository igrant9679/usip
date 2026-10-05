/**
 * ARE sequences and meeting proposals get the knowledge-base passages too
 * (owner ask 2026-10-05). What they search with is what is specific to the
 * person: here, that it finds the right passage.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import { areKnowledgeQuery, chatKnowledgeQuery, proposalKnowledgeQuery } from "./services/knowledgeQueries";
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

describe("chatKnowledgeQuery", () => {
  const at = "2026-10-05T12:00:00Z";
  const convo = [
    { role: "visitor", text: "Hi, do you handle fellowship programs?", at },
    { role: "agent", text: "We do! Pricing and security details are on our site.", at },
    { role: "visitor", text: "What does the enterprise plan cost?", at },
  ];

  it("is the visitor's recent messages and the page, never the agent's own words", () => {
    const q = chatKnowledgeQuery(convo, "Page: Pricing");
    expect(q).toBe("Hi, do you handle fellowship programs?\nWhat does the enterprise plan cost?\nPage: Pricing");
    expect(q).not.toContain("security details");
  });

  it("finds the pricing page for a price question", () => {
    expect(searchIndex(index, chatKnowledgeQuery(convo.slice(2)))[0].id).toBe(1);
  });

  it("a follow-up still finds the page the first question did", () => {
    const followUp = [...convo, { role: "visitor", text: "and for five users?", at }];
    expect(searchIndex(index, chatKnowledgeQuery(followUp))[0].id).toBe(1);
  });

  it("only the last three visitor messages count", () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ role: "visitor", text: `message ${i}`, at }));
    expect(chatKnowledgeQuery(many).split("\n")).toEqual(["message 3", "message 4", "message 5"]);
    expect(chatKnowledgeQuery(undefined)).toBe("");
  });

  it("the chat agent searches with it", () => {
    const src = readFileSync(path.join(__dirname, "services", "chatAgent.ts"), "utf8");
    expect(src).toContain("buildBrandContext(input.workspaceId, { query: chatKnowledgeQuery(input.messages, input.pageContext) })");
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
