/**
 * Owner, 2026-11-24: "wire in WarmySender verification beside Reoon".
 *
 * The adapter could verify an address and nothing called it. Now Reoon stays
 * the verifier and WarmySender gives a second opinion where Reoon gives none.
 *
 * Held here:
 *   1. WHEN it is asked: a power check Reoon answered "unknown" or failed.
 *      Never a quick check, never over a verdict Reoon gave;
 *   2. what its answer becomes: a catch-all is accept_all, never valid;
 *   3. every gate before the call (switched off, no key, the option, the
 *      scope, a rejected key, a tripped circuit, the allowance), and that the
 *      allowance is held before the vendor is asked and counted after;
 *   4. its failure never fails a verification;
 *   5. the option is saved for WarmySender only, and the card and the audit
 *      say who decided.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

const h = vi.hoisted(() => ({
  off: false,
  creds: null as any,
  status: "valid" as string,
  circuitOpen: false,
  hold: { slug: "warmysender", bucket: "verification", units: 1, rowIds: [7], fundedBy: "plan" } as any,
  verdict: { ok: true, status: "valid", reason: "", isCatchAll: false } as any,
  verifyThrows: false,
  order: [] as string[],
  reserves: [] as any[],
  commits: [] as any[],
  releases: [] as any[],
  verifyCalls: [] as any[],
  spend: [] as any[],
  reoon: { status: 200, body: { email: "a@acme.org", status: "unknown", overall_score: 41, is_safe_to_send: false, is_valid_syntax: true, is_disposable: false, is_role_account: true, is_catch_all: false, is_deliverable: false, mx_accepts_mail: true } as any },
  fetches: [] as string[],
}));

vi.mock("./services/prospectSources/registry", async (a) => ({
  ...(await a<typeof import("./services/prospectSources/registry")>()),
  sourceSwitchedOff: async () => h.off,
}));
vi.mock("./services/prospectSources/credentials", async (a) => ({
  ...(await a<typeof import("./services/prospectSources/credentials")>()),
  loadCredentials: async () => h.creds,
  credentialView: async () => ({ status: h.status }),
}));
vi.mock("./services/prospectSources/circuit", async (a) => ({
  ...(await a<typeof import("./services/prospectSources/circuit")>()),
  circuitState: async () => ({ open: h.circuitOpen, failures: 0, openUntil: null }),
}));
vi.mock("./services/prospectSources/ledger", async (a) => ({
  ...(await a<typeof import("./services/prospectSources/ledger")>()),
  reserve: async (...args: unknown[]) => { h.order.push("reserve"); h.reserves.push(args); return h.hold; },
  commit: async (...args: unknown[]) => { h.order.push("commit"); h.commits.push(args); },
  release: async (...args: unknown[]) => { h.order.push("release"); h.releases.push(args); },
}));
vi.mock("./services/prospectSources/adapters/warmysender", async (a) => ({
  ...(await a<typeof import("./services/prospectSources/adapters/warmysender")>()),
  warmySenderVerifyEmail: async (...args: unknown[]) => {
    h.order.push("verify"); h.verifyCalls.push(args);
    if (h.verifyThrows) throw new Error("socket hang up");
    return h.verdict;
  },
}));
vi.mock("./services/spend", async (a) => ({
  ...(await a<typeof import("./services/spend")>()),
  recordSpend: async (e: unknown) => { h.spend.push(e); },
}));

import { reoonStatusToUsip, reoonVerifySingle, type ReoonVerifyResult } from "./services/reoon";
import { VERIFY_SCOPE, asReoonResult, warmySenderSecondOpinion } from "./services/secondVerifier";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
const METER = { workspaceId: 2, feature: "prospects.verifyEmail" };
const KEYED = { slug: "warmysender", workspaceId: 2, secrets: { apiKey: "ws_test" }, config: { scopes: ["leads:read", "leads:write", "verification:read", VERIFY_SCOPE] } };
const reoonBody = (status: string): ReoonVerifyResult => ({ ...h.reoon.body, status });
const usage = (vendor: string) => h.spend.filter((e) => e.vendor === vendor);

beforeEach(() => {
  h.off = false; h.creds = JSON.parse(JSON.stringify(KEYED)); h.status = "valid"; h.circuitOpen = false;
  h.hold = { slug: "warmysender", bucket: "verification", units: 1, rowIds: [7], fundedBy: "plan" };
  h.verdict = { ok: true, status: "valid", reason: "", isCatchAll: false };
  h.verifyThrows = false;
  h.order = []; h.reserves = []; h.commits = []; h.releases = []; h.verifyCalls = []; h.spend = []; h.fetches = [];
  h.reoon = { status: 200, body: reoonBody("unknown") };
  vi.stubGlobal("fetch", async (url: string) => {
    h.fetches.push(String(url));
    return { ok: h.reoon.status === 200, status: h.reoon.status, json: async () => h.reoon.body } as never;
  });
});

describe("when WarmySender is asked", () => {
  it("not when Reoon gives a verdict, whatever the verdict", async () => {
    for (const status of ["safe", "invalid", "catch_all", "role_account", "spamtrap"]) {
      h.reoon.body = reoonBody(status);
      const r = await reoonVerifySingle("a@acme.org", "k", "power", METER);
      expect(r.status, status).toBe(status);
      expect(r.decidedBy, status).toBeUndefined();
    }
    expect(h.verifyCalls).toHaveLength(0);
    expect(usage("warmysender")).toHaveLength(0);
  });

  it("when a power check comes back unknown, and its verdict is the answer", async () => {
    const r = await reoonVerifySingle("a@acme.org", "k", "power", METER);
    expect(h.verifyCalls).toHaveLength(1);
    expect(h.verifyCalls[0][1]).toBe("a@acme.org");
    expect(r).toMatchObject({ status: "safe", is_safe_to_send: true, is_deliverable: true, decidedBy: "warmysender" });
    expect(reoonStatusToUsip(r.status)).toBe("valid");
    // Reoon was still paid for its own check, and WarmySender for one.
    expect(usage("reoon")).toEqual([expect.objectContaining({ meter: "daily_credits", quantity: 1 })]);
    expect(usage("warmysender")).toEqual([expect.objectContaining({ workspaceId: 2, meter: "verifications", quantity: 1, feature: "prospects.verifyEmail" })]);
  });

  it("never for a quick check: those are the guessed addresses the pattern finder discards", async () => {
    const r = await reoonVerifySingle("a@acme.org", "k", "quick", METER);
    expect(r.status).toBe("unknown");
    expect(h.verifyCalls).toHaveLength(0);
    h.reoon.status = 500;
    await expect(reoonVerifySingle("a@acme.org", "k", "quick", METER)).rejects.toThrow("Reoon API error: 500");
    expect(h.verifyCalls).toHaveLength(0);
  });

  it("when the Reoon power check fails, and its verdict stands in", async () => {
    h.reoon.status = 503;
    h.verdict = { ok: true, status: "invalid", reason: "mailbox_not_found", isCatchAll: false };
    const r = await reoonVerifySingle("a@acme.org", "k", "power", METER);
    expect(r).toMatchObject({ email: "a@acme.org", status: "invalid", is_safe_to_send: false, decidedBy: "warmysender" });
    // A failed Reoon call billed nothing.
    expect(usage("reoon")).toHaveLength(0);
  });

  it("when both give nothing, the caller gets exactly what Reoon gave", async () => {
    h.verdict = { ok: true, status: "unknown", reason: "", isCatchAll: false };
    const undecided = await reoonVerifySingle("a@acme.org", "k", "power", METER);
    expect(undecided).toEqual(reoonBody("unknown"));
    h.reoon.status = 503;
    await expect(reoonVerifySingle("a@acme.org", "k", "power", METER)).rejects.toThrow("Reoon API error: 503");
  });

  it("its own failure never fails a verification", async () => {
    h.verifyThrows = true;
    const r = await reoonVerifySingle("a@acme.org", "k", "power", METER);
    expect(r).toEqual(reoonBody("unknown"));
    h.verifyThrows = false;
    h.verdict = { ok: false, reason: "rate_limited", message: "slow down" };
    expect(await reoonVerifySingle("a@acme.org", "k", "power", METER)).toEqual(reoonBody("unknown"));
  });
});

describe("what its answer becomes", () => {
  const v = (status: "valid" | "invalid" | "risky" | "unknown", isCatchAll = false) => asReoonResult("a@acme.org", { status, isCatchAll }, null);

  it("valid, risky and invalid map to the statuses the app already has", () => {
    expect(reoonStatusToUsip(v("valid")!.status)).toBe("valid");
    expect(reoonStatusToUsip(v("risky")!.status)).toBe("risky");
    expect(reoonStatusToUsip(v("invalid")!.status)).toBe("invalid");
    expect(v("unknown")).toBeNull();
  });

  it("a catch-all is accept_all, never valid, and never safe to send", () => {
    const r = v("valid", true)!;
    expect(reoonStatusToUsip(r.status)).toBe("accept_all");
    expect(r).toMatchObject({ is_catch_all: true, is_safe_to_send: false, is_deliverable: false });
    expect(reoonStatusToUsip(v("risky", true)!.status)).toBe("accept_all");
    // An address that does not exist is invalid on any domain.
    expect(reoonStatusToUsip(v("invalid", true)!.status)).toBe("invalid");
  });

  it("keeps what Reoon did establish, and says who decided", () => {
    const r = asReoonResult("a@acme.org", { status: "valid", isCatchAll: false }, reoonBody("unknown"))!;
    expect(r).toMatchObject({ overall_score: 41, is_role_account: true, is_valid_syntax: true, decidedBy: "warmysender" });
  });
});

describe("the gates before the call", () => {
  const ask = () => warmySenderSecondOpinion(2, "a@acme.org", "t", null);
  const skipped = async (why: string) => {
    expect(await ask()).toMatchObject({ decided: false, why });
    expect(h.verifyCalls).toHaveLength(0);
    expect(h.reserves).toHaveLength(0);
  };

  it("no workspace, nobody to bill", async () => {
    expect(await warmySenderSecondOpinion(null, "a@acme.org", "t", null)).toEqual({ decided: false, why: "no_workspace" });
    expect(h.verifyCalls).toHaveLength(0);
  });
  it("WarmySender switched off in Settings is off for verification too", async () => { h.off = true; await skipped("source_off"); });
  it("no key", async () => { h.creds = null; await skipped("no_key"); });
  it("the option switched off", async () => { h.creds.config.verifyUndecided = false; await skipped("option_off"); });
  it("a key known to lack the verification scope is not asked", async () => { h.creds.config.scopes = ["leads:read", "leads:write", "verification:read"]; await skipped("scope_missing"); });
  it("a key the vendor rejected", async () => { h.status = "invalid"; await skipped("key_invalid"); });
  it("a tripped circuit", async () => { h.circuitOpen = true; await skipped("circuit_open"); });

  it("a key never tested (scopes unknown) is asked; the option is on unless set false", async () => {
    delete h.creds.config.scopes;
    expect((await ask()).decided).toBe(true);
    h.creds.config.verifyUndecided = true;
    expect((await ask()).decided).toBe(true);
  });

  it("an allowance that is used up means no call", async () => {
    h.hold = null;
    expect(await ask()).toMatchObject({ decided: false, why: "allowance_used_up" });
    expect(h.reserves).toHaveLength(1);
    expect(h.verifyCalls).toHaveLength(0);
  });

  it("the allowance is held before the vendor is asked, and counted after", async () => {
    expect((await ask()).decided).toBe(true);
    expect(h.order).toEqual(["reserve", "verify", "commit"]);
    const [ws, slug, bucket, units] = h.reserves[0];
    expect([ws, slug, bucket, units]).toEqual([2, "warmysender", "verification", 1]);
    expect(h.commits[0].slice(0, 3)).toEqual([2, h.hold, 1]);
    expect(h.spend).toEqual([expect.objectContaining({ vendor: "warmysender", meter: "verifications", quantity: 1, keySource: "workspace", feature: "t" })]);
  });

  it("a refused call gives the hold back and counts nothing", async () => {
    h.verdict = { ok: false, reason: "unavailable", message: "503" };
    expect(await ask()).toMatchObject({ decided: false, why: "call_failed", detail: "503" });
    expect(h.order).toEqual(["reserve", "verify", "release"]);
    expect(h.commits).toHaveLength(0);
    expect(h.spend).toHaveLength(0);
  });

  it("an undecided answer was still a paid check", async () => {
    h.verdict = { ok: true, status: "unknown", reason: "", isCatchAll: false };
    expect(await ask()).toMatchObject({ decided: false, why: "undecided" });
    expect(h.commits).toHaveLength(1);
    expect(h.spend).toHaveLength(1);
  });
});

describe("the wiring", () => {
  it("lives in the one function every caller uses, behind verification's own switch", () => {
    const src = read("./services/reoon.ts");
    const fn = src.slice(src.indexOf("export async function reoonVerifySingle("), src.indexOf("/** The Reoon call itself."));
    expect(fn).toContain('if (mode === "power" && (failure !== null || reoonStatusToUsip(body!.status) === "unknown")) {');
    expect(fn).toContain("if (second.decided) return second.result;");
    expect(fn).toContain("if (failure !== null) throw failure;");
    // Nothing else calls the second verifier: with verification off, getReoonKey
    // returns "" and no caller reaches reoonVerifySingle at all.
    const callers = ["./routers/prospects.ts", "./routers/emailVerification.ts", "./routers/are/prospects.ts", "./services/enrichmentSweeper.ts", "./services/enrichment/comprehensivePass.ts", "./services/scraper/index.ts"];
    for (const f of callers) expect(read(f), f).not.toContain("warmySenderSecondOpinion");
  });

  it("the option is saved for WarmySender only", () => {
    const src = read("./routers/prospectSources.ts");
    expect(src).toContain("verifyUndecided: z.boolean().optional(),");
    expect(src).toContain('if (input.slug === "warmysender" && c.verifyUndecided !== undefined) config.verifyUndecided = c.verifyUndecided;');
  });

  it("the card has the switch, says what a check spends, and follows a lender's setting", () => {
    const src = read("../client/src/components/usip/settings/WarmySenderSourceCard.tsx");
    expect(src).toContain("const verifyOn = config.verifyUndecided !== false;");
    expect(src).toContain('aria-label="Verify addresses Reoon cannot decide"');
    expect(src).toContain('onCheckedChange={(v) => save.mutate({ slug: "warmysender", config: { verifyUndecided: v } })}');
    expect(src).toContain("disabled={!isAdmin || save.isPending || !!cred?.sharedFrom || canVerify === false}");
    expect(src).toContain("One verification from this plan's allowance each time.");
    expect(src).not.toContain("<code>verification:read</code>; other scopes are never used");
  });

  it("the audit and the person page say who decided", () => {
    const src = read("./routers/prospects.ts");
    expect(src).toContain('after: { email, emailStatus: verdict, reoon: raw.status, verifier: raw.decidedBy ?? "reoon" },');
    expect(src).toContain('verifier: raw.decidedBy ?? "reoon", replaced,');
    expect(read("../client/src/pages/usip/ProspectDetail.tsx")).toContain('r.verifier === "warmysender" ? " · decided by the second verifier, Reoon could not" : ""');
  });

  it("the spend report names the unit", () => {
    expect(read("../shared/spendReport.ts")).toContain('verifications: "Addresses verified (second opinion)",');
  });
});
