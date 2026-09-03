/**
 * Phase 4 of the seams audit (owner: "Start phase 4", 2026-09-02): fewer
 * surfaces, same information. A fold has two failure directions (the
 * dead-wiring class): the new home renders the surface but old links 404 or
 * drop their params, or the links work but some nav surface still points at
 * a page that no longer exists. Both directions are pinned, following the
 * Find Prospects → Data Enrichment precedent (findProspectsFold.test.ts).
 */
import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { TOOLS, PRIMARY_TOOLS } from "../client/src/lib/toolRegistry";
import { savedRedirectUrl } from "../client/src/pages/usip/SavedRedirect";

const read = (...p: string[]) => readFileSync(join(__dirname, ...p), "utf8");
const client = (...p: string[]) => read("..", "client", "src", ...p);
const hrefOf = (label: string) => TOOLS.find((t) => t.label === label)?.href;

describe("folded pages point INTO their absorbing page (registry direction)", () => {
  it("Email Drafts and AI Pipeline are filters of Emails", () => {
    // The feed's own filter vocabulary: "awaiting" = pending_review / ai_pending_review / approved,
    // and source narrows to sequence drafts vs AI-written drafts.
    expect(hrefOf("Email Drafts")).toBe("/v2/emails?status=awaiting&source=sequence");
    expect(hrefOf("AI Pipeline")).toBe("/v2/emails?status=awaiting&source=ai_draft");
  });
  it("Data Health is a tab of Data Enrichment; Saved People/Companies are Lists by type; Pipeline Alerts is the Deals strip", () => {
    expect(hrefOf("Data Health")).toBe("/v2/data-enrichment?tab=data-health-center");
    expect(hrefOf("Saved People")).toBe("/v2/lists?type=people");
    expect(hrefOf("Saved Companies")).toBe("/v2/lists?type=companies");
    expect(hrefOf("Pipeline Alerts")).toBe("/v2/deals#alerts");
  });
  it("consumer-less libraries left the registry; the live Segment Rules page joined it", () => {
    expect(hrefOf("Email Builder")).toBeUndefined();
    expect(hrefOf("Snippets")).toBeUndefined();
    expect(hrefOf("Segment Rules")).toBe("/segment-rules");
  });
  it("Email Sending names the four-page cluster; none of the folded entries is on the rail", () => {
    expect(hrefOf("Email Sending")).toBe("/sending-accounts");
    const rail = new Set(PRIMARY_TOOLS.map((t) => t.href));
    for (const h of ["/email-drafts", "/ai-pipeline", "/data-health", "/pipeline-alerts", "/v2/saved-people", "/v2/saved-companies", "/sender-pools", "/v2/deliverability", "/email-suppressions"]) {
      expect(rail.has(h), h).toBe(false);
    }
  });
});

describe("old links survive the move (URL direction)", () => {
  it("saved-* redirect into Lists with the type preserved", () => {
    expect(savedRedirectUrl("people")).toBe("/v2/lists?type=people");
    expect(savedRedirectUrl("companies")).toBe("/v2/lists?type=companies");
    const app = client("App.tsx");
    expect(app).toContain('<Route path="/v2/saved-people"><AuthGate><SavedRedirect entityType="people" /></AuthGate></Route>');
    expect(app).toContain('<Route path="/v2/saved-companies"><AuthGate><SavedRedirect entityType="companies" /></AuthGate></Route>');
    expect(existsSync(join(__dirname, "..", "client", "src", "pages", "usip", "SavedRecordsV2.tsx"))).toBe(false);
  });
  it("Lists honours ?type=, Emails honours ?status=/?source=/?direction=, Deals carries the #alerts anchor", () => {
    expect(client("pages", "usip", "Lists.tsx")).toContain('new URLSearchParams(useSearch()).get("type")');
    const emails = client("pages", "usip", "EmailsV2.tsx");
    expect(emails).toContain('useState(initial.get("status") || "all")');
    expect(emails).toContain('useState(initial.get("source") || "all")');
    expect(client("pages", "usip", "DealsV2.tsx")).toContain('<div id="alerts"');
  });
  it("the retained editor pages stay routed and reachable from the Emails drawer", () => {
    const app = client("App.tsx");
    for (const r of ['path="/email-drafts"', 'path="/ai-pipeline"', 'path="/data-health"', 'path="/pipeline-alerts"', 'path="/segment-rules"']) expect(app).toContain(r);
    expect(client("pages", "usip", "EmailsV2.tsx")).toContain('href={row.status === "ai_pending_review" ? "/ai-pipeline" : "/email-drafts"}');
  });
});

describe("clusters link to themselves", () => {
  it("Sending Accounts' SubNav reaches all four email-sending pages", () => {
    const sa = client("pages", "usip", "SendingAccounts.tsx");
    for (const h of ['"/sender-pools"', '"/v2/deliverability"', '"/email-suppressions"']) expect(sa).toContain(h);
  });
  it("Lead Routing's SubNav reaches Lead Scoring", () => {
    expect(client("pages", "usip", "LeadRouting.tsx")).toContain('{ href: "/lead-scoring", label: "Lead Scoring"');
  });
});
