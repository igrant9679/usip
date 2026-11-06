/**
 * Website chat visitors and their history (owner ask 2026-10-05, "safe now,
 * full after code"): a visitor is whoever they type, so a matched visitor's
 * agent gets harmless details only, until a code emailed to that address is
 * typed back; the code is checked by Velocity, expires, is rate-limited, and
 * is only ever stored as an HMAC bound to the chat.
 */
import { readFileSync } from "fs";
import path from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { chatSessions, contacts, leads, prospects } from "../drizzle/schema";

type Row = Record<string, any>;
const data = new Map<unknown, Row[]>();
const updates: Row[] = [];
const fakeDb: any = {
  select: () => ({
    from: (table: unknown) => {
      const q: any = { where: () => q, limit: () => Promise.resolve(data.get(table) ?? []), then: (r: any, j: any) => Promise.resolve(data.get(table) ?? []).then(r, j) };
      return q;
    },
  }),
  update: (table: unknown) => ({ set: (v: Row) => ({ where: () => { if (table === chatSessions) updates.push(v); return Promise.resolve(); } }) }),
};
vi.mock("./db", () => ({ getDb: async () => fakeDb }));
const sendWorkspaceEmail = vi.fn(async (_ws: number, _o: any) => ({ ok: true }));
vi.mock("./emailDelivery", () => ({ sendWorkspaceEmail: (ws: number, o: any) => sendWorkspaceEmail(ws, o) }));
const buildPersonHistory = vi.fn(async () => "They replied 2026-09-30 (interested): Send me pricing.");
const personIdForRecord = vi.fn(async (_ws: number, type: string, id: number) => (type === "contact" ? 900 + id : type === "lead" ? 800 + id : null));
vi.mock("./services/personHistory", () => ({
  buildPersonHistory: (...a: any[]) => (buildPersonHistory as any)(...a),
  personIdForRecord: (...a: any[]) => (personIdForRecord as any)(...a),
}));

import {
  checkCode, codeHash, codeIn, CODE_TTL_MS, isVerified, MAX_ATTEMPTS, MAX_CODES_PER_ADDRESS_PER_DAY, MAX_CODES_PER_CHAT,
  mayIssueCode, personIdForEmail, resolveChatIdentity, sendCode,
} from "./services/chatIdentity";
import { identityGuidance, sanitizeTurn } from "./services/chatAgent";

beforeEach(() => {
  data.clear();
  updates.length = 0;
  sendWorkspaceEmail.mockClear();
  sendWorkspaceEmail.mockResolvedValue({ ok: true });
  buildPersonHistory.mockClear();
});

const NOW = Date.parse("2026-10-05T15:00:00Z");
const pending = (code: string, over: Row = {}) => ({
  token: "tok-A",
  visitorEmail: "Dana@Acme.com",
  verifyCodeHash: codeHash("tok-A", code),
  verifyCodeExpiresAt: new Date(NOW + CODE_TTL_MS),
  verifyAttempts: 0,
  ...over,
});

describe("reading a code", () => {
  it("finds six digits however they are typed", () => {
    expect(codeIn("123456")).toBe("123456");
    expect(codeIn("my code is 123 456 thanks")).toBe("123456");
    expect(codeIn("123-456")).toBe("123456");
  });
  it("ignores numbers that are not a code", () => {
    expect(codeIn("1234567")).toBeNull();
    expect(codeIn("12345")).toBeNull();
    expect(codeIn("no code here")).toBeNull();
  });
});

describe("checking a code (Velocity checks it, not the model)", () => {
  it("the right code proves the address: verified, lower-cased, code cleared", () => {
    const r = checkCode(pending("482913"), "it's 482913", NOW);
    expect(r.result).toBe("verified");
    expect((r as any).patch).toMatchObject({ verifiedEmail: "dana@acme.com", verifyCodeHash: null, verifyAttempts: 0 });
  });
  it("a wrong code counts an attempt; the last one voids the code", () => {
    const r = checkCode(pending("482913"), "111111", NOW);
    expect(r).toEqual({ result: "wrong", patch: { verifyAttempts: 1 } });
    const last = checkCode(pending("482913", { verifyAttempts: MAX_ATTEMPTS - 1 }), "111111", NOW);
    expect(last.result).toBe("wrong");
    expect((last as any).patch.verifyCodeHash).toBeNull();
  });
  it("an expired code proves nothing", () => {
    const r = checkCode(pending("482913", { verifyCodeExpiresAt: new Date(NOW - 1) }), "482913", NOW);
    expect(r.result).toBe("expired");
    expect((r as any).patch.verifyCodeHash).toBeNull();
  });
  it("a code is bound to its chat: the same digits in another chat are wrong", () => {
    const r = checkCode(pending("482913", { token: "tok-B", verifyCodeHash: codeHash("tok-A", "482913") }), "482913", NOW);
    expect(r.result).toBe("wrong");
  });
  it("no code outstanding, or no code in the message: nothing happens", () => {
    expect(checkCode(pending("482913", { verifyCodeHash: null }), "482913", NOW)).toEqual({ result: null });
    expect(checkCode(pending("482913"), "what does it cost?", NOW)).toEqual({ result: null });
  });
  it("the code is never stored, only its HMAC", () => {
    expect(codeHash("tok-A", "482913")).toMatch(/^[0-9a-f]{64}$/);
    expect(codeHash("tok-A", "482913")).not.toContain("482913");
  });
});

