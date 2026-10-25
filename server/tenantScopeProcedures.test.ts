/**
 * Every procedure the 2026-10-20 audit's C1 and C4–C9 named, called from one
 * workspace with ANOTHER workspace's ids — against the real routers and an
 * in-memory database that evaluates the SQL they render (`__fakes__/sqlFakeDb`),
 * so a missing `workspaceId = ?` is a row that leaks, not a condition object
 * that merely looks right.
 *
 * `tenantScope.test.ts` is the static half: it reads every UPDATE and DELETE
 * whose WHERE a caller can steer. It could not see these bugs, because most of
 * them were READS (prospect, dossier, campaign, customer, contact email) or
 * writes whose WHERE was scoped while their SET was not (the C7 patches). This
 * file asks the behavioural question instead: called with a stranger's id, does
 * the procedure refuse, and is the stranger's data exactly as it was?
 *
 * Each refusal sits beside a control that makes the same call with the
 * caller's OWN ids and gets past the check — without it, a procedure that
 * refused everything (or a fake that threw on the first query) would pass.
 *
 * Workspaces: LSI Media = 2 (the caller), CommunityForce = 4 (the other tenant).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => ({
  db: null as any,
  sent: [] as { workspaceId: number; to: string; subject: string; html: string }[],
  llmCalls: 0,
  transports: [] as { host: string; port: number; username: string; password: string }[],
}));

vi.mock("./db", async (importActual) => ({
  ...(await importActual<typeof import("./db")>()),
  getDb: async () => h.db,
}));
vi.mock("./audit", async (importActual) => ({
  ...(await importActual<typeof import("./audit")>()),
  recordAudit: async () => {},
}));
vi.mock("./emailDelivery", async (importActual) => ({
  ...(await importActual<typeof import("./emailDelivery")>()),
  sendSystemEmail: async (workspaceId: number, msg: { to: string; subject: string; html: string }) => {
    h.sent.push({ workspaceId, ...msg });
    return { ok: true };
  },
}));
vi.mock("./_core/llm", async (importActual) => ({
  ...(await importActual<typeof import("./_core/llm")>()),
  invokeLLM: async () => {
    h.llmCalls++;
    return { choices: [{ message: { content: JSON.stringify({ wins: [], risks: [], asks: [], agenda: [] }) } }] };
  },
}));
vi.mock("./sendLimits", async (importActual) => ({
  ...(await importActual<typeof import("./sendLimits")>()),
  accountsSentToday: async () => new Map<number, number>(),
}));
vi.mock("./services/sendgridKey", async (importActual) => ({
  ...(await importActual<typeof import("./services/sendgridKey")>()),
  getWorkspaceSendgridKey: async () => null,
}));
// The SMTP test refuses internal hosts by resolving them (ssrfGuard). The
// mailboxes here use reserved .example names, which do not resolve — treat
// those as public, and let everything else through the real check.
vi.mock("./services/scraper/ssrfGuard", async (importActual) => {
  const actual = await importActual<typeof import("./services/scraper/ssrfGuard")>();
  return { ...actual, assertPublicHost: async (h: string) => (/\.example$/.test(h) ? undefined : actual.assertPublicHost(h)) };
});
vi.mock("./routers/smtpConfig", async (importActual) => ({
  ...(await importActual<typeof import("./routers/smtpConfig")>()),
  buildTransporter: (o: { host: string; port: number; username: string; password: string }) => {
    h.transports.push({ host: o.host, port: o.port, username: o.username, password: o.password });
    return { verify: async () => true };
  },
}));

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { appRouter } from "./routers";
import { processSignal, promoteProspectToCrm } from "./routers/are/execution";
import { ensureCustomerForWonOpp } from "./services/wonToCustomer";

const LSI = 2;
const CF = 4;
const FUTURE = () => new Date(Date.now() + 7 * 86_400_000);

/** User ids. */
const ADMIN = 20; // admin of LSI Media
const REP = 21; // rep in LSI Media
const LOCAL = 30; // rep in LSI Media, and nowhere else
const VICTIM = 10; // super_admin of CommunityForce, a real account with a password and 2FA

