/**
 * Phase 5 of the seams audit (owner: "Start phase 5", 2026-09-02): one design
 * language on the detail pages. Every v2 list opened a legacy-shell detail
 * page — banner header, card grid — so the look flipped on nearly every
 * click (audit cause 5). DetailShell is the one definition of a v2 detail
 * page; the pages below use it, and the duplicate/dead pages are gone.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { accountRedirectUrl } from "../client/src/pages/usip/AccountRedirect";

const client = (...p: string[]) => readFileSync(join(__dirname, "..", "client", "src", ...p), "utf8");
const gone = (...p: string[]) => !existsSync(join(__dirname, "..", "client", "src", ...p));

describe("the detail pages speak the v2 vocabulary", () => {
  const shell = client("components", "usip", "DetailShell.tsx");
  it("DetailShell is the one definition: header with accent rule + back link, titled sections, body", () => {
    for (const e of ["export function DetailHeader", "export function DetailSection", "export function DetailBody", "export function DetailFact"]) expect(shell).toContain(e);
    expect(shell).toContain('className="absolute inset-x-0 top-0 h-0.5"');
    expect(shell).toContain("text-xs font-semibold uppercase tracking-wide text-muted-foreground");
  });
  for (const [label, file, back] of [
    ["Lead", "LeadDetail.tsx", '{ href: "/leads", label: "Leads" }'],
    ["Opportunity", "OpportunityDetail.tsx", '{ href: "/v2/deals", label: "Deals" }'],
    ["Prospect", "ProspectDetail.tsx", '{ href: "/v2/people", label: "People" }'],
  ] as const) {
    it(`${label} detail uses DetailHeader/DetailSection and no legacy banner or card grid`, () => {
      const src = client("pages", "usip", file);
      expect(src).toContain('from "@/components/usip/DetailShell"');
      expect(src).toContain("<DetailHeader");
      expect(src).toContain("<DetailSection");
      expect(src).toContain(`back={${back}}`);
      expect(src).not.toContain("<PageHeader");
      expect(src).not.toContain("<Card>");
      expect(src).not.toContain("<CardContent");
    });
  }
});

describe("one company page", () => {
  it("/accounts and /accounts/:id redirect into Companies with the id preserved", () => {
    expect(accountRedirectUrl("42")).toBe("/v2/companies/42");
    expect(accountRedirectUrl(undefined)).toBe("/v2/companies");
    expect(accountRedirectUrl("nope")).toBe("/v2/companies");
    const app = client("App.tsx");
    expect(app).toContain('<Route path="/accounts"><AuthGate><AccountRedirect /></AuthGate></Route>');
    expect(app).toContain('<Route path="/accounts/:id"><AuthGate><AccountRedirect /></AuthGate></Route>');
    expect(app).not.toContain("<AccountDetail");
    expect(app).not.toContain("import AccountDetail");
    expect(app).not.toContain('import Accounts from');
  });
  it("CompanyProfile absorbed AccountDetail's panels: deals, custom fields, tasks, activity/notes/files", () => {
    const src = client("pages", "usip", "CompanyProfile.tsx");
    for (const e of ["Deals ({opps.length})", '<CustomFieldsPanel entityType="account"', '<RelatedTasks entityType="account"', '<EntityDetailTabs entityType="account"']) expect(src).toContain(e);
  });
  it("the retired pages and the dead button are gone", () => {
    expect(gone("pages", "usip", "AccountDetail.tsx")).toBe(true);
    expect(gone("pages", "usip", "Accounts.tsx")).toBe(true);
    expect(gone("pages", "usip", "ContactDetail.tsx")).toBe(true);
    expect(gone("components", "usip", "AddToSequenceButton.tsx")).toBe(true);
  });
});
