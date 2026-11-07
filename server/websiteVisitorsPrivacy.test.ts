/**
 * Website visitor tracking, privacy first (audit 2026-10-20, P87), and honest
 * about who a visit is (P88).
 *
 *   P87  a browser that sends Do Not Track or Global Privacy Control is not
 *        tracked, by the script or by the route · query strings and fragments
 *        are never stored · the cookie lasts 30 days, not a year · visits are
 *        kept for 180 days · a suppressed person gets no "reach out" task.
 *   P88  the page no longer promises "known prospect" matching: nothing adds
 *        a record id to links and the id is unsigned, so a visit naming a
 *        record is shown, and filed, as an unverified claim.
 *   P154 a failed stats read says so instead of showing zeros and
 *        "Not connected"; P160 a long path wraps.
 *
 * The script runs for real in a sandbox; the route runs against the
 * in-memory database.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";

const h = vi.hoisted(() => ({ db: null as any }));
vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db }));

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import {
  purgeOldWebsiteVisits, registerWebsiteTrackingRoutes, signVisitorId, VISITOR_COOKIE_DAYS, WEBSITE_VISIT_RETENTION_DAYS, withoutQuery,
} from "./websiteTracking";

const WS = 2;
const root = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8").replace(/\r\n/g, "\n");
const rows = (t: string) => h.db.rowsOf(t) as any[];

function routes() {
  const out: { script?: (req: any, res: any) => void; beacon?: (req: any, res: any) => Promise<void> } = {};
  registerWebsiteTrackingRoutes({
    get: (p: string, fn: any) => { if (p === "/v/track.js") out.script = fn; },
    options: () => {},
    post: (_p: string, fn: any) => { out.beacon = fn; },
  } as any);
  return out;
}
const res = () => { const r: any = { setHeader: () => {}, status: () => r, json: () => r, end: () => r, send: (b: string) => { r.body = b; return r; } }; return r; };

/** Run the served tracker script in a page with these privacy signals; report what it did. */
function runScript(nav: Record<string, unknown> = {}, win: Record<string, unknown> = {}) {
  const r = res();
  routes().script!({}, r);
  const sent: any[] = [];
  const doc = { cookie: "", referrer: "https://news.example/item?id=1&utm_source=x#c", currentScript: { getAttribute: () => "lsi", src: "https://app.example/v/track.js" }, getElementsByTagName: () => [] };
  runInNewContext(r.body, {
    navigator: { userAgent: "UA", ...nav },
    document: doc,
    location: { pathname: "/pricing", search: "?email=ann%40acme.example&vid=l1" },
    URLSearchParams,
    fetch: (_u: string, o: any) => { sent.push(JSON.parse(o.body)); return Promise.resolve(); },
    window: win,
    ...win,
  });
  return { sent, cookie: doc.cookie };
}

describe("the tracker script", () => {
  it("does nothing at all under Global Privacy Control", () => {
    const r = runScript({ globalPrivacyControl: true });
    expect(r.sent).toHaveLength(0);
    expect(r.cookie).toBe("");
  });

  it.each([
    ["navigator.doNotTrack", { doNotTrack: "1" }, {}],
    ["window.doNotTrack", {}, { doNotTrack: "1" }],
  ])("does nothing under Do Not Track (%s)", (_n, nav, win) => {
    expect(runScript(nav, win).sent).toHaveLength(0);
  });

  it("sends the path and the referrer without their query strings", () => {
    const { sent } = runScript();
    expect(sent).toHaveLength(1);
    expect(sent[0].path).toBe("/pricing");
    expect(sent[0].referrer).toBe("https://news.example/item");
  });

  it(`sets a ${VISITOR_COOKIE_DAYS}-day cookie, not a year's`, () => {
    expect(VISITOR_COOKIE_DAYS).toBe(30);
    expect(runScript().cookie).toContain(`max-age=${30 * 86400};`);
  });
});

