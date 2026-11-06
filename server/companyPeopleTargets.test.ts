/**
 * The company profile: who "Add N people to…" enrols, who sees Enrich and
 * Archive, one people count, and a restore (audit 2026-10-20, R3 · R10 · R47 ·
 * R64 · R65).
 *
 *   R3  · the profile sends People rows as prospect ids and CRM contacts as
 *         contact ids, each once; a contact that is a listed People row's own
 *         link is not sent again. It sent every id as a contact id, so People
 *         row 5 enrolled CONTACT 5, a different person.
 *   R10 · Enrich, Archive and Recalculate follow the WORKSPACE role, not the
 *         platform role, and no client screen ranks the platform role.
 *   R65 · header, list, People section and merge dialog give one number.
 *   R64 · an archived company can be found (Archived filter) and restored.
 *   R47 · the AI Account Brief is on the profile.
 *
 * Procedures run against the SQL-evaluating fake; the profile is rendered with
 * its query results stubbed, and the rows it is given are the real
 * getCompanyContacts output.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Router } from "wouter";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => {
  if (!process.env.ENCRYPTION_KEY && !process.env.JWT_SECRET) process.env.ENCRYPTION_KEY = "b".repeat(64);
  return {
    db: null as any,
    data: {} as Record<string, unknown>,
    wsRole: "rep" as string | null,
    platformRole: "user" as string,
    addTo: [] as any[],
    roles: {} as Record<number, string>,
  };
});

vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));
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
vi.mock("@/contexts/WorkspaceContext", () => ({ useWorkspace: () => ({ current: h.wsRole ? { id: 2, role: h.wsRole } : null, workspaces: [] }) }));
vi.mock("@/_core/hooks/useAuth", () => ({ useAuth: () => ({ user: { id: 1, role: h.platformRole } }) }));
vi.mock("@/components/usip/Shell", () => ({ Shell: ({ children }: any) => children, useAccentColor: () => "#123456" }));
vi.mock("@/components/usip/AddToMenu", () => ({
  AddToMenu: (props: any) => { h.addTo.push(props); return createElement("span", { "data-addto": props.label }); },
}));
vi.mock("@/components/usip/CustomFieldsPanel", () => ({ CustomFieldsPanel: () => null }));
vi.mock("@/components/usip/EntityDetail", () => ({ EntityDetailTabs: () => null }));
vi.mock("@/pages/usip/Tasks", () => ({ RelatedTasks: () => null }));
vi.mock("@/components/usip/company/CompanyAvatar", () => ({ CompanyAvatar: () => null }));
vi.mock("@/components/usip/company/CompanyResearchCard", () => ({ CompanyResearchCard: () => null }));
vi.mock("@/components/usip/company/AccountBriefPanel", () => ({ AccountBriefPanel: (p: any) => createElement("div", { "data-brief": p.accountId }) }));
vi.mock("@/components/usip/Common", () => ({ confirmAction: () => {} }));

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { appRouter } from "./routers";
import { getCompanyContacts } from "./services/company/profileService";
import { companyOutreachTargets } from "../client/src/lib/companyPeople";
import CompanyProfile from "../client/src/pages/usip/CompanyProfile";
import { ProspectScoringPanel } from "../client/src/components/usip/scoring/ProspectScoringPanel";

const WS = 2, OTHER = 9, ACCT = 7;
const root = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8").replace(/\r\n/g, "\n");
const rows = (t: string) => h.db.rowsOf(t) as any[];

function caller(role = "admin") {
  h.roles[WS] = role;
  return appRouter.createCaller({
    user: { id: 1, openId: "u", email: "o@example.com", name: "O", loginMethod: "password", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
    req: { protocol: "https", headers: { "x-workspace-id": String(WS) } },
    res: { clearCookie: () => {} },
  } as unknown as TrpcContext);
}
async function refusal(p: Promise<unknown>) {
  try { await p; } catch (e: any) { return e; }
  throw new Error("expected a refusal");
}

const link = (personType: "prospect" | "contact", personId: number, accountId = ACCT, workspaceId = WS) => ({
  workspaceId, personType, personId, accountId, relationshipType: "employee", isCurrent: true, sourceType: "manual",
});
const person = (id: number, o: Record<string, unknown> = {}) => ({ id, workspaceId: WS, firstName: `P${id}`, lastName: "Person", email: `p${id}@acme.example`, emailStatus: "valid", linkedContactId: null, ...o });
const contact = (id: number, o: Record<string, unknown> = {}) => ({ id, workspaceId: WS, firstName: `C${id}`, lastName: "Contact", email: `c${id}@acme.example`, emailVerificationStatus: null, ...o });

/**
 * The shape that broke: People rows 5 and 6, CRM contacts 5 and 30 (contact 5
 * is NOT People row 5 — the ids collide), and contact 31, which IS People row
 * 6's own linked contact.
 */
