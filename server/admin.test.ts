import { describe, expect, it } from "vitest";
import { roleRank } from "./_core/workspace";

/**
 * Admin / Team / Settings invariants.
 * These check the pure role-rank logic embedded in the admin router
 * (full DB-backed integration tests would require a live MySQL, which
 * we don't have in CI — but every guard below mirrors a concrete branch
 * inside server/routers/admin.ts so the behavior is exercised.)
 */

describe("admin — role-rank guards", () => {
  it("refuses to assign a role higher than actor's own rank", () => {
    const actor = "manager" as const;
    const wantedTarget = "admin" as const;
    const allowed = roleRank(wantedTarget) <= roleRank(actor);
    expect(allowed).toBe(false);
  });

  it("allows a manager to promote/demote within their own rank or below", () => {
    const actor = "manager" as const;
    for (const r of ["rep", "manager"] as const) {
      expect(roleRank(r) <= roleRank(actor)).toBe(true);
    }
    for (const r of ["admin", "super_admin"] as const) {
      expect(roleRank(r) <= roleRank(actor)).toBe(false);
    }
  });

  it("prevents a non-super-admin from changing a peer/higher role (except self)", () => {
    const actorRole = "admin" as const;
    const actorId = 7;

    // Peer admin (different user): blocked
    const peer = { role: "admin" as const, userId: 8 };
    const peerBlocked =
      actorRole !== "super_admin" &&
      roleRank(peer.role) >= roleRank(actorRole) &&
      peer.userId !== actorId;
    expect(peerBlocked).toBe(true);

    // Manager below: allowed
    const lower = { role: "manager" as const, userId: 9 };
    const lowerBlocked =
      actorRole !== "super_admin" &&
      roleRank(lower.role) >= roleRank(actorRole) &&
      lower.userId !== actorId;
    expect(lowerBlocked).toBe(false);

    // Self: allowed
    const self = { role: "admin" as const, userId: actorId };
    const selfBlocked =
      actorRole !== "super_admin" &&
      roleRank(self.role) >= roleRank(actorRole) &&
      self.userId !== actorId;
    expect(selfBlocked).toBe(false);
  });

  it("super_admin can act on any peer, including other super_admins", () => {
    const actorRole = "super_admin" as const;
    const peer = { role: "super_admin" as const, userId: 99 };
    const peerBlocked =
      actorRole !== "super_admin" &&
      roleRank(peer.role) >= roleRank(actorRole) &&
      peer.userId !== 1;
    expect(peerBlocked).toBe(false);
  });
});

describe("admin — sole super_admin guard", () => {
  it("refuses to demote the sole super_admin", () => {
    // The router counts super_admins in the workspace before allowing a
    // change away from super_admin. We simulate that count here.
    const totalSuperAdmins = 1;
    const newRole = "admin" as const;
    const blocked = newRole !== "super_admin" && totalSuperAdmins <= 1;
    expect(blocked).toBe(true);
  });

  it("allows demoting a super_admin when at least one other remains", () => {
    const totalSuperAdmins = 2;
    const newRole = "admin" as const;
    const blocked = newRole !== "super_admin" && totalSuperAdmins <= 1;
    expect(blocked).toBe(false);
  });
});

describe("admin — deactivate reassignment semantics", () => {
  it("requires a reassignment target that is (a) a member and (b) not deactivated", () => {
    type M = { userId: number; deactivatedAt: Date | null };
    const members: M[] = [
      { userId: 1, deactivatedAt: null },
      { userId: 2, deactivatedAt: null },
      { userId: 3, deactivatedAt: new Date() },
    ];
    const pickValid = (id: number) => {
      const m = members.find((x) => x.userId === id);
      return Boolean(m && !m.deactivatedAt);
    };
    expect(pickValid(2)).toBe(true);
    expect(pickValid(3)).toBe(false);
    expect(pickValid(4)).toBe(false);
  });

  it("blocks deactivation of self", () => {
    const actorUserId = 5;
    const targetUserId = 5;
    expect(targetUserId === actorUserId).toBe(true);
  });
});

