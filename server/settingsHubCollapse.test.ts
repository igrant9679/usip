/**
 * The legacy Settings page was collapsed into the Settings hub on 2026-09-15
 * (commit 1e9c333). `/settings` is not a page any more: it is a deep-link shim
 * that reads `?tab=` and redirects into the matching hub section.
 *
 * Phase 5's consolidation pass (2026-10-28) found that collapse already done
 * and nothing guarding it, so these are the pins it was missing. Two things
 * can break it silently, and "silently" is the whole point:
 *
 *   1. A mapping target that is not an INTERNAL hub section lands on Profile.
 *      SettingsHub resolves `:section` with `i.internal && i.id === param`, and
 *      anything else falls through to "Profile (the default landing subpage)".
 *      So a renamed section id, a typo, or a target that is one of the hub's
 *      link-out (`href:`) rows all produce a deep link that looks like it
 *      works and quietly shows the wrong page. No error, no 404.
 *   2. `/settings/pipelines` and `/settings/linkedin-limits` are separate
 *      pages that happen to live under the same prefix. This is the same trap
 *      `/prospects/:id` was in phase 5 item 2 — retire or reroute the parent
 *      and every deep link to the children goes with it.
 *
 * Source-text pins, in the style of the other phase guards: the shim and the
 * hub's section registry cannot be imported here (both pull React, tRPC and
 * lucide at module scope — the reason client/src/lib/retiredRoutes.ts exists
 * as a React-free module).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8").replace(/\r\n/g, "\n");

const settings = read("client/src/pages/usip/Settings.tsx");
const hub = read("client/src/pages/usip/SettingsHub.tsx");
const app = read("client/src/App.tsx");

/** The legacy tab ids, from the TABS literal the page still exports its type from. */
function legacyTabIds(): string[] {
  const start = settings.indexOf("const TABS = [");
  const end = settings.indexOf("] as const;", start);
  expect(start, "TABS literal").toBeGreaterThan(-1);
  expect(end, "end of TABS").toBeGreaterThan(start);
  const block = settings.slice(start, end);
  return [...block.matchAll(/\{ id: "([a-z-]+)"/g)].map((m) => m[1]);
}

/** tab id -> hub section id, from the shim's TAB_TO_SECTION map. */
function tabToSection(): Record<string, string> {
  const start = settings.indexOf("const TAB_TO_SECTION");
  const end = settings.indexOf("};", start);
  expect(start, "TAB_TO_SECTION").toBeGreaterThan(-1);
  const block = settings.slice(start, end);
  const out: Record<string, string> = {};
  for (const m of block.matchAll(/"?([a-z-]+)"?\s*:\s*"([a-z-]+)"/g)) out[m[1]] = m[2];
  return out;
}

/** Hub section ids that render IN the hub (internal), not the link-out rows. */
function internalSectionIds(): string[] {
  const start = hub.indexOf("const GROUPS: HubGroup[]");
  const end = hub.indexOf("export default function SettingsHub", start);
  expect(start, "the hub's GROUPS registry").toBeGreaterThan(-1);
  const block = hub.slice(start, end > start ? end : undefined);
  return [...block.matchAll(/\{ id: "([a-z-]+)"[^}]*\}/g)]
    .filter((m) => m[0].includes("internal: true"))
    .map((m) => m[1]);
}

describe("the legacy Settings page stays collapsed into the hub (2026-09-15, pinned 2026-10-28)", () => {
  it("/settings is a redirect shim, not a settings page", () => {
    // Three lines: read ?tab, map it, replace. If this grows a UI again the
    // collapse has been undone and the hub is no longer the one Settings area.
    expect(settings).toContain('export default function Settings() {');
    expect(settings).toMatch(/return <Redirect to=\{`\/v2\/settings\/\$\{TAB_TO_SECTION\[t\] \?\? "workspace"\}`\} replace \/>;/);
    // replace, so Back leaves Settings instead of bouncing through the shim.
    expect(settings).toContain("replace />");
  });

  it("every legacy tab still has somewhere to land", () => {
    const ids = legacyTabIds();
    const map = tabToSection();
    expect(ids.length, "legacy tabs").toBe(11);
    for (const id of ids) expect(map[id], `?tab=${id}`).toBeTruthy();
  });

  it("every target is an INTERNAL hub section, or the deep link silently shows Profile", () => {
    const internal = internalSectionIds();
    // Sanity: the parse found the registry, not an empty list that would make
    // the real assertion below vacuous.
    expect(internal, "internal hub sections").toContain("profile");
    expect(internal.length).toBeGreaterThan(8);
    const map = tabToSection();
    const targets = [...new Set(Object.values(map))];
    expect(targets.length).toBeGreaterThan(5);
    for (const t of targets) expect(internal, `?tab=… -> /v2/settings/${t}`).toContain(t);
    // The shim's own fallback has to resolve too.
    expect(internal, "the shim's fallback").toContain("workspace");
  });

  it("the branding tab's email half rides with delivery, and that is on purpose", () => {
    // The legacy Branding tab was "Branding & email defaults": brand colours
    // AND the outbound From-name and signature. The hub split it — colours,
    // logo and voice to BrandingSection, email identity to Email delivery —
    // so `branding` maps to email-delivery rather than to the hub's own
    // `branding` section. Checked by eye 2026-10-28 before relying on it;
    // pinned because the mapping reads like a mistake and is not one.
    expect(tabToSection().branding).toBe("email-delivery");
    expect(settings).toContain("Email identity (From-name + signature) rides with delivery");
    // The fields the split could have orphaned are still edited somewhere.
    expect(settings).toContain("emailFromName");
    expect(settings).toContain("emailSignature");
    expect(settings).toMatch(/\{tab === "smtp" && \(\n\s*<>\n\s*<SmtpTab canEdit=\{isAdmin\} \/>\n\s*<BrandingTab/);
    // Colours/logo/voice live in the hub's own section, which must still exist.
    expect(internalSectionIds()).toContain("branding");
  });

  it("the two pages under /settings/ are their own routes, not swallowed by the shim", () => {
    // Same shape as /prospects/:id in item 2: the parent stopped being a page,
    // the children did not.
    expect(app).toContain('<Route path="/settings/pipelines"><AuthGate><SettingsPipelines /></AuthGate></Route>');
    expect(app).toContain('<Route path="/settings/linkedin-limits"><AuthGate><LinkedInLimits /></AuthGate></Route>');
    // Neither is a retired route, so neither redirects anywhere. Read the MAP,
    // not the file: the module's header discusses both paths in prose, and a
    // first version of this check matched that prose and failed on it.
    const retired = read("client/src/lib/retiredRoutes.ts");
    const mapStart = retired.indexOf("export const RETIRED_ROUTES");
    const mapEnd = retired.indexOf("} as const;", mapStart);
    expect(mapStart, "RETIRED_ROUTES").toBeGreaterThan(-1);
    expect(mapEnd, "end of RETIRED_ROUTES").toBeGreaterThan(mapStart);
    const keys = [...retired.slice(mapStart, mapEnd).matchAll(/"([^"]+)":/g)].map((m) => m[1]);
    expect(keys.length, "retired paths").toBeGreaterThan(2);
    expect(keys).not.toContain("/settings/pipelines");
    expect(keys).not.toContain("/settings/linkedin-limits");
    expect(keys).not.toContain("/settings");
    // And the shim itself must stay an exact-path route, or it would match them.
    expect(app).toContain('<Route path="/settings"><AuthGate><Settings /></AuthGate></Route>');
  });
});
