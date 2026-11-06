/**
 * The record drawer and the Leads screens (audit 2026-10-20, R5 · R7 · R44 ·
 * R45 · R46 · R50 · R81).
 *
 *   R7  · the drawer timeline shows each activity's type, note text and call
 *         outcome, read from the columns activities.list returns
 *   R45 · drawer notes and detail-page notes are one store (crmNotes), and a
 *         drawer note's @mention still notifies
 *   R46 · one Files list in the drawer, whose delete asks first; the OneDrive
 *         box only for a workspace that connected it; no pointers to the
 *         retired Accounts and Contacts lists
 *   R44 · a DM to a profile starts a conversation with that person; an invite
 *         to a profile URL goes to its id; the panel follows what has loaded;
 *         a lead's LinkedIn profile is found
 *   R5  · "Send Email" to several leads is one capped request with a result
 *         per lead
 *   R50 · "Use AI" beside a send form writes copy and saves no draft
 *   R81 · a lead's status, phone and owner can be edited, a cleared field is
 *         cleared, and the lead's page can edit it
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => {
  if (!process.env.ENCRYPTION_KEY && !process.env.JWT_SECRET) process.env.ENCRYPTION_KEY = "b".repeat(64);
  return {
    db: null as any,
    paused: false,
    data: {} as Record<string, unknown>,
    sent: [] as any[],
    invites: [] as any[],
    emails: [] as any[],
  };
});

vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));
vi.mock("./services/outboundPause", async (a) => {
  const real = await a<typeof import("./services/outboundPause")>();
  return {
    ...real,
    isOutboundPaused: async () => h.paused,
    assertOutboundNotPaused: async () => { if (h.paused) { const { TRPCError } = await import("@trpc/server"); throw new TRPCError({ code: "PRECONDITION_FAILED", message: real.OUTBOUND_PAUSED_MESSAGE }); } },
  };
});
vi.mock("./lib/unipile", async (a) => ({
  ...(await a<typeof import("./lib/unipile")>()),
  sendMessage: async (p: any) => { h.sent.push(p); return { id: "msg-1", chatId: "chat-1" }; },
  sendLinkedInInvitation: async (p: any) => { h.invites.push(p); return { id: "inv-1" }; },
}));
vi.mock("./services/linkedin/activityGate", () => ({
  checkLinkedInAction: async () => ({ allowed: true }),
  recordLinkedInAction: async () => {},
}));
vi.mock("./_core/llm", async (a) => ({
  ...(await a<typeof import("./_core/llm")>()),
  invokeLLM: async () => ({ choices: [{ message: { content: JSON.stringify({ subject: "Hello there", body: "Short body" }) } }] }),
}));
vi.mock("./emailAdapter", async (a) => ({
  ...(await a<typeof import("./emailAdapter")>()),
  createEmailAdapter: () => ({ sendEmail: async (m: any) => { h.emails.push(m); return { messageId: `m-${h.emails.length}` }; } }),
}));
vi.mock("./sendLimits", async (a) => ({ ...(await a<typeof import("./sendLimits")>()), assertSendAllowed: async () => {} }));
vi.mock("@/lib/trpc", () => {
  const noop: any = new Proxy(() => undefined, { get: () => noop, apply: () => undefined });
  const node = (path: string[]): any => new Proxy({}, {
    get(_t, key: string) {
      if (key === "useQuery") return () => ({ data: h.data[path.join(".")], isLoading: false, isError: false });
      if (key === "useMutation") return () => ({ mutate: () => {}, mutateAsync: async () => ({}), isPending: false });
      if (key === "useUtils") return () => noop;
      return node([...path, key]);
    },
  });
  return { trpc: node([]) };
});

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { appRouter } from "./routers";
import { linkedInRecipient } from "./routers/unipile";
import { DrawerTimeline } from "../client/src/components/usip/detail/DrawerTimeline";
import { LinkedInActionsPanel } from "../client/src/components/usip/detail/LinkedInActionsPanel";
import { RecordFiles } from "../client/src/components/usip/MicrosoftGraph";
import { leadEditPatch } from "../client/src/lib/leadEdit";

const WS = 2, OTHER = 9, ANN = 5, STRANGER = 6;
const root = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8").replace(/\r\n/g, "\n");
const rows = (t: string) => h.db.rowsOf(t) as any[];

function caller(userId = 1) {
  return appRouter.createCaller({
    user: { id: userId, openId: "u", email: "o@example.com", name: "Olu", loginMethod: "password", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
    req: { protocol: "https", headers: { "x-workspace-id": String(WS) } },
    res: { clearCookie: () => {} },
  } as unknown as TrpcContext);
}
async function refusal(p: Promise<unknown>) {
  try { await p; } catch (e: any) { return e; }
  throw new Error("expected a refusal");
}

beforeEach(() => {
  h.db = makeSqlFakeDb({ realMembers: true });
  h.paused = false;
  h.data = {};
  h.sent = []; h.invites = []; h.emails = [];
  rows("workspaces").push({ id: WS, name: "W", slug: "w", ownerUserId: 1, archivedAt: null, plan: "trial" }, { id: OTHER, name: "O", slug: "o", ownerUserId: 9, archivedAt: null, plan: "trial" });
  rows("users").push({ id: 1, name: "Olu", email: "olu@w.example" }, { id: ANN, name: "Ann", email: "ann@w.example" }, { id: STRANGER, name: "Sam", email: "sam@o.example" });
  rows("workspace_members").push(
    { id: 1, workspaceId: WS, userId: 1, role: "manager", deactivatedAt: null, inviteToken: null, lastActiveAt: new Date() },
    { id: 2, workspaceId: WS, userId: ANN, role: "rep", deactivatedAt: null, inviteToken: null, lastActiveAt: new Date() },
    { id: 3, workspaceId: OTHER, userId: STRANGER, role: "rep", deactivatedAt: null, inviteToken: null, lastActiveAt: new Date() },
  );
});

describe("R7 · the drawer timeline shows what was logged", () => {
  it("type, note text and call outcome come through from the real rows", async () => {
    const c = caller();
    await c.activities.logCall({ relatedType: "lead", relatedId: 40, disposition: "voicemail", durationSec: 30, outcome: "Left a message", notes: "Asked for a call back Tuesday" });
    await c.activities.logMeeting({ relatedType: "lead", relatedId: 40, subject: "Discovery", notes: "Budget is approved" });
    const listed = await c.activities.list({ relatedType: "lead", relatedId: 40 });
    const html = renderToStaticMarkup(createElement(DrawerTimeline, { rows: listed as any[], onDelete: () => {} }));
    expect(html).toContain(">call<");
    expect(html).toContain(">meeting<");
    expect(html).toContain("voicemail");
    expect(html).toContain("Asked for a call back Tuesday");
    expect(html).toContain("Budget is approved");
  });

  it("the drawer renders that timeline and reads no column that does not exist", () => {
    const src = read("client/src/components/usip/RecordDrawer.tsx");
    expect(src).toContain("<DrawerTimeline rows={acts.data as any[]} onDelete={(id) => delActivity.mutate({ id })} />");
    expect(src).not.toMatch(/a\.kind === "call"|\{a\.notes &&|a\.disposition &&/);
  });
});

describe("R45 · one notes store", () => {
  it("a note written in the drawer is a crmNotes row the detail page lists, and its @mention notifies a member", async () => {
    const c = caller();
    const r = await c.crmNotes.create({ entityType: "lead", entityId: 40, body: "Ping @[Ann](user:5) and @[Sam](user:6) and me @[Olu](user:1)" });
    expect(r.mentioned.sort()).toEqual([ANN, STRANGER]);
    expect((await c.crmNotes.list({ entityType: "lead", entityId: 40 })).map((n) => n.body)).toEqual(["Ping @[Ann](user:5) and @[Sam](user:6) and me @[Olu](user:1)"]);
    // Only this workspace's member hears about it; never another workspace's user, never yourself.
    expect(rows("notifications").map((n) => [n.userId, n.kind, n.relatedType, n.relatedId])).toEqual([[ANN, "mention", "lead", 40]]);
  });

  it("the drawer's Notes tab is the detail page's notes, and writes no activities note", () => {
    const src = read("client/src/components/usip/RecordDrawer.tsx");
    expect(src).toContain("<RecordNotes entityType={relatedType} entityId={relatedId} />");
    expect(src).not.toContain("activities.addNote");
    expect(read("client/src/components/usip/EntityDetail.tsx")).toContain("export { NotesTab as RecordNotes, FilesTab as RecordAttachments };");
  });
});

describe("R46 · one Files list, a confirmed delete, live links", () => {
  it("the drawer's Files tab is the shared attachments list and the OneDrive box only when connected", () => {
    const src = read("client/src/components/usip/RecordDrawer.tsx");
    expect(src).toContain("<RecordAttachments entityType={relatedType} entityId={relatedId} />");
    expect(src).toContain("relatedId={relatedId} onlyWhenConnected />");
    expect(src).not.toContain("delAtt.mutate");
    expect(src).not.toContain('aria-label="Delete attachment"');
    // The shared list asks before it deletes.
    const files = read("client/src/components/usip/EntityDetail.tsx");
    const tab = files.slice(files.indexOf("function FilesTab("), files.indexOf("export { NotesTab as RecordNotes"));
    expect(tab).toContain('confirmAction({ title: "Delete this file?"');
  });

  it("the OneDrive box renders nothing until Microsoft 365 is connected, where asked", () => {
    const box = (onlyWhenConnected: boolean) => renderToStaticMarkup(createElement(RecordFiles, { relatedType: "lead", relatedId: 40, onlyWhenConnected }));
    h.data["graph.status"] = { connected: false };
    expect(box(true)).toBe("");
    expect(box(false)).toContain("Files (OneDrive)");
    h.data["graph.status"] = { connected: true };
    h.data["graph.listFiles"] = { files: [] };
    expect(box(true)).toContain("Files (OneDrive)");
  });

  it("clicking a company or contact in the drawer goes to its live page", () => {
    const src = read("client/src/components/usip/RecordDrawer.tsx");
    expect(src).not.toMatch(/open from the (Accounts|Contacts) list/);
    expect(src).toContain("onAccountClick={(accountId) => navigate(`/v2/companies/${accountId}`)}");
    expect(src).toContain("onContactClick={(contactId) => navigate(`/contacts/${contactId}`)}");
  });
});

describe("R44 · LinkedIn from the drawer", () => {
  beforeEach(() => {
    rows("unipile_accounts").push({ id: 1, workspaceId: WS, userId: 1, unipileAccountId: "acc-1", provider: "LINKEDIN", accountName: "Olu LI" });
  });

  it("a DM to a profile URL starts a conversation with that person", async () => {
    await caller().unipile.sendMessage({ unipileAccountId: "acc-1", recipientProfile: "https://www.linkedin.com/in/jane-doe/", text: "Hi Jane", linkedLeadId: 40 });
    expect(h.sent).toEqual([{ chatId: undefined, accountId: "acc-1", attendeesIds: ["jane-doe"], text: "Hi Jane", linkedinInmail: undefined }]);
    expect(rows("unipile_messages")[0]).toMatchObject({ recipientProviderId: "jane-doe", chatId: "chat-1", linkedLeadId: 40 });
  });

  it("a DM with no recipient at all is refused, not sent to nowhere", async () => {
    expect((await refusal(caller().unipile.sendMessage({ unipileAccountId: "acc-1", text: "Hi" }))).code).toBe("BAD_REQUEST");
    expect((await refusal(caller().unipile.sendMessage({ unipileAccountId: "acc-1", recipientProfile: "https://example.com/jane", text: "Hi" }))).code).toBe("BAD_REQUEST");
    expect(h.sent).toEqual([]);
  });

  it("an invite to a profile URL goes to the profile's id", async () => {
    await caller().unipile.sendLinkedInInvite({ unipileAccountId: "acc-1", recipientProviderId: "linkedin.com/in/jane-doe?trk=abc", recipientName: "Jane" });
    expect(h.invites).toEqual([{ accountId: "acc-1", providerId: "jane-doe", message: undefined }]);
    expect(rows("unipile_invites")[0]).toMatchObject({ recipientProviderId: "jane-doe" });
    expect(linkedInRecipient("ACoAAB12_xyz")).toBe("ACoAAB12_xyz");
    expect(linkedInRecipient("not a url or id")).toBeNull();
  });

  it("the panel follows what has loaded, and sends the profile as the recipient", () => {
    h.data["unipile.listConnectedAccounts"] = [{ unipileAccountId: "acc-1", provider: "LINKEDIN", accountName: "Olu LI" }];
    const html = renderToStaticMarkup(createElement(LinkedInActionsPanel, { relatedType: "lead", relatedId: 40, linkedinUrl: "https://www.linkedin.com/in/jane-doe", name: "Jane" }));
    expect(html).toContain('value="https://www.linkedin.com/in/jane-doe"');
    expect(html).toMatch(/<option value="acc-1" selected="">/);
    const src = read("client/src/components/usip/detail/LinkedInActionsPanel.tsx");
    // Nothing seeded from a first render that had not loaded yet.
    expect(src).not.toMatch(/useState<string>\(linkedInAccounts\[0\]/);
    expect(src).not.toMatch(/useState\(linkedinUrl/);
    expect(src).toContain("const selectedAccountId = pickedAccountId ?? linkedInAccounts[0]?.unipileAccountId ?? \"\";");
    expect(src).toContain("recipientProfile: profileId.trim(),");
    expect(src).not.toMatch(/chatId: profileId/);
    // The drawer renders this panel, not a copy of its own.
    const drawer = read("client/src/components/usip/RecordDrawer.tsx");
    expect(drawer).toContain('import { LinkedInActionsPanel } from "./detail/LinkedInActionsPanel";');
    expect(drawer).not.toContain("function LinkedInActionsPanel(");
  });

  it("a lead's LinkedIn profile: from its import, else from its People row", async () => {
    rows("leads").push(
      { id: 40, workspaceId: WS, firstName: "Jane", lastName: "Doe", status: "new", customFields: { linkedinUrl: "https://linkedin.com/in/jane-doe" } },
      { id: 41, workspaceId: WS, firstName: "Jo", lastName: "Roe", status: "new", customFields: null },
      { id: 42, workspaceId: WS, firstName: "No", lastName: "Profile", status: "new", customFields: {} },
    );
    rows("prospects").push({ id: 7, workspaceId: WS, firstName: "Jo", lastName: "Roe", linkedLeadId: 41, linkedinUrl: "https://linkedin.com/in/jo-roe" }, { id: 8, workspaceId: OTHER, firstName: "X", lastName: "Y", linkedLeadId: 42, linkedinUrl: "https://linkedin.com/in/not-theirs" });
    const c = caller();
    expect((await c.leads.get({ id: 40 }))?.linkedinUrl).toBe("https://linkedin.com/in/jane-doe");
    expect((await c.leads.get({ id: 41 }))?.linkedinUrl).toBe("https://linkedin.com/in/jo-roe");
    expect((await c.leads.get({ id: 42 }))?.linkedinUrl).toBeNull();
    expect(read("client/src/components/usip/RecordDrawer.tsx")).toContain('linkedinUrl={relatedType === "lead" ? (leadData.data as any)?.linkedinUrl ?? ""');
  });
});

describe("R5 · one capped request, a result per lead", () => {
  beforeEach(() => {
    rows("leads").push(
      { id: 40, workspaceId: WS, firstName: "Jane", lastName: "Doe", email: "jane@acme.example", status: "new" },
      { id: 41, workspaceId: WS, firstName: "No", lastName: "Email", email: null, status: "new" },
      { id: 42, workspaceId: OTHER, firstName: "Not", lastName: "Ours", email: "x@other.example", status: "new" },
      { id: 43, workspaceId: WS, firstName: "Jo", lastName: "Roe", email: "jo@acme.example", status: "new" },
    );
    rows("sending_accounts").push({ id: 3, workspaceId: WS, name: "SMTP", fromEmail: "olu@w.example", fromName: "Olu", provider: "smtp" });
  });

  it("each lead gets the single send's checks and its own result", async () => {
    const r = await caller().leads.sendAdHocEmailBulk({ leadIds: [40, 41, 42, 43, 40], subject: "Hi {{firstName}}", body: "Hello" });
    expect(r.results.map((x) => [x.leadId, x.ok])).toEqual([[40, true], [41, false], [42, false], [43, true]]);
    expect(r.results.find((x) => x.leadId === 41)!.error).toBe("Lead has no email address");
    expect(r).toMatchObject({ sent: 2, failed: 2 });
    expect(h.emails.map((m) => [m.to, m.subject])).toEqual([["jane@acme.example", "Hi Jane"], ["jo@acme.example", "Hi Jo"]]);
  });

  it("over the cap, or while outbound is paused, nothing is tried", async () => {
    const many = Array.from({ length: 51 }, (_, i) => i + 1000);
    expect((await refusal(caller().leads.sendAdHocEmailBulk({ leadIds: many, subject: "s", body: "b" }))).code).toBe("BAD_REQUEST");
    h.paused = true;
    expect((await refusal(caller().leads.sendAdHocEmailBulk({ leadIds: [40], subject: "s", body: "b" }))).code).toBe("PRECONDITION_FAILED");
    expect(h.emails).toEqual([]);
  });

  it("the Leads page sends once, through the bulk procedure, and says when the selection is too big", () => {
    const src = read("client/src/pages/usip/Leads.tsx");
    const modal = src.slice(src.indexOf("function SendEmailModal("), src.indexOf("/* ─── Main Leads page"));
    expect(modal).toContain("trpc.leads.sendAdHocEmailBulk.useMutation");
    expect(modal).toContain("send.mutate({ leadIds, subject, body, aiGenerated: compose.isSuccess });");
    expect(modal).not.toContain("for (const leadId of leadIds)");
    expect(modal).toContain("disabled={!subject || isEmptyEmailBody(body) || sending || tooMany}");
    expect(src).toContain("const LEAD_BULK_SEND_MAX = 50;");
    expect(read("server/routers/crm.ts")).toContain("export const LEAD_BULK_SEND_MAX = 50;");
  });
});

describe("R50 · Use AI writes copy, not a draft", () => {
  beforeEach(() => {
    rows("leads").push({ id: 40, workspaceId: WS, firstName: "Jane", lastName: "Doe", email: "jane@acme.example", status: "new", title: "CFO", company: "Acme" });
  });

  it("previewOnly returns the copy and saves nothing; without it the draft is saved as before", async () => {
    const c = caller();
    const preview = await c.emailDrafts.compose({ prompt: "Follow up on the demo", toLeadId: 40, previewOnly: true });
    expect(preview).toMatchObject({ id: null, subject: "Hello there", body: "Short body" });
    expect(rows("email_drafts")).toEqual([]);
    const saved = await c.emailDrafts.compose({ prompt: "Follow up on the demo", toLeadId: 40 });
    expect(saved.id).toBeGreaterThan(0);
    expect(rows("email_drafts")).toHaveLength(1);
  });

  it("every Use AI beside a send form asks for preview copy for its recipient", () => {
    const leads = read("client/src/pages/usip/Leads.tsx");
    expect(leads).toContain("compose.mutate({ prompt: aiPrompt, toLeadId: leadIds.length === 1 ? leadIds[0] : undefined, previewOnly: true })");
    const drawer = read("client/src/components/usip/RecordDrawer.tsx");
    expect(drawer).toContain("generate.mutate({ prompt: aiPrompt, toLeadId: leadId, previewOnly: true })");
    expect(drawer).toContain("generate.mutate({ prompt: aiPrompt, toContactId: contactId, previewOnly: true })");
    expect(drawer).not.toContain("generate.mutate({ prompt: aiPrompt })");
  });
});

describe("R81 · editing a lead", () => {
  const before = { status: "new", ownerUserId: 1 };

  it("a cleared field is null; status and owner go only when changed; converting is not an edit", () => {
    expect(leadEditPatch({ firstName: " Jane ", lastName: "Doe", email: "", phone: " ", title: "CFO", company: "", source: "web", status: "working", ownerUserId: "5" }, before))
      .toEqual({ firstName: "Jane", lastName: "Doe", email: null, phone: null, title: "CFO", company: null, source: "web", status: "working", ownerUserId: 5 });
    const same = leadEditPatch({ firstName: "Jane", lastName: "Doe", status: "new", ownerUserId: "1" }, before);
    expect(same).not.toHaveProperty("status");
    expect(same).not.toHaveProperty("ownerUserId");
    expect(leadEditPatch({ firstName: "J", lastName: "D", status: "converted" }, before)).not.toHaveProperty("status");
  });

  it("leads.update stores that patch: phone cleared, status and owner changed", async () => {
    rows("leads").push({ id: 40, workspaceId: WS, firstName: "Jane", lastName: "Doe", email: "jane@acme.example", phone: "555-0100", status: "new", ownerUserId: 1 });
    const patch = leadEditPatch({ firstName: "Jane", lastName: "Doe", email: "jane@acme.example", phone: "", status: "qualified", ownerUserId: String(ANN) }, before);
    await caller().leads.update({ id: 40, patch: patch as any });
    expect(rows("leads").find((l) => l.id === 40)).toMatchObject({ phone: null, status: "qualified", ownerUserId: ANN });
  });

  it("the Leads list and the lead's page use the one dialog, which edits status, phone and owner", () => {
    expect(read("client/src/pages/usip/Leads.tsx")).toContain('import { EditLeadDialog } from "@/components/usip/EditLeadDialog";');
    expect(read("client/src/pages/usip/Leads.tsx")).not.toContain("function EditLeadDialog(");
    const detail = read("client/src/pages/usip/LeadDetail.tsx");
    expect(detail).toContain("<EditLeadDialog lead={lead} open={editing} onOpenChange={setEditing} />");
    expect(detail).toContain("onClick={() => setEditing(true)}");
    const dialog = read("client/src/components/usip/EditLeadDialog.tsx");
    for (const f of ['name="status"', 'name="ownerUserId"', '<Field name="phone"']) expect(dialog, f).toContain(f);
    expect(dialog).toContain("patch: leadEditPatch(values, lead)");
  });
});
