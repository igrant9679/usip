/**
 * A landing-page submit must LEAVE SOMETHING BEHIND.
 *
 * 🔴 THE BUG. `landingPages.submit` created a lead, routed it, enrolled it and
 * incremented `submitCount` — and stored the submitted data nowhere. `forms`,
 * the same product idea written twice, had written `form_submissions` all
 * along. Three ordinary paths therefore lost a submission outright:
 *
 *   1. `autoCreateLead` switched off — a page used purely as a capture surface;
 *   2. a submission carrying neither an email nor a first name;
 *   3. the lead insert throwing, which the handler catches and continues past
 *      by design (a capture surface must not fail the visitor's submit).
 *
 * In all three the counter still ticked, so the page reported a submission
 * whose contents did not exist anywhere. That gap is what these tests hold
 * open: the interesting assertions are the ones where NO lead is created.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { landingPages, landingPageSubmissions, leads, enrollments } from "../drizzle/schema";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => ({
  db: null as any,
  notified: [] as Record<string, unknown>[],
  routeTo: null as number | null,
  pageOwner: undefined as number | null | undefined,
  leadInsertThrows: false,
}));

vi.mock("./db", async (importActual) => ({
  ...(await importActual<typeof import("./db")>()),
  getDb: async () => h.db,
}));

vi.mock("./services/policyNotify", async (importActual) => ({
  ...(await importActual<typeof import("./services/policyNotify")>()),
  notifyLeadRouted: async (n: Record<string, unknown>) => { h.notified.push(n); },
}));

vi.mock("./routers/leadScoring", async (importActual) => ({
  ...(await importActual<typeof import("./routers/leadScoring")>()),
  routeLeadOwner: async () => h.routeTo,
}));

/**
 * ⚠️ MOCKED DELIBERATELY, AFTER IT BIT. Left real, `activeOwnerOrNull` runs its
 * own membership select against the fake, exhausted the scripted queue, and the
 * handler's `catch` swallowed the resulting throw and carried on with a null
 * owner. Every test still passed — through an ERROR path, with `routedToUserId`
 * null for a reason that had nothing to do with what was being asserted. A
 * queue-exhaustion guard only helps if the code under test does not catch it.
 */
vi.mock("./_core/activeMembers", async (importActual) => ({
  ...(await importActual<typeof import("./_core/activeMembers")>()),
  /**
   * `undefined` means "not configured — behave like the author is active".
   * `null` means "the author has LEFT", which is a distinct, meaningful answer.
   * Written with `??` first, which collapsed the two and made the departed-author
   * test read the author back as present — the fake lying in exactly the way
   * these suites exist to prevent.
   */
  activeOwnerOrNull: async (_ws: number, userId: number | null | undefined) =>
    h.pageOwner === undefined ? (userId ?? null) : h.pageOwner,
}));

import { appRouter } from "./routers";

interface Recorded {
  inserts: { table: unknown; values: Record<string, unknown> }[];
  updates: { table: unknown; values: Record<string, unknown> }[];
}

function rec(): Recorded {
  return { inserts: [], updates: [] };
}

/**
 * Dispatches on the real drizzle table object, as the other suites do.
 *
 * ⚠️ The select queue THROWS when exhausted. `[]` is how "no such page" is
 * expressed, so a queue that quietly bottomed out would make the NOT_FOUND test
 * pass without the procedure ever having looked.
 */
/**
 * Which columns a drizzle WHERE actually compares.
 *
 * 📏 THIS EXISTS BECAUSE THE FAKE CANNOT READ WHERE CLAUSES. Dropping the
 * `workspaceId` predicate from `landingPages.submissions` — a cross-tenant read
 * of another workspace's captured leads — SURVIVED the first battery: the fake
 * returns its scripted rows whatever the filter says, and `tenantScope.test.ts`
 * covers destructive statements only, by design.
 *
 * So rather than grep the source (presence is not effect), this walks the query
 * object the code actually built. It stops at a column reference instead of
 * descending: a column's `.table` links back to every sibling, and a naive walk
 * reports the whole table as "compared" — which is a check that passes always.
 */
function comparedColumns(node: any, out: string[] = [], d = 0): string[] {
  if (!node || d > 10) return out;
  if (typeof node.name === "string" && node.table) { out.push(node.name); return out; }
  const chunks = node.queryChunks ?? (Array.isArray(node) ? node : null);
  if (chunks) for (const c of chunks) comparedColumns(c, out, d + 1);
  return out;
}

