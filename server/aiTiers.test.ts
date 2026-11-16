/**
 * AI model tiers (owner 2026-11-16).
 *
 * A workspace had one model for every AI call. It now has three tiers (fast,
 * standard, deep), a tier per kind of work with the defaults in code
 * (shared/aiTiers.ts), and its own overrides of those.
 *
 * The promise that matters most is the first one tested: A WORKSPACE THAT
 * SETS NOTHING BEHAVES EXACTLY AS BEFORE. Every workspace starts there.
 *
 * Only the provider SDK and the database are stubbed; invokeLLM, the routing
 * and the meter are real.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const h = vi.hoisted(() => ({
  calls: [] as any[],
  reply: (_p: any): any => { throw new Error("unscripted"); },
  /** The workspace_settings row every read gets. */
  row: {} as Record<string, unknown>,
}));

vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = {
      create: async (params: any) => {
        h.calls.push(JSON.parse(JSON.stringify(params)));
        return h.reply(params);
      },
    };
  },
}));

vi.mock("./db", async (importActual) => {
  // Every select resolves to the one settings row; writes are swallowed.
  const chain = (): any => {
    const c: any = {
      from: () => c, where: () => c, limit: () => c, innerJoin: () => c, leftJoin: () => c, orderBy: () => c, groupBy: () => c,
      then: (res: any, rej: any) => Promise.resolve([h.row]).then(res, rej),
    };
    return c;
  };
  const write = (): any => {
    const w: any = { values: () => w, set: () => w, where: () => w, onDuplicateKeyUpdate: () => w, then: (res: any, rej: any) => Promise.resolve([]).then(res, rej) };
    return w;
  };
  return {
    ...(await importActual<typeof import("./db")>()),
    getDb: async () => ({ select: () => chain(), insert: () => write(), update: () => write() }),
  };
});

vi.mock("./_core/env", async (importActual) => {
  const actual = await importActual<typeof import("./_core/env")>();
  // Anthropic only: OpenAI and Gemini have no key anywhere in these tests.
  return { ...actual, ENV: { ...actual.ENV, anthropicApiKey: "test-key", openaiApiKey: "", geminiApiKey: "", aiDefaultProvider: "anthropic" } };
});

vi.mock("./services/keyShares", async (importActual) => ({
  ...(await importActual<typeof import("./services/keyShares")>()),
  linkedKeys: async () => ({}),
  linkedKey: async () => "",
}));

import { failedItsFormat, invokeLLM } from "./_core/llm";
import { __resetTierConfigForTests } from "./services/aiTiers";
import { findLlmCallSites } from "./__fakes__/llmCallSites";
import {
  AI_TASKS,
  AI_TASK_IDS,
  AI_TIERS,
  canStepUp,
  cleanTaskTiers,
  cleanTierModels,
  isAiTask,
  pickTierModel,
  tierForTask,
  type AiProviderId,
  type TierModels,
} from "@shared/aiTiers";

