/**
 * Old contact-type members of a People list resolve to People (audit
 * 2026-10-20, A55). A People list shows prospects only, so a CRM contact an
 * old client had added was on the list and never shown — on the list page or
 * in the Add-existing wizard's "From a list" source. Each now resolves
 * through `resolveToPeopleIds`; one that can't is kept and reported.
 *
 * Executed against the SQL-evaluating fake. Creating a person for a contact
 * (personLink.upsertPersonForContact) is mocked: it makes one for a contact
 * with an email and none for a contact with nothing to identify them by.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => ({ db: null as any, created: [] as number[] }));

vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));
vi.mock("./audit", async (a) => ({ ...(await a<typeof import("./audit")>()), recordAudit: async () => {} }));
vi.mock("./services/personLink", async (a) => ({
  ...(await a<typeof import("./services/personLink")>()),
  upsertPersonForContact: async (ws: number, c: { id: number; email: string | null }) => {
    if (!c.email) return null;
    const id = 500 + c.id;
    h.db.rowsOf("prospects").push({ id, workspaceId: ws, firstName: "P", lastName: String(c.id), email: c.email });
    h.db.rowsOf("contacts").find((r: any) => r.id === c.id).personProspectId = id;
    h.created.push(c.id);
    return { personId: id, created: true, tier: "email" };
  },
}));

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { resolveContactListMembers } from "./services/listContactMembers";
import { listMemberPage } from "./services/listMembers";
import { appRouter } from "./routers";

const WS = 2, FOREIGN = 9, ME = 20;
const rows = (t: string) => h.db.rowsOf(t) as any[];
const caller = () => appRouter.createCaller({
  user: { id: ME, openId: "u", email: "me@example.com", name: "Me", loginMethod: "password", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
  req: { protocol: "https", headers: { "x-workspace-id": String(WS) } },
  res: { clearCookie: () => {} },
} as unknown as TrpcContext);
const member = (id: number, listId: number, recordType: string, recordId: number, workspaceId = WS) =>
  ({ id, workspaceId, listId, recordType, recordId, addedByUserId: ME, addedAt: new Date(Date.UTC(2026, 0, 1, 0, id)) });

beforeEach(() => {
  h.db = makeSqlFakeDb({ roles: { [WS]: "rep" }, wsId: () => WS });
  h.created = [];
  rows("record_lists").push(
    { id: 1, workspaceId: WS, name: "Board members", entityType: "people", updatedAt: new Date() },
    { id: 2, workspaceId: WS, name: "Accounts", entityType: "companies", updatedAt: new Date() },
    { id: 3, workspaceId: FOREIGN, name: "Theirs", entityType: "people", updatedAt: new Date() },
  );
  rows("prospects").push(
    { id: 101, workspaceId: WS, firstName: "Already", lastName: "Linked", email: "a@example.com" },
    { id: 102, workspaceId: WS, firstName: "On", lastName: "List", email: "b@example.com" },
  );
  rows("contacts").push(
    { id: 11, workspaceId: WS, firstName: "Ann", lastName: "A", email: "a@example.com", personProspectId: 101 },
    { id: 12, workspaceId: WS, firstName: "Ben", lastName: "B", email: "b@example.com", personProspectId: 102 },
    { id: 13, workspaceId: WS, firstName: "Cat", lastName: "C", email: "c@example.com", personProspectId: null },
    { id: 14, workspaceId: WS, firstName: "Unknown", lastName: "Prospect", email: null, personProspectId: null },
    { id: 31, workspaceId: FOREIGN, firstName: "Dee", lastName: "D", email: "d@example.com", personProspectId: null },
  );
  rows("record_list_members").push(
    member(1, 1, "prospect", 102),   // Ben is already on the list as a person
    member(2, 1, "contact", 11),     // linked contact → becomes person 101
    member(3, 1, "contact", 12),     // Ben again, as a contact → a duplicate, removed
    member(4, 1, "contact", 13),     // unlinked contact with an email → person created
    member(5, 1, "contact", 14),     // nothing to identify → kept, reported
    member(6, 1, "contact", 99),     // contact deleted → kept, reported
    member(7, 2, "contact", 11),     // a Companies list: not this pass's
    member(8, 3, "contact", 31, FOREIGN),
  );
});

describe("resolving a People list's old contact members", () => {
  it("each resolvable contact member becomes the person it maps to; the rest are kept and reported", async () => {
    const r = await resolveContactListMembers({ workspaceId: WS });
    expect(r.scanned).toBe(5);
    expect(r.converted).toBe(2);
    expect(r.duplicates).toBe(1);
    expect(r.unresolved.map((u) => [u.memberId, u.reason]).sort()).toEqual([[5, "no_identity"], [6, "contact_missing"]]);
    const list1 = rows("record_list_members").filter((m) => m.listId === 1).map((m) => [m.id, m.recordType, m.recordId]);
    expect(list1).toEqual([[1, "prospect", 102], [2, "prospect", 101], [4, "prospect", 513], [5, "contact", 14], [6, "contact", 99]]);
    // The Companies list and the other workspace's list are untouched.
    expect(rows("record_list_members").find((m) => m.id === 7)).toMatchObject({ recordType: "contact", recordId: 11 });
    expect(rows("record_list_members").find((m) => m.id === 8)).toMatchObject({ recordType: "contact", recordId: 31 });
    expect(h.created).toEqual([13]);
  });

  it("is idempotent: a second run converts nothing and reports the same two", async () => {
    await resolveContactListMembers({ workspaceId: WS });
    const before = JSON.stringify(rows("record_list_members"));
    const again = await resolveContactListMembers({ workspaceId: WS });
    expect(again).toMatchObject({ scanned: 2, converted: 0, duplicates: 0 });
    expect(again.unresolved).toHaveLength(2);
    expect(JSON.stringify(rows("record_list_members"))).toBe(before);
  });

  it("the boot pass covers every workspace, each against its own lists", async () => {
    const r = await resolveContactListMembers({});
    expect(r.converted).toBe(3);
    expect(rows("record_list_members").find((m) => m.id === 8)).toMatchObject({ recordType: "prospect", recordId: 531 });
  });

  it("the list page shows the converted people and counts the ones still unmatched", async () => {
    const before = await listMemberPage(WS, { id: 1 });
    expect(before.total).toBe(1);
    expect(before.unmatchedContacts).toBe(5);
    await resolveContactListMembers({ workspaceId: WS });
    const after = await listMemberPage(WS, { id: 1 });
    expect(after.rows.map((m) => m.recordId).sort()).toEqual([101, 102, 513]);
    expect(after.prospectIds.sort()).toEqual([101, 102, 513]);
    expect(after.unmatchedContacts).toBe(2);
  });

  it("the list page's button resolves one list and says why the rest stay", async () => {
    const r = await caller().recordLists.resolveContactMembers({ listId: 1 });
    expect(r).toMatchObject({ converted: 2, duplicates: 1 });
    expect(r.unresolved.map((u) => u.reason).sort()).toEqual(["the contact has no name, email or LinkedIn to make a person from", "the contact no longer exists"]);
    await expect(caller().recordLists.resolveContactMembers({ listId: 3 })).rejects.toThrow(/not in this workspace/);
  });
});

describe("wiring", () => {
  const ROOT = join(__dirname, "..");
  const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");
  it("runs once after boot, skipping archived workspaces", () => {
    const idx = read("server/_core/index.ts");
    const i = idx.indexOf('import("../services/listContactMembers")');
    expect(i).toBeGreaterThan(0);
    const block = idx.slice(i, idx.indexOf("}, 55_000);", i));
    expect(block).toContain("m.resolveContactListMembers({ skipWorkspaces: await archivedWorkspaceIds() })");
  });
  it("the list page says how many are unmatched and offers to match them", () => {
    const src = read("client/src/pages/usip/ListDetail.tsx");
    expect(src).toContain("trpc.recordLists.resolveContactMembers.useMutation(");
    const i = src.indexOf("!isCompanies && unmatchedContacts > 0 && (");
    expect(i).toBeGreaterThan(0);
    const block = src.slice(i, src.indexOf("{/* body */}", i));
    expect(block).toContain("not matched to People");
    expect(block).toContain("resolveContactsMut.mutate({ listId: id })");
    expect(block).toContain("Match to People");
  });
});
