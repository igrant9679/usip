/**
 * Proposals and quotes (audit 2026-10-20, batch Rc): R25 · R69 · R70 · R71 ·
 * R91 · R94.
 *
 *   R25 · the wizard names the contact, company and deal, and accepting a
 *         proposal closes the deal it names — never one already closed
 *   R69 · switching sections asks before dropping edits; the AI stream writes
 *         only into the section it started in; an accepted proposal is locked
 *         and its accepted content kept as revisions
 *   R70 · the Send-from picker reads the list the server sends from, in the
 *         order it picks; a load failure is not "Proposal not found"
 *   R91 · an accepted proposal never reads Expired; History shows the
 *         section's text, not its HTML source
 *   R71 · a quote's PDF carries the workspace's name and no status stamp; a
 *         quote past its date reads expired and can't be accepted; Accept and
 *         Reject ask first; no e-signature promise
 *   R94 · a quote with many lines breaks onto new pages
 *
 * Run against the real routers and the SQL-evaluating fake.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => ({
  db: null as any,
  stored: [] as Array<{ key: string; buf: Buffer; type: string }>,
  sent: [] as any[],
  smtp: [] as any[],
}));

vi.mock("./services/outboundPause", async (a) => ({
  ...(await a<typeof import("./services/outboundPause")>()),
  isOutboundPaused: async () => false,
  assertOutboundNotPaused: async () => {},
}));
vi.mock("./emailAdapter", async (a) => ({
  ...(await a<typeof import("./emailAdapter")>()),
  createEmailAdapter: (acc: any) => ({ sendEmail: async (m: any) => { h.sent.push({ accountId: acc.id, ...m }); return { messageId: "m-1" }; } }),
}));
vi.mock("./emailDelivery", async (a) => ({
  ...(await a<typeof import("./emailDelivery")>()),
  sendWorkspaceEmail: async (_ws: number, m: any) => { h.smtp.push(m); return { ok: true }; },
}));

vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));
vi.mock("./audit", async (a) => ({ ...(await a<typeof import("./audit")>()), recordAudit: async () => {} }));
vi.mock("./services/workspaceTimezone", async (a) => ({
  ...(await a<typeof import("./services/workspaceTimezone")>()),
  getWorkspaceTimezone: async () => "America/New_York",
}));
vi.mock("./services/policyNotify", async (a) => ({
  ...(await a<typeof import("./services/policyNotify")>()),
  notifyIfEnabled: async () => true,
}));
vi.mock("./services/workflowEngine", async (a) => ({
  ...(await a<typeof import("./services/workflowEngine")>()),
  fireStageChanged: async () => {},
  fireRecordCreated: async () => {},
  fireRecordUpdated: async () => {},
}));
vi.mock("./storage", async (a) => ({
  ...(await a<typeof import("./storage")>()),
  storagePut: async (key: string, buf: Buffer, type: string) => { h.stored.push({ key, buf, type }); return { key, url: `/manus-storage/${key}` }; },
}));

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { appRouter } from "./routers";
import { invalidateStageIndex } from "./_core/stageSemantics";

const LSI = 2;
const CF = 4;
const ADMIN = 20;
const REP = 21;
const T0 = new Date("2026-11-18T15:00:00Z").getTime();
const DAY = 86_400_000;

const ROOT = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");
/** The text from `start` up to the first `end` after it — throws when either is missing. */
function block(src: string, start: string, end: string): string {
  const i = src.indexOf(start);
  if (i < 0) throw new Error(`anchor not found: ${start}`);
  const j = src.indexOf(end, i + start.length);
  if (j < 0) throw new Error(`end anchor not found after ${start}: ${end}`);
  return src.slice(i, j + end.length);
}

const rows = (t: string) => h.db.rowsOf(t) as any[];
const opp = (id: number) => rows("opportunities").find((r) => r.id === id);

