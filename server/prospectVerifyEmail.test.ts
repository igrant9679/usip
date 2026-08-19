/**
 * prospects.verifyEmail — single-address Reoon verify on a PERSON (People are
 * the sitewide record; Contacts had `emailVerification.verifySingle`, People
 * had nothing). Driven through the REAL procedure via appRouter.createCaller
 * against a fake db (companyDuplicates.test.ts pattern), with the Reoon
 * module mocked so no network and no credits.
 */
import { describe, it, expect, vi } from "vitest";
import { prospects } from "../drizzle/schema";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => ({ db: null as any, reoonStatus: "safe" as string, key: "k" as string }));

vi.mock("./db", async (importActual) => ({
  ...(await importActual<typeof import("./db")>()),
  getDb: async () => h.db,
}));
vi.mock("./services/reoon", async (importActual) => ({
  ...(await importActual<typeof import("./services/reoon")>()),
  getReoonKey: async () => h.key,
  reoonVerifySingle: async (email: string) => ({ email, status: h.reoonStatus, is_safe_to_send: h.reoonStatus === "safe", is_deliverable: h.reoonStatus === "safe" }),
}));

import { appRouter } from "./routers";

const WS = { id: 4, name: "CommunityForce" };

function makeDb(row: Record<string, unknown> | null, cap: { sets: Array<Record<string, unknown>>; inserts: number }) {
  const builder = () => {
    const st: { table?: unknown; joined: boolean } = { joined: false };
    const b: any = {
      from(t: unknown) { st.table = t; return b; },
      innerJoin() { st.joined = true; return b; },
      where() { return b; },
      limit() { return b; },
      orderBy() { return b; },
      then(res: (v: unknown) => void) {
        if (st.joined) {
          res([{
            ws: { ...WS, ownerUserId: 1, archivedAt: null },
            mb: { id: 1, userId: 1, workspaceId: WS.id, role: "manager", deactivatedAt: null, lastActiveAt: new Date() },
          }]);
        } else if (st.table === prospects) res(row ? [row] : []);
        else res([]);
      },
    };
    return b;
  };
  return {
    select: () => builder(),
    update: () => ({ set: (v: Record<string, unknown>) => { cap.sets.push(v); return { where: async () => undefined }; } }),
    insert: () => ({ values: async () => { cap.inserts++; } }),
  };
}

function makeCtx(): TrpcContext {
  return {
    user: { id: 1, openId: "u", email: "u@example.com", name: "U", loginMethod: "manus", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
    req: { protocol: "https", headers: { "x-workspace-id": "4" } },
    res: { clearCookie: () => {} },
  } as unknown as TrpcContext;
}

const PEREZ = {
  id: 2638, workspaceId: 4, firstName: "Nilvio", lastName: "Perez", email: "nperez@southern.edu", emailStatus: "accept_all",
  fieldProvenance: { email: { source: "are_enrich_agent", confidence: 62, verification: "accept_all", at: "2026-08-13T23:31:10.613Z" } },
};

describe("prospects.verifyEmail", () => {
  it("replaces the address with a supplied one, verifies it, and records a user-sourced ledger entry with the verdict", async () => {
    const cap = { sets: [] as Array<Record<string, unknown>>, inserts: 0 };
    h.db = makeDb(PEREZ, cap); h.reoonStatus = "safe"; h.key = "k";
    const out = await appRouter.createCaller(makeCtx()).prospects.verifyEmail({ prospectId: 2638, email: "PerezN18@southernct.edu" });
    expect(out).toMatchObject({ email: "perezn18@southernct.edu", status: "valid", reoonStatus: "safe", replaced: true, previousEmail: "nperez@southern.edu" });
    const set = cap.sets[0];
    expect(set.email).toBe("perezn18@southernct.edu");
    expect(set.emailStatus).toBe("valid");
    expect(set.emailVerifiedAt).toBeInstanceOf(Date);
    const ledger = set.fieldProvenance as { email: { source: string; confidence: number; verification: string } };
    expect(ledger.email).toMatchObject({ source: "user", confidence: 100, verification: "valid" });
  });

  it("re-verifying the CURRENT address keeps its source and updates the verdict; an invalid verdict is recorded, not hidden by clearing", async () => {
    const cap = { sets: [] as Array<Record<string, unknown>>, inserts: 0 };
    h.db = makeDb(PEREZ, cap); h.reoonStatus = "invalid";
    const out = await appRouter.createCaller(makeCtx()).prospects.verifyEmail({ prospectId: 2638 });
    expect(out).toMatchObject({ email: "nperez@southern.edu", status: "invalid", replaced: false });
    const set = cap.sets[0];
    expect(set.email).toBe("nperez@southern.edu");
    expect(set.emailStatus).toBe("invalid");
    const ledger = set.fieldProvenance as { email: { source: string; confidence: number; verification: string } };
    expect(ledger.email).toMatchObject({ source: "are_enrich_agent", confidence: 0, verification: "invalid" });
  });

  it("a catch-all domain comes back accept_all — recorded as such, never dressed up as valid", async () => {
    const cap = { sets: [] as Array<Record<string, unknown>>, inserts: 0 };
    h.db = makeDb(PEREZ, cap); h.reoonStatus = "catch_all";
    const out = await appRouter.createCaller(makeCtx()).prospects.verifyEmail({ prospectId: 2638, email: "perezn18@southernct.edu" });
    expect(out.status).toBe("accept_all");
    expect((cap.sets[0].fieldProvenance as any).email.confidence).toBe(62);
  });

  it("refuses without a Reoon key (the one optional-verification choke point) and with no address", async () => {
    const cap = { sets: [] as Array<Record<string, unknown>>, inserts: 0 };
    h.db = makeDb(PEREZ, cap); h.key = "";
    await expect(appRouter.createCaller(makeCtx()).prospects.verifyEmail({ prospectId: 2638 })).rejects.toThrow(/Reoon/);
    h.key = "k"; h.db = makeDb({ ...PEREZ, email: null }, cap);
    await expect(appRouter.createCaller(makeCtx()).prospects.verifyEmail({ prospectId: 2638 })).rejects.toThrow(/no email/);
    expect(cap.sets).toEqual([]);
  });
});