function seed() {
  const db = h.db;
  db.rowsOf("workspaces").push(
    { id: LSI, name: "LSI Media", slug: "lsi", ownerUserId: ADMIN, archivedAt: null, plan: "trial" },
    { id: CF, name: "CommunityForce", slug: "cf", ownerUserId: VICTIM, archivedAt: null, plan: "trial" },
  );
  const user = (id: number, email: string, over: Record<string, unknown> = {}) => ({
    id, openId: `local:${id}`, name: `User ${id}`, email, loginMethod: "password", role: "user",
    passwordHash: `hash-of-${id}`, mfaTotpSecret: null, mfaTotpEnabledAt: null,
    createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date(), ...over,
  });
  db.rowsOf("users").push(
    user(ADMIN, "admin@lsi.example"),
    user(REP, "rep@lsi.example"),
    user(LOCAL, "local@lsi.example"),
    user(VICTIM, "victim@cf.example", { mfaTotpSecret: "VICTIMSECRET", mfaTotpEnabledAt: new Date() }),
  );
  const member = (id: number, workspaceId: number, userId: number, role: string, over: Record<string, unknown> = {}) => ({
    id, workspaceId, userId, role, title: null, quota: null, deactivatedAt: null, lastActiveAt: new Date(),
    notifEmail: null, notifPrefs: null, inviteToken: null, inviteExpiresAt: null, createdAt: new Date(), ...over,
  });
  db.rowsOf("workspace_members").push(
    member(1, LSI, ADMIN, "admin"),
    member(2, LSI, REP, "rep"),
    member(3, CF, VICTIM, "super_admin"),
    member(4, LSI, LOCAL, "rep"),
  );
}

function caller(userId: number, ws: number) {
  const user = h.db.rowsOf("users").find((u: any) => u.id === userId);
  return appRouter.createCaller({
    user,
    req: { protocol: "https", headers: { "x-workspace-id": String(ws) }, socket: { remoteAddress: "127.0.0.1" } },
    res: { clearCookie: () => {} },
  } as unknown as TrpcContext);
}

async function refusal(p: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await p;
  } catch (e: any) {
    return { code: e.code, message: e.message };
  }
  throw new Error("expected the procedure to refuse, but it resolved");
}

const rows = (t: string) => h.db.rowsOf(t) as any[];
const row = (t: string, id: number) => rows(t).find((r) => r.id === id);
const snapshot = (t: string, id: number) => JSON.stringify(row(t, id));

beforeEach(() => {
  h.db = makeSqlFakeDb({ realMembers: true });
  h.sent = [];
  h.llmCalls = 0;
  h.transports = [];
  seed();
});

/* ─── C1 — account-level edits on someone whose account lives elsewhere ──── */

