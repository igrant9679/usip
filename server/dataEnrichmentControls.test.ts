/**
 * Data enrichment's controls do something, or say they can't (audit
 * 2026-10-20: P89, P154, P160).
 *
 *   P89  no hard-coded "0 scheduled jobs", no builder that saves nothing behind
 *        "Schedule enrichment job", no cards whose buttons open Data Health,
 *        and no Salesforce / HubSpot sync that doesn't exist.
 *   P154 a failed read of the job-change setting is shown as unread, not as
 *        Off, and its buttons can't overwrite what was never read.
 *   P160 only admins may change that setting, as the server already insists;
 *        the credit card no longer names Apollo.
 *
 * Pinned by reading the page, as the other Data enrichment guards do.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8").replace(/\r\n/g, "\n");
const page = read("client/src/pages/usip/DataEnrichment.tsx");
const code = page.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("P89: placeholder controls", () => {
  it("no scheduled-jobs count that is always 0", () => {
    expect(code).not.toContain("View scheduled jobs");
    expect(code).not.toMatch(/<span className="text-muted-foreground">0<\/span>/);
  });

  it("scheduling goes to the enrichment sweep, the schedule that exists", () => {
    expect(code).toContain('const SWEEP_SETTINGS = "/v2/settings/enrichment-sweep";');
    expect(code).toContain("Schedule the enrichment sweep");
    expect(code).not.toContain("<EnrichmentJobDrawer");
    const fresh = code.slice(code.indexOf('<Card title="Enrichment freshness"'), code.indexOf("</Card>", code.indexOf('<Card title="Enrichment freshness"')));
    expect(fresh).toContain("setLocation(SWEEP_SETTINGS)");
  });

  it("Data Health is opened only by the card that is about Data Health", () => {
    const opens = code.split('setLocation("/data-health")').length - 1;
    expect(opens).toBe(1);
    const dup = code.slice(code.indexOf('<Card title="Duplicates"'), code.indexOf("</Card>", code.indexOf('<Card title="Duplicates"')));
    expect(dup).toContain('setLocation("/data-health")}>Review duplicates');
  });

  it("no cards with a fixed empty state or a CRM sync that doesn't exist", () => {
    for (const gone of ["Create scheduled enrichment", "No enrichment activities yet", "Check your CRM data status", "Connect Salesforce", "Connect HubSpot", "Key benefits"]) {
      expect(code, gone).not.toContain(gone);
    }
    expect(code).toContain("Syncing with an outside CRM such as Salesforce or HubSpot isn't available.");
  });
});

describe("P154 and P160: the job-change autopilot setting", () => {
  const block = code.slice(code.indexOf("Auto re-engage on job changes"), code.indexOf("{jobChangesQ.isLoading ? ("));

  it("a failed read shows an error, not Off", () => {
    expect(block).toContain("{jcSettings.error && !jcSettings.data ? (");
    expect(block).toContain('<QueryError compact what="this setting"');
  });

  it("the buttons are an admin's, and wait for the setting to load", () => {
    expect(code).toContain("const canSetJc = isAdminRole(me.data?.role);");
    expect(block).toContain("disabled={setJc.isPending || jcSettings.isLoading || !canSetJc}");
    expect(block).toContain("Only admins can change this.");
  });

  it("the credit card no longer names Apollo", () => {
    expect(code).not.toContain("API & Apollo data");
  });
});
