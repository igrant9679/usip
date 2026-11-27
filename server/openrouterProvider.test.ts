/**
 * OpenRouter, a fifth AI provider (owner decisions 2026-11-27,
 * openrouter-spec.md). What these pin, against the real invokeLLM,
 * streamLLM, key shares and procedures on the SQL-evaluating fake (only
 * fetch, the Anthropic SDK and the meter are stubs):
 *
 *   - THE KEY ORDER: a workspace's own OpenRouter key, then one lent to it,
 *     then the platform's shared key (OPENROUTER_API_KEY), and the ledger
 *     says whose account paid
 *   - NOTHING MOVES UNASKED: the shared key alone sends nobody to OpenRouter;
 *     a workspace's choice, a tier, or the platform default does
 *   - THE PLATFORM DEFAULT: unset until the platform owner sets it; it moves
 *     only workspaces with no choice and no key of their own
 *   - THE MODEL: the newest Claude Sonnet that takes tools, read from the live
 *     list; and a call that needs a structured answer only ever goes to a
 *     model whose listing says it can give one
 *   - METERING from the response's usage, with OpenRouter's own cost, inside
 *     the same monthly budget and burst ceiling as every other call
 *   - ERRORS in OpenRouter's words: 401 bad key, 402 out of credit, 429 and
 *     5xx tried again
 *   - THE KEY in Settings: checked with OpenRouter before it is kept, stored
 *     encrypted, never sent to a browser
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => {
  if (!process.env.ENCRYPTION_KEY && !process.env.JWT_SECRET) process.env.ENCRYPTION_KEY = "c".repeat(64);
  return {
    db: null as any,
    /** Every chat request sent to OpenRouter. */
    fetches: [] as Array<{ url: string; headers: Record<string, string>; body: any }>,
    respond: (_n: number, _body: any): Response => { throw new Error("unscripted OpenRouter reply"); },
    models: (): Response => { throw new Error("unscripted model list"); },
    modelReads: 0,
    keyChecks: [] as string[],
    keyReply: (): Response => { throw new Error("unscripted key check"); },
    anthropic: [] as Array<{ apiKey: string; model: string }>,
    ledger: [] as any[],
    tokens: [] as number[],
  };
});

vi.mock("./db", async (a) => ({
  ...(await a<typeof import("./db")>()),
  getDb: async () => h.db,
  hasPermission: async () => true,
  checkPermission: async () => {},
}));

vi.mock("./_core/env", async (a) => {
  const actual = await a<typeof import("./_core/env")>();
  // The deployment has an Anthropic key, as the live one does, and the owner has put in the shared OpenRouter key.
  return {
    ...actual,
    ENV: { ...actual.ENV, anthropicApiKey: "env-anthropic-key", openaiApiKey: "", geminiApiKey: "", deepseekApiKey: "", openrouterApiKey: "sk-or-v1-PLATFORM-SHARED-0000", aiDefaultProvider: "" },
  };
});

vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    apiKey: string;
    constructor(opts: { apiKey: string }) { this.apiKey = opts.apiKey; }
    messages = {
      create: async (p: any) => {
        h.anthropic.push({ apiKey: this.apiKey, model: p.model });
        return { id: "msg", model: p.model, content: [{ type: "text", text: "from anthropic" }], stop_reason: "end_turn", usage: { input_tokens: 3, output_tokens: 2 } };
      },
      stream: (p: any) => {
        h.anthropic.push({ apiKey: this.apiKey, model: p.model });
        return (async function* () {
          yield { type: "message_start", message: { model: p.model, usage: { input_tokens: 3 } } };
          yield { type: "content_block_delta", delta: { type: "text_delta", text: "from anthropic" } };
        })();
      },
    };
  },
}));

vi.mock("./services/spend", async (a) => ({
  ...(await a<typeof import("./services/spend")>()),
  recordAiUsage: async (e: unknown) => { h.ledger.push(e); },
}));
vi.mock("./usageCounters", async (a) => ({
  ...(await a<typeof import("./usageCounters")>()),
  recordLlmTokens: async (_ws: unknown, n: number) => { h.tokens.push(n); },
}));

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { appRouter } from "./routers";
import { workspaceSettings } from "../drizzle/schema";
import { ENV } from "./_core/env";
import { encryptSecret, tryDecryptSecret } from "./_core/crypto";
import { __resetForcedToolMemoryForTests, __resetLlmBurstForTests, invokeLLM, isRetryableLLMError, openrouterUsage } from "./_core/llm";
import { streamLLM } from "./_core/llmStream";
import { runWithRequestContext } from "./_core/requestContext";
import { SETTINGS_SECRET_FIELDS } from "./_core/safeProjections";
import { appBaseUrl } from "./appUrl";
import { __resetTierConfigForTests } from "./services/aiTiers";
import { OPENROUTER_CHAT_URL, OPENROUTER_KEY_URL, OPENROUTER_MODELS_URL, __resetOpenRouterModelsForTests } from "./services/openrouter";
import { openrouterSettings } from "./services/openrouterSettings";
import { invalidatePlatformAiCache } from "./services/platformAi";
import { SHARE_KINDS, SHARE_KIND_LABEL } from "./services/keyShares";
import { usageMonthKey } from "./usageCounters";
import { AI_PROVIDER_IDS, AI_PROVIDER_LABEL } from "@shared/aiTiers";
import {
  OPENROUTER_FALLBACK_MODEL,
  canAnswerStructured,
  defaultOpenRouterModel,
  modelsForStructuredAnswers,
  openrouterMode,
  parseOpenRouterModels,
  priceLabel,
} from "@shared/openrouterModels";
import { VENDOR_LABEL, averageCallCostUsd, summarizeSpend } from "@shared/spendReport";

const ROOT = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");

const A = 2; // LSI Media
const B = 4; // CommunityForce
const C = 6; // a workspace whose monthly AI budget is used up
const OWNER = 10; // super_admin of A and B
const SHARED = "sk-or-v1-PLATFORM-SHARED-0000";
const OWN_A = "sk-or-v1-lsi-AAAA1111";
const OWN_B = "sk-or-v1-cf-BBBB2222";
const HAIKU = "claude-haiku-4-5-20251001";
const SONNET = "anthropic/claude-sonnet-5.5";
const STRUCTURED = "respond_with_structured_output";

/* ─── OpenRouter's model list, as /api/v1/models answers ───────────────── */

