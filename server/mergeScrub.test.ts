/**
 * The send-boundary merge scrub: no `{{…}}` ever leaves in a template send.
 *
 * The renderers deliberately disagree about unresolved tags — areEngine
 * strips (autonomous path, no reviewer), resolveMergeVars/renderMergeFields
 * leave them VISIBLE so reviewers catch them in drafts. Both policies are
 * right for their surfaces and neither is a wire guarantee: recipients have
 * received a literal {{senderCompany}} (sequences, pre-fix) and a campaign
 * subject carried {{company}} on 2026-08-08. The guarantee now lives at the
 * egress: scrub template sends, never human-composed mail.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { scrubUnresolvedMergeTags, scrubForSend } from "./mergeVars";

const read = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8");

describe("scrubUnresolvedMergeTags — executed", () => {
  it("removes a lone unresolved tag and reports it", () => {
    const r = scrubUnresolvedMergeTags("The gap at {{company}}");
    expect(r.text).toBe("The gap at");
    expect(r.removed).toEqual(["company"]);
  });

  it("tidies the double space a mid-sentence removal leaves", () => {
    const r = scrubUnresolvedMergeTags("Hello {{firstName}} and welcome");
    expect(r.text).toBe("Hello and welcome");
  });

  it("tidies stranded space before punctuation", () => {
    const r = scrubUnresolvedMergeTags("your work at {{company}}.");
    expect(r.text).toBe("your work at.");
  });

  it("removes every tag, including fallback syntax and empty braces", () => {
    const r = scrubUnresolvedMergeTags("{{a|b}} x {{ }} y {{first_name}}");
    expect(r.text).toBe("x y");
    expect(r.removed).toEqual(["a|b", "", "first_name"]);
  });

  it("touches NOTHING when no tag is present — the human-prose guarantee", () => {
    // The tidy passes only run after a removal: prose with deliberate double
    // spaces or spaced punctuation must pass through byte-identical.
    const s = "I typed  two spaces , and I meant them.";
    const r = scrubUnresolvedMergeTags(s);
    expect(r.text).toBe(s);
    expect(r.removed).toEqual([]);
  });

  it("an UNCLOSED {{ triggers no removal and therefore no rewriting", () => {
    /**
     * The discriminating case for the tidy gate: tag-free text is protected
     * by the cheap `includes("{{")` early return, so only input that
     * CONTAINS "{{" without forming a tag reaches the gate with zero
     * removals. A mutation running the tidy passes unconditionally survived
     * every other test — this is the one place the gate is observable.
     */
    const s = "I wrote {{ and left  two spaces , deliberately.";
    const r = scrubUnresolvedMergeTags(s);
    expect(r.text).toBe(s);
    expect(r.removed).toEqual([]);
  });

  it("handles empty and null-ish input", () => {
    expect(scrubUnresolvedMergeTags("").text).toBe("");
    expect(scrubUnresolvedMergeTags("").removed).toEqual([]);
  });

  it("leaves single braces and JSON-ish content alone", () => {
    const s = 'config: { "a": 1 } and {not a tag}';
    expect(scrubUnresolvedMergeTags(s).text).toBe(s);
  });

  it("scrubForSend returns the scrubbed text", () => {
    expect(scrubForSend("hi {{x}}", "test")).toBe("hi");
    expect(scrubForSend("clean", "test")).toBe("clean");
  });
});

describe("the scrub sits at every template egress", () => {
  it("emailDelivery scrubs in all three senders", () => {
    const src = read("server/emailDelivery.ts");
    // 2026-09-03: the pool and workspace senders fill the SENDER tokens from
    // the chosen mailbox first, then scrub — the scrub is still the last
    // thing before the wire, and the fill is what stops "Best," / blank line.
    expect(src.includes('scrubTemplateOpts(fillSenderTokens(opts, chosen), "emailDelivery.pool")'), "pool sender unscrubbed").toBe(true);
    expect(src.includes('scrubTemplateOpts(fillSenderTokens(opts, { fromName: cfg.fromName, fromEmail }), "emailDelivery.workspace")'), "workspace sender unscrubbed").toBe(true);
    expect(src.includes('scrubTemplateOpts(opts, "emailDelivery.system")'), "system sender unscrubbed").toBe(true);
    // The pool scrub must sit AFTER the account is chosen and BEFORE the adapter send.
    const pool = src.slice(src.indexOf("export async function sendCampaignEmailViaPool"), src.indexOf("export async function sendWorkspaceEmail"));
    const chosenAt = pool.indexOf("let chosen = eligible[0].a;");
    const scrubAt = pool.indexOf('scrubTemplateOpts(fillSenderTokens(opts, chosen), "emailDelivery.pool")');
    const sendAt = pool.indexOf("await adapter.sendEmail({");
    expect(chosenAt).toBeGreaterThan(-1);
    expect(scrubAt).toBeGreaterThan(chosenAt);
    expect(sendAt).toBeGreaterThan(scrubAt);
    // The helper must scrub subject AND html AND text.
    const helper = src.slice(src.indexOf("function scrubTemplateOpts"), src.indexOf("function scrubTemplateOpts") + 700);
    for (const field of ["subject:", "html:", "text:"] as const) {
      expect(helper.includes(field), `scrubTemplateOpts skips ${field}`).toBe(true);
    }
  });

  it("the sequences auto-send scrubs subject and both bodies", () => {
    // The path that has ALREADY mailed a recipient a literal tag, and runs
    // with no human in the loop.
    const src = read("server/routers/sequences.ts");
    expect(src.includes('"sequences.autoSend.subject"')).toBe(true);
    expect(src.includes('"sequences.autoSend.body"')).toBe(true);
    expect(src.includes('"sequences.autoSend.bodyText"')).toBe(true);
  });

  it("the crm single-send scrubs subject and both bodies", () => {
    const src = read("server/routers/crm.ts");
    expect(src.includes('"crm.send.subject"')).toBe(true);
    expect(src.includes('"crm.send.body"')).toBe(true);
    expect(src.includes('"crm.send.bodyText"')).toBe(true);
  });

  it("the ARE path keeps its own strip policy — belt under the emailDelivery scrub", () => {
    const src = read("server/areEngine.ts");
    // Sender tokens are the one deferred set (filled by emailDelivery once
    // the mailbox is known); everything else unresolved is still stripped.
    expect(src.includes('if (hit === undefined) return name && isDeferredSenderToken(name) ? match : "";')).toBe(true);
  });

  it("human-composed mail is NOT scrubbed", () => {
    /**
     * The deliberate exclusion: the Rep Mailbox adapter carries what a person
     * typed, and a person may legitimately write "{{firstName}}" when
     * discussing a template. Silently rewriting a human's words is worse than
     * any stray brace — if this assertion fails because someone added the
     * scrub to the adapter, that is a decision to unmake, not a gap closed.
     */
    const adapter = read("server/emailAdapter.ts");
    expect(adapter.includes("scrubForSend")).toBe(false);
    expect(adapter.includes("scrubUnresolvedMergeTags")).toBe(false);
    expect(adapter.includes("scrubTemplateOpts")).toBe(false);
  });

  it("a fired scrub is reported, naming the tokens", () => {
    // A silent scrub hides the upstream bug (a token offered somewhere but
    // missing from a merge map) that caused it to fire at all.
    const src = read("server/mergeVars.ts");
    const fn = src.slice(src.indexOf("export function scrubForSend"), src.indexOf("export function scrubForSend") + 600);
    expect(fn.includes("console.warn")).toBe(true);
    expect(fn.includes("removed.join")).toBe(true);
  });
});
