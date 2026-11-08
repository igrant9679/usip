/**
 * Audit final pass, batch CRMP (2026-11-07): one import pipeline.
 *
 *   R86 · validation does not take the whole CSV again: the upload is kept on
 *         the server under a token, and validation and commit read it
 *   F32 · one importer: the RFC 4180 parser, the file under a token, LeadRocks
 *         as a mapping preset (its verdict kept as provenance, not as the email
 *         status), a full downloadable error report, and "Undo this import"
 *         that removes what that import made and nothing else
 *   U27 · an import-history row opens its errors
 *
 * Run against the SQL fake; screens are pinned by source.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => {
  if (!process.env.ENCRYPTION_KEY && !process.env.JWT_SECRET) process.env.ENCRYPTION_KEY = "f".repeat(64);
  return { db: null as any, role: "rep", audits: [] as any[], wsId: 2 };
});
vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));
vi.mock("./audit", async (a) => ({ ...(await a<typeof import("./audit")>()), recordAudit: async (x: any) => { h.audits.push(x); } }));
// The contacts import links People synchronously; the link pass is its own test's business.
vi.mock("./services/personLink", async (a) => ({
  ...(await a<typeof import("./services/personLink")>()),
  linkUnlinkedContacts: async () => ({ scanned: 0, linked: 0, created: 0, failed: 0, skippedNoIdentity: 0 }),
}));

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { appRouter } from "./routers";

const WS = 2, OTHER = 9;
const OWNER = 1, TEAMMATE = 7;
const rows = (t: string) => h.db.rowsOf(t) as any[];
const read = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8").replace(/\r\n/g, "\n");
function caller(userId = OWNER, ws = WS) {
  h.wsId = ws;
  return appRouter.createCaller({
    user: { id: userId, openId: `u${userId}`, email: `u${userId}@example.com`, name: "U", loginMethod: "password", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
    req: { protocol: "https", headers: { "x-workspace-id": String(ws) } },
    res: { clearCookie: () => {} },
  } as unknown as TrpcContext);
}
async function refusal(p: Promise<unknown>): Promise<{ code: string; message: string }> {
  try { await p; } catch (e: any) { return { code: e.code, message: e.message }; }
  throw new Error("expected a refusal, but it resolved");
}
const peopleMapping = { "First Name": "firstName", "Last Name": "lastName", Email: "email", Company: "company" };
const commitPeople = (fileToken: string, userId = OWNER) => caller(userId).imports.commit({
  fileToken, filename: "people.csv", fieldMapping: peopleMapping, destination: "prospects", skipDuplicates: true, matchOnNameCompany: false,
});

beforeEach(() => {
  h.role = "rep";
  h.audits = [];
  h.db = makeSqlFakeDb({ roles: new Proxy({}, { get: (_t, k) => (Number(k) === WS || Number(k) === OTHER ? h.role : undefined) }) as Record<number, string>, wsId: () => h.wsId });
});

describe("the upload is kept under a token; validation and commit read it (R86)", () => {
  const csv = [
    "First Name,Last Name,Email,Company,Notes",
    'Ann,Lee,ann@acme.example,Acme,"Met at the fair,\nfollow up in May"',
    "Bo,Ng,bo@beta.example,Beta,",
  ].join("\n");

  it("parse keeps the file and answers with a token; validate and commit take only the token", async () => {
    const p = await caller().imports.parseCSV({ csvText: csv, filename: "people.csv" });
    expect(p.fileToken).toMatch(/^[0-9a-f-]{36}$/);
    // The quoted line break stays inside its cell: two rows, not three (RFC 4180).
    expect(p.totalRows).toBe(2);
    expect(rows("import_files")).toHaveLength(1);
    expect(rows("import_files")[0]).toMatchObject({ workspaceId: WS, userId: OWNER, content: csv });
    const v = await caller().imports.validateRows({ fileToken: p.fileToken, filename: "people.csv", fieldMapping: peopleMapping, destination: "prospects", skipDuplicates: true, matchOnNameCompany: false });
    expect(v).toMatchObject({ totalRows: 2, newCount: 2, errorCount: 0 });
    const r = await commitPeople(p.fileToken);
    expect(r.importedRows).toBe(2);
    expect(rows("prospects").map((x) => x.email)).toEqual(["ann@acme.example", "bo@beta.example"]);
    // Consumed: the same token cannot be committed twice.
    expect(rows("import_files")).toHaveLength(0);
    expect((await refusal(commitPeople(p.fileToken))).code).toBe("NOT_FOUND");
  });

  it("another person, or another workspace, cannot read or commit it", async () => {
    const p = await caller().imports.parseCSV({ csvText: csv, filename: "people.csv" });
    expect((await refusal(commitPeople(p.fileToken, TEAMMATE))).code).toBe("FORBIDDEN");
    expect((await refusal(caller(OWNER, OTHER).imports.validateRows({ fileToken: p.fileToken, filename: "x", fieldMapping: peopleMapping, destination: "prospects" }))).code).toBe("FORBIDDEN");
    expect(rows("prospects")).toHaveLength(0);
  });

  it("the page sends the token, not the file, to validation and commit", () => {
    const src = read("client/src/pages/usip/ImportContacts.tsx");
    const validate = src.slice(src.indexOf("async function handleValidate"), src.indexOf("/* ── Step 4: Commit ── */"));
    const commit = src.slice(src.indexOf("async function handleCommit"), src.indexOf("/* ── Download error report ── */"));
    for (const block of [validate, commit]) {
      expect(block).toContain("fileToken,");
      expect(block).not.toContain("csvText");
    }
  });
});

