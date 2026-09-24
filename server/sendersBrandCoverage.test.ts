/**
 * Every AI writer whose output reaches a prospect or customer carries the
 * sender's brand (owner ask 2026-09-24: "all AI generated emails/
 * communications etc. should be informed by this new messaging … all
 * workspaces"). Each workspace gets its OWN profile (services/brandContext).
 *
 * Two ways a writer gets it: it builds the block itself (buildBrandContext)
 * or it sets `sendersBrand: true` on invokeLLM / streamLLM, which appends the
 * block to the system prompt for the resolved workspace. Before this, 8
 * writers had it and ~17 did not — including the nightly email pipeline,
 * LinkedIn openers and invite notes, mailbox replies, subject lines,
 * workflow emails, client proposals, the campaign outline and the voice agent.
 *
 * The coverage list is explicit on purpose: a scanner that silently finds
 * nothing reads exactly like full coverage, so each entry asserts its anchor.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { appendSendersBrand } from "./services/brandContext";

const read = (f: string) => readFileSync(f, "utf8");

/** [file, a string that anchors the writer, what it writes] */
const FLAGGED: Array<[string, string, string]> = [
  ["server/routers/emailBuilder.ts", "rewriteBlock: repProcedure", "template block rewrite"],
  ["server/routers/emailBuilder.ts", "suggestSubjects: repProcedure", "subject lines"],
  ["server/routers/emailBuilder.ts", "const categoryDescriptions: Record<string, string> = {", "email snippets"],
  ["server/routers/aiPipeline.ts", "const draftRes = await invokeLLM({", "nightly pipeline drafts"],
  ["server/routers/aiPipeline.ts", "const regenRes = await invokeLLM({", "draft regeneration"],
  ["server/sequenceEngine.ts", "const out = await invokeLLM({", "AI-dynamic sequence steps"],
  ["server/services/workflowEngine.ts", "const out = await invokeLLM({", "workflow email drafts"],
  ["server/services/socialAutopilot.ts", "async function generateOpener", "LinkedIn opener"],
  ["server/services/socialAutopilot.ts", "const res = await invokeLLM({ sendersBrand: true, workspaceId,", "LinkedIn invite note"],
  ["server/services/replyClassifier.ts", "const res = await invokeLLM({", "suggested reply"],
  ["server/routers/mailbox.ts", "aiDraftReply", "mailbox reply"],
  ["server/routers/mailbox.ts", "aiDraftForward", "mailbox forward"],
  ["server/routers/subjectAB.ts", "const out = await invokeLLM({", "subject A/B variants"],
  ["server/routers/proposals.ts", "const response = await invokeLLM({", "client proposal sections"],
  ["server/routers/are/prospects.ts", "export async function generateCampaignTemplate(", "campaign step outline"],
  ["server/emailBuilderStreamRoute.ts", "for await (const delta of streamLLM({", "streamed template copy"],
  ["server/proposalsStreamRoute.ts", "for await (const delta of streamLLM({", "streamed proposal copy"],
];

