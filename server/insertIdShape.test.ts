/**
 * Insert ids are read at the level mysql2 puts them (audit 2026-11-06, N6).
 *
 * `db.insert(...)` on drizzle's mysql2 driver resolves to
 * `[ResultSetHeader, FieldPacket[]]` (drizzle-orm 0.44.6,
 * mysql2/session.d.ts: `MySqlRawQueryResult`; session.js `execute()` reads
 * `res[0].insertId` itself before returning `res`). Reading `.insertId` off
 * that array gives undefined, so the new row's id came back as 0: a saved
 * report the next Save duplicated instead of updating, and ad-hoc emails whose
 * log rows were never joined to their drafts, so the Emails page showed no
 * opens or clicks for them.
 *
 *   1. `insertIdOf` reads either shape.
 *   2. A guard over server/**: every `.insertId` read is off a destructured
 *      header, an explicit `[0]`, or goes through `insertIdOf`.
 *   3. The procedures whose callers use the id, run against the SQL fake, which
 *      answers an insert with mysql2's own `[header, fields]`.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => {
  if (!process.env.ENCRYPTION_KEY && !process.env.JWT_SECRET) process.env.ENCRYPTION_KEY = "c".repeat(64);
  return { db: null as any, sent: [] as any[] };
});

vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));
vi.mock("./audit", async (a) => ({ ...(await a<typeof import("./audit")>()), recordAudit: async () => {} }));
vi.mock("./services/workspaceTimezone", async (a) => ({
  ...(await a<typeof import("./services/workspaceTimezone")>()),
  getWorkspaceTimezone: async () => "UTC",
}));
vi.mock("./services/outboundPause", async (a) => ({
  ...(await a<typeof import("./services/outboundPause")>()),
  isOutboundPaused: async () => false,
  assertOutboundNotPaused: async () => {},
}));
// The real adapter writes the email_log row as it sends (migration 0163); the
// draft is written after, and linked to that row by message id.
vi.mock("./emailAdapter", async (a) => ({
  ...(await a<typeof import("./emailAdapter")>()),
  createEmailAdapter: () => ({
    sendEmail: async (input: any) => {
      h.sent.push(input);
      const messageId = `mid-${h.sent.length}`;
      h.db.rowsOf("email_log").push({ id: 500 + h.sent.length, workspaceId: WS, messageId, draftId: null, toEmail: input.to });
      return { messageId };
    },
  }),
}));
vi.mock("./sendLimits", async (a) => ({ ...(await a<typeof import("./sendLimits")>()), assertSendAllowed: async () => {} }));
vi.mock("./mergeVars", async (a) => ({ ...(await a<typeof import("./mergeVars")>()), resolveBookingUrl: async () => "" }));
vi.mock("./campaignCounters", async (a) => ({ ...(await a<typeof import("./campaignCounters")>()), bumpCampaignCounter: async () => {} }));
vi.mock("./routers/are/execution", async (a) => ({ ...(await a<typeof import("./routers/are/execution")>()), processSignal: async () => {} }));

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { appRouter } from "./routers";
import { processInboundReply } from "./inboundReplyPoller";
import { insertIdOf } from "./_core/insertId";

const WS = 2;
const REP = 21;
const rows = (t: string) => h.db.rowsOf(t) as any[];

function caller() {
  const user = rows("users").find((u) => u.id === REP);
  return appRouter.createCaller({
    user,
    req: { protocol: "https", headers: { "x-workspace-id": String(WS) }, socket: { remoteAddress: "127.0.0.1" } },
    res: { clearCookie: () => {} },
  } as unknown as TrpcContext);
}

beforeEach(() => {
  h.db = makeSqlFakeDb({ realMembers: true });
  h.sent = [];
  rows("workspaces").push({ id: WS, name: "Acme Sales", slug: "acme", ownerUserId: REP, archivedAt: null, plan: "trial" });
  rows("users").push({
    id: REP, openId: "local:21", name: "Rep", email: "rep@acme.example", loginMethod: "password", role: "user",
    passwordHash: "x", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date(), emailSignature: null,
  });
  rows("workspace_members").push({
    id: 1, workspaceId: WS, userId: REP, role: "admin", title: null, quota: null, deactivatedAt: null,
    lastActiveAt: new Date(), inviteToken: null, inviteExpiresAt: null, createdAt: new Date(),
  });
  rows("sending_accounts").push({
    id: 1, workspaceId: WS, name: "Rep box", fromEmail: "rep@acme.example", fromName: "Rep", enabled: true,
    provider: "smtp", dailySendLimit: 500, unipileAccountId: null, signature: null, optOutEnabled: false, optOutMessage: null,
  });
  // Seeded rows take the low ids, so a new row's id is not 1 by coincidence.
  for (const t of ["email_drafts", "saved_reports", "proposals", "email_templates", "ai_help_conversations", "mindmaps", "voice_agents", "email_replies"]) {
    rows(t).push({ id: 40, workspaceId: 99 });
  }
});

/* ── 1. the helper ─────────────────────────────────────────────────────── */