const ALL = ["max_tokens", "temperature", "tools", "tool_choice", "response_format", "structured_outputs"];
const NO_TEMP = ["max_tokens", "tools", "tool_choice", "response_format", "structured_outputs"];
const model = (id: string, created: number, params: string[], extra: Record<string, unknown> = {}) => ({
  id, name: id, created, context_length: 200_000,
  architecture: { output_modalities: ["text"] },
  pricing: { prompt: "0.000003", completion: "0.000015" },
  supported_parameters: params,
  ...extra,
});
const LIST = [
  model("anthropic/claude-sonnet-4.5", 1_759_100_000, ALL, { name: "Anthropic: Claude Sonnet 4.5" }),
  model(SONNET, 1_790_618_686, NO_TEMP, { name: "Anthropic: Claude Sonnet 5.5", pricing: { prompt: "0.000002", completion: "0.00001" } }),
  model("anthropic/claude-sonnet-5.5:batch", 1_790_618_687, NO_TEMP), // not answered interactively
  model("anthropic/claude-sonnet-6:thinking", 1_799_999_999, NO_TEMP), // a variant, not the model
  model("anthropic/claude-opus-5.5", 1_790_000_000, NO_TEMP, { name: "Anthropic: Claude Opus 5.5" }),
  model("openai/gpt-5-mini", 1_780_000_000, ["max_tokens", "temperature", "response_format", "structured_outputs"], { name: "OpenAI: GPT-5 Mini" }),
  model("acme/json-only", 1_770_000_000, ["max_tokens", "temperature", "response_format"], { name: "Acme: JSON Only" }),
  model("acme/tools-no-choice", 1_765_000_000, ["max_tokens", "temperature", "tools"], { name: "Acme: Tools, no choice" }),
  model("acme/plain", 1_760_000_000, ["max_tokens", "temperature"], { name: "Acme: Plain" }),
  model("google/image-maker", 1_795_000_000, ALL, { architecture: { output_modalities: ["image", "text"] } }),
  model("openrouter/auto", 1_700_000_000, ALL, { name: "Auto Router", pricing: { prompt: "-1", completion: "-1" } }),
];
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });

/** A chat completion as OpenRouter returns one. */
const completion = (over: { content?: string | null; tool_calls?: unknown[]; usage?: Record<string, unknown>; model?: string } = {}) =>
  json({
    id: "gen-1",
    created: 1,
    model: over.model ?? SONNET,
    choices: [{ index: 0, message: { role: "assistant", content: "content" in over ? over.content : "pong", ...(over.tool_calls ? { tool_calls: over.tool_calls } : {}) }, finish_reason: over.tool_calls ? "tool_calls" : "stop" }],
    usage: over.usage ?? { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, cost: 0.00004 },
  });
const toolCall = (args: unknown, name = STRUCTURED) => [{ id: "call_1", type: "function", function: { name, arguments: JSON.stringify(args) } }];
const orError = (status: number, message: string, extra: Record<string, unknown> = {}) => json({ error: { code: status, message, ...extra } }, status);

const rows = (t: string) => h.db.rowsOf(t) as any[];
const settings = (ws: number) => rows("workspace_settings").find((r) => r.workspaceId === ws);
const caller = (ws: number, role: "user" | "admin" = "user") => appRouter.createCaller({
  user: { id: OWNER, openId: "u10", email: "u10@example.com", name: "U10", loginMethod: "password", role, createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date(), mfaTotpEnabledAt: null },
  req: { protocol: "https", headers: { "x-workspace-id": String(ws) } },
  res: { clearCookie: () => {} },
} as unknown as TrpcContext);

const ask = (ws: number | undefined, extra: Record<string, unknown> = {}) =>
  invokeLLM({ workspaceId: ws, task: "general", messages: [{ role: "user", content: "hello" }], ...extra } as any);
const schema = { type: "object", properties: { score: { type: "number" } }, required: ["score"] };
const noWaits = () => vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void) => { fn(); return 0; }) as never);

