/**
 * The AI Account Brief on the company page, and the deal page's editors
 * (audit 2026-10-20, F35).
 *
 *   - the brief is on the company profile (moved there by batch Rc, R47) and
 *     generating it now says what it spends — one AI call, about how many
 *     tokens, and the month's AI use — and asks first, for Generate and for
 *     Regenerate alike;
 *   - the deal page's line-item and contact-role editors exist (batch Ra,
 *     R35; their behaviour is pinned in server/dealsFixes.test.ts) and call
 *     the server procedures.
 */
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("@/lib/trpc", () => {
  const noop: any = new Proxy(() => undefined, { get: () => noop, apply: () => undefined });
  return { trpc: noop };
});

import { ACCOUNT_BRIEF_TOKEN_ESTIMATE, accountBriefCostText } from "../client/src/components/usip/company/AccountBriefPanel";

const root = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8").replace(/\r\n/g, "\n");

describe("F35: the AI Account Brief says what it costs and asks first", () => {
  it("the confirmation names one AI call, the tokens a brief uses and the month's AI use", () => {
    const t = accountBriefCostText({ used: 120_000, cap: 2_000_000 });
    expect(t).toContain("This makes 1 AI call to write a 300-word brief");
    expect(t).toContain(`about ${ACCOUNT_BRIEF_TOKEN_ESTIMATE.toLocaleString("en-US")} tokens`);
    expect(t).toContain("This month: 120,000 of 2,000,000 tokens used.");
    expect(accountBriefCostText(null)).toContain("billed to this workspace's AI provider");
  });

  it("Generate and Regenerate go through the confirmation; nothing streams on the click alone", () => {
    const panel = read("client/src/components/usip/company/AccountBriefPanel.tsx");
    expect(panel).toContain("<Button size=\"sm\" onClick={() => askGenerate(!!brief)} disabled={streaming}>");
    expect(panel).not.toContain("onClick={handleGenerate}");
    const ask = panel.slice(panel.indexOf("const askGenerate = "), panel.indexOf("const handleStop = "));
    expect(ask).toContain("confirmAction({");
    expect(ask).toContain("description: `${accountBriefCostText(budgets.data?.ai)}");
    expect(ask).toContain("() => { void handleGenerate(); }");
  });

  it("the brief is on the company profile", () => {
    const profile = read("client/src/pages/usip/CompanyProfile.tsx");
    expect(profile).toContain("<AccountBriefPanel accountId={id} />");
  });
});

describe("F35: the deal page edits line items and contact roles", () => {
  it("both editors are on the deal page's Related tab and call the server procedures", () => {
    const page = read("client/src/pages/usip/OpportunityDetail.tsx");
    expect(page).toContain("<DealContactRoles opportunityId={o.id}");
    expect(page).toContain("<DealLineItems opportunityId={o.id}");
    for (const p of ["opportunities.addLineItem.useMutation(", "opportunities.removeLineItem.useMutation(", "opportunities.addRole.useMutation(", "opportunities.removeRole.useMutation("]) {
      expect(page).toContain(p);
    }
  });
});
