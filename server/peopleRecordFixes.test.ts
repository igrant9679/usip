/**
 * People records: edits, archive, search, sort, saved views and the toolbar
 * (audit 2026-10-20, R33 · R47 · R51 · R56 · R59 · R60 · R64 · R85 · R87 ·
 * R95 · R96).
 *
 *   R51 · a changed email is unverified: it kept the old address's "valid",
 *         so the outreach gates passed an address nobody had checked
 *   R87 · edit limits are the columns', a cleared field is NULL, and a
 *         database refusal comes back as a reason, not SQL
 *   R64 · archiving hides a person from People; the Archived stage finds
 *         them; Restore puts them back in review
 *   R85 · % and _ in a search are characters, not wildcards
 *   R56 · promoteToLead says whether it made a lead
 *   R96 · "Number of employees" sorts by the company's headcount
 *   R59 · choosing the Default view is remembered; Verified email filters on
 *         a verdict rows hold
 *   R33 · deleting a contact or lead clears the People row's link to it
 *   R60 · the People toolbar shows only controls that do something
 *   R95 · the preview's Enrich fully refreshes the person it ran for
 *
 * Procedures run for real against the SQL-evaluating fake. Screens too large
 * to render here are pinned by reading their source, as the repo does.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { getTableName, type SQL } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => {
  if (!process.env.ENCRYPTION_KEY && !process.env.JWT_SECRET) process.env.ENCRYPTION_KEY = "b".repeat(64);
  return { db: null as any, roles: {} as Record<number, string>, likes: [] as unknown[][] };
});
vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { appRouter } from "./routers";
import { peopleOrder } from "./routers/prospects";
import { describeWriteError } from "./services/dbWriteError";

const WS = 2, OTHER = 9;
const root = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8").replace(/\r\n/g, "\n");
const rows = (t: string) => h.db.rowsOf(t) as any[];
const dialect = new MySqlDialect();

function caller(role = "manager", userId = 1) {
  h.roles[WS] = role;
  return appRouter.createCaller({
    user: { id: userId, openId: "u", email: "o@example.com", name: "O", loginMethod: "password", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
    req: { protocol: "https", headers: { "x-workspace-id": String(WS) } },
    res: { clearCookie: () => {} },
  } as unknown as TrpcContext);
}
async function refusal(p: Promise<unknown>) {
  try { await p; } catch (e: any) { return e; }
  throw new Error("expected a refusal");
}
const person = (id: number, o: Record<string, unknown> = {}) => ({
  id, workspaceId: WS, firstName: `P${id}`, lastName: "Person", email: `p${id}@acme.example`, title: null, company: "Acme",
  emailStatus: null, verificationStatus: null, linkedContactId: null, linkedLeadId: null, accountId: null,
  createdAt: new Date(2026, 9, id), ...o,
});
const list = (input: Record<string, unknown> = {}) => caller().prospects.list({ page: 1, perPage: 50, ...input } as any);

beforeEach(() => {
  h.roles = { [WS]: "manager" };
  h.db = makeSqlFakeDb({ roles: h.roles, wsId: () => WS });
  h.likes = [];
});

describe("R51 · a changed email is unverified", () => {
  beforeEach(() => {
    rows("prospects").push(person(1, {
      email: "old@acme.example", emailStatus: "valid", emailVerifiedAt: new Date("2026-10-01T00:00:00Z"),
      fieldProvenance: { email: { source: "reoon", confidence: 95, verification: "valid" }, title: { source: "linkedin", confidence: 80 } },
    }));
  });
  const p1 = () => rows("prospects").find((p) => p.id === 1);

  it("a new address drops the old verdict, and the ledger no longer vouches for it", async () => {
    const r = await caller().prospects.update({ id: 1, email: "new@acme.example" });
    expect(r).toMatchObject({ ok: true, emailUnverified: true });
    expect(p1()).toMatchObject({ email: "new@acme.example", emailStatus: null, emailVerifiedAt: null });
    expect(p1().fieldProvenance.email).toMatchObject({ source: "user" });
    expect(p1().fieldProvenance.email.verification).toBeUndefined();
    // Other fields' provenance is untouched.
    expect(p1().fieldProvenance.title).toEqual({ source: "linkedin", confidence: 80 });
  });

  it("the same address in another case, or another field, keeps the verdict", async () => {
    await caller().prospects.update({ id: 1, email: "OLD@acme.example", title: "CFO" });
    expect(p1()).toMatchObject({ emailStatus: "valid" });
    expect(p1().emailVerifiedAt).not.toBeNull();
  });

  it("clearing the address clears its verdict too", async () => {
    await caller().prospects.update({ id: 1, email: "" });
    expect(p1()).toMatchObject({ email: null, emailStatus: null, emailVerifiedAt: null });
    expect(p1().fieldProvenance.email).toBeUndefined();
  });

  it("the person page offers Verify to managers, and says a changed address is unverified", () => {
    const src = read("client/src/pages/usip/ProspectDetail.tsx");
    expect(src).toContain("const { isManager } = useWorkspaceRole();");
    expect(src).toContain("{isManager && (");
    expect(src).toContain("verify.mutate({ prospectId: id })");
    expect(src).toContain("trpc.prospects.verifyEmail.useMutation");
    expect(src).toContain('r.emailUnverified ? "Saved — the new email is unverified until you verify it" : "Saved"');
  });
});

describe("R87 · edits match the columns, and say why one fails", () => {
  beforeEach(() => { rows("prospects").push(person(1, { title: "VP", phone: "555", city: "Austin" })); });
  const p1 = () => rows("prospects").find((p) => p.id === 1);

  it("a title longer than the column is refused before the database", async () => {
    const e = await refusal(caller().prospects.update({ id: 1, title: "x".repeat(121) }));
    expect(e.code).toBe("BAD_REQUEST");
    expect(p1().title).toBe("VP");
    await caller().prospects.update({ id: 1, title: "y".repeat(120) });
    expect(p1().title).toHaveLength(120);
  });

  it("a cleared field is stored as NULL, not an empty string; names stay required", async () => {
    await caller().prospects.update({ id: 1, title: "", phone: "   ", city: " Dallas " });
    expect(p1()).toMatchObject({ title: null, phone: null, city: "Dallas" });
    expect((await refusal(caller().prospects.update({ id: 1, firstName: "   " }))).code).toBe("BAD_REQUEST");
  });

  it("a database refusal comes back as a reason, never the SQL", async () => {
    const real = h.db.update;
    h.db.update = () => ({ set: () => ({ where: () => Promise.reject(Object.assign(new Error("Failed query: update `prospects` set `company_domain` = ? ..."), {
      cause: { code: "ER_DATA_TOO_LONG", sqlMessage: "Data too long for column 'company_domain' at row 1" },
    })) }) });
    const e = await refusal(caller().prospects.update({ id: 1, companyDomain: "acme.example" }));
    h.db.update = real;
    expect(e.code).toBe("BAD_REQUEST");
    expect(e.message).toBe("Couldn't save: company domain is too long.");
    expect(e.message).not.toContain("Failed query");
  });

  it("the reasons it knows", () => {
    const wrap = (cause: unknown) => Object.assign(new Error("Failed query: insert into ..."), { cause });
    expect(describeWriteError(wrap({ code: "ER_DUP_ENTRY", sqlMessage: "Duplicate entry 'x' for key 'prospects.clodura_person_id'" })))
      .toBe("a record with this value already exists (prospects.clodura_person_id)");
    expect(describeWriteError(wrap({ code: "ER_BAD_NULL_ERROR", sqlMessage: "Column 'firstName' cannot be null" }))).toBe("firstName is required");
    expect(describeWriteError(wrap({ code: "ER_LOCK_WAIT_TIMEOUT", sqlMessage: "Lock wait timeout exceeded" }))).toBeNull();
    expect(describeWriteError(new Error("boom"))).toBeNull();
  });
});

describe("R64 · archive hides a person, and Restore brings them back", () => {
  beforeEach(() => {
    rows("prospects").push(person(1), person(2, { verificationStatus: "verified" }), person(3, { verificationStatus: "rejected" }), { ...person(4), workspaceId: OTHER, verificationStatus: "rejected" });
  });

  it("People lists no archived person unless the Archived stage is picked", async () => {
    expect((await list()).data.map((p: any) => p.id).sort()).toEqual([1, 2]);
    expect((await list()).total).toBe(2);
    expect((await list({ verificationStatus: "rejected" })).data.map((p: any) => p.id)).toEqual([3]);
    expect((await list({ verificationStatus: "verified" })).data.map((p: any) => p.id)).toEqual([2]);
  });

  it("archive hides them; restore puts them back in review, set by a human", async () => {
    await caller().prospects.archive({ id: 1 });
    expect((await list()).data.map((p: any) => p.id)).toEqual([2]);
    await caller().prospects.unarchive({ id: 1 });
    expect(rows("prospects").find((p) => p.id === 1)).toMatchObject({ verificationStatus: "needs_review", verificationSetBy: "human", verificationSetByUserId: 1 });
    expect((await list()).data.map((p: any) => p.id).sort()).toEqual([1, 2]);
    expect(rows("audit_log").filter((a) => a.entityType === "prospect_archive").map((a) => a.after)).toEqual([{ archived: true }, { archived: false }]);
  });

  it("restore refuses a person who isn't archived, and another workspace's", async () => {
    expect((await refusal(caller().prospects.unarchive({ id: 2 }))).code).toBe("BAD_REQUEST");
    expect(rows("prospects").find((p) => p.id === 2).verificationStatus).toBe("verified");
    expect((await refusal(caller().prospects.unarchive({ id: 4 }))).code).toBe("NOT_FOUND");
  });

  it("the person page asks before archiving, offers Restore, and People names the stage Archived", () => {
    const pd = read("client/src/pages/usip/ProspectDetail.tsx");
    const archiveButton = pd.slice(pd.indexOf('{p.verificationStatus === "rejected" ? ('), pd.indexOf("<Archive className"));
    expect(archiveButton).toContain("unarchive.mutate({ id })");
    expect(archiveButton).toContain("confirmAction({ title: `Archive ${fullName}?`");
    expect(archiveButton).toContain("() => { archive.mutate({ id }); })");
    expect(pd).not.toContain("onClick={() => archive.mutate({ id })}");
    expect(read("client/src/pages/usip/People.tsx")).toContain('{ v: "rejected", l: "Archived" },');
  });
});

describe("R85 · a search means the characters typed", () => {
  it("% and _ reach LIKE escaped, in every text filter", async () => {
    const real = h.db.select;
    h.db.select = (proj?: Record<string, unknown>) => {
      const b = real(proj);
      const where = b.where;
      b.where = (c: any) => { if (c) h.likes.push(dialect.sqlToQuery(c).params); return where(c); };
      return b;
    };
    await list({ search: "50%_off", titleQ: "a_b", companyQ: "100%", industryQ: "x\\y", locationQ: "St_Louis", seniorities: ["v%p"] });
    const params = h.likes.flat().filter((v) => typeof v === "string" && (v as string).startsWith("%"));
    expect(params).toEqual(expect.arrayContaining(["%50\\%\\_off%", "%a\\_b%", "%100\\%%", "%x\\\\y%", "%St\\_Louis%", "%v\\%p%"]));
    // Nothing went through unescaped.
    expect(params.filter((p) => /[^\\][%_]./.test(String(p).slice(1, -1)))).toEqual([]);
  });
});

describe("R56 · converting says whether a lead was made", () => {
  beforeEach(() => {
    rows("prospects").push(person(1, { email: "known@acme.example" }), person(2, { email: "fresh@acme.example" }));
    rows("leads").push({ id: 40, workspaceId: WS, firstName: "K", lastName: "N", email: "known@acme.example", status: "new" });
  });

  it("an existing lead matched by email is not reported as created", async () => {
    expect(await caller().prospects.promoteToLead({ prospectId: 1 })).toEqual({ leadId: 40, created: false });
    expect(rows("leads")).toHaveLength(1);
  });

  it("a new lead is", async () => {
    const r = await caller().prospects.promoteToLead({ prospectId: 2 });
    expect(r.created).toBe(true);
    expect(rows("leads")).toHaveLength(2);
  });

  it("the Saved filter names what it counts", () => {
    expect(read("client/src/pages/usip/People.tsx")).toContain('{ v: "promoted", l: "Saved (a lead or contact)" },');
  });
});

describe("R96 · Number of employees sorts by headcount, and the sort in effect is shown", () => {
  it("orders by the linked company's employee count, then id", () => {
    const [first, second] = peopleOrder("employees", "desc").map((o) => dialect.sqlToQuery(o as SQL).sql);
    expect(first).toBe("(SELECT `accounts`.`employee_count` FROM `accounts` WHERE `accounts`.`id` = `prospects`.`account_id`) desc");
    expect(second).toBe("`prospects`.`id` desc");
    expect(dialect.sqlToQuery(peopleOrder("company", "asc")[0] as SQL).sql).toBe("`prospects`.`company` asc");
  });

  it("the page asks the server for that sort, and rows carry the headcount the column shows", async () => {
    expect(read("client/src/pages/usip/People.tsx")).toContain('company: "company", phone: "phone", employees: "employees", industries: "industry",');
    rows("accounts").push({ id: 70, workspaceId: WS, name: "Acme", employeeCount: 1200 }, { id: 71, workspaceId: OTHER, name: "Theirs", employeeCount: 9 });
    rows("prospects").push(person(1, { accountId: 70 }), person(2), person(3, { accountId: 71 }));
    const r = await list({ sortField: "employees", sortDir: "desc" });
    expect(Object.fromEntries(r.data.map((p: any) => [p.id, p.companyEmployees]))).toEqual({ 1: 1200, 2: null, 3: null });
    const cell = read("client/src/components/usip/people/peopleShared.tsx");
    expect(cell).toContain("cell: (p) => (p.companyEmployees != null ?");
  });

  it("the Sort button names the active sort", async () => {
    const { sortLabel } = await import("../client/src/components/usip/people/SortMenu");
    expect(sortLabel({ field: "employees", dir: "desc" })).toBe("Sort: Company · Number of employees ↓");
    expect(sortLabel({ field: "name", dir: "asc" })).toBe("Sort: Name ↑");
    expect(read("client/src/pages/usip/People.tsx")).toContain("<SortMenu current={{ field: sortField, dir: sortDir }}");
  }, 30_000); // the first import of the menu's UI modules is slow under load
});

describe("R59 · the Default view is kept, and Verified email finds verified people", () => {
  beforeEach(() => {
    const at = new Date("2026-11-01T00:00:00Z");
    rows("saved_searches").push(
      { id: 1, workspaceId: WS, ownerUserId: 1, surface: "people", name: "Mine", config: {}, lastAppliedAt: at },
      { id: 2, workspaceId: WS, ownerUserId: 1, surface: "companies", name: "Co", config: {}, lastAppliedAt: at },
      { id: 3, workspaceId: WS, ownerUserId: 7, surface: "people", name: "Theirs", config: {}, lastAppliedAt: at },
      { id: 4, workspaceId: OTHER, ownerUserId: 1, surface: "people", name: "Elsewhere", config: {}, lastAppliedAt: at },
    );
  });

  it("clearApplied forgets only this user's People searches here", async () => {
    await caller("rep").savedSearches.clearApplied({ surface: "people" });
    const at = Object.fromEntries(rows("saved_searches").map((s) => [s.id, s.lastAppliedAt]));
    expect(at[1]).toBeNull();
    expect(at[2]).not.toBeNull();
    expect(at[3]).not.toBeNull();
    expect(at[4]).not.toBeNull();
  });

  it("the page calls it when the Default view is picked, and the chip filters on valid", () => {
    const src = read("client/src/pages/usip/People.tsx");
    expect(src).toContain('if (stamp && v.system) clearApplied.mutate({ surface: "people" });');
    expect(src).toContain('verified: () => { setEmailStatus("valid"); resetPage(); },');
    expect(src).not.toContain('setEmailStatus("verified")');
  });
});

describe("R33 · a deleted contact or lead leaves no link behind", () => {
  beforeEach(() => {
    rows("contacts").push({ id: 20, workspaceId: WS, firstName: "C", lastName: "T" });
    rows("leads").push({ id: 30, workspaceId: WS, firstName: "L", lastName: "D", status: "new" }, { id: 31, workspaceId: WS, firstName: "L", lastName: "E", status: "new" });
    rows("prospects").push(
      person(1, { linkedContactId: 20 }), person(2, { linkedLeadId: 30 }), person(3, { linkedLeadId: 31 }),
      { ...person(4), workspaceId: OTHER, linkedContactId: 20, linkedLeadId: 30 },
    );
  });
  const link = (id: number) => rows("prospects").find((p) => p.id === id);

  it("contacts.delete clears linkedContactId", async () => {
    await caller("rep").contacts.delete({ id: 20 });
    expect(link(1).linkedContactId).toBeNull();
    expect(link(4).linkedContactId).toBe(20);
  });

  it("leads.delete and leads.bulkDelete clear linkedLeadId", async () => {
    await caller("rep").leads.delete({ id: 30 });
    expect(link(2).linkedLeadId).toBeNull();
    await caller("rep").leads.bulkDelete({ ids: [31] });
    expect(link(3).linkedLeadId).toBeNull();
    expect(link(4).linkedLeadId).toBe(30);
  });
});

describe("R47 · the person page carries what the retired contact page had", () => {
  it("the CRM contact's custom fields render on the person's page", () => {
    expect(read("client/src/pages/usip/ProspectDetail.tsx"))
      .toContain('{p.linkedContactId ? <CustomFieldsPanel entityType="contact" entityId={p.linkedContactId} /> : null}');
  });
});

describe("R60 · the People toolbar shows only controls that do something", () => {
  it("no coming-soon placeholders in the selection toolbar", () => {
    const src = read("client/src/components/usip/people/SelectionToolbar.tsx");
    expect(src).not.toMatch(/soon\(/);
    expect(src).not.toContain("— coming soon for");
    for (const gone of ["/> Push to CRM/ATS", '"Merge duplicates"', '"Set Custom Field"', '"Change Stage"', '"View Companies"', '"Remove from lists"']) {
      expect(src, gone).not.toContain(gone);
    }
    expect(src).not.toMatch(/<Save className/);
  });

  it("no Create field button and no Keywords column on offer", () => {
    expect(read("client/src/components/usip/people/SearchSettingsSheet.tsx")).not.toContain("Create field");
    const shared = read("client/src/components/usip/people/peopleShared.tsx");
    expect(shared).toContain('{ columnKey: null, label: "Keywords", icon: Tag },');
    expect(shared).not.toContain('{ columnKey: "keywords"');
  });
});

describe("R95 · Enrich fully refreshes the person it ran for", () => {
  it("one preview per person, and the refresh reads the run's own input", () => {
    const src = read("client/src/pages/usip/People.tsx");
    const panel = src.slice(src.indexOf("<DetailPanel"), src.indexOf("onClose={() => setSelectedId(null)}"));
    expect(panel).toContain("key={selected.id}");
    const enrich = src.slice(src.indexOf("const enrichFull = trpc.prospects.enrichFull.useMutation"), src.indexOf("const d = (full ?? p)"));
    expect(enrich).toContain("onSuccess: (r, vars) => {");
    expect(enrich).toContain("utils.prospects.get.invalidate({ id: vars.prospectId });");
    expect(enrich).toContain("getProspectEnrichment.invalidate({ prospectId: vars.prospectId });");
    expect(enrich).not.toContain("p.id");
  });
});
