/**
 * Audit final pass, batch CRMP (2026-11-07): lists and the LinkedIn import.
 *
 *   U19 · a list's member rows open their record; members can be selected and
 *         removed together, with Undo
 *   U31 · a list's description can be entered; records already on the list are
 *         marked in Add; an owner filter on a list's members and on the Lists
 *         index; the LinkedIn import's column mapping shows a preview first
 *
 * Procedures run against the SQL fake; screens are pinned by source.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => {
  if (!process.env.ENCRYPTION_KEY && !process.env.JWT_SECRET) process.env.ENCRYPTION_KEY = "c".repeat(64);
  return { db: null as any };
});
vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));
vi.mock("./audit", async (a) => ({ ...(await a<typeof import("./audit")>()), recordAudit: async () => {} }));

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { appRouter } from "./routers";
import { listMemberPage } from "./services/listMembers";
import { columnSamples, mappingPreview, parseCsvRecords, findHeaderRow, guessMapping } from "../client/src/lib/linkedinCsv";

const WS = 2, OTHER = 9;
const ME = 1, TEAMMATE = 3;
const rows = (t: string) => h.db.rowsOf(t) as any[];
const read = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8").replace(/\r\n/g, "\n");
const block = (src: string, start: string, end: string) => {
  const i = src.indexOf(start);
  if (i < 0) throw new Error(`missing ${start}`);
  const j = src.indexOf(end, i + start.length);
  return src.slice(i, j < 0 ? undefined : j);
};
function caller() {
  return appRouter.createCaller({
    user: { id: ME, openId: "u", email: "o@example.com", name: "O", loginMethod: "password", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
    req: { protocol: "https", headers: { "x-workspace-id": String(WS) } },
    res: { clearCookie: () => {} },
  } as unknown as TrpcContext);
}
async function refusal(p: Promise<unknown>): Promise<{ code: string; message: string }> {
  try { await p; } catch (e: any) { return { code: e.code, message: e.message }; }
  throw new Error("expected a refusal, but it resolved");
}

const person = (id: number, accountId: number | null, ws = WS) => ({ id, workspaceId: ws, firstName: `P${id}`, lastName: "Z", title: null, company: "Acme", email: null, emailStatus: null, linkedinUrl: null, city: null, state: null, country: null, accountId });
const company = (id: number, ownerUserId: number, ws = WS) => ({ id, workspaceId: ws, name: `Co ${id}`, domain: null, industry: null, region: null, arr: null, archivedAt: null, ownerUserId });
let mid = 0;
const member = (listId: number, recordType: string, recordId: number, ws = WS) => ({ id: ++mid, workspaceId: ws, listId, recordType, recordId, addedByUserId: ME, addedAt: new Date(Date.UTC(2026, 9, 1, 0, mid)) });

beforeEach(() => {
  h.db = makeSqlFakeDb({ roles: { [WS]: "rep" }, wsId: () => WS });
  mid = 0;
  rows("record_lists").push(
    { id: 7, workspaceId: WS, name: "Buyers", entityType: "people", updatedAt: new Date(0) },
    { id: 8, workspaceId: WS, name: "Targets", entityType: "companies", updatedAt: new Date(0) },
    { id: 10, workspaceId: WS, name: "Other buyers", entityType: "people", updatedAt: new Date(0) },
    { id: 9, workspaceId: OTHER, name: "Theirs", entityType: "people", updatedAt: new Date(0) },
  );
  rows("accounts").push(company(50, ME), company(51, TEAMMATE), company(52, ME, OTHER));
  rows("prospects").push(person(1, 50), person(2, 51), person(3, null), person(4, 52));
});

describe("members are removed together, with what was removed handed back (U19)", () => {
  beforeEach(() => {
    rows("record_list_members").push(member(7, "prospect", 1), member(7, "prospect", 2), member(7, "prospect", 3), member(10, "prospect", 1), member(9, "prospect", 1, OTHER));
  });

  it("removes only the chosen members of this list", async () => {
    const r = await caller().recordLists.removeMembers({ listId: 7, memberIds: [1, 2, 4, 5] });
    expect(r).toEqual({ removed: 2, listId: 7, recordType: "prospect", recordIds: [1, 2] });
    expect(rows("record_list_members").map((m) => m.id).sort()).toEqual([3, 4, 5]);
    expect(rows("record_lists").find((l) => l.id === 7).updatedAt.getTime()).toBeGreaterThan(0);
  });

  it("refuses another workspace's list and removes nothing", async () => {
    expect((await refusal(caller().recordLists.removeMembers({ listId: 9, memberIds: [5] }))).code).toBe("NOT_FOUND");
    expect(rows("record_list_members")).toHaveLength(5);
  });

  it("Undo puts them back through addMembers", async () => {
    const r = await caller().recordLists.removeMembers({ listId: 7, memberIds: [1, 2] });
    await caller().recordLists.addMembers({ listId: r.listId, recordType: "prospect", recordIds: r.recordIds });
    expect(rows("record_list_members").filter((m) => m.listId === 7).map((m) => m.recordId).sort()).toEqual([1, 2, 3]);
  });

  it("the page selects rows, removes them together, offers Undo, and each row opens its record", () => {
    const src = read("client/src/pages/usip/ListDetail.tsx");
    expect(src).toContain("removeManyMut.mutate({ listId: id, memberIds: Array.from(selected) })");
    expect(src).toContain(`action: { label: "Undo", onClick: () => putBackMut.mutate({ listId: res.listId, recordType: res.recordType as "prospect" | "account", recordIds: res.recordIds }) },`);
    expect(src).toContain("const href = m.recordType === \"account\" ? `/v2/companies/${m.recordId}` : `/prospects/${m.recordId}`;");
    expect(src).toContain("{...pressable(() => setLocation(href), { row: true })}");
    expect(src).toContain(`aria-label="Select every member on this page"`);
  });
});

describe("records already on the list are marked in Add (U31)", () => {
  beforeEach(() => {
    rows("record_list_members").push(member(7, "prospect", 1), member(7, "contact", 2), member(8, "account", 51), member(9, "prospect", 3, OTHER));
  });

  it("membership names this list's records of its own kind only", async () => {
    expect(await caller().recordLists.membership({ id: 7, recordIds: [1, 2, 3] })).toEqual([1]);
    expect(await caller().recordLists.membership({ id: 8, recordIds: [50, 51] })).toEqual([51]);
    expect((await refusal(caller().recordLists.membership({ id: 9, recordIds: [3] }))).code).toBe("NOT_FOUND");
  });

  it("the Add dialog asks for the list it adds to, marks those records and does not let them be picked", () => {
    const src = read("client/src/pages/usip/ListDetail.tsx");
    const dialog = block(src, "export function AddRecordsDialog", "\n}\n");
    expect(dialog).toContain("trpc.recordLists.membership.useQuery(");
    expect(dialog).toContain("const toggle = (id: number) => { if (onList.has(id)) return;");
    expect(dialog).toContain("On this list");
    expect(src).toContain("listId={id}");
    // Companies are searched on the server too, not loaded whole (X4.1).
    expect(dialog).toContain("trpc.accounts.list.useQuery({ search: search || undefined, limit: 100 }");
  });
});

describe("an owner filter on a list's members (U31)", () => {
  beforeEach(() => {
    rows("record_list_members").push(member(7, "prospect", 1), member(7, "prospect", 2), member(7, "prospect", 3), member(8, "account", 50), member(8, "account", 51));
  });

  it("a Companies list filters by the company's owner", async () => {
    const r = await listMemberPage(WS, { id: 8, ownerUserId: TEAMMATE });
    expect(r.rows.map((m) => m.recordId)).toEqual([51]);
    expect(r.total).toBe(1);
  });

  it("a People list filters by the owner of the company each person is filed under", async () => {
    expect((await listMemberPage(WS, { id: 7, ownerUserId: ME })).rows.map((m) => m.recordId)).toEqual([1]);
    expect((await listMemberPage(WS, { id: 7, ownerUserId: TEAMMATE })).rows.map((m) => m.recordId)).toEqual([2]);
    expect((await listMemberPage(WS, { id: 7 })).total).toBe(3);
  });

  it("the page offers the filter and passes it, and the Lists index filters by who made each list", () => {
    const detail = read("client/src/pages/usip/ListDetail.tsx");
    expect(detail).toContain("ownerUserId: owner ? Number(owner) : undefined },");
    expect(detail).toContain(`<option value="">Any owner</option>`);
    const lists = read("client/src/pages/usip/Lists.tsx");
    expect(lists).toContain(`const ownerMatches = (l: RecordList) => !owner || l.createdByUserId === (owner === "me" ? user?.id : Number(owner));`);
    expect(lists).toContain(`<option value="me">Made by me</option>`);
  });
});

describe("a list's description can be entered (U31)", () => {
  it("create stores it and update changes or clears it", async () => {
    const { id } = await caller().recordLists.create({ name: "Q1 events", description: "  People met at Q1 events  " });
    expect(rows("record_lists").find((l) => l.id === id).description).toBe("People met at Q1 events");
    await caller().recordLists.update({ id, description: null });
    expect(rows("record_lists").find((l) => l.id === id).description).toBeNull();
  });

  it("the New list and Rename dialogs and the list page take a description", () => {
    const lists = read("client/src/pages/usip/Lists.tsx");
    expect(lists).toContain(`description: newDescription.trim() || undefined },`);
    expect(lists).toContain("renameMut.mutate({ id: renaming.id, name: renameTo.trim(), description });");
    expect(read("client/src/pages/usip/ListDetail.tsx")).toContain("descMut.mutate({ id: list.id, description: descDraft.trim() || null })");
  });
});

describe("the LinkedIn import shows what its column mapping reads, first (U31)", () => {
  const csv = [
    "Notes: exported from LinkedIn",
    "First Name,Last Name,URL,Company",
    "Ann,Lee,https://www.linkedin.com/in/ann-lee,Acme",
    "Bo,Ng,,Beta",
    "Cy,Fox,https://example.com/cy,Gamma",
    "Di,Ra,https://www.linkedin.com/in/di-ra,Acme",
  ].join("\n");

  it("samples each column and previews the first rows as the mapping reads them", () => {
    const records = parseCsvRecords(csv);
    const headerRow = findHeaderRow(records);
    expect(headerRow).toBe(1);
    const map = guessMapping(records, headerRow);
    expect(columnSamples(records, headerRow)[3]).toEqual(["Acme", "Beta"]);
    const p = mappingPreview(records, headerRow, map, 3);
    expect(p.fields).toEqual(["linkedinUrl", "firstName", "lastName", "company"]);
    expect(p.rows.map((r) => [r.line, r.status])).toEqual([[3, "ok"], [4, "no_url"], [5, "not_profile"]]);
    expect(p.rows[0].values).toEqual({ linkedinUrl: "https://www.linkedin.com/in/ann-lee", firstName: "Ann", lastName: "Lee", company: "Acme" });
    expect([p.noUrl, p.notProfile]).toEqual([1, 1]);
  });

  it("the page renders the preview under the mapping and names each column by its contents", () => {
    const src = read("client/src/pages/usip/LinkedInEnrichmentImport.tsx");
    expect(src).toContain("mappingPreview(file.records, file.headerRow, file.mapping)");
    expect(src).toContain(`data-testid="linkedin-mapping-preview"`);
    expect(src).toContain("{c}{samples[i]?.length ? ` — e.g. ${samples[i].join(\", \")}` : \" — empty\"}");
  });
});