describe("LeadRocks is a preset of the same importer (F32)", () => {
  const header = "First Name,Last Name,Linked Url,Company Website,Company,Job Title,Direct Email #1,Direct Email #1 Status,Work Email #1,Work Email #1 Status,Phone #1,Location";
  const lr = [
    header,
    `Ann,Lee,https://www.linkedin.com/in/ann-lee,acme.example,Acme,CFO,,,ann@acme.example,ok_for_all,+1 512 555 0100,"Austin, TX, United States"`,
    `Bo,Ng,,beta.example,Beta,CTO,,,bo@beta.example,ok,,"Denver, CO, United States"`,
  ].join("\n");

  it("a LeadRocks file is read into the importer's own columns, with a mapping of its own", async () => {
    const p = await caller().imports.parseCSV({ csvText: lr, filename: "lr.csv" });
    expect(p).toMatchObject({ detectedPreset: "leadrocks", preset: "leadrocks" });
    expect(p.headers).toContain("LinkedIn URL");
    expect(p.previewRows[0]).toMatchObject({ "First Name": "Ann", Email: "ann@acme.example", City: "Austin", "State / Region": "TX", Country: "United States", Website: "acme.example", Phone: "+1 512 555 0100" });
    expect(p.presetMapping).toMatchObject({ "LinkedIn URL": "linkedinUrl", Email: "email", Website: "website" });
    // Read as it is, on request, without uploading again.
    const plain = await caller().imports.setPreset({ fileToken: p.fileToken, preset: null });
    expect(plain.preset).toBeNull();
    expect(plain.headers).toContain("Linked Url");
  });

  it("a row with no profile URL is an error; the verdict is provenance, not the email status", async () => {
    const p = await caller().imports.parseCSV({ csvText: lr, filename: "lr.csv" });
    const v = await caller().imports.validateRows({ fileToken: p.fileToken, filename: "lr.csv", fieldMapping: p.presetMapping!, destination: "prospects" });
    expect(v.errorRows).toEqual([{ rowIndex: 2, reason: "Missing LinkedIn URL" }]);
    const r = await caller().imports.commit({ fileToken: p.fileToken, filename: "lr.csv", fieldMapping: p.presetMapping!, destination: "prospects" });
    expect(r.importedRows).toBe(1);
    const ann = rows("prospects")[0];
    expect(ann).toMatchObject({ firstName: "Ann", email: "ann@acme.example", linkedinUrl: "https://www.linkedin.com/in/ann-lee", city: "Austin", country: "United States", companyDomain: "acme.example" });
    expect(ann.emailStatus ?? null).toBeNull();
    expect(ann.fieldProvenance.email).toMatchObject({ source: "leadrocks", verification: "ok_for_all", slot: "work" });
    expect(rows("contact_imports")[0]).toMatchObject({ preset: "leadrocks", destination: "prospects" });
  });

  it("the separate LeadRocks importer is gone, and the page offers the preset", () => {
    expect(existsSync(join(__dirname, "routers", "prospectImports.ts"))).toBe(false);
    expect(existsSync(join(__dirname, "..", "client", "src", "pages", "usip", "ProspectImportDialog.tsx"))).toBe(false);
    expect((appRouter as any)._def.record.prospectImports).toBeUndefined();
    const src = read("client/src/pages/usip/ImportContacts.tsx");
    expect(src).toContain(`data-testid="leadrocks-preset"`);
    expect(src).toContain(`onClick={() => void switchPreset(null)}>Read as a plain CSV</Button>`);
  });
});

