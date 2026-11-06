/**
 * Data Health says what it measures, and its repairs do what they say
 * (audit 2026-10-20: P78, P79, P80, P81, P93, P95, P158).
 *
 *   P78  "Enriched (90d)" reads lastEnrichedAt, not updatedAt (any edit).
 *   P79  "Verified" counts valid addresses only.
 *   P80  "Duplicate People" counts the groups the merge can act on.
 *   P81  "Verify Now" (emailStatus=unknown) lists people with no status too.
 *   P93  "Link all unlinked" is a manager's, reads one page per click, and
 *        never links on a name match.
 *   P95  the contact merge shows every record, lets the person choose the
 *        survivor and the address, and the kept address carries the opt-out.
 *   P158 Refresh reloads every card, and the merge card's count is not capped
 *        at the 50 it lists.
 *
 * The routers run against the in-memory database. getMetrics' aggregate SQL is
 * beyond the fake, so its arithmetic is the pure healthMetricsFrom and its SQL
 * is pinned by source.
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

import { and, eq } from "drizzle-orm";
import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { appRouter } from "./routers";
import { prospects } from "../drizzle/schema";
import { emailStatusCondition } from "./routers/prospects";
import { healthMetricsFrom, mergeableEmailGroups } from "./services/dataHealthMetrics";
import { linkUnlinkedContacts } from "./services/personLink";
import { planContactMerge } from "../client/src/lib/contactMergePlan";

const WS = 2;
const root = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8").replace(/\r\n/g, "\n");
const rows = (t: string) => h.db.rowsOf(t) as any[];
const row = (t: string, id: number) => rows(t).find((r) => r.id === id);

function fresh(role: string) {
  h.db = makeSqlFakeDb({ roles: { [WS]: role }, wsId: () => WS });
  rows("workspaces").push({ id: WS, name: "LSI", slug: "lsi", ownerUserId: 1, archivedAt: null, plan: "trial" });
}
const caller = () => appRouter.createCaller({
  user: { id: 1, openId: "u", email: "o@example.com", name: "O", loginMethod: "password", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
  req: { protocol: "https", headers: { "x-workspace-id": String(WS) } },
  res: { clearCookie: () => {} },
} as unknown as TrpcContext);
async function refusal(p: Promise<unknown>): Promise<{ code: string; message: string }> {
  try { await p; } catch (e: any) { return { code: e.code, message: e.message }; }
  throw new Error("expected a refusal, but it resolved");
}
function contact(id: number, over: Record<string, unknown> = {}) {
  rows("contacts").push({
    id, workspaceId: WS, accountId: null, firstName: "Ann", lastName: "Lee", email: null, phone: null, title: null,
    linkedinUrl: null, city: null, seniority: null, companyName: null, companyDomain: null, personProspectId: null,
    createdAt: new Date(2026, 0, id), ...over,
  });
}
function person(id: number, over: Record<string, unknown> = {}) {
  rows("prospects").push({
    id, workspaceId: WS, firstName: "Ann", lastName: "Lee", email: null, linkedinUrl: null, company: null,
    companyDomain: null, title: null, phone: null, fieldProvenance: null, linkedContactId: null, ...over,
  });
}

beforeEach(() => fresh("admin"));

/* ── The Overview numbers ────────────────────────────────────────────────── */

describe("getMetrics", () => {
  const src = read("server/routers/dataHealth.ts");
  const fn = src.slice(src.indexOf("getMetrics: workspaceProcedure"), src.indexOf("mergeContacts: adminWsProcedure"));
  const totals = {
    total: 10, withEmail: 8, withPhone: 1, withCompany: 1, withTitle: 1, withLinkedIn: 1,
    verifiedValid: 2, verifiedAcceptAll: 2, verifiedRisky: 1, verifiedInvalid: 3, verifiedUnknown: 2, enrichedLast90Days: 4,
  };

  it("P78: enriched in 90 days means lastEnrichedAt, which only an enrichment pass stamps", () => {
    expect(fn.length).toBeGreaterThan(0);
    expect(fn).toContain("${prospects.lastEnrichedAt} >= DATE_SUB(NOW(), INTERVAL 90 DAY)");
    expect(fn).not.toContain("${prospects.updatedAt}");
    expect(healthMetricsFrom(totals, []).pctEnriched).toBe(40);
  });

  it("P79: verified means valid — invalid, risky and accept-all addresses are not", () => {
    expect(healthMetricsFrom(totals, []).pctVerified).toBe(20);
    const page = read("client/src/pages/usip/DataHealth.tsx");
    const card = page.slice(page.indexOf('label="Valid Emails"'), page.indexOf("fixLabel=\"Verify Now\""));
    expect(card).toContain("value={metrics?.verifiedValid ?? 0}");
    expect(card).not.toContain("verifiedInvalid");
  });

  it("P80: duplicate people are the address groups the merge takes, nothing else", () => {
    // The name + company groups no tool merges are gone from the query.
    expect(fn).not.toMatch(/GROUP BY firstName, lastName, company/);
    expect(fn).toContain("healthMetricsFrom(totals, dupEmailRows)");
    // Shared inboxes and placeholders are never merged, so never counted;
    // one address in two spellings is one group.
    expect(mergeableEmailGroups([
      { email: "ann@acme.example" }, { email: "ANN@acme.example " }, { email: "info@acme.example" },
      { email: "<UNKNOWN>" }, { email: "bob@acme.example" },
    ])).toBe(2);
    expect(healthMetricsFrom(totals, [{ email: "ann@acme.example" }]).estimatedDuplicates).toBe(1);
  });
});

