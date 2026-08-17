/**
 * Association dry run — the plan a run returns before anything moves.
 *
 * The 2026-08-13 run had to be undone by owner directive; the next one gets
 * read first. These tests drive the REAL associateProspectToCompany /
 * associateUnlinkedProspects against a fake db whose insert/update THROW, so
 * "a dry run writes nothing" is proved by the run finishing, not by scanning
 * the source for the word dryRun.
 */
import { describe, it, expect, vi } from "vitest";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { accounts, accountDomains, prospects, prospectLinkedinEnrichments } from "../../../drizzle/schema";

const h = vi.hoisted(() => ({ db: null as any }));
vi.mock("../../db", async (importActual) => ({
  ...(await importActual<typeof import("../../db")>()),
  getDb: async () => h.db,
}));

import { associateProspectToCompany, associateUnlinkedProspects } from "./associationService";

const dialect = new MySqlDialect();
const paramsOf = (cond: unknown) => dialect.sqlToQuery(cond as any).params;

type FakeAccount = { id: number; normalizedName: string; normalizedDomain: string | null };
const FISERV = { id: 9, normalizedName: "fiserv", normalizedDomain: "fiserv.com", domain: "fiserv.com", name: "Fiserv", globalOrganizationId: 3 };

/** A read-only fake: every table has scripted rows; any write throws.
 *  Accounts lookups return only rows whose name/domain/id appears among the
 *  query's bound params, so a candidate is found the way the real index
 *  would find it — not handed back for every query regardless. */
function readOnlyDb(rows: { accounts?: FakeAccount[]; prospects?: unknown[]; linkedin?: unknown[] }) {
  const builder = () => {
    const st: { table?: unknown; params: unknown[] } = { params: [] };
    const b: any = {
      from(t: unknown) { st.table = t; return b; },
      where(cond: unknown) { st.params = paramsOf(cond); return b; },
      limit() { return b; },
      then(res: (v: unknown) => void, rej: (e: unknown) => void) {
        if (st.table === accounts) {
          res((rows.accounts ?? []).filter((r) => st.params.some((p) => p === r.normalizedName || p === r.normalizedDomain)));
        }
        else if (st.table === accountDomains) res([]);
        else if (st.table === prospects) res(rows.prospects ?? []);
        else if (st.table === prospectLinkedinEnrichments) res(rows.linkedin ?? []);
        else res([]); // global organizations etc.: nothing there
        void rej;
      },
    };
    return b;
  };
  return {
    select: () => builder(),
    insert: () => { throw new Error("dry run wrote: insert"); },
    update: () => { throw new Error("dry run wrote: update"); },
    delete: () => { throw new Error("dry run wrote: delete"); },
  };
}

describe("associateProspectToCompany dryRun", () => {
  it("links by exact name as needs_review and writes nothing", async () => {
    h.db = readOnlyDb({ accounts: [FISERV] });
    const r = await associateProspectToCompany(
      { id: 1, workspaceId: 7, company: "Fiserv", email: "jane@gmail.com" },
      { dryRun: true, linkedin: null },
    );
    expect(r.status).toBe("needs_review");
    expect(r.accountId).toBe(9);
    expect(r.created).toBe(false);
    expect(r.input).toEqual({ name: "Fiserv", domain: null, emailDomain: null, viaLinkedIn: false });
    expect(r.reasons).toContain("exact name (+50)");
  });

  it("reports a would-create with the identity it would use, and writes nothing", async () => {
    h.db = readOnlyDb({ accounts: [] });
    const r = await associateProspectToCompany(
      { id: 2, workspaceId: 7, company: "NewCo", companyDomain: "newco.org", email: "x@dc.gov" },
      { dryRun: true, linkedin: null },
    );
    expect(r.created).toBe(true);
    expect(r.accountId).toBeNull();
    expect(r.input).toEqual({ name: "NewCo", domain: "newco.org", emailDomain: "dc.gov", viaLinkedIn: false });
  });

  it("marks LinkedIn-sourced identity and prefers it over the record", async () => {
    h.db = readOnlyDb({ accounts: [] });
    const r = await associateProspectToCompany(
      { id: 3, workspaceId: 7, company: "Old Employer", email: "x@old.com" },
      { dryRun: true, linkedin: { companyName: "Fiserv", companyDomain: "fiserv.com" } },
    );
    expect(r.input?.viaLinkedIn).toBe(true);
    expect(r.input?.name).toBe("Fiserv");
    expect(r.input?.domain).toBe("fiserv.com");
  });

  it("reports missing without writing the status", async () => {
    h.db = readOnlyDb({ accounts: [] });
    const r = await associateProspectToCompany(
      { id: 4, workspaceId: 7, company: null, email: "x@dc.gov" },
      { dryRun: true, linkedin: null },
    );
    expect(r.status).toBe("missing");
    expect(r.input?.emailDomain).toBe("dc.gov"); // seen, but not an identity
  });

  it("a real run does try to write (so the fake's throw is what protects the dry run)", async () => {
    h.db = readOnlyDb({ accounts: [FISERV] });
    // Never throws into the ingestion path — the failure surfaces as "missing".
    const r = await associateProspectToCompany(
      { id: 1, workspaceId: 7, company: "Fiserv", email: "jane@gmail.com" },
      { linkedin: null },
    );
    expect(r.status).toBe("missing");
    expect(r.accountId).toBeNull();
  });
});

describe("associateUnlinkedProspects dryRun plan", () => {
  it("groups would-creates by name, counts links/reviews/missing, flags nothing that already exists", async () => {
    h.db = readOnlyDb({
      accounts: [FISERV],
      prospects: [
        { id: 1, workspaceId: 7, company: "NewCo", companyDomain: "newco.org", email: "a@newco.org" },
        { id: 2, workspaceId: 7, company: "NewCo Inc.", companyDomain: null, email: "b@gmail.com" },
        { id: 3, workspaceId: 7, company: "Fiserv", companyDomain: null, email: "c@gmail.com" },
        { id: 4, workspaceId: 7, company: "Fiserv", companyDomain: "fiserv.com", email: "d@fiserv.com" },
        { id: 5, workspaceId: 7, company: null, companyDomain: null, email: "e@dc.gov" },
      ],
      linkedin: [{ prospectId: 1, companyName: "NewCo", companyDomain: "newco.org" }],
    });
    const plan = await associateUnlinkedProspects(7, 3000, "prospect_import", { dryRun: true });
    expect("dryRun" in plan && plan.dryRun).toBe(true);
    if (!("dryRun" in plan)) throw new Error("expected a plan");
    expect(plan.processed).toBe(5);
    expect(plan.viaLinkedIn).toBe(1);
    expect(plan.created).toBe(2);           // two people would create
    expect(plan.wouldCreateAccounts).toBe(1); // …one account ("newco", suffix stripped)
    expect(plan.wouldCreateWithDomain).toBe(1);
    expect(plan.needsReview).toBe(1);        // exact name only → reviewable link
    expect(plan.linked).toBe(1);             // name + domain → auto-link
    expect(plan.missing).toBe(1);
    expect(plan.conflict).toBe(0);
    expect(plan.nameCollisions).toEqual([]);
    expect(plan.domainVariants).toEqual([]);
    expect(plan.createSample).toEqual([{ name: "NewCo", domain: "newco.org", people: 2, viaLinkedIn: 1 }]);
  });
});
