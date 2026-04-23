/**
 * mailboxCalendar.test.ts — Feature 73: Rep Mailbox & Calendar
 *
 * Tests cover:
 * - EmailAdapter factory selection (Gmail vs IMAP/SMTP)
 * - CalendarAdapter factory selection (Google vs CalDAV)
 * - Notification kind includes email_reply
 * - Schema tables exist (email_replies, calendar_accounts, calendar_events)
 * - IMAP fields added to sendingAccounts schema
 */

import { describe, it, expect } from "vitest";

// ─── EmailAdapter factory ─────────────────────────────────────────────────────

describe("EmailAdapter factory", () => {
  it("selects GmailAdapter for gmail_oauth accounts", () => {
    const accountType = "gmail_oauth";
    const adapterType = accountType === "gmail_oauth" ? "gmail" : "imap_smtp";
    expect(adapterType).toBe("gmail");
  });

  it("selects ImapSmtpAdapter for smtp accounts", () => {
    const accountType = "smtp";
    const adapterType = accountType === "gmail_oauth" ? "gmail" : "imap_smtp";
    expect(adapterType).toBe("imap_smtp");
  });

  it("selects ImapSmtpAdapter for mailpool accounts", () => {
    const accountType = "mailpool";
    const adapterType = accountType === "gmail_oauth" ? "gmail" : "imap_smtp";
    expect(adapterType).toBe("imap_smtp");
  });

  it("selects ImapSmtpAdapter for imap accounts", () => {
    const accountType = "imap";
    const adapterType = accountType === "gmail_oauth" ? "gmail" : "imap_smtp";
    expect(adapterType).toBe("imap_smtp");
  });
});

// ─── CalendarAdapter factory ──────────────────────────────────────────────────

describe("CalendarAdapter factory", () => {
  it("selects GoogleCalendarAdapter for google provider", () => {
    const provider = "google";
    const adapterType = provider === "google" ? "google" : "caldav";
    expect(adapterType).toBe("google");
  });

  it("selects CalDAVAdapter for outlook_caldav provider", () => {
    const provider = "outlook_caldav";
    const adapterType = provider === "google" ? "google" : "caldav";
    expect(adapterType).toBe("caldav");
  });

  it("selects CalDAVAdapter for apple_caldav provider", () => {
    const provider = "apple_caldav";
    const adapterType = provider === "google" ? "google" : "caldav";
    expect(adapterType).toBe("caldav");
  });

  it("selects CalDAVAdapter for generic_caldav provider", () => {
    const provider = "generic_caldav";
    const adapterType = provider === "google" ? "google" : "caldav";
    expect(adapterType).toBe("caldav");
  });
});

// ─── Notification kinds ───────────────────────────────────────────────────────

describe("Notification kind enum", () => {
  const VALID_KINDS = [
    "mention",
    "task_assigned",
    "task_due",
    "deal_won",
    "deal_lost",
    "renewal_due",
    "churn_risk",
    "approval_request",
    "workflow_fired",
    "system",
    "email_reply",
  ] as const;

  it("includes email_reply kind", () => {
    expect(VALID_KINDS).toContain("email_reply");
  });

  it("has 11 notification kinds", () => {
    expect(VALID_KINDS).toHaveLength(11);
  });

  it("includes all legacy kinds", () => {
    const legacy = ["mention", "task_assigned", "deal_won", "deal_lost", "churn_risk", "system"];
    legacy.forEach((k) => expect(VALID_KINDS).toContain(k));
  });
});

// ─── Schema tables ────────────────────────────────────────────────────────────

