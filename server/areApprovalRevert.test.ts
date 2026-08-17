/**
 * Approval must be reversible, and the record of it must be durable.
 *
 * 2026-08-16/17: 152 prospects were bulk-approved from the owner's session on
 * an instruction the owner did not intend as an approval. Unwinding it found
 * two gaps: there was no path from `approved` back to `pending` (only reject
 * and cancel, both of which mean something else), and the single `approve`
 * proc re-stamped approvedAt on rows that were already approved — a repair
 * pass had just done that to 141 rows, so when the owner asked "who approved
 * these and when", the timestamps that would have answered were gone.
 *
 * Source assertions; the router needs a live DB.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(join(__dirname, "routers/are/prospects.ts"), "utf8");
const proc = (name: string, next: string) => {
  const a = src.indexOf(`  ${name}: workspaceProcedure`);
  const b = src.indexOf(next, a + 1);
  return { a, b, text: src.slice(a, b) };
};

describe("bulkUnapprove — the inverse of bulkApprove", () => {
  const { a, b, text } = proc("bulkUnapprove", "  /** Bulk approve a list of prospects */");

  it("exists and is bounded", () => {
    expect(a, "bulkUnapprove missing").toBeGreaterThan(-1);
    expect(b, "bulkApprove marker moved").toBeGreaterThan(a);
  });

  it("returns the row to pending and clears the approval stamp", () => {
    expect(text).toContain('sequenceStatus: "pending"');
    expect(text).toContain("approvedAt: null");
    expect(text).toContain("approvedByUserId: null");
  });

  it("skips every still-scheduled step so nothing sends", () => {
    expect(text).toMatch(/status: "skipped"[\s\S]{0,300}eq\(areExecutionQueue\.status, "scheduled"\)/);
  });

  it("does not delete the generated sequence", () => {
    // It is real work; the next approver may want it.
    expect(text).not.toMatch(/generatedSequence:\s*null/);
    expect(text).not.toContain("prospectIntelligence");
  });

  it("refuses prospects who already received a step, unless forced", () => {
    expect(text).toContain('eq(areExecutionQueue.status, "sent")');
    expect(text).toContain("refusedSent++");
    expect(text).toContain("if (!input.force)");
  });

  it("carries tenant scope at every statement", () => {
    const stmts = text.match(/\.where\(and\([\s\S]*?\)\)/g) ?? [];
    expect(stmts.length).toBeGreaterThanOrEqual(3);
    for (const s of stmts) expect(s).toMatch(/workspaceId, ctx\.workspace\.id/);
  });

  it("writes an engine log so the revert is visible in the campaign log", () => {
    expect(text).toContain('phase: "approval.revert"');
  });
});

describe("approve does not overwrite an existing approval record", () => {
  const { text } = proc("approve", "  skip: workspaceProcedure");

  it("approvedAt is COALESCEd, not unconditionally set", () => {
    expect(text).toContain("COALESCE(${prospectQueue.approvedAt}, NOW())");
    expect(text).not.toMatch(/approvedAt:\s*new Date\(\)/);
  });

  it("approvedByUserId is COALESCEd too", () => {
    expect(text).toContain("COALESCE(${prospectQueue.approvedByUserId}, ${ctx.user.id})");
  });
});

describe("bulkApprove only ever approves pending rows (already true; pinned)", () => {
  const { text } = proc("bulkApprove", "  /** Bulk reject");
  it("guards on sequenceStatus = pending", () => {
    expect(text).toContain('eq(prospectQueue.sequenceStatus, "pending")');
  });
});
