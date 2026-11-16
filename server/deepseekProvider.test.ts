/**
 * DeepSeek, a fourth AI provider (owner 2026-11-16: "have her use a low cost
 * model such as Haiku, Sonnet, Deepseek v4 flash").
 *
 * The tiers could only name Anthropic, OpenAI or Gemini. A workspace can now
 * enter a DeepSeek key, and point a tier or its default at it. What these pin:
 *
 *   - NOTHING REACHES DEEPSEEK UNASKED: a key alone changes nothing while
 *     another provider has one; it takes a tier or the default
 *   - the request is the one DeepSeek's API takes: thinking off, json_object
 *     in place of json_schema, the word "json" in the prompt, a blank JSON
 *     reply asked again once
 *   - usage is counted as DeepSeek bills it: cache hits apart from the rest
 *   - its key is a key like the others: entered and masked the same way,
 *     lent through the same link, withheld from members
 *   - its two columns are read APART from the other providers', so a server
 *     that starts before migration 0443 has run loses nothing it had
 *
 * Real invokeLLM, streamLLM, key shares and procedures against the
 * SQL-evaluating fake; only fetch, the Anthropic SDK and the meter are stubs.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => {
  if (!process.env.ENCRYPTION_KEY && !process.env.JWT_SECRET) process.env.ENCRYPTION_KEY = "b".repeat(64);
  return {
    db: null as any,
    /** Every request sent to DeepSeek. */
    fetches: [] as Array<{ url: string; headers: Record<string, string>; body: any }>,
    /** What DeepSeek answers the nth request (1-based) with. */
    respond: (_n: number, _body: any): Response => { throw new Error("unscripted DeepSeek reply"); },
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
  // The deployment has an Anthropic key and no other, as the live one does.
  return { ...actual, ENV: { ...actual.ENV, anthropicApiKey: "env-anthropic-key", openaiApiKey: "", geminiApiKey: "", deepseekApiKey: "", aiDefaultProvider: "" } };
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
import { encryptSecret, tryDecryptSecret } from "./_core/crypto";
import { DEEPSEEK_CHAT_URL, deepseekPayload, deepseekUsage, invokeLLM, isRetryableLLMError } from "./_core/llm";
import { streamLLM } from "./_core/llmStream";
import { SETTINGS_SECRET_FIELDS } from "./_core/safeProjections";
import { __resetTierConfigForTests } from "./services/aiTiers";
import { deepseekSettings } from "./services/deepseekSettings";
import { SHARE_KINDS, SHARE_KIND_LABEL, linkedKeys } from "./services/keyShares";
import { AI_PROVIDER_IDS, AI_PROVIDER_LABEL, cleanTierModels } from "@shared/aiTiers";
import { VENDOR_LABEL } from "@shared/spendReport";

const ROOT = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");

const A = 2; // LSI Media
const B = 4; // CommunityForce
const OWNER = 10; // super_admin of both
const DS_KEY_A = "sk-deepseek-lsi-AAAA1111";
const DS_KEY_B = "sk-deepseek-cf-BBBB2222";
const HAIKU = "claude-haiku-4-5-20251001";

const rows = (t: string) => h.db.rowsOf(t) as any[];
const settings = (ws: number) => rows("workspace_settings").find((r) => r.workspaceId === ws);
const caller = (ws: number) => appRouter.createCaller({
  user: { id: OWNER, openId: "u10", email: "u10@example.com", name: "U10", loginMethod: "password", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date(), mfaTotpEnabledAt: null },
  req: { protocol: "https", headers: { "x-workspace-id": String(ws) } },
  res: { clearCookie: () => {} },
} as unknown as TrpcContext);

/** A chat completion as DeepSeek returns one. */
const completion = (over: { content?: string | null; tool_calls?: unknown[]; usage?: Record<string, number>; model?: string } = {}) =>
  new Response(JSON.stringify({
    id: "cmpl-1",
    created: 1,
    model: over.model ?? "deepseek-flash",
    choices: [{ index: 0, message: { role: "assistant", content: "content" in over ? over.content : "pong", reasoning_content: null, ...(over.tool_calls ? { tool_calls: over.tool_calls } : {}) }, finish_reason: over.tool_calls ? "tool_calls" : "stop" }],
    usage: over.usage ?? { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 10 },
  }), { status: 200, headers: { "content-type": "application/json" } });

const ask = (ws: number, extra: Record<string, unknown> = {}) =>
  invokeLLM({ workspaceId: ws, task: "general", messages: [{ role: "user", content: "hello" }], ...extra } as any);

