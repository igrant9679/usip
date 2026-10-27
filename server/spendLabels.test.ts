/**
 * The cost report says what the platform's own model and engine spent
 * (follow-up to Phase 3, found on the live report 2026-10-27).
 *
 *   claude-haiku-4-5, the deployment's default model, has a list price, so
 *   its tokens show dollars instead of "—" · each step of an engine tick
 *   (are.enrich, are.screen, …) names the paid calls made anywhere below it,
 *   instead of one "background" line · a guarded cron job names its calls ·
 *   a vendor meter with no feature takes the current one · a tick started
 *   from a request keeps that request's workspace and user, and leaves the
 *   request's own name alone.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  // _core/env.ts and crypto read these at module load.
  if (!process.env.ENCRYPTION_KEY && !process.env.JWT_SECRET) process.env.ENCRYPTION_KEY = "b".repeat(64);
  return {
    db: null as any,
    usage: { input_tokens: 1000, output_tokens: 200, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  };
});

vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = {
      create: async () => ({ id: "m", model: "claude-haiku-4-5-20251001", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { ...h.usage } }),
    };
  },
}));
vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db }));
vi.mock("./_core/env", async (a) => {
  const actual = await a<typeof import("./_core/env")>();
  return { ...actual, ENV: { ...actual.ENV, anthropicApiKey: "env-anthropic", aiDefaultProvider: "anthropic" } };
});

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { invokeLLM, __resetLlmBurstForTests } from "./_core/llm";
import {
  getRequestFeature,
  getRequestUserId,
  getRequestWorkspaceId,
  mergeOwnRequestContext,
  runWithRequestContext,
} from "./_core/requestContext";
import { recordSpend, __resetSpendWarningsForTests } from "./services/spend";
import { runAreEngine } from "./areEngine";
import { RESEARCH_MODELS } from "@shared/researchModels";
import { summarizeSpend, unitCostUsd } from "@shared/spendReport";

const LSI = 2;
const ledger = () => h.db.rowsOf("spend_ledger") as Array<Record<string, any>>;
const featureOf = (meter: string) => ledger().filter((r) => r.meter === meter).map((r) => r.feature);

beforeEach(() => {
  h.db = makeSqlFakeDb({});
  __resetLlmBurstForTests();
  __resetSpendWarningsForTests();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Haiku 4.5 has a price on file", () => {
  it("is billed at $1 in, $5 out, $1.25 cache write and $0.10 cache read per million", () => {
    for (const model of ["claude-haiku-4-5-20251001", "claude-haiku-4-5"]) {
      expect(unitCostUsd("anthropic", "input_tokens", model, 1_000_000)).toBe(1);
      expect(unitCostUsd("anthropic", "output_tokens", model, 1_000_000)).toBe(5);
      expect(unitCostUsd("anthropic", "cache_write_tokens", model, 1_000_000)).toBe(1.25);
      expect(unitCostUsd("anthropic", "cache_read_tokens", model, 1_000_000)).toBeCloseTo(0.1, 10);
    }
  });

  it("puts dollars on the live report's Haiku lines", () => {
    // What the LSI Media report showed on 2026-10-27 with "—" in Est. cost.
    const row = { workspaceId: LSI, day: "2026-10-27", vendor: "anthropic", model: "claude-haiku-4-5-20251001", keySource: "workspace", feature: "background", calls: 4 };
    const s = summarizeSpend([
      { ...row, meter: "input_tokens", quantity: 18_502 },
      { ...row, meter: "output_tokens", quantity: 3_360 },
    ], ["2026-10-27"]);
    expect(s.lines.map((l) => l.estUsd)).toEqual([expect.closeTo(0.018502, 9), expect.closeTo(0.0168, 9)]);
    expect(s.estUsd).toBeCloseTo(0.035302, 9);
  });

  it("is not offered as a Research model, and a model with no price still shows none", () => {
    expect(Object.keys(RESEARCH_MODELS).sort()).toEqual(["claude-haiku-5-5", "claude-opus-5-5", "claude-sonnet-5-5"]);
    expect(unitCostUsd("anthropic", "input_tokens", "claude-sonnet-4-6", 1_000_000)).toBeNull();
    // A prefix of a priced id is not that model.
    expect(unitCostUsd("anthropic", "input_tokens", "claude-haiku-4", 1_000_000)).toBeNull();
  });
});

describe("a run that moves through steps names the calls in each", () => {
  it("records a model call under the step it was made in, however deep", async () => {
    const deep = async () => {
      await Promise.resolve();
      await invokeLLM({ workspaceId: LSI, messages: [{ role: "user", content: "hi" }] });
    };
    await mergeOwnRequestContext({ feature: "are.engine" }, async (ctx) => {
      ctx.feature = "are.sequence";
      await deep();
      ctx.feature = "are.dispatch";
      await deep();
      // A call that names itself keeps its name.
      await invokeLLM({ workspaceId: LSI, feature: "are.enrichAgent", messages: [{ role: "user", content: "hi" }] });
    });
    expect(featureOf("input_tokens").sort()).toEqual(["are.dispatch", "are.enrichAgent", "are.sequence"]);
    // Outside any run it is still "background".
    await invokeLLM({ workspaceId: LSI, messages: [{ role: "user", content: "hi" }] });
    expect(featureOf("input_tokens")).toContain("background");
  });

  it("keeps the workspace and user of the request it started in, and leaves the request's name alone", async () => {
    const inside: unknown[] = [];
    const after = await runWithRequestContext({ workspaceId: LSI, userId: 7, feature: "are.engine.runOnce" }, async () => {
      await mergeOwnRequestContext({ feature: "are.engine" }, async (ctx) => {
        ctx.feature = "are.screen";
        inside.push([getRequestWorkspaceId(), getRequestUserId(), getRequestFeature()]);
      });
      return getRequestFeature();
    });
    expect(inside).toEqual([[LSI, 7, "are.screen"]]);
    expect(after).toBe("are.engine.runOnce");
  });

  it("a vendor meter given no feature takes the current one", async () => {
    await runWithRequestContext({ feature: "are.screen" }, async () => {
      await recordSpend({ workspaceId: LSI, vendor: "reoon", meter: "daily_credits", quantity: 1, keySource: "workspace" });
      await recordSpend({ workspaceId: LSI, vendor: "reoon", meter: "instant_credits", quantity: 1, keySource: "workspace", feature: "verify" });
    });
    await recordSpend({ workspaceId: LSI, vendor: "reoon", meter: "bulk_emails", quantity: 1, keySource: "workspace" });
    expect(featureOf("daily_credits")).toEqual(["are.screen"]);
    expect(featureOf("instant_credits")).toEqual(["verify"]);
    expect(featureOf("bulk_emails")).toEqual([""]);
  });
});

describe("an engine tick names each step", () => {
  /**
   * A database that notes the context each query is made in and then fails
   * it, except the one read of active campaigns, which returns one. Every
   * phase catches its own failure, so a tick walks every step; what each
   * step's first query saw is the name its paid calls would be recorded under.
   */
  function stepRecordingDb(seen: Array<{ feature?: string; ws?: number; user?: number }>) {
    let servedCampaigns = false;
    const campaign = { id: 9, workspaceId: LSI, name: "C", status: "active", targetProspectCount: 10, sources: [] };
    const chain = (table: string | null): any =>
      new Proxy(() => {}, {
        get(_t, prop) {
          if (prop === "then") {
            return (ok: (v: unknown) => unknown, fail: (e: unknown) => unknown) => {
              if (table === "are_campaigns" && !servedCampaigns) {
                servedCampaigns = true;
                return Promise.resolve([campaign]).then(ok, fail);
              }
              return Promise.reject(new Error("stub database")).then(ok, fail);
            };
          }
          if (prop === "from") return (t: any) => chain(tableName(t));
          return () => chain(table);
        },
      });
    const tableName = (t: any): string | null => {
      const sym = t && Object.getOwnPropertySymbols(t).find((s) => String(s) === "Symbol(drizzle:Name)");
      return sym ? String(t[sym]) : null;
    };
    return new Proxy({}, {
      get(_t, prop) {
        if (prop === "then") return undefined; // getDb() must resolve to the database itself
        return (...args: any[]) => {
          seen.push({ feature: getRequestFeature(), ws: getRequestWorkspaceId(), user: getRequestUserId() });
          return chain(prop === "insert" || prop === "update" ? tableName(args[0]) : null);
        };
      },
    });
  }
  const steps = (seen: Array<{ feature?: string }>) =>
    seen.map((s) => s.feature).filter((f, i, all) => f !== all[i - 1]);
  const ORDER = ["are.enrich", "are.screen", "are.sequence", "are.enroll", "are.dispatch", "are.complete", "are.counters", "are.discovery"];

  beforeEach(() => {
    vi.stubGlobal("fetch", async () => { throw new Error("no network in tests"); });
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("from the cron: every step, in order, under its own name", async () => {
    const seen: Array<{ feature?: string; ws?: number; user?: number }> = [];
    h.db = stepRecordingDb(seen);
    await runAreEngine();
    expect(steps(seen)).toEqual(ORDER);
    expect(getRequestFeature()).toBeUndefined();
  });

  it("from 'Run engine now': the same names, the request's workspace and user, and the request keeps its own name", async () => {
    const seen: Array<{ feature?: string; ws?: number; user?: number }> = [];
    h.db = stepRecordingDb(seen);
    const after = await runWithRequestContext({ workspaceId: LSI, userId: 7, feature: "are.engine.runOnce" }, async () => {
      await runAreEngine();
      return getRequestFeature();
    });
    expect(steps(seen)).toEqual(ORDER);
    expect(seen.every((s) => s.ws === LSI && s.user === 7)).toBe(true);
    expect(after).toBe("are.engine.runOnce");
  });
});
