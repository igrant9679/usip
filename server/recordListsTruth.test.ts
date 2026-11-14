/**
 * Lists count and show what they hold, and their buttons do what they say
 * (audit 2026-10-20, batch Pa).
 *
 *   the index counts the members a list's page shows, not every row (P46) ·
 *   "Add all N to a campaign" goes in batches instead of failing over 100
 *   (P48) · an archived company is neither shown nor offered (P50) · Import
 *   says where records go, and the controls that did nothing are gone (P55) ·
 *   the row menu shows on keyboard focus (P58) · adding says how many (P134) ·
 *   Enter twice makes one list (P135) · Remove can be undone, and "Go find
 *   some" doesn't reload the app (P139).
 *
 * Procedures run against the SQL-evaluating fake; screens are rendered with
 * their queries stubbed and their buttons' handlers captured.
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
    queries: {} as Record<string, unknown>,
    mutations: {} as Record<string, any[]>,
    calls: [] as Array<{ path: string; vars: any }>,
    invalidated: [] as string[],
    toasts: [] as Array<{ kind: string; msg: string; opts?: any }>,
    buttons: [] as any[],
    params: {} as Record<string, string>,
    nav: [] as string[],
    confirms: [] as Array<{ opts: any; accept: () => void }>,
  };
});

vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));
vi.mock("@/lib/trpc", () => {
  const proc = (path: string) => ({
    useQuery: () => h.queries[path] ?? { data: undefined, isLoading: false, error: null },
    useMutation: (opts: any) => {
      (h.mutations[path] ??= []).push(opts);
      return { mutate: (vars: any) => { h.calls.push({ path, vars }); }, isPending: false };
    },
  });
  // 2026-11-08 (audit X1.7): writers refresh through lib/entityCache's family
  // helpers, which invalidate whole routers (`utils.recordLists.invalidate()`,
  // recorded as "recordLists.*") and some reads three deep.
  const leaf = (path: string): any => new Proxy({ invalidate: () => { h.invalidated.push(path); } }, { get: (t: any, k: string) => (k in t ? t[k] : leaf(`${path}.${k}`)) });
  const utils = new Proxy({}, { get: (_t, r: string) => new Proxy({ invalidate: () => { h.invalidated.push(`${r}.*`); } } as any, { get: (u: any, p: string) => (p in u ? u[p] : leaf(`${r}.${p}`)) }) });
  return {
    trpc: new Proxy({ useUtils: () => utils } as Record<string, unknown>, {
      get: (t, r: string) => (r in t ? t[r] : new Proxy({}, { get: (_u, p: string) => proc(`${r}.${p}`) })),
    }),
  };
});
vi.mock("@/components/usip/Shell", async () => {
  const { createElement: el } = await import("react");
  return {
    Shell: ({ children }: any) => el("main", null, children),
    QueryError: ({ what }: any) => el("div", null, `Couldn't load ${what}`),
    EmptyState: ({ title, description, action }: any) => el("div", null, title, " ", description, action),
    useAccentColor: () => "#123456",
  };
});
vi.mock("@/components/usip/AddToMenu", () => ({ AddToMenu: () => null }));
vi.mock("@/components/usip/people/LinkedInEnrichment", () => ({ LinkedInUpdateIndicator: () => null, useEnrichJob: () => ({ enrichList: () => {}, running: false }) }));
vi.mock("@/components/usip/people/ResearchAiMenu", () => ({ ResearchAiMenu: () => null }));
// A confirm is recorded, not accepted: a test accepts it by calling `accept`.
vi.mock("@/components/usip/Common", () => ({ confirmAction: (opts: any, accept: () => void) => { h.confirms.push({ opts, accept }); } }));
// Open or not, a dialog's body renders inline (a portal renders nothing on the server).
vi.mock("@/components/ui/dialog", async (a) => {
  const { createElement: el } = await import("react");
  const pass = ({ children }: any) => el("div", null, children);
  return { ...(await a<typeof import("../client/src/components/ui/dialog")>()), Dialog: pass, DialogContent: pass, DialogHeader: pass, DialogTitle: pass, DialogFooter: pass };
});
vi.mock("@/components/ui/button", async () => {
  const { createElement: el } = await import("react");
  return {
    Button: (props: any) => {
      h.buttons.push(props);
      return props.asChild ? props.children : el("button", { "aria-label": props["aria-label"], title: props.title, className: props.className }, props.children);
    },
  };
});
vi.mock("sonner", () => {
  const rec = (kind: string) => (msg: string, opts?: unknown) => { h.toasts.push({ kind, msg, opts }); };
  return { toast: Object.assign(rec("default"), { success: rec("success"), error: rec("error"), info: rec("info") }) };
});
vi.mock("wouter", async () => {
  const { createElement: el } = await import("react");
  return {
    useParams: () => h.params,
    useLocation: () => ["/", (to: string) => { h.nav.push(to); }],
    useSearch: () => "",
    Link: ({ href, children }: any) => el("a", { href }, children),
  };
});

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { appRouter } from "./routers";
import { listMemberPage } from "./services/listMembers";
import { pushChunks } from "../client/src/lib/pushChunks";
import { createSingleFlight } from "../client/src/lib/singleFlight";
import ListDetail, { AddRecordsDialog } from "../client/src/pages/usip/ListDetail";
import Lists, { SelectionBar, confirmDeleteLists } from "../client/src/pages/usip/Lists";

const WS = 2, OTHER = 9;
const rows = (t: string) => h.db.rowsOf(t) as any[];
const read = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8").replace(/\r\n/g, "\n");
const html = (el: any) => renderToStaticMarkup(el).replace(/<!-- -->/g, "");
const textOf = (b: any) => html(createElement("span", null, b.children));

function caller() {
  return appRouter.createCaller({
    user: { id: 1, openId: "u", email: "o@example.com", name: "O", loginMethod: "password", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
    req: { protocol: "https", headers: { "x-workspace-id": String(WS) } },
    res: { clearCookie: () => {} },
  } as unknown as TrpcContext);
}
async function refusal(p: Promise<unknown>): Promise<{ code: string; message: string }> {
  try { await p; } catch (e: any) { return { code: e.code, message: e.message }; }
  throw new Error("expected a refusal, but it resolved");
}

const person = (id: number, ws = WS) => ({ id, workspaceId: ws, firstName: `P${id}`, lastName: "Z", title: "CTO", company: "Acme", email: `p${id}@x.example`, emailStatus: null, linkedinUrl: null, city: null, state: null, country: null });
const company = (id: number, o: Record<string, unknown> = {}) => ({ id, workspaceId: WS, name: `Co ${id}`, domain: `co${id}.example`, industry: null, region: null, arr: null, archivedAt: null, ...o });
let mid = 0;
const member = (listId: number, recordType: string, recordId: number, ws = WS) => ({ id: ++mid, workspaceId: ws, listId, recordType, recordId, addedAt: new Date(Date.UTC(2026, 9, 1, 0, mid)) });

beforeEach(() => {
  h.db = makeSqlFakeDb({ roles: { [WS]: "rep" }, wsId: () => WS });
  h.queries = {}; h.mutations = {}; h.calls = []; h.invalidated = []; h.toasts = []; h.buttons = []; h.params = {}; h.nav = []; h.confirms = [];
  mid = 0;
  rows("record_lists").push(
    { id: 7, workspaceId: WS, name: "Buyers", entityType: "people", updatedAt: new Date() },
    { id: 8, workspaceId: WS, name: "Targets", entityType: "companies", updatedAt: new Date() },
    { id: 9, workspaceId: OTHER, name: "Theirs", entityType: "people", updatedAt: new Date() },
  );
  rows("prospects").push(person(1), person(2), person(3), person(40, OTHER), person(41, OTHER));
  rows("accounts").push(company(50), company(51, { archivedAt: new Date("2026-10-01T00:00:00Z") }), company(52), company(53, { archivedAt: new Date("2026-10-01T00:00:00Z") }));
});

/* ── P46, P50: counts and what a list holds ──────────────────────────────── */

