/**
 * Import Contacts → Data Enrichment fold (owner ask 2026-08-21, "same
 * integration protocol" as the Find Prospects fold). Both failure directions
 * of a fold are asserted (dead-wiring class): the new home renders the
 * surface and honors the retired route's params, and no nav surface still
 * points at a page that no longer stands alone. The fold REPLACES the old
 * "CSV" tab — a mock upsell whose only CTAs navigated to /import anyway.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  DATA_ENRICHMENT_TABS, tabFromSlug, tabRedirectUrl, tabSlug,
} from "../client/src/pages/usip/dataEnrichmentTabs";

describe("the tab vocabulary after the second fold", () => {
  it("Import contacts is a tab, the mock CSV tab is gone, and every tab still round-trips", () => {
    expect(DATA_ENRICHMENT_TABS).toContain("Import contacts");
    expect(DATA_ENRICHMENT_TABS).not.toContain("CSV");
    for (const t of DATA_ENRICHMENT_TABS) expect(tabFromSlug(tabSlug(t))).toBe(t);
  });
  it("the redirect carries old query params through", () => {
    expect(tabRedirectUrl("Import contacts", "")).toBe("/v2/data-enrichment?tab=import-contacts");
    expect(tabRedirectUrl("Import contacts", "?foo=1")).toBe("/v2/data-enrichment?foo=1&tab=import-contacts");
  });
});

describe("wiring — both directions", () => {
  const page = readFileSync("client/src/pages/usip/DataEnrichment.tsx", "utf8");
  const importer = readFileSync("client/src/pages/usip/ImportContacts.tsx", "utf8");
  const app = readFileSync("client/src/App.tsx", "utf8");
  const shell = readFileSync("client/src/components/usip/Shell.tsx", "utf8");
  const registry = readFileSync("client/src/lib/toolRegistry.ts", "utf8");
  const help = readFileSync("client/src/lib/helpText.ts", "utf8");

  it("Data Enrichment renders the wizard on its tab; the CSV mock (fake table, invented accuracy claim) is gone", () => {
    expect(page).toContain('{tab === "Import contacts" && <ImportContactsPanel />}');
    expect(page).not.toContain("97% email accuracy");
    expect(page).not.toContain('tab === "CSV"');
  });

  it("/import still routes — to a param-preserving redirect, not a 404", () => {
    expect(app).toContain('path="/import"');
    expect(importer).toContain("export default function ImportContactsRedirect");
    expect(importer).toContain('tabRedirectUrl("Import contacts", window.location.search)');
    expect(importer).toContain("export function ImportContactsPanel");
  });

  it("no sidebar item points at the retired page; the registry tool points at the tab, NOT primary", () => {
    expect(shell).not.toContain('href: "/import"');
    const entry = registry.slice(registry.indexOf('label: "Import Contacts"') - 400, registry.indexOf('label: "Import Contacts"') + 200);
    expect(entry).toContain('href: "/v2/data-enrichment?tab=import-contacts"');
    expect(entry).not.toContain("primary: true");
  });

  it("hover help is re-keyed to the registry href (navHelpFor matches exactly)", () => {
    expect(help).toContain('"/v2/data-enrichment?tab=import-contacts"');
    expect(help).not.toContain('"/import":');
  });

  it("every referring link spells the canonical tab URL instead of riding the redirect", () => {
    for (const f of [
      "client/src/pages/usip/Companies.tsx",
      "client/src/pages/usip/ListDetail.tsx",
      "client/src/pages/usip/People.tsx",
      "client/src/pages/usip/SettingsHub.tsx",
    ]) {
      const src = readFileSync(f, "utf8");
      expect(src, f).not.toContain('"/import"');
    }
  });
});
