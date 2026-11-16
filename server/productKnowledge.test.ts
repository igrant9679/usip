/**
 * Pins for the Operator's Manual (2026-09-08) — the same knowledge in three
 * homes (the repo skill, the assistant digest, the Help Center category) that
 * can only drift apart silently. These checks make the drift loud:
 *
 *   - every href the assistant digest names is a real registry tool (or one of
 *     its documented tab/filter variants), so `navigate` targets resolve;
 *   - the digest is actually IN both AI prompts (assistant + Ask AI), not just
 *     exported;
 *   - the manual's articles are seeded, in their own category, and every
 *     internal link inside them resolves to an article or a real page;
 *   - the article renderer supports the inline set the manual uses.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TOOLS } from "../client/src/lib/toolRegistry";
import { ARTICLES, CATEGORIES } from "./seedHelpContent";
import { OPERATOR_ARTICLES, OPERATOR_CATEGORY } from "./seedHelpOperatorManual";
import { PRODUCT_KNOWLEDGE, knowledgeHrefs } from "./productKnowledge";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

const registryHrefs = new Set(TOOLS.map((t) => t.href));
// Paths the digest names that are deliberately not registry tools.
// /v2/library is the page that LISTS the registry, so it is not in it; the
// shell's own LIBRARY_LINK and the route are checked below.
const KNOWN_NON_TOOL_PATHS = new Set(["/help/articles", "/v2/library"]);
/**
 * The Settings hub's sections, read from the page that renders them: its
 * `internal` rows each open at /v2/settings/<id> (2026-11-15).
 */
const hubSource = read("../client/src/pages/usip/SettingsHub.tsx");
const hubSections = Array.from(hubSource.matchAll(/\{ id: "([a-z-]+)", label: "([^"]+)", icon: \w+, internal: true/g)).map((m) => ({ id: m[1], label: m[2] }));
const hubLinkRows = Array.from(hubSource.matchAll(/\{ id: "[a-z-]+", label: "([^"]+)", icon: \w+, href: "/g)).map((m) => m[1]);
function hrefResolves(href: string): boolean {
  // "/v2/settings/ID" in the digest is the pattern; a named section must be a real one.
  if (href === "/v2/settings/") return true;
  if (href.startsWith("/v2/settings/") && hubSections.some((s) => s.id === href.slice("/v2/settings/".length))) return true;
  if (registryHrefs.has(href)) return true;
  const base = href.split("?")[0].split("#")[0];
  if (registryHrefs.has(base)) return true;
  if (KNOWN_NON_TOOL_PATHS.has(base)) return true;
  return false;
}

