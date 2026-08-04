/**
 * Invite acceptance, login-history filtering, expiry warnings, return paths —
 * against the REAL procedures.
 *
 * 🪞 WHAT THIS FILE USED TO BE, and it was worse than `dangerZone.test.ts`.
 * That one at least reimplemented the logic. This one built a `vi.fn()` mock,
 * called the MOCK, and asserted on what it had just handed the mock:
 *
 *     const rows = await mockDb.select().from("workspaceMembers")…where(…);
 *     expect(rows[0].workspaceName).toBe("Acme Corp");   // it configured that
 *
 * Several tests asserted nothing whatsoever — `expect(token.length).toBe(0)`
 * followed by the comment *"Procedure would throw BAD_REQUEST"*. 21 green
 * tests, no import of any router, zero coverage.
 *
 * 🔍 FOUR PLACES THE COPIES HAD ALREADY DRIFTED FROM THE SHIPPED CODE — every
 * one of them green:
 *   · it asserted `users.set({ loginMethod: "oauth", passwordHash: null })`.
 *     `finaliseAcceptance` writes `{ loginMethod, openId }` and has never
 *     touched `passwordHash`.
 *   · it asserted a `clamp(0) === 1` limit. The real input schema is
 *     `.min(1).max(500)`, which REJECTS 0 — the opposite behaviour.
 *   · it asserted `sendExpiryWarningEmails` skips on
 *     `settings.systemSenderAccountId`. No such field is read anywhere in
 *     `inviteExpiry.ts`; the skip is on `sendSystemEmail`'s `result.ok`.
 *   · it tested a `btoa(JSON.stringify({redirectUri, returnPath}))` OAuth state
 *     format that **does not exist in this codebase** and, going by the git
 *     history, never shipped. Three tests guarding an imaginary design.
 *
 * The last one is why the returnPath block below tests `@shared/returnPath`:
 * writing a REAL test for it is what turned up the open redirect that module
 * documents.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { workspaceMembers, users, loginHistory } from "../drizzle/schema";
import { safeReturnPath } from "@shared/returnPath";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => ({
  db: null as any,
  audits: [] as Record<string, unknown>[],
  sentEmails: [] as { to: string; subject: string; html: string }[],
  sendResult: { ok: true } as { ok: boolean; reason?: string },
}));

vi.mock("./db", async (importActual) => ({
  ...(await importActual<typeof import("./db")>()),
  getDb: async () => h.db,
}));

vi.mock("./audit", async (importActual) => ({
  ...(await importActual<typeof import("./audit")>()),
  recordAudit: async (entry: Record<string, unknown>) => { h.audits.push(entry); },
}));

vi.mock("./emailDelivery", async (importActual) => ({
  ...(await importActual<typeof import("./emailDelivery")>()),
  sendSystemEmail: async (_ws: number, msg: { to: string; subject: string; html: string }) => {
    h.sentEmails.push(msg);
    return h.sendResult;
  },
}));

import { appRouter } from "./routers";
import { sendExpiryWarningEmails } from "./inviteExpiry";

/**
 * The same fake-db shape as `dangerZone.test.ts`: dispatch on the real drizzle
 * table object and on whether `.innerJoin` was used, never on call order.
 *
 * ⚠️ IT THROWS WHEN THE QUEUE RUNS DRY. `[]` is a meaningful answer here — it
 * is how "invite link is invalid" and "member not found" are expressed — so a
 * queue that quietly bottomed out would make the NOT_FOUND tests pass without
 * the procedure ever having looked.
 */
interface Recorded {
  updates: { table: unknown; values: Record<string, unknown> }[];
  inserts: { table: unknown; values: Record<string, unknown> }[];
}

function rec(): Recorded {
  return { updates: [], inserts: [] };
}

