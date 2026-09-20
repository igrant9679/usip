/**
 * ONE draft-source vocabulary (owner report 2026-09-20): the Emails feed,
 * its status-aware filter chips, and the Home attention cards must classify
 * drafts identically — sequence (sequenceId set) > ai_draft (aiGenerated) >
 * crm — or a Home card links to a filter that matches nothing. That exact
 * failure shipped: 15 pending_review AI drafts counted as "sequence drafts"
 * on Home while the feed filed them under ai_draft, so the card's link
 * landed on an empty list under a banner still claiming 23.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (...p: string[]) => readFileSync(join(__dirname, ...p), "utf8");

describe("one draft-source vocabulary across feed, chips and Home", () => {
  it("the feed's ai_draft filter is the exact inverse of its classification", () => {
    const feed = read("routers", "emailActivity.ts");
    expect(feed).toContain('r.sequenceId ? "sequence" : r.aiGenerated ? "ai_draft" : "crm"');
    // sequence wins over ai_draft in classification, so the ai_draft FILTER
    // must exclude sequence-bound drafts.
    expect(feed).toContain("${emailDrafts.aiGenerated} = true AND ${emailDrafts.sequenceId} IS NULL");
  });

  it("stats chips are status-aware and drafts get chips", () => {
    const feed = read("routers", "emailActivity.ts");
    expect(feed).toContain('status: z.string().default("all")');
    expect(feed).toContain("bySource: chips,");
    // The awaiting chips group by the SAME case expression the feed uses.
    expect(feed).toContain("case when ${emailDrafts.sequenceId} is not null then 'sequence' when ${emailDrafts.aiGenerated} = true then 'ai_draft' else 'crm' end");
  });

  it("the attention cards count by flags, never by status string alone", () => {
    const att = read("routers", "attention.ts");
    // AI drafts: aiGenerated AND not sequence-bound.
    expect(att).toContain("eq(emailDrafts.aiGenerated, true)");
    expect(att).toContain("isNull(emailDrafts.sequenceId)");
    // Sequence drafts: sequence-bound, whatever the status string says.
    expect(att).toContain("isNotNull(emailDrafts.sequenceId)");
    // CRM drafts have their own card feed — the third class is not invisible.
    expect(att).toContain("crmDrafts");
    // The old status-only splits are gone.
    expect(att).not.toContain('eq(emailDrafts.status, "ai_pending_review")');
    expect(att).not.toContain('eq(emailDrafts.status, "pending_review")');
  });

  it("every Home draft card links to the source its rows classify under", () => {
    const panel = read("..", "client", "src", "components", "usip", "AttentionPanel.tsx");
    expect(panel).toContain('href="/v2/emails?status=awaiting&source=ai_draft"');
    expect(panel).toContain('href="/v2/emails?status=awaiting&source=sequence"');
    expect(panel).toContain('href="/v2/emails?status=awaiting&source=crm"');
  });

  it("the no-email door covers the CRM draft paths", () => {
    const pipeline = read("routers", "aiPipeline.ts");
    // Belt inside the pipeline (covers single, bulk and the nightly batch)…
    expect(pipeline).toContain("No email address on the contact/lead");
    // …plus the user-facing guards.
    expect(pipeline).toContain("skippedNoEmail");
    const sequences = read("routers", "sequences.ts");
    expect(sequences).toContain("This person has no email address — find one first");
  });
});
