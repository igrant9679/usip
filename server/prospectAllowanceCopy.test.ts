/**
 * The help content says what the monthly prospect-data allowance does, with
 * the app's own numbers and sentences, and names no data vendor (owner
 * approved 2026-11-25: member-facing copy says "our prospect databases").
 * Pinned to shared/prospectAllowance.ts, so a changed number fails here.
 */
import { describe, expect, it } from "vitest";
import {
  MEMBERSHIP_PLANS,
  PLAN_MONTHLY_LIMIT,
  allowanceLauncherLine,
  allowanceSummaryLine,
  buildAllowance,
} from "@shared/prospectAllowance";
import { ARTICLES, TOURS } from "./seedHelpContent";
import { PRODUCT_KNOWLEDGE } from "./productKnowledge";

describe("the help content says the same numbers, and names no vendor", () => {
  const VENDORS = /apollo|quickenrich|warmysender|leadocean|reoon/i;

  it("the article lists every plan's number and the app's own sentences", () => {
    const a = ARTICLES.find((x) => x.slug === "prospect-data-allowance");
    expect(a, "the allowance article").toBeTruthy();
    const body = a!.bodyMarkdown;
    for (const p of MEMBERSHIP_PLANS) {
      const label = p[0].toUpperCase() + p.slice(1);
      expect(body, p).toContain(`| ${label} | ${PLAN_MONTHLY_LIMIT[p].toLocaleString("en-US")} |`);
    }
    expect(body).toContain(allowanceSummaryLine(buildAllowance("contributor", 412, "2026-11")));
    expect(body).toContain("Your own keys are optional.");
    expect(`${a!.title} ${a!.summary} ${body}`).not.toMatch(VENDORS);
  });

  it("the tours and the assistant's digest give the same numbers without a vendor in the new lines", () => {
    const steps = TOURS.flatMap((t) => t.steps).filter((s) => /membership plan/i.test(s.bodyMarkdown));
    expect(steps.length).toBeGreaterThanOrEqual(3);
    for (const s of steps) expect(s.bodyMarkdown, s.title).not.toMatch(VENDORS);
    const sentence = PRODUCT_KNOWLEDGE.slice(PRODUCT_KNOWLEDGE.indexOf("Membership plans include prospect data"));
    const line = sentence.slice(0, sentence.indexOf("\n"));
    expect(line).toContain("Trial 250, Member 1,000, Contributor 3,000, Steward 5,000, Founder 6,000");
    expect(line).not.toMatch(VENDORS);
    expect(allowanceLauncherLine(buildAllowance("trial", 0, "2026-11"))).toBe("Prospect data: 250 of 250 left this month");
  });
});