/** The database of a server that started before migration 0443 ran: the two columns are not there. */
const beforeMigration = (real: any) => new Proxy(real, {
  get(t, k) {
    if (k === "select") {
      return (proj?: Record<string, unknown>) => {
        const cols = proj ? Object.values(proj) : [];
        if (cols.includes(workspaceSettings.deepseekApiKeyEnc) || cols.includes(workspaceSettings.deepseekModel)) {
          throw new Error("Unknown column 'workspace_settings.deepseekApiKeyEnc' in 'field list'");
        }
        return t.select(proj);
      };
    }
    const v = t[k];
    return typeof v === "function" ? v.bind(t) : v;
  },
});

beforeEach(() => {
  h.db = makeSqlFakeDb({ realMembers: true });
  h.fetches = [];
  h.anthropic = [];
  h.ledger = [];
  h.tokens = [];
  h.respond = () => completion();
  __resetTierConfigForTests();
  rows("users").push({ id: OWNER, openId: "u10", email: "u10@example.com", name: "U10", loginMethod: "password", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date(), mfaTotpEnabledAt: null });
  const ws = (id: number, name: string) => ({ id, name, slug: `ws${id}`, ownerUserId: OWNER, archivedAt: null, plan: "trial" });
  rows("workspaces").push(ws(A, "LSI Media"), ws(B, "CommunityForce"));
  rows("workspace_members").push(
    { id: 1, workspaceId: A, userId: OWNER, role: "super_admin", deactivatedAt: null, inviteToken: null, lastActiveAt: new Date() },
    { id: 2, workspaceId: B, userId: OWNER, role: "super_admin", deactivatedAt: null, inviteToken: null, lastActiveAt: new Date() },
  );
  const base = {
    enforce2fa: false, timezone: "America/New_York",
    anthropicApiKeyEnc: null, openaiApiKeyEnc: null, geminiApiKeyEnc: null, deepseekApiKeyEnc: null, xaiApiKeyEnc: null, apolloApiKeyEnc: null, reoonApiKeyEnc: null, quickenrichApiKeyEnc: null,
    anthropicModel: null, openaiModel: null, geminiModel: null, deepseekModel: null, aiDefaultProvider: null, aiTierModels: null, aiTaskTiers: null, llmMonthlyTokenCap: null,
  };
  rows("workspace_settings").push({ ...base, workspaceId: A }, { ...base, workspaceId: B });
  vi.stubGlobal("fetch", vi.fn(async (url: unknown, init?: { headers?: Record<string, string>; body?: string }) => {
    const body = JSON.parse(init?.body ?? "{}");
    h.fetches.push({ url: String(url), headers: init?.headers ?? {}, body });
    return h.respond(h.fetches.length, body);
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/* ─── Who is sent to DeepSeek ───────────────────────────────────────────── */

describe("nothing reaches DeepSeek unasked", () => {
  it("a workspace with no DeepSeek key never calls it, whatever it asks for", async () => {
    settings(B).aiDefaultProvider = "deepseek";
    settings(B).aiTierModels = { fast: { provider: "deepseek", model: "deepseek-flash" } };
    await ask(B);
    await ask(B, { task: "scoring" });
    expect(h.fetches).toEqual([]);
    expect(h.anthropic.map((c) => c.model)).toEqual([HAIKU, HAIKU]);
  });

  it("a DeepSeek key alone changes nothing while another provider has a key", async () => {
    settings(B).deepseekApiKeyEnc = encryptSecret(DS_KEY_B);
    await ask(B);
    await ask(B, { task: "scoring" });
    await ask(B, { task: "outreach" });
    expect(h.fetches).toEqual([]);
    expect(h.anthropic.length).toBe(3);
  });

  it("a tier set to DeepSeek sends that tier's work there, and only that work", async () => {
    settings(B).deepseekApiKeyEnc = encryptSecret(DS_KEY_B);
    settings(B).aiTierModels = { fast: { provider: "deepseek", model: "deepseek-flash" } };
    await ask(B, { task: "scoring" }); // Fast
    await ask(B, { task: "outreach" }); // Deep, not set
    await ask(B, { task: "elsie" }); // Standard, not set
    expect(h.fetches.map((f) => [f.url, f.body.model])).toEqual([[DEEPSEEK_CHAT_URL, "deepseek-flash"]]);
    expect(h.anthropic.map((c) => c.model)).toEqual([HAIKU, HAIKU]);
  });

  it("the default provider can be DeepSeek, on the model the workspace names or the built-in one", async () => {
    settings(B).deepseekApiKeyEnc = encryptSecret(DS_KEY_B);
    settings(B).aiDefaultProvider = "deepseek";
    await ask(B);
    settings(B).deepseekModel = "deepseek-v4-pro";
    await ask(B);
    expect(h.fetches.map((f) => f.body.model)).toEqual(["deepseek-flash", "deepseek-v4-pro"]);
    expect(h.anthropic).toEqual([]);
  });

  it("stored tiers naming DeepSeek are well-formed now", () => {
    expect(AI_PROVIDER_IDS).toEqual(["anthropic", "openai", "gemini", "deepseek"]);
    expect(cleanTierModels({ fast: { provider: "deepseek", model: "deepseek-flash" } })).toEqual({ fast: { provider: "deepseek", model: "deepseek-flash" } });
  });
});

/* ─── The request DeepSeek's API takes ──────────────────────────────────── */

describe("the DeepSeek request", () => {
  beforeEach(() => {
    settings(B).deepseekApiKeyEnc = encryptSecret(DS_KEY_B);
    settings(B).aiDefaultProvider = "deepseek";
  });

  it("goes to DeepSeek with the workspace's key and thinking off", async () => {
    const res = await ask(B, { messages: [{ role: "system", content: "Be brief." }, { role: "user", content: [{ type: "text", text: "hello" }, { type: "text", text: "again" }] }], temperature: 0.2, maxTokens: 300 });
    expect(h.fetches.length).toBe(1);
    const f = h.fetches[0];
    expect(f.url).toBe("https://api.deepseek.com/chat/completions");
    expect(f.headers.authorization).toBe(`Bearer ${DS_KEY_B}`);
    expect(f.body).toEqual({
      model: "deepseek-flash",
      messages: [{ role: "system", content: "Be brief." }, { role: "user", content: "hello\nagain" }],
      max_tokens: 300,
      thinking: { type: "disabled" },
      temperature: 0.2,
    });
    expect(res.choices[0].message).toEqual({ role: "assistant", content: "pong" });
    expect(res.model).toBe("deepseek-flash");
  });

  it("a schema call goes as json_object with the schema in the system prompt", async () => {
    const schema = { type: "object", properties: { score: { type: "number" } }, required: ["score"] };
    h.respond = () => completion({ content: '{"score":80}' });
    const res = await ask(B, { messages: [{ role: "system", content: "Score the lead." }, { role: "user", content: "Acme" }], outputSchema: { name: "score", schema } });
    const body = h.fetches[0].body;
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(JSON.stringify(body)).not.toContain("json_schema");
    expect(body.messages[0]).toEqual({ role: "system", content: `Score the lead.\n\nReply with one JSON object and nothing else. It must match this JSON schema:\n${JSON.stringify(schema)}` });
    expect(body.messages[1]).toEqual({ role: "user", content: "Acme" });
    // Room for the object: the same allowance a schema call gets on Anthropic.
    expect(body.max_tokens).toBe(8192);
    expect(JSON.parse(String(res.choices[0].message.content))).toEqual({ score: 80 });
  });

  it("a JSON-object call always says the word json, and is left alone when it already does", async () => {
    h.respond = () => completion({ content: "{}" });
    await ask(B, { messages: [{ role: "user", content: "List three colours." }], responseFormat: { type: "json_object" } });
    expect(h.fetches[0].body.messages).toEqual([{ role: "system", content: "Reply with one JSON object and nothing else." }, { role: "user", content: "List three colours." }]);
    await ask(B, { messages: [{ role: "user", content: "List three colours as JSON." }], responseFormat: { type: "json_object" } });
    expect(h.fetches[1].body.messages).toEqual([{ role: "user", content: "List three colours as JSON." }]);
    expect(h.fetches[1].body.response_format).toEqual({ type: "json_object" });
    // A plain call is never put in JSON mode.
    await ask(B);
    expect(h.fetches[2].body).not.toHaveProperty("response_format");
  });

  it("a blank JSON reply is asked again once, and both requests are counted", async () => {
    const usage = { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 100 };
    h.respond = (n) => completion({ content: n === 1 ? "   \n " : '{"ok":true}', usage });
    const res = await ask(B, { responseFormat: { type: "json_object" } });
    expect(h.fetches.length).toBe(2);
    expect(res.choices[0].message.content).toBe('{"ok":true}');
    expect(res.usage).toMatchObject({ prompt_tokens: 200, completion_tokens: 10, total_tokens: 210 });
    expect(h.ledger.length).toBe(1);
    expect(h.ledger[0].usage).toMatchObject({ input: 200, output: 10 });

    // Once only: a second blank is what the caller gets.
    h.fetches = [];
    h.respond = () => completion({ content: "" });
    const blank = await ask(B, { responseFormat: { type: "json_object" } });
    expect(h.fetches.length).toBe(2);
    expect(blank.choices[0].message.content).toBe("");
    // And never for a reply that was not asked to be JSON.
    h.fetches = [];
    await ask(B);
    expect(h.fetches.length).toBe(1);
  });

  it("tools and a forced choice go as OpenAI's, and the call's tool is its structure", async () => {
    const tools = [{ type: "function" as const, function: { name: "classify", description: "Classify", parameters: { type: "object", properties: { label: { type: "string" } } } } }];
    const tool_calls = [{ id: "call_1", type: "function", function: { name: "classify", arguments: '{"label":"positive"}' } }];
    h.respond = () => completion({ content: null, tool_calls });
    const res = await ask(B, { tools, toolChoice: { name: "classify" }, responseFormat: { type: "json_object" } });
    const body = h.fetches[0].body;
    expect(body.tools).toEqual(tools);
    expect(body.tool_choice).toEqual({ type: "function", function: { name: "classify" } });
    expect(body.thinking).toEqual({ type: "disabled" });
    expect(body).not.toHaveProperty("response_format");
    expect(res.choices[0].message).toEqual({ role: "assistant", content: "", tool_calls });
    expect(res.choices[0].finish_reason).toBe("tool_calls");
    // No tools, no tool fields.
    await ask(B);
    expect(h.fetches[1].body).not.toHaveProperty("tools");
    expect(h.fetches[1].body).not.toHaveProperty("tool_choice");
  });

  it("the payload builder is pure and reports whether it asked for JSON", () => {
    const plain = deepseekPayload({ messages: [{ role: "user", content: "hi" }] }, "m");
    expect(plain).toEqual({ payload: { model: "m", messages: [{ role: "user", content: "hi" }], max_tokens: 4096, thinking: { type: "disabled" } }, wantsJson: false });
    const original = [{ role: "system" as const, content: "S" }, { role: "user" as const, content: "U" }];
    const json = deepseekPayload({ messages: original, outputSchema: { name: "x", schema: { type: "object" } } }, "m");
    expect(json.wantsJson).toBe(true);
    // The caller's own messages are not changed.
    expect(original).toEqual([{ role: "system", content: "S" }, { role: "user", content: "U" }]);
  });
});

/* ─── What a call cost ──────────────────────────────────────────────────── */

describe("usage is counted as DeepSeek bills it", () => {
  it("cache hits are counted apart from the rest of the prompt", () => {
    expect(deepseekUsage({ prompt_tokens: 1000, completion_tokens: 50, prompt_cache_hit_tokens: 800, prompt_cache_miss_tokens: 200 })).toEqual({ input: 200, output: 50, cacheRead: 800 });
    // No miss figure: it is the prompt less the hits.
    expect(deepseekUsage({ prompt_tokens: 1000, completion_tokens: 50, prompt_cache_hit_tokens: 300 })).toEqual({ input: 700, output: 50, cacheRead: 300 });
    expect(deepseekUsage({ prompt_tokens: 40, completion_tokens: 4 })).toEqual({ input: 40, output: 4, cacheRead: 0 });
    expect(deepseekUsage(null)).toEqual({ input: 0, output: 0, cacheRead: 0 });
  });

  it("the ledger gets the vendor, the model that answered, whose key paid, and the split", async () => {
    settings(B).deepseekApiKeyEnc = encryptSecret(DS_KEY_B);
    settings(B).aiDefaultProvider = "deepseek";
    h.respond = () => completion({ model: "deepseek-flash", usage: { prompt_tokens: 1000, completion_tokens: 50, total_tokens: 1050, prompt_cache_hit_tokens: 800, prompt_cache_miss_tokens: 200 } });
    const res = await ask(B, { feature: "leadScoring" });
    expect(h.ledger).toEqual([{ workspaceId: B, vendor: "deepseek", model: "deepseek-flash", keySource: "workspace", feature: "leadScoring", usage: { input: 200, output: 50, cacheWrite: 0, cacheRead: 800 } }]);
    // The monthly budget counts what Anthropic's calls count: input and output, not cache reads.
    expect(h.tokens).toEqual([250]);
    expect(res.usage).toEqual({ prompt_tokens: 200, completion_tokens: 50, total_tokens: 250, cache_creation_input_tokens: 0, cache_read_input_tokens: 800 });
    expect(VENDOR_LABEL.deepseek).toBe("DeepSeek");
  });
});

/* ─── Failures ──────────────────────────────────────────────────────────── */

describe("when DeepSeek fails", () => {
  beforeEach(() => {
    settings(B).deepseekApiKeyEnc = encryptSecret(DS_KEY_B);
    settings(B).aiDefaultProvider = "deepseek";
  });

  it("an overloaded answer is tried again after a second, then three seconds", async () => {
    const waits: number[] = [];
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => { waits.push(ms ?? 0); fn(); return 0; }) as never);
    h.respond = (n) => (n < 3 ? new Response("Server overloaded", { status: 503, statusText: "Service Unavailable" }) : completion());
    const res = await ask(B);
    expect(h.fetches.length).toBe(3);
    expect(waits).toEqual([1000, 3000]);
    expect(res.choices[0].message.content).toBe("pong");
  });

  it("three overloaded answers fail with the status, as a failure a job may retry", async () => {
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void) => { fn(); return 0; }) as never);
    h.respond = () => new Response("Server overloaded", { status: 503, statusText: "Service Unavailable" });
    const err = await ask(B).catch((e) => e);
    expect(h.fetches.length).toBe(3);
    expect(err.message).toBe("DeepSeek invoke failed: 503 Service Unavailable – Server overloaded");
    expect(err.status).toBe(503);
    expect(isRetryableLLMError(err)).toBe(true);
    expect(h.ledger).toEqual([]);
  });

  it("a refused key or an empty balance fails at once and says so", async () => {
    h.respond = () => new Response('{"error":{"message":"Insufficient Balance"}}', { status: 402, statusText: "Payment Required" });
    const err = await ask(B).catch((e) => e);
    expect(h.fetches.length).toBe(1);
    expect(err.message).toContain("DeepSeek invoke failed: 402 Payment Required");
    expect(err.message).toContain("Insufficient Balance");
    expect(isRetryableLLMError(err)).toBe(false);
  });

  it("the key test in Settings says there is no key rather than calling", async () => {
    settings(B).deepseekApiKeyEnc = null;
    const err = await caller(B).aiCredentials.test({ provider: "deepseek" }).catch((e) => e);
    expect(err.message).toBe("DeepSeek API key is not configured (workspace or DEEPSEEK_API_KEY env)");
    expect(h.fetches).toEqual([]);
  });
});

