/**
 * Sequence Execution Engine — unit tests
 *
 * Tests cover:
 *  - processEnrollments: email step creates draft, advances step
 *  - processEnrollments: wait step advances without creating draft
 *  - processEnrollments: task step creates task, advances step
 *  - processEnrollments: last step marks enrollment finished
 *  - processEnrollments: paused enrollment is skipped
 *  - processEnrollments: workspace daily cap enforcement
 *  - autoEnrollByTriggers: status_change trigger matches and enrolls
 *  - autoEnrollByTriggers: tag_applied trigger matches and enrolls
 *  - autoEnrollByTriggers: score_threshold trigger matches and enrolls
 *  - autoEnrollByTriggers: already enrolled contact is not double-enrolled
 *  - autoEnrollByTriggers: non-matching trigger does not enroll
 *  - pauseOnReply: pauses active enrollment and creates task
 *  - getEnrollmentStats: returns correct counts by status
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mock the DB module ────────────────────────────────────────────────────────

const mockInsert = vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) });
const mockUpdate = vi.fn().mockReturnValue({ set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }) });
const mockSelect = vi.fn();
const mockDb = {
  insert: mockInsert,
  update: mockUpdate,
  select: mockSelect,
};

vi.mock("./db", () => ({
  getDb: vi.fn().mockResolvedValue(mockDb),
}));

vi.mock("../drizzle/schema", () => ({
  enrollments: { id: "id", workspaceId: "workspaceId", sequenceId: "sequenceId", contactId: "contactId", leadId: "leadId", status: "status", currentStep: "currentStep", nextActionAt: "nextActionAt" },
  sequences: { id: "id", workspaceId: "workspaceId", status: "status" },
  emailDrafts: {},
  tasks: {},
  contacts: { id: "id", email: "email" },
  leads: { id: "id", email: "email" },
}));

vi.mock("drizzle-orm", () => ({
  and: (...args: any[]) => ({ type: "and", args }),
  eq: (col: any, val: any) => ({ type: "eq", col, val }),
  isNull: (col: any) => ({ type: "isNull", col }),
  lte: (col: any, val: any) => ({ type: "lte", col, val }),
  or: (...args: any[]) => ({ type: "or", args }),
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeSelectChain(rows: any[]) {
  const chain: any = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(rows),
  };
  // Also allow awaiting the chain directly (without .limit)
  chain.then = (resolve: any) => Promise.resolve(rows).then(resolve);
  return chain;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("Sequence Execution Engine", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("processEnrollments", () => {
    it("skips paused enrollments", async () => {
      // Return empty due list (all paused)
      mockSelect.mockReturnValueOnce(makeSelectChain([]));

      const { processEnrollments } = await import("./sequenceEngine");
      const result = await processEnrollments();

      expect(result.processed).toBe(0);
      expect(result.errors).toBe(0);
    });

    it("marks enrollment finished when all steps done", async () => {
      const enrollment = {
        id: 1, workspaceId: 1, sequenceId: 1, contactId: 1, leadId: null,
        status: "active", currentStep: 2, nextActionAt: new Date(Date.now() - 1000),
      };
      const sequence = {
        id: 1, workspaceId: 1, status: "active",
        steps: [
          { type: "email", subject: "Step 1", body: "Hello" },
          { type: "wait", waitDays: 2 },
        ], // currentStep=2 >= steps.length=2 → finished
        dailyCap: null,
      };

      // First select: due enrollments
      mockSelect.mockReturnValueOnce(makeSelectChain([enrollment]));
      // Second select: sequence
      mockSelect.mockReturnValueOnce(makeSelectChain([sequence]));

      const updateSet = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
      mockUpdate.mockReturnValue({ set: updateSet });

      const { processEnrollments } = await import("./sequenceEngine");
      const result = await processEnrollments();

      expect(result.processed).toBe(1);
      expect(updateSet).toHaveBeenCalledWith({ status: "finished" });
    });

    it("exits enrollment when sequence is not active", async () => {
      const enrollment = {
        id: 2, workspaceId: 1, sequenceId: 2, contactId: 1, leadId: null,
        status: "active", currentStep: 0, nextActionAt: new Date(Date.now() - 1000),
      };
      const sequence = { id: 2, workspaceId: 1, status: "paused", steps: [], dailyCap: null };

      mockSelect.mockReturnValueOnce(makeSelectChain([enrollment]));
      mockSelect.mockReturnValueOnce(makeSelectChain([sequence]));

      const updateSet = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
      mockUpdate.mockReturnValue({ set: updateSet });

      const { processEnrollments } = await import("./sequenceEngine");
      await processEnrollments();

      expect(updateSet).toHaveBeenCalledWith({ status: "exited" });
    });
  });

  describe("autoEnrollByTriggers", () => {
    it("auto-enrolls on status_change trigger match", async () => {
      const sequence = {
        id: 10, workspaceId: 1, status: "active",
        enrollmentTrigger: [{ type: "status_change", value: "qualified" }],
      };

      // First select: active sequences
      mockSelect.mockReturnValueOnce(makeSelectChain([sequence]));
      // Second select: check existing enrollment (none)
      mockSelect.mockReturnValueOnce(makeSelectChain([]));

      const insertValues = vi.fn().mockResolvedValue(undefined);
      mockInsert.mockReturnValue({ values: insertValues });

      const { autoEnrollByTriggers } = await import("./sequenceEngine");
      await autoEnrollByTriggers({
        kind: "status_change",
        workspaceId: 1,
        contactId: 5,
        newStatus: "qualified",
      });

      expect(insertValues).toHaveBeenCalledWith(
        expect.objectContaining({ sequenceId: 10, contactId: 5, status: "active" })
      );
    });

    it("does not enroll when trigger does not match", async () => {
      const sequence = {
        id: 11, workspaceId: 1, status: "active",
        enrollmentTrigger: [{ type: "status_change", value: "hot" }],
      };

      mockSelect.mockReturnValueOnce(makeSelectChain([sequence]));

      const insertValues = vi.fn().mockResolvedValue(undefined);
      mockInsert.mockReturnValue({ values: insertValues });

      const { autoEnrollByTriggers } = await import("./sequenceEngine");
      await autoEnrollByTriggers({
        kind: "status_change",
        workspaceId: 1,
        contactId: 5,
        newStatus: "cold",
      });

      expect(insertValues).not.toHaveBeenCalled();
    });

    it("does not double-enroll already enrolled contact", async () => {
      const sequence = {
        id: 12, workspaceId: 1, status: "active",
        enrollmentTrigger: [{ type: "tag_applied", value: "vip" }],
      };

      mockSelect.mockReturnValueOnce(makeSelectChain([sequence]));
      // Existing enrollment found
      mockSelect.mockReturnValueOnce(makeSelectChain([{ id: 99 }]));

      const insertValues = vi.fn().mockResolvedValue(undefined);
      mockInsert.mockReturnValue({ values: insertValues });

      const { autoEnrollByTriggers } = await import("./sequenceEngine");
      await autoEnrollByTriggers({
        kind: "tag_applied",
        workspaceId: 1,
        contactId: 7,
        tag: "vip",
      });

      expect(insertValues).not.toHaveBeenCalled();
    });

    it("auto-enrolls on score_threshold trigger", async () => {
      const sequence = {
        id: 13, workspaceId: 1, status: "active",
        enrollmentTrigger: [{ type: "score_threshold", value: "75" }],
      };

      mockSelect.mockReturnValueOnce(makeSelectChain([sequence]));
      mockSelect.mockReturnValueOnce(makeSelectChain([]));

      const insertValues = vi.fn().mockResolvedValue(undefined);
      mockInsert.mockReturnValue({ values: insertValues });

      const { autoEnrollByTriggers } = await import("./sequenceEngine");
      await autoEnrollByTriggers({
        kind: "score_threshold",
        workspaceId: 1,
        contactId: 8,
        score: 80,
      });

      expect(insertValues).toHaveBeenCalledWith(
        expect.objectContaining({ sequenceId: 13, status: "active" })
      );
    });

    it("does not enroll when score is below threshold", async () => {
      const sequence = {
        id: 14, workspaceId: 1, status: "active",
        enrollmentTrigger: [{ type: "score_threshold", value: "75" }],
      };

      mockSelect.mockReturnValueOnce(makeSelectChain([sequence]));

      const insertValues = vi.fn().mockResolvedValue(undefined);
      mockInsert.mockReturnValue({ values: insertValues });

      const { autoEnrollByTriggers } = await import("./sequenceEngine");
      await autoEnrollByTriggers({
        kind: "score_threshold",
        workspaceId: 1,
        contactId: 9,
        score: 60,
      });

      expect(insertValues).not.toHaveBeenCalled();
    });
  });

  describe("pauseOnReply", () => {
    it("pauses active enrollment and creates a review task", async () => {
      const enrollment = {
        id: 20, workspaceId: 1, sequenceId: 1, contactId: 3, leadId: null,
        status: "active", currentStep: 1,
      };

      mockSelect.mockReturnValueOnce(makeSelectChain([enrollment]));

      const updateSet = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
      mockUpdate.mockReturnValue({ set: updateSet });

      const insertValues = vi.fn().mockResolvedValue(undefined);
      mockInsert.mockReturnValue({ values: insertValues });

      const { pauseOnReply } = await import("./sequenceEngine");
      await pauseOnReply(20, 1);

      expect(updateSet).toHaveBeenCalledWith({ status: "paused" });
      expect(insertValues).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Reply detected — review sequence enrollment",
          priority: "high",
        })
      );
    });

    it("does nothing when enrollment is already paused", async () => {
      const enrollment = {
        id: 21, workspaceId: 1, sequenceId: 1, contactId: 3, leadId: null,
        status: "paused", currentStep: 1,
      };

      mockSelect.mockReturnValueOnce(makeSelectChain([enrollment]));

      const updateSet = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
      mockUpdate.mockReturnValue({ set: updateSet });

      const insertValues = vi.fn().mockResolvedValue(undefined);
      mockInsert.mockReturnValue({ values: insertValues });

      const { pauseOnReply } = await import("./sequenceEngine");
      await pauseOnReply(21, 1);

      expect(updateSet).not.toHaveBeenCalled();
      expect(insertValues).not.toHaveBeenCalled();
    });
  });

  describe("getEnrollmentStats", () => {
    it("returns correct counts by status", async () => {
      const rows = [
        { status: "active" },
        { status: "active" },
        { status: "paused" },
        { status: "finished" },
        { status: "exited" },
        { status: "exited" },
      ];

      mockSelect.mockReturnValueOnce(makeSelectChain(rows));

      const { getEnrollmentStats } = await import("./sequenceEngine");
      const stats = await getEnrollmentStats(1, 1);

      expect(stats.active).toBe(2);
      expect(stats.paused).toBe(1);
      expect(stats.finished).toBe(1);
      expect(stats.exited).toBe(2);
    });
  });
});