describe("C1: an admin cannot take over an account through team.invite", () => {
  async function inviteVictim() {
    const out = await caller(ADMIN, LSI).team.invite({ email: "victim@cf.example", role: "rep", sendEmail: false, returnLink: true, origin: "https://getvelocityai.app" });
    const m = rows("workspace_members").find((r) => r.workspaceId === LSI && r.userId === VICTIM);
    expect(m, "the invite writes a pending membership").toBeTruthy();
    expect(m.inviteToken).toBeTruthy();
    return { member: m, token: m.inviteToken as string, out };
  }

  it("setMemberPassword is refused for the invited victim, and the password is unchanged", async () => {
    const { member } = await inviteVictim();
    const before = row("users", VICTIM).passwordHash;
    const r = await refusal(caller(ADMIN, LSI).team.setMemberPassword({ memberId: member.id, password: "attacker-chosen-1" }));
    expect(r.code).toBe("FORBIDDEN");
    expect(r.message).toMatch(/reset link/);
    expect(row("users", VICTIM).passwordHash).toBe(before);
  });

  it("resetMemberMfa is refused, and the victim's authenticator stays enrolled", async () => {
    const { member } = await inviteVictim();
    const r = await refusal(caller(ADMIN, LSI).team.resetMemberMfa({ memberId: member.id }));
    expect(r.code).toBe("FORBIDDEN");
    expect(row("users", VICTIM).mfaTotpSecret).toBe("VICTIMSECRET");
  });

  it("updateMember cannot change the victim's login email or name — but a role change still saves", async () => {
    const { member } = await inviteVictim();
    const r = await refusal(caller(ADMIN, LSI).team.updateMember({ memberId: member.id, email: "attacker@evil.example" }));
    expect(r.code).toBe("FORBIDDEN");
    expect(row("users", VICTIM).email).toBe("victim@cf.example");
    expect((await refusal(caller(ADMIN, LSI).team.updateMember({ memberId: member.id, name: "Renamed" }))).code).toBe("FORBIDDEN");
    // The Team dialog sends name and email on every save; unchanged values are not account edits.
    await caller(ADMIN, LSI).team.updateMember({ memberId: member.id, name: "User 10", email: "Victim@CF.example", title: "Partner" });
    expect(row("workspace_members", member.id).title).toBe("Partner");
  });

  it("the alternative is a reset link — and it goes to the victim's own inbox, not to the admin", async () => {
    const { member } = await inviteVictim();
    const out = await caller(ADMIN, LSI).team.sendPasswordReset({ memberId: member.id });
    expect(out).toEqual({ ok: true });
    expect(h.sent.map((m) => m.to)).toEqual(["victim@cf.example"]);
    // Sent through the victim's OWN workspace's sender — never through the one
    // that merely invited them, whose admins configure its transport.
    expect(h.sent[0].workspaceId).toBe(CF);
    // …and the sending workspace's Emails page records that a reset went out,
    // not the link that is the credential.
    expect((h.sent[0] as any).logPreview).toMatch(/link withheld/);
    expect((h.sent[0] as any).logPreview).not.toMatch(/reset-password|token=/);
    expect(h.sent[0].html).toMatch(/reset-password\?token=/);
    expect(JSON.stringify(out)).not.toMatch(/token|reset-password/);
    expect(row("users", VICTIM).passwordResetTokenHash, "the token is stored hashed").toMatch(/^[0-9a-f]{64}$/);
  });

  it("an invitation is not a membership: the victim cannot be steered into LSI Media until they accept it", async () => {
    const { token } = await inviteVictim();
    const before = await caller(VICTIM, LSI).workspace.current();
    expect(before.workspace.id, "a pending invite must not resolve as the active workspace").toBe(CF);
    await caller(VICTIM, LSI).team.finaliseAcceptance({ token });
    const after = await caller(VICTIM, LSI).workspace.current();
    expect(after.workspace.id).toBe(LSI);
  });

  it("another account carrying the victim's email cannot accept the invite or set the victim's password", async () => {
    const { token } = await inviteVictim();
    rows("users").push({ id: 40, openId: "local:40", email: "victim@cf.example", name: "Twin", loginMethod: "password", role: "user", passwordHash: "x" });
    expect((await refusal(caller(40, LSI).team.finaliseAcceptance({ token }))).code).toBe("FORBIDDEN");
    expect((await refusal(caller(40, LSI).team.setInvitePassword({ token, password: "attacker-chosen-1" }))).code).toBe("FORBIDDEN");
    expect(row("users", VICTIM).passwordHash).toBe(`hash-of-${VICTIM}`);
    expect(rows("workspace_members").find((r) => r.inviteToken === token), "the invite is still pending").toBeTruthy();
  });

  it("markInviteAccepted cannot accept on the victim's behalf", async () => {
    const { member, token } = await inviteVictim();
    expect((await refusal(caller(ADMIN, LSI).team.markInviteAccepted({ memberId: member.id }))).code).toBe("BAD_REQUEST");
    expect(row("workspace_members", member.id).inviteToken).toBe(token);
  });

  it("accepting the invite does not make a shared account the admin's: it still lives in CommunityForce", async () => {
    const { member, token } = await inviteVictim();
    await caller(VICTIM, LSI).team.finaliseAcceptance({ token });
    expect(row("workspace_members", member.id).inviteToken).toBeNull();
    expect((await refusal(caller(ADMIN, LSI).team.setMemberPassword({ memberId: member.id, password: "attacker-chosen-1" }))).code).toBe("FORBIDDEN");
    expect((await refusal(caller(ADMIN, LSI).team.resetMemberMfa({ memberId: member.id }))).code).toBe("FORBIDDEN");
    expect((await refusal(caller(ADMIN, LSI).team.updateMember({ memberId: member.id, email: "attacker@evil.example" }))).code).toBe("FORBIDDEN");
    expect(row("users", VICTIM)).toMatchObject({ passwordHash: `hash-of-${VICTIM}`, mfaTotpSecret: "VICTIMSECRET", email: "victim@cf.example" });
  });

  it("an invitee who has not accepted yet is not the admin's to edit, even when this is their only workspace", async () => {
    await caller(ADMIN, LSI).team.invite({ email: "brand-new@example.com", role: "rep", sendEmail: false, origin: "https://getvelocityai.app" });
    const placeholder = rows("users").find((u) => u.email === "brand-new@example.com");
    const m = rows("workspace_members").find((r) => r.userId === placeholder.id);
    expect(m.inviteToken, "pending").toBeTruthy();
    expect((await refusal(caller(ADMIN, LSI).team.setMemberPassword({ memberId: m.id, password: "admin-chosen-1" }))).code).toBe("FORBIDDEN");
    expect(row("users", placeholder.id).passwordHash ?? null).toBeNull();
  });

  it("control: an account that lives only in LSI Media can still be edited by its admin", async () => {
    await caller(ADMIN, LSI).team.setMemberPassword({ memberId: 4, password: "a-new-password" });
    expect(row("users", LOCAL).passwordHash).toMatch(/^\$2[aby]\$/);
    rows("users").find((u) => u.id === LOCAL).mfaTotpSecret = "LOCALSECRET";
    await caller(ADMIN, LSI).team.resetMemberMfa({ memberId: 4 });
    expect(row("users", LOCAL).mfaTotpSecret).toBeNull();
    await caller(ADMIN, LSI).team.updateMember({ memberId: 4, email: "renamed@lsi.example" });
    expect(row("users", LOCAL).email).toBe("renamed@lsi.example");
  });

  it("updateMember refuses an email another account already uses", async () => {
    const r = await refusal(caller(ADMIN, LSI).team.updateMember({ memberId: 4, email: "victim@cf.example" }));
    expect(r.code).toBe("BAD_REQUEST");
    expect(row("users", LOCAL).email).toBe("local@lsi.example");
  });

  it("a member id from the other workspace is simply not found", async () => {
    for (const call of [
      () => caller(ADMIN, LSI).team.setMemberPassword({ memberId: 3, password: "attacker-chosen-1" }),
      () => caller(ADMIN, LSI).team.resetMemberMfa({ memberId: 3 }),
      () => caller(ADMIN, LSI).team.updateMember({ memberId: 3, email: "attacker@evil.example" }),
      () => caller(ADMIN, LSI).team.sendPasswordReset({ memberId: 3 }),
    ]) {
      expect((await refusal(call())).code).toBe("NOT_FOUND");
    }
    expect(h.sent).toEqual([]);
  });
});

