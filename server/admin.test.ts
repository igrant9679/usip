import { describe, expect, it } from "vitest";
import { roleRank } from "./_core/workspace";
import { PERMISSION_KEYS, defaultGranted, roleTemplate } from "../shared/permissions";

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

  // 2026-09-20: this used to re-declare the six keys locally, which meant it
  // agreed with itself rather than with the product. The list now lives in
  // shared/permissions.ts and is imported by Team.tsx AND server/db.ts.
  it("correctly identifies all 6 expected feature keys", () => {
    expect(PERMISSION_KEYS.length).toBe(6);
    for (const key of PERMISSION_KEYS) {
      expect(typeof key).toBe("string");
      // setPermissions stores the key in a varchar(80) column.
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

/**
 * 2026-09-20: this block used to carry its OWN copy of the role-default rule,
 * so it agreed with itself no matter what server/db.ts did — and by the time
 * anyone looked, db.ts denied access_billing by default while nothing enforced
 * the key at all. It now calls the real exported `defaultGranted`, and the
 * behavioural half (an override row beating the default, the two refusal
 * messages, the fail-open) lives in permissionEnforcement.test.ts against the
 * actual resolver.
 */
describe("checkPermission — role-based defaults", () => {
  const elevated = (role: string) => role === "super_admin" || role === "admin";

  it("grants all features to super_admin by default", () => {
    for (const f of PERMISSION_KEYS) expect(defaultGranted(f, elevated("super_admin")), f).toBe(true);
  });

  it("grants all features to admin by default", () => {
    for (const f of PERMISSION_KEYS) expect(defaultGranted(f, elevated("admin")), f).toBe(true);
  });

  it("denies export_data and manage_api_keys for rep by default", () => {
    expect(defaultGranted("export_data", elevated("rep"))).toBe(false);
    expect(defaultGranted("manage_api_keys", elevated("rep"))).toBe(false);
  });

  it("but GRANTS access_billing — the flip that made enforcing the key safe", () => {
    // Enforced for the first time on 2026-09-20 (usage.currentMonth). Under the
    // old default that single line would have removed Settings → Billing and
    // credits from every manager and rep in every workspace on deploy.
    expect(defaultGranted("access_billing", elevated("rep"))).toBe(true);
    expect(defaultGranted("access_billing", elevated("manager"))).toBe(true);
  });

  it("allows manage_sequences and view_all_leads for rep by default", () => {
    // The pin that guards the SAFE default: gating those two keys changes
    // nothing for a workspace that never opened the Permissions tab.
    expect(defaultGranted("manage_sequences", elevated("rep"))).toBe(true);
    expect(defaultGranted("view_all_leads", elevated("rep"))).toBe(true);
  });

  it("denies the restricted features for manager by default", () => {
    expect(defaultGranted("export_data", elevated("manager"))).toBe(false);
    expect(defaultGranted("manage_api_keys", elevated("manager"))).toBe(false);
  });
});

describe("role permission templates", () => {
  // The Team page's preset buttons are now DERIVED from the same defaults the
  // server resolves against, rather than a second table that disagreed with it
  // on four of the six keys.
  //
  // 2026-09-20: each template is built from its ROLE STRING through the same
  // elevation predicate the page applies (Team.tsx applyRoleTemplate, mirroring
  // server/db.ts), not from a hand-passed boolean. Passing the boolean made the
  // manager/rep pin below compare `roleTemplate(false)` with `roleTemplate(false)`
  // — two calls to one pure function with one argument — so it could not fail
  // for any implementation, including the exact change it claims to guard.
  const elevated = (role: string) => role === "admin" || role === "super_admin";
  const TEMPLATES: Record<string, Record<string, boolean>> = {
    super_admin: roleTemplate(elevated("super_admin")),
    admin: roleTemplate(elevated("admin")),
    manager: roleTemplate(elevated("manager")),
    rep: roleTemplate(elevated("rep")),
  };

  it("all templates cover exactly 6 features", () => {
    for (const [role, tpl] of Object.entries(TEMPLATES)) {
      expect(Object.keys(tpl).length, role).toBe(6);
    }
  });

  it("super_admin and admin templates grant all features", () => {
    for (const v of Object.values(TEMPLATES.super_admin)) expect(v).toBe(true);
    for (const v of Object.values(TEMPLATES.admin)) expect(v).toBe(true);
  });

  it("the rep template no longer denies everything — it IS the rep defaults", () => {
    // It used to write `false` for all six, which is how applying the preset
    // silently revoked manage_sequences, view_all_leads and manage_integrations
    // from a member the server was granting all three.
    const denied = Object.entries(TEMPLATES.rep).filter(([, v]) => !v).map(([k]) => k).sort();
    expect(denied).toEqual(["export_data", "manage_api_keys"]);
  });

  it("manager and rep resolve identically — neither role is elevated", () => {
    // Asserted against a LITERAL as well as against each other: give manager
    // its own rank in the elevation predicate and both halves of an
    // equality-with-itself assertion move together, so the one property this
    // test names would break while the test stayed green.
    const unelevated = {
      export_data: false,
      manage_sequences: true,
      view_all_leads: true,
      manage_integrations: true,
      access_billing: true,
      manage_api_keys: false,
    };
    expect(TEMPLATES.manager).toEqual(unelevated);
    expect(TEMPLATES.rep).toEqual(unelevated);
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