describe("P81: the email-status filter", () => {
  beforeEach(() => {
    person(1, { emailStatus: null });
    person(2, { emailStatus: "unknown" });
    person(3, { emailStatus: "valid" });
    person(4, { emailStatus: null, workspaceId: 99 });
  });
  const ids = async (status: string) =>
    (await h.db.select().from(prospects).where(and(eq(prospects.workspaceId, WS), emailStatusCondition(status)))).map((p: any) => p.id).sort();

  it("unknown includes people never verified, as the tile linking to it counts them", async () => {
    expect(await ids("unknown")).toEqual([1, 2]);
  });
  it("any other status is that status only", async () => {
    expect(await ids("valid")).toEqual([3]);
  });
  it("the People list uses it", () => {
    expect(read("server/routers/prospects.ts")).toContain("if (input.emailStatus) conditions.push(emailStatusCondition(input.emailStatus));");
  });
});

/* ── Link all unlinked ───────────────────────────────────────────────────── */

describe("P93: Link all unlinked", () => {
  function seedLinkable() {
    // Same address: links.
    person(10, { email: "ann@acme.example" });
    contact(1, { email: "ann@acme.example" });
    // Only a name and company match: left alone.
    person(11, { firstName: "Bo", lastName: "Ng", company: "Initech" });
    contact(2, { firstName: "Bo", lastName: "Ng", companyName: "Initech" });
    // An address no People row holds, but a same-name person at its domain:
    // the name tier would link it, so it is left alone too.
    person(12, { firstName: "Cy", lastName: "Oh", companyDomain: "globex.example" });
    contact(3, { firstName: "Cy", lastName: "Oh", email: "cy.oh@globex.example", companyDomain: "globex.example" });
  }

  it("is refused to a rep", async () => {
    fresh("rep");
    seedLinkable();
    expect((await refusal(caller().dataHealth.relinkAllUnlinked({ afterId: 0 }))).code).toBe("FORBIDDEN");
    expect(row("contacts", 1).personProspectId).toBeNull();
  });

  it("links a manager's contacts on an address, and never on a name", async () => {
    fresh("manager");
    seedLinkable();
    const r = await caller().dataHealth.relinkAllUnlinked({ afterId: 0 });
    expect(row("contacts", 1).personProspectId).toBe(10);
    expect(row("contacts", 2).personProspectId).toBeNull();
    expect(row("contacts", 3).personProspectId).toBeNull();
    expect(r).toMatchObject({ linked: 1, skippedNameOnly: 2, more: false });
    // Nothing was written onto the name-matched people either.
    expect(row("prospects", 12).email).toBeNull();
  });

  it("reads one page per call and hands back where to carry on", async () => {
    seedLinkable();
    const first = await linkUnlinkedContacts({ workspaceId: WS, limit: 2, maxPages: 1, keysOnly: true });
    expect(first).toMatchObject({ scanned: 2, more: true, nextAfterId: 2 });
    const next = await linkUnlinkedContacts({ workspaceId: WS, limit: 2, maxPages: 1, keysOnly: true, afterId: first.nextAfterId });
    expect(next).toMatchObject({ scanned: 1, more: false });
  });

  it("the button reads one page, from the cursor", () => {
    const src = read("server/routers/dataHealth.ts");
    const proc = src.slice(src.indexOf("relinkAllUnlinked:"), src.indexOf("planPeopleMerge:"));
    expect(proc).toContain("relinkAllUnlinked: managerProcedure");
    expect(proc).toContain("afterId: input.afterId, limit: RELINK_PAGE, maxPages: 1, keysOnly: true");
  });

  it("control: the nightly backfill still links on the name tiers, as before", async () => {
    seedLinkable();
    await linkUnlinkedContacts({ workspaceId: WS });
    expect(row("contacts", 2).personProspectId).toBe(11);
  });
});

/* ── The contact merge ───────────────────────────────────────────────────── */

