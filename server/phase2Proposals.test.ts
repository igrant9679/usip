/**
 * Phase 2 of the 2026-10-20 audit, slice C — proposals — against the real
 * router and the SQL-evaluating fake.
 *
 *   accepted once, and only while open and unexpired (R24) · "Accepted" goes
 *   through acceptance; "Create & Link" makes an OPEN deal (R26) · a resend
 *   never moves an accepted proposal back to Sent (R27) · one wording for
 *   extension events, an open request is the latest one (R23) · approving an
 *   extension needs a future date and restores an expired proposal (R68) ·
 *   the portal renders sections as content, not markup (R22).
 *
 * Time is frozen at T0 — Wednesday 2026-11-18, 15:00 UTC (10:00 in New York).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => ({
  db: null as any,
  tz: "America/New_York",
  sent: [] as any[],
  race: null as null | ((table: string) => void),
}));

vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));
vi.mock("./audit", async (a) => ({ ...(await a<typeof import("./audit")>()), recordAudit: async () => {} }));
vi.mock("./services/workspaceTimezone", async (a) => ({
  ...(await a<typeof import("./services/workspaceTimezone")>()),
  getWorkspaceTimezone: async () => h.tz,
}));
vi.mock("./services/outboundPause", async (a) => ({
  ...(await a<typeof import("./services/outboundPause")>()),
  assertOutboundNotPaused: async () => {},
  isOutboundPaused: async () => false,
}));
vi.mock("./emailDelivery", async (a) => ({
  ...(await a<typeof import("./emailDelivery")>()),
  sendWorkspaceEmail: async (_ws: number, m: any) => { h.sent.push(m); return { ok: true }; },
}));
vi.mock("./services/workflowEngine", async (a) => ({
  ...(await a<typeof import("./services/workflowEngine")>()),
  fireStageChanged: async () => {},
  fireRecordCreated: async () => {},
}));
vi.mock("./services/policyNotify", async (a) => ({
  ...(await a<typeof import("./services/policyNotify")>()),
  notifyIfEnabled: async () => true,
}));

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { appRouter } from "./routers";
import { invalidateStageIndex } from "./_core/stageSemantics";
import { EXTENSION_SUBJECT, extensionEventOf, openExtensionRequest } from "@shared/proposalExtension";

const LSI = 2;
const ADMIN = 20;
const REP = 21;
const DAY = 86_400_000;
const T0 = new Date("2026-11-18T15:00:00Z").getTime();

const rows = (t: string) => h.db.rowsOf(t) as any[];
const row = (t: string, id: number) => rows(t).find((r) => r.id === id);

function seed() {
  rows("workspaces").push({ id: LSI, name: "LSI Media", slug: "lsi", ownerUserId: ADMIN, archivedAt: null, plan: "trial" });
  const user = (id: number, mail: string) => ({
    id, openId: `local:${id}`, name: `User ${id}`, email: mail, loginMethod: "password", role: "user",
    passwordHash: `hash-${id}`, createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date(), emailSignature: null,
  });
  rows("users").push(user(ADMIN, "admin@lsi.example"), user(REP, "rep@lsi.example"));
  const member = (id: number, userId: number, role: string) => ({
    id, workspaceId: LSI, userId, role, title: null, quota: null, deactivatedAt: null, lastActiveAt: new Date(),
    inviteToken: null, inviteExpiresAt: null, createdAt: new Date(),
  });
  rows("workspace_members").push(member(1, ADMIN, "admin"), member(2, REP, "rep"));
  rows("crm_pipelines").push({ id: 1, workspaceId: LSI, name: "Default", isDefault: true, sortOrder: 0 });
  rows("crm_pipeline_stages").push(
    { id: 11, workspaceId: LSI, pipelineId: 1, key: "lead_in", label: "Lead in", sortOrder: 10, defaultWinProb: 15, isWon: false, isLost: false },
    { id: 12, workspaceId: LSI, pipelineId: 1, key: "won", label: "Won", sortOrder: 90, defaultWinProb: 100, isWon: true, isLost: false },
  );
  rows("accounts").push({ id: 501, workspaceId: LSI, name: "Acme", archivedAt: null });
  rows("contacts").push({ id: 701, workspaceId: LSI, accountId: 501, firstName: "Ann", lastName: "Lee", email: "ann@acme.example" });
}

function proposal(id: number, over: Record<string, unknown> = {}) {
  rows("proposals").push({
    id, workspaceId: LSI, createdBy: REP, title: `Proposal ${id}`, clientName: "Acme", clientEmail: null,
    status: "sent", shareToken: `tok-${id}`, expiresAt: null, accountId: null, contactId: null, linkedOpportunityId: null,
    budget: "5000.00", acceptedAt: null, sentAt: null, extensionCount: 0, ...over,
  });
}

function caller(userId: number | null) {
  const user = userId == null ? null : rows("users").find((u) => u.id === userId);
  return appRouter.createCaller({
    user,
    req: { protocol: "https", headers: { "x-workspace-id": String(LSI) }, socket: { remoteAddress: "127.0.0.1" } },
    res: { clearCookie: () => {} },
  } as unknown as TrpcContext);
}

async function refusal(p: Promise<unknown>): Promise<{ code: string; message: string }> {
  try { await p; } catch (e: any) { return { code: e.code, message: e.message }; }
  throw new Error("expected a refusal, but it resolved");
}

const followUps = (proposalId: number) => rows("tasks").filter((t) => t.relatedType === "proposal" && t.relatedId === proposalId);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(T0));
  h.db = makeSqlFakeDb({ realMembers: true, beforeUpdate: (t) => h.race?.(t) });
  h.tz = "America/New_York";
  h.sent = [];
  h.race = null;
  invalidateStageIndex();
  seed();
});
afterEach(() => {
  vi.useRealTimers();
});

/* ── R24: acceptance ────────────────────────────────────────────────────── */