describe("the Lists index counts what each list's page shows (P46, P50)", () => {
  beforeEach(() => {
    rows("record_list_members").push(
      member(7, "prospect", 1), member(7, "prospect", 2),
      member(7, "prospect", 99),          // a deleted person
      member(7, "prospect", 40),          // another workspace's person
      member(7, "contact", 3),            // the wrong kind, from an old client
      member(7, "prospect", 3, OTHER),    // a membership row filed under another workspace
      member(8, "account", 50), member(8, "account", 51),   // 51 is archived
      member(8, "prospect", 1),           // a person on a Companies list
    );
  });

  it("each list's count is its page's total", async () => {
    const lists = await caller().recordLists.list();
    const count = (id: number) => lists.find((l) => l.id === id)!.memberCount;
    expect(count(7)).toBe(2);
    expect(count(8)).toBe(1);
    expect((await listMemberPage(WS, { id: 7 })).total).toBe(2);
    expect((await listMemberPage(WS, { id: 8 })).total).toBe(1);
  });

  it("an archived company isn't on its list's page (P50)", async () => {
    const page = await listMemberPage(WS, { id: 8 });
    expect(page.rows.map((r) => r.recordId)).toEqual([50]);
  });

  it("adding takes only what the list can show, and says what it left out", async () => {
    // 1 is on the list already; 41 is another workspace's person and 98 is no one, so neither goes on.
    expect(await caller().recordLists.addMembers({ listId: 7, recordType: "prospect", recordIds: [1, 3, 41, 98, 3] })).toEqual({ added: 1, alreadyOn: 1, skipped: 2 });
    expect(rows("record_list_members").filter((m) => m.listId === 7 && m.recordType === "prospect" && m.workspaceId === WS).map((m) => m.recordId).sort()).toEqual([1, 2, 3, 40, 99]);
    // An archived company is not offered by the picker and not taken here (P50).
    expect(await caller().recordLists.addMembers({ listId: 8, recordType: "account", recordIds: [53, 52] })).toEqual({ added: 1, alreadyOn: 0, skipped: 1 });
    expect(rows("record_list_members").filter((m) => m.listId === 8).map((m) => m.recordId).sort()).toEqual([1, 50, 51, 52]);
    // The wrong kind, and another workspace's list.
    expect((await refusal(caller().recordLists.addMembers({ listId: 7, recordType: "contact", recordIds: [3] }))).code).toBe("BAD_REQUEST");
    expect((await refusal(caller().recordLists.addMembers({ listId: 8, recordType: "prospect", recordIds: [1] }))).code).toBe("BAD_REQUEST");
    expect((await refusal(caller().recordLists.addMembers({ listId: 9, recordType: "prospect", recordIds: [1] }))).code).toBe("NOT_FOUND");
  });

  it("a deleted person's membership stays, unseen and uncounted, so a restore brings them back", async () => {
    // Deleting a person is audited and restorable (PR #19); the membership waits for them.
    expect((await listMemberPage(WS, { id: 7 })).total).toBe(2);
    rows("prospects").push(person(99));
    expect((await listMemberPage(WS, { id: 7 })).total).toBe(3);
    expect((await caller().recordLists.list()).find((l) => l.id === 7)!.memberCount).toBe(3);
  });

  it("the Companies picker leaves archived companies out", () => {
    h.queries["accounts.list"] = { data: rows("accounts"), isLoading: false };
    const page = html(createElement(AddRecordsDialog, { open: true, onClose: () => {}, isCompanies: true, accent: "#123456", picked: new Set<number>(), setPicked: () => {}, adding: false, onAdd: () => {} }));
    expect(page).toContain("Co 50");
    expect(page).toContain("Co 52");
    expect(page).not.toContain("Co 51");
  });
});

