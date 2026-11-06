/**
 * Prospect imports and the Add to… menu (audit 2026-10-20, R48 · R54 · R90).
 *
 *   R54 · a CSV imported into People keeps industry, state and country; a row
 *         the database refuses says why; LeadRocks recognises one profile
 *         however its URL is written, in the file and against People; the
 *         LeadRocks result lists the real reasons rows failed
 *   R90 · a preview is capped at 20 MB, a person has one pending preview per
 *         workspace, and only its owner can discard it
 *   R48 · picking a campaign or sequence is a review that enrols on Confirm,
 *         and List adds the people to a list instead of opening the Lists page
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getTableName } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => {
  if (!process.env.ENCRYPTION_KEY && !process.env.JWT_SECRET) process.env.ENCRYPTION_KEY = "b".repeat(64);
  return { db: null as any, wsId: 2, refuse: null as null | ((table: string, row: any) => unknown) };
});
vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));
// Company association after a LeadRocks commit is best-effort background work.
vi.mock("./services/company/associationService", async (a) => ({ ...(await a<typeof import("./services/company/associationService")>()), associateUnlinkedProspects: async () => ({}) }));

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { appRouter } from "./routers";
import { PREVIEW_CSV_MAX } from "./routers/prospectImports";

const WS = 2, OTHER = 9;
const root = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8").replace(/\r\n/g, "\n");
const rows = (t: string) => h.db.rowsOf(t) as any[];

function caller(userId = 1, ws = WS) {
  h.wsId = ws;
  return appRouter.createCaller({
    user: { id: userId, openId: `u${userId}`, email: "o@example.com", name: "O", loginMethod: "password", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
    req: { protocol: "https", headers: { "x-workspace-id": String(ws) } },
    res: { clearCookie: () => {} },
  } as unknown as TrpcContext);
}
async function refusal(p: Promise<unknown>) {
  try { await p; } catch (e: any) { return e; }
  throw new Error("expected a refusal");
}
const tooLong = () => Object.assign(new Error("Failed query: insert into `prospects` ..."), {
  cause: { code: "ER_DATA_TOO_LONG", sqlMessage: "Data too long for column 'title' at row 1" },
});

beforeEach(() => {
  h.db = makeSqlFakeDb({ roles: { [WS]: "rep", [OTHER]: "rep" }, wsId: () => h.wsId });
  h.refuse = null;
  // A database that refuses some rows the way MySQL strict mode does.
  const realInsert = h.db.insert;
  h.db.insert = (table: any) => {
    const chain = realInsert(table);
    const values = chain.values;
    chain.values = (v: any) => {
      const list = Array.isArray(v) ? v : [v];
      const err = h.refuse && list.map((r) => h.refuse!(getTableName(table), r)).find(Boolean);
      if (err) {
        const fail: any = { $returningId: () => Promise.reject(err), then: (_r: any, rej: any) => rej(err), onDuplicateKeyUpdate: () => fail, ignore: () => fail };
        return fail;
      }
      return values(v);
    };
    return chain;
  };
});

describe("R54 · a CSV into People keeps its fields, and says why a row failed", () => {
  const csv = [
    "First Name,Last Name,Email,Company,Title,Industry,State,Country",
    "Jane,Doe,jane@acme.example,Acme,CFO,Banking,TX,United States",
    "Bad,Row,bad@acme.example,Acme,Too long,Retail,CA,Canada",
  ].join("\n");
  const mapping = { "First Name": "firstName", "Last Name": "lastName", Email: "email", Company: "company", Title: "title", Industry: "industry", State: "state", Country: "country" };

  it("industry, state and country land on the People row; a refused row carries the database's reason", async () => {
    h.refuse = (table, row) => (table === "prospects" && row.firstName === "Bad" ? tooLong() : null);
    const r = await caller().imports.commit({ csvText: csv, filename: "people.csv", fieldMapping: mapping, destination: "prospects", skipDuplicates: true, matchOnNameCompany: false });
    expect(r).toMatchObject({ importedRows: 1, errorRows: 1 });
    expect(rows("prospects")).toHaveLength(1);
    expect(rows("prospects")[0]).toMatchObject({ firstName: "Jane", industry: "Banking", state: "TX", country: "United States" });
    const failed = rows("contact_import_rows").find((x) => x.status === "error");
    expect(failed.errorReason).toBe("Not saved: title is too long");
  });
});

describe("R54 · LeadRocks knows one profile however it is written", () => {
  const header = "First Name,Last Name,Linked Url,Company Website,Company,Job Title,Work Email #1,Work Email #1 Status,Location,Industry";
  const line = (first: string, last: string, url: string) => `${first},${last},${url},acme.example,Acme,CFO,${first.toLowerCase()}@acme.example,ok,"Austin, TX, United States",Banking`;

  it("dedupes in the file and against People on the profile, not the raw URL", async () => {
    rows("prospects").push(
      { id: 1, workspaceId: WS, firstName: "Jo", lastName: "Roe", linkedinUrl: "http://linkedin.com/in/jo-roe/" },
      { id: 2, workspaceId: OTHER, firstName: "Al", lastName: "Bee", linkedinUrl: "https://www.linkedin.com/in/al-bee" },
    );
    const csv = [
      header,
      line("Jane", "Doe", "https://www.linkedin.com/in/Jane-Doe/"),
      line("Jane", "Doe", "linkedin.com/in/jane-doe?trk=people"),
      line("Jo", "Roe", "https://www.linkedin.com/in/jo-roe"),
      line("Al", "Bee", "https://linkedin.com/in/al-bee/"),
    ].join("\n");
    const p = await caller().prospectImports.parsePreview({ csv, filename: "lr.csv" });
    expect(p).toMatchObject({ totalRows: 4, duplicateInFile: 1, alreadyExisting: 1, toImport: 2 });
    expect(p.sample.map((s: any) => `${s.firstName} ${s.lastName}`)).toEqual(["Jane Doe", "Al Bee"]);
  });

  it("the commit result lists why rows failed, not a guess", async () => {
    const csv = [header, line("Jane", "Doe", "https://www.linkedin.com/in/jane-doe"), line("Bad", "Row", "https://www.linkedin.com/in/bad-row")].join("\n");
    const p = await caller().prospectImports.parsePreview({ csv, filename: "lr.csv" });
    h.refuse = (table, row) => (table === "prospects" && row.firstName === "Bad" ? tooLong() : null);
    const r = await caller().prospectImports.commit({ importToken: p.importToken });
    expect(r).toMatchObject({ created: 1, errored: 1, failureReasons: [{ reason: "title is too long", count: 1 }] });
    const dialog = read("client/src/pages/usip/ProspectImportDialog.tsx");
    expect(dialog).not.toContain("Likely a race-condition duplicate");
    expect(dialog).toContain("{(result.failureReasons ?? []).map((r) => (");
  });
});

describe("R90 · previews are capped, one per person, and only theirs to discard", () => {
  const csv = (n: number) => ["First Name,Last Name,Linked Url,Company Website,Work Email #1", ...Array.from({ length: n }, (_, i) => `P${i},Q,https://www.linkedin.com/in/p${i},acme.example,p${i}@acme.example`)].join("\n");

  it("refuses a CSV over 20 MB, and the dialog says so before uploading", async () => {
    expect(PREVIEW_CSV_MAX).toBe(20_000_000);
    const big = "x".repeat(PREVIEW_CSV_MAX + 1);
    expect((await refusal(caller().prospectImports.parsePreview({ csv: big }))).code).toBe("BAD_REQUEST");
    expect(read("client/src/pages/usip/ProspectImportDialog.tsx")).toContain("if (file.size > 20_000_000) {");
  });

  it("a second preview replaces the first; another person's stays", async () => {
    const first = await caller(1).prospectImports.parsePreview({ csv: csv(2) });
    const theirs = await caller(7).prospectImports.parsePreview({ csv: csv(2) });
    const second = await caller(1).prospectImports.parsePreview({ csv: csv(3) });
    expect((await refusal(caller(1).prospectImports.commit({ importToken: first.importToken }))).code).toBe("NOT_FOUND");
    expect((await caller(7).prospectImports.commit({ importToken: theirs.importToken })).created).toBe(2);
    expect((await caller(1).prospectImports.commit({ importToken: second.importToken })).created).toBe(3);
  });

  it("discard is the owner's, in the owner's workspace", async () => {
    const p = await caller(1).prospectImports.parsePreview({ csv: csv(1) });
    expect((await refusal(caller(7).prospectImports.discard({ importToken: p.importToken }))).code).toBe("FORBIDDEN");
    expect((await refusal(caller(1, OTHER).prospectImports.discard({ importToken: p.importToken }))).code).toBe("FORBIDDEN");
    // Still there: its owner can commit it.
    expect((await caller(1).prospectImports.commit({ importToken: p.importToken })).created).toBe(1);
    const q = await caller(1).prospectImports.parsePreview({ csv: csv(1).replace("p0", "z0").replace("p0@", "z0@") });
    await caller(1).prospectImports.discard({ importToken: q.importToken });
    expect((await refusal(caller(1).prospectImports.commit({ importToken: q.importToken }))).code).toBe("NOT_FOUND");
  });
});

describe("R48 · Add to… reviews before it enrols, and List adds to a list", () => {
  const src = () => read("client/src/components/usip/AddToMenu.tsx");

  it("a campaign or sequence row only picks; Confirm enrols", () => {
    const s = src();
    expect(s).toContain('onClick={() => setPicked({ kind: "campaign", id: c.id, name: c.name, status: c.status })}');
    expect(s).toContain('onClick={() => setPicked({ kind: "sequence", id: s.id, name: s.name, status: s.status })}');
    // Each engine is called from one place: the Confirm handler.
    expect(s.split("pushExisting.mutate(").length - 1).toBe(1);
    expect(s.split("bulkEnroll.mutate(").length - 1).toBe(1);
    const confirm = s.slice(s.indexOf("const confirm = () => {"), s.indexOf("// The review: what Confirm will do"));
    expect(confirm).toContain('if (picked.kind === "campaign") pushExisting.mutate({ campaignId: picked.id, prospectIds, contactIds, leadIds });');
    expect(confirm).toContain("else bulkEnroll.mutate({ sequenceId: picked.id, prospectIds, contactIds, leadIds });");
    // Both panes show the review.
    expect(s.split("{review}").length - 1).toBe(2);
    expect(s).toContain("<Button size=\"sm\" onClick={confirm} disabled={pending}>");
  });

  it("List adds the selected people to the picked list, and no longer just opens /v2/lists", () => {
    const s = src();
    expect(s).not.toContain('<Link href="/v2/lists" onClick={close}');
    expect(s).toContain('addToList.mutate({ listId, recordType: "prospect", recordIds: prospectIds })');
    expect(s).toContain("trpc.recordLists.addMembers.useMutation");
  });

  it("the list it adds to gets the people, through the real procedure", async () => {
    rows("record_lists").push({ id: 5, workspaceId: WS, name: "Hot", entityType: "people", createdByUserId: 1 });
    rows("prospects").push({ id: 1, workspaceId: WS, firstName: "A", lastName: "B" }, { id: 2, workspaceId: WS, firstName: "C", lastName: "D" });
    const r = await caller().recordLists.addMembers({ listId: 5, recordType: "prospect", recordIds: [1, 2] });
    expect(r.added).toBe(2);
  });
});
