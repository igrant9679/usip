/**
 * Find Prospects → Data Enrichment fold (owner ask 2026-08-21).
 *
 * A fold has two failure directions (the dead-wiring class): the new home
 * renders the surface but old links 404 or drop their params, or the links
 * work but some nav surface still points at a page that no longer exists.
 * Both directions are asserted here; the slug/URL rules are pure
 * (dataEnrichmentTabs.ts, dependency-free) so the redirect contract is
 * testable without a DOM.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  DATA_ENRICHMENT_TABS, DEFAULT_TAB, foldRedirectUrl, tabFromSlug, tabSlug,
} from "../client/src/pages/usip/dataEnrichmentTabs";

describe("tab slugs — the URL vocabulary", () => {
  it("every tab round-trips through its slug", () => {
    for (const t of DATA_ENRICHMENT_TABS) expect(tabFromSlug(tabSlug(t))).toBe(t);
  });
  it("unknown or absent slugs land on the default tab, never a blank page", () => {
    expect(tabFromSlug(null)).toBe(DEFAULT_TAB);
    expect(tabFromSlug("nonsense")).toBe(DEFAULT_TAB);
  });
  it("the folded tab's slug is what every referring link spells", () => {
    expect(tabSlug("Find prospects")).toBe("find-prospects");
  });
});

describe("foldRedirectUrl — old deep links survive the move", () => {
  it("carries runId through (ProspectDetail's Run #N link)", () => {
    expect(foldRedirectUrl("?runId=42")).toBe("/v2/data-enrichment?runId=42&tab=find-prospects");
  });
  it("carries q through (People's typed discovery query)", () => {
    const url = foldRedirectUrl("?q=healthcare%20CFOs");
    expect(url).toContain("tab=find-prospects");
    expect(url).toContain("q=healthcare");
  });
  it("bare visits get just the tab", () => {
    expect(foldRedirectUrl("")).toBe("/v2/data-enrichment?tab=find-prospects");
  });
});

describe("wiring — both directions of the fold", () => {
  const page = readFileSync("client/src/pages/usip/DataEnrichment.tsx", "utf8");
  const finder = readFileSync("client/src/pages/usip/FindProspects.tsx", "utf8");
  const app = readFileSync("client/src/App.tsx", "utf8");
  const shell = readFileSync("client/src/components/usip/Shell.tsx", "utf8");
  const registry = readFileSync("client/src/lib/toolRegistry.ts", "utf8");

  it("Data Enrichment renders the panel on its tab, and the tab comes from and writes back to the URL", () => {
    expect(page).toContain('{tab === "Find prospects" && <FindProspectsPanel />}');
    expect(page).toContain("tabFromSlug(new URLSearchParams(window.location.search).get(\"tab\"))");
    expect(page).toContain("window.history.replaceState");
  });

  it("/find-prospects still routes — to a param-preserving redirect, not a 404", () => {
    expect(app).toContain('path="/find-prospects"');
    expect(finder).toContain("export default function FindProspectsRedirect");
    expect(finder).toContain("foldRedirectUrl(window.location.search)");
  });

  it("the panel is exported and the run history consumes discovery.listRuns (which had NO consumer)", () => {
    expect(finder).toContain("export function FindProspectsPanel");
    expect(finder).toContain("trpc.discovery.listRuns.useQuery");
  });

  it("no sidebar item points at the retired page; the registry tool points at the tab", () => {
    expect(shell).not.toContain('href: "/find-prospects"');
    expect(registry).toContain('href: "/v2/data-enrichment?tab=find-prospects"');
  });

  it("every referring link spells the canonical tab URL instead of riding the redirect", () => {
    const people = readFileSync("client/src/pages/usip/People.tsx", "utf8");
    const detail = readFileSync("client/src/pages/usip/ProspectDetail.tsx", "utf8");
    const social = readFileSync("client/src/components/usip/settings/SocialAccountsSection.tsx", "utf8");
    expect(people).toContain("/v2/data-enrichment?tab=find-prospects");
    expect(people).not.toContain('"/find-prospects"');
    expect(detail).toContain("/v2/data-enrichment?tab=find-prospects&runId=");
    expect(social).toContain("/v2/data-enrichment?tab=find-prospects");
  });

  it("a failed metrics load says so with a retry, instead of rendering error-zeros", () => {
    expect(page).toContain("metricsError");
    expect(page).toContain("Data health metrics failed to load");
    expect(page).toContain("refetchMetrics()");
  });
});
