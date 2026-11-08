/**
 * The campaign queue's duplicate check is an indexed lookup (audit
 * 2026-10-20, A34). It read the workspace's whole prospect_queue once per
 * discovery run and once per manual save. Each row now stores its identity
 * keys in indexed columns, made by queueIdentityColumns from
 * queueIdentityKeys (still the one definition); a check reads only the rows
 * that share a key with the people being checked, plus any row not keyed yet,
 * which it keys on the way out. Inserts write the columns; an update that
 * changes who a row is sends it back to "not keyed" (withIdentityRekey).
 *
 * Executed against the SQL-evaluating fake; the push's enrich chain is mocked.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  if (!process.env.ENCRYPTION_KEY && !process.env.JWT_SECRET) process.env.ENCRYPTION_KEY = "f".repeat(64);
  return { db: null as any };
});
vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));
vi.mock("./routers/are/prospects", async (a) => ({ ...(await a<typeof import("./routers/are/prospects")>()), runEnrichAgent: async () => true, runSequenceAgent: async () => ({}) }));

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import {
  KEY_ON_READ, backfillQueueIdentity, existingClaim, queueIdentityColumns, queueIdentityIndexFor, queueIdentityKeys,
  withIdentityRekey, workspaceQueueIdentityIndex,
} from "./services/are/queueIdentity";
import { pushPeopleIntoCampaign } from "./services/are/pushPeople";

const WS = 2, FOREIGN = 9;
const ROOT = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");
const rows = (t: string) => h.db.rowsOf(t) as any[];
const person = (over: Record<string, unknown>) => ({ email: null, linkedinUrl: null, firstName: null, lastName: null, companyName: null, companyDomain: null, ...over });
/** A queue row, keyed as an insert now keys it (or not, for a row from before). */
const queued = (id: number, campaignId: number, p: Record<string, unknown>, keyed = true, workspaceId = WS) => ({
  id, workspaceId, campaignId, sequenceStatus: "pending", enrichmentStatus: "pending", ...person(p),
  ...(keyed ? queueIdentityColumns(person(p)) : { identityEmail: null, identityLinkedin: null, identityNameOrg: null, identityVersion: 0 }),
});

beforeEach(() => {
  h.db = makeSqlFakeDb({ roles: { [WS]: "admin" }, wsId: () => WS });
  rows("are_campaigns").push(
    { id: 1, workspaceId: WS, name: "A", status: "active" },
    { id: 2, workspaceId: WS, name: "B", status: "active" },
    { id: 3, workspaceId: FOREIGN, name: "Theirs", status: "active" },
  );
});

describe("the stored keys are queueIdentityKeys' keys", () => {
  it.each([
    [{ email: " Ann@Example.org ", linkedinUrl: "https://www.linkedin.com/in/ann-lee-1/", firstName: "Ann", lastName: "Lee", companyDomain: "example.org" }],
    [{ linkedinUrl: "linkedin.com/in/bob", firstName: "Bob", lastName: "Ray", companyName: "Acme Inc." }],
    [{ email: "x@y.co" }],
    [{ firstName: "Only", lastName: "Name" }],
  ])("%j", (p) => {
    const keys = queueIdentityKeys(p);
    const c = queueIdentityColumns(p);
    if (c.identityEmail) expect(keys).toContain(`e:${c.identityEmail}`);
    if (c.identityLinkedin) expect(keys).toContain(`u:${c.identityLinkedin}`);
    if (c.identityNameOrg) expect(keys).toContain(`n:${c.identityNameOrg}`);
    expect(Boolean(c.identityEmail)).toBe(keys.some((k) => k.startsWith("e:")));
    expect(Boolean(c.identityNameOrg)).toBe(keys.some((k) => k.startsWith("n:")));
    expect(c.identityVersion).toBe(1);
  });
  it("the LinkedIn column keeps the profile slug, so any URL shape of it matches", () => {
    expect(queueIdentityColumns({ linkedinUrl: "https://m.linkedin.com/in/ann-lee-1?trk=x" }).identityLinkedin)
      .toBe(queueIdentityColumns({ linkedinUrl: "linkedin.com/in/ann-lee-1" }).identityLinkedin);
  });
});