function makeDb(opts: {
  /** FIFO: one entry per select the code under test runs, in source order. */
  selects: unknown[][];
  rec: Recorded;
}) {
  const queue = [...opts.selects];
  const next = () => {
    if (queue.length === 0) {
      throw new Error(
        "fake db: select queue exhausted — the code ran more selects than the " +
        "test scripted. Queue another result; do NOT default to [], which " +
        "reads as 'not found'.",
      );
    }
    return queue.shift();
  };

  const builder = () => {
    const b: any = {
      from: () => b,
      innerJoin: () => b,
      leftJoin: () => b,
      where: () => b,
      orderBy: () => b,
      limit: () => b,
      then: (res: (v: unknown) => void, rej: (e: unknown) => void) => {
        try { res(next()); } catch (e) { rej(e); }
      },
    };
    return b;
  };

  return {
    select: () => builder(),
    update(table: unknown) {
      return {
        set(values: Record<string, unknown>) {
          opts.rec.updates.push({ table, values });
          return { where: () => Promise.resolve([]) };
        },
      };
    },
    insert(table: unknown) {
      return {
        values(values: Record<string, unknown>) {
          opts.rec.inserts.push({ table, values });
          return Promise.resolve([]);
        },
      };
    },
  };
}

function makeCtx(userId: number, email: string): TrpcContext {
  return {
    user: {
      id: userId,
      openId: `open-${userId}`,
      email,
      name: `User ${userId}`,
      loginMethod: "oauth",
      role: "user",
      createdAt: new Date(),
      updatedAt: new Date(),
      lastSignedIn: new Date(),
    },
    req: { protocol: "https", headers: {} },
    res: { clearCookie: () => {} },
  } as unknown as TrpcContext;
}

/** Public procedures still need a context object; there is just no user on it. */
function publicCtx(): TrpcContext {
  return { user: null, req: { protocol: "https", headers: {} }, res: {} } as unknown as TrpcContext;
}

async function refusal(p: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await p;
  } catch (e: any) {
    return { code: e.code, message: e.message };
  }
  throw new Error("expected the procedure to throw, but it resolved");
}

const HOUR = 3_600_000;

/** One invite row as the two acceptance procedures select it. */
function inviteRow(over: Record<string, unknown> = {}) {
  return {
    memberId: 1,
    workspaceId: 1,
    workspaceName: "Acme Corp",
    userId: 42,
    role: "rep",
    inviteExpiresAt: new Date(Date.now() + 24 * HOUR),
    loginMethod: "invite",
    userName: "Alice",
    userEmail: "alice@acme.com",
    ...over,
  };
}

beforeEach(() => {
  h.audits = [];
  h.sentEmails = [];
  h.sendResult = { ok: true };
});

// ─── team.acceptInvitePreview ────────────────────────────────────────────────