function seedCompany() {
  rows("accounts").push({ id: ACCT, workspaceId: WS, name: "Acme", domain: "acme.example", normalizedDomain: "acme.example", normalizedName: "acme", archivedAt: null, createdAt: new Date(), updatedAt: new Date() });
  rows("prospects").push(person(5), person(6, { linkedContactId: 31 }));
  rows("contacts").push(contact(5, { email: "someone.else@other.example" }), contact(30), contact(31, { email: "p6@acme.example" }));
  rows("contact_account_links").push(link("prospect", 5), link("prospect", 6), link("contact", 5), link("contact", 30), link("contact", 31));
}

const profile = () => renderToStaticMarkup(createElement(Router, { ssrPath: `/v2/companies/${ACCT}` }, createElement(CompanyProfile)));

beforeEach(() => {
  h.roles = { [WS]: "admin" };
  h.db = makeSqlFakeDb({ roles: h.roles, wsId: () => WS });
  h.data = {};
  h.addTo = [];
  h.wsRole = "rep";
  h.platformRole = "user";
});

describe("R3 · the profile enrols the people it lists, as the kind they are", () => {
  it("splits by kind, sends each id once, and drops a People row's own contact", () => {
    const t = companyOutreachTargets([
      { kind: "prospect", id: 5 }, { kind: "prospect", id: 6, linkedContactId: 31 }, { kind: "prospect", id: 5 },
      { kind: "contact", id: 5 }, { kind: "contact", id: 30 }, { kind: "contact", id: 31 }, { kind: "contact", id: 30 },
    ]);
    expect(t).toEqual({ prospectIds: [5, 6], contactIds: [5, 30], count: 4 });
  });

  it("the page hands AddToMenu prospect ids and contact ids from the real People section rows", async () => {
    seedCompany();
    const listed = await getCompanyContacts(WS, ACCT);
    expect(listed.map((r: any) => `${r.kind}:${r.id}`).sort()).toEqual(["contact:30", "contact:31", "contact:5", "prospect:5", "prospect:6"]);
    h.data["companies.get"] = { id: ACCT, name: "Acme", contactCount: 5, score: null };
    h.data["companies.contacts"] = listed;
    const html = profile();
    expect(h.addTo).toHaveLength(1);
    const props = h.addTo[0];
    expect(props.prospectIds).toEqual([5, 6]);
    expect([...props.contactIds].sort((a: number, b: number) => a - b)).toEqual([5, 30]);
    expect(props.leadIds ?? []).toEqual([]);
    expect(html).toContain("Add 4 people to…");
  });

  it("what the page sends enrols People row 5 by its prospect id, never CRM contact 5", async () => {
    seedCompany();
    rows("sequences").push({ id: 1, workspaceId: WS, name: "Seq", status: "active", steps: [], isTemplate: false, ownerUserId: 1 });
    h.data["companies.get"] = { id: ACCT, name: "Acme", contactCount: 5, score: null };
    h.data["companies.contacts"] = await getCompanyContacts(WS, ACCT);
    profile();
    const { prospectIds, contactIds } = h.addTo[0];
    const r = await caller("rep").sequences.bulkEnroll({ sequenceId: 1, prospectIds, contactIds });
    expect(r.enrolled).toBe(4);
    const enrolled = rows("enrollments").map((e) => (e.prospectId != null ? `prospect:${e.prospectId}` : `contact:${e.contactId}`)).sort();
    expect(enrolled).toEqual(["contact:30", "contact:5", "prospect:5", "prospect:6"]);
    // People row 6 and its own contact 31 are one person: enrolled once.
    expect(enrolled).not.toContain("contact:31");
  });

  it("a company with only one person says so", async () => {
    rows("prospects").push(person(5));
    rows("contact_account_links").push(link("prospect", 5));
    h.data["companies.get"] = { id: ACCT, name: "Acme", contactCount: 1, score: null };
    h.data["companies.contacts"] = await getCompanyContacts(WS, ACCT);
    expect(profile()).toContain("Add 1 person to…");
    expect(h.addTo[0].prospectIds).toEqual([5]);
    expect(h.addTo[0].contactIds).toEqual([]);
  });
});

