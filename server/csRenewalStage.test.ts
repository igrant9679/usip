/**
 * cs.* returns the DERIVED renewal stage, and an amendment is the only way to
 * reach an outcome — both through the real procedures via createCaller.
 *
 * The stored customers.renewalStage never moved: wonToCustomer stamps "early"
 * when the deal is won and nothing in the product has ever updated it since.
 * So the fix lives on the read side, and it has to be on ALL FOUR reads, not
 * just the board — services/assistantActionCatalog.ts puts `cs` in
 * ALLOWED_GROUPS, so cs.list, cs.get, cs.kpis and cs.renewalsBoard are all live
 * AI-Assistant read actions. A board that is right while the assistant says
 * "early" is a worse failure than one that is wrong everywhere, because only
 * one of the two is discoverable.
 *
 * addAmendment is the other half: `renewed` and `churned` are engine-immutable
 * outcomes, so if nothing writes them they are unreachable columns. It also has
 * to roll the contract by the customer's OWN term — contract_amendments has no
 * term field, but contractStart/contractEnd already encode one, and a hardcoded
 * 365 days silently converts a two-year customer to annual.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { accounts, customers } from "../drizzle/schema";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => ({ db: null as any }));

vi.mock("./db", async (importActual) => ({
  ...(await importActual<typeof import("./db")>()),
  getDb: async () => h.db,
}));

import { appRouter } from "./routers";

const WS = { id: 7, name: "Acme Corp" };
const dialect = new MySqlDialect();
const render = (x: unknown) => dialect.sqlToQuery(x as any);
const daysOut = (d: number) => new Date(Date.now() + d * 86400000);

type Cap = {
  updates: Array<{ set?: Record<string, unknown>; where?: unknown }>;
  inserts: Array<{ table: unknown; values: unknown }>;
};

/** A customer row with the columns cs.* actually reads. */
function customer(over: Record<string, unknown>) {
  return {
    id: 1, workspaceId: WS.id, accountId: 1, arr: "120000",
    contractStart: daysOut(-360), contractEnd: daysOut(5),
    tier: "midmarket", cmUserId: 1,
    healthScore: 70, healthTier: "watch",
    usageScore: 70, engagementScore: 70, supportScore: 70,
    npsScore: 20, npsHistory: [], expansionPotential: "0", aiPlay: null,
    churnRiskScore: null, churnRiskLabel: null, churnRiskRationale: null, churnRiskScoredAt: null,
    renewalStage: "early",
    createdAt: new Date(), updatedAt: new Date(),
    ...over,
  };
}

function makeDb(rows: unknown[], cap: Cap, role = "rep") {
  const builder = () => {
    const st: { table?: unknown; joined: boolean } = { joined: false };
    const b: any = {
      from(t: unknown) { st.table = t; return b; },
      innerJoin() { st.joined = true; return b; },
      where() { return b; },
      orderBy() { return b; },
      limit() { return b; },
      then(res: (v: unknown) => void, rej: (e: unknown) => void) {
        if (st.joined) {
          // lastActiveAt fresh, so the middleware's touch-update never fires
          // and every captured update belongs to the procedure under test.
          res([{
            ws: { ...WS, ownerUserId: 1, archivedAt: null },
            mb: { id: 1, userId: 1, workspaceId: WS.id, role, deactivatedAt: null, lastActiveAt: new Date() },
          }]);
        } else if (st.table === customers) {
          res(rows);
        } else if (st.table === accounts) {
          res([{ id: 1, workspaceId: WS.id, name: "Acme Corp" }]);
        } else {
          res([]);
        }
      },
    };
    return b;
  };
  return {
    select: () => builder(),
    insert: (t: unknown) => ({
      values(v: unknown) { cap.inserts.push({ table: t, values: v }); return Promise.resolve([{ insertId: 42 }]); },
    }),
    update: () => {
      const u: { set?: Record<string, unknown>; where?: unknown } = {};
      const b: any = {
        set(v: Record<string, unknown>) { u.set = v; return b; },
        where(c: unknown) { u.where = c; cap.updates.push(u); return Promise.resolve([]); },
      };
      return b;
    },
  };
}

function makeCtx(): TrpcContext {
  return {
    user: {
      id: 1, openId: "user-1", email: "u1@example.com", name: "User 1",
      loginMethod: "manus", role: "user",
      createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date(),
    },
    req: { protocol: "https", headers: {} },
    res: { clearCookie: () => {} },
  } as unknown as TrpcContext;
}

let cap: Cap;
beforeEach(() => { cap = { updates: [], inserts: [] }; });

describe("every cs read derives the stage", () => {
  it("renewalsBoard: a stored 'early' five days out comes back as 'thirty'", async () => {
    h.db = makeDb([customer({ renewalStage: "early", contractEnd: daysOut(5) })], cap);
    const out = await appRouter.createCaller(makeCtx()).cs.renewalsBoard();
    expect(out[0]!.renewalStage).toBe("thirty");
  });

  it("list: the same row, same answer — the assistant reads this one", async () => {
    h.db = makeDb([customer({ renewalStage: "early", contractEnd: daysOut(5) })], cap);
    const out = await appRouter.createCaller(makeCtx()).cs.list();
    expect(out[0]!.renewalStage).toBe("thirty");
  });

  it("get: the single-record read agrees with the board", async () => {
    h.db = makeDb([customer({ renewalStage: "early", contractEnd: daysOut(75) })], cap);
    const out = await appRouter.createCaller(makeCtx()).cs.get({ id: 1 });
    expect(out!.renewalStage).toBe("ninety");
  });

  it("a recorded outcome survives the read path untouched", async () => {
    h.db = makeDb([customer({ renewalStage: "churned", contractEnd: daysOut(-20) })], cap);
    const out = await appRouter.createCaller(makeCtx()).cs.renewalsBoard();
    expect(out[0]!.renewalStage).toBe("churned");
  });
});