describe("team.acceptInvitePreview", () => {
  it("returns the workspace, role and invitee for a valid token", async () => {
    h.db = makeDb({ selects: [[inviteRow()]], rec: rec() });
    const out = await appRouter.createCaller(publicCtx()).team.acceptInvitePreview({ token: "abc123" });
    expect(out).toMatchObject({
      workspaceName: "Acme Corp",
      role: "rep",
      userName: "Alice",
      userEmail: "alice@acme.com",
      passwordSetupOnly: false,
    });
  });

  it("refuses an unknown token with NOT_FOUND, not an empty preview", async () => {
    h.db = makeDb({ selects: [[]], rec: rec() });
    const e = await refusal(
      appRouter.createCaller(publicCtx()).team.acceptInvitePreview({ token: "nope" }),
    );
    expect(e.code).toBe("NOT_FOUND");
    expect(e.message).toMatch(/invalid or has already been used/i);
  });

  it("rejects an empty token at the input boundary", async () => {
    // The old file asserted `expect("".length).toBe(0)` and left a comment
    // saying the procedure *would* throw. It does — `z.string().min(1)`.
    h.db = makeDb({ selects: [[inviteRow()]], rec: rec() });
    const e = await refusal(
      appRouter.createCaller(publicCtx()).team.acceptInvitePreview({ token: "" }),
    );
    expect(e.code).toBe("BAD_REQUEST");
  });

  it("refuses an expired invitation", async () => {
    h.db = makeDb({ selects: [[inviteRow({ inviteExpiresAt: new Date(Date.now() - 1000) })]], rec: rec() });
    const e = await refusal(
      appRouter.createCaller(publicCtx()).team.acceptInvitePreview({ token: "abc123" }),
    );
    expect(e.code).toBe("BAD_REQUEST");
    expect(e.message).toMatch(/expired/i);
  });

  /**
   * The comparison is `inviteExpiresAt <= now`, so an invite expiring on this
   * exact tick is expired. Pinned because `<` vs `<=` is invisible in review
   * and only shows up as a link that works one second too long.
   */
  it("treats an invite expiring exactly now as expired", async () => {
    const now = new Date();
    vi.setSystemTime(now);
    h.db = makeDb({ selects: [[inviteRow({ inviteExpiresAt: now })]], rec: rec() });
    const e = await refusal(
      appRouter.createCaller(publicCtx()).team.acceptInvitePreview({ token: "abc123" }),
    );
    expect(e.code).toBe("BAD_REQUEST");
    vi.useRealTimers();
  });

  it("allows an invite with no expiry set", async () => {
    h.db = makeDb({ selects: [[inviteRow({ inviteExpiresAt: null })]], rec: rec() });
    const out = await appRouter.createCaller(publicCtx()).team.acceptInvitePreview({ token: "abc123" });
    expect(out.expiresAt).toBeNull();
  });

  /**
   * `passwordSetupOnly` tells the client to skip `finaliseAcceptance` entirely
   * and just set a password. It is derived from `loginMethod`, and BOTH pending
   * spellings must count as pending — `expired_invite` is what the nightly job
   * rewrites `invite` to, so missing it would send every expired-then-resent
   * invitee down the wrong branch.
   */
  it("marks only NON-pending loginMethods as password-setup-only", async () => {
    for (const pending of ["invite", "expired_invite"]) {
      h.db = makeDb({ selects: [[inviteRow({ loginMethod: pending })]], rec: rec() });
      const out = await appRouter.createCaller(publicCtx()).team.acceptInvitePreview({ token: "t" });
      expect(out.passwordSetupOnly, `${pending} is a pending invite`).toBe(false);
    }
    for (const accepted of ["oauth", "google", "manus"]) {
      h.db = makeDb({ selects: [[inviteRow({ loginMethod: accepted })]], rec: rec() });
      const out = await appRouter.createCaller(publicCtx()).team.acceptInvitePreview({ token: "t" });
      expect(out.passwordSetupOnly, `${accepted} has already accepted`).toBe(true);
    }
  });
});

// ─── team.finaliseAcceptance ─────────────────────────────────────────────────

