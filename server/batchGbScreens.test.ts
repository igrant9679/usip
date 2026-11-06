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
import { DashboardChartRenderer } from "../client/src/components/usip/DashboardChartRenderer";
import { chartText } from "../client/src/lib/chartText";

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

describe("a dashboard chart has words (G64)", () => {
  const bar = { type: "bar", series: [{ label: "Mon", value: 3 }, { label: "Tue", value: 41 }] };

  it("a drawn chart is named by its summary and followed by a hidden table of what it plots", () => {
    const html = renderToStaticMarkup(createElement(DashboardChartRenderer, { data: bar }));
    expect(html).toContain('<figure class="m-0" aria-label="Bar chart, 2 points, from 3 to 41">');
    expect(html).toContain('<div aria-hidden="true">');
    expect(html).toMatch(/<table class="sr-only">[\s\S]*<th scope="row">Tue<\/th><td>41<\/td>/);
  });

  it("every drawn type says something; the text types are left as they are", () => {
    expect(chartText({ type: "pie", series: [{ name: "Won", value: 3 }, { name: "Lost", value: 1 }] })?.summary)
      .toBe("Pie chart, 2 slices, total 4; largest Won (75%)");
    expect(chartText({ type: "stacked_bar", keys: ["calls", "emails"], series: [{ label: "W1", calls: 2, emails: 5 }] })?.columns)
      .toEqual(["Label", "calls", "emails"]);
    expect(chartText({ type: "scatter", series: [{ name: "D", stage: "proposal", x: 9, y: 500 }] })?.rows).toEqual([["D", "proposal", 9, 500]]);
    expect(chartText({ type: "heatmap", series: [{ day: "Mon", hour: 9, count: 4 }, { day: "Tue", hour: 1, count: 0 }] })?.rows).toEqual([["Mon", "9:00", 4]]);
    expect(chartText({ type: "gauge", value: 62 })?.summary).toBe("Gauge: 62%");
    expect(chartText({ type: "funnel", series: [{ stage: "a", count: 1, value: 1 }] })).toBeNull();
    expect(chartText({ type: "single_value", value: 3 })).toBeNull();
    expect(chartText({ type: "bar", series: [] })).toBeNull();
  });
});

describe("a broken page keeps the sidebar (G37)", () => {
  it("Shell wraps the page content in its own boundary, keyed by the path", () => {
    const s = read("client/src/components/usip/Shell.tsx");
    const main = s.slice(s.indexOf('<main className="flex-1 overflow-auto bg-background">'), s.indexOf("</main>"));
    expect(main).toMatch(/<ErrorBoundary resetKey=\{location\} inline>\s*<PageTransition>\{children\}<\/PageTransition>\s*<\/ErrorBoundary>/);
  });
});

describe("the app shell's loose ends (G66)", () => {
  const shell = read("client/src/components/usip/Shell.tsx");

  it("the top-bar search opens the palette; there is no inert search box", () => {
    expect(shell).not.toMatch(/<input aria-label="Search"[^>]*placeholder="Search…"/);
    const top = shell.slice(shell.indexOf("<ElsieToggle />"), shell.indexOf("{actions}"));
    expect(top).toContain("onClick={openCommandPalette}");
  });

  it("both search entries show one shortcut label, the platform's", () => {
    expect(shell).toContain('const PALETTE_SHORTCUT = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘K" : "Ctrl K";');
    expect((shell.match(/\{PALETTE_SHORTCUT\}<\/kbd>/g) ?? []).length).toBe(2);
    expect(shell).not.toMatch(/>(Ctrl K|⌘K)<\/kbd>/);
  });

  it("the drawer's close button is called that, and only shows on a phone", () => {
    expect(shell).not.toContain('aria-label="Collapse sidebar"');
    const btn = shell.slice(shell.indexOf("onClick={() => setMobileOpen(false)}"), shell.indexOf('aria-label="Close menu"'));
    expect(btn).toContain("md:hidden");
  });

  it("only an admin gets the Admin Settings panel; anyone else gets Settings", () => {
    const bottom = shell.slice(shell.indexOf("{BOTTOM_LINKS.map((l) =>"), shell.indexOf("renderNavLink(l)\n"));
    expect(bottom).toMatch(/isAdminRole\(current\?\.role\) \? \(\s*<AdminSettingsMenu/);
    expect(bottom).toContain('renderNavLink({ ...l, href: "/v2/settings/profile", label: "Settings", trailingChevron: false })');
  });
});

describe("Settings > Billing ships no placeholder (L11)", () => {
  it("the Invoices card that only said Placeholder is gone", () => {
    const s = read("client/src/pages/usip/Settings.tsx");
    expect(s).not.toContain("Placeholder — invoice history appears here");
    expect(s).not.toMatch(/<Section title="Invoices"/);
  });
});