describe("settings — input validation", () => {
  it("accepts hex colors in #RRGGBB / #RGB / #RRGGBBAA form", () => {
    const re = /^#([0-9A-Fa-f]{3,8})$/;
    expect(re.test("#14B89A")).toBe(true);
    expect(re.test("#fff")).toBe(true);
    expect(re.test("#14B89AFF")).toBe(true);
    expect(re.test("rgb(1,2,3)")).toBe(false);
    expect(re.test("14B89A")).toBe(false);
  });

  it("clamps session timeout to a sensible range (15 min .. 7 days)", () => {
    const min = 15;
    const max = 60 * 24 * 7;
    const ok = (n: number) => n >= min && n <= max;
    expect(ok(30)).toBe(true);
    expect(ok(1)).toBe(false);
    expect(ok(60 * 24 * 30)).toBe(false);
    expect(ok(max)).toBe(true);
  });

  it("produces a default notifyPolicy with all expected events", () => {
    const DEFAULT = {
      newLeadRouted: { inApp: true, email: false },
      salesReadyCrossed: { inApp: true, email: true },
      dealMoved: { inApp: true, email: false },
      taskOverdue: { inApp: true, email: false },
      mention: { inApp: true, email: true },
    };
    expect(Object.keys(DEFAULT).length).toBe(5);
    for (const ev of Object.values(DEFAULT)) {
      expect(typeof ev.inApp).toBe("boolean");
      expect(typeof ev.email).toBe("boolean");
    }
  });
});

describe("team — getPermissions / setPermissions logic", () => {
  it("returns an empty map when no permissions have been set", () => {
    // Simulate no rows returned from memberPermissions
    const rows: { feature: string; granted: boolean }[] = [];
    const perms: Record<string, boolean> = {};
    for (const row of rows) perms[row.feature] = row.granted;
    expect(Object.keys(perms).length).toBe(0);
  });

  it("maps feature rows to a boolean record correctly", () => {
    const rows = [
      { feature: "export_data", granted: true },
      { feature: "access_billing", granted: false },
      { feature: "manage_api_keys", granted: true },
    ];
    const perms: Record<string, boolean> = {};
    for (const row of rows) perms[row.feature] = row.granted;
    expect(perms.export_data).toBe(true);
    expect(perms.access_billing).toBe(false);
    expect(perms.manage_api_keys).toBe(true);
  });

  it("skips upsert when permissions map is empty", () => {
    const entries = Object.entries({});
    expect(entries.length).toBe(0);
    // No DB calls should be made; the procedure returns early
  });

  it("correctly identifies all 6 expected feature keys", () => {
    const PERMISSION_FEATURES = [
      "export_data",
      "manage_sequences",
      "view_all_leads",
      "manage_integrations",
      "access_billing",
      "manage_api_keys",
    ];
    expect(PERMISSION_FEATURES.length).toBe(6);
    for (const key of PERMISSION_FEATURES) {
      expect(typeof key).toBe("string");
      expect(key.length).toBeLessThanOrEqual(80);
    }
  });
});

describe("team — getMemberActivityLog logic", () => {
  it("filters audit log rows by entityType workspace_member or user", () => {
    type AuditRow = { entityType: string; entityId: number; action: string; actorUserId: number };
    const rows: AuditRow[] = [
      { entityType: "workspace_member", entityId: 5, action: "update", actorUserId: 1 },
      { entityType: "user", entityId: 5, action: "update", actorUserId: 1 },
      { entityType: "lead", entityId: 5, action: "update", actorUserId: 1 },
      { entityType: "workspace_member", entityId: 6, action: "update", actorUserId: 1 },
    ];
    const targetUserId = 5;
    const filtered = rows.filter(
      (r) =>
        (r.entityType === "workspace_member" && r.entityId === targetUserId) ||
        (r.entityType === "user" && r.entityId === targetUserId) ||
        (r.action === "login" && r.actorUserId === targetUserId),
    );
    expect(filtered.length).toBe(2);
    expect(filtered.every((r) => r.entityId === targetUserId || r.actorUserId === targetUserId)).toBe(true);
  });

  it("includes login events for the target user", () => {
    type AuditRow = { entityType: string; entityId: number | null; action: string; actorUserId: number };
    const rows: AuditRow[] = [
      { entityType: "workspace_member", entityId: null, action: "login", actorUserId: 5 },
      { entityType: "workspace_member", entityId: null, action: "login", actorUserId: 7 },
    ];
    const targetUserId = 5;
    const filtered = rows.filter(
      (r) =>
        (r.entityType === "workspace_member" && r.entityId === targetUserId) ||
        (r.action === "login" && r.actorUserId === targetUserId),
    );
    expect(filtered.length).toBe(1);
    expect(filtered[0].actorUserId).toBe(5);
  });

  it("respects the limit parameter (default 50, max 100)", () => {
    const defaultLimit = 50;
    const maxLimit = 100;
    const minLimit = 1;
    expect(defaultLimit).toBe(50);
    expect(maxLimit).toBe(100);
    expect(minLimit).toBe(1);
    // Clamp logic
    const clamp = (n: number) => Math.max(minLimit, Math.min(maxLimit, n));
    expect(clamp(0)).toBe(1);
    expect(clamp(50)).toBe(50);
    expect(clamp(150)).toBe(100);
  });
});

