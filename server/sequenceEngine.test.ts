/**
 * Sequence Execution Engine — unit tests
 *
 * Tests cover (processEnrollments is in phase1Sends.test.ts, on the SQL fake):
 *  - autoEnrollByTriggers: status_change trigger matches and enrolls
 *  - autoEnrollByTriggers: tag_applied trigger matches and enrolls
 *  - autoEnrollByTriggers: score_threshold trigger matches and enrolls
 *  - autoEnrollByTriggers: already enrolled contact is not double-enrolled
 *  - autoEnrollByTriggers: non-matching trigger does not enroll
 *  - pauseOnReply: pauses active enrollment and creates task
 *  - getEnrollmentStats: returns correct counts by status
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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
  // Needed by the email step path (A/B variant lookup + prospect-native
  // enrollments). Absent before because no test exercised that path.
  sequenceAbVariants: { sequenceId: "sequenceId", stepIndex: "stepIndex", id: "id" },
  prospects: { id: "id", email: "email" },
  // Needed by the pre-draft suppression check (unsubscribe.isSuppressed).
  // Omitting a table the engine touches does not fail loudly: the reference is
  // `undefined`, dereferencing a column throws, the engine's own try/catch
  // swallows it, and the enrollment is silently skipped — which surfaced as an
  // unrelated assertion about advancing, not as an error.
  emailSuppressions: { id: "id", workspaceId: "workspaceId", email: "email", reason: "reason" },
}));

vi.mock("drizzle-orm", () => ({
  and: (...args: any[]) => ({ type: "and", args }),
  eq: (col: any, val: any) => ({ type: "eq", col, val }),
  isNull: (col: any) => ({ type: "isNull", col }),
  // 2026-09-20: resumeDueEnrollments (the OOO snooze sweep) calls isNotNull.
  // vitest's mock proxy throws "No 'isNotNull' export is defined on the mock"
  // at the call site if it is absent, so it is listed whether or not a test in
  // this file exercises that function.
  isNotNull: (col: any) => ({ type: "isNotNull", col }),
  // Imported by the engine since 2026-10-26 (its due query and LinkedIn
  // reply pause); listed so the module mock defines every name it imports.
  asc: (col: any) => ({ type: "asc", col }),
  inArray: (col: any, vals: any[]) => ({ type: "inArray", col, vals }),
  notInArray: (col: any, vals: any[]) => ({ type: "notInArray", col, vals }),
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
    // clearAllMocks does NOT drain mockReturnValueOnce queues, so any value a
    // test queued but didn't consume leaks into the next test and shifts every
    // subsequent select. mockSelect has no default implementation, so a full
    // reset is safe here and makes the suite order-independent.
    mockSelect.mockReset();
  });

  // processEnrollments' tests moved to phase1Sends.test.ts on 2026-10-26
  // (audit 2026-10-20, Phase 1). The engine now claims each step with a
  // conditional UPDATE, reads its page through a join, and holds rows instead
  // of skipping them; a queued chain of mocked selects can check none of
  // that, so they run against __fakes__/sqlFakeDb, which evaluates the SQL.
  // Every guarantee these tests held is held there ("the engine's older
  // guarantees, on the real query").

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

    it("auto-enrolls a LEAD on status_change (leads are what have a status)", async () => {
      // The event type originally accepted only contactId for status_change,
      // but `contacts` has no status column — `leads.status` is the field that
      // actually moves (new -> working -> qualified). The trigger therefore had
      // no entity it could legitimately fire for, which is part of why nothing
      // ever called it. crm.leads.update now fires this on a status change.
      const sequence = {
        id: 11, workspaceId: 1, status: "active",
        enrollmentTrigger: [{ type: "status_change", value: "qualified" }],
      };
      mockSelect.mockReturnValueOnce(makeSelectChain([sequence])); // active sequences
      mockSelect.mockReturnValueOnce(makeSelectChain([]));          // no existing enrollment

      const insertValues = vi.fn().mockResolvedValue(undefined);
      mockInsert.mockReturnValue({ values: insertValues });

      const { autoEnrollByTriggers } = await import("./sequenceEngine");
      await autoEnrollByTriggers({
        kind: "status_change",
        workspaceId: 1,
        leadId: 42,
        newStatus: "qualified",
      });

      expect(insertValues).toHaveBeenCalledWith(
        expect.objectContaining({ sequenceId: 11, leadId: 42, status: "active" }),
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

      // 2026-09-20: pauseOnReply now also clears resumeAt, because a human
      // pausing on a live conversation must override an OOO snooze already
      // stamped on the row rather than queue behind it (migration 0181).
      expect(updateSet).toHaveBeenCalledWith({ status: "paused", resumeAt: null });
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

  describe("the step-type chain terminates in a WRITING else", () => {
    // Source pin, not a behaviour test: the behaviour tests above can only
    // reach this through the mocked db, and a refactor that reorders the
    // chain could reintroduce a silent fall-through without failing them.
    const src = readFileSync(join(__dirname, "sequenceEngine.ts"), "utf8");

    it("the last arm advances the enrollment and names the step type", () => {
      // Since 2026-10-26 every branch ends in `continue`, so the terminal arm
      // is the code after the last one rather than an `else`; it advances
      // through the same conditional claim every step uses, and finishing
      // happens at the top once currentStep runs past the last step.
      const li = src.indexOf('if (step.type === "linkedin_dm" || step.type === "linkedin_invite") {');
      const terminal = src.indexOf("unsupported step type", li);
      expect(li).toBeGreaterThan(-1);
      expect(terminal).toBeGreaterThan(li);
      expect(src.slice(terminal, terminal + 400)).toContain("if (await claimNow()) processed++;");
      expect(src).toMatch(/const claim = async[\s\S]{0,200}currentStep: nextStepIndex/);
      expect(src).toMatch(/stepIndex >= steps\.length[\s\S]{0,300}status: "finished"/);
    });

    it("all four known branches still exist", () => {
      // Guarding the guard: deleting the named branches would make the
      // terminal else trivially "cover" everything.
      for (const branch of [
        'step.type === "email"',
        'step.type === "wait"',
        'step.type === "task"',
        'step.type === "linkedin_dm"',
      ]) {
        expect(src, branch).toContain(branch);
      }
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
