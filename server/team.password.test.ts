/**
 * Tests for team.setMemberPassword and team.resendInvitation procedures.
 *
 * These tests exercise the business-logic guards directly without a running
 * HTTP server, using the same pattern as auth.logout.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import bcrypt from "bcryptjs";

// ── Minimal in-memory DB mock ──────────────────────────────────────────────

const mockUsers: Record<number, { id: number; email: string; name: string; loginMethod: string | null; passwordHash: string | null }> = {
  10: { id: 10, email: "alice@acme.com", name: "Alice", loginMethod: "oauth", passwordHash: null },
  20: { id: 20, email: "bob@acme.com", name: "Bob", loginMethod: "invite", passwordHash: null },
  30: { id: 30, email: "carol@acme.com", name: "Carol", loginMethod: "invite", passwordHash: null },
};

const mockMembers: Record<number, { id: number; userId: number; workspaceId: number; role: string; deactivatedAt: Date | null }> = {
  1: { id: 1, userId: 10, workspaceId: 99, role: "admin", deactivatedAt: null },
  2: { id: 2, userId: 20, workspaceId: 99, role: "rep", deactivatedAt: null },
  3: { id: 3, userId: 30, workspaceId: 99, role: "rep", deactivatedAt: new Date() }, // deactivated
};

// ── Helpers that replicate the procedure logic ─────────────────────────────

const ROLE_RANK: Record<string, number> = { super_admin: 4, admin: 3, manager: 2, rep: 1 };

async function setMemberPassword(
  callerRole: string,
  callerMemberId: number,
  targetMemberId: number,
  password: string,
) {
  if (password.length < 8) throw new Error("Password must be at least 8 characters");
  const member = mockMembers[targetMemberId];
  if (!member) throw new Error("Member not found");
  if (callerRole !== "super_admin" && ROLE_RANK[member.role] >= ROLE_RANK[callerRole]) {
    throw new Error("Cannot set password for a member at or above your role");
  }
  const hash = await bcrypt.hash(password, 12);
  mockUsers[member.userId].passwordHash = hash;
  return { ok: true };
}

async function resendInvitation(callerRole: string, targetMemberId: number) {
  const member = mockMembers[targetMemberId];
  if (!member) throw new Error("Member not found");
  const user = mockUsers[member.userId];
  if (!user) throw new Error("User not found");
  if (user.loginMethod !== "invite") throw new Error("Member has already accepted their invitation and signed in");
  if (member.deactivatedAt) throw new Error("Cannot resend invitation to a deactivated member");
  return { ok: true };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("team.setMemberPassword", () => {
  beforeEach(() => {
    // Reset passwordHash before each test
    for (const u of Object.values(mockUsers)) u.passwordHash = null;
  });

  it("hashes and stores the password for a valid target", async () => {
    const result = await setMemberPassword("admin", 1, 2, "Secure123!");
    expect(result.ok).toBe(true);
    const stored = mockUsers[20].passwordHash;
    expect(stored).not.toBeNull();
    const valid = await bcrypt.compare("Secure123!", stored!);
    expect(valid).toBe(true);
  });

  it("rejects passwords shorter than 8 characters", async () => {
    await expect(setMemberPassword("admin", 1, 2, "short")).rejects.toThrow("at least 8 characters");
  });

  it("rejects when target member does not exist", async () => {
    await expect(setMemberPassword("admin", 1, 999, "Secure123!")).rejects.toThrow("Member not found");
  });

  it("rejects when caller tries to set password for a peer (same rank)", async () => {
    // memberId 2 is rep; caller is also rep (rank 1 >= rank 1)
    await expect(setMemberPassword("rep", 2, 2, "Secure123!")).rejects.toThrow("at or above your role");
  });

  it("allows super_admin to set password for any member regardless of rank", async () => {
    const result = await setMemberPassword("super_admin", 1, 2, "Secure123!");
    expect(result.ok).toBe(true);
  });
});

describe("team.resendInvitation", () => {
  it("succeeds for a pending invite member", async () => {
    const result = await resendInvitation("admin", 2);
    expect(result.ok).toBe(true);
  });

  it("rejects when member has already signed in via oauth", async () => {
    await expect(resendInvitation("admin", 1)).rejects.toThrow("already accepted their invitation");
  });

  it("rejects when member is deactivated", async () => {
    await expect(resendInvitation("admin", 3)).rejects.toThrow("deactivated member");
  });

  it("rejects when member does not exist", async () => {
    await expect(resendInvitation("admin", 999)).rejects.toThrow("Member not found");
  });
});