/* ─── C4 — mailbox credentials ─────────────────────────────────────────── */

describe("C4: sending accounts keep their credentials server-side", () => {
  function seedMailboxes() {
    const mailbox = (id: number, workspaceId: number, over: Record<string, unknown> = {}) => ({
      id, workspaceId, name: `Mailbox ${id}`, provider: "generic_smtp", fromEmail: `m${id}@example.com`,
      smtpHost: "smtp.real.example", smtpPort: 587, smtpUsername: `m${id}`, smtpPassword: `smtp-secret-${id}`,
      imapHost: "imap.real.example", imapPort: 993, imapUsername: `m${id}`, imapPassword: `imap-secret-${id}`,
      oauthAccessToken: `access-${id}`, oauthRefreshToken: `refresh-${id}`, sendgridApiKeyEnc: null,
      unipileAccountId: null, dailySendLimit: 100, createdAt: new Date(), ...over,
    });
    rows("sending_accounts").push(mailbox(100, LSI), mailbox(400, CF));
  }

  const SECRETS = ["smtpPassword", "imapPassword", "oauthAccessToken", "oauthRefreshToken", "sendgridApiKeyEnc"];

  it("list and get return no secret to a rep — only whether one exists", async () => {
    seedMailboxes();
    const list = await caller(REP, LSI).sendingAccounts.list();
    expect(list.map((a: any) => a.id)).toEqual([100]);
    const got = await caller(REP, LSI).sendingAccounts.get({ id: 100 });
    for (const a of [list[0], got] as any[]) {
      for (const k of SECRETS) expect(a, k).not.toHaveProperty(k);
      expect(JSON.stringify(a)).not.toMatch(/secret-100|access-100|refresh-100/);
      expect(a).toMatchObject({ hasSmtpPassword: true, hasImapPassword: true, hasOauthToken: true });
    }
  });

  it("get with the other workspace's mailbox id is not found", async () => {
    seedMailboxes();
    expect((await refusal(caller(REP, LSI).sendingAccounts.get({ id: 400 }))).code).toBe("NOT_FOUND");
  });

  it("testConfig is admin-only", async () => {
    seedMailboxes();
    const r = await refusal(caller(REP, LSI).sendingAccounts.testConfig({ editId: 100, provider: "generic_smtp", smtpHost: "evil.example", smtpPort: 25, smtpUsername: "x" }));
    expect(r.code).toBe("FORBIDDEN");
    expect(h.transports).toEqual([]);
  });

  it("a stored password is only ever tried against its stored host, whatever host the form sends", async () => {
    seedMailboxes();
    await caller(ADMIN, LSI).sendingAccounts.testConfig({ editId: 100, provider: "generic_smtp", smtpHost: "evil.example", smtpPort: 2525, smtpUsername: "attacker" });
    expect(h.transports).toEqual([{ host: "smtp.real.example", port: 587, username: "m100", password: "smtp-secret-100" }]);
  });

  it("editId from another workspace never yields its password", async () => {
    seedMailboxes();
    const out = await caller(ADMIN, LSI).sendingAccounts.testConfig({ editId: 400, provider: "generic_smtp", smtpHost: "evil.example", smtpPort: 25, smtpUsername: "x" });
    expect(out.ok).toBe(false);
    expect(h.transports).toEqual([]);
  });

  it("control: a password typed into the form is tried against the typed host", async () => {
    seedMailboxes();
    await caller(ADMIN, LSI).sendingAccounts.testConfig({ editId: 100, provider: "generic_smtp", smtpHost: "smtp.new.example", smtpPort: 465, smtpUsername: "new", smtpPassword: "typed-now" });
    expect(h.transports).toEqual([{ host: "smtp.new.example", port: 465, username: "new", password: "typed-now" }]);
  });
});

