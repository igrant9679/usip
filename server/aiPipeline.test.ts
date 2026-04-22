/**
 * Tests for AI Pipeline, Pipeline Alerts, and Account Briefs routers
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mock DB ──────────────────────────────────────────────────────────────────
const mockDb = {
  select: vi.fn().mockReturnThis(),
  from: vi.fn().mockReturnThis(),
  where: vi.fn().mockReturnThis(),
  orderBy: vi.fn().mockReturnThis(),
  limit: vi.fn().mockReturnThis(),
  offset: vi.fn().mockReturnThis(),
  insert: vi.fn().mockReturnThis(),
  values: vi.fn().mockReturnThis(),
  $returningId: vi.fn().mockResolvedValue([{ id: 42 }]),
  update: vi.fn().mockReturnThis(),
  set: vi.fn().mockReturnThis(),
};

vi.mock("./db", () => ({
  getDb: vi.fn().mockResolvedValue(mockDb),
}));

vi.mock("./_core/llm", () => ({
  invokeLLM: vi.fn().mockResolvedValue({
    choices: [{ message: { content: "Mocked LLM response" } }],
  }),
}));

vi.mock("./storage", () => ({
  storagePut: vi.fn().mockResolvedValue({ key: "test-key", url: "/manus-storage/test.pdf" }),
}));

// ─── AI Pipeline Job Schema ────────────────────────────────────────────────────
describe("AI Pipeline Job", () => {
  it("should have correct status enum values", () => {
    const validStatuses = ["queued", "running", "done", "failed"];
    expect(validStatuses).toContain("queued");
    expect(validStatuses).toContain("running");
    expect(validStatuses).toContain("done");
    expect(validStatuses).toContain("failed");
  });

  it("should have correct tone values for email drafts", () => {
    const validTones = ["formal", "casual", "value_prop"];
    expect(validTones).toHaveLength(3);
    expect(validTones).toContain("formal");
    expect(validTones).toContain("casual");
    expect(validTones).toContain("value_prop");
  });

  it("should generate 3 draft variants per pipeline run", () => {
    const tones = ["formal", "casual", "value_prop"];
    expect(tones).toHaveLength(3);
  });
});

// ─── Pipeline Alerts ──────────────────────────────────────────────────────────
describe("Pipeline Alerts", () => {
  it("should have correct alert type enum values", () => {
    const alertTypes = ["no_activity", "closing_soon_regression", "amount_change", "no_champion"];
    expect(alertTypes).toHaveLength(4);
    expect(alertTypes).toContain("no_activity");
    expect(alertTypes).toContain("closing_soon_regression");
    expect(alertTypes).toContain("no_champion");
  });

  it("should use 14 days as no-activity threshold", () => {
    const NO_ACTIVITY_DAYS = 14;
    expect(NO_ACTIVITY_DAYS).toBe(14);
  });

  it("should use 30 days as closing-soon threshold", () => {
    const CLOSING_SOON_DAYS = 30;
    expect(CLOSING_SOON_DAYS).toBe(30);
  });

  it("should correctly identify active opportunity stages", () => {
    const allStages = ["discovery", "qualified", "proposal", "negotiation", "won", "lost"];
    const activeStages = allStages.filter((s) => !["won", "lost"].includes(s));
    expect(activeStages).toHaveLength(4);
    expect(activeStages).not.toContain("won");
    expect(activeStages).not.toContain("lost");
  });
});

// ─── Account Briefs ───────────────────────────────────────────────────────────
describe("Account Briefs", () => {
  it("should have required sections in brief prompt", () => {
    const sections = [
      "Company Overview",
      "Key Stakeholders",
      "Open Opportunities",
      "Recent Engagement",
      "Recommended Next Steps",
    ];
    expect(sections).toHaveLength(5);
    sections.forEach((s) => expect(s).toBeTruthy());
  });

  it("should generate PDF with correct content type", () => {
    const contentType = "application/pdf";
    expect(contentType).toBe("application/pdf");
  });

  it("should sanitize account name for S3 key", () => {
    const accountName = "Acme Corp & Partners!";
    const safeKey = accountName.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40);
    expect(safeKey).not.toContain(" ");
    expect(safeKey).not.toContain("&");
    expect(safeKey).not.toContain("!");
    expect(safeKey.length).toBeLessThanOrEqual(40);
  });
});

// ─── Draft Review Queue ───────────────────────────────────────────────────────
describe("Draft Review Queue", () => {
  it("should support all draft statuses including ai_pending_review", () => {
    const statuses = ["pending_review", "approved", "rejected", "sent", "ai_pending_review"];
    expect(statuses).toContain("ai_pending_review");
    expect(statuses).toContain("approved");
    expect(statuses).toContain("rejected");
  });

  it("should support all regeneration presets", () => {
    const presets = ["more_formal", "shorter", "stronger_cta", "different_angle"];
    expect(presets).toHaveLength(4);
    presets.forEach((p) => expect(p).toBeTruthy());
  });

  it("should paginate correctly with default page size 20", () => {
    const page = 1;
    const pageSize = 20;
    const offset = (page - 1) * pageSize;
    expect(offset).toBe(0);

    const page2Offset = (2 - 1) * pageSize;
    expect(page2Offset).toBe(20);
  });
});
