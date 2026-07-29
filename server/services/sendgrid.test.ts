import { describe, it, expect } from "vitest";
import {
  buildSendGridPayload,
  describeSendGridError,
  validateSendGridMessage,
  type SendGridMessage,
} from "./sendgrid";

const msg = (o: Partial<SendGridMessage> = {}): SendGridMessage => ({
  to: "buyer@acme.com",
  subject: "Quick question",
  text: "Hello there",
  html: "<p>Hello there</p>",
  fromEmail: "sales@lsi-media.com",
  ...o,
});

/**
 * These field names are a CONTRACT with SendGrid's v3 API. Getting one wrong
 * fails as a 400 at send time, which — for a campaign sender driven by cron —
 * means the first sign of trouble is mail that never went out.
 */
describe("buildSendGridPayload", () => {
  it("nests the recipient the way v3 requires", () => {
    const p = buildSendGridPayload(msg()) as any;
    expect(p.personalizations).toEqual([{ to: [{ email: "buyer@acme.com" }] }]);
    expect(p.subject).toBe("Quick question");
  });

  /** SendGrid REJECTS the request when text/html precedes text/plain. */
  it("puts text/plain before text/html", () => {
    const p = buildSendGridPayload(msg()) as any;
    expect(p.content.map((c: any) => c.type)).toEqual(["text/plain", "text/html"]);
  });

  it("still sends when only html is supplied", () => {
    const p = buildSendGridPayload(msg({ text: undefined })) as any;
    expect(p.content).toEqual([{ type: "text/html", value: "<p>Hello there</p>" }]);
  });

  /** An empty content array is a 400; a blank part is not. */
  it("never emits an empty content array", () => {
    const p = buildSendGridPayload(msg({ text: undefined, html: undefined })) as any;
    expect(p.content).toHaveLength(1);
  });

  it("omits from.name entirely rather than sending null", () => {
    const p = buildSendGridPayload(msg({ fromName: null })) as any;
    expect(p.from).toEqual({ email: "sales@lsi-media.com" });
  });

  it("includes reply_to only when set — it is how replies are received at all", () => {
    expect((buildSendGridPayload(msg()) as any).reply_to).toBeUndefined();
    expect((buildSendGridPayload(msg({ replyTo: "idris@lsi-media.com" })) as any).reply_to)
      .toEqual({ email: "idris@lsi-media.com" });
  });
});

/**
 * Validate BEFORE spending a send: SendGrid rejects the whole request on one
 * bad address, and a campaign that fails per-message is far harder to diagnose
 * than one that never left.
 */
describe("validateSendGridMessage", () => {
  it("accepts a well-formed message", () => {
    expect(validateSendGridMessage(msg())).toBeNull();
  });

  it("rejects a bad recipient, sender or reply-to", () => {
    expect(validateSendGridMessage(msg({ to: "not-an-email" }))).toMatch(/recipient/i);
    expect(validateSendGridMessage(msg({ fromEmail: "" }))).toMatch(/From/i);
    expect(validateSendGridMessage(msg({ replyTo: "nope" }))).toMatch(/Reply-To/i);
  });

  it("rejects a blank subject rather than sending an untitled email", () => {
    expect(validateSendGridMessage(msg({ subject: "   " }))).toMatch(/subject/i);
  });
});

/**
 * The `field` in SendGrid's error is usually the whole diagnosis — "from.email"
 * means the sender is not verified. Dropping it turns a fixable problem into
 * "send failed".
 */
describe("describeSendGridError", () => {
  it("keeps the field name alongside the message", () => {
    const out = describeSendGridError(403, {
      errors: [{ message: "The from address does not match a verified Sender Identity.", field: "from.email" }],
    });
    expect(out).toContain("from.email");
    expect(out).toContain("verified Sender Identity");
  });

  it("explains a bare 401 instead of echoing a status code", () => {
    expect(describeSendGridError(401, null)).toMatch(/API key/i);
  });

  it("falls back to the status when the body is unparseable", () => {
    expect(describeSendGridError(500, null)).toBe("SendGrid returned HTTP 500");
  });

  it("caps a flood of errors rather than logging all of them", () => {
    const out = describeSendGridError(400, {
      errors: Array.from({ length: 20 }, (_, i) => ({ message: `err ${i}`, field: `f${i}` })),
    });
    expect(out).toContain("f0");
    expect(out).not.toContain("f5");
    expect(out.length).toBeLessThanOrEqual(300);
  });
});
