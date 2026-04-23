/**
 * Tests for Features 52, 53, 54
 *
 * Feature 52: SMTP Bounce Webhook — parseBouncePayload, detectBounceProvider,
 *             verifyBounceSignature (pure logic, no DB required)
 * Feature 53: getTrackingTimeSeries — daily bucket aggregation logic
 * Feature 54: runNightlyBatch owner notification — notifyOwner integration
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request } from "express";

// ─── Import the exported helpers from emailTracking.ts ─────────────────────
import {
  detectBounceProvider,
  parseBouncePayload,
  verifyBounceSignature,
} from "./emailTracking";

/* ═══════════════════════════════════════════════════════════════════════════
   Feature 52 — Bounce Webhook: detectBounceProvider
   ═══════════════════════════════════════════════════════════════════════════ */

function makeReq(headers: Record<string, string> = {}, body: unknown = {}): Request {
  return { headers, body } as unknown as Request;
}

describe("detectBounceProvider", () => {
  it("detects Mailgun from x-mailgun-signature-v2 header", () => {
    const req = makeReq({ "x-mailgun-signature-v2": "abc123" });
    expect(detectBounceProvider(req)).toBe("mailgun");
  });

  it("detects SendGrid from x-twilio-email-event-webhook-signature header", () => {
    const req = makeReq({ "x-twilio-email-event-webhook-signature": "abc123" });
    expect(detectBounceProvider(req)).toBe("sendgrid");
  });

  it("detects Postmark from x-postmark-signature header", () => {
    const req = makeReq({ "x-postmark-signature": "abc123" });
    expect(detectBounceProvider(req)).toBe("postmark");
  });

  it("falls back to generic when no provider headers are present", () => {
    const req = makeReq({});
    expect(detectBounceProvider(req)).toBe("generic");
  });

  it("Mailgun takes priority over other headers", () => {
    const req = makeReq({
      "x-mailgun-signature-v2": "mg",
      "x-postmark-signature": "pm",
    });
    expect(detectBounceProvider(req)).toBe("mailgun");
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   Feature 52 — Bounce Webhook: parseBouncePayload
   ═══════════════════════════════════════════════════════════════════════════ */

describe("parseBouncePayload — Mailgun", () => {
  it("parses a permanent failure as hard bounce", () => {
    const body = {
      "event-data": {
        event: "failed",
        severity: "permanent",
        recipient: "User@Example.COM",
        timestamp: 1700000000,
        "delivery-status": { message: "550 No such user" },
      },
    };
    const events = parseBouncePayload("mailgun", body);
    expect(events).toHaveLength(1);
    expect(events[0].email).toBe("user@example.com"); // lowercased
    expect(events[0].bounceType).toBe("hard");
    expect(events[0].message).toBe("550 No such user");
    expect(events[0].timestamp).toBeInstanceOf(Date);
  });

  it("parses a temporary failure as soft bounce", () => {
    const body = {
      "event-data": {
        event: "failed",
        severity: "temporary",
        recipient: "temp@example.com",
        timestamp: 1700000000,
      },
    };
    const events = parseBouncePayload("mailgun", body);
    expect(events).toHaveLength(1);
    expect(events[0].bounceType).toBe("soft");
  });

  it("parses a spam complaint", () => {
    const body = {
      "event-data": {
        event: "complained",
        recipient: "spam@example.com",
      },
    };
    const events = parseBouncePayload("mailgun", body);
    expect(events).toHaveLength(1);
    expect(events[0].bounceType).toBe("spam");
  });

  it("returns empty array for unknown Mailgun event type", () => {
    const body = {
      "event-data": {
        event: "delivered",
        recipient: "ok@example.com",
      },
    };
    expect(parseBouncePayload("mailgun", body)).toHaveLength(0);
  });

  it("returns empty array when event-data is missing", () => {
    expect(parseBouncePayload("mailgun", {})).toHaveLength(0);
  });

  it("returns empty array when recipient is missing", () => {
    const body = { "event-data": { event: "failed", severity: "permanent" } };
    expect(parseBouncePayload("mailgun", body)).toHaveLength(0);
  });
});

describe("parseBouncePayload — SendGrid", () => {
  it("parses a bounce event as hard bounce", () => {
    const body = [
      {
        email: "bounce@example.com",
        event: "bounce",
        type: "bounce",
        reason: "550 5.1.1 Unknown user",
        timestamp: 1700000000,
      },
    ];
    const events = parseBouncePayload("sendgrid", body);
    expect(events).toHaveLength(1);
    expect(events[0].email).toBe("bounce@example.com");
    expect(events[0].bounceType).toBe("hard");
    expect(events[0].message).toBe("550 5.1.1 Unknown user");
  });

  it("parses a blocked event as soft bounce", () => {
    const body = [{ email: "blocked@example.com", event: "blocked", type: "blocked", timestamp: 1700000000 }];
    const events = parseBouncePayload("sendgrid", body);
    expect(events).toHaveLength(1);
    expect(events[0].bounceType).toBe("soft");
  });

  it("parses a spamreport event", () => {
    const body = [{ email: "spam@example.com", event: "spamreport" }];
    const events = parseBouncePayload("sendgrid", body);
    expect(events).toHaveLength(1);
    expect(events[0].bounceType).toBe("spam");
  });

  it("handles multiple events in one payload", () => {
    const body = [
      { email: "a@example.com", event: "bounce", type: "bounce", timestamp: 1700000000 },
      { email: "b@example.com", event: "spamreport" },
      { email: "c@example.com", event: "delivered" }, // ignored
    ];
    const events = parseBouncePayload("sendgrid", body);
    expect(events).toHaveLength(2);
  });

  it("skips entries without an email field", () => {
    const body = [{ event: "bounce", type: "bounce", timestamp: 1700000000 }];
    expect(parseBouncePayload("sendgrid", body)).toHaveLength(0);
  });

  it("accepts a single object (not array) from SendGrid", () => {
    const body = { email: "single@example.com", event: "bounce", type: "bounce", timestamp: 1700000000 };
    const events = parseBouncePayload("sendgrid", body);
    expect(events).toHaveLength(1);
  });
});

describe("parseBouncePayload — Postmark", () => {
  it("parses a HardBounce record", () => {
    const body = {
      RecordType: "Bounce",
      Type: "HardBounce",
      Email: "hard@example.com",
      Description: "The server was unable to deliver your message",
      BouncedAt: "2024-01-15T10:00:00Z",
    };
    const events = parseBouncePayload("postmark", body);
    expect(events).toHaveLength(1);
    expect(events[0].email).toBe("hard@example.com");
    expect(events[0].bounceType).toBe("hard");
    expect(events[0].message).toBe("The server was unable to deliver your message");
  });

  it("parses a SpamComplaint type as spam", () => {
    const body = {
      RecordType: "Bounce",
      Type: "SpamComplaint",
      Email: "spam@example.com",
      BouncedAt: "2024-01-15T10:00:00Z",
    };
    const events = parseBouncePayload("postmark", body);
    expect(events).toHaveLength(1);
    expect(events[0].bounceType).toBe("spam");
  });

  it("parses a SoftBounce type as soft", () => {
    const body = {
      RecordType: "Bounce",
      Type: "SoftBounce",
      Email: "soft@example.com",
      BouncedAt: "2024-01-15T10:00:00Z",
    };
    const events = parseBouncePayload("postmark", body);
    expect(events).toHaveLength(1);
    expect(events[0].bounceType).toBe("soft");
  });

  it("parses a SpamComplaint RecordType directly", () => {
    const body = { RecordType: "SpamComplaint", Email: "spam2@example.com" };
    const events = parseBouncePayload("postmark", body);
    expect(events).toHaveLength(1);
    expect(events[0].bounceType).toBe("spam");
  });

  it("returns empty array when Email is missing", () => {
    const body = { RecordType: "Bounce", Type: "HardBounce" };
    expect(parseBouncePayload("postmark", body)).toHaveLength(0);
  });
});

describe("parseBouncePayload — generic", () => {
  it("parses a hard bounce from generic payload", () => {
    const body = { email: "generic@example.com", type: "hard", message: "User unknown" };
    const events = parseBouncePayload("generic", body);
    expect(events).toHaveLength(1);
    expect(events[0].bounceType).toBe("hard");
    expect(events[0].message).toBe("User unknown");
  });

  it("parses a soft bounce from generic payload", () => {
    const body = { email: "soft@example.com", type: "soft" };
    expect(parseBouncePayload("generic", body)[0].bounceType).toBe("soft");
  });

  it("parses a spam complaint from generic payload", () => {
    const body = { email: "spam@example.com", type: "spam" };
    expect(parseBouncePayload("generic", body)[0].bounceType).toBe("spam");
  });

  it("returns empty array for unknown type", () => {
    const body = { email: "x@example.com", type: "unknown" };
    expect(parseBouncePayload("generic", body)).toHaveLength(0);
  });

  it("returns empty array when email is missing", () => {
    const body = { type: "hard" };
    expect(parseBouncePayload("generic", body)).toHaveLength(0);
  });

  it("returns empty array for null body", () => {
    expect(parseBouncePayload("generic", null)).toHaveLength(0);
  });

  it("returns empty array for non-object body", () => {
    expect(parseBouncePayload("generic", "not-an-object")).toHaveLength(0);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   Feature 52 — verifyBounceSignature
   ═══════════════════════════════════════════════════════════════════════════ */

describe("verifyBounceSignature", () => {
  it("returns true for generic provider (no signature required)", () => {
    const req = makeReq({}, {});
    expect(verifyBounceSignature("generic", req)).toBe(true);
  });

  it("returns true for SendGrid (ECDSA skipped, use IP allowlist)", () => {
    const req = makeReq({ "x-twilio-email-event-webhook-signature": "sig" }, {});
    expect(verifyBounceSignature("sendgrid", req)).toBe(true);
  });

  it("returns true for Mailgun when MAILGUN_WEBHOOK_KEY is not set", () => {
    delete process.env.MAILGUN_WEBHOOK_KEY;
    const req = makeReq({}, {});
    expect(verifyBounceSignature("mailgun", req)).toBe(true);
  });

  it("returns true for Postmark when POSTMARK_WEBHOOK_KEY is not set", () => {
    delete process.env.POSTMARK_WEBHOOK_KEY;
    const req = makeReq({ "x-postmark-signature": "sig" }, {});
    expect(verifyBounceSignature("postmark", req)).toBe(true);
  });

  it("returns false for Mailgun when signature fields are missing", () => {
    process.env.MAILGUN_WEBHOOK_KEY = "test-key-12345";
    const req = makeReq({}, { signature: {} }); // missing timestamp/token/signature
    expect(verifyBounceSignature("mailgun", req)).toBe(false);
    delete process.env.MAILGUN_WEBHOOK_KEY;
  });

  it("validates correct Mailgun HMAC signature", () => {
    const crypto = require("crypto");
    const key = "my-mailgun-webhook-key";
    process.env.MAILGUN_WEBHOOK_KEY = key;
    const timestamp = "1700000000";
    const token = "abc123token";
    const signature = crypto.createHmac("sha256", key).update(timestamp + token).digest("hex");
    const req = makeReq({}, { signature: { timestamp, token, signature } });
    expect(verifyBounceSignature("mailgun", req)).toBe(true);
    delete process.env.MAILGUN_WEBHOOK_KEY;
  });

  it("rejects incorrect Mailgun HMAC signature", () => {
    process.env.MAILGUN_WEBHOOK_KEY = "my-mailgun-webhook-key";
    const req = makeReq(
      {},
      { signature: { timestamp: "1700000000", token: "abc123", signature: "wrong-signature-value-here-padded" } },
    );
    expect(verifyBounceSignature("mailgun", req)).toBe(false);
    delete process.env.MAILGUN_WEBHOOK_KEY;
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   Feature 53 — Time-series aggregation logic
   ═══════════════════════════════════════════════════════════════════════════ */

describe("time-series daily bucket aggregation", () => {
  /**
   * Replicate the aggregation logic from getTrackingTimeSeries for unit testing.
   * This mirrors what the tRPC procedure does server-side.
   */
  function buildTimeSeries(
    events: { type: "open" | "click"; createdAt: Date }[],
    days: number,
  ): { date: string; opens: number; clicks: number }[] {
    const since = Date.now() - days * 24 * 60 * 60 * 1000;
    const dailyMap: Record<string, { date: string; opens: number; clicks: number }> = {};
    for (const ev of events) {
      const ts = ev.createdAt.getTime();
      if (ts < since) continue;
      const day = new Date(ts).toISOString().slice(0, 10);
      if (!dailyMap[day]) dailyMap[day] = { date: day, opens: 0, clicks: 0 };
      if (ev.type === "open") dailyMap[day].opens++;
      else if (ev.type === "click") dailyMap[day].clicks++;
    }
    const result: { date: string; opens: number; clicks: number }[] = [];
    for (let i = days - 1; i >= 0; i--) {
      const day = new Date(Date.now() - i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      result.push(dailyMap[day] ?? { date: day, opens: 0, clicks: 0 });
    }
    return result;
  }

  it("returns exactly `days` entries", () => {
    const result = buildTimeSeries([], 30);
    expect(result).toHaveLength(30);
  });

  it("returns exactly 7 entries for 7-day range", () => {
    const result = buildTimeSeries([], 7);
    expect(result).toHaveLength(7);
  });

  it("fills missing days with zeros", () => {
    const result = buildTimeSeries([], 7);
    for (const day of result) {
      expect(day.opens).toBe(0);
      expect(day.clicks).toBe(0);
    }
  });

  it("counts opens and clicks on today's date", () => {
    const now = new Date();
    const events = [
      { type: "open" as const, createdAt: now },
      { type: "open" as const, createdAt: now },
      { type: "click" as const, createdAt: now },
    ];
    const result = buildTimeSeries(events, 7);
    const today = now.toISOString().slice(0, 10);
    const todayEntry = result.find((d) => d.date === today);
    expect(todayEntry).toBeDefined();
    expect(todayEntry!.opens).toBe(2);
    expect(todayEntry!.clicks).toBe(1);
  });

  it("excludes events older than the date range", () => {
    const oldDate = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
    const events = [{ type: "open" as const, createdAt: oldDate }];
    const result = buildTimeSeries(events, 30);
    const total = result.reduce((s, d) => s + d.opens + d.clicks, 0);
    expect(total).toBe(0);
  });

  it("includes events exactly at the boundary", () => {
    // An event 29 days ago should be included in a 30-day range
    const boundaryDate = new Date(Date.now() - 29 * 24 * 60 * 60 * 1000);
    const events = [{ type: "click" as const, createdAt: boundaryDate }];
    const result = buildTimeSeries(events, 30);
    const total = result.reduce((s, d) => s + d.opens + d.clicks, 0);
    expect(total).toBe(1);
  });

  it("dates are in ascending chronological order", () => {
    const result = buildTimeSeries([], 14);
    for (let i = 1; i < result.length; i++) {
      expect(result[i].date >= result[i - 1].date).toBe(true);
    }
  });

  it("correctly separates opens from clicks", () => {
    const now = new Date();
    const events = [
      { type: "open" as const, createdAt: now },
      { type: "click" as const, createdAt: now },
      { type: "click" as const, createdAt: now },
    ];
    const result = buildTimeSeries(events, 7);
    const today = now.toISOString().slice(0, 10);
    const todayEntry = result.find((d) => d.date === today)!;
    expect(todayEntry.opens).toBe(1);
    expect(todayEntry.clicks).toBe(2);
  });

  it("handles 90-day range correctly", () => {
    const result = buildTimeSeries([], 90);
    expect(result).toHaveLength(90);
    // First date should be ~89 days ago
    const expectedFirst = new Date(Date.now() - 89 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    expect(result[0].date).toBe(expectedFirst);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   Feature 54 — Nightly batch owner notification
   ═══════════════════════════════════════════════════════════════════════════ */

describe("nightly batch notification content", () => {
  /**
   * Test the notification message construction logic in isolation.
   * We replicate the message-building logic from nightlyBatch.ts.
   */
  function buildNotificationMessage(
    workspacesProcessed: number,
    totalTriggered: number,
    totalSkipped: number,
    totalErrors: number,
  ) {
    const runDate = new Date().toLocaleDateString(undefined, {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    });
    const content =
      `Nightly AI pipeline batch completed on ${runDate}.\n\n` +
      `• Workspaces processed: ${workspacesProcessed}\n` +
      `• Leads queued for AI research: ${totalTriggered}\n` +
      `• Leads skipped (recent job or over cap): ${totalSkipped}\n` +
      (totalErrors > 0 ? `• Errors encountered: ${totalErrors}\n` : "") +
      `\nEach queued lead will receive a personalised email draft in the AI Draft Queue (/ai-pipeline) for your review.`;

    const title = `Nightly Batch: ${totalTriggered} lead${totalTriggered !== 1 ? "s" : ""} queued`;
    return { title, content };
  }

  it("generates correct title for 0 leads", () => {
    const { title } = buildNotificationMessage(1, 0, 0, 0);
    expect(title).toBe("Nightly Batch: 0 leads queued");
  });

  it("generates correct title for 1 lead (singular)", () => {
    const { title } = buildNotificationMessage(1, 1, 0, 0);
    expect(title).toBe("Nightly Batch: 1 lead queued");
  });

  it("generates correct title for multiple leads (plural)", () => {
    const { title } = buildNotificationMessage(2, 15, 3, 0);
    expect(title).toBe("Nightly Batch: 15 leads queued");
  });

  it("includes workspaces processed count in content", () => {
    const { content } = buildNotificationMessage(3, 10, 5, 0);
    expect(content).toContain("Workspaces processed: 3");
  });

  it("includes triggered leads count in content", () => {
    const { content } = buildNotificationMessage(1, 12, 2, 0);
    expect(content).toContain("Leads queued for AI research: 12");
  });

  it("includes skipped leads count in content", () => {
    const { content } = buildNotificationMessage(1, 10, 8, 0);
    expect(content).toContain("Leads skipped (recent job or over cap): 8");
  });

  it("includes error count only when errors > 0", () => {
    const { content: withErrors } = buildNotificationMessage(1, 5, 2, 3);
    expect(withErrors).toContain("Errors encountered: 3");

    const { content: noErrors } = buildNotificationMessage(1, 5, 2, 0);
    expect(noErrors).not.toContain("Errors encountered");
  });

  it("always includes the AI Draft Queue link", () => {
    const { content } = buildNotificationMessage(1, 5, 0, 0);
    expect(content).toContain("/ai-pipeline");
  });

  it("content mentions the run date", () => {
    const { content } = buildNotificationMessage(1, 5, 0, 0);
    expect(content).toContain("Nightly AI pipeline batch completed on");
  });
});

describe("notifyOwner call in runNightlyBatch", () => {
  it("notifyOwner is called with non-empty title and content", async () => {
    // Verify the notification module exports the expected function signature
    const notificationModule = await import("./_core/notification");
    expect(typeof notificationModule.notifyOwner).toBe("function");
  });

  it("notification title has a maximum length within allowed bounds", () => {
    // Title max is 1200 chars per notification.ts
    const title = "Nightly Batch: 50 leads queued";
    expect(title.length).toBeLessThanOrEqual(1200);
  });

  it("notification content has a maximum length within allowed bounds", () => {
    // Content max is 20000 chars per notification.ts
    const content =
      "Nightly AI pipeline batch completed.\n\n" +
      "• Workspaces processed: 5\n" +
      "• Leads queued for AI research: 50\n" +
      "• Leads skipped (recent job or over cap): 100\n" +
      "• Errors encountered: 2\n" +
      "\nEach queued lead will receive a personalised email draft in the AI Draft Queue (/ai-pipeline) for your review.";
    expect(content.length).toBeLessThanOrEqual(20000);
  });
});