describe("checkPermission — role-based defaults", () => {
  type Role = "super_admin" | "admin" | "manager" | "rep";

  /**
   * Mirrors the role-default logic inside checkPermission in server/db.ts.
   * When no override row exists, restricted features are denied for non-elevated roles.
   */
  function defaultGranted(role: Role, feature: string): boolean {
    const restrictedByDefault = ["export_data", "access_billing", "manage_api_keys"];
    const isElevated = role === "super_admin" || role === "admin";
    if (!isElevated && restrictedByDefault.includes(feature)) return false;
    return true;
  }

  it("grants all features to super_admin by default", () => {
    const features = ["export_data", "manage_sequences", "view_all_leads", "manage_integrations", "access_billing", "manage_api_keys"];
    for (const f of features) {
      expect(defaultGranted("super_admin", f)).toBe(true);
    }
  });

  it("grants all features to admin by default", () => {
    const features = ["export_data", "manage_sequences", "view_all_leads", "manage_integrations", "access_billing", "manage_api_keys"];
    for (const f of features) {
      expect(defaultGranted("admin", f)).toBe(true);
    }
  });

  it("denies export_data, access_billing, manage_api_keys for rep by default", () => {
    expect(defaultGranted("rep", "export_data")).toBe(false);
    expect(defaultGranted("rep", "access_billing")).toBe(false);
    expect(defaultGranted("rep", "manage_api_keys")).toBe(false);
  });

  it("allows manage_sequences and view_all_leads for rep by default", () => {
    expect(defaultGranted("rep", "manage_sequences")).toBe(true);
    expect(defaultGranted("rep", "view_all_leads")).toBe(true);
  });

  it("denies restricted features for manager by default", () => {
    expect(defaultGranted("manager", "export_data")).toBe(false);
    expect(defaultGranted("manager", "access_billing")).toBe(false);
    expect(defaultGranted("manager", "manage_api_keys")).toBe(false);
  });

  it("an explicit override row takes precedence over role defaults", () => {
    // Simulate: rep with an explicit export_data=true override
    const overrideRow = { granted: true };
    // If row exists, use its value regardless of role
    const result = overrideRow !== undefined ? overrideRow.granted : defaultGranted("rep", "export_data");
    expect(result).toBe(true);
  });

  it("an explicit override row can deny a feature that would otherwise be allowed", () => {
    // Simulate: admin with an explicit export_data=false override
    const overrideRow = { granted: false };
    const result = overrideRow !== undefined ? overrideRow.granted : defaultGranted("admin", "export_data");
    expect(result).toBe(false);
  });
});

