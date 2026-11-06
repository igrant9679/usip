/**
 * Audit 2026-10-20, O49: on the LinkedIn Network page, Publish, Comment (Enter
 * posted it) and Withdraw acted on LinkedIn at once with no confirm, and a
 * withdraw left our stored invite "pending", so the Revenue Engine's LinkedIn
 * step kept waiting for an accept that could not come.
 *
 * The withdraw runs through the real router over an in-memory database that
 * evaluates its SQL; LinkedIn (Unipile) is a recording mock.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => {
  if (!process.env.ENCRYPTION_KEY && !process.env.JWT_SECRET) process.env.ENCRYPTION_KEY = "b".repeat(64);
  return { db: null as any, cancelled: [] as any[], cancelFails: false };
});
vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));
vi.mock("./lib/unipile", async (a) => ({
  ...(await a<typeof import("./lib/unipile")>()),
  cancelSentInvitation: async (p: any) => { if (h.cancelFails) throw new Error("LinkedIn said no"); h.cancelled.push(p); return {}; },
}));

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { appRouter } from "./routers";

const WS = 2;
const ME = 21;
const rows = (t: string) => h.db.rowsOf(t) as any[];
const caller = () => appRouter.createCaller({
  user: { id: ME, openId: "u", email: "rep@lsi.example", name: "Rep", loginMethod: "password", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
  req: { protocol: "https", headers: { "x-workspace-id": String(WS) } },
  res: { clearCookie: () => {} },
} as unknown as TrpcContext);
const invite = (id: number, over: Record<string, unknown>) =>
  rows("unipile_invites").push({ id, workspaceId: WS, userId: ME, unipileAccountId: "acc-rep", recipientProviderId: "jo-search", status: "pending", sentAt: new Date(), ...over });

beforeEach(() => {
  h.db = makeSqlFakeDb({ roles: { [WS]: "rep" }, wsId: () => WS });
  h.cancelled = [];
  h.cancelFails = false;
  rows("workspaces").push({ id: WS, name: "LSI", slug: "lsi", ownerUserId: 1, archivedAt: null, plan: "trial" });
  rows("unipile_accounts").push({ id: 2, workspaceId: WS, userId: ME, unipileAccountId: "acc-rep", provider: "LINKEDIN" });
  invite(1, {});
  invite(2, { recipientProviderId: "someone-else" });
  invite(3, { unipileAccountId: "acc-colleague", userId: 99 }); // the same person, invited by a colleague
  invite(4, { status: "accepted", recipientProviderId: "ACoAAJo" });
  invite(5, { workspaceId: 99 });
});

describe("withdrawing an invitation updates the stored invite", () => {
  it("this account's pending invite to that person is marked withdrawn, and nothing else", async () => {
    const r = await caller().unipile.withdrawInvitation({ invitationId: "inv-1", recipient: ["jo-search", "ACoAAJo"] });
    expect(r).toEqual({ ok: true, withdrawn: 1 });
    expect(h.cancelled).toEqual([{ accountId: "acc-rep", invitationId: "inv-1" }]);
    expect(rows("unipile_invites").map((i) => [i.id, i.status])).toEqual([[1, "withdrawn"], [2, "pending"], [3, "pending"], [4, "accepted"], [5, "pending"]]);
  });

  it("if LinkedIn refuses, nothing is marked", async () => {
    h.cancelFails = true;
    await expect(caller().unipile.withdrawInvitation({ invitationId: "inv-1", recipient: ["jo-search"] })).rejects.toThrow();
    expect(rows("unipile_invites")[0].status).toBe("pending");
  });

  it("the Revenue Engine reads a withdrawn invite as an answer, not a wait", () => {
    const step = readFileSync("server/services/are/linkedinStep.ts", "utf8");
    expect(step).toContain('if (invite && invite.status !== "pending" && !wantsMessage) {');
  });
});

describe("the page asks before it acts on LinkedIn", () => {
  const page = readFileSync("client/src/pages/usip/Social.tsx", "utf8").replace(/\r\n/g, "\n");
  const slice = (start: string, end: string) => page.slice(page.indexOf(start), page.indexOf(end, page.indexOf(start)));

  it("Withdraw is a confirm, and passes who the invite was to", () => {
    const btn = slice("<ConfirmButton size=\"sm\" variant=\"ghost\" disabled={withdraw.isPending}", "</ConfirmButton>");
    expect(btn).toContain("onConfirm={() => withdraw.mutate({");
    expect(btn).toContain("recipient: [inv.invited_user_public_identifier, inv.invited_user]");
    expect(page.split("withdraw.mutate(").length - 1).toBe(1);
  });

  it("Publish is a confirm", () => {
    const btn = slice('title="Publish this post to LinkedIn?"', "</ConfirmButton>");
    expect(btn).toContain("onConfirm={() => createLinkedInPost.mutate({ text: postBody.trim() })}");
    expect(page.split("createLinkedInPost.mutate(").length - 1).toBe(1);
  });

  it("a comment, by Enter or by Post, goes through the confirm", () => {
    const fn = slice("const postComment = (socialId: string) => {", "const lookupPosts = async () => {");
    expect(fn).toContain("confirmAction({");
    expect(fn).toContain("() => commentPost.mutate({ socialId, text })");
    expect(page.split("commentPost.mutate(").length - 1).toBe(1);
    expect(page).toContain('if (e.key === "Enter" && commentText.trim()) { e.preventDefault(); postComment(String(sid)); }');
    expect(page).toContain("onClick={() => postComment(String(sid))}>Post</Button>");
  });
});
