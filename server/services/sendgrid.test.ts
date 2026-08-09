import { describe, it, expect, vi, afterEach } from "vitest";
import {
  buildSendGridPayload,
  describeSendGridError,
  validateSendGridMessage,
  sendViaSendGrid,
  verifySendGridKey,
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

/**
 * The network layer, against a mocked fetch — because the one bug that
 * actually shipped here was invisible to every pure-function test: the calls
 * went to api.sendgrid.NET, which is SendGrid's SMTP/link domain and does not
 * serve the Web API (the TCP connection fails outright). Every send and every
 * key test failed as "request failed" while all the payload tests were green.
 * These tests assert the URL the code REALLY fetches, not a string in source.
 */
describe("sendViaSendGrid — the wire call", () => {
  afterEach(() => vi.unstubAllGlobals());

  const stub = (impl: (url: string, init?: RequestInit) => Promise<Response>) => {
    const spy = vi.fn(impl);
    vi.stubGlobal("fetch", spy);
    return spy;
  };

  it("POSTs to api.sendgrid.com — the .net host does not serve the Web API", async () => {
    const spy = stub(async () => new Response(null, { status: 202, headers: { "x-message-id": "mid-1" } }));
    const res = await sendViaSendGrid("SG.key", msg());
    expect(res.ok).toBe(true);
    expect(res.messageId).toBe("mid-1");
    const url = new URL(spy.mock.calls[0][0] as string);
    expect(url.hostname).toBe("api.sendgrid.com");
    expect(url.pathname).toBe("/v3/mail/send");
  });

  it("sends the key as a Bearer token and the payload as JSON", async () => {
    const spy = stub(async () => new Response(null, { status: 202 }));
    await sendViaSendGrid("SG.secret", msg());
    const init = spy.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer SG.secret");
    const body = JSON.parse(init.body as string);
    expect(body.personalizations[0].to[0].email).toBe("buyer@acme.com");
  });

  it("turns a non-202 into the described error, not a throw", async () => {
    stub(async () =>
      new Response(JSON.stringify({ errors: [{ field: "from.email", message: "not verified" }] }), { status: 403 }),
    );
    const res = await sendViaSendGrid("SG.key", msg());
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("from.email");
  });

  it("a dead host is a reason, never an exception — the pool caller counts on it", async () => {
    stub(async () => { throw new Error("getaddrinfo ENOTFOUND api.sendgrid.net"); });
    const res = await sendViaSendGrid("SG.key", msg());
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/request failed/i);
  });
});

describe("verifySendGridKey — the wire call", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("GETs /v3/scopes on api.sendgrid.com", async () => {
    const spy = vi.fn(async () => new Response(JSON.stringify({ scopes: ["mail.send"] }), { status: 200 }));
    vi.stubGlobal("fetch", spy);
    const res = await verifySendGridKey("SG.key");
    expect(res.ok).toBe(true);
    const url = new URL(spy.mock.calls[0][0] as string);
    expect(url.hostname).toBe("api.sendgrid.com");
    expect(url.pathname).toBe("/v3/scopes");
  });

  it("a key that authenticates without mail.send is refused with the reason", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ scopes: ["alerts.read"] }), { status: 200 })));
    const res = await verifySendGridKey("SG.key");
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Mail Send/i);
  });
});