/* ── P48: Add all N to a campaign ────────────────────────────────────────── */

describe("Add all N to a campaign goes in batches (P48)", () => {
  it("splits any mix into batches of at most 100, keeping every id once", () => {
    const ids = { prospectIds: Array.from({ length: 230 }, (_, i) => i + 1), contactIds: [9001, 9002], leadIds: [7001] };
    const batches = pushChunks(ids);
    expect(batches.map((b) => b.prospectIds.length + b.contactIds.length + b.leadIds.length)).toEqual([100, 100, 33]);
    expect(batches.flatMap((b) => [...b.prospectIds, ...b.contactIds, ...b.leadIds]).sort((a, b) => a - b))
      .toEqual([...ids.prospectIds, ...ids.leadIds, ...ids.contactIds].sort((a, b) => a - b));
    expect(batches[2]).toEqual({ prospectIds: Array.from({ length: 30 }, (_, i) => 201 + i), contactIds: [9001, 9002], leadIds: [7001] });
    expect(pushChunks({ prospectIds: [1], contactIds: [], leadIds: [] })).toEqual([{ prospectIds: [1], contactIds: [], leadIds: [] }]);
  });

  it("each batch fits the procedure's own limit", async () => {
    const src = read("server/routers/are/prospects.ts");
    const fn = src.slice(src.indexOf("pushExisting: workspaceProcedure"), src.indexOf("pushExistingPreview: workspaceProcedure"));
    expect(fn).toContain("prospectIds: z.array(z.number().int().positive()).max(100).default([])");
    const { PUSH_BATCH } = await import("../client/src/lib/pushChunks");
    expect(PUSH_BATCH).toBe(100);
  });

  it("the menu's Confirm pushes batch by batch and reports once, the review says so; best-fit isn't split", () => {
    const menu = read("client/src/components/usip/AddToMenu.tsx");
    // 2026-11-07 (CRMP, F36): the batches run over the ids the review kept,
    // which are every id given unless people at a do-not-contact company were
    // left out; the default is still the whole selection.
    expect(menu).toContain("ids: { prospectIds: number[]; contactIds: number[]; leadIds: number[] } = { prospectIds, contactIds, leadIds },");
    expect(menu).toContain("for (const batch of pushChunks(ids)) {");
    expect(menu).toContain("await pushExisting.mutateAsync({ campaignId: campaign.id, ...batch });");
    // The pick is a review (R48); Confirm runs the batches.
    expect(menu).toContain('if (picked.kind === "campaign") void pushToCampaign(picked, ids);');
    expect(menu).not.toContain("pushExisting.mutate({ campaignId: picked.id, prospectIds, contactIds, leadIds })");
    expect(menu).toContain('{picked.kind === "campaign" && n > PUSH_BATCH ? <span className="block text-[11.5px] text-muted-foreground mt-0.5">They go in {PUSH_BATCH} at a time.</span> : null}');
    expect(menu).toContain("disabled={bestFitTooMany}");
  });
});

