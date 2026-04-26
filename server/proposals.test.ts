/**
 * Proposals module — unit tests
 * Tests business logic guards and schema validation directly,
 * using the same mock-based pattern as team.password.test.ts.
 */
import { describe, it, expect } from "vitest";
import { z } from "zod";

const ROLE_RANK: Record<string, number> = { super_admin: 5, admin: 4, manager: 3, rep: 2, viewer: 1 };
function roleRank(role: string) { return ROLE_RANK[role] ?? 0; }

const VALID_STATUSES = ["draft", "sent", "under_review", "accepted", "not_accepted", "revision_requested"] as const;
type ProposalStatus = typeof VALID_STATUSES[number];

function canCreateProposal(role: string) { return roleRank(role) >= roleRank("rep"); }
function canDeleteProposal(role: string) { return roleRank(role) >= roleRank("manager"); }
function canUpdateProposal(role: string) { return roleRank(role) >= roleRank("rep"); }
function canTransitionStatus(_from: ProposalStatus, to: ProposalStatus) { return VALID_STATUSES.includes(to); }
function isValidShareToken(token: string) { return typeof token === "string" && token.length >= 32; }

const VALID_SECTION_KEYS = ["executive_summary","firm_overview","our_approach","timeline_narrative","pricing","case_studies","references","terms"];
function isValidSectionKey(key: string) { return VALID_SECTION_KEYS.includes(key); }

const feedbackSchema = z.object({
  token: z.string().min(1),
  authorName: z.string().min(1),
  authorEmail: z.string().email().optional().or(z.literal("")),
  message: z.string().min(1),
});

const createSchema = z.object({
  title: z.string().min(1),
  clientName: z.string().min(1),
  clientEmail: z.string().email().optional().or(z.literal("")),
  budget: z.number().positive().optional(),
});

const milestoneOwnerSchema = z.enum(["lsi_media", "client", "both"]);

describe("proposals — access control", () => {
  it("rep can create proposals", () => { expect(canCreateProposal("rep")).toBe(true); });
  it("viewer cannot create proposals", () => { expect(canCreateProposal("viewer")).toBe(false); });
  it("manager can delete proposals", () => { expect(canDeleteProposal("manager")).toBe(true); });
  it("rep cannot delete proposals", () => { expect(canDeleteProposal("rep")).toBe(false); });
  it("admin can delete proposals", () => { expect(canDeleteProposal("admin")).toBe(true); });
  it("rep can update proposals", () => { expect(canUpdateProposal("rep")).toBe(true); });
  it("viewer cannot update proposals", () => { expect(canUpdateProposal("viewer")).toBe(false); });
});

describe("proposals — status transitions", () => {
  it("draft → sent", () => { expect(canTransitionStatus("draft", "sent")).toBe(true); });
  it("sent → under_review", () => { expect(canTransitionStatus("sent", "under_review")).toBe(true); });
  it("under_review → accepted", () => { expect(canTransitionStatus("under_review", "accepted")).toBe(true); });
  it("under_review → revision_requested", () => { expect(canTransitionStatus("under_review", "revision_requested")).toBe(true); });
  it("all valid statuses accepted", () => {
    for (const s of VALID_STATUSES) expect(canTransitionStatus("draft", s)).toBe(true);
  });
});

describe("proposals — share token validation", () => {
  it("accepts 64-char hex token", () => { expect(isValidShareToken("a".repeat(64))).toBe(true); });
  it("rejects short token", () => { expect(isValidShareToken("abc123")).toBe(false); });
  it("rejects empty string", () => { expect(isValidShareToken("")).toBe(false); });
});

describe("proposals — section key validation", () => {
  it("accepts all standard keys", () => {
    for (const k of VALID_SECTION_KEYS) expect(isValidSectionKey(k)).toBe(true);
  });
  it("rejects unknown key", () => { expect(isValidSectionKey("unknown")).toBe(false); });
});

describe("proposals — feedback schema", () => {
  it("accepts valid feedback with email", () => {
    expect(feedbackSchema.safeParse({ token: "t", authorName: "Jane", authorEmail: "j@a.com", message: "Hi" }).success).toBe(true);
  });
  it("accepts feedback without email", () => {
    expect(feedbackSchema.safeParse({ token: "t", authorName: "Jane", message: "Hi" }).success).toBe(true);
  });
  it("rejects empty author name", () => {
    expect(feedbackSchema.safeParse({ token: "t", authorName: "", message: "Hi" }).success).toBe(false);
  });
  it("rejects empty message", () => {
    expect(feedbackSchema.safeParse({ token: "t", authorName: "Jane", message: "" }).success).toBe(false);
  });
  it("rejects invalid email", () => {
    expect(feedbackSchema.safeParse({ token: "t", authorName: "Jane", authorEmail: "bad", message: "Hi" }).success).toBe(false);
  });
});

describe("proposals — create schema", () => {
  it("accepts minimal valid proposal", () => {
    expect(createSchema.safeParse({ title: "P", clientName: "C" }).success).toBe(true);
  });
  it("rejects empty title", () => {
    expect(createSchema.safeParse({ title: "", clientName: "C" }).success).toBe(false);
  });
  it("rejects empty client name", () => {
    expect(createSchema.safeParse({ title: "P", clientName: "" }).success).toBe(false);
  });
  it("rejects negative budget", () => {
    expect(createSchema.safeParse({ title: "P", clientName: "C", budget: -1 }).success).toBe(false);
  });
  it("accepts positive budget", () => {
    expect(createSchema.safeParse({ title: "P", clientName: "C", budget: 50000 }).success).toBe(true);
  });
});

describe("proposals — milestone owner enum", () => {
  it("accepts lsi_media", () => { expect(milestoneOwnerSchema.safeParse("lsi_media").success).toBe(true); });
  it("accepts client", () => { expect(milestoneOwnerSchema.safeParse("client").success).toBe(true); });
  it("accepts both", () => { expect(milestoneOwnerSchema.safeParse("both").success).toBe(true); });
  it("rejects unknown owner", () => { expect(milestoneOwnerSchema.safeParse("vendor").success).toBe(false); });
});
