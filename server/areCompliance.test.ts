/**
 * Bulk-sender compliance for ARE campaign mail (audit 2026-09-20).
 *
 * Cold campaign mail is the one path that sends daily and autonomously, and
 * it shipped with none of the machinery the draft path has had for months:
 * no unsubscribe route, no sitewide suppression check, and bounces that
 * resolved to workspace 0 and suppressed nothing. These pins hold the three
 * seams closed.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const engine = readFileSync("server/areEngine.ts", "utf8");
const delivery = readFileSync("server/emailDelivery.ts", "utf8");
const tracking = readFileSync("server/emailTracking.ts", "utf8");

describe("ARE campaign mail is compliant bulk mail", () => {
  it("dispatch checks the SITE-WIDE suppression list, not only its own ARE list", () => {
    // Unsubscribes, bounces and spam complaints from every other send path
    // land in email_suppressions; the dispatcher must read it too.
    expect(engine).toContain("isSuppressedSitewide(wsId, p.email)");
    expect(engine).toContain('"On suppression list (workspace)"');
  });

  it("every campaign send carries the RFC 8058 one-click headers", () => {
    const call = engine.slice(engine.indexOf("sendCampaignEmailViaPool(wsId"));
    expect(call.slice(0, 1400)).toContain("headers: unsubHeaders");
    expect(engine).toContain("unsubscribeHeaders(appBaseUrl, wsId, p.email)");
  });

  it("the workspace's opt-out footer reaches campaign mail when enabled", () => {
    expect(engine).toContain("renderSequenceOptOut(optOutMessage");
    expect(engine).toContain("emailSequenceOptOutEnabled");
  });

  it("the pool AND its SMTP fallback forward the headers to the wire", () => {
    // SendEmailOptions.headers → adapter (pool) and nodemailer (fallback).
    expect(delivery).toContain("headers?: Record<string, string>");
    const occurrences = delivery.split("headers: opts.headers").length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(2);
  });

  it("a bounce for campaign mail resolves its workspace through email_log", () => {
    // Campaign sends write no draft row; without the log fallback the
    // suppression insert was skipped (workspaceId 0) and the dead address
    // kept being mailed.
    const fn = tracking.slice(tracking.indexOf("export async function processBounceEvent"));
    expect(fn).toContain("emailLog.toEmail, event.email");
    expect(fn).toContain("?? logWorkspaceId ?? 0");
  });
});