/* ── The list's page ─────────────────────────────────────────────────────── */

describe("a list's page", () => {
  const renderList = (opts: { companies?: boolean; total?: number } = {}) => {
    h.params = { id: opts.companies ? "8" : "7" };
    h.queries["recordLists.get"] = { data: rows("record_lists").find((l) => l.id === (opts.companies ? 8 : 7)), isFetched: true, error: null };
    h.queries["recordLists.members"] = { data: { rows: [], total: opts.total ?? 0, page: 1, perPage: 100, prospectIds: [] }, isLoading: false };
    h.buttons = [];
    return html(createElement(ListDetail));
  };
  const mutation = (path: string, nth = 0) => h.mutations[path][nth];

  it("Import says its records go elsewhere, and Create workflow and Create person are gone (P55)", () => {
    for (const companies of [false, true]) {
      const page = renderList({ companies });
      expect(page).toContain("Import a CSV");
      expect(page).toContain(`Imported records go to ${companies ? "Companies" : "People"}, not to this list.`);
      expect(page).not.toContain("Import by CSV");
      expect(page).not.toContain("Import records into this list");
      expect(page).not.toContain("Create workflow");
      expect(page).not.toContain("Automatically add");
      expect(page).not.toContain("Create person");
      expect(page).not.toContain("Create company");
      // The add button opens the picker; no menu, no chevron.
      const add = h.buttons.find((b) => textOf(b).includes(companies ? "Add companies to list" : "Add people to list"));
      expect(add.onClick).toBeTypeOf("function");
    }
  });

  it("adding says how many went on and how many were already there (P134)", () => {
    renderList();
    const add = mutation("recordLists.addMembers", 1);
    add.onSuccess({ added: 3, alreadyOn: 1, skipped: 0 });
    expect(h.toasts.map((t) => t.msg)).toEqual(["Added 3 to the list · 1 was already on it"]);
    add.onSuccess({ added: 0, alreadyOn: 0, skipped: 2 });
    expect(h.toasts[1].msg).toBe("Added 0 to the list · 2 could not be added (deleted, archived or not this list's kind)");
    // The list family's helper refreshes every list read, members included.
    expect(h.invalidated).toContain("recordLists.*");
  });

  it("Remove says so and can be undone (P139)", async () => {
    rows("record_list_members").push(member(7, "prospect", 2));
    const res = await caller().recordLists.removeMember({ memberId: 1 });
    expect(res).toEqual({ ok: true, removed: { listId: 7, recordType: "prospect", recordId: 2 } });
    expect(rows("record_list_members")).toEqual([]);
    renderList();
    mutation("recordLists.removeMember").onSuccess(res);
    expect(h.toasts[0].msg).toBe("Removed from the list");
    expect(h.toasts[0].opts.action.label).toBe("Undo");
    h.toasts[0].opts.action.onClick();
    expect(h.calls).toEqual([{ path: "recordLists.addMembers", vars: { listId: 7, recordType: "prospect", recordIds: [2] } }]);
    // That call puts them back.
    await caller().recordLists.addMembers(h.calls[0].vars);
    expect(rows("record_list_members").map((m) => m.recordId)).toEqual([2]);
  });

  it("the list's page has Delete list: it asks first, then deletes and goes back to Lists (owner ask 2026-11-13)", () => {
    const page = renderList();
    expect(page).toContain("Delete list");
    h.buttons.find((b) => textOf(b).includes("Delete list")).onClick();
    expect(h.confirms).toHaveLength(1);
    const { opts, accept } = h.confirms[0];
    expect(opts.title).toBe('Delete list "Buyers"?');
    expect(opts.description).toBe("Only the list goes: the people and companies on it stay in your workspace.");
    expect(opts.consequence).toEqual({ kind: "permanent" });
    expect(h.calls).toEqual([]);
    accept();
    expect(h.calls).toEqual([{ path: "recordLists.delete", vars: { id: 7 } }]);
    mutation("recordLists.delete").onSuccess({ ok: true });
    expect(h.toasts.at(-1)).toMatchObject({ kind: "success", msg: "List deleted" });
    expect(h.invalidated).toContain("recordLists.*");
    expect(h.nav).toEqual(["/v2/lists"]);
  });

  it("Go find some navigates inside the app instead of reloading it (P139)", () => {
    for (const isCompanies of [false, true]) {
      h.buttons = []; h.nav = [];
      h.queries[isCompanies ? "accounts.list" : "prospects.list"] = { data: isCompanies ? [] : { data: [], total: 0 }, isLoading: false };
      html(createElement(AddRecordsDialog, { open: true, onClose: () => {}, isCompanies, accent: "#123456", picked: new Set<number>(), setPicked: () => {}, adding: false, onAdd: () => {} }));
      h.buttons.find((b) => textOf(b).includes("Go find some")).onClick();
      expect(h.nav).toEqual([isCompanies ? "/v2/companies" : "/v2/people"]);
    }
    expect(read("client/src/pages/usip/ListDetail.tsx")).not.toContain("window.location.href");
  });
});