describe("a proposal is accepted once, and only while it is open (R24)", () => {
  it("the client accepts a sent proposal once; a second click changes nothing", async () => {
    proposal(1);
    expect(await caller(null).proposals.acceptByToken({ token: "tok-1" })).toMatchObject({ ok: true, alreadyAccepted: false });
    expect(row("proposals", 1).status).toBe("accepted");
    expect(await caller(null).proposals.acceptByToken({ token: "tok-1" })).toEqual({ ok: true, alreadyAccepted: true });
    expect(followUps(1)).toHaveLength(1);
  });

  it("a draft, a declined and an expired proposal cannot be accepted from the link", async () => {
    proposal(1, { status: "draft" });
    proposal(2, { status: "not_accepted" });
    proposal(3, { expiresAt: new Date(T0 - DAY) });
    expect((await refusal(caller(null).proposals.acceptByToken({ token: "tok-1" }))).message).toMatch(/not open for acceptance/);
    expect((await refusal(caller(null).proposals.acceptByToken({ token: "tok-2" }))).message).toMatch(/not open for acceptance/);
    expect((await refusal(caller(null).proposals.acceptByToken({ token: "tok-3" }))).message).toMatch(/expired/);
    expect(rows("proposals").map((p) => p.status)).toEqual(["draft", "not_accepted", "sent"]);
    expect(rows("tasks")).toHaveLength(0);
  });

  it("of two simultaneous accepts, the one that loses runs no side effects", async () => {
    proposal(1);
    h.race = (t) => { if (t === "proposals" && row("proposals", 1).status === "sent") row("proposals", 1).status = "accepted"; };
    expect(await caller(null).proposals.acceptByToken({ token: "tok-1" })).toEqual({ ok: true, alreadyAccepted: true });
    expect(rows("tasks")).toHaveLength(0);
    expect(rows("notifications")).toHaveLength(0);
  });

  it("a rep's accept runs once too", async () => {
    proposal(1);
    await caller(REP).proposals.acceptProposal({ id: 1 });
    expect(await caller(REP).proposals.acceptProposal({ id: 1 })).toMatchObject({ alreadyAccepted: true });
    expect(followUps(1)).toHaveLength(1);
  });
});