describe("P95: merging a duplicate-contact group", () => {
  it("loads every record in the group, in this workspace only", async () => {
    contact(701); contact(702); contact(703);
    contact(704, { workspaceId: 99 });
    const got = await caller().dataHealth.duplicateGroupRecords({ ids: [701, 702, 703, 704] });
    expect(got.map((r) => r.id)).toEqual([701, 702, 703]);
  });

  it("the survivor can keep the duplicate's address", async () => {
    contact(701, { email: "ann@acme.example" });
    contact(702, { email: "ann.lee@acme.example" });
    await caller().dataHealth.mergeContacts({ primaryId: 701, secondaryId: 702, overrideFields: ["email"] });
    expect(row("contacts", 701).email).toBe("ann.lee@acme.example");
  });

  it("an opt-out on the address it drops is carried to the address it keeps", async () => {
    contact(701, { email: "ann@acme.example" });
    contact(702, { email: "ann.lee@acme.example" });
    rows("email_suppressions").push({ id: 1, workspaceId: WS, email: "ann@acme.example", reason: "unsubscribe", contactId: 701 });
    await caller().dataHealth.mergeContacts({ primaryId: 701, secondaryId: 702, overrideFields: ["email"] });
    expect(rows("email_suppressions").filter((s) => s.email === "ann.lee@acme.example" && s.reason === "unsubscribe")).toHaveLength(1);
  });

  it("…in either direction: keeping its own address, the survivor takes the duplicate's opt-out", async () => {
    contact(701, { email: "ann@acme.example" });
    contact(702, { email: "ann.lee@acme.example" });
    rows("are_suppression_list").push({ id: 1, workspaceId: WS, email: "ann.lee@acme.example", reason: "do_not_contact" });
    await caller().dataHealth.mergeContacts({ primaryId: 701, secondaryId: 702 });
    expect(rows("are_suppression_list").some((s) => s.email === "ann@acme.example" && s.reason === "do_not_contact")).toBe(true);
  });

  it("control: a bounce stays with the address it is about", async () => {
    contact(701, { email: "ann@acme.example" });
    contact(702, { email: "ann.lee@acme.example" });
    rows("email_suppressions").push({ id: 1, workspaceId: WS, email: "ann@acme.example", reason: "bounce", contactId: 701 });
    await caller().dataHealth.mergeContacts({ primaryId: 701, secondaryId: 702, overrideFields: ["email"] });
    expect(rows("email_suppressions").filter((s) => s.email === "ann.lee@acme.example")).toHaveLength(0);
  });

  describe("planContactMerge, the dialog's preview and its calls", () => {
    const records = [
      { id: 1, email: "a@x.example", title: null, phone: "111" },
      { id: 2, email: "b@x.example", title: "VP", phone: "222" },
      { id: 3, email: null, title: "CFO", phone: null },
    ];

    it("one call per duplicate, into the chosen survivor, with only the fields picked from it", () => {
      const { steps, result } = planContactMerge(records, 3, { email: 2, title: 3, phone: 1 });
      expect(steps).toEqual([
        { secondaryId: 1, overrideFields: ["phone"] },
        { secondaryId: 2, overrideFields: ["email"] },
      ]);
      expect(result.email).toEqual({ value: "b@x.example", fromId: 2 });
      expect(result.title).toEqual({ value: "CFO", fromId: 3 });
      expect(result.phone).toEqual({ value: "111", fromId: 1 });
    });

    it("with no picks, the survivor keeps its own and fills blanks from the first that has one, as the server does", () => {
      const { steps, result } = planContactMerge(records, 1, {});
      expect(steps.every((s) => s.overrideFields.length === 0)).toBe(true);
      expect(result.email.fromId).toBe(1);
      expect(result.title).toEqual({ value: "VP", fromId: 2 });
    });

    it("a pick of a blank value is ignored", () => {
      expect(planContactMerge(records, 1, { phone: 3 }).steps[1]).toEqual({ secondaryId: 3, overrideFields: [] });
    });
  });

  it("the dialog shows every record and its choices drive the merge", () => {
    const page = read("client/src/pages/usip/DataHealth.tsx");
    const dialog = page.slice(page.indexOf("function MergeDialog("), page.indexOf("function SplitPeopleSection("));
    expect(dialog).toContain("trpc.dataHealth.duplicateGroupRecords.useQuery({ ids }");
    expect(dialog).toContain("records.map((r) => (");
    expect(dialog).toContain("const plan = planContactMerge(records, survivorId, picks);");
    expect(dialog).toContain("for (const step of plan.steps) {");
    expect(dialog).not.toContain("Only the first two are shown");
  });
});

/* ── Refresh and the merge card's count ──────────────────────────────────── */

describe("P158: what Refresh reloads, and what the merge card counts", () => {
  const page = read("client/src/pages/usip/DataHealth.tsx");

  it("Refresh invalidates every Data Health read", () => {
    const header = page.slice(page.indexOf("<PageHeader"), page.indexOf("</PageHeader>"));
    expect(header).toContain("onClick={() => { void utils.dataHealth.invalidate(); }}");
  });

  it("the merge card counts every mergeable group, and says when it lists fewer", () => {
    const section = page.slice(page.indexOf("function PeopleMergeSection("), page.indexOf("function ProviderEffectivenessCard("));
    expect(section).toContain("(plan.data?.clustersFound ?? 0) - (plan.data?.skipped.length ?? 0)");
    expect(section).toContain("Showing the first {clusters.length}.");
  });
});
