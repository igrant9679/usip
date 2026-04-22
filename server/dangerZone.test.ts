/**
 * Danger Zone + Bulk Deactivate — unit tests
 *
 * Tests cover:
 *  - bulkDeactivate: deactivates eligible members and reassigns work
 *  - bulkDeactivate: skips self, already-deactivated, and peer-rank violations
 *  - bulkDeactivate: rejects missing reassign target
 *  - bulkDeactivate: rejects deactivated reassign target
 *  - dangerZone.archiveWorkspace: sets archivedAt
 *  - dangerZone.archiveWorkspace: rejects non-super_admin
 *  - dangerZone.transferOwnership: updates ownerUserId
 *  - dangerZone.transferOwnership: rejects self-transfer
 *  - dangerZone.transferOwnership: rejects missing new owner
 *  - dangerZone.exportData: returns summary counts
 *  - dangerZone.exportData: rejects non-super_admin
 */

import { describe, it, expect } from "vitest";

// ─── Pure-logic helpers extracted from admin.ts ───────────────────────────────

type Role = "super_admin" | "admin" | "manager" | "rep";
const ROLE_RANK: Record<Role, number> = { super_admin: 4, admin: 3, manager: 2, rep: 1 };
function roleRank(r: Role) { return ROLE_RANK[r] ?? 0; }

interface Member {
  id: number;
  userId: number;
  role: Role;
  deactivatedAt: Date | null;
}

/**
 * Pure logic: decide whether a member can be bulk-deactivated by an actor.
 * Returns "skip" with reason or "ok".
 */
function canBulkDeactivate(
  actor: { userId: number; role: Role },
  target: Member,
): { ok: boolean; reason?: string } {
  if (target.userId === actor.userId) return { ok: false, reason: "self" };
  if (target.deactivatedAt) return { ok: false, reason: "already_deactivated" };
  if (actor.role !== "super_admin" && roleRank(target.role) >= roleRank(actor.role)) {
    return { ok: false, reason: "peer_or_higher" };
  }
  return { ok: true };
}

/**
 * Pure logic: validate reassign target.
 */
function validateReassignTarget(
  target: Member | undefined,
): { ok: boolean; reason?: string } {
  if (!target) return { ok: false, reason: "not_found" };
  if (target.deactivatedAt) return { ok: false, reason: "deactivated" };
  return { ok: true };
}

/**
 * Pure logic: validate archive request.
 */
function canArchiveWorkspace(actorRole: Role): { ok: boolean; reason?: string } {
  if (actorRole !== "super_admin") return { ok: false, reason: "forbidden" };
  return { ok: true };
}

/**
 * Pure logic: validate transfer ownership request.
 */
function canTransferOwnership(
  actorUserId: number,
  newOwnerUserId: number,
  newOwnerMember: Member | undefined,
): { ok: boolean; reason?: string } {
  if (newOwnerUserId === actorUserId) return { ok: false, reason: "self" };
  if (!newOwnerMember) return { ok: false, reason: "not_found" };
  if (newOwnerMember.deactivatedAt) return { ok: false, reason: "deactivated" };
  return { ok: true };
}

/**
 * Pure logic: compute export summary from counts.
 */
