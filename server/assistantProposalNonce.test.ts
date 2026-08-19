/**
 * The AI Assistant's confirm card is a SERVER-enforced gate (0168).
 *
 * Before: confirmAction took {tool, args} from the client — safe for privilege
 * (it runs as the caller) but any client code could "confirm" an action the
 * assistant never proposed, with any args. Now the server writes a proposal
 * row when the model calls a mutating tool, the client holds only a nonce,
 * and confirm/decline consume that row atomically — one outcome, once, inside
 * its TTL — executing the STORED args.
 *
 * Driven through the REAL procedures via appRouter.createCaller against a
 * fake db (prospectVerifyEmail.test.ts pattern). The fake captures every
 * update's SET and WHERE (rendered to SQL text) so the consume-first order
 * and the ownership scoping are asserted from what would hit the database.
 */
import { describe, it, expect, vi } from "vitest";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { aiAssistantProposals } from "../drizzle/schema";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => ({ db: null as any }));
vi.mock("./db", async (importActual) => ({
  ...(await importActual<typeof import("./db")>()),
  getDb: async () => h.db,
}));

import { appRouter } from "./routers";

const dialect = new MySqlDialect();
const render = (x: unknown) => dialect.sqlToQuery(x as any);

const WS = { id: 4, name: "CommunityForce" };
type Cap = { selects: string[]; updates: Array<{ set: Record<string, unknown>; where: string }>; affected: number; failExecution?: boolean };

function makeDb(proposal: Record<string, unknown> | null, cap: Cap) {
  const builder = () => {
    const st: { table?: unknown; joined: boolean } = { joined: false };
    const b: any = {
      from(t: unknown) { st.table = t; return b; },
      innerJoin() { st.joined = true; return b; },
      where(cond: unknown) { if (st.table === aiAssistantProposals) cap.selects.push(render(cond).sql); return b; },
      limit() { return b; },
      orderBy() { return b; },
      then(res: (v: unknown) => void) {
        if (st.joined) {
          res([{
            ws: { ...WS, ownerUserId: 1, archivedAt: null },
            mb: { id: 1, userId: 1, workspaceId: WS.id, role: "manager", deactivatedAt: null, lastActiveAt: new Date() },
          }]);
        } else if (st.table === aiAssistantProposals) res(proposal ? [proposal] : []);
        else res([]);
      },
    };
    return b;
  };
  return {
    select: () => builder(),
    update: () => ({
      set: (v: Record<string, unknown>) => ({
        where: (cond: unknown) => {
          cap.updates.push({ set: v, where: render(cond).sql });
          // Proposal-row writes carry outcome/resultSummary; anything else is
          // the underlying action (here: the campaign status write).
          const isProposalWrite = "outcome" in v || "resultSummary" in v;
          if (cap.failExecution && !isProposalWrite) return Promise.reject(new Error("simulated execution failure"));
          return Promise.resolve([{ affectedRows: cap.affected }]);
        },
      }),
    }),
    insert: () => ({ values: async () => undefined }),
  };
}

