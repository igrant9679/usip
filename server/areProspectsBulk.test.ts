/**
 * are.prospects.bulk — mass actions on a campaign's prospects (owner ask
 * 2026-08-19). Driven through the REAL procedure via appRouter.createCaller
 * against a fake db (prospectVerifyEmail.test.ts pattern). The points that
 * matter:
 *
 *  - ids that are not rows of THIS campaign are rejected before anything runs;
 *  - campaign-state actions delegate to the existing single-row procedure
 *    (so `approve` here IS `are.prospects.approve`, per id);
 *  - `restore` only touches rejected rows and reports the rest as failures,
 *    never rounded up;
 *  - `suppress` writes BOTH ledgers — the ARE suppression list and the
 *    site-wide email_suppressions — and the run is audited.
 */
import { describe, it, expect, vi } from "vitest";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { prospectQueue, emailSuppressions, areSuppressionList, areEngineLogs, auditLog } from "../drizzle/schema";
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

type Cap = { updates: Array<{ table: string; set: Record<string, unknown>; where: string }>; inserts: Array<{ table: string; values: unknown }> };
const tname = (t: unknown) => String((t as any)?.[Symbol.for("drizzle:Name")] ?? "?");

function makeDb(queueRows: Array<Record<string, unknown>>, cap: Cap) {
  const builder = () => {
    const st: { table?: unknown; joined: boolean; params: unknown[] } = { joined: false, params: [] };
    const b: any = {
      from(t: unknown) { st.table = t; return b; },
      innerJoin() { st.joined = true; return b; },
      leftJoin() { return b; },
      where(cond: unknown) { st.params = render(cond).params; return b; },
      limit() { return b; }, orderBy() { return b; }, groupBy() { return b; },
      then(res: (v: unknown) => void) {
        if (st.joined) {
          res([{ ws: { ...WS, ownerUserId: 1, archivedAt: null }, mb: { id: 1, userId: 1, workspaceId: WS.id, role: "manager", deactivatedAt: null, lastActiveAt: new Date() } }]);
        } else if (st.table === prospectQueue) {
          // Return the rows whose id is among the bound params (the IN list / eq id).
          const ids = st.params.filter((p) => typeof p === "number");
          res(queueRows.filter((r) => ids.includes(r.id as number)));
        } else res([]);
      },
    };
    return b;
  };
  return {
    select: () => builder(),
    update: (t: unknown) => ({ set: (v: Record<string, unknown>) => ({ where: async (cond: unknown) => { cap.updates.push({ table: tname(t), set: v, where: render(cond).sql }); return [{ affectedRows: 1 }]; } }) }),
    insert: (t: unknown) => ({ values: async (v: unknown) => { cap.inserts.push({ table: tname(t), values: v }); return [{ insertId: 1 }]; } }),
  };
}
function makeCtx(): TrpcContext {
  return {
    user: { id: 1, openId: "u", email: "u@example.com", name: "U", loginMethod: "manus", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
    req: { protocol: "https", headers: { "x-workspace-id": "4" } },
    res: { clearCookie: () => {} },
  } as unknown as TrpcContext;
}

const row = (id: number, extra: Record<string, unknown> = {}) => ({
  id, workspaceId: 4, campaignId: 21, firstName: "Pat", lastName: `Person${id}`, email: `p${id}@example.org`, linkedinUrl: null,
  sequenceStatus: "pending", rejectedAt: null, rejectionReason: null, personProspectId: null, icpMatchScore: 80, ...extra,
});

describe("are.prospects.bulk", () => {
  it("rejects ids that are not rows of this campaign before anything runs", async () => {
    const cap: Cap = { updates: [], inserts: [] };
    h.db = makeDb([row(1)], cap);
    await expect(appRouter.createCaller(makeCtx()).are.prospects.bulk({ campaignId: 21, prospectIds: [1, 999], action: "approve" }))
      .rejects.toThrow(/not in this campaign/);
    expect(cap.updates).toEqual([]);
  });

  it("approve delegates to the single-row procedure per id and audits + logs the run", async () => {
    const cap: Cap = { updates: [], inserts: [] };
    h.db = makeDb([row(1), row(2)], cap);
    const r = await appRouter.createCaller(makeCtx()).are.prospects.bulk({ campaignId: 21, prospectIds: [1, 2], action: "approve" });
    expect(r.ok).toBe(2);
    expect(r.failed).toEqual([]);
    expect(r.summary).toMatch(/Approved 2 prospects/);
    // Each id went through are.prospects.approve → an UPDATE on prospect_queue per row.
    const pqUpdates = cap.updates.filter((u) => u.table === "prospect_queue" && u.set.sequenceStatus === "approved");
    expect(pqUpdates.length).toBe(2);
    // One audit row + one campaign log line for the run.
    expect(cap.inserts.some((i) => i.table === tname(auditLog) && (i.values as any).entityType === "are_prospect_bulk")).toBe(true);
    expect(cap.inserts.some((i) => i.table === tname(areEngineLogs) && (i.values as any).phase === "bulk")).toBe(true);
  });

  it("restore only touches rejected rows and reports the rest as failures", async () => {
    const cap: Cap = { updates: [], inserts: [] };
    h.db = makeDb([row(1, { sequenceStatus: "skipped", rejectedAt: new Date(), rejectionReason: "Wrong industry" }), row(2, { sequenceStatus: "enrolled" })], cap);
    const r = await appRouter.createCaller(makeCtx()).are.prospects.bulk({ campaignId: 21, prospectIds: [1, 2], action: "restore", reason: "second look" });
    expect(r.ok).toBe(1);
    expect(r.failed).toEqual([{ id: 2, error: "not rejected (status enrolled)" }]);
    const u = cap.updates.find((x) => x.table === "prospect_queue");
    expect(u?.set).toMatchObject({ sequenceStatus: "pending", rejectedAt: null, rejectionReason: "Restored — second look" });
    expect(u?.where).toContain("`prospect_queue`.`id` = ?");
    expect(r.summary).toMatch(/Restored 1 prospect to pending; 1 failed/);
  });

  it("suppress writes the ARE list AND the site-wide email_suppressions, and cancels an enrolled sequence", async () => {
    const cap: Cap = { updates: [], inserts: [] };
    h.db = makeDb([row(1, { sequenceStatus: "enrolled" }), row(2, { email: null, linkedinUrl: null })], cap);
    const r = await appRouter.createCaller(makeCtx()).are.prospects.bulk({ campaignId: 21, prospectIds: [1, 2], action: "suppress", suppressionReason: "do_not_contact" });
    expect(r.ok).toBe(1);
    expect(r.failed).toEqual([{ id: 2, error: "no email or LinkedIn URL to suppress" }]);
    expect(cap.inserts.some((i) => i.table === tname(areSuppressionList))).toBe(true);
    const site = cap.inserts.find((i) => i.table === tname(emailSuppressions));
    expect(site).toBeTruthy();
    expect((site!.values as any)).toMatchObject({ workspaceId: 4, email: "p1@example.org", reason: "manual" });
    // The enrolled sequence was canceled through the single-row procedure.
    expect(cap.updates.some((u) => u.table === "prospect_queue" && u.set.sequenceStatus === "canceled")).toBe(true);
  });

  it("LLM-backed actions above a small batch return at once and run in the background (start line logged now, outcome + audit when done)", async () => {
    const cap: Cap = { updates: [], inserts: [] };
    const rows = Array.from({ length: 8 }, (_, i) => row(i + 1, { sequenceStatus: "pending" }));
    h.db = makeDb(rows, cap);
    const r = await appRouter.createCaller(makeCtx()).are.prospects.bulk({ campaignId: 21, prospectIds: rows.map((x) => x.id), action: "generateSequence" });
    expect(r.summary).toMatch(/Generating sequences for 8 prospects in the background/);
    // The "started" campaign log line is written before returning…
    expect(cap.inserts.some((i) => i.table === tname(areEngineLogs) && /running in the background/.test((i.values as any).message))).toBe(true);
    // …and the audit row is NOT yet (it is written when the background loop finishes).
    expect(cap.inserts.some((i) => i.table === tname(auditLog))).toBe(false);
  });

  it("the same action on a small batch runs inline and is audited on return", async () => {
    const cap: Cap = { updates: [], inserts: [] };
    h.db = makeDb([row(1, { sequenceStatus: "skipped", rejectedAt: new Date() })], cap);
    // reEvaluate on ONE row: inline path (≤5). The fake db lacks what the
    // real re-evaluation needs, so it fails per row — which is exactly the
    // honest outcome we want reported, and the audit still lands.
    const r = await appRouter.createCaller(makeCtx()).are.prospects.bulk({ campaignId: 21, prospectIds: [1], action: "reEvaluate" });
    expect(r.requested).toBe(1);
    expect(r.ok + r.failed.length).toBe(1);
    expect(cap.inserts.some((i) => i.table === tname(auditLog) && (i.values as any).entityType === "are_prospect_bulk")).toBe(true);
  });

  it("is manager-gated", async () => {
    const cap: Cap = { updates: [], inserts: [] };
    h.db = makeDb([row(1)], cap);
    // Downgrade the membership role for this call by faking the join result.
    const db = makeDb([row(1)], cap) as any;
    const origSelect = db.select;
    db.select = () => { const b = origSelect(); const origThen = b.then; b.then = (res: any) => origThen((v: any) => res(Array.isArray(v) && v[0]?.mb ? [{ ...v[0], mb: { ...v[0].mb, role: "rep" } }] : v)); return b; };
    h.db = db;
    await expect(appRouter.createCaller(makeCtx()).are.prospects.bulk({ campaignId: 21, prospectIds: [1], action: "approve" })).rejects.toThrow(/managers and admins/);
  });
});