describe("team.finaliseAcceptance", () => {
  it("marks the invite accepted: loginMethod + openId on the user, token cleared", async () => {
    const r = rec();
    h.db = makeDb({ selects: [[inviteRow()]], rec: r });
    const out = await appRouter
      .createCaller(makeCtx(42, "alice@acme.com"))
      .team.finaliseAcceptance({ token: "abc123" });

    expect(out).toEqual({ ok: true, workspaceName: "Acme Corp", role: "rep" });

    /**
     * ⚠️ THE OLD FILE ASSERTED `passwordHash: null` HERE. The procedure writes
     * `openId` and has never written `passwordHash` — an invitee who set a
     * password during acceptance would have had it wiped if it ever had.
     * `toEqual`, not `toMatchObject`, so an extra column added to this write
     * has to be looked at.
     */
    const userWrite = r.updates.find((u) => u.table === users);
    expect(userWrite?.values).toEqual({ loginMethod: "oauth", openId: "open-42" });

    const memberWrite = r.updates.find((u) => u.table === workspaceMembers);
    expect(memberWrite?.values).toEqual({ inviteToken: null, inviteExpiresAt: null });
  });

  it("records the acceptance in login history and the audit log", async () => {
    const r = rec();
    h.db = makeDb({ selects: [[inviteRow()]], rec: r });
    await appRouter.createCaller(makeCtx(42, "alice@acme.com")).team.finaliseAcceptance({ token: "abc123" });

    const hist = r.inserts.find((i) => i.table === loginHistory);
    expect(hist?.values).toMatchObject({ userId: 42, workspaceId: 1, outcome: "success" });
    expect(h.audits[0]).toMatchObject({
      entityType: "workspace_member",
      after: { loginMethod: "oauth", inviteAccepted: true },
    });
  });

  /**
   * 🔒 The invite names an email; the session names another. Without this the
   * first person to open a forwarded invite link joins the workspace as
   * whoever the invite was for.
   */
  it("refuses when the signed-in email does not match the invite", async () => {
    const r = rec();
    h.db = makeDb({ selects: [[inviteRow({ userEmail: "alice@acme.com" })]], rec: r });
    const e = await refusal(
      appRouter.createCaller(makeCtx(99, "bob@acme.com")).team.finaliseAcceptance({ token: "abc123" }),
    );
    expect(e.code).toBe("FORBIDDEN");
    expect(e.message).toMatch(/alice@acme\.com/);
    expect(r.updates).toHaveLength(0);
  });

  it("matches the email case-insensitively", async () => {
    const r = rec();
    h.db = makeDb({ selects: [[inviteRow({ userEmail: "Alice@Acme.com" })]], rec: r });
    const out = await appRouter
      .createCaller(makeCtx(42, "alice@acme.COM"))
      .team.finaliseAcceptance({ token: "abc123" });
    expect(out.ok).toBe(true);
  });

  it("refuses an expired invite before it checks anything else", async () => {
    const r = rec();
    h.db = makeDb({ selects: [[inviteRow({ inviteExpiresAt: new Date(Date.now() - 1000) })]], rec: r });
    const e = await refusal(
      appRouter.createCaller(makeCtx(42, "alice@acme.com")).team.finaliseAcceptance({ token: "abc123" }),
    );
    expect(e.code).toBe("BAD_REQUEST");
    expect(e.message).toMatch(/expired/i);
    expect(r.updates).toHaveLength(0);
  });

  it("refuses an unknown token", async () => {
    const r = rec();
    h.db = makeDb({ selects: [[]], rec: r });
    const e = await refusal(
      appRouter.createCaller(makeCtx(42, "alice@acme.com")).team.finaliseAcceptance({ token: "gone" }),
    );
    expect(e.code).toBe("NOT_FOUND");
    expect(r.updates).toHaveLength(0);
  });

  /**
   * The OAuth merge may already have accepted this invite. Then the only work
   * left is clearing the token — and crucially NOT rewriting `users.openId`,
   * which would repoint an established account at whoever opened the link.
   */
  it("for an already-accepted member, clears the token and touches the user row not at all", async () => {
    const r = rec();
    h.db = makeDb({ selects: [[inviteRow({ loginMethod: "oauth" })]], rec: r });
    const out = await appRouter
      .createCaller(makeCtx(42, "alice@acme.com"))
      .team.finaliseAcceptance({ token: "abc123" });

    expect(out).toEqual({ ok: true, workspaceName: "Acme Corp", role: "rep" });
    expect(r.updates).toHaveLength(1);
    expect(r.updates[0].table).toBe(workspaceMembers);
    expect(r.updates.some((u) => u.table === users), "must not rewrite the user row").toBe(false);
    expect(r.inserts, "no login-history row for a no-op acceptance").toHaveLength(0);
  });

  it("still treats expired_invite as pending, so a resent invite completes properly", async () => {
    const r = rec();
    h.db = makeDb({ selects: [[inviteRow({ loginMethod: "expired_invite" })]], rec: r });
    await appRouter.createCaller(makeCtx(42, "alice@acme.com")).team.finaliseAcceptance({ token: "abc123" });
    expect(r.updates.some((u) => u.table === users), "expired_invite is pending, so the user row IS written").toBe(true);
  });
});