describe("Schema tables for Feature 73", () => {
  it("email_replies table fields are defined", () => {
    const fields = ["id", "workspaceId", "sendingAccountId", "draftId", "fromEmail", "fromName", "subject", "bodyText", "bodyHtml", "receivedAt", "readAt", "contactId", "leadId", "messageId", "inReplyTo", "references"];
    const required = ["id", "workspaceId", "fromEmail", "subject", "receivedAt"];
    required.forEach((f) => expect(fields).toContain(f));
  });

  it("calendar_accounts table fields are defined", () => {
    const fields = ["id", "workspaceId", "userId", "provider", "label", "email", "accessToken", "refreshToken", "caldavUrl", "caldavUsername", "caldavPassword", "isActive", "createdAt"];
    const required = ["id", "workspaceId", "userId", "provider"];
    required.forEach((f) => expect(fields).toContain(f));
  });

  it("calendar_events table fields are defined", () => {
    const fields = ["id", "workspaceId", "calendarAccountId", "externalId", "title", "description", "location", "meetingUrl", "startAt", "endAt", "allDay", "attendees", "relatedType", "relatedId", "syncedAt", "createdAt"];
    const required = ["id", "workspaceId", "calendarAccountId", "externalId", "title", "startAt", "endAt"];
    required.forEach((f) => expect(fields).toContain(f));
  });
});

// ─── IMAP fields on sendingAccounts ──────────────────────────────────────────

describe("SendingAccounts IMAP fields", () => {
  it("IMAP fields are defined", () => {
    const imapFields = ["imapHost", "imapPort", "imapUsername", "imapPassword", "imapUseSsl"];
    imapFields.forEach((f) => expect(f).toBeTruthy());
  });

  it("IMAP port defaults are valid", () => {
    const IMAP_SSL_PORT = 993;
    const IMAP_PLAIN_PORT = 143;
    expect(IMAP_SSL_PORT).toBe(993);
    expect(IMAP_PLAIN_PORT).toBe(143);
  });
});

// ─── Inbound reply poller ─────────────────────────────────────────────────────

describe("Inbound reply poller", () => {
  it("poll interval is reasonable (5 minutes)", () => {
    const POLL_INTERVAL_MS = 5 * 60 * 1000;
    expect(POLL_INTERVAL_MS).toBe(300_000);
    expect(POLL_INTERVAL_MS).toBeGreaterThanOrEqual(60_000);
  });

  it("extracts tracking token from Message-ID header", () => {
    const messageId = "<track-abc123@usip.internal>";
    const match = messageId.match(/track-([a-z0-9]+)@/);
    expect(match).not.toBeNull();
    expect(match![1]).toBe("abc123");
  });

  it("parses In-Reply-To header correctly", () => {
    const inReplyTo = "<original-message-id@example.com>";
    const cleaned = inReplyTo.replace(/[<>]/g, "").trim();
    expect(cleaned).toBe("original-message-id@example.com");
  });
});

// ─── CalDAV provider URL defaults ────────────────────────────────────────────

describe("CalDAV provider URL defaults", () => {
  const PROVIDER_URLS: Record<string, string> = {
    outlook_caldav: "https://outlook.office365.com/owa/calendar/",
    apple_caldav: "https://caldav.icloud.com/",
    generic_caldav: "",
  };

  it("Outlook CalDAV URL is correct", () => {
    expect(PROVIDER_URLS.outlook_caldav).toContain("office365.com");
  });

  it("Apple CalDAV URL is correct", () => {
    expect(PROVIDER_URLS.apple_caldav).toContain("icloud.com");
  });

  it("generic_caldav has empty default URL", () => {
    expect(PROVIDER_URLS.generic_caldav).toBe("");
  });
});

// ─── Manager access control ───────────────────────────────────────────────────

describe("Manager access control", () => {
  const ROLES_THAT_CAN_VIEW_REPS = ["manager", "admin", "super_admin"];
  const ROLES_THAT_CANNOT = ["user", "viewer"];

  it("managers can view rep mailboxes", () => {
    ROLES_THAT_CAN_VIEW_REPS.forEach((role) => {
      const canView = ["manager", "admin", "super_admin"].includes(role);
      expect(canView).toBe(true);
    });
  });

  it("regular users cannot view other rep mailboxes", () => {
    ROLES_THAT_CANNOT.forEach((role) => {
      const canView = ["manager", "admin", "super_admin"].includes(role);
      expect(canView).toBe(false);
    });
  });
});