/* ─── C5 — ARE signal ingest ───────────────────────────────────────────── */

describe("C5: are.execution.ingestSignal cannot reach another workspace's prospect", () => {
  function seedAre() {
    rows("are_campaigns").push(
      { id: 200, workspaceId: LSI, name: "LSI campaign", ownerUserId: ADMIN, signalToOpportunityEnabled: false },
      { id: 201, workspaceId: LSI, name: "Another LSI campaign", ownerUserId: ADMIN },
      { id: 400, workspaceId: CF, name: "CF campaign", ownerUserId: VICTIM, signalToOpportunityEnabled: true },
    );
    rows("prospect_queue").push(
      { id: 2000, workspaceId: LSI, campaignId: 200, firstName: "Own", lastName: "Prospect", email: "own@example.com", sequenceStatus: "enrolled" },
      { id: 4000, workspaceId: CF, campaignId: 400, firstName: "Their", lastName: "Prospect", email: "theirs@cf-client.example", sequenceStatus: "enrolled", companyName: "CF Client" },
    );
  }

  it("refuses the other workspace's prospect, and writes nothing", async () => {
    seedAre();
    const before = snapshot("prospect_queue", 4000);
    const r = await refusal(caller(ADMIN, LSI).are.execution.ingestSignal({ prospectQueueId: 4000, campaignId: 400, signalType: "email_bounce" }));
    expect(r.code).toBe("NOT_FOUND");
    expect(snapshot("prospect_queue", 4000)).toBe(before);
    expect(rows("are_suppression_list")).toEqual([]);
    expect(rows("are_signal_log")).toEqual([]);
    expect(h.db.executed).toEqual([]);
  });

  it("is admin-only — no screen calls it", async () => {
    seedAre();
    expect((await refusal(caller(REP, LSI).are.execution.ingestSignal({ prospectQueueId: 2000, campaignId: 200, signalType: "email_bounce" }))).code).toBe("FORBIDDEN");
  });

  it("refuses a campaign the prospect is not in, rather than trusting the input", async () => {
    seedAre();
    expect((await refusal(caller(ADMIN, LSI).are.execution.ingestSignal({ prospectQueueId: 2000, campaignId: 400, signalType: "meeting_booked" }))).code).toBe("BAD_REQUEST");
    expect(h.db.executed).toEqual([]);
  });

  it("processSignal itself drops a signal whose prospect is not in that workspace and campaign", async () => {
    seedAre();
    const before = snapshot("prospect_queue", 4000);
    await processSignal(LSI, 4000, 400, "email_bounce", {});
    await processSignal(LSI, 4000, 400, "meeting_booked", {});
    await processSignal(LSI, 2000, 400, "meeting_booked", {});
    expect(snapshot("prospect_queue", 4000)).toBe(before);
    expect(rows("are_suppression_list")).toEqual([]);
    expect(rows("are_signal_log")).toEqual([]);
    expect(rows("contacts")).toEqual([]);
    expect(h.db.executed).toEqual([]);
  });

  it("promoteProspectToCrm will not promote another tenant's prospect, or file one under their campaign", async () => {
    seedAre();
    expect(await promoteProspectToCrm(LSI, 4000, 400, { createOpportunity: true })).toBeNull();
    expect(await promoteProspectToCrm(LSI, 2000, 400, { createOpportunity: true })).toBeNull();
    // …and not another campaign of the same workspace, whose owner and name
    // would be stamped on the new records.
    expect(await promoteProspectToCrm(LSI, 2000, 201, { createOpportunity: true })).toBeNull();
    expect(rows("contacts")).toEqual([]);
    expect(rows("opportunities")).toEqual([]);
  });

  it("control: the caller's own prospect is processed", async () => {
    seedAre();
    await caller(ADMIN, LSI).are.execution.ingestSignal({ prospectQueueId: 2000, campaignId: 200, signalType: "email_bounce" });
    expect(row("prospect_queue", 2000).sequenceStatus).toBe("skipped");
    expect(rows("are_suppression_list")).toMatchObject([{ workspaceId: LSI, email: "own@example.com" }]);
    expect(rows("are_signal_log")).toMatchObject([{ workspaceId: LSI, prospectQueueId: 2000, campaignId: 200 }]);
  });
});

/* ─── C6 — ARE sequence generation ─────────────────────────────────────── */