// ─── team.getLoginHistoryFiltered ────────────────────────────────────────────

describe("team.getLoginHistoryFiltered", () => {
  const ADMIN = { id: 1, userId: 1, role: "admin" as const, deactivatedAt: null };

  /** This one needs the workspace middleware satisfied as well. */
  function withMember(rows: unknown[][]) {
    const r = rec();
    const inner = makeDb({ selects: rows, rec: r });
    return {
      r,
      db: {
        ...inner,
        select: (fields?: Record<string, unknown>) => {
          const b: any = {
            _joined: false,
            from: () => b,
            innerJoin: () => { b._joined = true; return b; },
            leftJoin: () => b,
            where: () => b,
            orderBy: () => b,
            limit: () => b,
            then: (res: (v: unknown) => void, rej: (e: unknown) => void) => {
              if (b._joined) {
                res([{
                  ws: { id: 1, name: "Acme Corp", ownerUserId: 1, archivedAt: null },
                  mb: { ...ADMIN, workspaceId: 1, lastActiveAt: new Date() },
                }]);
                return;
              }
              (inner.select() as any).then(res, rej);
            },
          };
          void fields;
          return b;
        },
      },
    };
  }

  it("returns the member's history", async () => {
    const rows = [{ id: 9, userId: 7, outcome: "success" }];
    const { db } = withMember([[{ userId: 7 }], rows]);
    h.db = db;
    const out = await appRouter.createCaller(makeCtx(1, "admin@acme.com")).team.getLoginHistoryFiltered({
      memberId: 5,
    });
    expect(out).toEqual(rows);
  });

  /**
   * 🔒 THE TENANCY CHECK the old file never went near. `memberId` comes
   * straight from the caller, and the lookup is scoped to `ctx.workspace.id` —
   * otherwise any admin could read any member's login history in any workspace
   * by guessing an integer.
   */
  it("refuses a memberId that is not in the caller's workspace", async () => {
    const { db } = withMember([[]]);
    h.db = db;
    const e = await refusal(
      appRouter.createCaller(makeCtx(1, "admin@acme.com")).team.getLoginHistoryFiltered({ memberId: 999 }),
    );
    expect(e.code).toBe("NOT_FOUND");
    expect(e.message).toMatch(/member not found/i);
  });

  /**
   * ⚠️ THE OLD FILE ASSERTED THE OPPOSITE. It tested
   * `clamp = v => Math.min(500, Math.max(1, v))` and expected `clamp(0) === 1`
   * and `clamp(1000) === 500`. The real schema is `.min(1).max(500)`, which
   * REJECTS both — a caller sending 1000 gets a BAD_REQUEST, not 500 rows.
   */
  it("rejects a limit outside 1..500 rather than clamping it", async () => {
    const caller = appRouter.createCaller(makeCtx(1, "admin@acme.com"));
    for (const limit of [0, 501, 1000]) {
      const { db } = withMember([[{ userId: 7 }], []]);
      h.db = db;
      const e = await refusal(caller.team.getLoginHistoryFiltered({ memberId: 5, limit }));
      expect(e.code, `limit ${limit}`).toBe("BAD_REQUEST");
    }
    // …and the boundaries themselves are accepted.
    for (const limit of [1, 500]) {
      const { db } = withMember([[{ userId: 7 }], []]);
      h.db = db;
      await expect(caller.team.getLoginHistoryFiltered({ memberId: 5, limit })).resolves.toEqual([]);
    }
  });

  it("only accepts the three real outcomes", async () => {
    const caller = appRouter.createCaller(makeCtx(1, "admin@acme.com"));
    for (const outcome of ["success", "failed", "expired_invite"] as const) {
      const { db } = withMember([[{ userId: 7 }], []]);
      h.db = db;
      await expect(caller.team.getLoginHistoryFiltered({ memberId: 5, outcome })).resolves.toEqual([]);
    }
    const { db } = withMember([[{ userId: 7 }], []]);
    h.db = db;
    const e = await refusal(
      caller.team.getLoginHistoryFiltered({ memberId: 5, outcome: "pending" as never }),
    );
    expect(e.code).toBe("BAD_REQUEST");
  });

  it("refuses a rep at the middleware", async () => {
    const { db } = withMember([[{ userId: 7 }], []]);
    h.db = {
      ...db,
      select: (f?: Record<string, unknown>) => {
        const b: any = (db as any).select(f);
        const orig = b.then;
        b.then = (res: (v: unknown) => void, rej: (e: unknown) => void) => {
          if (b._joined) {
            res([{
              ws: { id: 1, name: "Acme Corp", ownerUserId: 1, archivedAt: null },
              mb: { id: 3, userId: 3, role: "rep", deactivatedAt: null, workspaceId: 1, lastActiveAt: new Date() },
            }]);
            return;
          }
          orig(res, rej);
        };
        return b;
      },
    };
    const e = await refusal(
      appRouter.createCaller(makeCtx(3, "rep@acme.com")).team.getLoginHistoryFiltered({ memberId: 5 }),
    );
    expect(e.code).toBe("FORBIDDEN");
    expect(e.message).toMatch(/requires admin role/i);
  });
});