describe("R10 · controls follow the workspace role", () => {
  // The button, not the word: "Enrichment history" is on every profile.
  const ENRICH_BUTTON = /<\/svg> Enrich<\/button>/;
  const page = () => {
    h.data["companies.get"] = { id: ACCT, name: "Acme", contactCount: 0, score: null, archivedAt: null };
    h.data["companies.contacts"] = [];
    return profile();
  };

  it("a workspace manager whose platform role is user sees Enrich, not Archive", () => {
    h.wsRole = "manager"; h.platformRole = "user";
    const html = page();
    expect(html).toMatch(ENRICH_BUTTON);
    expect(html).not.toContain('aria-label="Archive company"');
  });

  it("a workspace admin whose platform role is user sees Enrich and Archive", () => {
    h.wsRole = "admin"; h.platformRole = "user";
    const html = page();
    expect(html).toMatch(ENRICH_BUTTON);
    expect(html).toContain('aria-label="Archive company"');
  });

  it("a platform admin who is a rep in this workspace sees neither: the server would refuse", () => {
    h.wsRole = "rep"; h.platformRole = "admin";
    const html = page();
    expect(html).not.toMatch(ENRICH_BUTTON);
    expect(html).not.toContain('aria-label="Archive company"');
  });

  it("the scoring panel's Recalculate follows the workspace role too", () => {
    const panel = () => renderToStaticMarkup(createElement(ProspectScoringPanel, { objectType: "person", objectId: 1 }));
    h.wsRole = "manager"; h.platformRole = "user";
    expect(panel()).toContain("Recalculate");
    h.wsRole = "rep"; h.platformRole = "admin";
    expect(panel()).not.toContain("Recalculate");
  });

  it("Mailbox and Calendar show the rep switcher to workspace managers", () => {
    for (const f of ["client/src/pages/usip/Mailbox.tsx", "client/src/pages/usip/Calendar.tsx"]) {
      const src = read(f);
      expect(src, f).toContain("const isManager = useWorkspaceRole().isManager;");
    }
  });

  it("no client screen ranks the platform role", () => {
    // users.role is "user" | "admin"; ranking it against the workspace
    // hierarchy is the X1.3 bug. PageHeader and the platform spend report
    // compare it to "admin" on purpose, and are not this.
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) { walk(p); continue; }
        if (!/\.tsx?$/.test(name)) continue;
        const src = readFileSync(p, "utf8");
        if (/(rankOf|isAdminRole|roleRank)\(\s*\(?\s*(auth\.)?user\b/.test(src)) hits.push(p.slice(root.length + 1));
      }
    };
    walk(join(root, "client", "src"));
    expect(hits).toEqual([]);
  });
});