/* ── R26: status and deal ───────────────────────────────────────────────── */

describe("Accepted is acceptance, and Create & Link makes an open deal (R26)", () => {
  it("the status picker cannot set Accepted; other statuses still change", async () => {
    proposal(1, { status: "draft" });
    expect((await refusal(caller(REP).proposals.updateStatus({ id: 1, status: "accepted" }))).message).toMatch(/Use Accept/);
    await caller(REP).proposals.updateStatus({ id: 1, status: "under_review" });
    expect(row("proposals", 1).status).toBe("under_review");
  });

  it("creates an open deal in the default pipeline's first stage and leaves the proposal as it was", async () => {
    proposal(1, { status: "draft", contactId: 701 });
    const { opportunityId } = await caller(REP).proposals.createOpportunity({ proposalId: 1 });
    expect(row("opportunities", opportunityId)).toMatchObject({ accountId: 501, stage: "lead_in", pipelineId: 1, value: "5000.00", winProb: 15 });
    expect(row("opportunities", opportunityId).wonAt).toBeNull();
    expect(row("proposals", 1)).toMatchObject({ status: "draft", linkedOpportunityId: opportunityId });
    expect((await refusal(caller(REP).proposals.createOpportunity({ proposalId: 1 }))).code).toBe("CONFLICT");
  });

  it("needs a company to put the deal on", async () => {
    proposal(1);
    expect((await refusal(caller(REP).proposals.createOpportunity({ proposalId: 1 }))).message).toMatch(/Link the proposal to a company/);
  });
});

/* ── R27: resend ────────────────────────────────────────────────────────── */

describe("sending moves only a draft or a revision to Sent (R27)", () => {
  it("a draft becomes Sent; an accepted proposal resent stays accepted", async () => {
    proposal(1, { status: "draft", clientEmail: "ann@acme.example" });
    proposal(2, { status: "accepted", clientEmail: "ann@acme.example" });
    await caller(REP).proposals.sendToClient({ id: 1, origin: "https://app.example" });
    await caller(REP).proposals.sendToClient({ id: 2, origin: "https://app.example" });
    expect(row("proposals", 1).status).toBe("sent");
    expect(row("proposals", 2).status).toBe("accepted");
    expect(row("proposals", 2).sentAt).toBeTruthy(); // the email did go
    expect(h.sent).toHaveLength(2);
  });
});

/* ── R23 + R68: extensions ──────────────────────────────────────────────── */

