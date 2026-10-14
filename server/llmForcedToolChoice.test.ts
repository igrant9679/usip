/**
 * invokeLLM's structured output on models that refuse a forced tool choice.
 *
 * Every json_schema / json_object request on Anthropic becomes one tool call
 * (`respond_with_structured_output`), and it used to be FORCED. Claude Opus 5.5
 * answers a forced tool choice with a 400 — "tool_choice: type "tool" and
 * "any" are not supported for this model" (the Research engine's first live
 * run, 2026-10-14) — so any workspace that picked Opus 5.5 as its Anthropic
 * model would have had every structured AI feature fail. Forcing is still
 * tried first; on that refusal the tool is offered ("auto") with an instruction
 * to call it, the model is remembered, and a JSON reply in text is read too.
 *
 * Only the provider SDK is stubbed; invokeLLM, its ceilings and its meter are
 * real.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  calls: [] as any[],
  reply: (_p: any): any => { throw new Error("unscripted"); },
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

vi.mock("./db", async (importActual) => ({
  ...(await importActual<typeof import("./db")>()),
  getDb: async () => null,
}));

vi.mock("./_core/env", async (importActual) => {
  const actual = await importActual<typeof import("./_core/env")>();
  return { ...actual, ENV: { ...actual.ENV, anthropicApiKey: "test-key", aiDefaultProvider: "anthropic" } };
});

import { __resetForcedToolMemoryForTests, invokeLLM, jsonFromText, refusesForcedToolChoice } from "./_core/llm";

const REFUSAL = () =>
  Object.assign(
    new Error('400 {"type":"error","error":{"type":"invalid_request_error","message":"tool_choice: type \\"tool\\" and \\"any\\" are not supported for this model."}}'),
    { status: 400 },
  );

const msg = (content: any[], stop = "end_turn") => ({
  id: "msg_1",
  model: "m",
  content,
  stop_reason: stop,
  usage: { input_tokens: 10, output_tokens: 5 },
});

const structured = (model: string) =>
  invokeLLM({
    model,
    provider: "anthropic",
    messages: [{ role: "system", content: "You score leads." }, { role: "user", content: "Score this." }],
    outputSchema: { name: "score", schema: { type: "object", properties: { score: { type: "number" } } } },
  });

/** A model that refuses forced choice, and answers an offered tool with a call. */
const opus55 = (p: any) => {
  if (p.tool_choice?.type === "tool" || p.tool_choice?.type === "any") throw REFUSAL();
  return msg([{ type: "tool_use", id: "t1", name: "respond_with_structured_output", input: { score: 87 } }], "tool_use");
};

beforeEach(() => {
  h.calls = [];
  __resetForcedToolMemoryForTests();
});

describe("models that accept a forced tool choice", () => {
  it("are unchanged: one forced call, and the tool input is the result", async () => {
    h.reply = () => msg([{ type: "tool_use", id: "t1", name: "respond_with_structured_output", input: { score: 42 } }], "tool_use");
    const r = await structured("claude-haiku-4-5-20251001");
    expect(r.choices[0].message.content).toBe('{"score":42}');
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].tool_choice).toEqual({ type: "tool", name: "respond_with_structured_output" });
    expect(h.calls[0].system).toBe("You score leads.");
  });
});

describe("models that refuse it (Opus 5.5)", () => {
  it("get the tool offered with an instruction, and the caller still receives the JSON", async () => {
    h.reply = opus55;
    const r = await structured("claude-opus-5-5");
    expect(JSON.parse(r.choices[0].message.content as string)).toEqual({ score: 87 });
    expect(h.calls.map((c) => c.tool_choice)).toEqual([
      { type: "tool", name: "respond_with_structured_output" },
      { type: "auto" },
    ]);
    expect(h.calls[1].system).toBe("You score leads.\n\nRespond by calling the respond_with_structured_output tool exactly once with the complete result. Do not answer in text.");
    expect(h.calls[1].tools).toEqual(h.calls[0].tools);
  });

  it("are remembered, so later calls skip the refused attempt; other models still try forcing first", async () => {
    h.reply = opus55;
    await structured("claude-opus-5-5");
    h.calls = [];
    await structured("claude-opus-5-5");
    expect(h.calls.map((c) => c.tool_choice?.type)).toEqual(["auto"]);
    h.calls = [];
    h.reply = () => msg([{ type: "tool_use", id: "t1", name: "respond_with_structured_output", input: { score: 1 } }], "tool_use");
    await structured("claude-sonnet-5-5");
    expect(h.calls.map((c) => c.tool_choice?.type)).toEqual(["tool"]);
  });

  it("may answer in text: fenced or bare JSON becomes the result", async () => {
    h.reply = (p) => {
      if (p.tool_choice?.type !== "auto") throw REFUSAL();
      return msg([{ type: "text", text: 'Here you go:\n```json\n{"score": 63}\n```' }]);
    };
    const r = await structured("claude-opus-5-5");
    expect(r.choices[0].message.content).toBe('{"score":63}');
  });

  it("a caller's own forced tool is offered instead, and its call still comes back as a tool call", async () => {
    h.reply = (p) => {
      if (p.tool_choice?.type === "tool") throw REFUSAL();
      return msg([{ type: "tool_use", id: "t9", name: "classify", input: { label: "positive" } }], "tool_use");
    };
    const r = await invokeLLM({
      model: "claude-opus-5-5",
      provider: "anthropic",
      messages: [{ role: "user", content: "Classify." }],
      tools: [{ type: "function", function: { name: "classify", description: "Classify", parameters: { type: "object", properties: { label: { type: "string" } } } } }],
      toolChoice: { name: "classify" },
    });
    expect(h.calls.map((c) => c.tool_choice)).toEqual([{ type: "tool", name: "classify" }, { type: "auto" }]);
    expect(h.calls[1].system).toBe("Respond by calling the classify tool exactly once with the complete result. Do not answer in text.");
    expect(r.choices[0].message.tool_calls?.[0].function).toEqual({ name: "classify", arguments: '{"label":"positive"}' });
  });
});

describe("what is not retried", () => {
  it("any other error goes to the caller after one attempt", async () => {
    h.reply = () => { throw Object.assign(new Error("400 max_tokens: too large"), { status: 400 }); };
    await expect(structured("claude-opus-5-5")).rejects.toThrow(/max_tokens/);
    expect(h.calls).toHaveLength(1);
  });

  it("a request with no forced choice is never retried", async () => {
    h.reply = () => { throw REFUSAL(); };
    await expect(invokeLLM({ provider: "anthropic", model: "claude-opus-5-5", messages: [{ role: "user", content: "hi" }] })).rejects.toThrow();
    expect(h.calls).toHaveLength(1);
  });
});

describe("helpers", () => {
  it("recognise only the forced-choice refusal", () => {
    expect(refusesForcedToolChoice(REFUSAL())).toBe(true);
    expect(refusesForcedToolChoice(Object.assign(new Error("tool_choice: type \"tool\" and \"any\" are not supported for this model."), { status: 500 }))).toBe(false);
    expect(refusesForcedToolChoice(Object.assign(new Error("tools: too many"), { status: 400 }))).toBe(false);
  });

  it("find a JSON object in text", () => {
    expect(jsonFromText('{"a":1}')).toBe('{"a":1}');
    expect(jsonFromText('Sure.\n```\n{"a": 2}\n```')).toBe('{"a":2}');
    expect(jsonFromText('Result: {"a": 3} done')).toBe('{"a":3}');
    expect(jsonFromText("[1,2]")).toBeNull();
    expect(jsonFromText("no json")).toBeNull();
  });
});