/* ─── Streaming ─────────────────────────────────────────────────────────── */

describe("a streamed reply", () => {
  it("streams from DeepSeek with thinking off and counts what the last chunk reports", async () => {
    settings(B).deepseekApiKeyEnc = encryptSecret(DS_KEY_B);
    settings(B).aiDefaultProvider = "deepseek";
    const chunk = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
    h.respond = () => new Response(
      chunk({ model: "deepseek-flash", choices: [{ delta: { content: "Hel" } }], usage: null }) +
      chunk({ model: "deepseek-flash", choices: [{ delta: { content: "lo" } }], usage: null }) +
      chunk({ model: "deepseek-flash", choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 500, completion_tokens: 20, total_tokens: 520, prompt_cache_hit_tokens: 400, prompt_cache_miss_tokens: 100 } }) +
      "data: [DONE]\n\n",
      { status: 200 },
    );
    let out = "";
    for await (const piece of streamLLM({ workspaceId: B, task: "documents", feature: "proposal", messages: [{ role: "system", content: "Write." }, { role: "user", content: "Go" }] })) out += piece;
    expect(out).toBe("Hello");
    expect(h.fetches.length).toBe(1);
    expect(h.fetches[0].url).toBe(DEEPSEEK_CHAT_URL);
    expect(h.fetches[0].headers.authorization).toBe(`Bearer ${DS_KEY_B}`);
    expect(h.fetches[0].body).toEqual({
      model: "deepseek-flash",
      messages: [{ role: "system", content: "Write." }, { role: "user", content: "Go" }],
      max_tokens: 4096,
      thinking: { type: "disabled" },
      stream: true,
      stream_options: { include_usage: true },
    });
    expect(h.ledger).toEqual([{ workspaceId: B, vendor: "deepseek", model: "deepseek-flash", keySource: "workspace", feature: "proposal", usage: { input: 100, output: 20, cacheWrite: 0, cacheRead: 400 } }]);
    expect(h.tokens).toEqual([120]);
  });

  it("a streamed tier's work goes to DeepSeek and the rest does not", async () => {
    settings(B).deepseekApiKeyEnc = encryptSecret(DS_KEY_B);
    settings(B).aiTierModels = { standard: { provider: "deepseek", model: "deepseek-v4-pro" } };
    h.respond = () => new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', { status: 200 });
    let out = "";
    for await (const piece of streamLLM({ workspaceId: B, task: "documents", messages: [{ role: "user", content: "Go" }] })) out += piece;
    expect(out).toBe("ok");
    expect(h.fetches[0].body.model).toBe("deepseek-v4-pro");
  });
});