beforeEach(() => {
  h.db = makeSqlFakeDb({ realMembers: true });
  h.fetches = [];
  h.anthropic = [];
  h.ledger = [];
  h.tokens = [];
  h.modelReads = 0;
  h.keyChecks = [];
  h.respond = () => completion();
  h.models = () => json({ data: LIST });
  h.keyReply = () => json({ data: { label: "sk-or-v1-cf-...2222", limit: 20, limit_remaining: 12.5, usage: 7.5, is_free_tier: false } });
  (ENV as any).openrouterApiKey = SHARED;
  __resetTierConfigForTests();
  __resetOpenRouterModelsForTests();
  __resetForcedToolMemoryForTests();
  __resetLlmBurstForTests();
  invalidatePlatformAiCache();
  rows("users").push({ id: OWNER, openId: "u10", email: "u10@example.com", name: "U10", loginMethod: "password", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date(), mfaTotpEnabledAt: null });
  const ws = (id: number, name: string) => ({ id, name, slug: `ws${id}`, ownerUserId: OWNER, archivedAt: null, plan: "trial" });
  rows("workspaces").push(ws(A, "LSI Media"), ws(B, "CommunityForce"), ws(C, "Over Budget"));
  rows("workspace_members").push(
    { id: 1, workspaceId: A, userId: OWNER, role: "super_admin", deactivatedAt: null, inviteToken: null, lastActiveAt: new Date() },
    { id: 2, workspaceId: B, userId: OWNER, role: "super_admin", deactivatedAt: null, inviteToken: null, lastActiveAt: new Date() },
  );
  const base = {
    enforce2fa: false, timezone: "America/New_York",
    anthropicApiKeyEnc: null, openaiApiKeyEnc: null, geminiApiKeyEnc: null, deepseekApiKeyEnc: null, openrouterApiKeyEnc: null, xaiApiKeyEnc: null, apolloApiKeyEnc: null, reoonApiKeyEnc: null, quickenrichApiKeyEnc: null,
    anthropicModel: null, openaiModel: null, geminiModel: null, deepseekModel: null, openrouterModel: null, aiDefaultProvider: null, aiTierModels: null, aiTaskTiers: null, llmMonthlyTokenCap: null,
  };
  rows("workspace_settings").push({ ...base, workspaceId: A }, { ...base, workspaceId: B }, { ...base, workspaceId: C });
  vi.stubGlobal("fetch", vi.fn(async (url: unknown, init?: { headers?: Record<string, string>; body?: string }) => {
    const u = String(url);
    const headers = init?.headers ?? {};
    if (u === OPENROUTER_MODELS_URL) { h.modelReads++; return h.models(); }
    if (u === OPENROUTER_KEY_URL) { h.keyChecks.push(headers.authorization); return h.keyReply(); }
    const body = JSON.parse(init?.body ?? "{}");
    h.fetches.push({ url: u, headers, body });
    return h.respond(h.fetches.length, body);
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/* ─── The key order ─────────────────────────────────────────────────────── */

describe("the key order: own key, then a lent one, then the platform's shared key", () => {
  beforeEach(() => { settings(B).aiDefaultProvider = "openrouter"; });

  it("a workspace's own key comes first, and the ledger bills the workspace", async () => {
    settings(B).openrouterApiKeyEnc = encryptSecret(OWN_B);
    await ask(B);
    expect(h.fetches.map((f) => [f.url, f.headers.authorization])).toEqual([[OPENROUTER_CHAT_URL, `Bearer ${OWN_B}`]]);
    expect(h.ledger[0]).toMatchObject({ workspaceId: B, vendor: "openrouter", keySource: "workspace" });
  });

  it("a key another workspace lends comes next, and counts as the workspace's own", async () => {
    settings(A).openrouterApiKeyEnc = encryptSecret(OWN_A);
    await caller(A).keyShares.share({ kind: "openrouter", targetWorkspaceId: B });
    await ask(B);
    expect(h.fetches[0].headers.authorization).toBe(`Bearer ${OWN_A}`);
    expect(h.ledger[0]).toMatchObject({ vendor: "openrouter", keySource: "workspace" });
    expect(settings(B).openrouterApiKeyEnc).toBeNull();
  });

  it("with neither, the platform's shared key, billed to the platform", async () => {
    await ask(B);
    expect(h.fetches[0].headers.authorization).toBe(`Bearer ${SHARED}`);
    expect(h.ledger[0]).toMatchObject({ workspaceId: B, vendor: "openrouter", keySource: "shared" });
  });

  it("with no shared key either, OpenRouter is not called and the key test says so", async () => {
    (ENV as any).openrouterApiKey = "";
    await ask(B);
    expect(h.fetches).toEqual([]);
    expect(h.anthropic).toEqual([{ apiKey: "env-anthropic-key", model: HAIKU }]);
    const err = await caller(B).aiCredentials.test({ provider: "openrouter" }).catch((e) => e);
    expect(err.message).toBe("OpenRouter API key is not configured (workspace or OPENROUTER_API_KEY env)");
    expect(h.fetches).toEqual([]);
  });
});

/* ─── Who is sent to OpenRouter ─────────────────────────────────────────── */

describe("nothing reaches OpenRouter unasked", () => {
  it("the shared key alone moves nobody: a workspace with no choice stays on today's default", async () => {
    await ask(B);
    await ask(B, { task: "scoring" });
    expect(h.fetches).toEqual([]);
    expect(h.anthropic.map((c) => c.model)).toEqual([HAIKU, HAIKU]);
  });

  it("a workspace's own OpenRouter key alone changes nothing while another provider has a key", async () => {
    settings(B).openrouterApiKeyEnc = encryptSecret(OWN_B);
    await ask(B);
    expect(h.fetches).toEqual([]);
    expect(h.anthropic.length).toBe(1);
  });

  it("a tier set to OpenRouter sends that tier's work there, and only that work", async () => {
    settings(B).aiTierModels = { fast: { provider: "openrouter", model: "anthropic/claude-opus-5.5" } };
    await ask(B, { task: "scoring" }); // Fast
    await ask(B, { task: "outreach" }); // Deep, not set
    expect(h.fetches.map((f) => [f.body.model, f.headers.authorization])).toEqual([["anthropic/claude-opus-5.5", `Bearer ${SHARED}`]]);
    expect(h.anthropic.map((c) => c.model)).toEqual([HAIKU]);
  });
});

/* ─── The platform default ──────────────────────────────────────────────── */

describe("the platform default provider", () => {
  it("is not set until the platform owner sets it, and only the platform owner can", async () => {
    expect(await caller(B, "admin").aiCredentials.platformAi()).toMatchObject({
      defaultProvider: null,
      deploymentKeys: { anthropic: true, openai: false, gemini: false, deepseek: false, openrouter: true },
    });
    const notOwner = await caller(B).aiCredentials.setPlatformDefault({ provider: "openrouter" }).catch((e) => e);
    expect(notOwner.code).toBe("FORBIDDEN");
    expect(await caller(B).aiCredentials.platformAi().catch((e) => e.code)).toBe("FORBIDDEN");
    expect(rows("platform_settings")).toEqual([]);
  });

  it("cannot be a provider the server has no shared key for", async () => {
    (ENV as any).openrouterApiKey = "";
    const err = await caller(B, "admin").aiCredentials.setPlatformDefault({ provider: "openrouter" }).catch((e) => e);
    expect(err.code).toBe("BAD_REQUEST");
    expect(err.message).toContain("Set OPENROUTER_API_KEY on Railway first");
    expect(rows("platform_settings")).toEqual([]);
  });

  it("once set to OpenRouter, it moves workspaces with no choice and no key of their own, and no one else", async () => {
    await caller(B, "admin").aiCredentials.setPlatformDefault({ provider: "openrouter" });
    expect(rows("platform_settings")).toEqual([expect.objectContaining({ settingKey: "aiDefaultProvider", value: { provider: "openrouter" } })]);
    expect(rows("audit_log").at(-1)).toMatchObject({ entityType: "platform_settings", before: { aiDefaultProvider: null }, after: { aiDefaultProvider: "openrouter" } });

    // No choice, no key: OpenRouter, on the platform's shared key.
    await ask(B);
    expect(h.fetches.map((f) => f.headers.authorization)).toEqual([`Bearer ${SHARED}`]);
    expect(h.ledger.at(-1)).toMatchObject({ vendor: "openrouter", keySource: "shared" });
    // A call with no workspace at all follows it too.
    await ask(undefined);
    expect(h.fetches.length).toBe(2);

    // Its own Anthropic key: it keeps using it, never the owner's shared OpenRouter key.
    settings(A).anthropicApiKeyEnc = encryptSecret("sk-ant-own-A");
    await ask(A);
    expect(h.anthropic).toEqual([{ apiKey: "sk-ant-own-A", model: HAIKU }]);
    // Its own choice: kept.
    settings(B).aiDefaultProvider = "anthropic";
    await ask(B);
    expect(h.anthropic.at(-1)).toEqual({ apiKey: "env-anthropic-key", model: HAIKU });
    expect(h.fetches.length).toBe(2);

    // Cleared: back to how it was.
    settings(B).aiDefaultProvider = null;
    await caller(B, "admin").aiCredentials.setPlatformDefault({ provider: "" });
    await ask(B);
    expect(h.fetches.length).toBe(2);
    expect(h.anthropic.length).toBe(3);
  });

  it("streams follow it too", async () => {
    await caller(B, "admin").aiCredentials.setPlatformDefault({ provider: "openrouter" });
    h.respond = () => new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', { status: 200 });
    let out = "";
    for await (const piece of streamLLM({ workspaceId: B, task: "documents", messages: [{ role: "user", content: "Go" }] })) out += piece;
    expect(out).toBe("ok");
    expect(h.fetches[0].url).toBe(OPENROUTER_CHAT_URL);
  });
});

/* ─── The request ───────────────────────────────────────────────────────── */

describe("the OpenRouter request", () => {
  beforeEach(() => {
    settings(B).openrouterApiKeyEnc = encryptSecret(OWN_B);
    settings(B).aiDefaultProvider = "openrouter";
  });

  it("goes to OpenRouter in OpenAI's shape, on the newest Claude Sonnet in the live list, naming only the app", async () => {
    const res = await ask(B, { messages: [{ role: "system", content: "Be brief." }, { role: "user", content: [{ type: "text", text: "hello" }, { type: "text", text: "again" }] }], temperature: 0.2, maxTokens: 300 });
    expect(h.fetches.length).toBe(1);
    const f = h.fetches[0];
    expect(f.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(f.headers).toEqual({ "content-type": "application/json", authorization: `Bearer ${OWN_B}`, "HTTP-Referer": appBaseUrl(), "X-Title": "Velocity" });
    // Sonnet 5.5's listing takes no temperature, so none is sent; a plain call needs no routing rule.
    expect(f.body).toEqual({
      model: SONNET,
      messages: [{ role: "system", content: "Be brief." }, { role: "user", content: [{ type: "text", text: "hello" }, { type: "text", text: "again" }] }],
      max_tokens: 300,
    });
    expect(res.choices[0].message).toEqual({ role: "assistant", content: "pong" });
    expect(res.model).toBe(SONNET);
    // The list is read once and kept.
    await ask(B);
    expect(h.modelReads).toBe(1);
  });

  it("the default follows the live list: a newer Claude Sonnet that takes tools takes over", async () => {
    h.models = () => json({ data: [...LIST, model("anthropic/claude-sonnet-6", 1_800_000_000, NO_TEMP)] });
    await ask(B);
    expect(h.fetches[0].body.model).toBe("anthropic/claude-sonnet-6");
  });

  it("the workspace's own model is used when it names one, with the parameters its listing takes", async () => {
    settings(B).openrouterModel = "openai/gpt-5-mini";
    await ask(B, { temperature: 0.4 });
    expect(h.fetches[0].body).toMatchObject({ model: "openai/gpt-5-mini", temperature: 0.4 });
  });

  it("with OpenRouter's list unreadable, a call still goes, as asked, with nothing stripped", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    h.models = () => new Response("down", { status: 503 });
    await ask(B, { temperature: 0.3 });
    expect(h.fetches[0].body).toEqual({ model: OPENROUTER_FALLBACK_MODEL, messages: [{ role: "user", content: "hello" }], max_tokens: 4096, temperature: 0.3 });
    // A structured call is still asked the way Claude answers it, but cannot route on a listing it does not have.
    h.respond = () => completion({ content: null, tool_calls: toolCall({ score: 1 }) });
    const res = await ask(B, { outputSchema: { name: "score", schema } });
    expect(h.fetches[1].body.tool_choice).toEqual({ type: "function", function: { name: STRUCTURED } });
    expect(h.fetches[1].body).not.toHaveProperty("provider");
    expect(JSON.parse(String(res.choices[0].message.content))).toEqual({ score: 1 });
  });
});

/* ─── Structured answers ────────────────────────────────────────────────── */

describe("a structured answer only ever goes to a model that can give one", () => {
  beforeEach(() => {
    settings(B).openrouterApiKeyEnc = encryptSecret(OWN_B);
    settings(B).aiDefaultProvider = "openrouter";
  });

  it("a schema call on Claude forces one tool whose arguments are the answer, as the Anthropic path does", async () => {
    h.respond = () => completion({ content: null, tool_calls: toolCall({ score: 80 }) });
    const res = await ask(B, { messages: [{ role: "system", content: "Score the lead." }, { role: "user", content: "Acme" }], outputSchema: { name: "score", schema } });
    const body = h.fetches[0].body;
    expect(body.tools).toEqual([{ type: "function", function: { name: STRUCTURED, description: "Return the response strictly as JSON matching the provided schema.", parameters: schema } }]);
    expect(body.tool_choice).toEqual({ type: "function", function: { name: STRUCTURED } });
    expect(body).not.toHaveProperty("response_format");
    expect(body.max_tokens).toBe(8192);
    // Only providers that take every parameter sent: the tool and the forced choice.
    expect(body.provider).toEqual({ require_parameters: true });
    expect(res.choices[0].message).toEqual({ role: "assistant", content: '{"score":80}' });
  });

  it("a JSON-object call gets a permissive object as the tool", async () => {
    h.respond = () => completion({ content: null, tool_calls: toolCall({ colours: ["red"] }) });
    const res = await ask(B, { responseFormat: { type: "json_object" } });
    expect(h.fetches[0].body.tools[0].function.parameters).toEqual({ type: "object", additionalProperties: true });
    expect(JSON.parse(String(res.choices[0].message.content))).toEqual({ colours: ["red"] });
  });

  it("a model with structured outputs and no tools gets response_format json_schema", async () => {
    settings(B).openrouterModel = "openai/gpt-5-mini";
    h.respond = () => completion({ model: "openai/gpt-5-mini", content: '```json\n{"score":5}\n```' });
    const res = await ask(B, { outputSchema: { name: "score", schema } });
    const body = h.fetches[0].body;
    expect(body.model).toBe("openai/gpt-5-mini");
    expect(body.response_format).toEqual({ type: "json_schema", json_schema: { name: "score", schema } });
    expect(body).not.toHaveProperty("tools");
    expect(res.choices[0].message.content).toBe('{"score":5}');
  });

  it("a model with JSON mode only gets json_object, with the schema in the system prompt", async () => {
    settings(B).openrouterModel = "acme/json-only";
    h.respond = () => completion({ model: "acme/json-only", content: '{"score":3}' });
    await ask(B, { messages: [{ role: "system", content: "Score." }, { role: "user", content: "Acme" }], outputSchema: { name: "score", schema } });
    const body = h.fetches[0].body;
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.messages[0]).toEqual({ role: "system", content: `Score.\n\nReply with one JSON object and nothing else. It must match this JSON schema:\n${JSON.stringify(schema)}` });
  });

  it("a model that cannot give a structured answer is never sent one: the default model takes it", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    settings(B).openrouterModel = "acme/plain";
    // Plain text is fine on it.
    await ask(B);
    expect(h.fetches[0].body.model).toBe("acme/plain");
    // A schema call is not.
    h.respond = () => completion({ content: null, tool_calls: toolCall({ score: 9 }) });
    const res = await ask(B, { outputSchema: { name: "score", schema } });
    expect(h.fetches[1].body.model).toBe(SONNET);
    expect(h.fetches[1].body.tool_choice).toEqual({ type: "function", function: { name: STRUCTURED } });
    expect(res.model).toBe(SONNET);
    // Nor are a caller's own tools sent to a model that takes none.
    settings(B).openrouterModel = "acme/json-only";
    const tools = [{ type: "function" as const, function: { name: "classify", parameters: { type: "object" } } }];
    await ask(B, { tools });
    expect(h.fetches[2].body.model).toBe(SONNET);
    expect(h.fetches[2].body.tools).toEqual(tools);
  });

  it("a caller's own tools go as OpenAI's, and its tool call is its structure", async () => {
    const tools = [{ type: "function" as const, function: { name: "classify", description: "Classify", parameters: { type: "object", properties: { label: { type: "string" } } } } }];
    const calls = toolCall({ label: "positive" }, "classify");
    h.respond = () => completion({ content: null, tool_calls: calls });
    const res = await ask(B, { tools, toolChoice: { name: "classify" }, responseFormat: { type: "json_object" } });
    const body = h.fetches[0].body;
    expect(body.tools).toEqual(tools);
    expect(body.tool_choice).toEqual({ type: "function", function: { name: "classify" } });
    expect(body).not.toHaveProperty("response_format");
    expect(res.choices[0].message).toEqual({ role: "assistant", content: "", tool_calls: calls });
  });

  it("a model that takes tools but not tool_choice is offered the tool and told to call it", async () => {
    settings(B).openrouterModel = "acme/tools-no-choice";
    h.respond = () => completion({ content: '{"score":4}' });
    const res = await ask(B, { messages: [{ role: "user", content: "Acme" }], outputSchema: { name: "score", schema } });
    const body = h.fetches[0].body;
    expect(body.tools[0].function.name).toBe(STRUCTURED);
    expect(body).not.toHaveProperty("tool_choice");
    expect(body.messages[0]).toEqual({ role: "system", content: `Respond by calling the ${STRUCTURED} tool exactly once with the complete result. Do not answer in text.` });
    // It answered in text: the JSON alone is passed on.
    expect(res.choices[0].message.content).toBe('{"score":4}');
  });

  it("a model that refuses the forced choice is asked again with the tool offered, and remembered", async () => {
    h.respond = (n) => n === 1
      ? orError(400, "Provider returned error", { metadata: { provider_name: "Anthropic", raw: '{"type":"error","error":{"message":"tool_choice: forced tool use is not supported for this model"}}' } })
      : completion({ content: null, tool_calls: toolCall({ score: 7 }) });
    const res = await ask(B, { outputSchema: { name: "score", schema } });
    expect(h.fetches.length).toBe(2);
    expect(h.fetches[0].body.tool_choice).toEqual({ type: "function", function: { name: STRUCTURED } });
    expect(h.fetches[1].body).not.toHaveProperty("tool_choice");
    expect(h.fetches[1].body.messages[0].content).toContain(`Respond by calling the ${STRUCTURED} tool`);
    expect(JSON.parse(String(res.choices[0].message.content))).toEqual({ score: 7 });
    await ask(B, { outputSchema: { name: "score", schema } });
    expect(h.fetches.length).toBe(3);
    expect(h.fetches[2].body).not.toHaveProperty("tool_choice");
  });
});

/* ─── What a call cost ──────────────────────────────────────────────────── */

describe("usage is metered from the response, inside the same budget and ceiling", () => {
  it("the ledger gets the split, the model that answered, whose key paid, and OpenRouter's own cost", async () => {
    settings(B).openrouterApiKeyEnc = encryptSecret(OWN_B);
    settings(B).aiDefaultProvider = "openrouter";
    h.respond = () => completion({ usage: { prompt_tokens: 1000, completion_tokens: 50, total_tokens: 1050, cost: 0.0042, prompt_tokens_details: { cached_tokens: 600, cache_write_tokens: 100 } } });
    const res = await ask(B, { feature: "leadScoring" });
    expect(h.ledger).toEqual([{ workspaceId: B, vendor: "openrouter", model: SONNET, keySource: "workspace", feature: "leadScoring", usage: { input: 300, output: 50, cacheWrite: 100, cacheRead: 600, costUsd: 0.0042 } }]);
    // The monthly budget counts what every other provider's calls count: input and output.
    expect(h.tokens).toEqual([350]);
    expect(res.usage).toEqual({ prompt_tokens: 300, completion_tokens: 50, total_tokens: 350, cache_creation_input_tokens: 100, cache_read_input_tokens: 600, cost: 0.0042 });
  });

  it("the usage reader takes what is there and nothing else", () => {
    expect(openrouterUsage({ prompt_tokens: 40, completion_tokens: 4 })).toEqual({ input: 40, output: 4, cacheRead: 0, cacheWrite: 0, costUsd: null });
    expect(openrouterUsage(null)).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: null });
    expect(openrouterUsage({ prompt_tokens: 10, completion_tokens: 1, cost: 0 })).toMatchObject({ costUsd: 0 });
  });

  it("the cost is kept as its own meter and priced as OpenRouter's figure, not estimated", async () => {
    const real = await vi.importActual<typeof import("./services/spend")>("./services/spend");
    await real.recordAiUsage({ workspaceId: B, vendor: "openrouter", model: SONNET, keySource: "shared", feature: "leadScoring", usage: { input: 300, output: 50, cacheRead: 600, costUsd: 0.0042 } });
    const ledger = rows("spend_ledger");
    expect(ledger.map((r) => [r.meter, r.quantity]).sort()).toEqual([["cache_read_tokens", 600], ["cost_usd_micros", 4200], ["input_tokens", 300], ["output_tokens", 50]]);
    const day = ledger[0].day;
    const summary = summarizeSpend(ledger.map((r) => ({ ...r, quantity: Number(r.quantity) })), [day]);
    expect(summary.lines.find((l) => l.meter === "cost_usd_micros")?.estUsd).toBeCloseTo(0.0042, 10);
    expect(summary.lines.filter((l) => l.meter !== "cost_usd_micros").every((l) => l.estUsd === null)).toBe(true);
    expect(summary.estUsd).toBeCloseTo(0.0042, 10);
    expect(averageCallCostUsd(ledger.map((r) => ({ ...r, quantity: Number(r.quantity) })))?.perCall).toBeCloseTo(0.0042, 10);
    expect(VENDOR_LABEL.openrouter).toBe("OpenRouter");
  });

  it("a call on the shared key is refused once the workspace's monthly budget is used up", async () => {
    settings(C).aiDefaultProvider = "openrouter";
    settings(C).llmMonthlyTokenCap = 500;
    rows("usage_counters").push({ id: 1, workspaceId: C, month: usageMonthKey(), llmTokens: 1000, emailsSent: 0, createdAt: new Date() });
    const err = await ask(C).catch((e) => e);
    expect(err.message).toContain("monthly AI budget");
    expect(h.fetches).toEqual([]);
  });

  it("and a signed-in user's 30-a-minute ceiling applies to OpenRouter calls as to every other", async () => {
    settings(B).aiDefaultProvider = "openrouter";
    let refused = "";
    for (let i = 0; i < 31 && !refused; i++) {
      await (runWithRequestContext({ userId: 990 }, () => ask(B)) as Promise<unknown>).catch((e: Error) => { refused = e.message; });
    }
    expect(h.fetches.length).toBe(30);
    expect(refused).toContain("more than 30 AI requests in a minute");
  });
});

/* ─── Failures ──────────────────────────────────────────────────────────── */

describe("errors are OpenRouter's own words", () => {
  beforeEach(() => { settings(B).aiDefaultProvider = "openrouter"; });

  it("401: the key is wrong or revoked, said at once and not tried again", async () => {
    settings(B).openrouterApiKeyEnc = encryptSecret(OWN_B);
    h.respond = () => orError(401, "User not found.");
    const err = await ask(B).catch((e) => e);
    expect(err.message).toBe("OpenRouter refused this workspace's OpenRouter key (401: User not found.). The key is wrong or has been revoked.");
    expect(err.status).toBe(401);
    expect(isRetryableLLMError(err)).toBe(false);
    expect(h.fetches.length).toBe(1);
    expect(h.ledger).toEqual([]);
    expect(err.message).not.toContain(OWN_B);
  });

  it("402: out of credit, naming whose key", async () => {
    h.respond = () => orError(402, "Insufficient credits. Add more using https://openrouter.ai/credits");
    const err = await ask(B).catch((e) => e);
    expect(err.message).toBe("OpenRouter says the platform's shared OpenRouter key is out of credit (402: Insufficient credits. Add more using https://openrouter.ai/credits). Add credit at openrouter.ai, or raise the key's limit.");
    expect(isRetryableLLMError(err)).toBe(false);
    expect(err.message).not.toContain(SHARED);
  });

  it("429: tried again after a second, then three seconds, then failed as a failure a job may retry", async () => {
    const waits: number[] = [];
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => { waits.push(ms ?? 0); fn(); return 0; }) as never);
    h.respond = () => orError(429, "Rate limit exceeded");
    const err = await ask(B).catch((e) => e);
    expect(h.fetches.length).toBe(3);
    expect(waits).toEqual([1000, 3000]);
    expect(err.message).toBe("OpenRouter is rate limiting the platform's shared OpenRouter key (429: Rate limit exceeded). Try again in a moment.");
    expect(err.status).toBe(429);
    expect(isRetryableLLMError(err)).toBe(true);
  });

  it("5xx is transient: a provider that is down is tried again", async () => {
    noWaits();
    h.respond = (n) => (n === 1 ? new Response("Bad Gateway", { status: 502, statusText: "Bad Gateway" }) : completion());
    const res = await ask(B);
    expect(h.fetches.length).toBe(2);
    expect(res.choices[0].message.content).toBe("pong");
  });

  it("a 200 that carries an error is an error, with the provider's own words", async () => {
    noWaits();
    h.respond = () => json({ error: { code: 502, message: "Provider returned error", metadata: { provider_name: "Anthropic", raw: "upstream overloaded" } } });
    const err = await ask(B).catch((e) => e);
    expect(h.fetches.length).toBe(3);
    expect(err.message).toBe("OpenRouter request failed (502: Provider returned error (Anthropic): upstream overloaded)");
    expect(isRetryableLLMError(err)).toBe(true);
  });
});