describe("C6: are.prospects.generateSequence cannot write copy onto another workspace's prospect", () => {
  function seedAre() {
    rows("are_campaigns").push(
      { id: 200, workspaceId: LSI, name: "LSI campaign", copyMode: "ai" },
      { id: 201, workspaceId: LSI, name: "Another LSI campaign", copyMode: "ai" },
      { id: 400, workspaceId: CF, name: "CF campaign", copyMode: "fixed", fixedSteps: [{ subject: "planted", body: "planted" }] },
    );
    rows("prospect_queue").push(
      { id: 2000, workspaceId: LSI, campaignId: 200, firstName: "Own", lastName: "Prospect" },
      { id: 4000, workspaceId: CF, campaignId: 400, firstName: "Their", lastName: "Prospect" },
    );
    rows("prospect_intelligence").push({ id: 9, workspaceId: CF, prospectQueueId: 4000, generatedSequence: [] });
    // Corrupt rows whose campaign belongs to the OTHER tenant: the prospect
    // check and the campaign check must each refuse on their own, not lean on
    // the other.
    rows("prospect_queue").push(
      { id: 4001, workspaceId: CF, campaignId: 200, firstName: "Their", lastName: "Stray" },
      { id: 2001, workspaceId: LSI, campaignId: 400, firstName: "Own", lastName: "Stray" },
    );
  }

  it("refuses the other workspace's prospect and campaign, and touches neither the dossier nor the logs", async () => {
    seedAre();
    const before = snapshot("prospect_intelligence", 9);
    for (const [prospectId, campaignId] of [[4000, 400], [2000, 400], [4000, 200], [2000, 201], [4001, 200], [2001, 400]]) {
      const r = await refusal(caller(ADMIN, LSI).are.prospects.generateSequence({ prospectId, campaignId, force: true }));
      expect(r.code, `${prospectId}/${campaignId}`).toBe("NOT_FOUND");
    }
    expect(snapshot("prospect_intelligence", 9)).toBe(before);
    expect(rows("prospect_intelligence")).toHaveLength(1);
    expect(rows("are_engine_logs")).toEqual([]);
    expect(h.llmCalls).toBe(0);
  });

  it("control: the caller's own prospect gets past the scope check (and stops where enrichment is missing)", async () => {
    seedAre();
    const r = await refusal(caller(ADMIN, LSI).are.prospects.generateSequence({ prospectId: 2000, campaignId: 200, allowWithoutEnrichment: false }));
    expect(r.code).toBe("INTERNAL_SERVER_ERROR");
    expect(r.message).toMatch(/no enrichment data/);
    expect(rows("are_engine_logs")).toMatchObject([{ workspaceId: LSI, campaignId: 200 }]);
  });
});

/* ─── C7 — CRM patches ─────────────────────────────────────────────────── */

