/**
 * URL-as-name account repair + bulk brand resolution (owner ask 2026-08-13).
 * The pure helpers are the dataCleanup-era logic, recovered — the dry-run
 * findings they encode (social hosts are never domains; slugs stay
 * lowercase) still hold and are pinned here.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { companyDomainFromUrl, companyFromUrl, looksLikeUrl } from "./services/company/nameRepair";

describe("companyFromUrl", () => {
  it("takes the slug from a social profile URL", () => {
    expect(companyFromUrl("https://facebook.com/fanatics")).toBe("fanatics");
    expect(companyFromUrl("https://www.linkedin.com/company/state-auto")).toBe("state auto");
  });
  it("takes the host label from the company's own site", () => {
    expect(companyFromUrl("https://www.acme-corp.com/about")).toBe("acme corp");
  });
  it("never invents casing", () => {
    expect(companyFromUrl("https://facebook.com/MongoDB")).toBe("MongoDB");
    expect(companyFromUrl("https://facebook.com/mongodb")).toBe("mongodb");
  });
  it("a company site is named from its HOST even when the host ends in a social token", () => {
    // The same unanchored-`x` trap, on the naming side: "netflix.com/jobs"
    // read as a profile URL would name the account "jobs".
    expect(companyFromUrl("https://netflix.com/jobs")).toBe("netflix");
    expect(companyFromUrl("https://equifax.com/about/careers")).toBe("equifax");
    expect(companyFromUrl("https://x.com/acme")).toBe("acme");
  });
});

describe("companyDomainFromUrl — the wrong-domain trap", () => {
  it("a social host is NEVER the company's domain", () => {
    expect(companyDomainFromUrl("https://facebook.com/fanatics")).toBeNull();
    expect(companyDomainFromUrl("https://x.com/acme")).toBeNull();
  });
  it("the company's own site is", () => {
    expect(companyDomainFromUrl("https://www.stateauto.com/careers")).toBe("stateauto.com");
  });
  it("a company whose name merely ENDS in a social token keeps its domain", () => {
    // Unanchored, the `x` alternative eats every ...x.com company.
    expect(companyDomainFromUrl("https://www.netflix.com/jobs")).toBe("netflix.com");
    expect(companyDomainFromUrl("https://equifax.com")).toBe("equifax.com");
    expect(companyDomainFromUrl("https://xerox.com")).toBe("xerox.com");
  });
  it("still catches social SUBdomains", () => {
    expect(companyDomainFromUrl("https://uk.linkedin.com/company/acme")).toBeNull();
  });
});

describe("looksLikeUrl", () => {
  it("catches the shapes that ended up as account names", () => {
    expect(looksLikeUrl("https://facebook.com/fcc")).toBe(true);
    expect(looksLikeUrl("www.acme.com")).toBe(true);
    expect(looksLikeUrl("acme.com/team")).toBe(true);
    expect(looksLikeUrl("Acme Corporation")).toBe(false);
  });
});

describe("the repair + bulk resolve are wired", () => {
  it("repairUrlNamedAccounts respects overrides and clears the brand stamp", () => {
    const src = readFileSync("server/services/company/nameRepair.ts", "utf8");
    expect(src).toContain("if (a.brandOverride) { summary.skippedOverride++; continue; }");
    expect(src).toContain("brandVerifiedAt: null");
  });
  it("companies.resolveBrandsBatch runs repair + one bounded sweep and reports the remainder", () => {
    const src = readFileSync("server/routers/companies.ts", "utf8");
    expect(src).toContain("repairUrlNamedAccounts(ctx.workspace.id)");
    expect(src).toContain("remainingUnverified");
  });
  it("the sweep it drives is SCOPED to the workspace it reports on", () => {
    // Otherwise the loop signal (this workspace's remainder) and the spend
    // (whatever the cross-workspace scan happened to reach) describe
    // different sets of accounts, and the loop can never converge.
    const src = readFileSync("server/routers/companies.ts", "utf8");
    const call = src.slice(src.indexOf("runBrandReconciliation("), src.indexOf("runBrandReconciliation(") + 160);
    expect(call).toContain("workspaceId: ctx.workspace.id");
  });
});