function deal(id: number, over: Record<string, unknown> = {}) {
  rows("opportunities").push({
    id, workspaceId: LSI, accountId: 501, name: `Deal ${id}`, stage: "proposal", value: "5000.00", winProb: 50,
    closeDate: null, daysInStage: 0, stageEnteredAt: new Date(T0 - 10 * DAY), wonAt: null, lostAt: null,
    pipelineId: 1, ownerUserId: REP, createdAt: new Date(T0 - 60 * DAY), updatedAt: new Date(T0 - 3 * DAY),
    ...over,
  });
}

function seed() {
  rows("workspaces").push(
    { id: LSI, name: "LSI Media", slug: "lsi", ownerUserId: ADMIN, archivedAt: null, plan: "trial" },
    { id: CF, name: "CommunityForce", slug: "cf", ownerUserId: 10, archivedAt: null, plan: "trial" },
  );
  const user = (id: number) => ({
    id, openId: `local:${id}`, name: `User ${id}`, email: `u${id}@lsi.example`, loginMethod: "password", role: "user",
    passwordHash: `hash-${id}`, createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date(), emailSignature: null,
  });
  rows("users").push(user(ADMIN), user(REP));
  const member = (id: number, userId: number, role: string) => ({
    id, workspaceId: LSI, userId, role, title: null, quota: null, deactivatedAt: null, lastActiveAt: new Date(),
    inviteToken: null, inviteExpiresAt: null, createdAt: new Date(),
  });
  rows("workspace_members").push(member(1, ADMIN, "admin"), member(2, REP, "rep"));
  rows("crm_pipelines").push({ id: 1, workspaceId: LSI, name: "Default", isDefault: true, sortOrder: 0 });
  const stages = [
    ["discovery", 10, 20, false, false], ["proposal", 30, 50, false, false],
    ["won", 50, 100, true, false], ["lost", 60, 0, false, true],
  ] as const;
  stages.forEach(([key, sortOrder, defaultWinProb, isWon, isLost], i) =>
    rows("crm_pipeline_stages").push({ id: 11 + i, workspaceId: LSI, pipelineId: 1, key, label: key, sortOrder, defaultWinProb, isWon, isLost }));
  rows("accounts").push(
    { id: 501, workspaceId: LSI, name: "Acme", domain: "acme.example" },
    { id: 502, workspaceId: LSI, name: "Gamma", domain: null },
    { id: 601, workspaceId: CF, name: "Other tenant", domain: null },
  );
  rows("contacts").push(
    { id: 701, workspaceId: LSI, accountId: 501, firstName: "Ada", lastName: "Byron", email: "ada@acme.example" },
    { id: 801, workspaceId: CF, accountId: 601, firstName: "Not", lastName: "Ours", email: "x@other.example" },
  );
}

function caller(userId: number, ws = LSI) {
  const user = rows("users").find((u) => u.id === userId);
  return appRouter.createCaller({
    user,
    req: { protocol: "https", headers: { "x-workspace-id": String(ws) }, socket: { remoteAddress: "127.0.0.1" } },
    res: { clearCookie: () => {} },
  } as unknown as TrpcContext);
}
function publicCaller() {
  return appRouter.createCaller({
    user: null,
    req: { protocol: "https", headers: {}, socket: { remoteAddress: "127.0.0.1" } },
    res: { clearCookie: () => {} },
  } as unknown as TrpcContext);
}
async function refusal(p: Promise<unknown>): Promise<{ code: string; message: string }> {
  try { await p; } catch (e: any) { return { code: e.code, message: e.message }; }
  throw new Error("expected a refusal, but it resolved");
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(T0));
  h.db = makeSqlFakeDb({ realMembers: true });
  h.stored = [];
  h.sent = [];
  h.smtp = [];
  invalidateStageIndex();
  seed();
});
afterEach(() => { vi.useRealTimers(); });

/* ── R25 ────────────────────────────────────────────────────────────────── */

