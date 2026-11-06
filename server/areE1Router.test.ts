/**
 * Revenue Engine procedures (audit 2026-10-20, batch E1).
 *
 *   A69 approveBatch, which approved any row whatever its state and which no
 *       screen called, is gone
 *   A75 re-evaluating one prospect uses the campaign's approve line, not a
 *       hard-coded 70, and only a workspace admin (not a platform role) may
 *       delete someone else's note
 *   A11 Re-evaluate All re-scores only the engine's own score rejections, keeps
 *       why they were rejected, and runs in the background with real progress
 *   A31 a campaign's first launch asks for the workspace's time zone while it
 *       is still the UTC default
 *
 * Through the real procedures against the SQL-evaluating fake, with a real
 * member table, so each caller's role is the one on their row.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => {
  if (!process.env.ENCRYPTION_KEY && !process.env.JWT_SECRET) process.env.ENCRYPTION_KEY = "b".repeat(64);
  return { db: null as any, score: 80 as number | null, scored: [] as number[] };
});

vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));
vi.mock("./audit", async (a) => ({ ...(await a<typeof import("./audit")>()), recordAudit: async () => {} }));
vi.mock("./_core/llm", async (a) => ({
  ...(await a<typeof import("./_core/llm")>()),
  invokeLLM: async () => {
    h.scored.push(1);
    if (h.score == null) return { choices: [{ message: { content: "" } }] };
    return { choices: [{ message: { content: JSON.stringify({ industry: 15, title: 15, companySize: 15, geography: 15, antiPatternPenalty: 0, total: h.score }) } }] };
  },
}));

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { appRouter } from "./routers";

const WS = 2;
const ADMIN = 20;
const REP = 21;
const rows = (t: string) => h.db.rowsOf(t) as any[];
const find = (t: string, id: number) => rows(t).find((r) => r.id === id);
const caller = (userId: number, platformRole = "user") => appRouter.createCaller({
  user: { id: userId, openId: `u${userId}`, email: `u${userId}@example.com`, name: `U${userId}`, loginMethod: "password", role: platformRole, createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date(), mfaTotpEnabledAt: null },
  req: { protocol: "https", headers: { "x-workspace-id": String(WS) } },
  res: { clearCookie: () => {} },
} as unknown as TrpcContext);
async function code(p: Promise<unknown>) {
  try { await p; } catch (e: any) { return e.code as string; }
  return "OK";
}

beforeEach(() => {
  h.db = makeSqlFakeDb({ realMembers: true });
  h.score = 80;
  h.scored = [];
  const user = (id: number) => ({ id, openId: `u${id}`, email: `u${id}@example.com`, name: `U${id}`, loginMethod: "password", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date(), mfaTotpEnabledAt: null });
  rows("users").push(user(ADMIN), user(REP));
  rows("workspaces").push({ id: WS, name: "LSI", slug: "lsi", ownerUserId: ADMIN, archivedAt: null, plan: "trial" });
  const member = (id: number, userId: number, role: string) => ({ id, workspaceId: WS, userId, role, deactivatedAt: null, inviteToken: null, lastActiveAt: new Date() });
  rows("workspace_members").push(member(1, ADMIN, "admin"), member(2, REP, "rep"));
  rows("workspace_settings").push({ workspaceId: WS, enforce2fa: false, timezone: "America/New_York" });
  rows("icp_profiles").push({ id: 1, workspaceId: WS, isActive: true, targetTitles: ["County Administrator"], targetIndustries: [], targetGeographies: [], antiPatterns: [] });
  rows("are_campaigns").push({ id: 7, workspaceId: WS, name: "Counties", status: "active", autoApproveThreshold: 85, icpOverrides: {}, ownerUserId: ADMIN });
});

describe("approveBatch (A69)", () => {
  it("is not a procedure any more", () => {
    const procs = Object.keys((appRouter as any)._def.procedures);
    expect(procs).toContain("are.campaigns.approveAllPending");
    expect(procs).not.toContain("are.campaigns.approveBatch");
  });
});
