/**
 * The Home dashboard must not lie at rest (owner screenshot 2026-08-26:
 * "0 emails sent" on a day campaigns delivered, "No prospects yet." against
 * 1,190 People).
 *
 * Two distinct classes, both pinned:
 *  1. digest24h.emailsSent counted emailDrafts — a table only the inbox
 *     AI-draft flow writes — instead of the sitewide send log (email_log).
 *  2. Home requested perPage: 8 from prospects.list, whose zod floor is 10;
 *     the validation error was swallowed by `?? []` and rendered as an
 *     honest-looking empty state.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const attention = readFileSync(join(__dirname, "routers", "attention.ts"), "utf8");
const home = readFileSync(join(__dirname, "..", "client", "src", "pages", "usip", "Home.tsx"), "utf8");
const prospectsRouter = readFileSync(join(__dirname, "routers", "prospects.ts"), "utf8");

describe("digest24h reads the sitewide send log", () => {
  it("emailsSent counts email_log 'sent' rows in the window", () => {
    expect(attention).toContain("from(emailLog)");
    expect(attention).toMatch(/eq\(emailLog\.status, "sent"\), gte\(emailLog\.sentAt, since\)/);
  });

  it("no digest count reads emailDrafts' sent rows (the flow campaigns never touch)", () => {
    expect(attention).not.toMatch(/emailDrafts\.status, "sent"/);
  });
});

describe("dashboards read the send log the ARE campaigns write (owner report 2026-08-26)", () => {
  const analytics = readFileSync(join(__dirname, "..", "client", "src", "pages", "usip", "AnalyticsV2.tsx"), "utf8");
  const reports = readFileSync(join(__dirname, "routers", "reports.ts"), "utf8");

  it("Analytics outreach reads emailActivity.stats, not sequences-only sums", () => {
    expect(analytics).toContain("trpc.emailActivity.stats.useQuery");
    // The old shape: outreach.sent summed getPerformanceAnalytics rows.
    expect(analytics).not.toMatch(/const sent = rows\.reduce/);
  });

  it("the report builder exposes the emails object over email_log", () => {
    expect(reports).toContain("emails: {");
    expect(reports).toContain("table: emailLog");
    expect(reports).toContain('"activities", "emails"');
    // Presets make the new object discoverable rather than a hidden dropdown.
    expect(reports).toContain('"emails-by-source"');
  });
});

describe("Home's prospects query clears the server's validation floor", () => {
  it("perPage in Home.tsx >= the zod minimum in prospects.list", () => {
    const homeMatch = /trpc\.prospects\.list\.useQuery\(\{ page: 1, perPage: (\d+) \}/.exec(home);
    expect(homeMatch, "Home's prospects.list call shape moved — re-anchor").toBeTruthy();
    const floorMatch = /perPage: z\.number\(\)\.int\(\)\.min\((\d+)\)/.exec(prospectsRouter);
    expect(floorMatch, "prospects.list perPage zod floor moved — re-anchor").toBeTruthy();
    expect(Number(homeMatch![1])).toBeGreaterThanOrEqual(Number(floorMatch![1]));
  });
});