/** The `sendersBrand: true` belonging to the first model call after the anchor. */
function flagAfter(src: string, anchor: string): boolean {
  const a = src.indexOf(anchor);
  if (a === -1) return false;
  const call = src.slice(a).search(/(invokeLLM|streamLLM)\(\{/);
  if (call === -1) return false;
  const start = a + call;
  return src.slice(start, start + 260).includes("sendersBrand: true");
}

describe("every prospect-facing writer carries the sender's brand", () => {
  for (const [file, anchor, what] of FLAGGED) {
    it(`${what} (${file})`, () => {
      const src = read(file);
      expect(src.indexOf(anchor), `anchor moved in ${file}: ${anchor}`).toBeGreaterThan(-1);
      expect(flagAfter(src, anchor), `${what}: no sendersBrand on its model call`).toBe(true);
    });
  }

  it("the mailbox streams set it through the shared SSE helper", () => {
    const src = read("server/mailboxStreamRoute.ts");
    expect(src.split("sendersBrand: true,").length - 1).toBe(2);
    expect(read("server/_core/streamHelpers.ts")).toContain("sendersBrand?: boolean;");
  });

  it("the research pipeline brands only its email-writing stage", () => {
    const src = read("server/routers/researchPipeline.ts");
    expect(src).toContain("sendersBrand: opts?.sendersBrand,");
    expect(src.split("{ sendersBrand: true }").length - 1).toBe(1);
    const at = src.indexOf("{ sendersBrand: true }");
    expect(src.slice(at, at + 200)).toContain("stage4_draft: stage4");
  });

  it("the nightly pipeline passes its workspace explicitly (it runs with no request)", () => {
    const src = read("server/routers/aiPipeline.ts");
    const at = src.indexOf("const draftRes = await invokeLLM({");
    expect(src.slice(at, at + 120)).toMatch(/workspaceId,\s*\n\s*sendersBrand: true,/);
  });

  it("the voice agent speaks with the workspace's brand", () => {
    const src = read("server/services/voiceBridge.ts");
    expect(src).toContain("const brand = await buildBrandContext(agent.workspaceId).catch(() => \"\");");
    expect(src).toContain("defaultInstructions(agent.name, ownerName), brand].filter(Boolean).join(\"\\n\\n\")");
  });

  it("writers that already build the block are not double-branded", () => {
    for (const f of ["server/routers/emailAssist.ts", "server/services/chatFollowUp.ts", "server/services/meetingScheduler.ts", "server/services/chatAgent.ts", "server/services/referralHandler.ts"]) {
      const src = read(f);
      expect(src, f).toContain("buildBrandContext(");
      expect(src, f).not.toContain("sendersBrand: true");
    }
  });
});

describe("the mechanism", () => {
  it("invokeLLM and streamLLM append the brand for the resolved workspace", () => {
    const llm = read("server/_core/llm.ts");
    expect(llm).toContain("sendersBrand?: boolean;");
    const fn = llm.slice(llm.indexOf("export async function invokeLLM("));
    const resolveAt = fn.indexOf("const workspaceId = params.workspaceId ?? getRequestWorkspaceId();");
    const brandAt = fn.indexOf("if (params.sendersBrand && workspaceId)");
    const callAt = fn.indexOf("switch (provider)");
    expect(resolveAt).toBeGreaterThan(-1);
    expect(brandAt).toBeGreaterThan(resolveAt);
    expect(callAt).toBeGreaterThan(brandAt);
    const stream = read("server/_core/llmStream.ts");
    const s = stream.slice(stream.indexOf("export async function* streamLLM("));
    expect(s.indexOf("if (params.sendersBrand && params.workspaceId)")).toBeGreaterThan(-1);
    expect(s.indexOf("if (params.sendersBrand && params.workspaceId)")).toBeLessThan(s.indexOf("switch (provider)"));
  });

  it("appends to the first string system message", () => {
    const out = appendSendersBrand([
      { role: "system", content: "You write emails." },
      { role: "user", content: "Write one." },
    ], "## About the sender\n- Company: Acme");
    expect(out[0].content).toBe("You write emails.\n\n## About the sender\n- Company: Acme");
    expect(out[1].content).toBe("Write one.");
  });

  it("adds a system message when there is none", () => {
    const out = appendSendersBrand([{ role: "user", content: "Write one." }], "BRAND");
    expect(out).toEqual([{ role: "system", content: "BRAND" }, { role: "user", content: "Write one." }]);
  });

  it("changes nothing when the workspace has no brand (or opted out)", () => {
    const msgs = [{ role: "system", content: "S" }, { role: "user", content: "U" }];
    expect(appendSendersBrand(msgs, "")).toBe(msgs);
  });

  it("never mutates the caller's messages", () => {
    const msgs = [{ role: "system", content: "S" }];
    appendSendersBrand(msgs, "B");
    expect(msgs[0].content).toBe("S");
  });
});