function makeDb(opts: { selects: unknown[][]; rec: Recorded; wheres?: string[][] }) {
  const queue = [...opts.selects];
  const builder = () => {
    const b: any = {
      from: () => b, innerJoin: () => b, leftJoin: () => b,
      where: (w: unknown) => { opts.wheres?.push([...new Set(comparedColumns(w))]); return b; },
      orderBy: () => b, limit: () => b,
      then: (res: (v: unknown) => void, rej: (e: unknown) => void) => {
        if (queue.length === 0) { rej(new Error("fake db: select queue exhausted")); return; }
        res(queue.shift());
      },
    };
    return b;
  };
  return {
    select: () => builder(),
    insert(table: unknown) {
      return {
        values(values: Record<string, unknown>) {
          if (table === leads && h.leadInsertThrows) {
            return Promise.reject(new Error("simulated lead insert failure"));
          }
          opts.rec.inserts.push({ table, values });
          return Promise.resolve([{ insertId: table === leads ? 555 : 1 }]);
        },
      };
    },
    update(table: unknown) {
      return {
        set(values: Record<string, unknown>) {
          opts.rec.updates.push({ table, values });
          return { where: () => Promise.resolve([]) };
        },
      };
    },
  };
}

function publicCtx(): TrpcContext {
  return { user: null, req: { protocol: "https", headers: {} }, res: {} } as unknown as TrpcContext;
}

function page(over: Record<string, unknown> = {}) {
  return {
    id: 7,
    workspaceId: 1,
    slug: "demo",
    status: "published",
    autoCreateLead: true,
    autoRoute: false,
    autoEnrollSequenceId: null,
    createdByUserId: 3,
    redirectUrl: null,
    submitCount: 4,
    ...over,
  };
}

const submit = (data: Record<string, unknown>, slug = "demo") =>
  appRouter.createCaller(publicCtx()).landingPages.submit({ slug, data });

const submissionOf = (r: Recorded) => r.inserts.find((i) => i.table === landingPageSubmissions);

beforeEach(() => {
  h.notified = [];
  h.routeTo = null;
  h.pageOwner = undefined;
  h.leadInsertThrows = false;
});