/* ─── The key, in Settings ──────────────────────────────────────────────── */

describe("the DeepSeek key is a key like the others", () => {
  it("an admin enters it, it is stored encrypted, and nobody is shown more than its tail", async () => {
    expect((await caller(B).aiCredentials.get()).deepseek).toEqual({ configured: false, masked: "", sharedFrom: null, model: "" });
    await caller(B).aiCredentials.upsert({ provider: "deepseek", apiKey: DS_KEY_B, model: "deepseek-v4-pro" });
    expect(settings(B).deepseekApiKeyEnc).not.toContain(DS_KEY_B);
    expect(tryDecryptSecret(settings(B).deepseekApiKeyEnc)).toBe(DS_KEY_B);
    expect(settings(B).deepseekModel).toBe("deepseek-v4-pro");
    // The other providers' columns were not touched.
    expect(settings(B).anthropicApiKeyEnc).toBeNull();
    const got = (await caller(B).aiCredentials.get()).deepseek;
    expect(got.configured).toBe(true);
    expect(got.model).toBe("deepseek-v4-pro");
    expect(got.masked).toContain(DS_KEY_B.slice(-4));
    expect(got.masked).not.toContain(DS_KEY_B.slice(0, 12));
    expect(SETTINGS_SECRET_FIELDS).toContain("deepseekApiKeyEnc");

    await caller(B).aiCredentials.upsert({ provider: "deepseek", apiKey: "" });
    expect(settings(B).deepseekApiKeyEnc).toBeNull();
    expect((await caller(B).aiCredentials.get()).deepseek.configured).toBe(false);
  });

  it("it can be the default, be a tier, and be tested", async () => {
    await caller(B).aiCredentials.upsert({ provider: "deepseek", apiKey: DS_KEY_B });
    await caller(B).aiCredentials.setDefaultProvider({ provider: "deepseek" });
    expect(settings(B).aiDefaultProvider).toBe("deepseek");
    await caller(B).aiCredentials.setTier({ tier: "fast", provider: "deepseek", model: "deepseek-flash" });
    expect((await caller(B).aiCredentials.getTiers()).tiers).toEqual({ fast: { provider: "deepseek", model: "deepseek-flash" } });

    const tested = await caller(B).aiCredentials.test({ provider: "deepseek" });
    expect(tested).toMatchObject({ ok: true, model: "deepseek-flash", reply: "pong" });
    const tier = await caller(B).aiCredentials.testTier({ tier: "fast" });
    expect(tier).toMatchObject({ ok: true, model: "deepseek-flash" });
    expect(h.fetches.map((f) => [f.headers.authorization, f.body.max_tokens])).toEqual([[`Bearer ${DS_KEY_B}`, 8], [`Bearer ${DS_KEY_B}`, 8]]);
  });

  it("copying a workspace's AI keys brings the DeepSeek key and model, re-encrypted", async () => {
    settings(A).deepseekApiKeyEnc = encryptSecret(DS_KEY_A);
    settings(A).deepseekModel = "deepseek-v4-pro";
    const res = await caller(B).aiCredentials.copyFromWorkspace({ fromWorkspaceId: A });
    expect(res.providers).toEqual(["deepseek"]);
    expect(tryDecryptSecret(settings(B).deepseekApiKeyEnc)).toBe(DS_KEY_A);
    expect(settings(B).deepseekApiKeyEnc).not.toBe(settings(A).deepseekApiKeyEnc);
    expect(settings(B).deepseekModel).toBe("deepseek-v4-pro");
  });

  it("it is lent through the same live link, and a lent key is never shown", async () => {
    settings(A).deepseekApiKeyEnc = encryptSecret(DS_KEY_A);
    expect(SHARE_KINDS).toContain("deepseek");
    expect(SHARE_KIND_LABEL.deepseek).toBe("DeepSeek");
    const before = (await caller(A).keyShares.overview()).keys.find((k) => k.kind === "deepseek")!;
    expect(before).toMatchObject({ label: "DeepSeek", hasOwnKey: true, sharedWith: [] });

    await caller(A).keyShares.share({ kind: "deepseek", targetWorkspaceId: B });
    expect(await linkedKeys(B, ["anthropic", "openai", "gemini", "deepseek"])).toEqual({ deepseek: { ownerWorkspaceId: A, key: DS_KEY_A } });
    expect((await caller(B).aiCredentials.get()).deepseek).toEqual({ configured: true, masked: "", sharedFrom: "LSI Media", model: "" });
    // Nothing was stored in the borrower, and its calls go out on the lender's key.
    expect(settings(B).deepseekApiKeyEnc).toBeNull();
    settings(B).aiDefaultProvider = "deepseek";
    await ask(B);
    expect(h.fetches[0].headers.authorization).toBe(`Bearer ${DS_KEY_A}`);

    // Live: rotated in the lender, it is the new key on the next call; taken back, there is none.
    settings(A).deepseekApiKeyEnc = encryptSecret("sk-deepseek-rotated");
    await ask(B);
    expect(h.fetches[1].headers.authorization).toBe("Bearer sk-deepseek-rotated");
    await caller(A).keyShares.unshare({ kind: "deepseek", targetWorkspaceId: B });
    await ask(B);
    expect(h.fetches.length).toBe(2);
    expect(h.anthropic.length).toBe(1);
    // A borrowed key cannot be passed on: B has none of its own to lend.
    await caller(A).keyShares.share({ kind: "deepseek", targetWorkspaceId: B });
    const err = await caller(B).keyShares.share({ kind: "deepseek", targetWorkspaceId: A }).catch((e) => e);
    expect(err.code).toBe("BAD_REQUEST");
  });
});

