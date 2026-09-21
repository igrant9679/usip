/**
 * The ARE sequence templates produce the step count their names promise.
 *
 * Until 2026-09-20 the picker offered "Aggressive 3-Step" and "Nurture
 * 14-Step" while the generator asked the model for
 * `campaign.sequenceTemplate === "standard_7step" ? 7 : 5` — so both of those
 * campaigns produced FIVE steps, and three of the four picker descriptions
 * ("over 21 days", "3 emails in 7 days", "14 touches over 60 days", plus a
 * channel mix nothing enforces) described a product that did not exist.
 *
 * The count now lives on the same object as the label, and the two calls that
 * have to carry every step in one JSON response are given a token budget that
 * scales with it — a truncated response is not a short sequence, it is
 * parseLlmJson throwing and generation failing for the whole campaign.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  ARE_SEQUENCE_TEMPLATES,
  DEFAULT_ARE_SEQUENCE_TEMPLATE,
  FALLBACK_TEMPLATE_STEPS,
  sequenceMaxTokens,
  stepCountForTemplate,
} from "@shared/areSequenceTemplates";
import { MAX_TIMELINE_STEPS } from "@shared/areStepCadence";

const read = (...p: string[]) => readFileSync(join(__dirname, ...p), "utf8");

describe("ARE sequence templates: the count the name promises", () => {
  it("every known value resolves to its own count and everything else keeps today's 5", () => {
    expect(stepCountForTemplate("standard_7step")).toBe(7);
    expect(stepCountForTemplate("aggressive_3step")).toBe(3);
    expect(stepCountForTemplate("nurture_14step")).toBe(14);
    expect(stepCountForTemplate("custom")).toBe(5);
    // sequenceTemplate is z.string() on both writers (are/campaigns.ts update,
    // admin.ts settings save), so an arbitrary value is storable. Total by
    // construction, and the fallback is what those rows generate today.
    expect(stepCountForTemplate(null)).toBe(FALLBACK_TEMPLATE_STEPS);
    expect(stepCountForTemplate(undefined)).toBe(FALLBACK_TEMPLATE_STEPS);
    expect(stepCountForTemplate("something_else")).toBe(FALLBACK_TEMPLATE_STEPS);
    expect(FALLBACK_TEMPLATE_STEPS).toBe(5);
  });

  it("a label that names an N-Step carries exactly N steps", () => {
    // The bug class, pinned: the label and the count are on one object, so a
    // future edit to either one that does not touch the other fails here.
    ARE_SEQUENCE_TEMPLATES.forEach((t) => {
      const m = /(\d+)-Step/i.exec(t.label);
      if (!m) return;
      expect(Number(m[1]), `"${t.label}" names ${m[1]} steps but carries ${t.steps}`).toBe(t.steps);
    });
  });

  it("every template is representable in the per-prospect timeline editor", () => {
    // A template longer than MAX_TIMELINE_STEPS could not be re-timed by the
    // mass timeline editor (prospects.ts / prospectsBulk.ts cap dayOffsets at
    // the same constant), so it would be a shape the product cannot edit.
    ARE_SEQUENCE_TEMPLATES.forEach((t) => {
      expect(t.steps).toBeGreaterThanOrEqual(1);
      expect(t.steps).toBeLessThanOrEqual(MAX_TIMELINE_STEPS);
    });
  });

  it("values are unique and the default is one of them, matching the column default", () => {
    const values = ARE_SEQUENCE_TEMPLATES.map((t) => t.value);
    expect(new Set(values).size).toBe(values.length);
    expect(values).toContain(DEFAULT_ARE_SEQUENCE_TEMPLATE);
    expect(DEFAULT_ARE_SEQUENCE_TEMPLATE).toBe("standard_7step");
    expect(readFileSync("drizzle/schema.ts", "utf8")).toContain('sequenceTemplate: varchar("sequenceTemplate", { length: 64 }).default("standard_7step")');
  });

  it("a longer template gets a bigger budget, and no existing one gets a smaller budget than today", () => {
    // 8192 is the Anthropic structured-tool default (llm.ts) — the floor means
    // a 7-step campaign that works today cannot regress.
    expect(sequenceMaxTokens(7)).toBeGreaterThanOrEqual(8192);
    expect(sequenceMaxTokens(3)).toBeGreaterThanOrEqual(8192);
    expect(sequenceMaxTokens(14)).toBeGreaterThan(sequenceMaxTokens(7));
  });
});

describe("ARE sequence templates: the wiring", () => {
  it("the generator reads the table and the old ternary cannot come back", () => {
    const p = read("routers", "are", "prospects.ts");
    expect(p).toContain("stepCountForTemplate(campaign.sequenceTemplate)");
    expect(p).not.toMatch(/sequenceTemplate === "standard_7step" \? 7 : 5/);
  });

  it("the skeleton is bounded by the promise and a short one is a recorded fact", () => {
    const p = read("routers", "are", "prospects.ts");
    const gen = p.slice(
      p.indexOf('const parsed = parseLlmJson(content, "generateCampaignTemplate")'),
      p.indexOf("generatedTemplateAt: new Date()"),
    );
    expect(gen).toContain(".slice(0, stepCount)");
    expect(gen).toContain("sequence.template");
    // The skeleton call carries every step in one response, so it is budgeted.
    expect(p).toContain("maxTokens: sequenceMaxTokens(stepCount)");
  });

  it("the personalizer is budgeted and aligned to the skeleton", () => {
    // This array, not the skeleton, is what becomes the stored sequence and the
    // areExecutionQueue rows — the 1:1 was only ever asked for in the prompt.
    const p = read("routers", "are", "prospects.ts");
    const fn = p.slice(
      p.indexOf("async function personalizeForProspect"),
      p.indexOf("export async function runSequenceAgent"),
    );
    expect(fn).toContain("maxTokens: sequenceMaxTokens(template.steps.length)");
    expect(fn).toContain(".slice(0, template.steps.length).map(");
  });

  it("the picker renders from the table and the four false claims are gone", () => {
    const s = readFileSync(join(__dirname, "..", "client", "src", "pages", "usip", "ARESettings.tsx"), "utf8");
    expect(s).toContain("ARE_SEQUENCE_TEMPLATES");
    // Each one named so a copy-paste revert of the old literal array fails.
    expect(s).not.toContain("over 21 days");
    expect(s).not.toContain("3 emails in 7 days");
    expect(s).not.toContain("14 touches over 60 days");
    expect(s).not.toContain("Email × 4 + LinkedIn × 2 + call × 1");
  });

  it("editing sequenceTemplate busts the cached skeleton, and the bust flag is declared first", () => {
    const c = read("routers", "are", "campaigns.ts");
    const bust = c.slice(c.indexOf("let bustTemplate = false;"), c.indexOf("if (bustTemplate)"));
    expect(bust).toContain("rest.sequenceTemplate !== undefined");
    // Declaration before use: the assignment moved INTO the bust block, and a
    // move that left it above the `let` would be a TDZ error at runtime.
    expect(c.indexOf("let bustTemplate = false;")).toBeLessThan(c.indexOf("updates.sequenceTemplate = rest.sequenceTemplate"));
  });

  it("Gemini's output cap is clamped rather than passed through", () => {
    // Callers now size maxTokens to their work (up to 16000 for 14 steps) and
    // Gemini errors on a value above the model's cap.
    expect(read("_core", "llm.ts")).toContain("Math.min(8192, maxTokens ?? max_tokens ?? 4096)");
  });

  it("the AI-proposal path names the default; the fixed-copy path keeps its inert literal", () => {
    const prop = read("services", "campaignProposals.ts");
    expect(prop).toContain("DEFAULT_ARE_SEQUENCE_TEMPLATE");
    expect(prop).not.toContain('sequenceTemplate: "standard_7step"');
    // createFixedFromSequence builds a copyMode "fixed" campaign, and the fixed
    // branch of runSequenceAgent returns before generateCampaignTemplate runs —
    // so this value is never read. It stays, with the reason written down, so
    // nobody "unifies" it into a promise that path cannot keep.
    const c = read("routers", "are", "campaigns.ts");
    expect(c).toContain('sequenceTemplate: "standard_7step"');
    expect(c).toContain("Inert on purpose");
  });
});