describe("landingPages.submit — the submission row", () => {
  it("records the submission alongside the lead it created", async () => {
    const r = rec();
    h.db = makeDb({ selects: [[page()]], rec: r });
    const out = await submit({ name: "Ada Lovelace", email: "ada@example.com", company: "Analytical" });

    expect(out.ok).toBe(true);
    const s = submissionOf(r);
    expect(s?.values).toMatchObject({
      workspaceId: 1,
      pageId: 7,
      name: "Ada Lovelace",
      email: "ada@example.com",
      company: "Analytical",
      leadId: 555,
    });
  });

  /**
   * 🔴 CASE 1 — the page captures but does not create leads. Before the row
   * existed this submit incremented a counter and stored nothing at all.
   */
  it("records a submission even when autoCreateLead is OFF", async () => {
    const r = rec();
    h.db = makeDb({ selects: [[page({ autoCreateLead: false })]], rec: r });
    await submit({ name: "Grace Hopper", email: "grace@example.com" });

    expect(r.inserts.some((i) => i.table === leads), "no lead should be created").toBe(false);
    const s = submissionOf(r);
    expect(s, "the submission must be stored anyway — this is the whole bug").toBeTruthy();
    expect(s?.values).toMatchObject({ email: "grace@example.com", leadId: null, routedToUserId: null });
  });

  /**
   * 🔴 CASE 2 — neither email nor first name, so the lead branch is skipped by
   * its own guard. A message-only enquiry is still a submission.
   */
  it("records a submission carrying neither email nor name", async () => {
    const r = rec();
    h.db = makeDb({ selects: [[page()]], rec: r });
    await submit({ message: "call me about pricing", company: "Acme" });

    expect(r.inserts.some((i) => i.table === leads)).toBe(false);
    const s = submissionOf(r);
    expect(s?.values).toMatchObject({ company: "Acme", leadId: null });
    // The raw payload survives even though no column exists for `message`.
    expect((s?.values.data as any)?.message).toBe("call me about pricing");
  });

  /**
   * 🔴 CASE 3 — the lead insert throws. The handler swallows it on purpose, so
   * without this row a database hiccup silently destroyed the capture.
   */
  it("records a submission when the lead insert FAILS", async () => {
    const r = rec();
    h.leadInsertThrows = true;
    h.db = makeDb({ selects: [[page()]], rec: r });
    await submit({ name: "Alan Turing", email: "alan@example.com" });

    const s = submissionOf(r);
    expect(s, "a failed lead insert must not take the submission with it").toBeTruthy();
    expect(s?.values.leadId, "no lead id, because there is no lead").toBeNull();
    expect(s?.values.email).toBe("alan@example.com");
  });

  it("keeps the full payload, including fields with no column of their own", async () => {
    const r = rec();
    h.db = makeDb({ selects: [[page()]], rec: r });
    await submit({ name: "Ada", email: "ada@example.com", phone: "+44 7700 900000", budget: "50k" });

    const data = submissionOf(r)?.values.data as any;
    expect(data.phone).toBe("+44 7700 900000");
    expect(data.budget, "an unmapped custom field must survive").toBe("50k");
  });

  it("records which rep the lead was routed to", async () => {
    const r = rec();
    h.pageOwner = 3;   // the page's author is still active…
    h.routeTo = 42;    // …but the routing rules pick someone else
    h.db = makeDb({ selects: [[page({ autoRoute: true })]], rec: r });
    await submit({ name: "Ada", email: "ada@example.com" });

    expect(submissionOf(r)?.values.routedToUserId, "the ROUTED rep wins over the author").toBe(42);
  });

  /**
   * With autoRoute off the page's author owns it — and the submission row must
   * say so, or "routed to nobody" and "routed to the author" look identical.
   */
  it("falls back to the page author when autoRoute is off", async () => {
    const r = rec();
    h.pageOwner = 3;
    h.db = makeDb({ selects: [[page({ autoRoute: false })]], rec: r });
    await submit({ name: "Ada", email: "ada@example.com" });

    expect(submissionOf(r)?.values.routedToUserId).toBe(3);
  });

  /**
   * A page outlives its author's employment. When the author has left,
   * `activeOwnerOrNull` returns null and the row records an unowned capture
   * rather than pointing at someone who cannot sign in.
   */
  it("records no owner when the page's author has left", async () => {
    const r = rec();
    h.pageOwner = null; // explicitly departed, NOT "unconfigured" — see the mock
    h.db = makeDb({ selects: [[page({ autoRoute: false })]], rec: r });
    await submit({ name: "Ada", email: "ada@example.com" });

    expect(submissionOf(r)?.values.routedToUserId).toBeNull();
  });

  it("still increments the counter, and the increment stays atomic", async () => {
    const r = rec();
    h.db = makeDb({ selects: [[page()]], rec: r });
    await submit({ name: "Ada", email: "ada@example.com" });

    const bump = r.updates.find((u) => u.table === landingPages);
    expect(bump).toBeTruthy();
    /**
     * A JS-computed `(page.submitCount ?? 0) + 1` would be a lost update — two
     * concurrent submitters both read N and both write N+1. It must stay an SQL
     * expression, never the number 5.
     */
    expect(typeof bump!.values.submitCount, "must be an SQL expression, not a JS number").not.toBe("number");
  });

  it("does not record anything for an unpublished page", async () => {
    const r = rec();
    h.db = makeDb({ selects: [[page({ status: "draft" })]], rec: r });
    await expect(submit({ email: "ada@example.com" })).rejects.toThrow();
    expect(r.inserts).toHaveLength(0);
    expect(r.updates).toHaveLength(0);
  });

  it("does not record anything for an unknown slug", async () => {
    const r = rec();
    h.db = makeDb({ selects: [[]], rec: r });
    await expect(submit({ email: "ada@example.com" }, "nope")).rejects.toThrow();
    expect(r.inserts).toHaveLength(0);
  });

  it("still enrols into the configured sequence — the row is additive, not a replacement", async () => {
    const r = rec();
    h.db = makeDb({
      selects: [
        [page({ autoEnrollSequenceId: 9 })],
        [], // enrollmentDedupe: no active enrollment for this email
      ],
      rec: r,
    });
    await submit({ name: "Ada", email: "ada@example.com" });

    expect(r.inserts.some((i) => i.table === enrollments), "enrolment must still happen").toBe(true);
    expect(submissionOf(r)).toBeTruthy();
  });

  it("still announces the routed lead", async () => {
    const r = rec();
    h.db = makeDb({ selects: [[page()]], rec: r });
    await submit({ name: "Ada", email: "ada@example.com" });
    expect(h.notified).toHaveLength(1);
    expect(h.notified[0]).toMatchObject({ source: "landing:demo" });
  });
});