/* ── The Lists index ─────────────────────────────────────────────────────── */

describe("the Lists index", () => {
  // 2026-11-13 (owner ask, "i need to be able to delete lists"): P58 made the
  // button show on keyboard focus as well as hover; it is now always shown,
  // since hidden until hovered the way to delete a list could not be found.
  it("a row's actions button is always shown and names its list (P58)", async () => {
    h.queries["recordLists.list"] = { data: await caller().recordLists.list(), isLoading: false };
    html(createElement(Lists));
    const actions = h.buttons.find((b) => b["aria-label"] === "Actions for Buyers");
    expect(actions.className).not.toContain("opacity-0");
    expect(actions.title).toBe("Rename or delete");
  });

  it("Enter twice makes one list (P135)", () => {
    const once = createSingleFlight();
    const starts: Array<() => void> = [];
    expect(once((done) => starts.push(done))).toBe(true);
    expect(once((done) => starts.push(done))).toBe(false);
    expect(starts).toHaveLength(1);
    starts[0]();
    expect(once((done) => starts.push(done))).toBe(true);
    // Enter and the button both go through it, and it lets go when the call settles.
    const src = read("client/src/pages/usip/Lists.tsx");
    expect(src).toContain("const createOnce = useRef(createSingleFlight()).current;");
    expect(src).toContain("createOnce((done) => createMut.mutate(");
    expect(src).toContain("{ onSettled: done },");
    expect(src).toContain('onKeyDown={(e) => { if (e.key === "Enter") create(); }}');
    expect(src).toContain("<Button onClick={create} disabled={!newName.trim() || createMut.isPending}");
  });
});