describe("R25: a proposal made in the wizard closes the deal it names", () => {
  it("create keeps the contact, takes their company, and links the deal picked", async () => {
    deal(1);
    const { id } = await caller(REP).proposals.create({ title: "Acme renewal", clientName: "Acme", contactId: 701, linkedOpportunityId: 1, budget: 8000 });
    const p = rows("proposals").find((r) => r.id === id);
    expect(p).toMatchObject({ contactId: 701, accountId: 501, linkedOpportunityId: 1 });
  });

  it("a deal alone brings its company", async () => {
    deal(1, { accountId: 502 });
    const { id } = await caller(REP).proposals.create({ title: "Gamma", clientName: "Gamma", linkedOpportunityId: 1 });
    expect(rows("proposals").find((r) => r.id === id)).toMatchObject({ accountId: 502, linkedOpportunityId: 1 });
  });

  it("refuses another workspace's deal, contact or company, and a deal of a different company", async () => {
    rows("opportunities").push({ id: 99, workspaceId: CF, accountId: 601, name: "Theirs", stage: "proposal", value: "1", pipelineId: null });
    deal(1, { accountId: 502 });
    const rep = caller(REP);
    expect((await refusal(rep.proposals.create({ title: "x", clientName: "x", linkedOpportunityId: 99 }))).code).toBe("NOT_FOUND");
    expect((await refusal(rep.proposals.create({ title: "x", clientName: "x", contactId: 801 }))).code).toBe("NOT_FOUND");
    expect((await refusal(rep.proposals.create({ title: "x", clientName: "x", accountId: 601 }))).code).toBe("NOT_FOUND");
    expect((await refusal(rep.proposals.create({ title: "x", clientName: "x", accountId: 501, linkedOpportunityId: 1 }))).code).toBe("BAD_REQUEST");
    expect(rows("proposals")).toHaveLength(0);
  });

  it("accepting a wizard-made proposal closes its deal won", async () => {
    deal(1);
    const rep = caller(REP);
    const { id } = await rep.proposals.create({ title: "Acme renewal", clientName: "Acme", contactId: 701, linkedOpportunityId: 1, budget: 8000 });
    rows("proposals").find((r) => r.id === id).status = "sent";
    const res = await rep.proposals.acceptProposal({ id });
    expect(res.opportunityId).toBe(1);
    expect(opp(1)).toMatchObject({ stage: "won", value: "8000", winProb: 100 });
    expect(rows("opportunities")).toHaveLength(1);
  });

  it("a linked deal that is already lost stays lost, on either accept", async () => {
    deal(1, { stage: "lost", winProb: 0, lostAt: new Date(T0 - 5 * DAY) });
    rows("proposals").push(
      { id: 901, workspaceId: LSI, title: "Late yes", clientName: "Acme", budget: "8000.00", linkedOpportunityId: 1, accountId: 501, status: "sent", shareToken: "tok-901" },
      { id: 902, workspaceId: LSI, title: "Late yes 2", clientName: "Acme", budget: "8000.00", linkedOpportunityId: 1, accountId: 501, status: "sent", shareToken: "tok-902" },
    );
    await caller(REP).proposals.acceptProposal({ id: 901 });
    await publicCaller().proposals.acceptByToken({ token: "tok-902" });
    expect(opp(1)).toMatchObject({ stage: "lost", value: "5000.00", winProb: 0, wonAt: null });
    expect(rows("opportunity_stage_history")).toHaveLength(0);
    // And no second, won deal is made beside it.
    expect(rows("opportunities")).toHaveLength(1);
  });

  it("a linked deal already won keeps the day it was won and its value", async () => {
    const wonAt = new Date(T0 - 20 * DAY);
    deal(1, { stage: "won", winProb: 100, wonAt, value: "4000.00" });
    rows("proposals").push({ id: 903, workspaceId: LSI, title: "Again", clientName: "Acme", budget: "9000.00", linkedOpportunityId: 1, accountId: 501, status: "sent", shareToken: "tok-903" });
    await caller(REP).proposals.acceptProposal({ id: 903 });
    expect(opp(1).wonAt.getTime()).toBe(wonAt.getTime());
    expect(opp(1).value).toBe("4000.00");
  });

  it("the deal picker lists the company's open deals only, in this workspace", async () => {
    deal(1);
    deal(2, { stage: "won", winProb: 100 });
    deal(3, { stage: "lost", winProb: 0 });
    deal(4, { accountId: 502 });
    rows("opportunities").push({ id: 99, workspaceId: CF, accountId: 501, name: "Theirs", stage: "proposal", value: "1", pipelineId: null, updatedAt: new Date() });
    const options = await caller(REP).proposals.dealOptions({ accountId: 501 });
    expect(options.map((o: any) => o.id)).toEqual([1]);
  });

  it("the wizard sends the contact, the company and the picked deal", () => {
    const src = read("client/src/pages/usip/Proposals.tsx");
    const submit = block(src, "function handleSubmit() {", "\n  }\n");
    expect(submit).toContain("contactId: linkedContact?.id");
    expect(submit).toContain("accountId: selectedContactAccountId ?? undefined");
    expect(submit).toContain("linkedOpportunityId: dealId ?? undefined");
    expect(src).toContain("trpc.proposals.dealOptions.useQuery(");
  });
});