describe("extension requests (R23, R68)", () => {
  it("one wording, old rows included; open means the latest event is a request", () => {
    expect(extensionEventOf("Client requested an extension")).toBe("requested");
    expect(extensionEventOf("Extension request declined")).toBe("declined");
    expect(extensionEventOf("Extension approved — new expiry: 11/25/2026")).toBe("approved");
    expect(extensionEventOf("Status changed to \"sent\"")).toBeNull();
    const at = (d: number) => new Date(T0 - d * DAY);
    expect(openExtensionRequest([
      { id: 1, subject: EXTENSION_SUBJECT.requested, occurredAt: at(5) },
      { id: 2, subject: `${EXTENSION_SUBJECT.approved} — new expiry: x`, occurredAt: at(4) },
      { id: 3, subject: EXTENSION_SUBJECT.requested, occurredAt: at(1) },
    ])?.id).toBe(3);
    expect(openExtensionRequest([
      { id: 1, subject: EXTENSION_SUBJECT.requested, occurredAt: at(5) },
      { id: 2, subject: EXTENSION_SUBJECT.declined, occurredAt: at(4) },
    ])).toBeNull();
  });

  it("a request is pending until answered, and a second request after an approval is pending again", async () => {
    proposal(1, { status: "not_accepted", expiresAt: new Date(T0 - DAY) });
    await caller(null).proposals.requestExtension({ token: "tok-1", reason: "Board meets next week" });
    expect(rows("activities").at(-1).subject).toBe(EXTENSION_SUBJECT.requested);
    expect((await caller(ADMIN).proposals.listExtensionPending()).map((p) => p.id)).toEqual([1]);
    expect((await caller(null).proposals.getExtensionStatus({ token: "tok-1" })).status).toBe("pending");

    // A week past an expiry that has gone is still the past.
    expect((await refusal(caller(ADMIN).proposals.approveExtension({ proposalId: 1, newExpiresAt: "2026-11-17" }))).message).toMatch(/after today/);
    vi.setSystemTime(new Date(T0 + 60_000));
    await caller(ADMIN).proposals.approveExtension({ proposalId: 1, newExpiresAt: "2026-11-25" });
    // The day lasts to its end in New York, and the expired proposal is back in front of the client.
    expect(row("proposals", 1).expiresAt.toISOString()).toBe("2026-11-26T04:59:59.999Z");
    expect(row("proposals", 1).status).toBe("sent");
    expect(rows("activities").at(-1).subject).toBe("Extension approved — new expiry: 11/25/2026");
    expect(await caller(ADMIN).proposals.listExtensionPending()).toEqual([]);
    expect((await caller(null).proposals.getExtensionStatus({ token: "tok-1" })).status).toBe("approved");

    vi.setSystemTime(new Date(T0 + 120_000));
    await caller(null).proposals.requestExtension({ token: "tok-1", reason: "One more week" });
    expect((await caller(ADMIN).proposals.listExtensionPending()).map((p) => p.id)).toEqual([1]);
    vi.setSystemTime(new Date(T0 + 180_000));
    await caller(ADMIN).proposals.denyExtension({ proposalId: 1, reason: "Final" });
    expect(rows("activities").at(-1).subject).toBe(EXTENSION_SUBJECT.declined);
    expect((await caller(null).proposals.getExtensionStatus({ token: "tok-1" })).status).toBe("denied");
  });

  it("the SLA nudges read the latest extension event, and old wording is rewritten once", () => {
    const tracking = readFileSync(join(__dirname, "emailTracking.ts"), "utf8");
    expect(tracking).toContain("if (openExtensionRequest(proposalActs)?.id !== pendingAct.id) continue;");
    expect(tracking).toContain("if (openExtensionRequest(resActs)?.id !== act72.id) continue;");
    expect(tracking).not.toMatch(/\.select\(\{ id: activities\.id \}\)[\s\S]{0,400}\(a as any\)\.subject/);
    const migrations = readFileSync(join(__dirname, "_core", "rawMigrations.ts"), "utf8");
    expect(migrations).toContain("SET `subject` = 'Extension requested' WHERE `relatedType` = 'proposal' AND `subject` = 'Client requested an extension'");
    expect(migrations).toContain("SET `subject` = 'Extension declined' WHERE `relatedType` = 'proposal' AND `subject` = 'Extension request declined'");
  });
});

/* ── R22: the portal ────────────────────────────────────────────────────── */

describe("the client portal renders sections as content (R22)", () => {
  it("HTML is sanitised and rendered; Markdown is rendered as Markdown", () => {
    const portal = readFileSync(join(__dirname, "..", "client", "src", "pages", "ProposalPortal.tsx"), "utf8");
    expect(portal).toContain("dangerouslySetInnerHTML={{ __html: sanitizeEmailHtml(content) }}");
    expect(portal).toContain("<Streamdown>{content}</Streamdown>");
    expect(portal).toContain("<SectionBody content={content} />");
    expect(portal).not.toContain("whitespace-pre-wrap\">{content}</div>");
  });
});
