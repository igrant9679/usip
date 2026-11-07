/**
 * Verify People from the screen, and the credits card (audit 2026-10-20,
 * batch RESB: F39, F10). Against the real routers, the real job runner and
 * the SQL fake; Reoon is mocked and never called.
 *
 *   F39  a People selection is verified by one background job that runs each
 *        person through prospects.verifyEmail; people with no address are left
 *        out; the shared key's allowance is checked first; a second click gets
 *        the running job; the Data health "valid" count moves
 *   F10  dataHealth.credits: the Reoon balance on the workspace's own key, the
 *        allowance (never the platform's balance) on the shared key, a failed
 *        balance read said as such, QuickEnrich emails this month, LinkedIn
 *        lookups left today
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => ({
  db: null as any,
  reoonKey: "",
  verified: [] as string[],
  balance: null as null | (() => Promise<any>),
  balanceCalls: 0,
  accounts: [] as any[],
}));
vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));
vi.mock("./audit", async (a) => ({ ...(await a<typeof import("./audit")>()), recordAudit: async () => {} }));
vi.mock("./services/enrichment/fieldHistory", async (a) => ({ ...(await a<typeof import("./services/enrichment/fieldHistory")>()), recordFieldHistory: async () => {} }));
vi.mock("./services/reoon", async (a) => ({
  ...(await a<typeof import("./services/reoon")>()),
  getReoonKey: async () => h.reoonKey,
  reoonVerifySingle: async (email: string) => { h.verified.push(email); return { status: email.startsWith("bad") ? "invalid" : "safe" }; },
  reoonCheckBalance: async () => { h.balanceCalls++; return h.balance!(); },
}));
vi.mock("./services/linkedinLookup", async (a) => ({ ...(await a<typeof import("./services/linkedinLookup")>()), listUsableAccounts: async () => h.accounts }));

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { appRouter } from "./routers";
import { tickJobs, __resetJobRunnerForTests } from "./services/jobs/runner";
import { PEOPLE_VERIFY_JOB } from "./services/peopleVerify";
import { spendDay } from "./services/spend";

const WS = 2;
const rows = (t: string) => h.db.rowsOf(t) as any[];
const row = (t: string, id: number) => rows(t).find((r) => r.id === id);
const user = { id: 1, openId: "u", email: "o@example.com", name: "O", loginMethod: "password", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() };
const caller = () => appRouter.createCaller({
  user,
  req: { protocol: "https", headers: { "x-workspace-id": String(WS) } },
  res: { clearCookie: () => {} },
} as unknown as TrpcContext);
let role = "manager";
const person = (id: number, email: string | null) => rows("prospects").push({
  id, workspaceId: WS, firstName: `P${id}`, lastName: "X", email, emailStatus: null, fieldProvenance: {}, verificationStatus: "verified",
});

beforeEach(() => {
  role = "manager";
  h.db = makeSqlFakeDb({ roles: new Proxy({}, { get: () => role }) as Record<number, string>, wsId: () => WS });
  h.reoonKey = "own-key";
  h.verified = [];
  h.balance = async () => ({ api_status: "success", remaining_daily_credits: 420, remaining_instant_credits: 1500, status: "ok" });
  h.balanceCalls = 0;
  h.accounts = [];
  delete process.env.REOON_API_KEY;
  __resetJobRunnerForTests();
  rows("workspaces").push({ id: WS, name: "LSI", slug: "lsi", ownerUserId: 1, archivedAt: null, plan: "trial" });
  rows("users").push({ ...user });
});

describe("verify People from the screen (F39)", () => {
  it("queues one job of the people with an address and runs each through verifyEmail, writing the column Data health counts", async () => {
    person(1, "ann@acme.example"); person(2, null); person(3, "bad@acme.example");
    const r = await caller().prospects.verifyEmailBulk({ ids: [1, 2, 3] });
    expect(r).toMatchObject({ queued: 2, noEmail: 1, existing: false });
    expect(rows("bulk_jobs")[0]).toMatchObject({ kind: PEOPLE_VERIFY_JOB, total: 2, status: "queued" });
    expect(h.verified).toHaveLength(0);

    // A second click while it is queued gets the same job.
    const again = await caller().prospects.verifyEmailBulk({ ids: [1, 3] });
    expect(again).toMatchObject({ jobId: r.jobId, existing: true });
    expect(rows("bulk_jobs")).toHaveLength(1);

    await tickJobs(5_000);
    expect(h.verified.sort()).toEqual(["ann@acme.example", "bad@acme.example"]);
    expect(row("prospects", 1).emailStatus).toBe("valid");
    expect(row("prospects", 3).emailStatus).toBe("invalid");
    expect(row("prospects", 2).emailStatus).toBeNull();

    const job = await caller().prospects.verifyJob({ jobId: r.jobId });
    expect(job).toMatchObject({ status: "done", done: 2, total: 2, failed: 0 });

    // Data health counts exactly this column on People (dataHealth.getMetrics).
    const dh = readFileSync(join(__dirname, "routers/dataHealth.ts"), "utf8");
    expect(dh).toContain("verifiedValid: sql<number>`SUM(CASE WHEN ${prospects.emailStatus} = 'valid' THEN 1 ELSE 0 END)`");
  });

  it("is a manager's, needs someone with an address, and stays inside the shared key's allowance", async () => {
    person(1, "ann@acme.example"); person(2, "bo@acme.example"); person(3, null);
    role = "rep";
    await expect(caller().prospects.verifyEmailBulk({ ids: [1] })).rejects.toMatchObject({ code: "FORBIDDEN" });
    role = "manager";
    await expect(caller().prospects.verifyEmailBulk({ ids: [3] })).rejects.toMatchObject({ code: "BAD_REQUEST" });

    h.reoonKey = "shared-key";
    process.env.REOON_API_KEY = "shared-key";
    rows("workspace_settings").push({ workspaceId: WS, sharedReoonKey: true, sharedReoonDailyCap: 10 });
    rows("spend_ledger").push({ id: 1, workspaceId: WS, day: spendDay(), vendor: "reoon", meter: "daily_credits", model: "", keySource: "shared", feature: "x", quantity: 9, calls: 9 });
    await expect(caller().prospects.verifyEmailBulk({ ids: [1, 2] })).rejects.toThrow(/room for 1 more/);
    expect(rows("bulk_jobs")).toHaveLength(0);

    h.reoonKey = "";
    await expect(caller().prospects.verifyEmailBulk({ ids: [1] })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it("someone removed from the workspace since does not keep verifying in it", async () => {
    person(1, "ann@acme.example");
    const r = await caller().prospects.verifyEmailBulk({ ids: [1] });
    role = "rep";
    await tickJobs(5_000);
    expect(h.verified).toHaveLength(0);
    const job = await caller().prospects.verifyJob({ jobId: r.jobId });
    expect(job.failed).toBe(1);
  });
});

describe("the credits card (F10)", () => {
  it("shows the Reoon balance on the workspace's own key, QuickEnrich's month and LinkedIn's day", async () => {
    h.accounts = [{ unipileAccountId: "a", remainingToday: 64 }];
    const first = `${spendDay().slice(0, 8)}01`;
    rows("spend_ledger").push(
      { id: 1, workspaceId: WS, day: first, vendor: "quickenrich", meter: "email_hits", model: "", keySource: "workspace", feature: "a", quantity: 30, calls: 30 },
      { id: 2, workspaceId: WS, day: spendDay(), vendor: "quickenrich", meter: "email_hits", model: "", keySource: "workspace", feature: "b", quantity: 5, calls: 5 },
      { id: 3, workspaceId: 4, day: spendDay(), vendor: "quickenrich", meter: "email_hits", model: "", keySource: "workspace", feature: "b", quantity: 99, calls: 1 },
    );
    const c = await caller().dataHealth.credits();
    expect(c.reoon).toMatchObject({ configured: true, keySource: "workspace", balance: { daily: 420, instant: 1500 }, error: null });
    expect(c.quickenrich.emailsThisMonth).toBe(35);
    expect(c.linkedin).toEqual({ accounts: 1, left: 64, cap: 100 });
  });

  it("on the shared key it shows today's allowance and never asks for the platform's balance", async () => {
    h.reoonKey = "shared-key";
    process.env.REOON_API_KEY = "shared-key";
    rows("workspace_settings").push({ workspaceId: WS, sharedReoonKey: true, sharedReoonDailyCap: 500 });
    rows("spend_ledger").push({ id: 1, workspaceId: WS, day: spendDay(), vendor: "reoon", meter: "daily_credits", model: "", keySource: "shared", feature: "x", quantity: 120, calls: 120 });
    const c = await caller().dataHealth.credits();
    expect(c.reoon).toMatchObject({ keySource: "shared", balance: null, allowance: { used: 120, cap: 500 } });
    expect(h.balanceCalls).toBe(0);
  });

  it("a balance that cannot be read is said, not shown as zero; no key says no key", async () => {
    h.balance = async () => { throw new Error("Reoon balance error: 503"); };
    let c = await caller().dataHealth.credits();
    expect(c.reoon.balance).toBeNull();
    expect(c.reoon.error).toContain("503");
    h.reoonKey = "";
    c = await caller().dataHealth.credits();
    expect(c.reoon).toMatchObject({ configured: false, balance: null });
  });
});