/* ── R69 ────────────────────────────────────────────────────────────────── */

describe("R69: the proposal editor keeps what was written, where it was written", () => {
  function proposal(id: number, status: string) {
    rows("proposals").push({ id, workspaceId: LSI, title: `P${id}`, clientName: "Acme", budget: null, linkedOpportunityId: null, accountId: null, status, shareToken: `tok-${id}`, createdBy: REP });
    rows("proposal_sections").push({ id: id * 10, proposalId: id, sectionKey: "pricing", content: "<p>$10,000 flat</p>" });
  }

  it("an accepted proposal's content is locked on the server", async () => {
    proposal(910, "accepted");
    rows("proposal_revisions").push({ id: 1, proposalId: 910, sectionKey: "pricing", content: "<p>old</p>", savedByUserId: REP, savedByName: "x", createdAt: new Date() });
    const rep = caller(REP);
    expect((await refusal(rep.proposals.updateSection({ proposalId: 910, sectionKey: "pricing", content: "<p>$1</p>" }))).code).toBe("BAD_REQUEST");
    expect((await refusal(rep.proposals.restoreRevision({ revisionId: 1 }))).code).toBe("BAD_REQUEST");
    expect(rows("proposal_sections").find((s) => s.proposalId === 910).content).toBe("<p>$10,000 flat</p>");
  });

  it("a draft is still editable", async () => {
    proposal(911, "draft");
    await caller(REP).proposals.updateSection({ proposalId: 911, sectionKey: "pricing", content: "<p>$12,000</p>" });
    expect(rows("proposal_sections").find((s) => s.proposalId === 911).content).toBe("<p>$12,000</p>");
  });

  it("accepting keeps the accepted content as revisions, on either path", async () => {
    proposal(912, "sent");
    proposal(913, "sent");
    await caller(REP).proposals.acceptProposal({ id: 912 });
    await publicCaller().proposals.acceptByToken({ token: "tok-913" });
    const kept = rows("proposal_revisions").filter((r) => r.savedByName === "Accepted version");
    expect(kept.map((r) => [r.proposalId, r.sectionKey, r.content])).toEqual([
      [912, "pricing", "<p>$10,000 flat</p>"],
      [913, "pricing", "<p>$10,000 flat</p>"],
    ]);
  });

  const src = () => read("client/src/pages/usip/ProposalDetail.tsx");
  const contentTab = () => block(src(), "function ContentTab(", "\n// ── Timeline Tab");

  it("switching section asks before dropping unsaved edits or a running draft", () => {
    const tab = contentTab();
    expect(tab).toContain("onClick={() => switchSection(s.key)}");
    expect(tab).not.toContain("onClick={() => { setActiveSection(s.key); setEditContent(null); }}");
    const sw = block(tab, "function switchSection(key: string) {", "\n  }\n");
    expect(sw).toContain("if (!dirty && !generating) { go(); return; }");
    expect(sw).toContain("confirmAction(");
    expect(sw).toContain("abortRef.current?.abort();");
  });

  it("the AI stream writes only into the section it was started for", () => {
    const gen = block(contentTab(), "async function handleGenerate() {", "\n  function handleStop()");
    expect(gen).toContain("const sectionKey = activeSection;");
    expect(gen).toContain("/section/${sectionKey}/stream");
    expect(gen).toContain("if (streamSectionRef.current === sectionKey && !controller.signal.aborted) setEditContent(accumulated);");
  });

  it("a save records the section it saved, and an accepted proposal is read-only", () => {
    const tab = contentTab();
    const save = block(tab, "const updateSection = trpc.proposals.updateSection.useMutation({", "\n  });");
    expect(save).toContain("sectionKey: vars.sectionKey, content: vars.content");
    expect(tab).toContain(`const locked = proposal.status === "accepted";`);
    expect(tab).toContain("disabled={locked}");
    expect(tab).toContain("disabled={generating || locked}");
  });
});

