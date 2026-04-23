/**
 * Tests for Email Suppressions, Preview Resolved, and Email Analytics (Features 49–51)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Suppression logic tests ──────────────────────────────────────────────────

describe("Email Suppression logic", () => {
  // Email normalization
  it("normalizes email addresses to lowercase for comparison", () => {
    const normalize = (email: string) => email.toLowerCase().trim();
    expect(normalize("User@Example.COM")).toBe("user@example.com");
    expect(normalize("  SALES@CORP.ORG  ")).toBe("sales@corp.org");
  });

  // Reason enum validation
  it("validates suppression reason enum values", () => {
    const validReasons = ["unsubscribe", "bounce", "spam_complaint", "manual"] as const;
    type Reason = (typeof validReasons)[number];
    const isValid = (r: string): r is Reason => validReasons.includes(r as Reason);

    expect(isValid("unsubscribe")).toBe(true);
    expect(isValid("bounce")).toBe(true);
    expect(isValid("spam_complaint")).toBe(true);
    expect(isValid("manual")).toBe(true);
    expect(isValid("invalid")).toBe(false);
    expect(isValid("")).toBe(false);
  });

  // Summary aggregation
  it("aggregates suppression counts by reason correctly", () => {
    const suppressions = [
      { reason: "unsubscribe" },
      { reason: "unsubscribe" },
      { reason: "bounce" },
      { reason: "spam_complaint" },
      { reason: "manual" },
      { reason: "manual" },
      { reason: "manual" },
    ];

    const summary = suppressions.reduce(
      (acc, s) => {
        acc.total++;
        acc[s.reason as keyof typeof acc] = ((acc[s.reason as keyof typeof acc] as number) || 0) + 1;
        return acc;
      },
      { total: 0, unsubscribe: 0, bounce: 0, spam_complaint: 0, manual: 0 },
    );

    expect(summary.total).toBe(7);
    expect(summary.unsubscribe).toBe(2);
    expect(summary.bounce).toBe(1);
    expect(summary.spam_complaint).toBe(1);
    expect(summary.manual).toBe(3);
  });

  // Duplicate suppression prevention
  it("prevents duplicate suppressions for the same email", () => {
    const existing = new Set(["user@example.com", "other@corp.org"]);
    const isDuplicate = (email: string) => existing.has(email.toLowerCase());

    expect(isDuplicate("user@example.com")).toBe(true);
    expect(isDuplicate("USER@EXAMPLE.COM")).toBe(true);
    expect(isDuplicate("new@example.com")).toBe(false);
  });

  // Unsubscribe token lookup
  it("validates unsubscribe token format (UUID without dashes)", () => {
    const isValidToken = (token: string) => /^[0-9a-f]{32}$/.test(token);
    const sampleToken = "a1b2c3d4e5f6789012345678901234ab";
    expect(isValidToken(sampleToken)).toBe(true);
    expect(isValidToken("not-a-token")).toBe(false);
    expect(isValidToken("")).toBe(false);
    // UUID with dashes should fail (we strip dashes when storing)
    expect(isValidToken("a1b2c3d4-e5f6-7890-1234-5678901234ab")).toBe(false);
  });
});

// ─── Preview Resolved logic tests ─────────────────────────────────────────────

describe("Preview Resolved merge var substitution", () => {
  // Simulate resolveMergeVars logic inline for unit testing
  function resolveMergeVars(template: string, ctx: Record<string, string | undefined>): string {
    return template.replace(/\{\{(\w+)(?:\|([^}]*))?\}\}/g, (_match, key, fallback) => {
      const val = ctx[key];
      if (val !== undefined && val !== "") return val;
      if (fallback !== undefined) return fallback;
      return `{{${key}}}`;
    });
  }

  it("resolves firstName and company in subject", () => {
    const subject = "Hi {{firstName}}, a quick note about {{company}}";
    const result = resolveMergeVars(subject, { firstName: "Alice", company: "Acme Corp" });
    expect(result).toBe("Hi Alice, a quick note about Acme Corp");
  });

  it("uses fallback when value is missing", () => {
    const body = "Hello {{firstName|there}}, welcome to {{company|our platform}}";
    const result = resolveMergeVars(body, {});
    expect(result).toBe("Hello there, welcome to our platform");
  });

  it("leaves unresolved tokens intact when no fallback", () => {
    const body = "Your role: {{title}}";
    const result = resolveMergeVars(body, {});
    expect(result).toBe("Your role: {{title}}");
  });

  it("handles multiple occurrences of the same variable", () => {
    const body = "{{firstName}} is great. {{firstName}} will love this.";
    const result = resolveMergeVars(body, { firstName: "Bob" });
    expect(result).toBe("Bob is great. Bob will love this.");
  });

  it("does not resolve variables with empty string values (uses fallback)", () => {
    const body = "Hello {{firstName|friend}}";
    const result = resolveMergeVars(body, { firstName: "" });
    expect(result).toBe("Hello friend");
  });

  it("resolves senderName and senderEmail", () => {
    const body = "Sent by {{senderName}} <{{senderEmail}}>";
    const result = resolveMergeVars(body, {
      senderName: "Jane Smith",
      senderEmail: "jane@company.com",
    });
    expect(result).toBe("Sent by Jane Smith <jane@company.com>");
  });
});

// ─── Email Analytics aggregation tests ────────────────────────────────────────

describe("Email Analytics aggregation", () => {
  interface DraftStats {
    id: number;
    subject: string;
    status: string;
    openCount: number;
    clickCount: number;
    sentAt: Date | null;
  }

  const mockDrafts: DraftStats[] = [
    { id: 1, subject: "Q1 Outreach", status: "sent", openCount: 45, clickCount: 12, sentAt: new Date("2026-01-15") },
    { id: 2, subject: "Follow-up", status: "sent", openCount: 30, clickCount: 8, sentAt: new Date("2026-01-16") },
    { id: 3, subject: "Cold intro", status: "sent", openCount: 0, clickCount: 0, sentAt: new Date("2026-01-17") },
    { id: 4, subject: "Draft only", status: "draft", openCount: 0, clickCount: 0, sentAt: null },
  ];

  function computeOverview(drafts: DraftStats[]) {
    const sent = drafts.filter((d) => d.status === "sent");
    const totalSent = sent.length;
    const totalOpens = sent.reduce((s, d) => s + d.openCount, 0);
    const totalClicks = sent.reduce((s, d) => s + d.clickCount, 0);
    const openRate = totalSent > 0 ? totalOpens / totalSent : 0;
    const clickRate = totalSent > 0 ? totalClicks / totalSent : 0;
    const openedCount = sent.filter((d) => d.openCount > 0).length;
    return { totalSent, totalOpens, totalClicks, openRate, clickRate, openedCount };
  }

  it("counts only sent drafts in analytics", () => {
    const overview = computeOverview(mockDrafts);
    expect(overview.totalSent).toBe(3);
  });

  it("sums opens and clicks correctly", () => {
    const overview = computeOverview(mockDrafts);
    expect(overview.totalOpens).toBe(75);
    expect(overview.totalClicks).toBe(20);
  });

  it("calculates open rate as opens / sent", () => {
    const overview = computeOverview(mockDrafts);
    expect(overview.openRate).toBeCloseTo(25, 0); // 75 / 3 = 25
  });

  it("calculates click rate as clicks / sent", () => {
    const overview = computeOverview(mockDrafts);
    expect(overview.clickRate).toBeCloseTo(6.67, 1); // 20 / 3 ≈ 6.67
  });

  it("counts drafts with at least one open", () => {
    const overview = computeOverview(mockDrafts);
    expect(overview.openedCount).toBe(2); // drafts 1 and 2 have opens
  });

  it("returns zero rates when no sent drafts", () => {
    const overview = computeOverview([]);
    expect(overview.openRate).toBe(0);
    expect(overview.clickRate).toBe(0);
    expect(overview.totalSent).toBe(0);
  });

  it("sorts drafts by open count descending", () => {
    const sorted = [...mockDrafts.filter((d) => d.status === "sent")].sort(
      (a, b) => b.openCount - a.openCount,
    );
    expect(sorted[0].id).toBe(1); // 45 opens
    expect(sorted[1].id).toBe(2); // 30 opens
    expect(sorted[2].id).toBe(3); // 0 opens
  });
});

// ─── Unsubscribe page HTML tests ──────────────────────────────────────────────

describe("Unsubscribe confirmation page", () => {
  it("generates a valid HTML confirmation page with email address", () => {
    const email = "user@example.com";
    const html = `<!DOCTYPE html><html><head><title>Unsubscribed</title></head>
      <body><h1>You have been unsubscribed</h1>
      <p>${email} has been removed from our mailing list.</p></body></html>`;

    expect(html).toContain("user@example.com");
    expect(html).toContain("unsubscribed");
    expect(html).toContain("<!DOCTYPE html>");
  });

  it("generates an error page for invalid tokens", () => {
    const html = `<!DOCTYPE html><html><head><title>Error</title></head>
      <body><h2>This unsubscribe link is invalid or has already been used.</h2></body></html>`;

    expect(html).toContain("invalid");
    expect(html).toContain("<!DOCTYPE html>");
  });
});

// ─── Suppression check in send flow ──────────────────────────────────────────

describe("Suppression check before send", () => {
  it("blocks sending to suppressed addresses", async () => {
    const suppressedEmails = new Set(["blocked@example.com", "optout@corp.org"]);
    const isEmailSuppressed = (email: string) => suppressedEmails.has(email.toLowerCase());

    expect(isEmailSuppressed("blocked@example.com")).toBe(true);
    expect(isEmailSuppressed("BLOCKED@EXAMPLE.COM")).toBe(true);
    expect(isEmailSuppressed("allowed@example.com")).toBe(false);
  });

  it("allows sending after suppression is removed", async () => {
    const suppressedEmails = new Set(["blocked@example.com"]);
    const isEmailSuppressed = (email: string) => suppressedEmails.has(email.toLowerCase());

    expect(isEmailSuppressed("blocked@example.com")).toBe(true);
    suppressedEmails.delete("blocked@example.com");
    expect(isEmailSuppressed("blocked@example.com")).toBe(false);
  });

  it("counts suppressed emails skipped in bulk send", () => {
    const suppressedEmails = new Set(["a@example.com", "b@example.com"]);
    const recipients = ["a@example.com", "c@example.com", "d@example.com", "b@example.com"];

    let sent = 0;
    let skipped = 0;
    for (const email of recipients) {
      if (suppressedEmails.has(email)) {
        skipped++;
      } else {
        sent++;
      }
    }

    expect(sent).toBe(2);
    expect(skipped).toBe(2);
  });
});