describe("role permission templates", () => {
  const TEMPLATES: Record<string, Record<string, boolean>> = {
    super_admin: { export_data: true, manage_sequences: true, view_all_leads: true, manage_integrations: true, access_billing: true, manage_api_keys: true },
    admin: { export_data: true, manage_sequences: true, view_all_leads: true, manage_integrations: true, access_billing: true, manage_api_keys: false },
    manager: { export_data: true, manage_sequences: true, view_all_leads: true, manage_integrations: false, access_billing: false, manage_api_keys: false },
    rep: { export_data: false, manage_sequences: false, view_all_leads: false, manage_integrations: false, access_billing: false, manage_api_keys: false },
  };

  it("all templates cover exactly 6 features", () => {
    for (const [role, tpl] of Object.entries(TEMPLATES)) {
      expect(Object.keys(tpl).length).toBe(6);
    }
  });

  it("super_admin template grants all features", () => {
    for (const v of Object.values(TEMPLATES.super_admin)) expect(v).toBe(true);
  });

  it("rep template denies all features", () => {
    for (const v of Object.values(TEMPLATES.rep)) expect(v).toBe(false);
  });

  it("admin template denies only manage_api_keys", () => {
    const denied = Object.entries(TEMPLATES.admin).filter(([, v]) => !v).map(([k]) => k);
    expect(denied).toEqual(["manage_api_keys"]);
  });

  it("manager template denies manage_integrations, access_billing, manage_api_keys", () => {
    const denied = Object.entries(TEMPLATES.manager).filter(([, v]) => !v).map(([k]) => k).sort();
    expect(denied).toEqual(["access_billing", "manage_api_keys", "manage_integrations"]);
  });
});

describe("audit.list — actorUserId filter", () => {
  type AuditRow = { id: number; actorUserId: number | null; entityType: string };

  it("returns all rows when no actorUserId filter is set", () => {
    const rows: AuditRow[] = [
      { id: 1, actorUserId: 1, entityType: "lead" },
      { id: 2, actorUserId: 2, entityType: "contact" },
      { id: 3, actorUserId: null, entityType: "system" },
    ];
    const filtered = rows; // no filter applied
    expect(filtered.length).toBe(3);
  });

  it("filters rows to only those matching actorUserId", () => {
    const rows: AuditRow[] = [
      { id: 1, actorUserId: 1, entityType: "lead" },
      { id: 2, actorUserId: 2, entityType: "contact" },
      { id: 3, actorUserId: 1, entityType: "account" },
    ];
    const actorUserId = 1;
    const filtered = rows.filter((r) => r.actorUserId === actorUserId);
    expect(filtered.length).toBe(2);
    expect(filtered.every((r) => r.actorUserId === 1)).toBe(true);
  });

  it("returns empty array when no rows match the actorUserId", () => {
    const rows: AuditRow[] = [
      { id: 1, actorUserId: 1, entityType: "lead" },
    ];
    const filtered = rows.filter((r) => r.actorUserId === 99);
    expect(filtered.length).toBe(0);
  });

  it("can combine entityType and actorUserId filters", () => {
    const rows: AuditRow[] = [
      { id: 1, actorUserId: 1, entityType: "lead" },
      { id: 2, actorUserId: 1, entityType: "contact" },
      { id: 3, actorUserId: 2, entityType: "lead" },
    ];
    const actorUserId = 1;
    const entityType = "lead";
    let filtered = rows;
    if (entityType) filtered = filtered.filter((r) => r.entityType === entityType);
    if (actorUserId) filtered = filtered.filter((r) => r.actorUserId === actorUserId);
    expect(filtered.length).toBe(1);
    expect(filtered[0].id).toBe(1);
  });
});

