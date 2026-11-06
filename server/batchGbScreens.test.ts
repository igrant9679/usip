/**
 * Smaller screen fixes from audit batch Gb (2026-11-06), pinned by reading the
 * source the way the repo's other screen guards do.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
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

describe("public pages say what is true (G70)", () => {
  it("the proposal portal shows a client no Draft badge and none of the team's labels", () => {
    const s = read("client/src/pages/ProposalPortal.tsx");
    const cfg = s.slice(s.indexOf("const STATUS_CONFIG = {"), s.indexOf("} as const;", s.indexOf("const STATUS_CONFIG = {")));
    expect(cfg).not.toContain("draft:");
    expect(cfg).not.toContain("Sent to Client");
    expect(s).not.toContain("?? STATUS_CONFIG.draft");
    expect(s).toMatch(/\{statusCfg && \(\s*<span/);
  });

  it("the chat promises a calendar invite only when one was sent", () => {
    const s = read("client/src/pages/ChatPage.tsx");
    expect(s).toContain("setInviteSent(!!r?.calendarBooked);");
    expect(s).toContain('{inviteSent ? " — a calendar invite is on its way." : " — the team will confirm with you shortly."}');
    expect(s).not.toContain('{" — a calendar invite is on its way."}');
  });
});

describe("the settings hub says where you are (G51)", () => {
  const hub = read("client/src/pages/usip/SettingsHub.tsx");

  it("an unknown section says so instead of showing Profile", () => {
    expect(hub).not.toContain('.some((i) => i.internal && i.id === params.section)');
    expect(hub).toContain("const unknownSection = !!params.section && !askedItem ? params.section : null;");
    expect(hub).toContain("There is no settings section called “{unknownSection}”");
    expect(hub).toContain('const section = askedItem?.internal ? askedItem.id : "profile";');
  });

  it("a link-out row reached by its id goes where the rail sends it", () => {
    expect(hub).toContain("if (askedItem && !askedItem.internal && askedItem.href) navigate(askedItem.href, { replace: true });");
  });

  it("the audit page's row carries its title", () => {
    expect(hub).toContain('{ id: "system-activity", label: "Audit log", icon: Activity, href: "/audit" }');
  });
});

describe("dead client code is gone (G67)", () => {
  // Each was imported by nothing, routed nowhere and lazy-loaded by nobody
  // (checked 2026-11-06): template leftovers, and a SendGrid card unmounted on
  // 2026-08-14. A file brought back should be wired into something.
  const gone = [
    "client/src/pages/Placeholder.tsx",
    "client/src/pages/ComponentShowcase.tsx",
    "client/src/pages/Home.tsx",
    "client/src/components/AIChatBox.tsx",
    "client/src/components/DashboardLayout.tsx",
    "client/src/components/DashboardLayoutSkeleton.tsx",
    "client/src/components/LoginDialog.tsx",
    "client/src/components/usip/settings/SendGridCard.tsx",
  ];
  it.each(gone)("%s", (f) => {
    expect(existsSync(join(root, f))).toBe(false);
  });
});

describe("Settings > Billing ships no placeholder (L11)", () => {
  it("the Invoices card that only said Placeholder is gone", () => {
    const s = read("client/src/pages/usip/Settings.tsx");
    expect(s).not.toContain("Placeholder — invoice history appears here");
    expect(s).not.toMatch(/<Section title="Invoices"/);
  });
});
