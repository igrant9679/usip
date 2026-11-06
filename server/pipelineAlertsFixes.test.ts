/**
 * Pipeline alerts and the notices around them (audit 2026-10-20, batch Ra).
 *
 *   R2  — the stuck-deal digest and the proposal engagement notice go to this
 *         workspace's own people, not the platform operator; deal names are
 *         text in the mail, not markup · no sender pushes a workspace's records
 *         to the operator's notification service.
 *
 * Procedures run through the real router against the SQL-evaluating fake.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => {
  if (!process.env.ENCRYPTION_KEY && !process.env.JWT_SECRET) process.env.ENCRYPTION_KEY = "b".repeat(64);
  // The platform's own owner account: a user, but no member of workspace 2.
  process.env.OWNER_OPEN_ID = "platform-owner";
  return {
    db: null as any,
    sent: [] as Array<{ ws: number; to: unknown; subject: string; html: string }>,
    pushed: [] as unknown[],
  };
});
vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));
vi.mock("./emailDelivery", async (a) => ({
  ...(await a<typeof import("./emailDelivery")>()),
  sendSystemEmail: async (ws: number, o: { to: unknown; subject: string; html: string }) => { h.sent.push({ ws, ...o }); return { ok: true }; },
}));
vi.mock("./_core/notification", () => ({ notifyOwner: async (p: unknown) => { h.pushed.push(p); return true; } }));

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { appRouter } from "./routers";
import { invalidateStageIndex } from "./_core/stageSemantics";

const WS = 2, ME = 1, OWNER = 7, PLATFORM = 99, AUTHOR = 5;
const root = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8").replace(/\r\n/g, "\n");
const rows = (t: string) => h.db.rowsOf(t) as any[];
const caller = (userId = ME) => appRouter.createCaller({
  user: { id: userId, openId: `u${userId}`, email: `me${userId}@example.com`, name: "Me", loginMethod: "password", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
  req: { protocol: "https", headers: { "x-workspace-id": String(WS) } },
  res: { clearCookie: () => {} },
} as unknown as TrpcContext);
const member = (id: number, userId: number, role: string, o: Record<string, unknown> = {}) =>
  ({ id, workspaceId: WS, userId, role, deactivatedAt: null, inviteToken: null, lastActiveAt: new Date(), ...o });

beforeEach(() => {
  h.db = makeSqlFakeDb({ realMembers: true });
  h.sent = [];
  h.pushed = [];
  invalidateStageIndex();
  rows("workspaces").push({ id: WS, name: "W", slug: "w", ownerUserId: OWNER, archivedAt: null, plan: "trial" });
  rows("users").push(
    { id: ME, name: "Me", email: "me@example.com", openId: "u1" },
    { id: OWNER, name: "Owner", email: "owner@example.com", openId: "u7" },
    { id: AUTHOR, name: "Author", email: "author@example.com", openId: "u5" },
    { id: PLATFORM, name: "Platform", email: "platform@example.com", openId: "platform-owner" },
  );
  rows("workspace_members").push(member(1, ME, "rep"), member(2, OWNER, "super_admin"), member(3, AUTHOR, "rep"));
});

describe("R2: the digest goes to this workspace's owner", () => {
  beforeEach(() => {
    rows("opportunities").push(
      { id: 1, workspaceId: WS, accountId: 1, name: `<img src=x onerror="alert(1)">`, stage: "discovery", value: "5000", daysInStage: 30, ownerUserId: ME },
    );
  });

  it("mails the workspace owner, never the platform owner", async () => {
    const r = await caller().pipelineAlerts.sendDigest();
    expect(r).toMatchObject({ sent: true, recipient: "owner@example.com" });
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].to).toBe("owner@example.com");
    expect(JSON.stringify(h.sent)).not.toContain("platform@example.com");
  });

  it("an owner who has left hands the digest to a member who is still here", async () => {
    rows("workspace_members").find((m) => m.userId === OWNER).deactivatedAt = new Date();
    await caller().pipelineAlerts.sendDigest();
    expect(["me@example.com", "author@example.com"]).toContain(h.sent[0].to);
  });

  it("a deal's name is text in the mail, not markup", async () => {
    await caller().pipelineAlerts.sendDigest();
    expect(h.sent[0].html).not.toContain("<img");
    expect(h.sent[0].html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  });
});

describe("R2: a proposal's engagement drop tells its author, in the app", () => {
  beforeEach(() => {
    rows("proposals").push({ id: 3, workspaceId: WS, createdBy: AUTHOR, title: "Q4 renewal", clientName: "Acme", status: "sent", sentAt: new Date(), emailOpenedAt: null, emailClickedAt: null });
    rows("proposal_score_history").push({ id: 1, proposalId: 3, score: 70, createdAt: new Date(Date.now() - 86_400_000) });
  });

  it("writes a notification for the author and pushes nothing to the platform", async () => {
    const r = await caller().proposals.snapshotScore({ proposalId: 3 });
    expect(r.dropped).toBe(true);
    const notes = rows("notifications").filter((n) => n.workspaceId === WS);
    expect(notes.map((n) => n.userId)).toEqual([AUTHOR]);
    expect(notes[0]).toMatchObject({ relatedType: "proposal", relatedId: 3 });
    expect(notes[0].title).toContain("Q4 renewal");
    expect(h.pushed).toEqual([]);
  });

  it("an author who has left: the workspace's owner hears instead", async () => {
    rows("workspace_members").find((m) => m.userId === AUTHOR).deactivatedAt = new Date();
    await caller().proposals.snapshotScore({ proposalId: 3 });
    expect(rows("notifications").map((n) => n.userId)).toEqual([OWNER]);
  });
});

describe("R2: no sender pushes a workspace's records to the platform operator", () => {
  /**
   * notifyOwner POSTs the operator's notification service — one inbox for the
   * whole install. The digests and notices of a workspace belong in that
   * workspace. What may still call it: platform-wide run summaries that carry
   * counts across every workspace and no workspace's records.
   */
  const PLATFORM_SUMMARIES = ["server/_core/systemRouter.ts", "server/nightlyBatch.ts", "server/routers/segmentRules.ts"];

  const files = (dir: string): string[] => readdirSync(join(root, dir)).flatMap((n) => {
    const rel = `${dir}/${n}`;
    if (statSync(join(root, rel)).isDirectory()) return n === "__fakes__" ? [] : files(rel);
    return /\.ts$/.test(n) && !/\.test\.ts$/.test(n) ? [rel] : [];
  });

  it("only the platform-wide summaries import it", () => {
    const callers = files("server")
      .filter((f) => /from ["'][./]+(?:_core\/)?notification["']|import\(["'][./]+(?:_core\/)?notification["']\)/.test(read(f)))
      .filter((f) => f !== "server/_core/notification.ts")
      .map((f) => relative(root, join(root, f)).replace(/\\/g, "/"))
      .sort();
    expect(callers).toEqual(PLATFORM_SUMMARIES.slice().sort());
  });

  it("the meeting-booked signal and the rejection digest no longer call it", () => {
    expect(read("server/routers/are/execution.ts")).not.toMatch(/notifyOwner\(/);
    expect(read("server/emailTracking.ts")).not.toMatch(/notifyOwner\(/);
  });

  it("the reconnect mail prints the account's own names as text", () => {
    const mail = read("server/unipileWebhook.ts");
    expect(mail).toContain("<p>Hi ${escapeHtml(user.name ?? user.email.split(\"@\")[0])},</p>");
    expect(mail).toContain("<em>${escapeHtml(accountLabel)}</em>");
  });
});