describe("a check reads only the rows that share a key", () => {
  beforeEach(() => {
    rows("prospect_queue").push(
      queued(10, 1, { email: "ann@example.org", firstName: "Ann", lastName: "Lee", companyDomain: "example.org" }),
      queued(11, 2, { linkedinUrl: "https://www.linkedin.com/in/bob-ray", firstName: "Bob", lastName: "Ray" }),
      queued(12, 2, { email: "carol@example.org" }),
      queued(13, 3, { email: "ann@example.org" }, true, FOREIGN),
      queued(14, 2, { email: "ann@example.org" }),
    );
  });

  it("finds a claim by email, by any URL shape of a profile, and by name at a company", async () => {
    const shapes = [
      { email: "ANN@example.org" },
      { linkedinUrl: "linkedin.com/in/bob-ray/" },
      { firstName: "Ann", lastName: "Lee", companyDomain: "example.org" },
    ];
    const index = await queueIdentityIndexFor(WS, shapes);
    expect(existingClaim(index, shapes[0])).toEqual({ rowId: 10, campaignId: 1 });
    expect(existingClaim(index, shapes[1])).toEqual({ rowId: 11, campaignId: 2 });
    expect(existingClaim(index, shapes[2])).toEqual({ rowId: 10, campaignId: 1 });
  });

  it("holds nobody else: not an unrelated row, not another workspace's", async () => {
    const index = await queueIdentityIndexFor(WS, [{ email: "ann@example.org" }]);
    expect(index.has("e:carol@example.org")).toBe(false);
    expect(Array.from(new Set(Array.from(index.values()).map((v) => v.rowId)))).toEqual([10]);
    expect(Array.from(index.values()).some((v) => v.campaignId === 3)).toBe(false);
    // The whole-queue index, for contrast, holds everyone.
    expect((await workspaceQueueIdentityIndex(WS)).has("e:carol@example.org")).toBe(true);
  });

  it("the lowest id wins a key, as in the whole-queue index", async () => {
    const index = await queueIdentityIndexFor(WS, [{ email: "ann@example.org" }]);
    expect(index.get("e:ann@example.org")).toEqual({ rowId: 10, campaignId: 1 });
  });

  it("a row whose campaign is gone is left out, unless the caller counts every row", async () => {
    rows("are_campaigns").splice(rows("are_campaigns").findIndex((c) => c.id === 1), 1);
    expect(existingClaim(await queueIdentityIndexFor(WS, [{ firstName: "Ann", lastName: "Lee", companyDomain: "example.org" }]), { firstName: "Ann", lastName: "Lee", companyDomain: "example.org" })).toBeNull();
    expect(existingClaim(await queueIdentityIndexFor(WS, [{ firstName: "Ann", lastName: "Lee", companyDomain: "example.org" }], { liveCampaignsOnly: false }), { firstName: "Ann", lastName: "Lee", companyDomain: "example.org" }))
      .toEqual({ rowId: 10, campaignId: 1 });
  });
});

describe("a row not keyed yet is never missed, and is keyed", () => {
  it("is read by every lookup until keyed, and keyed on the way out", async () => {
    rows("prospect_queue").push(queued(20, 1, { email: "old@example.org" }, false));
    const index = await queueIdentityIndexFor(WS, [{ email: "old@example.org" }]);
    expect(existingClaim(index, { email: "old@example.org" })).toEqual({ rowId: 20, campaignId: 1 });
    expect(rows("prospect_queue")[0]).toMatchObject({ identityEmail: "old@example.org", identityVersion: 1 });
  });
  it("a lookup keys at most KEY_ON_READ of them; the backfill keys the rest, once", async () => {
    for (let i = 0; i < KEY_ON_READ + 5; i++) rows("prospect_queue").push(queued(100 + i, 1, { email: `p${i}@example.org` }, false));
    await queueIdentityIndexFor(WS, [{ email: "nobody@example.org" }]);
    expect(rows("prospect_queue").filter((r) => r.identityVersion === 1)).toHaveLength(KEY_ON_READ);
    expect(await backfillQueueIdentity({ batch: 3 })).toEqual({ keyed: 5 });
    expect(rows("prospect_queue").every((r) => r.identityVersion === 1)).toBe(true);
    expect(await backfillQueueIdentity()).toEqual({ keyed: 0 });
  });
  it("an update that changes who a row is sends it back to not keyed", () => {
    expect(withIdentityRekey({ email: "new@example.org", enrichedAt: null })).toEqual({ email: "new@example.org", enrichedAt: null, identityVersion: 0 });
    expect(withIdentityRekey({ enrichmentStatus: "failed" })).toEqual({ enrichmentStatus: "failed" });
  });
});