/* ── R70 ────────────────────────────────────────────────────────────────── */

describe("R70: Send from lists what the send uses, and a failed load says so", () => {
  function mailbox(id: number, over: Record<string, unknown> = {}) {
    rows("sending_accounts").push({ id, workspaceId: LSI, name: `Box ${id}`, fromEmail: `box${id}@lsi.example`, fromName: null, provider: "smtp", enabled: true, unipileAccountId: null, ...over });
  }
  beforeEach(() => {
    rows("proposals").push({ id: 920, workspaceId: LSI, title: "P", clientName: "Acme", clientEmail: "buyer@acme.example", status: "draft", shareToken: "tok-920", createdBy: REP, orgAbbr: null });
  });

  it("the picker's list is the workspace's enabled mailboxes, in the order the send picks", async () => {
    mailbox(7, { name: "Zed" });
    mailbox(5, { name: "Yan" });
    mailbox(6, { name: "Abe", enabled: false });
    rows("sending_accounts").push({ id: 4, workspaceId: CF, name: "Theirs", fromEmail: "x@other.example", enabled: true });
    const list = await caller(REP).proposals.listSendingAccounts();
    expect(list.map((a: any) => a.id)).toEqual([5, 7]);
    await caller(REP).proposals.sendToClient({ id: 920, origin: "https://app.example" });
    // "Auto" is the first row of that list.
    expect(h.sent.map((m) => m.accountId)).toEqual([5]);
  });

  it("a picked mailbox that is disabled is refused, not swapped for the workspace SMTP", async () => {
    mailbox(5);
    mailbox(6, { enabled: false });
    expect((await refusal(caller(REP).proposals.sendToClient({ id: 920, origin: "https://app.example", sendingAccountId: 6 }))).code).toBe("BAD_REQUEST");
    expect(h.sent).toHaveLength(0);
    expect(h.smtp).toHaveLength(0);
    expect(rows("proposals").find((p) => p.id === 920).status).toBe("draft");
  });

  it("the Share tab reads that list, and a failed load is not 'Proposal not found'", () => {
    const src = read("client/src/pages/usip/ProposalDetail.tsx");
    const share = block(src, "function ShareTab(", "\n  const generateLink");
    expect(share).toContain("trpc.proposals.listSendingAccounts.useQuery()");
    expect(share).not.toContain("trpc.sendingAccounts.list.useQuery()");
    const page = block(src, "export default function ProposalDetail()", "if (!data) {");
    expect(page).toContain("if (error && !isNotFoundError(error)) {");
    expect(page).toContain(`<QueryError what="this proposal" message={error.message} onRetry={() => refetch()} />`);
  });
});

/* ── R91 ────────────────────────────────────────────────────────────────── */