describe("insertIdOf", () => {
  it("reads the id off mysql2's [ResultSetHeader, fields]", () => {
    expect(insertIdOf([{ insertId: 41, affectedRows: 1 }, []])).toBe(41);
  });
  it("reads a bare header, as `const [res] = await db.insert(...)` leaves it", () => {
    expect(insertIdOf({ insertId: 41, affectedRows: 1 })).toBe(41);
  });
  it("is 0 when there is no id", () => {
    for (const none of [undefined, null, [], [undefined], {}, [{ affectedRows: 0 }, []], [{ insertId: "x" }]]) expect(insertIdOf(none)).toBe(0);
  });
  it("takes a numeric string, as mysql2 gives for big numbers", () => {
    expect(insertIdOf([{ insertId: "9007199254" }, []])).toBe(9007199254);
  });
});

/* ── 2. the guard ──────────────────────────────────────────────────────── */

type Read = { at: string; receiver: string; bad: string | null };

/** Comments blanked to spaces, so offsets and line numbers still hold. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[\s;{}(),])\/\/[^\n]*/g, (m, p: string) => p + " ".repeat(m.length - p.length));
}

/** The expression `.insertId` at `dot` is read off, walking back over its postfix chain. */
function receiverAt(src: string, dot: number): string {
  let i = src[dot - 1] === "?" ? dot - 1 : dot;
  const end = i;
  const openOf = (close: number) => {
    const pair: Record<string, string> = { ")": "(", "]": "[" };
    let depth = 0;
    for (let j = close; j >= 0; j--) {
      if (src[j] === src[close]) depth++;
      else if (src[j] === pair[src[close]] && --depth === 0) return j;
    }
    return -1;
  };
  for (;;) {
    const c = src[i - 1];
    if (c === "!") { i--; continue; }
    if (c === ")" || c === "]") {
      const j = openOf(i - 1);
      if (j < 0) break;
      i = j;
      const p = src[i - 1];
      if (p && /[\w$)\]]/.test(p)) continue; // foo[0], foo(...), (x)[0]
    } else if (c && /[\w$]/.test(c)) {
      while (i > 0 && /[\w$]/.test(src[i - 1])) i--;
    } else break;
    if (src[i - 1] === ".") { i -= src[i - 2] === "?" ? 2 : 1; continue; }
    break;
  }
  return src.slice(i, end).trim();
}

/** `(x as T)!` → `x`; anything that is not, after unwrapping, a plain name → null. */
function nameOf(expr: string): string | null {
  let e = expr.trim();
  for (;;) {
    e = e.replace(/!$/, "").trim();
    if (e.startsWith("(") && e.endsWith(")")) { e = e.slice(1, -1).trim(); continue; }
    const as = e.match(/^([\w$]+)\s+as\s[\s\S]*$/);
    if (as) { e = as[1]; continue; }
    break;
  }
  return /^[A-Za-z_$][\w$]*$/.test(e) ? e : null;
}