/* ─── Streaming ─────────────────────────────────────────────────────────── */

describe("a streamed reply", () => {
  beforeEach(() => { settings(B).aiDefaultProvider = "openrouter"; });

  it("streams in OpenAI's format and meters the last chunk's usage and cost", async () => {
    const chunk = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
    h.respond = () => new Response(
      ": OPENROUTER PROCESSING\n\n" +
      chunk({ model: SONNET, choices: [{ delta: { content: "Hel" } }] }) +
      chunk({ model: SONNET, choices: [{ delta: { content: "lo" } }] }) +
      chunk({ model: SONNET, choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 500, completion_tokens: 20, total_tokens: 520, cost: 0.0011, prompt_tokens_details: { cached_tokens: 400 } } }) +
      "data: [DONE]\n\n",
      { status: 200 },
    );
    let out = "";
    for await (const piece of streamLLM({ workspaceId: B, task: "documents", feature: "proposal", temperature: 0.3, messages: [{ role: "system", content: "Write." }, { role: "user", content: "Go" }] })) out += piece;
    expect(out).toBe("Hello");
    expect(h.fetches[0].headers.authorization).toBe(`Bearer ${SHARED}`);
    expect(h.fetches[0].body).toEqual({ model: SONNET, messages: [{ role: "system", content: "Write." }, { role: "user", content: "Go" }], stream: true, max_tokens: 4096 });
    expect(h.ledger).toEqual([{ workspaceId: B, vendor: "openrouter", model: SONNET, keySource: "shared", feature: "proposal", usage: { input: 100, output: 20, cacheWrite: 0, cacheRead: 400, costUsd: 0.0011 } }]);
    expect(h.tokens).toEqual([120]);
  });

  it("an error after the stream has started is thrown in OpenRouter's words", async () => {
    h.respond = () => new Response(
      'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n' +
      'data: {"error":{"code":502,"message":"Provider disconnected"},"choices":[{"index":0,"delta":{"content":""},"finish_reason":"error"}]}\n\n',
      { status: 200 },
    );
    let out = "";
    const err = await (async () => {
      for await (const piece of streamLLM({ workspaceId: B, task: "documents", messages: [{ role: "user", content: "Go" }] })) out += piece;
    })().catch((e) => e);
    expect(out).toBe("Hi");
    expect(err.message).toBe("OpenRouter request failed (502: Provider disconnected)");
  });
});