describe("R91: accepted is never Expired, and History shows the text", () => {
  it("the list flags an open proposal past its date, not an accepted one", async () => {
    const past = new Date(T0 - 2 * DAY);
    const base = { workspaceId: LSI, createdBy: REP, updatedAt: new Date(T0), sentAt: null, emailOpenedAt: null, emailClickedAt: null };
    rows("proposals").push(
      { ...base, id: 930, title: "Won", clientName: "A", status: "accepted", expiresAt: past },
      { ...base, id: 931, title: "Out", clientName: "B", status: "sent", expiresAt: past },
      { ...base, id: 932, title: "Soon", clientName: "C", status: "accepted", expiresAt: new Date(T0 + 2 * DAY) },
    );
    const list = await caller(ADMIN).proposals.list();
    const by = (id: number) => list.find((p: any) => p.id === id) as any;
    expect(by(930)).toMatchObject({ isExpired: false, isExpiringSoon: false });
    expect(by(931)).toMatchObject({ isExpired: true });
    expect(by(932)).toMatchObject({ isExpiringSoon: false });
  });

  it("the detail page's expiry card and History render accordingly", () => {
    const src = read("client/src/pages/usip/ProposalDetail.tsx");
    const card = block(src, "{proposal.expiresAt && (() => {", "})()}");
    expect(card).toContain("const isExpired = !accepted && msLeft < 0;");
    const rev = block(src, "function ExpandedRevision(", "\nfunction HistoryTab(");
    expect(rev).toContain("dangerouslySetInnerHTML={{ __html: sanitizeEmailHtml(rev.content) }}");
    expect(rev).not.toContain("<pre className");
  });
});

/* ── R71 · R94: quotes ──────────────────────────────────────────────────── */

/** Each page's text, from an uncompressed pdfkit file. */
function pdfPages(buf: Buffer): string[] {
  const s = buf.toString("latin1");
  const streams = Array.from(s.matchAll(/stream\n([\s\S]*?)\nendstream/g), (m) => m[1]).filter((c) => c.includes(" Tf"));
  return streams.map((c) => Array.from(c.matchAll(/\[([^\]]*)\] TJ/g), (tj) =>
    Array.from(tj[1].matchAll(/<([0-9a-f]*)>/g), (x) => Buffer.from(x[1], "hex").toString("latin1")).join("")).join("|"));
}

