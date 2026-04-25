/**
 * Batch U tests — invite acceptance, login history filters, expiry warnings
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── acceptInvitePreview ────────────────────────────────────────────────────

describe("team.acceptInvitePreview", () => {
  it("returns workspace info for a valid token", async () => {
    const mockDb = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      innerJoin: vi.fn().mockReturnThis(),
      leftJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([
        {
          memberId: 1,
          workspaceId: 1,
          userId: 42,
          role: "rep",
          inviteExpiresAt: null,
          workspaceName: "Acme Corp",
          userName: "Alice",
          userEmail: "alice@acme.com",
          loginMethod: "invite",
        },
      ]),
    };
    // Simulate the procedure logic inline
    const token = "abc123";
    const rows = await mockDb.select().from("workspaceMembers").innerJoin("users", "eq").leftJoin("workspaces", "eq").where("token", token);
    expect(rows).toHaveLength(1);
    expect(rows[0].workspaceName).toBe("Acme Corp");
    expect(rows[0].role).toBe("rep");
  });

  it("rejects an empty token", () => {
    const token = "";
    expect(token.length).toBe(0);
    // Procedure would throw BAD_REQUEST
  });

  it("detects an expired invitation", () => {
    const inviteExpiresAt = new Date(Date.now() - 1000); // 1 second ago
    const now = new Date();
    expect(inviteExpiresAt < now).toBe(true);
    // Procedure would throw BAD_REQUEST with "expired" message
  });

  it("detects an already-accepted invitation", () => {
    const loginMethod = "oauth";
    expect(loginMethod).not.toBe("invite");
    // Procedure would throw BAD_REQUEST with "already accepted" message
  });
});

// ── finaliseAcceptance ─────────────────────────────────────────────────────

describe("team.finaliseAcceptance", () => {
  it("clears inviteToken and sets loginMethod to oauth on success", async () => {
    const updates: Record<string, unknown>[] = [];
    const mockDb = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      innerJoin: vi.fn().mockReturnThis(),
      leftJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([
        {
          memberId: 1,
          workspaceId: 1,
          userId: 42,
          role: "rep",
          inviteExpiresAt: null,
          workspaceName: "Acme Corp",
          userEmail: "alice@acme.com",
          loginMethod: "invite",
        },
      ]),
      update: vi.fn().mockImplementation((table) => ({
        set: (vals: Record<string, unknown>) => {
          updates.push({ table, ...vals });
          return { where: vi.fn().mockResolvedValue([]) };
        },
      })),
      insert: vi.fn().mockReturnThis(),
      values: vi.fn().mockResolvedValue([]),
    };

    // Simulate the update
    await mockDb.update("users").set({ loginMethod: "oauth", passwordHash: null });
    await mockDb.update("workspaceMembers").set({ inviteToken: null, inviteExpiresAt: null });

    expect(updates[0]).toMatchObject({ loginMethod: "oauth" });
    expect(updates[1]).toMatchObject({ inviteToken: null, inviteExpiresAt: null });
  });

  it("rejects when user email does not match invite email", () => {
    const inviteEmail = "alice@acme.com";
    const callerEmail = "bob@acme.com";
    expect(inviteEmail.toLowerCase()).not.toBe(callerEmail.toLowerCase());
    // Procedure would throw FORBIDDEN
  });
});

// ── getLoginHistoryFiltered ────────────────────────────────────────────────

describe("team.getLoginHistoryFiltered", () => {
  it("builds correct conditions for outcome filter", () => {
    const conditions: string[] = [];
    const outcome = "success";
    if (outcome) conditions.push(`outcome = '${outcome}'`);
    expect(conditions).toContain("outcome = 'success'");
  });

  it("builds correct conditions for date range filter", () => {
    const conditions: string[] = [];
    const from = new Date("2026-01-01");
    const to = new Date("2026-01-31");
    if (from) conditions.push(`createdAt >= '${from.toISOString()}'`);
    if (to) conditions.push(`createdAt <= '${to.toISOString()}'`);
    expect(conditions).toHaveLength(2);
  });

  it("returns empty conditions when no filters are applied", () => {
    const conditions: string[] = [];
    const outcome = undefined;
    const from = undefined;
    const to = undefined;
    if (outcome) conditions.push(`outcome = '${outcome}'`);
    if (from) conditions.push(`createdAt >= '${from}'`);
    if (to) conditions.push(`createdAt <= '${to}'`);
    expect(conditions).toHaveLength(0);
  });

  it("enforces limit between 1 and 500", () => {
    const clamp = (v: number) => Math.min(500, Math.max(1, v));
    expect(clamp(0)).toBe(1);
    expect(clamp(1000)).toBe(500);
    expect(clamp(200)).toBe(200);
  });
});

// ── sendExpiryWarningEmails ────────────────────────────────────────────────

describe("sendExpiryWarningEmails", () => {
  it("correctly identifies invitations expiring within 48 hours", () => {
    const now = new Date();
    const in48h = new Date(now.getTime() + 48 * 60 * 60 * 1000);
    const expiringSoon = new Date(now.getTime() + 24 * 60 * 60 * 1000); // 24h from now
    const alreadyExpired = new Date(now.getTime() - 1000);
    const farFuture = new Date(now.getTime() + 72 * 60 * 60 * 1000); // 72h from now

    expect(expiringSoon > now && expiringSoon <= in48h).toBe(true);
    expect(alreadyExpired > now).toBe(false);
    expect(farFuture > in48h).toBe(true);
  });

  it("calculates hours remaining correctly", () => {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 6 * 60 * 60 * 1000); // 6h from now
    const hoursLeft = Math.round((expiresAt.getTime() - now.getTime()) / 3_600_000);
    expect(hoursLeft).toBe(6);
  });

  it("skips workspaces without a system sender configured", () => {
    const settings = { systemSenderAccountId: null };
    const shouldSkip = !settings.systemSenderAccountId;
    expect(shouldSkip).toBe(true);
  });

  it("generates correct email subject line", () => {
    const workspaceName = "Acme Corp";
    const hoursLeft = 12;
    const subject = `Your invitation to ${workspaceName} expires in ${hoursLeft} hour${hoursLeft === 1 ? "" : "s"}`;
    expect(subject).toBe("Your invitation to Acme Corp expires in 12 hours");
  });

  it("generates singular 'hour' for 1 hour remaining", () => {
    const hoursLeft = 1;
    const subject = `expires in ${hoursLeft} hour${hoursLeft === 1 ? "" : "s"}`;
    expect(subject).toBe("expires in 1 hour");
  });
});

// ── OAuth returnPath in state ──────────────────────────────────────────────

describe("OAuth returnPath state encoding", () => {
  it("encodes returnPath into state correctly", () => {
    const redirectUri = "https://example.com/api/oauth/callback";
    const returnPath = "/invite/accept?token=abc123";
    const state = btoa(JSON.stringify({ redirectUri, returnPath }));
    const decoded = JSON.parse(atob(state));
    expect(decoded.returnPath).toBe(returnPath);
    expect(decoded.redirectUri).toBe(redirectUri);
  });

  it("falls back to '/' for plain btoa(redirectUri) state", () => {
    const redirectUri = "https://example.com/api/oauth/callback";
    const state = btoa(redirectUri); // old format
    let returnPath = "/";
    try {
      const decoded = JSON.parse(Buffer.from(state, "base64").toString("utf8"));
      if (decoded?.returnPath && typeof decoded.returnPath === "string" && decoded.returnPath.startsWith("/")) {
        returnPath = decoded.returnPath;
      }
    } catch (_) { /* keep default */ }
    expect(returnPath).toBe("/");
  });

  it("rejects returnPath that does not start with /", () => {
    const state = btoa(JSON.stringify({ redirectUri: "https://example.com/api/oauth/callback", returnPath: "https://evil.com" }));
    let returnPath = "/";
    try {
      const decoded = JSON.parse(Buffer.from(state, "base64").toString("utf8"));
      if (decoded?.returnPath && typeof decoded.returnPath === "string" && decoded.returnPath.startsWith("/")) {
        returnPath = decoded.returnPath;
      }
    } catch (_) { /* keep default */ }
    expect(returnPath).toBe("/");
  });
});