/** How `name` was last bound before `pos`: as the first element of an array pattern, or plainly. */
function bindingOf(src: string, name: string, pos: number): { kind: "header" | "plain" | "unknown"; init?: string } {
  const before = src.slice(0, pos);
  let best: { at: number; kind: "header" | "plain"; init?: string } | null = null;
  const keep = (at: number, kind: "header" | "plain", init?: string) => { if (!best || at > best.at) best = { at, kind, init }; };
  for (const m of Array.from(before.matchAll(new RegExp(`(?:const|let|var)\\s*\\[\\s*${name.replace(/\$/g, "\\$")}\\s*[,\\]]`, "g")))) keep(m.index!, "header");
  for (const m of Array.from(before.matchAll(new RegExp(`(?:(?:const|let|var)\\s+|[;{}\\n]\\s*)${name.replace(/\$/g, "\\$")}\\s*(?::[^=;]+)?=(?![=>])([^;]*)`, "g")))) keep(m.index!, "plain", m[1]);
  for (const m of Array.from(before.matchAll(new RegExp(`\\b${name.replace(/\$/g, "\\$")}\\s*:\\s*ResultSetHeader\\b`, "g")))) keep(m.index!, "header");
  return best ?? { kind: "unknown" };
}

/** Every `.insertId` read in one file, with why it is wrong when it is. */
function insertIdReads(file: string, raw: string): Read[] {
  const src = stripComments(raw);
  const lineOf = (i: number) => src.slice(0, i).split("\n").length;
  const out: Read[] = [];
  for (const m of Array.from(src.matchAll(/\??\.insertId\b/g))) {
    const dot = m.index! + (m[0].startsWith("?") ? 1 : 0);
    const receiver = receiverAt(src, dot);
    const indexed = /(?:\?\.)?\[\s*0\s*\]$/.test(receiver);
    const base = receiver.replace(/(?:\?\.)?\[\s*0\s*\]$/, "");
    const name = nameOf(base);
    const binding = name ? bindingOf(src, name, dot) : { kind: "unknown" as const };
    let bad: string | null = null;
    if (indexed) {
      if (binding.kind === "header") bad = `indexes [0] of ${name}, which is already the header (a destructured insert result)`;
    } else if (binding.kind === "header") {
      // const [res] = await db.insert(...)  →  res.insertId
    } else if (binding.kind === "plain" && /\[\s*0\s*\]\s*$/.test(binding.init ?? "")) {
      // const header = result[0]  →  header.insertId
    } else {
      const lineStart = src.lastIndexOf("\n", dot) + 1;
      const earlier = src.slice(lineStart, dot);
      const fallback = name != null && new RegExp(`\\b${name.replace(/\$/g, "\\$")}\\b[^\\n]*\\[\\s*0\\s*\\]\\s*\\??\\.insertId`).test(earlier);
      if (!fallback) bad = `reads .insertId off ${receiver || "an expression"} without [0]: on mysql2 that is the [header, fields] array`;
    }
    out.push({ at: `${file}:${lineOf(dot)}`, receiver, bad });
  }
  for (const m of Array.from(src.matchAll(/(?:const|let|var)\s*\{[^}]*\binsertId\b[^}]*\}\s*=/g))) {
    out.push({ at: `${file}:${lineOf(m.index!)}`, receiver: m[0], bad: "destructures insertId off the [header, fields] array" });
  }
  return out;
}

const ROOT = join(__dirname, "..");
function serverSources(): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== "node_modules" && e.name !== "__fakes__") walk(p); }
      else if (p.endsWith(".ts") && !p.endsWith(".test.ts") && !p.endsWith(".d.ts")) files.push(p);
    }
  };
  walk(join(ROOT, "server"));
  return files;
}

