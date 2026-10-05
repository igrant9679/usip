/**
 * chatIdentity.ts — who a website chat visitor is, and how they prove it.
 *
 * Owner ask 2026-10-05: "Give the chat agent the visitor's history too",
 * choosing "safe now, full after code". A visitor is whoever they type, so:
 *
 *   matched   their email matches someone in the CRM. The agent gets only
 *             harmless details (that they are known, their company and role)
 *             so it does not ask again, and is told to reveal nothing else.
 *   verified  they asked to be looked up, a 6-digit code was emailed to that
 *             address from the workspace's own mailbox, and they typed it
 *             back. The agent gets the same history the phone agent does.
 *
 * The code is checked here, not by the model, stored only as an HMAC,
 * expires in 10 minutes, allows 5 tries, and is rate-limited per chat and
 * per address so the widget cannot be used to spam an inbox.
 */
import crypto from "crypto";
import { and, eq, gte, sql } from "drizzle-orm";
import { chatSessions, contacts, leads, prospects } from "../../drizzle/schema";
import { getDb } from "../db";
import { sendWorkspaceEmail } from "../emailDelivery";
import { escapeHtml } from "@shared/escapeHtml";
import { buildPersonHistory, personIdForRecord } from "./personHistory";
import type { ChatIdentityView } from "./chatAgent";

export const CODE_TTL_MS = 10 * 60 * 1000;
export const MAX_ATTEMPTS = 5;
export const MAX_CODES_PER_CHAT = 3;
export const MAX_CODES_PER_ADDRESS_PER_DAY = 5;
/** A second code this soon after the first is a double click, not a request. */
const RESEND_GAP_MS = 30 * 1000;

const norm = (e: string | null | undefined) => String(e ?? "").trim().toLowerCase();

/** The People record behind an email address, or null. */
export async function personIdForEmail(workspaceId: number, email: string | null | undefined): Promise<number | null> {
  const e = norm(email);
  if (!e || !e.includes("@")) return null;
  try {
    const db = await getDb();
    if (!db) return null;
    const [p] = await db.select({ id: prospects.id }).from(prospects)
      .where(and(eq(prospects.workspaceId, workspaceId), sql`lower(${prospects.email}) = ${e}`)).limit(1);
    if (p) return p.id;
    const [c] = await db.select({ id: contacts.id }).from(contacts)
      .where(and(eq(contacts.workspaceId, workspaceId), sql`lower(${contacts.email}) = ${e}`)).limit(1);
    if (c) {
      const viaContact = await personIdForRecord(workspaceId, "contact", c.id);
      if (viaContact) return viaContact;
    }
    const [l] = await db.select({ id: leads.id }).from(leads)
      .where(and(eq(leads.workspaceId, workspaceId), sql`lower(${leads.email}) = ${e}`)).limit(1);
    if (l) return await personIdForRecord(workspaceId, "lead", l.id);
    return null;
  } catch {
    return null;
  }
}

/* ── the code ─────────────────────────────────────────────────────────── */

function secret(): string {
  const k = process.env.ENCRYPTION_KEY || process.env.JWT_SECRET || "";
  if (!k && process.env.NODE_ENV === "production") throw new Error("No server secret for chat verification codes");
  return `chat-verify:${k || "dev-only"}`;
}

/** Bound to the chat, so a code from one chat proves nothing in another. */
export function codeHash(sessionToken: string, code: string): string {
  return crypto.createHmac("sha256", secret()).update(`${sessionToken}:${code}`).digest("hex");
}

export function newCode(): string {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
}

/** A 6-digit code in what the visitor typed ("123456", "123 456", "123-456"). */
export function codeIn(text: string | null | undefined): string | null {
  const m = /(?:^|[^\d])(\d{3})[\s-]?(\d{3})(?!\d)/.exec(String(text ?? ""));
  return m ? `${m[1]}${m[2]}` : null;
}

export type SessionCodeState = {
  token: string;
  visitorEmail: string | null;
  verifyCodeHash: string | null;
  verifyCodeExpiresAt: Date | string | null;
  verifyAttempts: number;
};

export type CodeCheck =
  | { result: null }
  | { result: "verified" | "wrong" | "expired"; patch: Record<string, unknown> };

/**
 * What a visitor's message does to an outstanding code. Pure: the caller
 * writes `patch` to the session. A message without a 6-digit code, or a
 * chat with no code outstanding, does nothing.
 */
export function checkCode(s: SessionCodeState, message: string, nowMs = Date.now()): CodeCheck {
  if (!s.verifyCodeHash) return { result: null };
  const code = codeIn(message);
  if (!code) return { result: null };
  const clear = { verifyCodeHash: null, verifyCodeExpiresAt: null, verifyAttempts: 0 };
  const exp = s.verifyCodeExpiresAt ? new Date(s.verifyCodeExpiresAt).getTime() : 0;
  if (!exp || exp < nowMs) return { result: "expired", patch: clear };
  const want = Buffer.from(s.verifyCodeHash, "hex");
  const got = Buffer.from(codeHash(s.token, code), "hex");
  if (want.length === got.length && crypto.timingSafeEqual(want, got) && norm(s.visitorEmail)) {
    return { result: "verified", patch: { ...clear, verifiedEmail: norm(s.visitorEmail), verifiedAt: new Date(nowMs) } };
  }
  const attempts = (s.verifyAttempts ?? 0) + 1;
  // Out of tries: the code is void; a new one has to be asked for.
  return { result: "wrong", patch: attempts >= MAX_ATTEMPTS ? clear : { verifyAttempts: attempts } };
}