/* ── Deleting lists (owner ask 2026-11-13) ───────────────────────────────── */

describe("deleting lists (owner ask 2026-11-13: \"i need to be able to delete lists\")", () => {
  beforeEach(() => {
    rows("record_list_members").push(member(7, "prospect", 1), member(7, "prospect", 2), member(8, "account", 50), member(9, "prospect", 40, OTHER));
  });

  it("delete takes the list and its memberships, never the people on it", async () => {
    expect(await caller().recordLists.delete({ id: 7 })).toEqual({ ok: true });
    expect(rows("record_lists").map((l) => l.id).sort()).toEqual([8, 9]);
    expect(rows("record_list_members").map((m) => m.listId).sort()).toEqual([8, 9]);
    expect(rows("prospects")).toHaveLength(5);
  });

  it("another workspace's list, or one already gone, is not found and nothing changes", async () => {
    expect(await refusal(caller().recordLists.delete({ id: 9 }))).toEqual({ code: "NOT_FOUND", message: "That list is not in this workspace." });
    expect((await refusal(caller().recordLists.delete({ id: 404 }))).code).toBe("NOT_FOUND");
    expect(rows("record_lists")).toHaveLength(3);
    expect(rows("record_list_members")).toHaveLength(4);
  });

  it("deleteMany deletes this workspace's lists among the ids, skips the rest, and says how many", async () => {
    expect(await caller().recordLists.deleteMany({ ids: [7, 8, 9, 404, 7] })).toEqual({ deleted: 2 });
    expect(rows("record_lists").map((l) => l.id)).toEqual([9]);
    expect(rows("record_list_members").map((m) => m.listId)).toEqual([9]);
    expect(rows("prospects")).toHaveLength(5);
    expect(rows("accounts")).toHaveLength(4);
    expect(await caller().recordLists.deleteMany({ ids: [404] })).toEqual({ deleted: 0 });
  });

  it("deleteMany takes 1 to 200 ids", async () => {
    expect((await refusal(caller().recordLists.deleteMany({ ids: [] }))).code).toBe("BAD_REQUEST");
    expect((await refusal(caller().recordLists.deleteMany({ ids: Array.from({ length: 201 }, (_, i) => i + 1) }))).code).toBe("BAD_REQUEST");
    expect(rows("record_lists")).toHaveLength(3);
  });

  it("every row on the index has a checkbox that names its list", async () => {
    h.queries["recordLists.list"] = { data: await caller().recordLists.list(), isLoading: false };
    const page = html(createElement(Lists));
    expect(page).toContain('aria-label="Select Buyers"');
    expect(page).toContain('aria-label="Select Targets"');
    expect(page).not.toContain("Theirs");
  });

  it("the selection bar shows only with a pick, counts it, and its buttons call through", () => {
    const calls: string[] = [];
    const bar = (selected: number, shown: number) => {
      h.buttons = [];
      return html(createElement(SelectionBar, { selected, shown, deleting: false, onSelectAll: () => calls.push("all"), onClear: () => calls.push("clear"), onDelete: () => calls.push("delete") }));
    };
    expect(bar(0, 2)).toBe("");
    const one = bar(1, 2);
    expect(one).toContain("1 selected");
    expect(one).toContain("Select all 2");
    expect(one).toContain("Delete 1 list");
    for (const label of ["Select all 2", "Clear", "Delete 1 list"]) h.buttons.find((b) => textOf(b).includes(label)).onClick();
    expect(calls).toEqual(["all", "clear", "delete"]);
    const all = bar(2, 2);
    expect(all).toContain("Delete 2 lists");
    expect(all).not.toContain("Select all");
  });

  it("deleting asks first, with the count for several and that it cannot be undone, then sends the ids", () => {
    const sent: number[][] = [];
    confirmDeleteLists([{ id: 7, name: "Buyers" }, { id: 8, name: "Targets" }], (ids) => sent.push(ids));
    confirmDeleteLists([{ id: 7, name: "Buyers" }], (ids) => sent.push(ids));
    confirmDeleteLists([], (ids) => sent.push(ids));
    expect(h.confirms).toHaveLength(2);
    const [many, one] = h.confirms;
    expect(many.opts).toMatchObject({ title: "Delete 2 lists?", count: { n: 2, one: "list" }, consequence: { kind: "permanent" }, confirmLabel: "Delete" });
    expect(many.opts.description).toBe("Only the lists go: the people and companies on them stay in your workspace.");
    expect(one.opts).toMatchObject({ title: 'Delete list "Buyers"?', consequence: { kind: "permanent" } });
    expect(one.opts.count).toBeUndefined();
    expect(sent).toEqual([]);
    many.accept(); one.accept();
    expect(sent).toEqual([[7, 8], [7]]);
  });

  it("the index's deletes refresh the lists and say what happened, and a failed one refreshes too", async () => {
    h.queries["recordLists.list"] = { data: await caller().recordLists.list(), isLoading: false };
    html(createElement(Lists));
    h.mutations["recordLists.deleteMany"][0].onSuccess({ deleted: 2 });
    expect(h.toasts.at(-1)).toMatchObject({ kind: "success", msg: "Deleted 2 lists" });
    h.mutations["recordLists.delete"][0].onSuccess({ ok: true });
    expect(h.toasts.at(-1)).toMatchObject({ kind: "success", msg: "List deleted" });
    h.invalidated = [];
    h.mutations["recordLists.delete"][0].onError({ message: "That list is not in this workspace." });
    expect(h.toasts.at(-1)).toMatchObject({ kind: "error", msg: "That list is not in this workspace." });
    expect(h.invalidated).toContain("recordLists.*");
  });
});