describe("the push into a campaign uses the indexed check and writes the keys", () => {
  it("a person already queued elsewhere is refused; a new one is queued keyed", async () => {
    rows("prospect_queue").push(queued(10, 1, { email: "ann@example.org" }));
    rows("prospects").push(
      { id: 500, workspaceId: WS, firstName: "Ann", lastName: "Lee", email: "ann@example.org" },
      { id: 501, workspaceId: WS, firstName: "Dee", lastName: "Fox", email: "dee@example.org", linkedinUrl: "https://www.linkedin.com/in/dee-fox" },
    );
    const r = await pushPeopleIntoCampaign(WS, 2, [500, 501]);
    expect(r.skipped.map((s) => s.prospectId)).toEqual([500]);
    expect(r.added.map((a) => a.prospectId)).toEqual([501]);
    const row = rows("prospect_queue").find((q) => q.personProspectId === 501);
    expect(row).toMatchObject({ identityEmail: "dee@example.org", identityLinkedin: "dee-fox", identityVersion: 1 });
    // The push's first call loads its lazy imports; slow on a busy machine.
  }, 30_000);
});

describe("every writer keeps the keys right", () => {
  const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return f === "__fakes__" || f === "node_modules" ? [] : files(p);
    return /\.ts$/.test(f) && !/\.test\.ts$/.test(f) && !/seed/i.test(f) ? [p] : [];
  });
  const sources = files(join(ROOT, "server")).map((f) => ({ f: relative(ROOT, f), src: readFileSync(f, "utf8").replace(/\r\n/g, "\n") }));

  it("each update that sets an identity field, or a patch object, goes through withIdentityRekey", () => {
    const ID = /\b(email|linkedinUrl|firstName|lastName|companyName|companyDomain)\b\s*:/;
    const offenders: string[] = [];
    for (const { f, src } of sources) {
      let i = 0;
      while ((i = src.indexOf("update(prospectQueue)", i)) >= 0) {
        const end = src.indexOf(".where(", i);
        const stmt = src.slice(i, end < 0 ? i + 400 : end);
        const variable = /\.set\(\s*[A-Za-z_]\w*\s*(as never)?\s*\)/.test(stmt);
        if ((ID.test(stmt) || variable) && !stmt.includes("withIdentityRekey(") && !stmt.includes("queueIdentityColumns(")) offenders.push(`${f}: ${stmt.replace(/\s+/g, " ").slice(0, 140)}`);
        i += 10;
      }
    }
    expect(offenders).toEqual([]);
  });

  it("each insert writes the stored keys", () => {
    const sites = sources.filter(({ src }) => src.includes("insert(prospectQueue)"));
    expect(sites.map((s) => s.f.split(sep).join("/")).sort()).toEqual([
      "server/routers/are/prospects.ts",
      "server/routers/are/scraper.ts",
      "server/services/are/pushPeople.ts",
    ]);
    for (const s of sites) expect(s.src, s.f).toContain("...queueIdentityColumns(");
    const pros = read("server/routers/are/prospects.ts");
    expect(pros).toContain("...rest,\n        ...queueIdentityColumns(rest),");
    expect(pros).toContain("...queueIdentityColumns(shape),\n          icpMatchScore: 0,");
  });

  it("discovery and the manual saves look up by index, not the whole queue", () => {
    const eng = read("server/areEngine.ts");
    const fn = eng.slice(eng.indexOf("async function runDiscovery("), eng.indexOf("/* ─── Query slice builder"));
    expect(fn).not.toContain(".where(eq(prospectQueue.workspaceId, campaign.workspaceId))\n    .orderBy(prospectQueue.id);");
    expect(fn).toContain("await queueIdentityIndexFor(campaign.workspaceId, fresh, { liveCampaignsOnly: false });");
    const at = fn.indexOf("await loadClaims(raw);");
    expect(at).toBeGreaterThan(0);
    expect(fn.slice(at, at + 80)).toContain("const unique = raw.filter(");
    for (const f of ["server/services/are/pushPeople.ts", "server/services/are/addExistingPreview.ts", "server/routers/are/scraper.ts"]) {
      expect(read(f), f).toContain("queueIdentityIndexFor(");
      expect(read(f), f).not.toContain("workspaceQueueIdentityIndex(");
    }
    const pros = read("server/routers/are/prospects.ts");
    expect(pros).not.toContain("workspaceQueueIdentityIndex(");
    expect(read("server/_core/index.ts")).toContain("m.backfillQueueIdentity()");
  });
});