/** Whether another code may go out now, for this chat and this address. */
export function mayIssueCode(
  s: { verifyCodesSent: number; verifyCodeSentAt: Date | string | null },
  codesToAddressLastDay: number,
  nowMs = Date.now(),
): boolean {
  if ((s.verifyCodesSent ?? 0) >= MAX_CODES_PER_CHAT) return false;
  if (codesToAddressLastDay >= MAX_CODES_PER_ADDRESS_PER_DAY) return false;
  const last = s.verifyCodeSentAt ? new Date(s.verifyCodeSentAt).getTime() : 0;
  return !last || nowMs - last >= RESEND_GAP_MS;
}

/** Codes sent to this address from any chat in the last day (sum over sessions). */
export async function codesToAddressLastDay(workspaceId: number, email: string, nowMs = Date.now()): Promise<number> {
  const db = await getDb();
  if (!db) return MAX_CODES_PER_ADDRESS_PER_DAY;
  const [r] = await db.select({ n: sql<number>`coalesce(sum(${chatSessions.verifyCodesSent}), 0)` }).from(chatSessions)
    .where(and(eq(chatSessions.workspaceId, workspaceId), sql`lower(${chatSessions.visitorEmail}) = ${norm(email)}`, gte(chatSessions.verifyCodeSentAt, new Date(nowMs - 24 * 60 * 60 * 1000))));
  return Number(r?.n ?? 0);
}

/**
 * Email a fresh code to the chat's address from the workspace's own mailbox,
 * and record its HMAC. A failed send leaves no code outstanding.
 */
export async function sendCode(
  workspaceId: number,
  session: { id: number; token: string; verifyCodesSent: number },
  email: string,
  from: { companyName: string; agentName: string },
  nowMs = Date.now(),
): Promise<{ ok: boolean; reason?: string }> {
  const db = await getDb();
  if (!db) return { ok: false, reason: "no_db" };
  const code = newCode();
  await db.update(chatSessions).set({
    verifyCodeHash: codeHash(session.token, code),
    verifyCodeExpiresAt: new Date(nowMs + CODE_TTL_MS),
    verifyCodeSentAt: new Date(nowMs),
    // In SQL: two requests at once must both count toward the limit.
    verifyCodesSent: sql`${chatSessions.verifyCodesSent} + 1`,
    verifyAttempts: 0,
  } as never).where(eq(chatSessions.id, session.id));
  const company = from.companyName || "our team";
  const text =
    `Your verification code is ${code}\n\n` +
    `You asked ${from.agentName} on ${company}'s website to look up your details. Type this code into the chat to confirm it's you. It expires in 10 minutes.\n\n` +
    `If that wasn't you, ignore this email: nothing has been shared.`;
  const res = await sendWorkspaceEmail(workspaceId, {
    to: email,
    subject: `Your ${company} verification code: ${code}`,
    text,
    html: text.split("\n\n").map((p) => `<p>${escapeHtml(p)}</p>`).join(""),
    logSource: "transactional",
    logLabel: "Chat verification code",
  });
  if (!res.ok) {
    await db.update(chatSessions).set({ verifyCodeHash: null, verifyCodeExpiresAt: null } as never).where(eq(chatSessions.id, session.id));
    return { ok: false, reason: res.reason };
  }
  return { ok: true };
}

/* ── what the agent is told ───────────────────────────────────────────── */

/**
 * Who this visitor is, as far as they have proven it: unknown, matched
 * (harmless details only), or verified (their history).
 */
export async function resolveChatIdentity(
  workspaceId: number,
  session: { visitorEmail: string | null; verifiedEmail: string | null; verifyCodeHash: string | null; verifyCodeExpiresAt: Date | string | null; verifyCodesSent: number; verifyCodeSentAt: Date | string | null },
  email: string | null,
  nowMs = Date.now(),
): Promise<ChatIdentityView> {
  const personId = await personIdForEmail(workspaceId, email);
  if (!personId) return { status: "unknown" };
  if (isVerified(session, email)) return { status: "verified", history: await buildPersonHistory(workspaceId, personId) };
  const safe = await safeDetails(workspaceId, personId);
  const exp = session.verifyCodeExpiresAt ? new Date(session.verifyCodeExpiresAt).getTime() : 0;
  const recent = email ? await codesToAddressLastDay(workspaceId, email, nowMs) : MAX_CODES_PER_ADDRESS_PER_DAY;
  return { status: "matched", ...safe, codePending: !!session.verifyCodeHash && exp > nowMs, canSendCode: mayIssueCode(session, recent, nowMs) };
}

/** Company and role on record for a person: the only details a matched, unverified visitor's agent gets. */
export async function safeDetails(workspaceId: number, personId: number): Promise<{ company: string | null; title: string | null }> {
  try {
    const db = await getDb();
    if (!db) return { company: null, title: null };
    const [p] = await db.select({ company: prospects.company, title: prospects.title }).from(prospects)
      .where(and(eq(prospects.id, personId), eq(prospects.workspaceId, workspaceId))).limit(1);
    return { company: p?.company ?? null, title: p?.title ?? null };
  } catch {
    return { company: null, title: null };
  }
}

/** History only when the address they gave is the address they proved. */
export function isVerified(s: { visitorEmail: string | null; verifiedEmail: string | null }, email: string | null): boolean {
  const e = norm(email ?? s.visitorEmail);
  return !!e && !!s.verifiedEmail && norm(s.verifiedEmail) === e;
}