describe("C7: CRM updates take explicit fields and own-workspace links only", () => {
  function seedCrm() {
    rows("accounts").push(
      { id: 1, workspaceId: LSI, name: "Own Co", domain: "own.example", ownerUserId: ADMIN },
      { id: 2, workspaceId: CF, name: "Their Co", domain: "their.example", ownerUserId: VICTIM },
    );
    rows("contacts").push(
      { id: 1, workspaceId: LSI, firstName: "Own", lastName: "Contact", accountId: 1, ownerUserId: ADMIN },
      { id: 2, workspaceId: CF, firstName: "Their", lastName: "Contact", accountId: 2, ownerUserId: VICTIM },
    );
    rows("leads").push({ id: 1, workspaceId: LSI, firstName: "Own", lastName: "Lead", status: "new", ownerUserId: ADMIN });
    rows("opportunities").push({ id: 1, workspaceId: LSI, accountId: 1, name: "Own deal", stage: "discovery", value: "100", ownerUserId: ADMIN });
    rows("territories").push({ id: 1, workspaceId: LSI, name: "East" }, { id: 2, workspaceId: CF, name: "Theirs" });
    rows("products").push({ id: 1, workspaceId: LSI, sku: "A", name: "Thing", listPrice: "1", cost: "0", billingCycle: "annual", active: true });
    rows("crm_territory_rules").push({ id: 1, workspaceId: LSI, name: "Rule", priority: 1, territoryId: 1, active: true });
    rows("crm_pipelines").push({ id: 7, workspaceId: CF, name: "Their pipeline" });
    rows("tasks").push({ id: 1, workspaceId: LSI, title: "Call", type: "call", priority: "normal", status: "open", ownerUserId: ADMIN });
  }

  const c = () => caller(ADMIN, LSI);
  const CASES: Array<[string, () => Promise<unknown>, string, number]> = [
    ["accounts.update moving the row", () => c().accounts.update({ id: 1, patch: { workspaceId: CF } as any }), "accounts", 1],
    ["accounts.update rewriting its id", () => c().accounts.update({ id: 1, patch: { id: 2 } as any }), "accounts", 1],
    ["accounts.update to another tenant's owner", () => c().accounts.update({ id: 1, patch: { ownerUserId: VICTIM } }), "accounts", 1],
    ["accounts.update to another tenant's parent", () => c().accounts.update({ id: 1, patch: { parentAccountId: 2 } }), "accounts", 1],
    ["accounts.update to another tenant's territory", () => c().accounts.update({ id: 1, patch: { territoryId: 2 } }), "accounts", 1],
    ["contacts.update moving the row", () => c().contacts.update({ id: 1, patch: { workspaceId: CF } as any }), "contacts", 1],
    ["contacts.update onto another tenant's account", () => c().contacts.update({ id: 1, patch: { accountId: 2 } }), "contacts", 1],
    ["leads.update moving the row", () => c().leads.update({ id: 1, patch: { workspaceId: CF } as any }), "leads", 1],
    ["leads.update to another tenant's owner", () => c().leads.update({ id: 1, patch: { ownerUserId: VICTIM } }), "leads", 1],
    ["opportunities.update moving the row", () => c().opportunities.update({ id: 1, patch: { workspaceId: CF } as any }), "opportunities", 1],
    ["opportunities.update onto another tenant's account", () => c().opportunities.update({ id: 1, patch: { accountId: 2 } }), "opportunities", 1],
    ["opportunities.update onto another tenant's pipeline", () => c().opportunities.update({ id: 1, patch: { pipelineId: 7 } }), "opportunities", 1],
    ["territories.update moving the row", () => c().territories.update({ id: 1, patch: { workspaceId: CF } as any }), "territories", 1],
    ["products.update moving the row", () => c().products.update({ id: 1, patch: { workspaceId: CF } as any }), "products", 1],
    ["crmTerritoryRules.update moving the row", () => c().crmTerritoryRules.update({ id: 1, patch: { workspaceId: CF } as any }), "crm_territory_rules", 1],
    ["crmTerritoryRules.update onto another tenant's territory", () => c().crmTerritoryRules.update({ id: 1, patch: { territoryId: 2 } }), "crm_territory_rules", 1],
    ["tasks.update moving the row", () => c().tasks.update({ id: 1, patch: { workspaceId: CF } as any }), "tasks", 1],
    ["tasks.update to another tenant's owner", () => c().tasks.update({ id: 1, patch: { ownerUserId: VICTIM } }), "tasks", 1],
  ];

  for (const [name, call, table, id] of CASES) {
    it(`refuses ${name}, and the row is unchanged`, async () => {
      seedCrm();
      const before = snapshot(table, id);
      expect((await refusal(call())).code).toBe("BAD_REQUEST");
      expect(snapshot(table, id)).toBe(before);
    });
  }

  it("refuses creating records linked to another tenant's account", async () => {
    seedCrm();
    expect((await refusal(c().opportunities.create({ name: "Planted", accountId: 2 }))).code).toBe("BAD_REQUEST");
    expect((await refusal(c().contacts.create({ firstName: "P", lastName: "Q", accountId: 2 }))).code).toBe("BAD_REQUEST");
    expect((await refusal(c().tasks.create({ title: "For a stranger", ownerUserId: VICTIM }))).code).toBe("BAD_REQUEST");
    expect(rows("opportunities")).toHaveLength(1);
    expect(rows("contacts")).toHaveLength(2);
    expect(rows("tasks")).toHaveLength(1);
  });

  it("control: ordinary edits still save, and an account's dedupe keys follow its name", async () => {
    seedCrm();
    await c().accounts.update({ id: 1, patch: { name: "Renamed Holdings Inc", ownerUserId: REP, territoryId: 1 } });
    expect(row("accounts", 1)).toMatchObject({ workspaceId: LSI, name: "Renamed Holdings Inc", ownerUserId: REP, territoryId: 1 });
    expect(row("accounts", 1).normalizedName).toBeTruthy();
    await c().contacts.update({ id: 1, patch: { title: "VP", accountId: 1 } });
    expect(row("contacts", 1)).toMatchObject({ workspaceId: LSI, title: "VP" });
    await c().tasks.update({ id: 1, patch: { title: "Call back", ownerUserId: REP } });
    expect(row("tasks", 1)).toMatchObject({ workspaceId: LSI, title: "Call back", ownerUserId: REP });
  });
});

/* ─── C8 — customer success ────────────────────────────────────────────── */