describe("guard: every insert id is read at the right level", () => {
  const bad = (src: string) => insertIdReads("x.ts", src).filter((r) => r.bad).map((r) => r.bad);

  it("finds no read off the array anywhere in server/ (tests and the helper aside)", () => {
    const all: Read[] = [];
    for (const f of serverSources()) {
      const rel = relative(ROOT, f).replace(/\\/g, "/");
      if (rel === "server/_core/insertId.ts") continue;
      all.push(...insertIdReads(rel, readFileSync(f, "latin1")));
    }
    // The scan saw the codebase, not an empty result from a stripper gone wrong.
    expect(all.length).toBeGreaterThan(60);
    expect(all.filter((r) => r.bad).map((r) => `${r.at}  ${r.bad}`)).toEqual([]);
  });

  it("flags the forms that read the array as if it were the header", () => {
    expect(bad("const r = await db.insert(t).values({});\nreturn { id: Number((r as unknown as { insertId?: number })?.insertId ?? 0) };")).toHaveLength(1);
    expect(bad("const inserted = await db.insert(t).values({\n  a: 1,\n});\nconst draftId = Number((inserted as unknown as { insertId?: number })?.insertId ?? 0);")).toHaveLength(1);
    expect(bad("const r = await db.insert(t).values({});\nreturn r.insertId;")).toHaveLength(1);
    expect(bad("let r;\nr = await db.execute(sql`INSERT INTO t VALUES (1)`);\nreturn (r as any).insertId;")).toHaveLength(1);
    expect(bad("return { id: ((await db.insert(t).values({})) as any).insertId };")).toHaveLength(1);
    expect(bad("const { insertId } = (await db.insert(t).values({})) as any;")).toHaveLength(1);
    // The reverse slip: the destructured header has no [0].
    expect(bad("const [res] = await db.insert(t).values({});\nreturn (res as any)[0]?.insertId;")).toHaveLength(1);
  });

  it("passes the destructured header, an explicit [0], the both-shapes fallback and comments", () => {
    expect(bad("const [res] = await db.insert(t).values({});\nreturn { id: (res as any).insertId as number };")).toEqual([]);
    expect(bad("const [res] = (await db.insert(t).values({})) as any;\nawait audit(Number(res?.insertId ?? 0));")).toEqual([]);
    expect(bad("const [inserted] = await db.insert(t).values({});\nconst id = (inserted as { insertId: number }).insertId;")).toEqual([]);
    expect(bad("const r = await db.insert(t).values({});\nreturn Number((r as any)[0]?.insertId ?? 0);")).toEqual([]);
    expect(bad("const r = await db.insert(t).values({});\nreturn { id: Number((r as unknown as { insertId?: number }[])[0]?.insertId ?? 0) };")).toEqual([]);
    expect(bad("const insertId = (r: unknown) => Number((r as any)?.[0]?.insertId ?? 0);")).toEqual([]);
    expect(bad("const ins = await db.insert(t).values({});\nconst id = Number((ins as any)[0]?.insertId ?? (ins as any)?.insertId ?? 0);")).toEqual([]);
    expect(bad("const header = (await db.insert(t).values({}))[0];\nreturn header.insertId;")).toEqual([]);
    expect(bad("const [{ insertId }] = (await db.insert(t).values({})) as any;")).toEqual([]);
    expect(bad("const r = await db.insert(t).values({});\n// reading r.insertId off it is wrong\n/* r.insertId */\nreturn insertIdOf(r);")).toEqual([]);
  });
});

/* ── 3. the procedures, against mysql2's real shape ────────────────────── */