describe("R65 · one people count for a company", () => {
  it("header, list, People section and merge dialog agree", async () => {
    seedCompany();
    // A second link to the same person, a link to a deleted contact, and
    // another workspace's link: none of them is one more person.
    rows("contact_account_links").push(link("prospect", 5), link("contact", 99), link("contact", 30, ACCT, OTHER));
    // A same-domain twin, so the merge dialog lists this company.
    rows("accounts").push({ id: 8, workspaceId: WS, name: "Acme Inc", domain: "acme.example", normalizedDomain: "acme.example", normalizedName: "acme inc", archivedAt: null, createdAt: new Date(), updatedAt: new Date() });

    const c = caller("admin");
    const header = (await c.companies.get({ accountId: ACCT })).contactCount;
    const section = (await c.companies.contacts({ accountId: ACCT })).length;
    const list = (await c.companies.search({ filters: {}, sort: { field: "name", direction: "asc" }, page: 1, perPage: 50 })).data.find((a) => a.id === ACCT)!.contactCount;
    const merge = (await c.companies.duplicates()).flatMap((g) => g.accounts).find((a) => a.id === ACCT)!.contactCount;
    expect({ header, section, list, merge }).toEqual({ header: 5, section: 5, list: 5, merge: 5 });
  });

  it("the Most contacts sort counts the same people", async () => {
    const { searchOrder } = await import("./services/company/searchService");
    const { MySqlDialect } = await import("drizzle-orm/mysql-core");
    const q = new MySqlDialect().sqlToQuery(searchOrder(WS, { field: "contactCount", direction: "desc" })[0] as any);
    const sql = q.sql.replace(/\s+/g, " ");
    expect(sql).toContain("COUNT(DISTINCT cal.`person_type`, cal.`person_id`)");
    expect(sql).toContain("EXISTS (SELECT 1 FROM `prospects` p WHERE p.`id` = cal.`person_id` AND p.`workspaceId` = ?)");
    expect(sql).toContain("EXISTS (SELECT 1 FROM `contacts` c WHERE c.`id` = cal.`person_id` AND c.`workspaceId` = ?)");
    expect(q.params).toEqual([WS, WS, WS]);
  });
});

describe("R64 · an archived company can be found and restored", () => {
  beforeEach(() => {
    rows("accounts").push(
      { id: ACCT, workspaceId: WS, name: "Acme", domain: null, archivedAt: new Date("2026-10-01T00:00:00Z"), createdAt: new Date(), updatedAt: new Date() },
      { id: 8, workspaceId: WS, name: "Live", domain: null, archivedAt: null, createdAt: new Date(), updatedAt: new Date() },
      { id: 9, workspaceId: OTHER, name: "Theirs", domain: null, archivedAt: new Date(), createdAt: new Date(), updatedAt: new Date() },
    );
  });

  it("the Archived filter lists only this workspace's archived companies", async () => {
    const r = await caller("admin").companies.search({ filters: { archivedOnly: true }, sort: { field: "name", direction: "asc" }, page: 1, perPage: 50 });
    expect(r.data.map((a) => a.id)).toEqual([ACCT]);
    const active = await caller("admin").companies.search({ filters: {}, sort: { field: "name", direction: "asc" }, page: 1, perPage: 50 });
    expect(active.data.map((a) => a.id)).toEqual([8]);
  });

  it("an admin restores it; a manager cannot; another workspace's is not found", async () => {
    expect((await refusal(caller("manager").companies.restore({ accountId: ACCT }))).code).toBe("FORBIDDEN");
    expect(rows("accounts").find((a) => a.id === ACCT).archivedAt).not.toBeNull();
    expect((await refusal(caller("admin").companies.restore({ accountId: 9 }))).code).toBe("NOT_FOUND");
    await caller("admin").companies.restore({ accountId: ACCT });
    expect(rows("accounts").find((a) => a.id === ACCT).archivedAt).toBeNull();
    expect(rows("audit_log").some((a) => a.entityType === "company_archive" && a.entityId === ACCT)).toBe(true);
  });

  it("the profile of an archived company offers Restore to an admin, and says it is archived", () => {
    h.wsRole = "admin";
    h.data["companies.get"] = { id: ACCT, name: "Acme", contactCount: 0, score: null, archivedAt: new Date() };
    h.data["companies.contacts"] = [];
    const html = profile();
    expect(html).toContain("Restore");
    expect(html).toContain(">Archived<");
    expect(html).not.toContain('aria-label="Archive company"');
  });

  it("the archive confirm points at the restore that now exists", () => {
    expect(read("client/src/pages/usip/CompanyProfile.tsx")).toContain("You can restore it from Companies → Archived.");
  });
});

describe("R47 · the AI Account Brief is on the company profile", () => {
  it("renders for the company", () => {
    h.data["companies.get"] = { id: ACCT, name: "Acme", contactCount: 0, score: null };
    h.data["companies.contacts"] = [];
    expect(profile()).toContain(`data-brief="${ACCT}"`);
  });
});