/* ─── A server that starts before the migration has run ─────────────────── */

describe("before migration 0443 has run", () => {
  it("the DeepSeek read fails to 'none', by itself", async () => {
    settings(B).deepseekApiKeyEnc = encryptSecret(DS_KEY_B);
    expect(await deepseekSettings(B)).toEqual({ keyEnc: settings(B).deepseekApiKeyEnc, model: null });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    h.db = beforeMigration(h.db);
    expect(await deepseekSettings(B)).toEqual({ keyEnc: null, model: null });
    expect(log).toHaveBeenCalled();
    expect(await deepseekSettings(undefined)).toEqual({ keyEnc: null, model: null });
  });

  it("a workspace keeps its own keys and the keys it is lent", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    settings(B).anthropicApiKeyEnc = encryptSecret("sk-ant-own-B");
    settings(A).openaiApiKeyEnc = encryptSecret("sk-openai-lsi");
    await caller(A).keyShares.share({ kind: "openai", targetWorkspaceId: B });
    h.db = beforeMigration(h.db);

    // Its own Anthropic key, not the deployment's: the credential read did not fail.
    await ask(B);
    expect(h.anthropic).toEqual([{ apiKey: "sk-ant-own-B", model: HAIKU }]);
    expect(h.ledger[0]).toMatchObject({ vendor: "anthropic", keySource: "workspace" });
    // The lent key still resolves, asked for alongside DeepSeek as the funnels ask.
    expect(await linkedKeys(B, ["openai", "gemini", "deepseek"])).toEqual({ openai: { ownerWorkspaceId: A, key: "sk-openai-lsi" } });
    // Settings still opens, with DeepSeek shown as not set.
    const got = await caller(B).aiCredentials.get();
    expect(got.anthropic.configured).toBe(true);
    expect(got.openai).toMatchObject({ configured: true, sharedFrom: "LSI Media" });
    expect(got.deepseek).toEqual({ configured: false, masked: "", sharedFrom: null, model: "" });
    const overview = await caller(A).keyShares.overview();
    expect(overview.keys.find((k) => k.kind === "openai")!.hasOwnKey).toBe(true);
    expect(overview.keys.find((k) => k.kind === "deepseek")!.hasOwnKey).toBe(false);
  });

  it("only one file reads the two columns, and no select reads them beside another column", () => {
    const out = execFileSync("git", ["grep", "-l", "-E", "deepseek(ApiKeyEnc|Model)\\b", "--", "server", "drizzle/schema.ts"], { cwd: ROOT, encoding: "utf8" });
    const files = out.split("\n").map((s) => s.trim()).filter((f) => f && !f.endsWith(".test.ts")).sort();
    expect(files).toEqual([
      "drizzle/schema.ts",
      "server/_core/llm.ts", // creds.deepseekModel, the resolved model: no column
      "server/_core/llmStream.ts", // the same
      "server/_core/rawMigrations.ts",
      "server/_core/safeProjections.ts",
      "server/routers/aiCredentials.ts", // the two writes
      "server/services/deepseekSettings.ts",
    ]);
    for (const f of files.filter((x) => x.startsWith("server/") && x !== "server/services/deepseekSettings.ts")) {
      expect(read(f), f).not.toMatch(/workspaceSettings\.deepseek(ApiKeyEnc|Model)/);
    }
    expect(read("server/services/keyShares.ts")).not.toMatch(/deepseekApiKeyEnc/);
    const helper = read("server/services/deepseekSettings.ts");
    expect(helper).toContain(".select({ keyEnc: workspaceSettings.deepseekApiKeyEnc, model: workspaceSettings.deepseekModel })");
    expect(helper.match(/workspaceSettings\.\w+/g)).toEqual(["workspaceSettings.deepseekApiKeyEnc", "workspaceSettings.deepseekModel", "workspaceSettings.workspaceId"]);
    // Both funnels and the two key-share reads go through it.
    for (const f of ["server/_core/llm.ts", "server/_core/llmStream.ts"]) {
      expect(read(f), f).toContain("const deepseek = await deepseekSettings(workspaceId);");
      expect(read(f), f).toContain('const missing = (["anthropic", "openai", "gemini", "deepseek"] as const).filter((p) => !own[p]);');
    }
  });

  it("the migration adds the two columns the schema names, and nothing else", () => {
    const migrations = read("server/_core/rawMigrations.ts");
    const start = migrations.indexOf('name: "0443_deepseek_provider.sql",');
    expect(start).toBeGreaterThan(-1);
    const entry = migrations.slice(start, migrations.indexOf("\n  },\n", start));
    expect(entry.match(/"(ALTER|CREATE|UPDATE|DROP|INSERT)[^"]*"/g)).toEqual([
      '"ALTER TABLE `workspace_settings` ADD COLUMN `deepseekApiKeyEnc` text NULL"',
      '"ALTER TABLE `workspace_settings` ADD COLUMN `deepseekModel` varchar(128) NULL"',
    ]);
    const schema = read("drizzle/schema.ts");
    expect(schema).toContain('deepseekApiKeyEnc: text("deepseekApiKeyEnc"),');
    expect(schema).toContain('deepseekModel: varchar("deepseekModel", { length: 128 }),');
  });
});

