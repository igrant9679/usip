import { describe, it, expect } from "vitest";
import { sectionNameFor, SECTION_NAME_RE } from "./services/onenoteSync";

/**
 * The OneNote sync's two directions meet in a STRING: push writes section
 * names like "Contact — Jane Doe", pull parses them back to find the record.
 * If the builder and the regex drift (different dash, different casing, a
 * sanitizer that eats the separator), every pushed record's section becomes
 * unmatchable and pulled pages silently pile up as "skippedUnmatched" —
 * which reads as "nothing to sync", not as a bug. This is the same
 * producer/consumer seam as every name-mismatch in the dead-wiring class,
 * so it gets the same treatment: one test that runs the round trip.
 */
describe("OneNote section-name contract", () => {
  it("push-written names parse back by the pull matcher", () => {
    for (const [type, name] of [
      ["contact", "Jane Doe"],
      ["lead", "Bob O'Neil"],          // apostrophe is OneNote-illegal → sanitized
      ["account", "Acme & Sons: West"], // & and : are OneNote-illegal → sanitized
      ["account", "  spaced   out  "],
    ] as const) {
      const section = sectionNameFor(type, name);
      const m = SECTION_NAME_RE.exec(section);
      expect(m, `"${section}" did not parse`).not.toBeNull();
      expect(m![1].toLowerCase()).toBe(type);
      expect(m![2].length).toBeGreaterThan(0);
    }
  });

  it("strips every character OneNote refuses in section names", () => {
    const section = sectionNameFor("contact", `a?b*c\\d/e:f<g>h|i&j#k'l%m~n`);
    expect(section).not.toMatch(/[?*\\/:<>|&#'%~]/);
    expect(SECTION_NAME_RE.exec(section)).not.toBeNull();
  });

  it("caps the name so OneNote's 50-char section limit can't reject it", () => {
    const section = sectionNameFor("account", "X".repeat(200));
    expect(section.length).toBeLessThanOrEqual(50);
  });

  it("an empty record name still produces a parseable section", () => {
    const section = sectionNameFor("contact", "???");
    expect(SECTION_NAME_RE.exec(section)![2]).toBe("Unnamed");
  });
});