describe("the full error report, every row with its own columns (F32)", () => {
  const many = ["First Name,Last Name,Email,Company", ...Array.from({ length: 250 }, (_, i) => `P${i},Q,not-an-address-${i},Acme`), "=HYPERLINK(\"x\"),Q,bad,Acme", "Ok,Row,ok@acme.example,Acme"].join("\n");

  it("before the import: from the stored upload, all of them, safe in a spreadsheet", async () => {
    const p = await caller().imports.parseCSV({ csvText: many, filename: "many.csv" });
    await caller().imports.validateRows({ fileToken: p.fileToken, filename: "many.csv", fieldMapping: peopleMapping, destination: "prospects" });
    const rep = await caller().imports.errorReport({ fileToken: p.fileToken });
    expect(rep.count).toBe(251);
    const lines = rep.csv.split("\n");
    expect(lines[0]).toBe("First Name,Last Name,Email,Company,Row,Reason");
    expect(lines).toHaveLength(252);
    expect(lines[1]).toBe("P0,Q,not-an-address-0,Acme,1,Invalid email format: not-an-address-0");
    // A formula cell is neutralised (G49).
    expect(lines[251].startsWith("\"'=HYPERLINK")).toBe(true);
  });

  it("after it: every error and duplicate row the import recorded, and the history opens them a page at a time", async () => {
    const p = await caller().imports.parseCSV({ csvText: many, filename: "many.csv" });
    const r = await commitPeople(p.fileToken);
    expect(r).toMatchObject({ importedRows: 1, errorRows: 251 });
    const rep = await caller().imports.errorReport({ importId: r.importId });
    expect(rep.count).toBe(251);
    expect(rep.csv.split("\n")).toHaveLength(252);
    const page2 = await caller().imports.getImport({ importId: r.importId, page: 2, perPage: 100 });
    expect(page2.errorTotal).toBe(251);
    expect(page2.errorRows.map((x: any) => x.rowIndex)[0]).toBe(101);
    expect((await refusal(caller(OWNER, OTHER).imports.errorReport({ importId: r.importId }))).code).toBe("NOT_FOUND");
  });

  it("the page downloads the server's report, and a history row opens its errors", () => {
    const src = read("client/src/pages/usip/ImportContacts.tsx");
    expect(src).toContain("const r = await utils.imports.errorReport.fetch({ fileToken });");
    expect(src).toContain("{...pressable(() => setOpenId(h.id))}");
    expect(src).toContain("trpc.imports.getImport.useQuery({ importId, page, perPage: PER }");
    expect(src).toContain("const r = await utils.imports.errorReport.fetch({ importId });");
  });
});