describe("limits on sending codes", () => {
  it("three per chat, five per address a day, not twice within 30 seconds", () => {
    expect(mayIssueCode({ verifyCodesSent: 0, verifyCodeSentAt: null }, 0, NOW)).toBe(true);
    expect(mayIssueCode({ verifyCodesSent: MAX_CODES_PER_CHAT, verifyCodeSentAt: null }, 0, NOW)).toBe(false);
    expect(mayIssueCode({ verifyCodesSent: 0, verifyCodeSentAt: null }, MAX_CODES_PER_ADDRESS_PER_DAY, NOW)).toBe(false);
    expect(mayIssueCode({ verifyCodesSent: 1, verifyCodeSentAt: new Date(NOW - 10_000) }, 1, NOW)).toBe(false);
    expect(mayIssueCode({ verifyCodesSent: 1, verifyCodeSentAt: new Date(NOW - 60_000) }, 1, NOW)).toBe(true);
  });
});

describe("verified means the address they gave is the address they proved", () => {
  it("matches case-insensitively, and stops matching if they change address", () => {
    expect(isVerified({ visitorEmail: "dana@acme.com", verifiedEmail: "dana@acme.com" }, "Dana@ACME.com")).toBe(true);
    expect(isVerified({ visitorEmail: "dana@acme.com", verifiedEmail: "dana@acme.com" }, "ceo@acme.com")).toBe(false);
    expect(isVerified({ visitorEmail: "dana@acme.com", verifiedEmail: null }, "dana@acme.com")).toBe(false);
  });
});

describe("matching an email to a person", () => {
  it("a person by their own email, else through a contact or lead", async () => {
    data.set(prospects, [{ id: 9 }]);
    expect(await personIdForEmail(4, "Dana@Acme.com")).toBe(9);
    data.set(prospects, []);
    data.set(contacts, [{ id: 31 }]);
    expect(await personIdForEmail(4, "dana@acme.com")).toBe(931);
    data.set(contacts, []);
    data.set(leads, [{ id: 5 }]);
    expect(await personIdForEmail(4, "dana@acme.com")).toBe(805);
    data.set(leads, []);
    expect(await personIdForEmail(4, "nobody@nowhere.com")).toBeNull();
    expect(await personIdForEmail(4, "not an email")).toBeNull();
  });
});

