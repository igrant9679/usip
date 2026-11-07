/**
 * Every workspace mutation leaves an audit entry (audit 2026-10-20, G49;
 * final pass 2026-11-07).
 *
 * Many mutations wrote nothing to the audit log, and the Audit page said so.
 * workspaceProcedure now records, after a mutation succeeds, the procedure,
 * the person and the ids its input named, unless the procedure recorded its
 * own entry (then nothing is added). Numbers only: no password, token, key or
 * message body can reach the entry. A short, explained list of
 * high-frequency, low-value mutations is skipped.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => ({ db: null as any }));
vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));

import bcrypt from "bcryptjs";
import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { appRouter } from "./routers";
import { AUTO_AUDIT_SKIP, autoAuditAction, idsInInput } from "./_core/autoAudit";
import { resetAccountLockouts } from "./services/accountLockout";

const ROOT = join(__dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const rows = (t: string) => h.db.rowsOf(t) as any[];
const audits = () => rows("audit_log");
const auto = () => audits().filter((a) => a.after?.auto === true);
const WS = 2;
const PASSWORD = "an old long password";

function caller(userId = 1) {
  const user = rows("users").find((u) => u.id === userId);
  return appRouter.createCaller({
    user,
    req: { protocol: "https", headers: { "x-workspace-id": String(WS) }, socket: { remoteAddress: "127.0.0.1" } },
    res: { clearCookie: () => {}, cookie: () => {} },
  } as unknown as TrpcContext);
}

beforeEach(() => {
  resetAccountLockouts();
  h.db = makeSqlFakeDb({ realMembers: true });
  rows("workspaces").push({ id: WS, name: "LSI", slug: "lsi", ownerUserId: 1, archivedAt: null });
  rows("users").push(
    { id: 1, openId: "o1", name: "Admin", email: "admin@lsi.example", role: "user", passwordHash: bcrypt.hashSync(PASSWORD, 4), sessionVersion: 0, mfaTotpEnabledAt: null },
    { id: 2, openId: "o2", name: "Rep", email: "rep@lsi.example", role: "user", passwordHash: null, sessionVersion: 0 },
  );
  rows("workspace_members").push(
    { id: 1, workspaceId: WS, userId: 1, role: "super_admin", deactivatedAt: null, inviteToken: null },
    { id: 2, workspaceId: WS, userId: 2, role: "rep", deactivatedAt: null, inviteToken: null },
  );
  rows("campaigns").push({ id: 7, workspaceId: WS, name: "Spring", status: "planning", checklist: [] });
  rows("accounts").push({ id: 9, workspaceId: WS, name: "Acme", archivedAt: null });
  rows("notifications").push({ id: 3, workspaceId: WS, userId: 1, kind: "mention", title: "x", readAt: null });
});

describe("a mutation that records nothing itself now leaves an entry", () => {
  it("names the procedure, the person and the ids, and nothing else", async () => {
    await caller().campaigns.update({ id: 7, patch: { name: "Summer launch", ownerUserId: 2 } });
    const a = auto();
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({
      workspaceId: WS, actorUserId: 1, action: "update", entityType: "campaigns", entityId: 7,
      after: { procedure: "campaigns.update", auto: true, ids: { id: 7, "patch.ownerUserId": 2 } },
    });
    // The new name is not an id, so it is not in the entry.
    expect(JSON.stringify(a[0])).not.toContain("Summer launch");
  });

  it("never carries a password, whatever the input held", async () => {
    await caller().profile.changeMyPassword({ currentPassword: PASSWORD, newPassword: "a brand new password" });
    const a = auto();
    expect(a).toHaveLength(1);
    expect(a[0].after).toEqual({ procedure: "profile.changeMyPassword", auto: true });
    expect(JSON.stringify(audits())).not.toContain(PASSWORD);
    expect(JSON.stringify(audits())).not.toContain("a brand new password");
  });

  it("never carries a message body: a note records the record it is on, not what it says", async () => {
    await caller().activities.addNote({ relatedType: "account", relatedId: 9, body: "Private: their budget is $40k" });
    const a = auto();
    expect(a).toHaveLength(1);
    expect(a[0].after).toEqual({ procedure: "activities.addNote", auto: true, ids: { relatedId: 9 } });
    expect(JSON.stringify(audits())).not.toContain("budget");
  });
});

describe("nothing is doubled, refused, read-only or skipped", () => {
  it("a procedure that audits itself is not given a second entry", async () => {
    await caller().companies.archive({ accountId: 9 });
    expect(audits()).toHaveLength(1);
    expect(audits()[0]).toMatchObject({ entityType: "company_archive", entityId: 9 });
    expect(auto()).toHaveLength(0);
  });

  it("a refused call records nothing", async () => {
    await expect(caller(2).companies.archive({ accountId: 9 })).rejects.toBeTruthy();
    await expect(caller().campaigns.update({ id: 7, patch: { ownerUserId: 999 } })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(audits()).toHaveLength(0);
  });

  it("a query records nothing", async () => {
    await caller().campaigns.list();
    expect(audits()).toHaveLength(0);
  });

  it("marking a notification read is on the skip list, with its reason", async () => {
    await caller().notifications.markRead({ id: 3 });
    expect(audits()).toHaveLength(0);
    expect(AUTO_AUDIT_SKIP["notifications.markRead"]).toBe("read state");
  });

  it("every skipped path is a real mutation, so a renamed one cannot hide", () => {
    const procs = (appRouter as any)._def.procedures as Record<string, any>;
    for (const p of Object.keys(AUTO_AUDIT_SKIP)) {
      expect(procs[p]?._def?.type, p).toBe("mutation");
      expect(AUTO_AUDIT_SKIP[p].length, `${p} says why`).toBeGreaterThan(5);
    }
  });
});

describe("the pieces", () => {
  it("only numeric id fields are copied, top level and one object down", () => {
    expect(idsInInput({ id: 4, ids: [1, 2], accountId: 5, name: "x", token: "secret", apiKey: 123, patch: { ownerUserId: 6, body: "hi" }, deep: { a: { contactId: 7 } } }))
      .toEqual({ id: 4, ids: [1, 2], accountId: 5, "patch.ownerUserId": 6 });
    expect(idsInInput({ externalId: "abc", contactIds: ["1"] })).toEqual({});
    expect(idsInInput(null)).toEqual({});
  });

  it("the action follows the procedure's name", () => {
    expect(autoAuditAction("proposals.create")).toBe("create");
    expect(autoAuditAction("segments.addContacts")).toBe("create");
    expect(autoAuditAction("tasks.delete")).toBe("delete");
    expect(autoAuditAction("senderPools.removeMember")).toBe("delete");
    expect(autoAuditAction("campaigns.update")).toBe("update");
  });

  it("recordAudit marks the request, and workspaceProcedure writes only when nothing did", () => {
    const audit = read("server/audit.ts");
    expect(audit).toContain("noteAuditRecorded();");
    const ws = read("server/_core/workspace.ts");
    const mw = ws.slice(ws.indexOf("export const workspaceProcedure"), ws.indexOf("export function roleRank("));
    expect(mw).toContain('if (type === "mutation" && result.ok && !auditMark.recorded && !autoAuditSkipped(path)) {');
  });

  it("the Audit page no longer says entries are missing", () => {
    const page = read("client/src/pages/usip/Audit.tsx");
    expect(page).not.toContain("Not every action writes an entry yet");
    expect(page).toContain("Every change made in the app is recorded");
  });
});