describe("Undo this import removes what it made and nothing else (F32)", () => {
  it("a People import: its rows go, except those since promoted, enrolled or in a campaign; others' rows stay", async () => {
    rows("prospects").push({ id: 1, workspaceId: WS, firstName: "Old", lastName: "Row", email: "old@acme.example", company: "Acme" });
    const csv = ["First Name,Last Name,Email,Company", "A,One,a@acme.example,Acme", "B,Two,b@acme.example,Acme", "C,Three,c@acme.example,Acme", "D,Four,d@acme.example,Acme"].join("\n");
    const p = await caller().imports.parseCSV({ csvText: csv, filename: "people.csv" });
    const r = await commitPeople(p.fileToken);
    const made = rows("prospects").filter((x) => x.id !== 1);
    expect(made).toHaveLength(4);
    made[1].linkedLeadId = 500; // promoted since
    rows("enrollments").push({ id: 1, workspaceId: WS, prospectId: made[2].id, status: "active" });
    const s = await caller().imports.undo({ importId: r.importId });
    expect(s).toMatchObject({ removedPeople: 2, keptInUse: 2, removedContacts: 0 });
    expect(rows("prospects").map((x) => x.id).sort((a, b) => a - b)).toEqual([1, made[1].id, made[2].id].sort((a, b) => a - b));
    expect(rows("contact_imports")[0].undoneAt).toBeInstanceOf(Date);
    // The removed rows are in the audit entry, to restore from.
    const audit = h.audits.find((a) => a.entityType === "contact_import_undo");
    expect(audit.before.people.map((x: any) => x.email).sort()).toEqual(["a@acme.example", "d@acme.example"]);
    expect((await refusal(caller().imports.undo({ importId: r.importId }))).code).toBe("CONFLICT");
  });

  it("a contacts import: its contacts, the People rows its linking made, and its unused companies go; older ones are unlinked or kept", async () => {
    rows("accounts").push({ id: 40, workspaceId: WS, name: "Beta", domain: null, archivedAt: null });
    const csv = ["First Name,Last Name,Email,Company", "A,One,a@acme.example,Acme", "B,Two,b@beta.example,Beta"].join("\n");
    const p = await caller().imports.parseCSV({ csvText: csv, filename: "contacts.csv" });
    const T = new Date("2026-11-07T10:00:00Z");
    const r = await caller().imports.commit({ fileToken: p.fileToken, filename: "contacts.csv", fieldMapping: peopleMapping, destination: "contacts" });
    rows("contact_imports")[0].createdAt = T;
    const [a, b] = rows("contacts");
    const acme = rows("accounts").find((x) => x.name === "Acme");
    expect(rows("contact_imports")[0].createdAccountIds).toEqual([acme.id]);
    expect(b.accountId).toBe(40);
    rows("prospects").push(
      { id: 900, workspaceId: WS, firstName: "A", lastName: "One", linkedContactId: a.id, linkedLeadId: null, createdAt: new Date("2026-11-07T10:00:05Z") },
      { id: 901, workspaceId: WS, firstName: "B", lastName: "Two", linkedContactId: b.id, linkedLeadId: null, createdAt: new Date("2026-01-01T00:00:00Z") },
    );
    const s = await caller().imports.undo({ importId: r.importId });
    expect(s).toMatchObject({ removedContacts: 2, removedPeople: 1, unlinkedPeople: 1, removedCompanies: 1 });
    expect(rows("contacts")).toHaveLength(0);
    expect(rows("prospects").map((x) => [x.id, x.linkedContactId])).toEqual([[901, null]]);
    expect(rows("accounts").map((x) => x.id)).toEqual([40]);
  });

  it("the person who ran it or a manager may undo it; nobody in another workspace", async () => {
    const p = await caller().imports.parseCSV({ csvText: "First Name,Last Name,Email,Company\nA,One,a@acme.example,Acme", filename: "x.csv" });
    const r = await commitPeople(p.fileToken);
    expect((await refusal(caller(TEAMMATE).imports.undo({ importId: r.importId }))).code).toBe("FORBIDDEN");
    expect((await refusal(caller(OWNER, OTHER).imports.undo({ importId: r.importId }))).code).toBe("NOT_FOUND");
    h.role = "manager";
    expect((await caller(TEAMMATE).imports.undo({ importId: r.importId })).removedPeople).toBe(1);
  });

  it("the page asks first and says what is kept", () => {
    const src = read("client/src/pages/usip/ImportContacts.tsx");
    const btn = src.slice(src.indexOf("function UndoImportButton"));
    expect(btn).toContain(`title: "Undo this import?",`);
    expect(btn).toContain("() => undo.mutate({ importId })");
    expect(src).toContain("<UndoImportButton importId={importResult.importId}");
  });
});