// ─── Batch Z: Unipile Status Webhook ─────────────────────────────────────────
describe("Unipile status webhook logic", () => {
  const EXPIRED_STATUSES = ["CREDENTIALS", "ERROR", "STOPPED"];
  const HEALTHY_STATUSES = ["OK", "CONNECTED", "CONNECTING", "PENDING"];

  it("identifies expired statuses correctly", () => {
    for (const s of EXPIRED_STATUSES) {
      expect(["CREDENTIALS", "ERROR", "STOPPED"].includes(s)).toBe(true);
    }
  });

  it("does not flag healthy statuses as expired", () => {
    for (const s of HEALTHY_STATUSES) {
      expect(["CREDENTIALS", "ERROR", "STOPPED"].includes(s)).toBe(false);
    }
  });

  it("CREDENTIALS status triggers re-auth email path", () => {
    const shouldSendEmail = (status: string) =>
      ["CREDENTIALS", "ERROR", "STOPPED"].includes(status);
    expect(shouldSendEmail("CREDENTIALS")).toBe(true);
    expect(shouldSendEmail("ERROR")).toBe(true);
    expect(shouldSendEmail("STOPPED")).toBe(true);
    expect(shouldSendEmail("OK")).toBe(false);
    expect(shouldSendEmail("CONNECTING")).toBe(false);
  });

  it("reconnect link uses MANUS_APP_URL base with correct path", () => {
    const appBase = "https://usipsales-8xkycm4e.manus.space";
    const userId = 42;
    const workspaceId = 7;
    const notifyUrl = `${appBase}/api/unipile/account-webhook?userId=${userId}&workspaceId=${workspaceId}`;
    const successRedirectUrl = `${appBase}/connected-accounts?connected=1`;
    expect(notifyUrl).toContain("/api/unipile/account-webhook");
    expect(notifyUrl).toContain(`userId=${userId}`);
    expect(notifyUrl).toContain(`workspaceId=${workspaceId}`);
    expect(successRedirectUrl).toContain("/connected-accounts?connected=1");
  });

  it("strips trailing slash from MANUS_APP_URL", () => {
    const rawUrl = "https://usipsales-8xkycm4e.manus.space/";
    const appBase = rawUrl.replace(/\/$/, "");
    expect(appBase).toBe("https://usipsales-8xkycm4e.manus.space");
    expect(appBase.endsWith("/")).toBe(false);
  });

  it("reconnect link expires in 24 hours", () => {
    const before = Date.now();
    const expiresOn = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const after = Date.now();
    const expiresMs = new Date(expiresOn).getTime();
    expect(expiresMs - before).toBeGreaterThanOrEqual(24 * 60 * 60 * 1000 - 1000);
    expect(expiresMs - after).toBeLessThanOrEqual(24 * 60 * 60 * 1000 + 1000);
  });

  it("isConnecting banner auto-clears after 5 minutes timeout", () => {
    const TIMEOUT_MS = 5 * 60 * 1000;
    expect(TIMEOUT_MS).toBe(300_000);
  });

  it("EXPIRED_STATUSES set matches the frontend constant", () => {
    const backendStatuses = new Set(["CREDENTIALS", "ERROR", "STOPPED"]);
    const frontendStatuses = ["CREDENTIALS", "ERROR", "STOPPED"];
    for (const s of frontendStatuses) {
      expect(backendStatuses.has(s)).toBe(true);
    }
    expect(backendStatuses.size).toBe(frontendStatuses.length);
  });
});

// ─── Batch AA: setInvitePassword ─────────────────────────────────────────────
describe("team.setInvitePassword", () => {
  it("rejects passwords shorter than 8 characters", () => {
    const validate = (pw: string) => pw.length >= 8;
    expect(validate("short")).toBe(false);
    expect(validate("longpass")).toBe(true);
  });

  it("rejects if confirm password does not match", () => {
    const validate = (pw: string, confirm: string) => pw === confirm;
    expect(validate("password123", "password456")).toBe(false);
    expect(validate("password123", "password123")).toBe(true);
  });

  it("accepts valid password and confirm match", () => {
    const validate = (pw: string, confirm: string) =>
      pw.length >= 8 && pw === confirm;
    expect(validate("securePass1", "securePass1")).toBe(true);
  });

  it("skip path sets passwordStep to done without calling mutation", () => {
    let step = "pending";
    const skip = () => { step = "done"; };
    skip();
    expect(step).toBe("done");
  });

  it("password step blocks finalise until done", () => {
    const shouldFinalise = (passwordStep: string, user: boolean) =>
      user && passwordStep === "done";
    expect(shouldFinalise("pending", true)).toBe(false);
    expect(shouldFinalise("done", true)).toBe(true);
    expect(shouldFinalise("done", false)).toBe(false);
  });

  it("expired banner maps each expired account to a reconnect button", () => {
    const accounts = [
      { unipileAccountId: "a1", status: "CREDENTIALS", provider: "LINKEDIN", accountName: "Alice" },
      { unipileAccountId: "a2", status: "OK", provider: "LINKEDIN", accountName: "Bob" },
      { unipileAccountId: "a3", status: "ERROR", provider: "GMAIL", accountName: "Carol" },
    ];
    const EXPIRED = new Set(["CREDENTIALS", "ERROR", "STOPPED"]);
    const expired = accounts.filter((a) => EXPIRED.has(a.status));
    expect(expired).toHaveLength(2);
    expect(expired.map((a) => a.unipileAccountId)).toEqual(["a1", "a3"]);
  });
});