describe("C8: cs.* reads and writes stay inside the workspace", () => {
  function seedCs() {
    rows("accounts").push(
      { id: 1, workspaceId: LSI, name: "Own Co" },
      { id: 2, workspaceId: CF, name: "Their Secret Client" },
      { id: 3, workspaceId: CF, name: "Their Other Client" },
    );
    rows("customers").push(
      { id: 10, workspaceId: LSI, accountId: 1, arr: "1000", renewalStage: "early", contractEnd: null },
      // Made, before the fix, from a won deal carrying a foreign accountId.
      { id: 11, workspaceId: LSI, accountId: 2, arr: "0", renewalStage: "early", contractEnd: null },
      { id: 40, workspaceId: CF, accountId: 2, arr: "99999", healthTier: "at_risk", renewalStage: "early", contractEnd: null },
    );
  }

  it("scheduleQbr refuses another workspace's customer", async () => {
    seedCs();
    expect((await refusal(caller(REP, LSI).cs.scheduleQbr({ customerId: 40, scheduledAt: "2026-11-01" }))).code).toBe("NOT_FOUND");
    expect(rows("qbrs")).toEqual([]);
  });

  it("generateQbrPrep on a QBR stored against another workspace's customer reads nothing of theirs", async () => {
    seedCs();
    rows("qbrs").push({ id: 5, workspaceId: LSI, customerId: 40, status: "scheduled" });
    expect((await refusal(caller(REP, LSI).cs.generateQbrPrep({ qbrId: 5 }))).code).toBe("NOT_FOUND");
    expect(h.llmCalls, "their ARR and health must not reach a prompt").toBe(0);
    expect(row("qbrs", 5).aiPrep).toBeUndefined();
  });

  it("cs.get does not hand over another workspace's account", async () => {
    seedCs();
    const got: any = await caller(REP, LSI).cs.get({ id: 11 });
    expect(got.account).toBeNull();
    expect(JSON.stringify(got)).not.toMatch(/Their Secret Client/);
  });

  it("a won deal on another workspace's account does not become a customer", async () => {
    seedCs();
    expect(await ensureCustomerForWonOpp(h.db, LSI, { accountId: 3, value: "5", ownerUserId: ADMIN }, ADMIN)).toBe(false);
    expect(rows("customers").filter((r) => r.workspaceId === LSI)).toHaveLength(2);
    // Control: a won deal on the caller's own account does become a customer.
    rows("accounts").push({ id: 5, workspaceId: LSI, name: "New Win" });
    expect(await ensureCustomerForWonOpp(h.db, LSI, { accountId: 5, value: "5", ownerUserId: ADMIN }, ADMIN)).toBe(true);
  });

  it("control: the caller's own customer is scheduled and prepared", async () => {
    seedCs();
    const { id } = await caller(REP, LSI).cs.scheduleQbr({ customerId: 10, scheduledAt: "2026-11-01" });
    await caller(REP, LSI).cs.generateQbrPrep({ qbrId: id });
    expect(h.llmCalls).toBe(1);
    expect(row("qbrs", id).aiPrep).toBeTruthy();
  });
});

/* ─── C9 — sequence enrolment ──────────────────────────────────────────── */

describe("C9: sequences.enroll and bulkEnroll accept only this workspace's ids", () => {
  function seedSeq() {
    rows("sequences").push(
      { id: 1, workspaceId: LSI, name: "Own", status: "active", steps: [] },
      { id: 4, workspaceId: CF, name: "Theirs", status: "active", steps: [] },
    );
    rows("contacts").push(
      { id: 1, workspaceId: LSI, firstName: "Own", lastName: "Contact", email: "own@example.com" },
      { id: 2, workspaceId: CF, firstName: "Their", lastName: "Contact", email: "theirs@cf-client.example" },
    );
    rows("leads").push({ id: 2, workspaceId: CF, firstName: "Their", lastName: "Lead", email: "lead@cf-client.example" });
    rows("prospects").push({ id: 2, workspaceId: CF, firstName: "Their", lastName: "Person", email: "person@cf-client.example" });
  }

  it("enroll refuses another workspace's sequence, contact or lead", async () => {
    seedSeq();
    for (const input of [{ sequenceId: 4, contactId: 1 }, { sequenceId: 1, contactId: 2 }, { sequenceId: 1, leadId: 2 }]) {
      expect((await refusal(caller(REP, LSI).sequences.enroll(input))).code, JSON.stringify(input)).toBe("NOT_FOUND");
    }
    expect(rows("enrollments")).toEqual([]);
  });

  it("bulkEnroll refuses a batch with any stranger in it, and enrolls nobody", async () => {
    seedSeq();
    for (const input of [
      { sequenceId: 1, contactIds: [1, 2] },
      { sequenceId: 1, leadIds: [2] },
      { sequenceId: 1, prospectIds: [2] },
      { sequenceId: 4, contactIds: [1] },
    ]) {
      expect((await refusal(caller(REP, LSI).sequences.bulkEnroll(input))).code, JSON.stringify(input)).toBe("NOT_FOUND");
    }
    expect(rows("enrollments")).toEqual([]);
  });

  it("control: the caller's own contact is enrolled", async () => {
    seedSeq();
    await caller(REP, LSI).sequences.enroll({ sequenceId: 1, contactId: 1 });
    expect(rows("enrollments")).toMatchObject([{ workspaceId: LSI, sequenceId: 1, contactId: 1 }]);
  });
});