const ROOT = join(__dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const DEFAULT_MODEL = "claude-haiku-4-5-20251001";
const text = (t: string, model = "m") => ({ id: "msg_1", model, content: [{ type: "text", text: t }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 } });
const toolUse = (input: unknown) => ({ id: "msg_1", model: "m", content: [{ type: "tool_use", id: "t1", name: "respond_with_structured_output", input }], stop_reason: "tool_use", usage: { input_tokens: 10, output_tokens: 5 } });

const ask = (extra: Record<string, unknown> = {}) =>
  invokeLLM({ workspaceId: 7, messages: [{ role: "user", content: "hello" }], ...extra } as any);

beforeEach(() => {
  h.calls = [];
  h.reply = () => text("ok");
  h.row = {};
  __resetTierConfigForTests();
});

/* ─── The rules (pure) ──────────────────────────────────────────────────── */

describe("the rules", () => {
  const allKeys = () => true;

  it("every kind of work has a default tier that is a real tier", () => {
    expect(AI_TASK_IDS.length).toBeGreaterThanOrEqual(10);
    for (const task of AI_TASK_IDS) {
      expect(AI_TIERS, task).toContain(AI_TASKS[task].defaultTier);
      expect(AI_TASKS[task].label.length, task).toBeGreaterThan(3);
      expect(AI_TASKS[task].detail.length, task).toBeGreaterThan(10);
    }
    // What the owner was told: writing to a prospect and choosing who to
    // target get the strongest model; sorting and scoring get the cheapest.
    expect(AI_TASKS.outreach.defaultTier).toBe("deep");
    expect(AI_TASKS.targeting.defaultTier).toBe("deep");
    expect(AI_TASKS.elsie.defaultTier).toBe("standard");
    expect(AI_TASKS.help.defaultTier).toBe("standard");
    expect(AI_TASKS.replies.defaultTier).toBe("fast");
    expect(AI_TASKS.scoring.defaultTier).toBe("fast");
    expect(AI_TASKS.suggestions.defaultTier).toBe("fast");
  });

  it("a workspace's own choice beats the default, and only for that task", () => {
    expect(tierForTask("scoring", {})).toBe("fast");
    expect(tierForTask("scoring", { scoring: "deep" })).toBe("deep");
    expect(tierForTask("replies", { scoring: "deep" })).toBe("fast");
  });

  it("with nothing set, every task gets no model of its own: the default is used", () => {
    for (const task of AI_TASK_IDS) {
      const pick = pickTierModel({ task, tiers: {}, taskTiers: {}, hasKey: allKeys });
      expect(pick.use, task).toBeNull();
      expect(canStepUp(pick, { tiers: {}, taskTiers: {}, hasKey: allKeys }), task).toBe(false);
    }
  });

  it("a call with no task is 'everything else'", () => {
    const pick = pickTierModel({ task: undefined, tiers: { standard: { provider: "anthropic", model: "s" } }, taskTiers: {}, hasKey: allKeys });
    expect(pick.task).toBe("general");
    expect(pick.use?.model).toBe("s");
  });

  it("a tier whose provider has no key here is treated as not set", () => {
    const tiers: TierModels = { fast: { provider: "openai", model: "cheap" } };
    const pick = pickTierModel({ task: "scoring", tiers, taskTiers: {}, hasKey: (p: AiProviderId) => p === "anthropic" });
    expect(pick.tier).toBe("fast");
    expect(pick.use).toBeNull();
  });

  it("a step up lands only on a tier that is set, and never moves down", () => {
    const fastOnly: TierModels = { fast: { provider: "anthropic", model: "f" } };
    // Fast is set, nothing above it: a step up stays on Fast. Falling back to
    // the unset Standard would mean the default model, which may be cheaper.
    const stay = pickTierModel({ task: "scoring", stepUp: 1, tiers: fastOnly, taskTiers: {}, hasKey: allKeys });
    expect(stay.tier).toBe("fast");
    expect(stay.use?.model).toBe("f");
    expect(canStepUp(pickTierModel({ task: "scoring", tiers: fastOnly, taskTiers: {}, hasKey: allKeys }), { tiers: fastOnly, taskTiers: {}, hasKey: allKeys })).toBe(false);

    // Standard is skipped when unset; Deep is the next one that is set.
    const fastDeep: TierModels = { fast: { provider: "anthropic", model: "f" }, deep: { provider: "anthropic", model: "d" } };
    const up = pickTierModel({ task: "scoring", stepUp: 1, tiers: fastDeep, taskTiers: {}, hasKey: allKeys });
    expect(up.tier).toBe("deep");
    expect(up.use?.model).toBe("d");
    // From an unset tier (Elsie on Standard) up to the one that is set.
    const elsie = pickTierModel({ task: "elsie", stepUp: 1, tiers: fastDeep, taskTiers: {}, hasKey: allKeys });
    expect(elsie.baseTier).toBe("standard");
    expect(elsie.use?.model).toBe("d");
    // Already at the top: nowhere to go.
    const top = pickTierModel({ task: "outreach", stepUp: 2, tiers: fastDeep, taskTiers: {}, hasKey: allKeys });
    expect(top.tier).toBe("deep");
    expect(canStepUp(top, { tiers: fastDeep, taskTiers: {}, hasKey: allKeys })).toBe(false);
  });

  it("stepping up to the same model is not a step", () => {
    const same: TierModels = { fast: { provider: "anthropic", model: "x" }, standard: { provider: "anthropic", model: "x" } };
    const pick = pickTierModel({ task: "scoring", tiers: same, taskTiers: {}, hasKey: allKeys });
    expect(canStepUp(pick, { tiers: same, taskTiers: {}, hasKey: allKeys })).toBe(false);
  });

  it("stored settings are read back as only their well-formed parts", () => {
    expect(cleanTierModels(null)).toEqual({});
    expect(cleanTierModels("fast")).toEqual({});
    expect(cleanTierModels({
      fast: { provider: "anthropic", model: "  f  " },
      standard: { provider: "deepseek", model: "x" }, // not a provider this build can call
      deep: { provider: "openai", model: "" },
      turbo: { provider: "openai", model: "y" },
    })).toEqual({ fast: { provider: "anthropic", model: "f" } });
    expect(cleanTaskTiers({ scoring: "deep", elsie: "ultra", nonsense: "fast" })).toEqual({ scoring: "deep" });
  });
});

/* ─── The routing, through the real invokeLLM ───────────────────────────── */

describe("invokeLLM", () => {
  it("NOTHING SET: every kind of work runs on the default model, as before tiers existed", async () => {
    for (const task of AI_TASK_IDS) await ask({ task });
    await ask({ task: "elsie", stepUp: 1 });
    await ask();
    expect(h.calls.length).toBe(AI_TASK_IDS.length + 2);
    expect(new Set(h.calls.map((c) => c.model))).toEqual(new Set([DEFAULT_MODEL]));
  });

  it("a set tier's model is used for the work assigned to it, and only that work", async () => {
    h.row = { tiers: { fast: { provider: "anthropic", model: "fast-model" }, deep: { provider: "anthropic", model: "deep-model" } } };
    await ask({ task: "scoring" });
    await ask({ task: "replies" });
    await ask({ task: "outreach" });
    await ask({ task: "elsie" }); // Standard, which is not set
    await ask(); // no task: "everything else", also Standard
    expect(h.calls.map((c) => c.model)).toEqual(["fast-model", "fast-model", "deep-model", DEFAULT_MODEL, DEFAULT_MODEL]);
  });

  it("the workspace can move a kind of work to another tier", async () => {
    h.row = {
      tiers: { fast: { provider: "anthropic", model: "fast-model" }, deep: { provider: "anthropic", model: "deep-model" } },
      taskTiers: { replies: "deep", outreach: "fast" },
    };
    await ask({ task: "replies" });
    await ask({ task: "outreach" });
    await ask({ task: "scoring" });
    expect(h.calls.map((c) => c.model)).toEqual(["deep-model", "fast-model", "fast-model"]);
  });

  it("Elsie's later rounds run one tier up", async () => {
    h.row = { tiers: { standard: { provider: "anthropic", model: "std-model" }, deep: { provider: "anthropic", model: "deep-model" } } };
    await ask({ task: "elsie" });
    await ask({ task: "elsie", stepUp: 1 });
    expect(h.calls.map((c) => c.model)).toEqual(["std-model", "deep-model"]);
  });

  it("a caller that names its own model keeps it", async () => {
    h.row = { tiers: { fast: { provider: "anthropic", model: "fast-model" } } };
    await ask({ task: "scoring", model: "the-callers-model" });
    await ask({ task: "scoring", provider: "anthropic" });
    expect(h.calls.map((c) => c.model)).toEqual(["the-callers-model", DEFAULT_MODEL]);
  });

  it("a tier set to a provider with no key falls back to the default model, and does not fail", async () => {
    h.row = { tiers: { fast: { provider: "openai", model: "gpt-cheap" } } };
    await ask({ task: "scoring" });
    expect(h.calls.map((c) => c.model)).toEqual([DEFAULT_MODEL]);
  });

  it("a reply that had to be JSON and is not is tried once more, one set tier up", async () => {
    h.row = { tiers: { fast: { provider: "anthropic", model: "fast-model" }, deep: { provider: "anthropic", model: "deep-model" } } };
    h.reply = (p) => (p.model === "fast-model" ? text("I think it is probably fine.") : toolUse({ score: 80 }));
    const res = await ask({ task: "scoring", outputSchema: { name: "score", schema: { type: "object", properties: { score: { type: "number" } } } } });
    expect(h.calls.map((c) => c.model)).toEqual(["fast-model", "deep-model"]);
    expect(JSON.parse(String(res.choices[0].message.content))).toEqual({ score: 80 });
  });

  it("with no stronger tier set there is no second call, and a good reply never gets one", async () => {
    const schema = { outputSchema: { name: "score", schema: { type: "object", properties: { score: { type: "number" } } } } };
    h.row = { tiers: { fast: { provider: "anthropic", model: "fast-model" } } };
    h.reply = () => text("not json at all");
    await ask({ task: "scoring", ...schema });
    expect(h.calls.length).toBe(1);

    h.calls = [];
    __resetTierConfigForTests();
    h.row = { tiers: { fast: { provider: "anthropic", model: "fast-model" }, deep: { provider: "anthropic", model: "deep-model" } } };
    h.reply = () => toolUse({ score: 3 });
    await ask({ task: "scoring", ...schema });
    expect(h.calls.map((c) => c.model)).toEqual(["fast-model"]);

    // A plain-text call is never judged by a JSON check.
    h.calls = [];
    h.reply = () => text("just prose");
    await ask({ task: "scoring" });
    expect(h.calls.length).toBe(1);
  });

  it("the format check asks only whether JSON came back", () => {
    const res = (content: string, tool_calls?: unknown[]) => ({ id: "x", created: 0, model: "m", choices: [{ index: 0, message: { role: "assistant", content, ...(tool_calls ? { tool_calls } : {}) }, finish_reason: "stop" }] }) as any;
    const json = { messages: [], responseFormat: { type: "json_object" } } as any;
    expect(failedItsFormat(json, res("nope"))).toBe(true);
    expect(failedItsFormat(json, res('{"a":1}'))).toBe(false);
    expect(failedItsFormat(json, res('```json\n{"a":1}\n```'))).toBe(false);
    expect(failedItsFormat(json, res("", [{ id: "1" }]))).toBe(false);
    expect(failedItsFormat({ messages: [] } as any, res("nope"))).toBe(false);
    expect(failedItsFormat({ messages: [], responseFormat: { type: "text" } } as any, res("nope"))).toBe(false);
  });
});

/* ─── Every call names its kind of work ─────────────────────────────────── */

describe("every model call names its task", () => {
  /** Calls that name their own provider: a key or tier test must hit what it tests. */
  const NAMES_ITS_PROVIDER = ["server/routers/aiCredentials.ts::test", "server/routers/aiCredentials.ts::testTier"];
  const sites = findLlmCallSites();

  it("finds the call sites at all", () => {
    expect(sites.length).toBeGreaterThan(60);
  });

  it("a call with no task is on the short list of provider tests, checked both ways", () => {
    const without = sites.filter((s) => !/\btask:/.test(s.args)).map((s) => s.key);
    expect(without.filter((k) => !NAMES_ITS_PROVIDER.includes(k)), "a model call that does not say what kind of work it is").toEqual([]);
    expect(NAMES_ITS_PROVIDER.filter((k) => !without.includes(k)), "listed as a provider test, but gone or now naming a task").toEqual([]);
    for (const k of NAMES_ITS_PROVIDER) {
      expect(sites.find((s) => s.key === k)?.args, k).toMatch(/\bprovider:/);
    }
  });

  it("every task named in a call is one the catalog has", () => {
    const named = new Set<string>();
    for (const s of sites) for (const m of Array.from(s.args.matchAll(/\btask:\s*([^,\n]+)/g))) {
      for (const lit of Array.from(m[1].matchAll(/"([a-z_]+)"/g))) named.add(lit[1]);
    }
    expect(named.size).toBeGreaterThanOrEqual(10);
    expect(Array.from(named).filter((t) => !isAiTask(t))).toEqual([]);
    // And every task in the catalog is used by some call, "general" included.
    expect(AI_TASK_IDS.filter((t) => !named.has(t)), "a task the settings screen offers that no call uses").toEqual([]);
  });

  it("the streaming helper makes its callers say, and both streams route like invokeLLM", () => {
    const helpers = read("server/_core/streamHelpers.ts");
    const type = helpers.slice(helpers.indexOf("export type BuildMessagesResult = {"), helpers.indexOf("export type StreamHandlerOptions"));
    expect(type).toMatch(/\n\s+task: import\("@shared\/aiTiers"\)\.AiTask;/);
    expect(helpers).toContain("task: built.task,");
    const stream = read("server/_core/llmStream.ts");
    const fn = stream.slice(stream.indexOf("export async function* streamLLM("));
    const route = fn.indexOf("params = (await applyTier(params, workspaceId, creds)).params;");
    expect(route).toBeGreaterThan(-1);
    expect(fn.slice(route)).toContain("const provider = resolveProvider(params.provider, creds);");
    expect(fn.slice(0, route)).toContain("const creds = await loadCreds(workspaceId);");
  });

  it("Elsie steps up once she has looked things up, and on her forced final answer", () => {
    const src = read("server/routers/assistant.ts");
    expect(src).toMatch(/task: "elsie",[\s\S]{0,420}stepUp: round > 0 \? 1 : 0,/);
    expect(src).toContain('invokeLLM({ task: "elsie", stepUp: 1, messages, maxTokens: 1400, workspaceId: ctx.workspace.id })');
  });
});

/* ─── Storage and the screen ────────────────────────────────────────────── */

describe("settings", () => {
  it("two nullable columns, added by a migration, and never read with the keys", () => {
    const schema = read("drizzle/schema.ts");
    expect(schema).toContain('aiTierModels: json("aiTierModels"),');
    expect(schema).toContain('aiTaskTiers: json("aiTaskTiers"),');
    const mig = read("server/_core/rawMigrations.ts");
    const block = mig.slice(mig.indexOf('name: "0441_ai_model_tiers.sql"'));
    expect(block.slice(0, 400)).toContain("ALTER TABLE `workspace_settings` ADD COLUMN `aiTierModels` json NULL");
    expect(block.slice(0, 400)).toContain("ALTER TABLE `workspace_settings` ADD COLUMN `aiTaskTiers` json NULL");
    // The migration runs after the server starts. The read of the provider
    // keys must not name the new columns, or every key lookup would fail (and
    // fall back to the server's keys) until it has run.
    const llm = read("server/_core/llm.ts");
    const loadCreds = llm.slice(llm.indexOf("async function loadCreds("), llm.indexOf("// Anthropic", llm.indexOf("async function loadCreds(")));
    expect(loadCreds.length).toBeGreaterThan(500);
    expect(loadCreds).not.toMatch(/aiTierModels|aiTaskTiers/);
    const streamSrc = read("server/_core/llmStream.ts");
    expect(streamSrc).not.toMatch(/aiTierModels|aiTaskTiers/);
    // And the tier read itself fails to "not set", never to an error.
    const svc = read("server/services/aiTiers.ts");
    const load = svc.slice(svc.indexOf("export async function loadTierConfig("), svc.indexOf("export function forgetTierConfig("));
    expect(load).toMatch(/\} catch \(err\) \{/);
    expect(load.slice(load.indexOf("} catch (err) {"))).not.toMatch(/throw/);
  });

  it("only an admin with the keys permission can change a tier, and a save is audited and takes effect at once", () => {
    const src = read("server/routers/aiCredentials.ts");
    for (const name of ["setTier", "setTaskTier"]) {
      const start = src.indexOf(`  ${name}: adminWsProcedure`);
      expect(start, name).toBeGreaterThan(-1);
      const body = src.slice(start, src.indexOf("\n    }),", start));
      expect(body, name).toContain('await checkPermission(ctx, "manage_api_keys");');
      expect(body, name).toContain("forgetTierConfig(ctx.workspace.id);");
      expect(body, name).toContain("await recordAudit(");
    }
    expect(src).toMatch(/\n  getTiers: workspaceProcedure\.query\(/);
    expect(src).toMatch(/\n  testTier: adminWsProcedure/);
  });

  it("the card is on the AI providers screen and lists every kind of work from the catalog", () => {
    const settings = read("client/src/pages/usip/Settings.tsx");
    const section = settings.slice(settings.indexOf("function AIProvidersSection("), settings.indexOf("function ProposalsTab("));
    expect(section).toContain("<ModelTiersCard isAdmin={isAdmin} />");
    const card = read("client/src/components/usip/settings/ModelTiersCard.tsx");
    expect(card).toContain("{AI_TASK_IDS.map((task) => {");
    expect(card).toContain("{AI_TIERS.map((tier) => {");
    // Choosing a task's default tier clears the override instead of storing it.
    expect(card).toContain('tier: v === info.defaultTier ? "" : (v as AiTier)');
    // And the card says, in words, that blank means no change.
    expect(card).toContain("nothing\n            changes until you set one");
  });
});
