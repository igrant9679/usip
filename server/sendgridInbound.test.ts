/**
 * SendGrid inbound replies (owner ask 2026-08-13: "replies populate only in
 * Velocity, not the From address's inbox"). The token in the recipient
 * address is the webhook's entire auth model — these tests pin the address
 * grammar, the routing seams, and the always-200 discipline the webhook
 * must keep (SendGrid disables a webhook that keeps failing, which would
 * silently lose replies).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { inboundReplyAddress, tokenFromRecipient } from "./sendgridInbound";

describe("the reply address grammar", () => {
  it("round-trips: the address we emit is the address we recognize", () => {
    const addr = inboundReplyAddress("a1b2c3d4e5f60718293a4b5c6d7e8f90", "reply.lsimedia.com");
    expect(addr).toBe("r-a1b2c3d4e5f60718293a4b5c6d7e8f90@reply.lsimedia.com");
    expect(tokenFromRecipient(addr)).toBe("a1b2c3d4e5f60718293a4b5c6d7e8f90");
  });

  it("finds the token in real-world recipient shapes", () => {
    expect(tokenFromRecipient('"Velocity Replies" <r-a1b2c3d4e5f60718293a4b5c6d7e8f90@reply.x.com>'))
      .toBe("a1b2c3d4e5f60718293a4b5c6d7e8f90");
    expect(tokenFromRecipient("other@x.com, r-a1b2c3d4e5f60718293a4b5c6d7e8f90@reply.x.com"))
      .toBe("a1b2c3d4e5f60718293a4b5c6d7e8f90");
  });

  it("rejects everything that is not a plausible token", () => {
    expect(tokenFromRecipient("idris@lsimedia.com")).toBeNull();
    expect(tokenFromRecipient("r-short@reply.x.com")).toBeNull(); // < 16 chars
    expect(tokenFromRecipient("")).toBeNull();
  });
});

describe("the webhook keeps its promises (structural)", () => {
  const src = readFileSync("server/sendgridInbound.ts", "utf8");

  it("feeds processInboundReply — the ONE reply pipeline, not a parallel one", () => {
    expect(src).toContain("processInboundReply({");
    // Every downstream behavior (inbox, classification, pause-on-reply,
    // notifications, ARE signals) exists because this seam is shared.
  });

  it("an unknown token is acknowledged silently — never confirmed to a prober", () => {
    const gate = src.indexOf("if (!ws) { res.status(200).send(\"ok\"); return; }");
    expect(gate).toBeGreaterThan(-1);
  });

  it("dedups on Message-ID — SendGrid retries must not double-ingest", () => {
    expect(src).toContain("eq(emailReplies.messageId, messageId)");
  });

  it("guards against reply loops from its own address", () => {
    expect(src).toContain("if (tokenFromRecipient(fromEmail))");
  });

  it("never buffers attachment files", () => {
    expect(src).toContain("files: 0");
    expect(src).toContain("stream.resume()");
  });
});

describe("the send side fills Reply-To automatically", () => {
  it("SendGridAdapter falls back to the workspace inbound address", () => {
    const src = readFileSync("server/emailAdapter.ts", "utf8");
    expect(src).toContain("inboundReplyAddress(ws.token, ws.domain)");
    // Precedence: explicit input, then the account's stored Reply-To, then
    // the inbound address — a user's deliberate Reply-To always wins.
    expect(src).toContain("input.replyTo ?? this.account.replyTo ?? null");
  });

  it("migration 0162 is declared in both places", () => {
    const mig = readFileSync("server/_core/rawMigrations.ts", "utf8");
    expect(mig).toContain("0162_sendgrid_inbound_reply.sql");
    expect(mig).toContain("`sendgrid_inbound_domain`");
    const schema = readFileSync("drizzle/schema.ts", "utf8");
    expect(schema).toContain('sendgridInboundDomain: varchar("sendgrid_inbound_domain"');
  });

  it("the route is registered at boot", () => {
    const core = readFileSync("server/_core/index.ts", "utf8");
    expect(core).toContain("registerSendGridInboundRoute(app)");
  });
});