/* ─── The screens ───────────────────────────────────────────────────────── */

describe("the settings screens list DeepSeek where they list the others", () => {
  it("a key card, the tier picker, the sharing panel and settings search", () => {
    const page = read("client/src/pages/usip/Settings.tsx");
    const providers = page.slice(page.indexOf("const AI_PROVIDERS = ["), page.indexOf("function AIProvidersSection("));
    expect(providers.match(/id: "(\w+)" as const/g)).toEqual(['id: "anthropic" as const', 'id: "openai" as const', 'id: "gemini" as const', 'id: "deepseek" as const']);
    expect(providers).toContain('docsUrl: "https://platform.deepseek.com/api_keys"');
    expect(providers).toContain("Velocity calls them with DeepSeek's thinking mode off.");
    expect(page).toContain("Bring your own API keys for Anthropic, OpenAI, Gemini or DeepSeek.");

    // The tier picker lists the shared list of providers by their shared names.
    const card = read("client/src/components/usip/settings/ModelTiersCard.tsx");
    expect(card).toContain("AI_PROVIDER_LABEL as PROVIDER_NAME,");
    expect(card).toContain("{AI_PROVIDER_IDS.map((p) => (");
    expect(AI_PROVIDER_LABEL).toEqual({ anthropic: "Anthropic", openai: "OpenAI", gemini: "Google Gemini", deepseek: "DeepSeek" });

    expect(read("client/src/components/usip/settings/KeySharingCard.tsx")).toContain('export const AI_KEY_KINDS: ShareableKind[] = ["anthropic", "openai", "gemini", "deepseek"];');
    expect(read("client/src/pages/usip/SettingsHub.tsx")).toMatch(/id: "integrations".*"deepseek"/);
  });
});