// ─── sendExpiryWarningEmails ─────────────────────────────────────────────────

describe("sendExpiryWarningEmails", () => {
  function expiring(over: Record<string, unknown> = {}) {
    return {
      memberId: 1,
      workspaceId: 1,
      userId: 42,
      inviteExpiresAt: new Date(Date.now() + 12 * HOUR),
      inviteToken: "tok123",
      userName: "Alice",
      userEmail: "alice@acme.com",
      workspaceName: "Acme Corp",
      ...over,
    };
  }

  it("emails each expiring invitee and logs the reminder", async () => {
    const r = rec();
    h.db = makeDb({ selects: [[expiring()]], rec: r });
    await sendExpiryWarningEmails();

    expect(h.sentEmails).toHaveLength(1);
    expect(h.sentEmails[0].to).toBe("alice@acme.com");
    expect(h.sentEmails[0].subject).toBe("Your invitation to Acme Corp expires in 12 hours");
    expect(h.sentEmails[0].html).toContain("/invite/accept?token=tok123");

    const hist = r.inserts.find((i) => i.table === loginHistory);
    expect(hist?.values).toMatchObject({ userId: 42, outcome: "expired_invite", userAgent: "expiry-warning-job" });
  });

  it("uses the singular hour at exactly one hour left", async () => {
    h.db = makeDb({ selects: [[expiring({ inviteExpiresAt: new Date(Date.now() + HOUR) })]], rec: rec() });
    await sendExpiryWarningEmails();
    expect(h.sentEmails[0].subject).toBe("Your invitation to Acme Corp expires in 1 hour");
  });

  /**
   * ⚠️ THE OLD FILE CHECKED `settings.systemSenderAccountId`, a field this
   * module never reads. The real skip is `sendSystemEmail` returning
   * `{ ok: false }` — and when it does, NO login-history row may be written,
   * or the admin sees "reminder sent" for a mail that never left.
   */
  it("writes no reminder record when the send is skipped", async () => {
    const r = rec();
    h.sendResult = { ok: false, reason: "no system sender configured" };
    h.db = makeDb({ selects: [[expiring()]], rec: r });
    await sendExpiryWarningEmails();

    expect(h.sentEmails).toHaveLength(1); // it was attempted…
    expect(r.inserts, "a skipped send must not be logged as a reminder").toHaveLength(0);
  });

  it("skips an invitee with no email rather than sending to nobody", async () => {
    const r = rec();
    h.db = makeDb({ selects: [[expiring({ userEmail: null })]], rec: r });
    await sendExpiryWarningEmails();
    expect(h.sentEmails).toHaveLength(0);
    expect(r.inserts).toHaveLength(0);
  });

  it("does nothing at all when nothing is expiring", async () => {
    const r = rec();
    h.db = makeDb({ selects: [[]], rec: r });
    await sendExpiryWarningEmails();
    expect(h.sentEmails).toHaveLength(0);
    expect(r.inserts).toHaveLength(0);
  });

  it("survives one bad recipient and still mails the rest", async () => {
    const r = rec();
    h.db = makeDb({ selects: [[expiring({ userEmail: null }), expiring({ userEmail: "bob@acme.com" })]], rec: r });
    await sendExpiryWarningEmails();
    expect(h.sentEmails.map((e) => e.to)).toEqual(["bob@acme.com"]);
  });
});