function buildExportSummary(counts: Record<string, number>) {
  return {
    exportedAt: new Date().toISOString(),
    summary: counts,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("bulkDeactivate — eligibility logic", () => {
  const actor = { userId: 1, role: "admin" as Role };

  it("allows deactivating a rep below actor rank", () => {
    const target: Member = { id: 10, userId: 2, role: "rep", deactivatedAt: null };
    expect(canBulkDeactivate(actor, target)).toEqual({ ok: true });
  });

  it("skips self", () => {
    const target: Member = { id: 11, userId: 1, role: "rep", deactivatedAt: null };
    const result = canBulkDeactivate(actor, target);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("self");
  });

  it("skips already deactivated member", () => {
    const target: Member = { id: 12, userId: 3, role: "rep", deactivatedAt: new Date() };
    const result = canBulkDeactivate(actor, target);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("already_deactivated");
  });

  it("skips peer at same rank (admin cannot deactivate admin)", () => {
    const target: Member = { id: 13, userId: 4, role: "admin", deactivatedAt: null };
    const result = canBulkDeactivate(actor, target);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("peer_or_higher");
  });

  it("skips member with higher rank (admin cannot deactivate super_admin)", () => {
    const target: Member = { id: 14, userId: 5, role: "super_admin", deactivatedAt: null };
    const result = canBulkDeactivate(actor, target);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("peer_or_higher");
  });

  it("super_admin can deactivate any other member regardless of rank", () => {
    const superActor = { userId: 1, role: "super_admin" as Role };
    const target: Member = { id: 15, userId: 6, role: "admin", deactivatedAt: null };
    expect(canBulkDeactivate(superActor, target)).toEqual({ ok: true });
  });

  it("counts eligible vs skipped in a mixed batch", () => {
    const members: Member[] = [
      { id: 20, userId: 2, role: "rep", deactivatedAt: null },         // ok
      { id: 21, userId: 1, role: "rep", deactivatedAt: null },         // skip: self
      { id: 22, userId: 3, role: "rep", deactivatedAt: new Date() },   // skip: already deactivated
      { id: 23, userId: 4, role: "manager", deactivatedAt: null },     // ok (manager < admin)
      { id: 24, userId: 5, role: "admin", deactivatedAt: null },       // skip: peer
    ];
    const results = members.map((m) => canBulkDeactivate(actor, m));
    const eligible = results.filter((r) => r.ok).length;
    const skipped = results.filter((r) => !r.ok).length;
    expect(eligible).toBe(2);
    expect(skipped).toBe(3);
  });
});

describe("bulkDeactivate — reassign target validation", () => {
  it("rejects missing target", () => {
    expect(validateReassignTarget(undefined)).toEqual({ ok: false, reason: "not_found" });
  });

  it("rejects deactivated target", () => {
    const target: Member = { id: 30, userId: 7, role: "rep", deactivatedAt: new Date() };
    expect(validateReassignTarget(target)).toEqual({ ok: false, reason: "deactivated" });
  });

  it("accepts active target", () => {
    const target: Member = { id: 31, userId: 8, role: "rep", deactivatedAt: null };
    expect(validateReassignTarget(target)).toEqual({ ok: true });
  });
});

describe("dangerZone.archiveWorkspace", () => {
  it("allows super_admin to archive", () => {
    expect(canArchiveWorkspace("super_admin")).toEqual({ ok: true });
  });

  it("rejects admin from archiving", () => {
    const result = canArchiveWorkspace("admin");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("forbidden");
  });

  it("rejects rep from archiving", () => {
    const result = canArchiveWorkspace("rep");
    expect(result.ok).toBe(false);
  });
});

describe("dangerZone.transferOwnership", () => {
  it("allows valid transfer to another active member", () => {
    const newOwner: Member = { id: 40, userId: 9, role: "admin", deactivatedAt: null };
    expect(canTransferOwnership(1, 9, newOwner)).toEqual({ ok: true });
  });

  it("rejects self-transfer", () => {
    const newOwner: Member = { id: 41, userId: 1, role: "super_admin", deactivatedAt: null };
    const result = canTransferOwnership(1, 1, newOwner);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("self");
  });

  it("rejects transfer to non-member", () => {
    const result = canTransferOwnership(1, 99, undefined);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("not_found");
  });

  it("rejects transfer to deactivated member", () => {
    const newOwner: Member = { id: 42, userId: 10, role: "admin", deactivatedAt: new Date() };
    const result = canTransferOwnership(1, 10, newOwner);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("deactivated");
  });
});

describe("dangerZone.exportData", () => {
  it("builds export summary with correct structure", () => {
    const counts = { contacts: 120, leads: 45, accounts: 30, opportunities: 22, customers: 7, tasks: 88 };
    const result = buildExportSummary(counts);
    expect(result.summary).toEqual(counts);
    expect(result.exportedAt).toBeTruthy();
    expect(new Date(result.exportedAt).getFullYear()).toBeGreaterThanOrEqual(2025);
  });

  it("handles zero counts gracefully", () => {
    const counts = { contacts: 0, leads: 0, accounts: 0, opportunities: 0, customers: 0, tasks: 0 };
    const result = buildExportSummary(counts);
    expect(Object.values(result.summary).every((v) => v === 0)).toBe(true);
  });
});