describe("assistant product knowledge digest", () => {
  it("names only real pages", () => {
    const hrefs = knowledgeHrefs();
    expect(hrefs.length).toBeGreaterThan(40);
    const unknown = hrefs.filter((h) => !hrefResolves(h));
    expect(unknown, "digest names a path the tool registry does not have — navigate would 404").toEqual([]);
  });

  it("covers every primary (rail) tool by href", () => {
    const missing = TOOLS.filter((t) => t.primary && !PRODUCT_KNOWLEDGE.includes(t.href)).map((t) => t.href);
    expect(missing).toEqual([]);
  });

  it("stays a digest, not a manual", () => {
    // 2026-11-15: 9000 → 10500. The digest sat at 8,968 of 9,000 and named none
    // of three areas shipped since October: Research (what the AI writers read),
    // AI phone calls, and key sharing between workspaces. Each got one terse
    // paragraph, and the routines were cut down to pay for part of it (10,158
    // now). The headroom is for the assistant's own paragraph, not for prose:
    // depth still belongs in the Operator's Manual articles, which help_lookup reads.
    //
    // 2026-11-15, later the same day: 10500 → 12500. Asked on the live site
    // where to change a key, Elsie answered "Settings (top bar…)". The digest
    // named Settings sections ("Settings → Data sources") without ever saying
    // where Settings is or what else is in it, so she guessed. It now says
    // where every control in the top bar and the sidebar is, and lists the
    // hub's sections with what each holds (about 1,900 characters). The two
    // tests below hold that text to the real shell and the real hub.
    expect(PRODUCT_KNOWLEDGE.length).toBeLessThan(12500);
  });

  it("says where Settings is, and names every section the hub has", () => {
    expect(hubSections.length).toBeGreaterThanOrEqual(20);
    const start = PRODUCT_KNOWLEDGE.indexOf("Settings hub (each section is at /v2/settings/ID");
    expect(start).toBeGreaterThan(-1);
    const hub = PRODUCT_KNOWLEDGE.slice(start, PRODUCT_KNOWLEDGE.indexOf("Page map (group", start));
    expect(hub.length).toBeGreaterThan(400);
    // Every section, by the id its address ends in: a section added to the hub
    // and not to the digest fails here.
    const missing = hubSections.filter((s) => !new RegExp(`(^|[\\s(:,])${s.id}([\\s,.(]|$)`).test(hub)).map((s) => s.id);
    expect(missing).toEqual([]);
    // The rows that leave the hub are named as such, by their labels.
    expect(hubLinkRows.sort()).toEqual(["Data enrichment", "Imports and exports", "Tour builder"]);
    for (const label of hubLinkRows) expect(hub, label).toContain(label);
    // Where the digest gives a section a label, it is the hub's own.
    for (const [id, label] of [["workspace", "Workspace overview"], ["knowledge", "Knowledge base"], ["data-sources", "Data sources"], ["billing", "Billing and credits"], ["system-activity", "Audit log"]]) {
      expect(hubSections.find((s) => s.id === id)?.label, id).toBe(label);
      expect(hub).toContain(`${id} (${label}`);
    }
    // What the digest says each section holds is on that section's page.
    const legacy = read("../client/src/pages/usip/Settings.tsx");
    expect(hubSource).toContain('section === "workspace" && <LegacySettingsSection tab="general"');
    const general = legacy.slice(legacy.indexOf("function GeneralTab("), legacy.indexOf("function MyProfileTab("));
    expect(general).toContain("<SendWindowSection");
    expect(legacy).toContain('aria-label="Pause all outbound"');
    const billing = legacy.slice(legacy.indexOf("function BillingTab("), legacy.indexOf("function DangerTab("));
    expect(billing).toContain('title="Monthly AI budget"');
    // Asked where to change an Apollo key after the first version shipped,
    // Elsie said Integrations: the digest described that section and left
    // Data sources bare. Each says which keys it holds now, and the vendor
    // cards really are in the Data sources section.
    expect(hub).toContain("integrations (AI provider keys and webhooks; NOT the data vendors)");
    expect(hub).toContain("for Apollo, QuickEnrich, WarmySender, LeadOcean and Reoon)");
    const dataSources = hubSource.slice(hubSource.indexOf('{section === "data-sources" && ('), hubSource.indexOf('{section === "workspace" &&'));
    for (const vendor of ["Apollo", "QuickEnrich", "WarmySender", "LeadOcean", "Reoon"]) expect(dataSources.toLowerCase(), vendor).toContain(vendor.toLowerCase());
    const security = legacy.slice(legacy.indexOf("function SecurityTab("), legacy.indexOf("function NotificationsTab("));
    expect(security).toContain("IP allowlist");
    expect(security).toContain("Session timeout");
  });

  it("puts each control where the shell puts it", () => {
    const start = PRODUCT_KNOWLEDGE.indexOf("Where the controls are.");
    expect(start).toBeGreaterThan(-1);
    const frame = PRODUCT_KNOWLEDGE.slice(start, PRODUCT_KNOWLEDGE.indexOf("Settings hub (each section", start));
    expect(frame).toContain("Settings is NOT in the top bar.");
    expect(frame).toContain("Admin Settings at the bottom of the sidebar");
    const shell = read("../client/src/components/usip/Shell.tsx");
    // The bottom of the sidebar: these three rows, in this order.
    const bottom = shell.slice(shell.indexOf("const BOTTOM_LINKS"), shell.indexOf("// ── Route → accent colour maps"));
    const labels = Array.from(bottom.matchAll(/label: "([^"]+)"/g)).map((m) => m[1]);
    expect(labels).toEqual(["Deliverability suite", "Help Center", "Admin Settings"]);
    expect(frame).toContain("Deliverability suite, Help Center and Admin Settings");
    // The Library row, by its own label and address, and the page exists.
    expect(shell).toMatch(/const LIBRARY_LINK: NavLink = \{\s*href: "\/v2\/library",\s*label: "Library — all tools",/);
    expect(read("../client/src/App.tsx")).toContain('path="/v2/library"');
    expect(frame).toContain("Library — all tools (/v2/library)");
    // The admin menu: these rows, then All settings.
    const menu = shell.slice(shell.indexOf("const ADMIN_MENU_ITEMS"), shell.indexOf("function AdminSettingsMenu("));
    expect(Array.from(menu.matchAll(/label: "([^"]+)"/g)).map((m) => m[1])).toEqual(["Users and Teams", "Audit Log", "Security", "Integrations"]);
    expect(shell).toContain("All settings");
    expect(frame).toContain("Users and Teams, Audit Log, Security, Integrations and All settings");
    // The same answer said "click your name at the bottom of the sidebar,
    // then Settings". The name row has a help link and Sign out and nothing
    // else, and the digest gives the clicks in so many words.
    expect(frame).toContain("clicking the name opens nothing");
    expect(frame).toContain("Admin Settings → All settings → the section in the hub's left list");
    const rowStart = shell.indexOf('{(user?.name ?? "?").slice(0, 1).toUpperCase()}');
    expect(rowStart).toBeGreaterThan(-1);
    const userRow = shell.slice(rowStart, shell.indexOf("</aside>", rowStart));
    expect(userRow).toContain('<Link href="/help"');
    expect(userRow).toContain("logout()");
    expect(userRow).not.toContain("/v2/settings");
    // A member who is not an admin gets a plain Settings row there.
    expect(shell).toContain('renderNavLink({ ...l, href: "/v2/settings/profile", label: "Settings", trailingChevron: false })');
    // The top bar's controls, in the order the digest lists them.
    const bar = ["<ElsieButton />", 'title="Colour theme"', 'aria-label="Open Help Center"', 'aria-label="Notifications"'].map((needle) => {
      const at = shell.lastIndexOf(needle);
      expect(at, needle).toBeGreaterThan(-1);
      return at;
    });
    const said = ["Elsie, Search", "colour theme", "? (help", "the bell"].map((needle) => {
      const at = frame.indexOf(needle);
      expect(at, needle).toBeGreaterThan(-1);
      return at;
    });
    expect(said).toEqual([...said].sort((a, b) => a - b));
    // Colour theme is rendered by a component declared after the bar; the other three are in bar order.
    expect([bar[0], bar[2], bar[3]]).toEqual([bar[0], bar[2], bar[3]].sort((a, b) => a - b));
  });

  it("is inside BOTH AI system prompts", () => {
    const assistant = read("./routers/assistant.ts");
    const help = read("./routers/helpCenter.ts");
    expect(assistant).toMatch(/import \{ PRODUCT_KNOWLEDGE \} from "\.\.\/productKnowledge"/);
    expect(assistant).toContain("${PRODUCT_KNOWLEDGE}");
    expect(assistant).toContain("whats_waiting first");
    expect(help).toMatch(/import \{ PRODUCT_KNOWLEDGE \} from "\.\.\/productKnowledge"/);
    expect(help).toContain("${PRODUCT_KNOWLEDGE}");
  });
});

describe("Operator's Manual help articles", () => {
  it("are seeded in their own category, first", () => {
    expect(CATEGORIES[0]).toBe(OPERATOR_CATEGORY);
    expect(OPERATOR_ARTICLES.length).toBeGreaterThanOrEqual(12);
    for (const a of OPERATOR_ARTICLES) {
      expect(ARTICLES).toContain(a);
      expect(a.slug.startsWith("om-")).toBe(true);
      expect(a.categorySlug).toBe(OPERATOR_CATEGORY.slug);
    }
  });

  it("cover the routines and the page directory", () => {
    const slugs = new Set(OPERATOR_ARTICLES.map((a) => a.slug));
    for (const s of ["om-how-velocity-fits-together", "om-page-directory", "om-daily-routine", "om-weekly-routine", "om-monthly-routine", "om-revenue-engine-lifecycle", "om-autopilots-and-schedules", "om-glossary", "om-troubleshooting"]) {
      expect(slugs.has(s), s).toBe(true);
    }
    // Every rail tool is named in the page directory by href.
    const dir = OPERATOR_ARTICLES.find((a) => a.slug === "om-page-directory")!.bodyMarkdown;
    const missing = TOOLS.filter((t) => t.primary && !dir.includes(t.href)).map((t) => t.href);
    expect(missing).toEqual([]);
  });

  it("only link to articles that exist and pages that exist", () => {
    const slugs = new Set(ARTICLES.map((a) => a.slug));
    const bad: string[] = [];
    for (const a of OPERATOR_ARTICLES) {
      for (const m of a.bodyMarkdown.matchAll(/\]\((\/[^)\s]+)\)/g)) {
        const href = m[1];
        const art = href.match(/^\/help\/articles\/([a-z0-9-]+)$/);
        if (art) { if (!slugs.has(art[1])) bad.push(`${a.slug} → ${href}`); continue; }
        if (!hrefResolves(href)) bad.push(`${a.slug} → ${href}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("use only markdown the article renderer supports", () => {
    const renderer = read("../client/src/pages/usip/HelpArticle.tsx");
    // bold, code, links and pipe tables are rendered — not shown as literal asterisks.
    expect(renderer).toContain("export function renderInline");
    expect(renderer).toContain("export function splitTableRow");
    expect(renderer).toContain("flushTable()");
    for (const a of OPERATOR_ARTICLES) {
      expect(a.bodyMarkdown, a.slug).not.toMatch(/^>\s/m); // no blockquotes
      expect(a.bodyMarkdown, a.slug).not.toMatch(/!\[/); // no images
    }
  });
});