// ─── the returnPath guard ────────────────────────────────────────────────────

/**
 * 🔴 THE OPEN REDIRECT THIS BLOCK FOUND. The old tests here reimplemented a
 * `btoa(JSON.stringify({redirectUri, returnPath}))` OAuth state format that
 * exists nowhere in this codebase. Writing a real test meant finding what
 * actually guards the post-login redirect — four hand-written copies of
 * `returnPath.startsWith("/")` — and `//evil.com` starts with `/`.
 *
 * `/?returnPath=//evil.com` → sign in → `res.redirect(302, "//evil.com")`.
 * See `@shared/returnPath` for the full note; these are the cases.
 */
describe("safeReturnPath — where a visitor may be sent after signing in", () => {
  it("keeps ordinary in-app paths, including query strings", () => {
    for (const p of ["/", "/people", "/invite/accept?token=abc123", "/v2/deals#tab=open"]) {
      expect(safeReturnPath(p), p).toBe(p);
    }
  });

  it("refuses a protocol-relative URL — the bug", () => {
    expect(safeReturnPath("//evil.com")).toBe("/");
    expect(safeReturnPath("//evil.com/looks/like/a/path")).toBe("/");
  });

  it("refuses the backslash spelling of the same thing", () => {
    // WHATWG URL parsing treats `/\` as `//`, so Chrome and Firefox resolve
    // this to another origin exactly like the case above.
    expect(safeReturnPath("/\\evil.com")).toBe("/");
  });

  it("refuses absolute URLs and scheme-bearing strings", () => {
    for (const p of ["https://evil.com", "http://evil.com", "javascript:alert(1)", "data:text/html,x"]) {
      expect(safeReturnPath(p), p).toBe("/");
    }
  });

  it("refuses CR/LF, which would be header injection at res.redirect", () => {
    expect(safeReturnPath("/ok\r\nSet-Cookie: a=b")).toBe("/");
    expect(safeReturnPath("/ok\nX-Injected: 1")).toBe("/");
  });

  it("refuses non-strings instead of coercing them", () => {
    for (const v of [null, undefined, 42, {}, ["/people"]]) {
      expect(safeReturnPath(v)).toBe("/");
    }
  });

  it("honours a caller-chosen fallback, so getLoginUrl can ask for empty", () => {
    // `getLoginUrl` needs to distinguish "no usable path" from "the root path".
    expect(safeReturnPath("//evil.com", "")).toBe("");
    expect(safeReturnPath("/people", "")).toBe("/people");
  });

  /**
   * A single leading slash followed by anything else is the whole legitimate
   * population, so this is the boundary: `/` alone is fine, `//` is not.
   */
  it("keeps a bare slash", () => {
    expect(safeReturnPath("/")).toBe("/");
  });
});
