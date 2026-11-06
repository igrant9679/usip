/**
 * Who hears about a Revenue Engine prospect, and how they get to them (audit
 * 2026-10-20, batch E2).
 *
 *   A57 a notice goes to the campaign's owner and names and links the person
 *   A49 ?prospect= links open that prospect; @mentions notify the teammates
 *       picked, by id; deleting a note asks first
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => {
  if (!process.env.ENCRYPTION_KEY && !process.env.JWT_SECRET) process.env.ENCRYPTION_KEY = "b".repeat(64);
  return { db: null as any };
});
vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { appRouter } from "./routers";
import { areNotify, notifyPersonLabel } from "./routers/are/notify";
import { processSignal } from "./routers/are/execution";

const WS = 2, OTHER = 9;
const OWNER = 20, REP = 21, ALICE = 22, ALAN = 23, GONE = 24;
const read = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8").replace(/\r\n/g, "\n");
const rows = (t: string) => h.db.rowsOf(t) as any[];
const notices = () => rows("notifications");
const caller = (userId: number) => appRouter.createCaller({
  user: { id: userId, openId: `u${userId}`, email: `u${userId}@example.com`, name: `U${userId}`, loginMethod: "password", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date(), mfaTotpEnabledAt: null },
  req: { protocol: "https", headers: { "x-workspace-id": String(WS) } },
  res: { clearCookie: () => {} },
} as unknown as TrpcContext);

beforeEach(() => {
  h.db = makeSqlFakeDb({ realMembers: true });
  const user = (id: number, name: string) => ({ id, openId: `u${id}`, email: `u${id}@example.com`, name, loginMethod: "password", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date(), mfaTotpEnabledAt: null });
  rows("users").push(user(OWNER, "Owner"), user(REP, "Rep"), user(ALICE, "Alice Smith"), user(ALAN, "Alan Smithers"), user(GONE, "Gone"));
  rows("workspaces").push({ id: WS, name: "LSI", slug: "lsi", ownerUserId: OWNER, archivedAt: null, plan: "trial" });
  const member = (id: number, userId: number, role: string, deactivatedAt: Date | null = null) => ({ id, workspaceId: WS, userId, role, deactivatedAt, inviteToken: null, lastActiveAt: new Date() });
  rows("workspace_members").push(member(1, OWNER, "admin"), member(2, REP, "rep"), member(3, ALICE, "rep"), member(4, ALAN, "rep"), member(5, GONE, "rep", new Date()));
  rows("workspace_settings").push({ workspaceId: WS, enforce2fa: false, timezone: "America/New_York" });
  rows("are_campaigns").push(
    { id: 7, workspaceId: WS, name: "Counties", status: "active", ownerUserId: REP },
    { id: 8, workspaceId: WS, name: "Cities", status: "active", ownerUserId: GONE },
  );
  rows("prospect_queue").push(
    { id: 1, workspaceId: WS, campaignId: 7, firstName: "Pat", lastName: "Lee", companyName: "Acme County", sequenceStatus: "enrolled" },
    { id: 2, workspaceId: OTHER, campaignId: 70, firstName: "Not", lastName: "Ours", sequenceStatus: "enrolled" },
  );
});

describe("notices go to the campaign's owner and name the person (A57)", () => {
  it("a campaign's notice reaches its owner, not the workspace owner", async () => {
    await areNotify({ workspaceId: WS, eventType: "hook_enhanced", title: "t", body: "b", relatedId: 7, relatedType: "are_campaign" });
    expect(notices().map((n) => n.userId)).toEqual([REP]);
  });

  it("an owner who has left hands it to the workspace's standing recipient", async () => {
    await areNotify({ workspaceId: WS, eventType: "hook_enhanced", title: "t", body: "b", relatedId: 8, relatedType: "are_campaign" });
    expect(notices().map((n) => n.userId)).toEqual([OWNER]);
  });

  it("an engagement signal names the person, links to them, and tells the campaign's owner", async () => {
    await processSignal(WS, 1, 7, "email_open", {});
    const n = notices().find((x) => x.title === "ARE: Engagement signal received");
    expect(n).toMatchObject({ userId: REP, relatedType: "prospect_queue", relatedId: 1 });
    expect(n.body).toBe("Pat Lee at Acme County opened your email.");
    expect(notifyPersonLabel({ firstName: "", lastName: null })).toBe("A prospect");
  });

  it("the person link resolves to their campaign, in this workspace only", async () => {
    expect(await caller(REP).are.prospects.locate({ prospectId: 1 })).toEqual({ campaignId: 7 });
    await expect(caller(REP).are.prospects.locate({ prospectId: 2 })).rejects.toThrow(/not found/i);
    expect(read("client/src/App.tsx")).toContain('<Route path="/are/prospects/:id"><AuthGate><AREProspectRedirect /></AuthGate></Route>');
    expect(read("client/src/pages/usip/AREProspectRedirect.tsx")).toContain("navigate(`/are/campaigns/${q.data.campaignId}?prospect=${prospectId}`, { replace: true });");
    expect(read("client/src/pages/usip/Inbox.tsx")).toContain('isAreEvent && n.relatedType === "prospect_queue" && n.relatedId');
  });

  it("the positive-reply and meeting notices are about the person too", () => {
    const exec = read("server/routers/are/execution.ts");
    expect(exec).toContain("title: `ARE: Positive reply from ${person}`,");
    expect(exec).not.toContain("body: `A prospect replied positively.");
    const meeting = exec.slice(exec.indexOf('eventType: "meeting_booked",'), exec.indexOf('eventType: "meeting_booked",') + 600);
    expect(meeting).toContain('relatedType: "prospect_queue",');
    expect(meeting).toContain("campaignId,");
  });
});

describe("notes (A49)", () => {
  it("mentions notify the teammates picked, by id, and nobody whose name merely matches", async () => {
    await caller(REP).are.prospects.addNote({ prospectId: 1, campaignId: 7, body: "@Alice Smith can you look?", mentionUserIds: [ALICE] });
    expect(notices().map((n) => n.userId)).toEqual([ALICE]);
    expect(notices()[0].body.split("\n")[0]).toBe('{"campaignId":7,"prospectId":1}');
  });

  it("a name typed without picking notifies nobody, and ids outside the workspace are dropped", async () => {
    // By name, "@Smith" reached both Alice Smith and Alan Smithers.
    await caller(REP).are.prospects.addNote({ prospectId: 1, body: "ping @Smith", mentionUserIds: [999, REP] });
    expect(notices()).toHaveLength(0);
  });

  it("a note can't be written on another workspace's prospect", async () => {
    await expect(caller(REP).are.prospects.addNote({ prospectId: 2, body: "x" })).rejects.toThrow(/not found/i);
    expect(rows("prospect_notes")).toHaveLength(0);
  });

  it("the page opens ?prospect=, sends picked ids and asks before deleting a note", () => {
    const detail = read("client/src/pages/usip/ARECampaignDetail.tsx");
    expect(detail).toContain('.get("prospect"));');
    expect(detail).toContain("const [selectedProspectId, setSelectedProspectId] = useState<number | null>(linkedProspectId);");
    expect(detail).toContain("const [dossierOpen, setDossierOpen] = useState(linkedProspectId !== null);");
    expect(detail).toContain("mentionUserIds: Array.from(mentioned.entries())");
    expect(detail).not.toContain("onClick={() => deleteNote.mutate({ noteId: note.id })}");
    expect(detail).toContain('{ title: "Delete this note?"');
  });
});