/* ─── The key and the model, in Settings ────────────────────────────────── */

describe("the OpenRouter key and model in Settings", () => {
  it("a key is checked with OpenRouter, stored encrypted, and nobody is shown more than its tail", async () => {
    expect((await caller(B).aiCredentials.get()).openrouter).toEqual({ configured: false, masked: "", sharedFrom: null, model: "", platformKey: true });
    const saved = await caller(B).aiCredentials.upsert({ provider: "openrouter", apiKey: ` ${OWN_B} `, model: "anthropic/claude-opus-5.5" });
    expect(h.keyChecks).toEqual([`Bearer ${OWN_B}`]);
    // The credit, and not the key's label (OpenRouter's default label is the key, shortened).
    expect(saved).toEqual({ ok: true, keyCheck: { limit: 20, limitRemaining: 12.5, usage: 7.5, isFreeTier: false } });
    expect(settings(B).openrouterApiKeyEnc).not.toContain(OWN_B);
    expect(tryDecryptSecret(settings(B).openrouterApiKeyEnc)).toBe(OWN_B);
    expect(settings(B).openrouterModel).toBe("anthropic/claude-opus-5.5");
    const got = await caller(B).aiCredentials.get();
    expect(got.openrouter).toMatchObject({ configured: true, model: "anthropic/claude-opus-5.5", platformKey: true });
    expect(got.openrouter.masked).toContain(OWN_B.slice(-4));
    expect(JSON.stringify(got)).not.toContain(OWN_B.slice(0, 14));
    expect(JSON.stringify(got)).not.toContain(SHARED);
    expect(SETTINGS_SECRET_FIELDS).toContain("openrouterApiKeyEnc");

    await caller(B).aiCredentials.upsert({ provider: "openrouter", apiKey: "" });
    expect(settings(B).openrouterApiKeyEnc).toBeNull();
    expect(h.keyChecks.length).toBe(1);
  });

  it("a key OpenRouter refuses is not kept, and OpenRouter's words say why", async () => {
    h.keyReply = () => orError(401, "No auth credentials found");
    const err = await caller(B).aiCredentials.upsert({ provider: "openrouter", apiKey: "sk-or-v1-wrong" }).catch((e) => e);
    expect(err.code).toBe("BAD_REQUEST");
    expect(err.message).toBe("OpenRouter refused this workspace's OpenRouter key (401: No auth credentials found). The key is wrong or has been revoked.");
    expect(settings(B).openrouterApiKeyEnc).toBeNull();
  });

  it("only a model that can give structured answers can be saved, as the default or for a tier", async () => {
    const plain = await caller(B).aiCredentials.upsert({ provider: "openrouter", model: "acme/plain" }).catch((e) => e);
    expect(plain.message).toBe("Acme: Plain cannot give structured answers on OpenRouter (no tools or structured outputs), and Velocity's AI features need them. Pick another model.");
    const unknown = await caller(B).aiCredentials.upsert({ provider: "openrouter", model: "nope/model" }).catch((e) => e);
    expect(unknown.message).toBe('OpenRouter has no model "nope/model". Pick one from the list.');
    const tier = await caller(B).aiCredentials.setTier({ tier: "fast", provider: "openrouter", model: "acme/plain" }).catch((e) => e);
    expect(tier.code).toBe("BAD_REQUEST");
    expect(settings(B).openrouterModel).toBeNull();
    await caller(B).aiCredentials.setTier({ tier: "fast", provider: "openrouter", model: "openai/gpt-5-mini" });
    expect((await caller(B).aiCredentials.getTiers()).tiers).toEqual({ fast: { provider: "openrouter", model: "openai/gpt-5-mini" } });
  });

  it("the picker lists only models that can give structured answers, with prices, and the live default", async () => {
    const list = await caller(B).aiCredentials.openrouterModels();
    expect(list.models.map((m) => m.id).sort()).toEqual([
      "acme/json-only", "acme/tools-no-choice", "anthropic/claude-opus-5.5", "anthropic/claude-sonnet-4.5", "anthropic/claude-sonnet-6:thinking", SONNET, "openai/gpt-5-mini", "openrouter/auto",
    ].sort());
    // In name order, so each vendor's models sit together ("Anthropic: …", "OpenAI: …").
    const names = list.models.map((m) => m.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
    expect(list.models.map((m) => m.id)).not.toContain("acme/plain");
    expect(list.models.map((m) => m.id)).not.toContain("google/image-maker");
    expect(list.models.map((m) => m.id)).not.toContain("anthropic/claude-sonnet-5.5:batch");
    expect(list.defaultModelId).toBe(SONNET);
    expect(list.models.find((m) => m.id === SONNET)).toMatchObject({ name: "Anthropic: Claude Sonnet 5.5", price: "$2.00 in · $10.00 out per 1M tokens", promptPerMillion: 2, completionPerMillion: 10, tools: true, structuredOutputs: true });
    expect(list.models.find((m) => m.id === "openrouter/auto")!.price).toBe("Price varies");
    expect(list.notOffered).toBe(1);
    expect(list.error).toBeNull();
  });

  it("with no key of its own a workspace can test OpenRouter on the platform's shared key", async () => {
    const tested = await caller(B).aiCredentials.test({ provider: "openrouter" });
    expect(tested).toMatchObject({ ok: true, model: SONNET, reply: "pong" });
    expect(h.fetches.map((f) => [f.headers.authorization, f.body.max_tokens])).toEqual([[`Bearer ${SHARED}`, 8]]);
  });

  it("the platform owner can check the shared key's credit; nobody else can, and the key is never returned", async () => {
    const res = await caller(B, "admin").aiCredentials.checkSharedOpenRouterKey();
    expect(res).toEqual({ ok: true, limit: 20, limitRemaining: 12.5, usage: 7.5, isFreeTier: false });
    expect(h.keyChecks).toEqual([`Bearer ${SHARED}`]);
    expect((await caller(B).aiCredentials.checkSharedOpenRouterKey().catch((e) => e)).code).toBe("FORBIDDEN");
  });

  it("copying a workspace's AI keys brings the OpenRouter key and model, re-encrypted", async () => {
    settings(A).openrouterApiKeyEnc = encryptSecret(OWN_A);
    settings(A).openrouterModel = "openai/gpt-5-mini";
    const res = await caller(B).aiCredentials.copyFromWorkspace({ fromWorkspaceId: A });
    expect(res.providers).toEqual(["openrouter"]);
    expect(tryDecryptSecret(settings(B).openrouterApiKeyEnc)).toBe(OWN_A);
    expect(settings(B).openrouterApiKeyEnc).not.toBe(settings(A).openrouterApiKeyEnc);
    expect(settings(B).openrouterModel).toBe("openai/gpt-5-mini");
  });

  it("it is a provider and a shareable key like the others", () => {
    expect(AI_PROVIDER_IDS).toEqual(["anthropic", "openai", "gemini", "deepseek", "openrouter"]);
    expect(AI_PROVIDER_LABEL.openrouter).toBe("OpenRouter");
    expect(SHARE_KINDS).toContain("openrouter");
    expect(SHARE_KIND_LABEL.openrouter).toBe("OpenRouter");
  });
});

/* ─── A server that starts before the migration has run ─────────────────── */

describe("before migration 0448 has run", () => {
  const beforeMigration = (real: any) => new Proxy(real, {
    get(t, k) {
      if (k === "select") {
        return (proj?: Record<string, unknown>) => {
          const cols = proj ? Object.values(proj) : [];
          if (cols.includes(workspaceSettings.openrouterApiKeyEnc) || cols.includes(workspaceSettings.openrouterModel)) {
            throw new Error("Unknown column 'workspace_settings.openrouterApiKeyEnc' in 'field list'");
          }
          return t.select(proj);
        };
      }
      const v = t[k];
      return typeof v === "function" ? v.bind(t) : v;
    },
  });

  it("the OpenRouter read fails to 'none' by itself, and every other key still resolves", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    settings(B).openrouterApiKeyEnc = encryptSecret(OWN_B);
    settings(B).anthropicApiKeyEnc = encryptSecret("sk-ant-own-B");
    h.db = beforeMigration(h.db);
    expect(await openrouterSettings(B)).toEqual({ keyEnc: null, model: null });
    await ask(B);
    expect(h.anthropic).toEqual([{ apiKey: "sk-ant-own-B", model: HAIKU }]);
    expect(h.ledger[0]).toMatchObject({ vendor: "anthropic", keySource: "workspace" });
    const got = await caller(B).aiCredentials.get();
    expect(got.anthropic.configured).toBe(true);
    expect(got.openrouter).toMatchObject({ configured: false, masked: "" });
  });

  it("the migration adds the two columns the schema names, and nothing else", () => {
    const migrations = read("server/_core/rawMigrations.ts");
    const start = migrations.indexOf('name: "0448_openrouter_provider.sql",');
    expect(start).toBeGreaterThan(-1);
    const entry = migrations.slice(start, migrations.indexOf("\n  },\n", start));
    expect(entry.match(/"(ALTER|CREATE|UPDATE|DROP|INSERT)[^"]*"/g)).toEqual([
      '"ALTER TABLE `workspace_settings` ADD COLUMN `openrouterApiKeyEnc` text NULL"',
      '"ALTER TABLE `workspace_settings` ADD COLUMN `openrouterModel` varchar(128) NULL"',
    ]);
  });
});