describe("what the agent is told", () => {
  const session = { visitorEmail: "dana@acme.com", verifiedEmail: null, verifyCodeHash: null, verifyCodeExpiresAt: null, verifyCodesSent: 0, verifyCodeSentAt: null };

  /**
   * 2026-11-06 (audit G44): an unproven visitor is told the same whether or
   * not the CRM knows the address. The matched case used to hand the agent
   * the person's company and role and tell it to skip those questions, and
   * only a matched address was offered a code, so what the agent asked or
   * offered said who was a customer. These two cases pin the new shape;
   * what they protected (no history before a code, a firm "reveal nothing")
   * is kept and asserted.
   */
  it("no email yet: nothing", async () => {
    expect(await resolveChatIdentity(4, session, null, NOW)).toEqual({ status: "unknown" });
  });

  it("an email, known or not: the same unproven view, and history is never even fetched", async () => {
    const unknown = await resolveChatIdentity(4, session, "x@y.com", NOW);
    expect(unknown).toEqual({ status: "unproven", matched: false, codePending: false, canSendCode: true });
    data.set(prospects, [{ id: 9, company: "Acme University", title: "Director of Scholarships" }]);
    const id = await resolveChatIdentity(4, session, "dana@acme.com", NOW);
    expect(id).toEqual({ status: "unproven", matched: true, codePending: false, canSendCode: true });
    expect(buildPersonHistory).not.toHaveBeenCalled();
    const g = identityGuidance(id as any, null);
    expect(g, "the agent is told the same either way").toBe(identityGuidance(unknown as any, null));
    expect(g).not.toMatch(/Acme|Director|in our records \(/);
    expect(g).toContain("have NOT proven it is theirs");
    expect(g).toContain("Do not say, confirm or hint whether we know them");
    expect(g).toContain("set sendCode to true");
    expect(g).not.toContain("HISTORY");
  });

  it("verified: the history, fenced, and they may discuss it", async () => {
    data.set(prospects, [{ id: 9 }]);
    const id = await resolveChatIdentity(4, { ...session, verifiedEmail: "dana@acme.com" }, "dana@acme.com", NOW);
    expect(buildPersonHistory).toHaveBeenCalledWith(4, 9);
    const g = identityGuidance(id as any, "verified");
    expect(g).toContain("They just typed the right verification code");
    expect(g).toContain("you may use what the team knows about them and discuss it with them");
    expect(g.slice(g.indexOf("<<HISTORY"), g.indexOf("HISTORY>>"))).toContain("Send me pricing.");
  });

  it("a code on its way, or no more codes allowed, is said plainly", () => {
    expect(identityGuidance({ status: "unproven", matched: true, codePending: true, canSendCode: false }, null)).toContain("ask them to type it here");
    expect(identityGuidance({ status: "unproven", matched: false, codePending: false, canSendCode: false }, "wrong"))
      .toMatch(/code they typed is not right[\s\S]*team will follow up by email/);
    expect(identityGuidance({ status: "unknown" }, null)).toBe("");
  });

  it("the model's sendCode is read strictly", () => {
    expect(sanitizeTurn({ reply: "ok", sendCode: true }, "x").sendCode).toBe(true);
    expect(sanitizeTurn({ reply: "ok", sendCode: "yes" }, "x").sendCode).toBe(false);
    expect(sanitizeTurn({ reply: "ok" }, "x").sendCode).toBe(false);
  });
});

describe("sending the code", () => {
  it("emails it from the workspace's mailbox, and keeps only its HMAC", async () => {
    const r = await sendCode(4, { id: 1, token: "tok-A", verifyCodesSent: 0 }, "dana@acme.com", { companyName: "CommunityForce", agentName: "Ava" }, NOW);
    expect(r.ok).toBe(true);
    const [ws, mail] = sendWorkspaceEmail.mock.calls[0] as any[];
    expect(ws).toBe(4);
    expect(mail.to).toBe("dana@acme.com");
    const code = /(\d{6})/.exec(mail.subject)![1];
    expect(mail.subject).toBe(`Your CommunityForce verification code: ${code}`);
    expect(mail.text).toContain("If that wasn't you, ignore this email");
    expect(mail.text).not.toMatch(/velocity/i);
    expect(updates[0]).toMatchObject({ verifyCodeHash: codeHash("tok-A", code), verifyAttempts: 0 });
    // Counted in SQL, not from a value read earlier (atomicCounters guard).
    expect(updates[0].verifyCodesSent).not.toBe(1);
    for (const u of updates) for (const v of Object.values(u)) expect(v).not.toBe(code);
  });

  // 2026-11-06 (audit G44): it used to clear the code, which an unknown
  // address's decoy never does, so a failed send told the two apart. The
  // code that went nowhere is replaced with one nobody holds: still nothing
  // anyone can type.
  it("a send that fails leaves only a code nobody holds", async () => {
    sendWorkspaceEmail.mockResolvedValueOnce({ ok: false, reason: "No SMTP config found for workspace" } as any);
    const r = await sendCode(4, { id: 1, token: "tok-A", verifyCodesSent: 0 }, "dana@acme.com", { companyName: "X", agentName: "Ava" }, NOW);
    expect(r.ok).toBe(false);
    const code = /(\d{6})/.exec((sendWorkspaceEmail.mock.calls[0] as any[])[1].subject)![1];
    expect(updates.at(-1)!.verifyCodeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(updates.at(-1)!.verifyCodeHash).not.toBe(codeHash("tok-A", code));
  });
});

describe("the chat router, in order", () => {
  const src = readFileSync(path.join(__dirname, "routers", "chatAgents.ts"), "utf8");
  const send = src.slice(src.indexOf("send: publicProcedure"), src.indexOf("book: publicProcedure"));
  it("checks a code in the message before the agent runs, and hands it the identity", () => {
    expect(send.indexOf("const check = checkCode(")).toBeGreaterThan(-1);
    expect(send.indexOf("const check = checkCode(")).toBeLessThan(send.indexOf("const turn = await runChatTurn({"));
    expect(send).toContain("const identity = await resolveChatIdentity(agent.workspaceId, session, typedEmail)");
    expect(send).toMatch(/identity,\s*codeResult: check\.result,/);
  });
  // 2026-11-06 (audit G44): a real code only to a known address, a decoy to
  // an unknown one, and the same words for both once the limits are reached.
  it("sends a code only to a known, unproven address within the limits; a decoy otherwise", () => {
    expect(send).toContain('if (turn.sendCode && identity.status === "unproven" && visitor.email) {');
    const block = send.slice(send.indexOf('if (turn.sendCode && identity.status === "unproven"'), send.indexOf("const qualified = turn.score"));
    expect(block).toContain("if (!identity.canSendCode) {\n          reply = `${reply}\\n\\n${CODE_NOT_SENT}`;");
    expect(block).toContain("} else if (identity.matched) {");
    expect(block).toContain("await issueDecoyCode(session);");
  });
});
