/**
 * Outreach ownership checks (audit 2026-10-20, O31, O32, O33).
 *
 *   O31 · a test call respects the AI-calls switch and won't ring a number
 *         that belongs to someone in the workspace's records
 *   O32 · a chat is read only through one of the caller's own accounts here,
 *         and an explicit LinkedIn account must be this workspace's
 *   O33 · removing a Unipile account turns its bridged mailbox off, and the
 *         send fallback never picks another rep's bridged mailbox or an
 *         account from another workspace. Every change here can only stop a
 *         send (outbound is paused on workspaces 2, 4 and 5).
 *
 * Procedures run against the SQL-evaluating fake; vendors are mocked and
 * record what they were asked. The sender selection is DB-backed, so it is
 * pinned over the source, as senderFallback.test.ts does.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => {
  if (!process.env.ENCRYPTION_KEY && !process.env.JWT_SECRET) process.env.ENCRYPTION_KEY = "b".repeat(64);
  return { db: null as any, role: "admin", dialed: [] as string[], vendor: [] as string[], messages: [] as Array<{ account_id: string }> };
});

vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));
vi.mock("./audit", async (a) => ({ ...(await a<typeof import("./audit")>()), recordAudit: async () => {} }));
vi.mock("./services/plivo", async (a) => ({
  ...(await a<typeof import("./services/plivo")>()),
  plivoCreds: async () => ({ authId: "test", authToken: "test" }),
  placeCall: async (_c: unknown, p: { to: string }) => { h.dialed.push(p.to); return { requestUuid: "r" }; },
}));
vi.mock("./services/voiceGuards", async (a) => ({ ...(await a<typeof import("./services/voiceGuards")>()), admitInboundCall: async () => ({ ok: true }) }));
vi.mock("./lib/unipile", async (a) => ({
  ...(await a<typeof import("./lib/unipile")>()),
  getChatMessages: async (chatId: string) => { h.vendor.push(`messages:${chatId}`); return { items: h.messages }; },
  cancelSentInvitation: async (p: { accountId: string }) => { h.vendor.push(`withdraw:${p.accountId}`); },
  deleteUnipileAccount: async (id: string) => { h.vendor.push(`delete:${id}`); },
}));

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { appRouter } from "./routers";

const WS = 2, FOREIGN = 9, ME = 1, ANN = 21;
const root = join(__dirname, "..");
const rows = (t: string) => h.db.rowsOf(t) as any[];
const caller = () => appRouter.createCaller({
  user: { id: ME, openId: "u", email: "o@example.com", name: "O", loginMethod: "password", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
  req: { protocol: "https", headers: { "x-workspace-id": String(WS) } },
  res: { clearCookie: () => {} },
} as unknown as TrpcContext);

beforeEach(() => {
  h.role = "admin";
  h.dialed = [];
  h.vendor = [];
  h.messages = [];
  h.db = makeSqlFakeDb({ roles: new Proxy({}, { get: (_t, k) => (Number(k) === WS ? h.role : undefined) }) as Record<number, string>, wsId: () => WS });
  rows("workspaces").push({ id: WS, name: "W", slug: "w", ownerUserId: ME, archivedAt: null, plan: "trial" });
});

describe("O31: test calls", () => {
  beforeEach(() => {
    rows("voice_agents").push({ id: 5, workspaceId: WS, name: "Eve", purpose: "outbound_outreach", plivoNumber: "+15715550111", plivoExtraNumbers: null, status: "active" });
    rows("workspace_settings").push({ id: 1, workspaceId: WS, aiCallsPausedAt: null });
    rows("prospects").push({ id: 40, workspaceId: WS, firstName: "P", phone: "(571) 555-0177" });
    rows("leads").push({ id: 41, workspaceId: WS, firstName: "L", phone: "571.555.0188" });
    // Another workspace's person with this number is not this workspace's record.
    rows("prospects").push({ id: 42, workspaceId: FOREIGN, firstName: "F", phone: "+1 571 555 0199" });
  });

  it("are refused while AI calls are paused, before anything dials", async () => {
    rows("workspace_settings")[0].aiCallsPausedAt = new Date();
    await expect(caller().aiCalls.testCall({ agentId: 5, toNumber: "+1 571 555 0100" })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(h.dialed).toEqual([]);
    expect(rows("voice_calls")).toHaveLength(0);
  });

  it("won't ring a person in People or a lead, however their number is written", async () => {
    await expect(caller().aiCalls.testCall({ agentId: 5, toNumber: "571-555-0177" })).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining("a person in People") });
    await expect(caller().aiCalls.testCall({ agentId: 5, toNumber: "+15715550188" })).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining("a lead") });
    expect(h.dialed).toEqual([]);
  });

  it("rings the tester's own number, and one that is only another workspace's", async () => {
    await caller().aiCalls.testCall({ agentId: 5, toNumber: "+1 571 555 0100" });
    await caller().aiCalls.testCall({ agentId: 5, toNumber: "571 555 0199" });
    expect(h.dialed).toEqual(["+15715550100", "+15715550199"]);
  });

  it("the dialog says so and waits while AI calls are paused", () => {
    const src = readFileSync(join(root, "client/src/components/usip/settings/VoiceAgentsSection.tsx"), "utf8");
    expect(src).toContain("const paused = !!trpc.voiceAgents.plivoStatus.useQuery(undefined, { enabled: open }).data?.aiCallsPausedAt;");
    expect(src).toContain("disabled={!number.trim() || call.isPending || paused}");
  });
});

describe("O32: chats and LinkedIn accounts are the caller's own, here", () => {
  beforeEach(() => {
    rows("unipile_accounts").push(
      { id: 1, workspaceId: WS, userId: ME, unipileAccountId: "acc-mine", provider: "LINKEDIN" },
      { id: 2, workspaceId: FOREIGN, userId: ME, unipileAccountId: "acc-mine-elsewhere", provider: "LINKEDIN" },
      { id: 3, workspaceId: WS, userId: ANN, unipileAccountId: "acc-ann", provider: "LINKEDIN" },
    );
  });

  it("a chat on the caller's own account reads", async () => {
    h.messages = [{ account_id: "acc-mine" }];
    expect((await caller().unipile.getChatMessages({ chatId: "c1" })).items).toHaveLength(1);
  });

  it("a chat on someone else's account is refused", async () => {
    h.messages = [{ account_id: "acc-ann" }];
    await expect(caller().unipile.getChatMessages({ chatId: "c2" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    h.messages = [{ account_id: "acc-mine-elsewhere" }];
    await expect(caller().unipile.getChatMessages({ chatId: "c3" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("someone with no account here reads nothing, and the vendor isn't asked", async () => {
    rows("unipile_accounts").splice(0, 1);
    h.messages = [{ account_id: "acc-ann" }];
    expect(await caller().unipile.getChatMessages({ chatId: "c4" })).toEqual({ items: [] });
    expect(h.vendor).toEqual([]);
  });

  it("an explicit account from another workspace is not the caller's here", async () => {
    await expect(caller().unipile.withdrawInvitation({ invitationId: "i1", unipileAccountId: "acc-mine-elsewhere" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await caller().unipile.withdrawInvitation({ invitationId: "i1", unipileAccountId: "acc-mine" });
    expect(h.vendor).toEqual(["withdraw:acc-mine"]);
  });
});

describe("O33: removing a Unipile account", () => {
  beforeEach(() => {
    rows("unipile_accounts").push(
      { id: 1, workspaceId: WS, userId: ME, unipileAccountId: "acc-ms", provider: "OUTLOOK" },
      { id: 2, workspaceId: FOREIGN, userId: ME, unipileAccountId: "acc-ms-elsewhere", provider: "OUTLOOK" },
    );
    rows("sending_accounts").push(
      { id: 10, workspaceId: WS, name: "Mine", fromEmail: "me@acme.example", provider: "outlook_oauth", unipileAccountId: "acc-ms", enabled: true },
      { id: 11, workspaceId: WS, name: "SMTP", fromEmail: "team@acme.example", provider: "generic_smtp", unipileAccountId: null, enabled: true },
      { id: 12, workspaceId: FOREIGN, name: "Theirs", fromEmail: "me@else.example", provider: "outlook_oauth", unipileAccountId: "acc-ms", enabled: true },
    );
  });

  it("turns its bridged mailbox off, here only, and leaves the rest", async () => {
    await caller().unipile.disconnectAccount({ unipileAccountId: "acc-ms" });
    const byId = (id: number) => rows("sending_accounts").find((r) => r.id === id);
    expect(byId(10).enabled).toBe(false);
    expect(byId(11).enabled).toBe(true);
    expect(byId(12).enabled).toBe(true);
    expect(rows("unipile_accounts").map((r) => r.id)).toEqual([2]);
  });

  it("an account connected in another workspace can't be removed from here", async () => {
    await expect(caller().unipile.disconnectAccount({ unipileAccountId: "acc-ms-elsewhere" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(h.vendor).toEqual([]);
  });

  it("the send fallbacks pick no other workspace's account and no other rep's bridged mailbox", () => {
    const strip = (s: string) => s.replace(/^\s*\/\*[\s\S]*?\*\//gm, "").replace(/^\s*\/\/.*$/gm, "");
    const src = strip(readFileSync(join(root, "server/routers/sequences.ts"), "utf8").replace(/\r\n/g, "\n"));
    const at = src.indexOf("let fromAccount: typeof sendingAccounts.$inferSelect | undefined;");
    expect(at).toBeGreaterThan(0);
    const resolution = src.slice(at, src.indexOf("const adapter = createEmailAdapter(fromAccount);", at));
    const personal = resolution.slice(resolution.indexOf("const [personal]"), resolution.indexOf("if (personal) fromAccount"));
    expect(personal).toContain("eq(unipileAccounts.workspaceId, workspaceId)");
    expect(personal).toContain("eq(unipileAccounts.userId, userId)");
    const fallback = resolution.slice(resolution.indexOf("const [fallback]"), resolution.indexOf("if (fallback) fromAccount"));
    expect(fallback).toContain("isNull(sendingAccounts.unipileAccountId)");
    expect(fallback).toContain("eq(sendingAccounts.enabled, true)");
  });
});