function makeCtx(): TrpcContext {
  return {
    user: { id: 1, openId: "u", email: "u@example.com", name: "U", loginMethod: "manus", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
    req: { protocol: "https", headers: { "x-workspace-id": "4" } },
    res: { clearCookie: () => {} },
  } as unknown as TrpcContext;
}

const NONCE = "abcdefghijklmnopqrstuvwxyz012345";
const fresh = () => ({
  id: 77, workspaceId: 4, userId: 1, conversationId: 9, nonce: NONCE,
  tool: "set_campaign_status", args: { campaignId: 21, status: "paused" },
  description: "Set campaign #21 to PAUSED",
  expiresAt: new Date(Date.now() + 10 * 60 * 1000), consumedAt: null, outcome: null, resultSummary: null, createdAt: new Date(),
});

describe("assistant.confirmAction — nonce gate", () => {
  it("an unknown nonce is NOT_FOUND, and the lookup is scoped to this user and workspace", async () => {
    const cap: Cap = { selects: [], updates: [], affected: 1 };
    h.db = makeDb(null, cap);
    await expect(appRouter.createCaller(makeCtx()).assistant.confirmAction({ nonce: NONCE })).rejects.toThrow(/isn't in this conversation/);
    expect(cap.selects[0]).toContain("`ai_assistant_proposals`.`nonce` = ?");
    expect(cap.selects[0]).toContain("`ai_assistant_proposals`.`workspaceId` = ?");
    expect(cap.selects[0]).toContain("`ai_assistant_proposals`.`userId` = ?");
    expect(cap.updates).toEqual([]);
  });

  it("an already-answered proposal cannot be confirmed again", async () => {
    const cap: Cap = { selects: [], updates: [], affected: 1 };
    h.db = makeDb({ ...fresh(), consumedAt: new Date(), outcome: "declined" }, cap);
    await expect(appRouter.createCaller(makeCtx()).assistant.confirmAction({ nonce: NONCE })).rejects.toThrow(/already declined/);
    expect(cap.updates).toEqual([]);
  });

  it("an expired proposal cannot be confirmed", async () => {
    const cap: Cap = { selects: [], updates: [], affected: 1 };
    h.db = makeDb({ ...fresh(), expiresAt: new Date(Date.now() - 1000) }, cap);
    await expect(appRouter.createCaller(makeCtx()).assistant.confirmAction({ nonce: NONCE })).rejects.toThrow(/expired/);
    expect(cap.updates).toEqual([]);
  });

  it("a fresh proposal is CONSUMED FIRST (conditional on consumedAt IS NULL), then the STORED args execute, then the result lands on the row", async () => {
    const cap: Cap = { selects: [], updates: [], affected: 1 };
    h.db = makeDb(fresh(), cap);
    const r = await appRouter.createCaller(makeCtx()).assistant.confirmAction({ nonce: NONCE });
    expect(r).toEqual({ ok: true, summary: "Campaign #21 is now paused" }); // args came from the row, not the client
    const first = cap.updates[0];
    expect(first.set).toMatchObject({ outcome: "confirmed" });
    expect(first.set.consumedAt).toBeInstanceOf(Date);
    expect(first.where).toContain("`ai_assistant_proposals`.`id` = ?");
    expect(first.where).toContain("`ai_assistant_proposals`.`consumedAt` is null");
    const last = cap.updates[cap.updates.length - 1];
    expect(last.set).toMatchObject({ resultSummary: "Campaign #21 is now paused" });
  });

  it("a failed execution stays consumed (never re-runnable blind) and is recorded as failed", async () => {
    const cap: Cap = { selects: [], updates: [], affected: 1, failExecution: true };
    h.db = makeDb(fresh(), cap);
    await expect(appRouter.createCaller(makeCtx()).assistant.confirmAction({ nonce: NONCE })).rejects.toThrow(/simulated execution failure/);
    expect(cap.updates[0].set).toMatchObject({ outcome: "confirmed" });
    const last = cap.updates[cap.updates.length - 1];
    expect(last.set).toMatchObject({ outcome: "failed" });
    expect(String(last.set.resultSummary)).toContain("simulated execution failure");
  });

  it("losing the consume race (0 rows flipped) stops before anything executes", async () => {
    const cap: Cap = { selects: [], updates: [], affected: 0 };
    h.db = makeDb(fresh(), cap);
    await expect(appRouter.createCaller(makeCtx()).assistant.confirmAction({ nonce: NONCE })).rejects.toThrow(/already answered/);
    expect(cap.updates).toHaveLength(1); // only the attempted consume
  });

  it("the client cannot supply tool or args any more — the input is the nonce alone", async () => {
    const cap: Cap = { selects: [], updates: [], affected: 1 };
    h.db = makeDb(null, cap);
    await expect(appRouter.createCaller(makeCtx()).assistant.confirmAction({ tool: "set_campaign_status", args: { campaignId: 1, status: "active" } } as never)).rejects.toThrow();
  });
});

describe("assistant.declineAction", () => {
  it("consumes the proposal as declined, scoped to user + workspace + not-yet-answered", async () => {
    const cap: Cap = { selects: [], updates: [], affected: 1 };
    h.db = makeDb(fresh(), cap);
    const r = await appRouter.createCaller(makeCtx()).assistant.declineAction({ nonce: NONCE });
    expect(r).toEqual({ ok: true });
    expect(cap.updates[0].set).toMatchObject({ outcome: "declined" });
    expect(cap.updates[0].where).toContain("`ai_assistant_proposals`.`nonce` = ?");
    expect(cap.updates[0].where).toContain("`ai_assistant_proposals`.`userId` = ?");
    expect(cap.updates[0].where).toContain("`ai_assistant_proposals`.`consumedAt` is null");
  });
});

describe("migration 0168 is declared in both places", () => {
  it("schema table + rawMigrations entry, with the unique nonce index", async () => {
    const { readFileSync } = await import("node:fs");
    const schema = readFileSync("drizzle/schema.ts", "utf8");
    const mig = readFileSync("server/_core/rawMigrations.ts", "utf8");
    expect(schema.replace(/\r\n/g, "\n")).toContain('mysqlTable(\n  "ai_assistant_proposals"');
    expect(mig).toContain('name: "0168_ai_assistant_proposals.sql"');
    expect(mig).toContain("CREATE UNIQUE INDEX `ix_aap_nonce` ON `ai_assistant_proposals` (`nonce`)");
  });
});