/* ─── The model list, read the same way everywhere ──────────────────────── */

describe("OpenRouter's list, and the filter for structured answers", () => {
  const parsed = parseOpenRouterModels({ data: LIST });

  it("keeps text models, drops :batch variants and image generators, and reads prices per million", () => {
    expect(parsed.map((m) => m.id)).not.toContain("anthropic/claude-sonnet-5.5:batch");
    expect(parsed.map((m) => m.id)).not.toContain("google/image-maker");
    expect(parsed.find((m) => m.id === SONNET)).toMatchObject({ promptPerMillion: 2, completionPerMillion: 10, created: 1_790_618_686 });
    expect(parsed.find((m) => m.id === "openrouter/auto")).toMatchObject({ promptPerMillion: null, completionPerMillion: null });
    expect(parseOpenRouterModels(null)).toEqual([]);
    expect(parseOpenRouterModels({ data: [{ name: "no id" }] })).toEqual([]);
  });

  it("decides how each kind of call is asked from supported_parameters", () => {
    expect(openrouterMode(NO_TEMP, "json_schema")).toBe("forced_tool");
    expect(openrouterMode(["tools"], "json_object")).toBe("offered_tool");
    expect(openrouterMode(["structured_outputs"], "json_schema")).toBe("json_schema");
    expect(openrouterMode(["response_format"], "json_schema")).toBe("json_object");
    expect(openrouterMode(["response_format"], "json_object")).toBe("json_object");
    expect(openrouterMode(["max_tokens"], "json_object")).toBeNull();
    expect(openrouterMode(["response_format", "structured_outputs"], "tools")).toBeNull();
    expect(openrouterMode(["tools"], "tools")).toBe("tools");
  });

  it("offers only models that can answer a schema", () => {
    expect(modelsForStructuredAnswers(parsed).map((m) => m.id)).not.toContain("acme/plain");
    expect(canAnswerStructured({ supportedParameters: ["response_format"] })).toBe(true);
    expect(canAnswerStructured({ supportedParameters: ["max_tokens", "temperature"] })).toBe(false);
  });

  it("the default is the newest Claude Sonnet that takes tools, never a variant or another family", () => {
    expect(defaultOpenRouterModel(parsed)?.id).toBe(SONNET);
    expect(defaultOpenRouterModel(parseOpenRouterModels({ data: [model("anthropic/claude-sonnet-7", 1_900_000_000, ["max_tokens"]), ...LIST] }))?.id).toBe(SONNET);
    expect(defaultOpenRouterModel([])).toBeNull();
  });

  it("labels prices per million tokens", () => {
    expect(priceLabel({ promptPerMillion: 2, completionPerMillion: 10 })).toBe("$2.00 in · $10.00 out per 1M tokens");
    expect(priceLabel({ promptPerMillion: 0, completionPerMillion: 0 })).toBe("Free");
    expect(priceLabel({ promptPerMillion: 0.1, completionPerMillion: 0.4 })).toBe("$0.10 in · $0.40 out per 1M tokens");
    expect(priceLabel({ promptPerMillion: null, completionPerMillion: 1 })).toBe("Price varies");
  });
});
