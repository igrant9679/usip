/**
 * The assistant's bounded tool set — the invariants that keep "bounded" true:
 *
 *  - the registry partitions cleanly (a tool is read XOR mutating XOR
 *    navigate; a tool in neither list would silently never run, and a tool
 *    in both would execute without confirmation);
 *  - every LLM-facing definition has a runtime zod gate and vice versa —
 *    a definition without a gate means unvalidated args reach an executor;
 *  - nothing in the registry can dispatch outreach: the outbound gate is
 *    structural (no such tool exists), not behavioural;
 *  - navigate hrefs are in-app paths only — same open-redirect class as the
 *    returnPath rule, one layer up.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  ASSISTANT_TOOLS,
  MUTATING_TOOLS,
  READ_TOOLS,
  TOOL_ARGS,
  buildToolDigest,
  describeAction,
  isMutatingTool,
  parseToolArgs,
  validateNavigateHref,
} from "./services/assistantTools";

describe("assistant tool registry", () => {
  it("partitions cleanly: read XOR mutating XOR navigate, no strays", () => {
    const read = new Set<string>(READ_TOOLS);
    const mut = new Set<string>(MUTATING_TOOLS);
    for (const t of read) expect(mut.has(t)).toBe(false);
    const all = new Set([...read, ...mut, "navigate"]);
    expect([...all].sort()).toEqual(Object.keys(TOOL_ARGS).sort());
  });

  it("every LLM-facing tool has a runtime arg gate, and vice versa", () => {
    const defined = ASSISTANT_TOOLS.map((t) => t.function.name).sort();
    expect(defined).toEqual(Object.keys(TOOL_ARGS).sort());
  });

  it("the outbound gate is structural — no tool can send anything", () => {
    // If someone adds a send/reply/message tool, this fails and forces the
    // conversation about the approval queue it must live behind instead.
    for (const name of Object.keys(TOOL_ARGS)) {
      expect(name).not.toMatch(/send|reply|outreach|dispatch/i);
    }
  });

  it("confirmation gating keys off isMutatingTool", () => {
    expect(isMutatingTool("enroll_in_sequence")).toBe(true);
    expect(isMutatingTool("search_people")).toBe(false);
    expect(isMutatingTool("navigate")).toBe(false);
    expect(isMutatingTool("made_up_tool")).toBe(false);
  });
});

describe("argument gates", () => {
  it("caps prospect batches — the model cannot propose an unbounded action", () => {
    const many = Array.from({ length: 51 }, (_, i) => i + 1);
    expect(() => parseToolArgs("enroll_in_sequence", JSON.stringify({ sequenceId: 1, prospectIds: many }))).toThrow();
    expect(() => parseToolArgs("enroll_in_sequence", JSON.stringify({ sequenceId: 1, prospectIds: [] }))).toThrow();
    expect(() => parseToolArgs("enrich_prospects", JSON.stringify({ prospectIds: Array.from({ length: 26 }, (_, i) => i + 1) }))).toThrow();
  });

  it("create_campaign is mutating (confirm-carded), drafts only, human-in-the-loop only, and capped", () => {
    expect(isMutatingTool("create_campaign")).toBe(true);
    const ok = parseToolArgs("create_campaign", JSON.stringify({
      name: "Higher-Ed CFO outreach", targeting: { targetTitles: ["CFO", "VP Finance"], targetIndustries: ["Higher Education"] },
    })) as Record<string, unknown>;
    // Safe defaults the model did not have to state.
    expect(ok).toMatchObject({ autonomyMode: "batch_approval", targetProspectCount: 100, dailySendCap: 25, goalType: "reply", channels: { email: true, linkedin: false } });
    // `launch` is not an argument — a draft is the only thing this tool can make.
    expect("launch" in ok).toBe(false);
    // A model that tries `launch: true` is ignored by the gate and the key is stripped.
    expect("launch" in (parseToolArgs("create_campaign", JSON.stringify({ name: "xy", targeting: { targetTitles: ["CFO"] }, launch: true })) as object)).toBe(false);
    // Unattended autonomy cannot be proposed from chat.
    expect(() => parseToolArgs("create_campaign", JSON.stringify({ name: "xy", targeting: { targetTitles: ["CFO"] }, autonomyMode: "full" }))).toThrow();
    // Targeting is required and must say something.
    expect(() => parseToolArgs("create_campaign", JSON.stringify({ name: "xy" }))).toThrow();
    expect(() => parseToolArgs("create_campaign", JSON.stringify({ name: "xy", targeting: {} }))).toThrow();
    expect(() => parseToolArgs("create_campaign", JSON.stringify({ name: "xy", targeting: { targetTitles: [] } }))).toThrow();
    // Caps sit inside the procedure's own.
    expect(() => parseToolArgs("create_campaign", JSON.stringify({ name: "xy", targeting: { keywords: ["grants"] }, targetProspectCount: 1001 }))).toThrow();
    expect(() => parseToolArgs("create_campaign", JSON.stringify({ name: "xy", targeting: { keywords: ["grants"] }, dailySendCap: 101 }))).toThrow();
    // The card says DRAFT and that nothing runs.
    const text = describeAction("create_campaign", ok);
    expect(text).toContain("DRAFT");
    expect(text).toContain("Nothing runs until you activate it");
    expect(text).toContain("CFO/VP Finance");
  });

  it("the confirm dispatch never passes launch:true for create_campaign (draft by construction)", () => {
    const src = readFileSync("server/routers/assistant.ts", "utf8");
    const block = src.slice(src.indexOf('case "create_campaign"'), src.indexOf('case "create_list_from_filter"'));
    expect(block).toContain("launch: false");
    expect(block).not.toMatch(/launch:\s*true/);
    expect(block).toContain("caller.are.campaigns.create(");
  });

  it("campaign status is active|paused only — no tool-side archive/delete", () => {
    expect(() => parseToolArgs("set_campaign_status", JSON.stringify({ campaignId: 1, status: "archived" }))).toThrow();
    expect(parseToolArgs("set_campaign_status", JSON.stringify({ campaignId: 1, status: "paused" }))).toMatchObject({ status: "paused" });
  });

  it("add_to_list needs a destination", () => {
    expect(() => parseToolArgs("add_to_list", JSON.stringify({ prospectIds: [1] }))).toThrow();
    expect(parseToolArgs("add_to_list", JSON.stringify({ newListName: "Q3 targets", prospectIds: [1] })))
      .toMatchObject({ newListName: "Q3 targets" });
  });

  it("malformed JSON from the model throws instead of executing", () => {
    expect(() => parseToolArgs("create_tasks", "{not json")).toThrow();
  });

  it("propose_meetings is capped at 5 — a meeting draft per prospect is not a bulk operation", () => {
    expect(() => parseToolArgs("propose_meetings", JSON.stringify({ prospectIds: [1, 2, 3, 4, 5, 6] }))).toThrow();
    expect(parseToolArgs("propose_meetings", JSON.stringify({ prospectIds: [1] }))).toMatchObject({ prospectIds: [1] });
  });

  it("create_list_from_filter refuses an empty filter and caps the blast radius", () => {
    // "Make a list of everyone" needs at least one stated criterion.
    expect(() => parseToolArgs("create_list_from_filter", JSON.stringify({ newListName: "All", filter: {} }))).toThrow();
    expect(() => parseToolArgs("create_list_from_filter", JSON.stringify({ newListName: "Big", filter: { hasEmail: true }, limit: 5000 }))).toThrow();
    expect(parseToolArgs("create_list_from_filter", JSON.stringify({ newListName: "Verified CFOs", filter: { titleQ: "CFO", emailStatus: "valid" } })))
      .toMatchObject({ newListName: "Verified CFOs", limit: 500 });
  });

  it("preview_people_filter needs a non-empty filter too — same vocabulary as the mutation", () => {
    expect(() => parseToolArgs("preview_people_filter", JSON.stringify({ filter: {} }))).toThrow();
    expect(parseToolArgs("preview_people_filter", JSON.stringify({ filter: { seniorities: ["vp"] } })))
      .toMatchObject({ filter: { seniorities: ["vp"] } });
  });
});

describe("validateNavigateHref", () => {
  it("accepts in-app paths", () => {
    expect(validateNavigateHref("/v2/people")).toBe(true);
    expect(validateNavigateHref("/settings?tab=danger")).toBe(true);
    expect(validateNavigateHref("/are/campaigns")).toBe(true);
  });

  it("rejects everything that could leave the app", () => {
    expect(validateNavigateHref("https://evil.example")).toBe(false);
    expect(validateNavigateHref("//evil.example")).toBe(false);
    expect(validateNavigateHref("/a/../admin")).toBe(false);
    expect(validateNavigateHref("javascript:alert(1)")).toBe(false);
    expect(validateNavigateHref("")).toBe(false);
  });
});

describe("describeAction", () => {
  it("states the blast radius in plain words", () => {
    expect(describeAction("enroll_in_sequence", { sequenceId: 3, prospectIds: [1, 2, 3] }))
      .toBe("Enroll 3 people in sequence #3");
    expect(describeAction("set_campaign_status", { campaignId: 13, status: "active" }))
      .toContain("ACTIVE");
    expect(describeAction("enrich_prospects", { prospectIds: [1] })).toContain("credits");
  });

  it("propose_meetings says out loud that nothing is sent without approval", () => {
    const d = describeAction("propose_meetings", { prospectIds: [1, 2] });
    expect(d).toContain("2 meeting proposals");
    expect(d).toContain("approval queue");
    expect(d.toLowerCase()).toContain("nothing is scheduled or mailed");
  });

  it("create_list_from_filter card names the list, the criteria, and the cap", () => {
    const d = describeAction("create_list_from_filter", {
      newListName: "Verified CFOs",
      filter: { titleQ: "CFO", emailStatus: "valid" },
      limit: 500,
    });
    expect(d).toContain('"Verified CFOs"');
    expect(d).toContain('title contains "CFO"');
    expect(d).toContain("email status valid");
    expect(d).toContain("up to 500");
  });
});

describe("buildToolDigest — ids must survive into later turns", () => {
  it("carries tool results (including ids) into the stored message", () => {
    const d = buildToolDigest([{ tool: "search_people", result: { people: [{ id: 140, name: "Steven Burke" }] } }]);
    expect(d).toContain("[assistant_context");
    expect(d).toContain('"id":140');
  });

  it("is empty when no tools ran — no noise in pure-chat turns", () => {
    expect(buildToolDigest([])).toBe("");
  });

  it("is bounded — a huge tool result cannot bloat the conversation store", () => {
    const big = buildToolDigest([
      { tool: "a", result: { blob: "x".repeat(5000) } },
      { tool: "b", result: { blob: "y".repeat(5000) } },
    ]);
    expect(big.length).toBeLessThan(2300);
  });
});
