/**
 * Owner (2026-09-04): "Add the Dashboard and some of the other menus (that
 * are still relevant and working properly) back to the main navigation
 * (where appropriate)."
 *
 * What came back, and where: Dashboard at the top (Daily), Lists + Tasks
 * under CRM, Campaigns + Social under Outreach, and Analytics as a rail
 * section again (Analytics, Reports, Dashboards, Engine Performance,
 * Forecast). What stayed off, and why: Email Analytics reads drafts only
 * (audit 2026-09-02) and would understate every campaign; Broadcasts does
 * not send. The rail still renders ONLY from the registry, and the Daily
 * row from TOP_LINKS — both are pinned so the two cannot drift.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PRIMARY_TOOLS, TOOLS } from "../client/src/lib/toolRegistry";
import { NAV_HELP } from "../client/src/lib/helpText";

const client = (...p: string[]) => readFileSync(join(__dirname, "..", "client", "src", ...p), "utf8");
const primaryHrefs = new Set(PRIMARY_TOOLS.map((t) => t.href));
const tool = (href: string) => TOOLS.find((t) => t.href === href)!;

describe("what came back to the rail", () => {
  it("Dashboard: registered primary in Daily AND in the Shell's top row, with help copy", () => {
    expect(tool("/dashboard")).toBeTruthy();
    expect(tool("/dashboard").group).toBe("Daily");
    expect(primaryHrefs.has("/dashboard")).toBe(true);
    const shell = client("components", "usip", "Shell.tsx");
    const top = shell.slice(shell.indexOf("const TOP_LINKS"), shell.indexOf("// THE RAIL IS A BUDGET"));
    expect(top).toContain('{ href: "/dashboard", label: "Dashboard", icon: LayoutDashboard');
    // Home stays first — Dashboard is the second row, not the landing page.
    expect(top.indexOf('href: "/v2/home"')).toBeLessThan(top.indexOf('href: "/dashboard"'));
    expect(NAV_HELP["/dashboard"]?.body).toBeTruthy();
  });

  it("Lists and Tasks under CRM; Campaigns and Social under Outreach", () => {
    for (const [href, group] of [["/v2/lists", "CRM"], ["/v2/tasks", "CRM"], ["/are/campaigns", "Outreach"], ["/social", "Outreach"]] as const) {
      expect(tool(href).group, href).toBe(group);
      expect(primaryHrefs.has(href), href).toBe(true);
      expect(NAV_HELP[href]?.body, href).toBeTruthy();
    }
    // One "Campaigns" in the palette: the engine's list. The unfinished
    // Marketing product is "Broadcasts".
    expect(tool("/are/campaigns").label).toBe("Campaigns");
    expect(tool("/campaigns").label).toBe("Broadcasts");
    expect(TOOLS.filter((t) => t.label === "Campaigns")).toHaveLength(1);
  });

  it("Analytics is a rail section again — after the products — with its working pages", () => {
    const shell = client("components", "usip", "Shell.tsx");
    const meta = shell.slice(shell.indexOf("const GROUP_META"), shell.indexOf("const EXTRA_GROUP_COLORS"));
    expect(meta).toContain('{ group: "Analytics", label: "Analytics", icon: BarChart3');
    expect(meta.indexOf('group: "Customer Success"')).toBeLessThan(meta.indexOf('group: "Analytics"'));
    for (const href of ["/v2/analytics", "/reports", "/dashboards", "/are/performance", "/forecast"]) {
      expect(tool(href).group, href).toBe("Analytics");
      expect(primaryHrefs.has(href), href).toBe(true);
      expect(NAV_HELP[href]?.body, href).toBeTruthy();
    }
  });
});

describe("what stayed off, on purpose", () => {
  it("Email Analytics stays demoted — it reads drafts only and would understate campaigns", () => {
    expect(primaryHrefs.has("/email-analytics")).toBe(false);
    expect(tool("/email-analytics").description).toContain("drafts only");
  });
  it("Broadcasts stays off the rail until it sends", () => {
    expect(primaryHrefs.has("/campaigns")).toBe(false);
  });
  it("the rail is still a budget: under 40 entries, every one from the registry", () => {
    expect(PRIMARY_TOOLS.length).toBeLessThan(40);
    const shell = client("components", "usip", "Shell.tsx");
    expect(shell).toContain('items: PRIMARY_TOOLS.filter((t) => t.group === m.group && t.group !== "Daily")');
  });
});