describe("cs.kpis", () => {
  it("renewing90 counts the derived set, not the frozen column", async () => {
    // Every row stored "early" — which is exactly the production shape, since
    // nothing ever moved the column. Before the derivation this returned 0.
    h.db = makeDb([
      customer({ id: 1, renewalStage: "early", contractEnd: daysOut(5) }),
      customer({ id: 2, renewalStage: "early", contractEnd: daysOut(75) }),
      customer({ id: 3, renewalStage: "early", contractEnd: daysOut(-10) }),
      customer({ id: 4, renewalStage: "early", contractEnd: daysOut(300) }),
      customer({ id: 5, renewalStage: "renewed", contractEnd: daysOut(-400) }),
    ], cap);
    const out = await appRouter.createCaller(makeCtx()).cs.kpis();
    expect(out!.renewing90).toBe(3);
  });

  it("returns the same keys it always did", async () => {
    // Customers.tsx and DashboardHome2.tsx read `renewing90` off this object;
    // the derivation changes the VALUE, never the shape.
    h.db = makeDb([customer({})], cap);
    const out = await appRouter.createCaller(makeCtx()).cs.kpis();
    expect(Object.keys(out!).sort()).toEqual(
      ["arr", "atRisk", "avgNps", "expansion", "npsBand", "renewing90", "total"],
    );
  });
});

describe("addAmendment is the only road to an outcome", () => {
  it("a renewal rolls the contract by the customer's OWN term", async () => {
    // Two-year customer: a hardcoded 365d would quietly make them annual.
    const start = daysOut(-725);
    const end = daysOut(5);
    h.db = makeDb([customer({ contractStart: start, contractEnd: end })], cap);

    await appRouter.createCaller(makeCtx()).cs.addAmendment({
      customerId: 1, type: "renewal", arrDelta: 10000,
      effectiveAt: new Date().toISOString(),
    });

    expect(cap.updates).toHaveLength(1); // one statement, not one per field
    const set = cap.updates[0]!.set!;
    expect(set.arr).toBe("130000");
    expect((set.contractStart as Date).getTime()).toBe(end.getTime());
    const term = (set.contractEnd as Date).getTime() - (set.contractStart as Date).getTime();
    expect(Math.round(term / 86400000)).toBe(730);
    // The new end is ~2 years out, so the derived stage is "early" — but it is
    // DERIVED: a back-dated effectiveAt can legitimately land inside 90 days.
    expect(set.renewalStage).toBe("early");
  });

  it("a renewal that lands inside 90 days is not called 'early'", async () => {
    // effectiveAt is caller-supplied and routinely back-dated (seed.ts writes
    // amendments 30-200 days in the past), so the rolled end date can be close.
    const start = daysOut(-380);
    const end = daysOut(-320);
    h.db = makeDb([customer({ contractStart: start, contractEnd: end })], cap);

    await appRouter.createCaller(makeCtx()).cs.addAmendment({
      customerId: 1, type: "renewal", arrDelta: 0,
      effectiveAt: new Date().toISOString(),
    });
    // 60-day term rolled off an end date 320 days ago → still in the past.
    expect(cap.updates[0]!.set!.renewalStage).toBe("at_risk");
  });

  it("a termination churns the customer and stamps the end date", async () => {
    const eff = daysOut(-3);
    h.db = makeDb([customer({})], cap);

    await appRouter.createCaller(makeCtx()).cs.addAmendment({
      customerId: 1, type: "termination", arrDelta: -120000,
      effectiveAt: eff.toISOString(),
    });

    const set = cap.updates[0]!.set!;
    expect(set.renewalStage).toBe("churned");
    expect((set.contractEnd as Date).getTime()).toBe(eff.getTime());
    expect(set.arr).toBe("0");
  });

  it("an amendment that is neither leaves the contract alone", async () => {
    h.db = makeDb([customer({})], cap);
    await appRouter.createCaller(makeCtx()).cs.addAmendment({
      customerId: 1, type: "upgrade", arrDelta: 5000,
      effectiveAt: new Date().toISOString(),
    });
    expect(cap.updates[0]!.set).toEqual({ arr: "125000" });
  });

  it("the write stays inside the caller's workspace", async () => {
    h.db = makeDb([customer({})], cap);
    await appRouter.createCaller(makeCtx()).cs.addAmendment({
      customerId: 1, type: "renewal", arrDelta: 0,
      effectiveAt: new Date().toISOString(),
    });
    const where = render(cap.updates[0]!.where);
    expect(where.sql).toContain("`customers`.`workspaceId` = ?");
    expect(where.params).toEqual([1, WS.id]);
  });
});