describe("the /api/track route", () => {
  beforeEach(() => {
    h.db = makeSqlFakeDb({ roles: { [WS]: "admin" }, wsId: () => WS });
    rows("workspaces").push({ id: WS, name: "LSI", slug: "lsi", ownerUserId: 1, archivedAt: null, plan: "trial" });
    rows("leads").push(
      { id: 1, workspaceId: WS, firstName: "Ann", lastName: "Lee", email: "ann@acme.example", ownerUserId: null },
      { id: 2, workspaceId: WS, firstName: "Bo", lastName: "Ng", email: "bo@initech.example", ownerUserId: null },
    );
  });
  const beacon = (body: Record<string, unknown>, headers: Record<string, string> = {}) => routes().beacon!({ body, headers }, res());
  const intentTasks = () => rows("tasks").filter((t) => String(t.title).startsWith("High-intent website visit"));

  it.each([["dnt"], ["sec-gpc"]])("drops a beacon sent with %s: 1, from an older cached script", async (header) => {
    await beacon({ slug: "lsi", visitorId: "v1", path: "/pricing" }, { [header]: "1" });
    expect(rows("website_visits")).toHaveLength(0);
  });

  it("stores the path and the referrer without query strings or fragments", async () => {
    await beacon({ slug: "lsi", visitorId: "v1", path: "/demo?email=ann%40acme.example#x", referrer: "https://search.example/?q=ann+lee" });
    expect(rows("website_visits")[0]).toMatchObject({ path: "/demo", referrer: "https://search.example/" });
    expect(withoutQuery("?only=query")).toBe("");
  });

  // 2026-11-06 (S1b, P5): only a signed link id can file a task now, so both
  // cases below use one; an unsigned id filing nothing would make the
  // suppression case pass for the wrong reason. The task's wording follows.
  it("files no task for someone who unsubscribed, and still counts the visit", async () => {
    rows("email_suppressions").push({ id: 1, workspaceId: WS, email: "ann@acme.example", reason: "unsubscribe" });
    await beacon({ slug: "lsi", visitorId: "v1", path: "/pricing", vid: signVisitorId(WS, "l", 1) });
    expect(rows("website_visits")).toHaveLength(1);
    expect(intentTasks()).toHaveLength(0);
    expect(rows("activities")).toHaveLength(0);
  });

  it("control: an unsuppressed record still gets the task, which says how it was matched", async () => {
    await beacon({ slug: "lsi", visitorId: "v1", path: "/pricing", vid: signVisitorId(WS, "l", 2) });
    expect(intentTasks()).toHaveLength(1);
    expect(intentTasks()[0].description).toContain("matched by a signed id in the link");
  });
});

describe("retention", () => {
  it(`deletes visits older than ${WEBSITE_VISIT_RETENTION_DAYS} days, in batches`, async () => {
    // A full batch, then a short one: two DELETEs, then it stops.
    const affected = [5000, 12];
    const statements: any[] = [];
    h.db = { execute: async (q: unknown) => { statements.push(q); return [{ affectedRows: affected.shift() ?? 0 }]; } };
    const now = new Date("2026-11-06T00:00:00Z");
    expect(await purgeOldWebsiteVisits(now)).toBe(2);
    const q = new (await import("drizzle-orm/mysql-core")).MySqlDialect().sqlToQuery(statements[0]);
    expect(q.sql).toMatch(/^DELETE FROM `website_visits` WHERE `website_visits`\.`createdAt` < \? LIMIT 5000$/);
    expect(new Date(q.params[0] as any).getTime()).toBe(now.getTime() - 180 * 86_400_000);
  });

  it("runs daily with the engine-log retention", () => {
    const index = read("server/_core/index.ts");
    const job = index.slice(index.indexOf("const runLogRetention = () => {"), index.indexOf("setInterval(runLogRetention"));
    expect(job).toContain("m.purgeOldWebsiteVisits()");
  });
});

describe("the visitors page", () => {
  const page = read("client/src/pages/usip/WebsiteVisitors.tsx");

  it("P88: does not promise known-prospect matching, or tell anyone to hand-tag links", () => {
    expect(page).not.toContain("matched to the exact prospect");
    expect(page).not.toContain("?vid=&lt;leadId&gt;");
    expect(page).toContain("Matching a visit to a prospect isn't available yet.");
    expect(page).toContain('"Records named (unverified)"');
  });

  it("P154: a failed stats read is an error, not zeros and Not connected", () => {
    const head = page.slice(page.indexOf("{statsFailed ? ("), page.indexOf("{/* connect tracking"));
    expect(head).toContain("Status unknown");
    expect(head).toContain('<QueryError compact what="visit counts"');
  });

  it("P160: a long path wraps instead of being cut off", () => {
    expect(page).toContain('max-w-[280px] break-all">{r.path}</td>');
    expect(page).not.toContain("truncate max-w-[280px]");
  });

  it("the tour and the manual don't promise who either", () => {
    expect(read("server/seedHelpContent.ts")).not.toContain("Known people, recognised");
    expect(read("server/seedHelpOperatorManual.ts")).not.toContain("companies and known contacts seen on your site");
  });
});