describe("landingPages.submissions — reading them back", () => {
  const adminCtx = () => ({
    user: {
      id: 1, openId: "o1", email: "admin@acme.com", name: "Admin", loginMethod: "manus",
      role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date(),
    },
    req: { protocol: "https", headers: {} },
    res: { clearCookie: () => {} },
  } as unknown as TrpcContext);

  /** The workspace middleware resolves through an innerJoin; everything else is scripted. */
  function dbWithMember(rows: unknown[], wheres: string[][], froms: unknown[] = []) {
    const r = rec();
    const inner = makeDb({ selects: [rows], rec: r, wheres });
    return {
      ...inner,
      select: () => {
        const b: any = {
          _joined: false,
          // Recorded at RESOLVE time, not here: `.from()` runs BEFORE
          // `.innerJoin()`, so recording eagerly logged the middleware's own
          // workspace_members select as if it were the procedure's.
          from: (t: unknown) => { b._table = t; return b; },
          innerJoin: () => { b._joined = true; return b; },
          leftJoin: () => b,
          where: (w: unknown) => { if (!b._joined) wheres.push([...new Set(comparedColumns(w))]); return b; },
          orderBy: () => b,
          limit: () => b,
          then: (res: (v: unknown) => void, rej: (e: unknown) => void) => {
            if (b._joined) {
              res([{
                ws: { id: 1, name: "Acme", ownerUserId: 1, archivedAt: null },
                mb: { id: 1, userId: 1, role: "admin", deactivatedAt: null, workspaceId: 1, lastActiveAt: new Date() },
              }]);
              return;
            }
            froms.push(b._table);
            (inner.select() as any).then(res, rej);
          },
        };
        return b;
      },
    };
  }

  it("returns the page's submissions, newest first", async () => {
    const rows = [{ id: 2, pageId: 7, email: "b@x.com" }, { id: 1, pageId: 7, email: "a@x.com" }];
    h.db = dbWithMember(rows, []);
    const out = await appRouter.createCaller(adminCtx()).landingPages.submissions({ id: 7 });
    expect(out).toEqual(rows);
  });

  /**
   * 🔴 READS THE SUBMISSIONS TABLE, NOT `leads`.
   *
   * This list used to be derived from `leads` matching
   * `source = "landing:<slug>"`, which could only ever show submissions that
   * BECAME leads — structurally blind to the three cases this whole change
   * exists for. Swapping the table back is invisible to a fake that returns its
   * scripted rows regardless, so the TABLE the query was built against is
   * asserted directly.
   */
  it("reads landing_page_submissions — not leads, which is what made the old list lie", async () => {
    const froms: unknown[] = [];
    h.db = dbWithMember([], [], froms);
    await appRouter.createCaller(adminCtx()).landingPages.submissions({ id: 7 });

    expect(froms, "no un-joined select ran — re-anchor this test").toHaveLength(1);
    expect(froms[0], "the list must come from the submissions table").toBe(landingPageSubmissions);
    expect(froms[0], "deriving it from leads is the bug this replaced").not.toBe(leads);
  });

  /**
   * 🔒 CROSS-TENANT READ. `pageId` is caller input. Without the workspace
   * predicate any admin could page through another workspace's captured leads
   * by guessing an integer — and the fake cannot see that, so the QUERY is
   * inspected instead of the rows.
   */
  it("scopes the query to the caller's workspace, not just the pageId", async () => {
    const wheres: string[][] = [];
    h.db = dbWithMember([], wheres);
    await appRouter.createCaller(adminCtx()).landingPages.submissions({ id: 7 });

    const submissionWhere = wheres.find((cols) => cols.includes("pageId"));
    expect(submissionWhere, "no WHERE compared pageId — re-anchor this test").toBeTruthy();
    expect(
      submissionWhere,
      "the submissions query must filter on workspaceId as well as pageId",
    ).toContain("workspaceId");
  });
});

/**
 * 🚨 THE DOMINANT PROD-BREAKING BUG IN THIS REPO is a table that reaches
 * `drizzle/schema.ts` but never `rawMigrations.ts`. The drizzle journal is
 * frozen at 0047, so anything after that ONLY reaches production through the
 * embedded MIGRATIONS array — and `runRawMigrations` swallows failures, so the
 * app boots identically either way and the first symptom is a 500 in prod.
 */
describe("the migration exists for the table", () => {
  it("landing_page_submissions is created by a raw migration, not just declared in the schema", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(join(__dirname, "_core/rawMigrations.ts"), "utf8");

    expect(src).toContain("0145_landing_page_submissions.sql");
    expect(
      src,
      "the CREATE TABLE is missing — the schema declares a table production will not have",
    ).toMatch(/CREATE TABLE IF NOT EXISTS .landing_page_submissions./);

    // Every column the schema declares must appear in the migration, or the
    // table exists in prod with a column drizzle selects and MySQL rejects.
    for (const col of ["workspaceId", "pageId", "data", "name", "email", "company", "leadId", "routedToUserId", "createdAt"]) {
      expect(src, `column \`${col}\` is in schema.ts but not in migration 0145`).toContain(`\`${col}\``);
    }
  });
});
