/**
 * Apollo is search-only / zero-credit — an OWNER DECISION, not an accident.
 *
 * The paid surface (services/apolloEnrich.ts, /people/match behind the
 * dataCleanup router) was removed 2026-08-12 with owner approval. These
 * guards make the removal stick: the search module must never grow a paid
 * call, and the paid module must not quietly come back.
 *
 * The campaign predicate `isEnrichableCampaign` survived the removal — it
 * moved to enrichmentSweeper.ts (its only remaining caller). Its behavior
 * tests moved here with it because they document a real mis-spend.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { isEnrichableCampaign } from "./services/enrichmentSweeper";

describe("zero-credit structural guarantee", () => {
  it("the search-only module has no /people/match code line", () => {
    // apollo.ts legitimately *mentions* /people/match in prose to explain what
    // it does NOT call, so assert on CODE lines only.
    const searchOnly = readFileSync("server/services/apollo.ts", "utf8");
    const codeHits = searchOnly
      .split("\n")
      .filter((l) => l.includes("people/match"))
      .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l));
    expect(codeHits).toEqual([]);
  });

  it("the paid module stays deleted", () => {
    expect(existsSync("server/services/apolloEnrich.ts")).toBe(false);
    expect(existsSync("server/routers/dataCleanup.ts")).toBe(false);
  });

  it("no code line anywhere refers to /people/match", () => {
    // A paid call added under any filename would still need the endpoint
    // string. Prose mentions (comments explaining what we do NOT call) are
    // fine and exist in several files; a CODE line is not.
    const { execSync } = require("node:child_process") as typeof import("node:child_process");
    const out = execSync('git grep -n "people/match" -- server shared client || true', { encoding: "utf8" })
      .split("\n").filter(Boolean)
      .filter((l) => !l.startsWith("server/apolloSearchOnly.test.ts"))
      .filter((l) => {
        const code = l.replace(/^[^:]+:\d+:/, "");
        return !/^\s*(\*|\/\/|\/\*)/.test(code);
      });
    expect(out).toEqual([]);
  });
});

describe("Apollo is sourcing-only — removed from the prospect waterfall 2026-08-12", () => {
  it("only the sourcing surfaces import services/apollo", () => {
    // Owner directive: LinkedIn+QuickEnrich are the single source of truth
    // for company identity, prospect-level included. Apollo remains ONLY as
    // a people-search prospect source (ARE + Discovery) and its own settings
    // router. An import appearing in enrichment/sweeper/router code means
    // the waterfall grew an Apollo step back.
    // execFileSync, not execSync: the pattern quoting must not pass through
    // cmd.exe, whose escaping rules differ from POSIX shells.
    const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
    const importers = execFileSync("git", [
      "grep", "-l",
      "-e", 'services/apollo"',
      "-e", 'from "../apollo"',
      "-e", 'from "./apollo"',
      "--", "server",
    ], { encoding: "utf8" })
      .split("\n").filter(Boolean)
      .filter((f) => !f.endsWith(".test.ts") && f !== "server/services/apollo.ts");
    expect(importers.sort()).toEqual([
      "server/areEngine.ts",
      "server/routers/apollo.ts",
      "server/services/discovery/index.ts",
    ]);
  });
});

describe("campaign targeting — added after the pilot mis-spent", () => {
  it("refuses to work a prospect with no campaign", () => {
    // The first paid pilot spent 17 credits on orphaned rows: prospect_queue
    // held 559 rows while the live campaigns accounted for 177. An orphan will
    // never be mailed, so it must never be worked.
    expect(isEnrichableCampaign(null)).toBe(false);
    expect(isEnrichableCampaign("")).toBe(false);
    expect(isEnrichableCampaign("   ")).toBe(false);
  });

  it("refuses seeded demo campaigns", () => {
    // Demo people are invented — any enrichment either finds nothing or
    // matches a real stranger who happens to share the name.
    expect(isEnrichableCampaign("[Demo] Autonomous Outbound — SaaS RevOps")).toBe(false);
    expect(isEnrichableCampaign("[demo] anything")).toBe(false);
  });

  it("allows real campaigns", () => {
    expect(isEnrichableCampaign("Nonprofit Community Service")).toBe(true);
    expect(isEnrichableCampaign("AI Audit - CFO Cost Savings ROI")).toBe(true);
  });
});
