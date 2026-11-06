/**
 * Smaller screen fixes from audit batch Gb (2026-11-06), pinned by reading the
 * source the way the repo's other screen guards do.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { submissionExtras } from "../client/src/lib/submissionFields";
import { SubmissionExtras } from "../client/src/components/usip/SubmissionExtras";

const root = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8").replace(/\r\n/g, "\n");

describe("a submission's message and phone are shown (G63)", () => {
  const data = { name: "Ann Lee", email: "ann@example.com", company: "Acme", message: "Call me after 3.\nThanks", phone: "+1 555 0100", budget_band: "10-50k", empty: "  " };

  it("lists every field beyond name, email and company, phone first and message last", () => {
    expect(submissionExtras(data)).toEqual([
      { key: "phone", label: "Phone", value: "+1 555 0100" },
      { key: "budget_band", label: "Budget band", value: "10-50k" },
      { key: "message", label: "Message", value: "Call me after 3.\nThanks" },
    ]);
    expect(submissionExtras(null)).toEqual([]);
    expect(submissionExtras(["x"])).toEqual([]);
  });

  it("renders them, escaped", () => {
    const html = renderToStaticMarkup(createElement(SubmissionExtras, { data: { message: "<b>hi</b>" } }));
    expect(html).toContain("Message:");
    expect(html).toContain("&lt;b&gt;hi&lt;/b&gt;");
    expect(renderToStaticMarkup(createElement(SubmissionExtras, { data: { name: "x" } }))).toBe("");
  });

  it("both submissions lists show them", () => {
    expect(read("client/src/pages/usip/FormsV2.tsx")).toContain("<SubmissionExtras data={r.data} />");
    expect(read("client/src/pages/usip/LandingPages.tsx")).toContain("<SubmissionExtras data={s.data} />");
  });
});

describe("Settings > Billing ships no placeholder (L11)", () => {
  it("the Invoices card that only said Placeholder is gone", () => {
    const s = read("client/src/pages/usip/Settings.tsx");
    expect(s).not.toContain("Placeholder — invoice history appears here");
    expect(s).not.toMatch(/<Section title="Invoices"/);
  });
});