describe("R71 · R94: a quote says who it is from, expires, and fits its pages", () => {
  const quote = (over: Record<string, unknown> = {}) => ({
    quoteNumber: "Q-1700000000000", createdAt: new Date(T0), expiresAt: new Date(T0 + 30 * DAY),
    subtotal: "100.00", discountTotal: "0.00", taxTotal: "0.00", total: "100.00", notes: null, terms: null, ...over,
  });
  const line = (i: number) => ({ name: `Line item ${String(i).padStart(2, "0")}`, description: i % 3 === 0 ? "Includes onboarding and a quarterly review" : null, quantity: 1, unitPrice: `${1000 + i}.00`, discountPct: "0", lineTotal: `${1000 + i}.00` });

  it("the PDF carries the workspace's name and dates, and no USIP or status stamp", async () => {
    const { renderQuotePdf } = await import("./routers/operations");
    const [page] = pdfPages(await renderQuotePdf(quote(), [line(1)], { workspaceName: "LSI Media", timeZone: "America/New_York", compress: false }));
    expect(page).toContain("LSI Media");
    expect(page).toContain("Valid until: Dec 18, 2026");
    expect(page).not.toContain("USIP");
    expect(page).not.toMatch(/Status:|DRAFT/);
  });

  it("six- and seven-figure amounts print on one line", async () => {
    const { renderQuotePdf } = await import("./routers/operations");
    const big = { ...line(1), unitPrice: "123456.78", lineTotal: "123456.78" };
    const [page] = pdfPages(await renderQuotePdf(quote({ subtotal: "9876543.21", total: "9876543.21" }), [big], { workspaceName: "LSI Media", timeZone: "UTC", compress: false }));
    expect(page).toContain("|$123,456.78|");
    expect(page).toContain("|$9,876,543.21");
  });

  it("sixty lines break onto pages that each hold whole rows", async () => {
    const { renderQuotePdf } = await import("./routers/operations");
    const lines = Array.from({ length: 60 }, (_, i) => line(i + 1));
    const pages = pdfPages(await renderQuotePdf(quote({ total: "61830.00" }), lines, { workspaceName: "LSI Media", timeZone: "UTC", compress: false }));
    expect(pages.length).toBeGreaterThanOrEqual(2);
    expect(pages.length).toBeLessThanOrEqual(4);
    for (const l of lines) {
      // A row's name and its own total are on one page.
      const at = pages.filter((p) => p.includes(l.name));
      expect(at).toHaveLength(1);
      expect(at[0]).toContain(`$${(1000 + Number(l.name.slice(-2))).toLocaleString("en-US")}.00`);
    }
    // Every page after the first repeats the column header.
    for (const p of pages.slice(1)) if (lines.some((l) => p.includes(l.name))) expect(p).toContain("ITEM");
    // The totals come after the last row.
    expect(pages[pages.length - 1]).toContain("$61,830.00");
  });

  function seedQuote(id: number, over: Record<string, unknown>) {
    rows("quotes").push({ id, workspaceId: LSI, opportunityId: 1, quoteNumber: `Q-${id}`, status: "sent", expiresAt: new Date(T0 + DAY), total: "100.00", createdAt: new Date(T0 - DAY), ...over });
  }

  it("a quote past its date reads expired, and can't be sent or accepted", async () => {
    seedQuote(1, { status: "sent", expiresAt: new Date(T0 - 1000) });
    seedQuote(2, { status: "draft", expiresAt: new Date(T0 - DAY) });
    seedQuote(3, { status: "sent", expiresAt: new Date(T0 + DAY) });
    seedQuote(4, { status: "accepted", expiresAt: new Date(T0 - DAY) });
    rows("quotes").push({ id: 5, workspaceId: CF, opportunityId: 9, quoteNumber: "Q-5", status: "sent", expiresAt: new Date(T0 - DAY), total: "1", createdAt: new Date() });
    const rep = caller(REP);
    const list = await rep.quotes.list();
    const st = (id: number) => list.find((q: any) => q.id === id)?.status;
    expect([st(1), st(2), st(3), st(4)]).toEqual(["expired", "expired", "sent", "accepted"]);
    // Another workspace's quote is not touched.
    expect(rows("quotes").find((q) => q.id === 5).status).toBe("sent");
    expect((await refusal(rep.quotes.setStatus({ id: 1, status: "accepted" }))).message).toMatch(/expired/);
    expect((await refusal(rep.quotes.send({ id: 2 }))).message).toMatch(/expired/);
    await rep.quotes.setStatus({ id: 1, status: "rejected" });
    expect(rows("quotes").find((q) => q.id === 1).status).toBe("rejected");
  });

  it("an unread lapsed quote is refused too, before any list has flipped it", async () => {
    seedQuote(6, { status: "sent", expiresAt: new Date(T0 - 1000) });
    expect((await refusal(caller(REP).quotes.setStatus({ id: 6, status: "accepted" }))).code).toBe("BAD_REQUEST");
    expect(rows("quotes").find((q) => q.id === 6).status).toBe("sent");
  });

  it("Accept and Reject ask first, and no e-signature is promised", () => {
    // 2026-11-07 (audit F34, batch CRMD): the Quotes page is retired; a quote
    // is a proposal's pricing, and the client's answer is the proposal's
    // (Accept with an e-signature record, Decline, Request changes — each
    // confirmed on the portal). Accepting the proposal records its current
    // pricing as accepted. The pricing tab offers no one-click answer and
    // promises no e-signature of its own.
    const src = read("client/src/components/usip/ProposalPricing.tsx");
    expect(src).not.toMatch(/setStatus|e-signature/i);
    expect(read("server/routers/proposals.ts")).toContain("await acceptCurrentPricing(db, ctx.workspace.id, input.id);");
  });
});