describe("each new row's id reaches the caller", () => {
  const newest = (t: string) => rows(t).filter((r) => r.workspaceId === WS).at(-1);

  it("the fake answers an insert as mysql2 does: [ResultSetHeader, fields]", async () => {
    const res = await h.db.insert((await import("../drizzle/schema")).savedReports).values({ workspaceId: WS, ownerUserId: REP, name: "x", object: "deals", config: {} });
    expect(Array.isArray(res)).toBe(true);
    expect(res).toHaveLength(2);
    expect(res[0]).toMatchObject({ affectedRows: 1, insertId: 41 });
    expect(Array.isArray(res[1])).toBe(true);
  });

  it("reports.save: a new report's id comes back, so the next Save updates it instead of adding a copy", async () => {
    const spec = { object: "deals" as const, columns: ["name"] };
    const { id } = await caller().reports.save({ name: "Pipeline", spec });
    expect(id).toBe(newest("saved_reports").id);
    expect(id).toBeGreaterThan(0);
    // Reports.tsx keeps that id as loadedId and sends it with the next Save.
    await caller().reports.save({ id, name: "Pipeline (renamed)", spec });
    expect(rows("saved_reports").filter((r) => r.workspaceId === WS).map((r) => r.name)).toEqual(["Pipeline (renamed)"]);
  });

  it("contacts.sendAdHocEmail: the send's log row is joined to its draft, so its opens and clicks can show", async () => {
    rows("contacts").push({ id: 101, workspaceId: WS, firstName: "Ann", lastName: "Lee", email: "ann@client.example", accountId: null, title: null });
    const out = await caller().contacts.sendAdHocEmail({ contactIds: [101], subject: "Hello", body: "Hi {{firstName}}" });
    expect(out).toMatchObject({ results: [expect.objectContaining({ contactId: 101, status: "sent" })] });
    const draft = newest("email_drafts");
    expect(draft).toMatchObject({ toContactId: 101, status: "sent", trackingToken: "mid-1" });
    expect(rows("email_log").find((l) => l.messageId === "mid-1")?.draftId).toBe(draft.id);
  });

  it("leads.sendAdHocEmail: the same join for a lead", async () => {
    rows("leads").push({ id: 201, workspaceId: WS, firstName: "Bo", lastName: "Ng", email: "bo@client.example", title: null, company: "Beta", ownerUserId: REP, status: "new" });
    await caller().leads.sendAdHocEmail({ leadId: 201, subject: "Hello", body: "Hi {{firstName}}" });
    const draft = newest("email_drafts");
    expect(draft).toMatchObject({ toLeadId: 201, status: "sent", trackingToken: "mid-1" });
    expect(rows("email_log").find((l) => l.messageId === "mid-1")?.draftId).toBe(draft.id);
  });

  it("voiceAgents.create: the new agent's id, which the form needs to save its numbers", async () => {
    const { id } = await caller().voiceAgents.create({ name: "Front desk", purpose: "outbound_outreach" });
    expect(id).toBe(newest("voice_agents").id);
    expect(id).toBeGreaterThan(0);
  });

  // Already read off a destructured header; pinned so neither half of the shape slips.
  it("proposals.create", async () => {
    const { id } = await caller().proposals.create({ title: "RFP", clientName: "Client Co" });
    expect(id).toBe(newest("proposals").id);
    expect(id).toBeGreaterThan(0);
  });

  it("emailTemplates.create", async () => {
    const { id } = await caller().emailTemplates.create({ name: "Welcome" });
    expect(id).toBe(newest("email_templates").id);
    expect(id).toBeGreaterThan(0);
  });

  it("helpCenter.startConversation", async () => {
    const { conversationId } = await caller().helpCenter.startConversation();
    expect(conversationId).toBe(newest("ai_help_conversations").id);
    expect(conversationId).toBeGreaterThan(0);
  });

  it("mindmaps.create", async () => {
    const { id } = await caller().mindmaps.create({ name: "Territory plan" });
    expect(id).toBe(newest("mindmaps").id);
    expect(id).toBeGreaterThan(0);
  });

  it("an inbound reply: the owner's notification points at the reply row", async () => {
    await processInboundReply({
      workspaceId: WS, sendingAccountId: 1, userId: REP, fromEmail: "stranger@else.example", fromName: "Stranger",
      subject: "Re: Hello", bodyText: "Tell me more", bodyHtml: "", messageId: "<r1@else.example>", inReplyTo: "", references: "",
      receivedAt: new Date(),
    });
    const reply = newest("email_replies");
    expect(reply.id).toBeGreaterThan(40);
    expect(rows("notifications").find((n) => n.kind === "email_reply")).toMatchObject({ userId: REP, relatedType: "email_reply", relatedId: reply.id });
  });
});
