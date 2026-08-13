/**
 * ARE prospect audit + campaign exclusivity (owner directive 2026-08-12).
 *
 * One identity vocabulary (services/are/queueIdentity) serves dedup AND the
 * one-campaign-per-prospect rule, enforced at every ingest seam; the
 * reconcile pass applies the same rule to history. Tests here drive the
 * real audit against a fake db, the real key functions, and pin the seams.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { prospectQueue, prospects } from "../drizzle/schema";

const h = vi.hoisted(() => ({ db: null as any }));
vi.mock("./db", async (importActual) => ({
  ...(await importActual<typeof import("./db")>()),
  getDb: async () => h.db,
}));

import { queueIdentityKeys, existingClaim } from "./services/are/queueIdentity";
import { auditQueueProspects } from "./services/are/prospectReconcile";

describe("queue identity keys", () => {
  it("recognizes the same LinkedIn profile through URL variants via the slug", () => {
    const a = queueIdentityKeys({ linkedinUrl: "https://www.linkedin.com/in/jane-doe-123/" });
    const b = queueIdentityKeys({ linkedinUrl: "https://m.linkedin.com/in/Jane-Doe-123?src=x" });
    const slugKeys = (k: string[]) => k.filter((x) => x.startsWith("u:") && !x.includes("linkedin.com"));
    expect(slugKeys(a)).toEqual(slugKeys(b));
    expect(slugKeys(a).length).toBeGreaterThan(0);
  });

  it("emails key case-insensitively; name+org needs BOTH a name and an org", () => {
    expect(queueIdentityKeys({ email: "Jane@Acme.COM" })).toContain("e:jane@acme.com");
    expect(queueIdentityKeys({ firstName: "Jane", lastName: "Doe" })).toEqual([]);
    expect(queueIdentityKeys({ firstName: "Jane", lastName: "Doe", companyName: "Acme Corp" }))
      .toContain("n:jane doe@acme corp");
  });

  it("existingClaim answers with the owning campaign", () => {
    const index = new Map([["e:jane@acme.com", { rowId: 9, campaignId: 3 }]]);
    expect(existingClaim(index, { email: "JANE@acme.com" })).toEqual({ rowId: 9, campaignId: 3 });
    expect(existingClaim(index, { email: "other@acme.com" })).toBeNull();
  });
});

describe("auditQueueProspects (real function, fake db)", () => {
  function makeDb(queueRows: unknown[], personRows: unknown[] = []) {
    const builder = () => {
      const st: { table?: unknown } = {};
      const b: any = {
        from(t: unknown) { st.table = t; return b; },
        where() { return b; },
        orderBy() { return b; },
        then(res: (v: unknown) => void) {
          res(st.table === prospectQueue ? queueRows : st.table === prospects ? personRows : []);
        },
      };
      return b;
    };
    return { select: () => builder() };
  }
  const row = (o: Record<string, unknown>) => ({
    id: 1, campaignId: 1, personProspectId: null, sequenceStatus: "pending",
    firstName: null, lastName: null, email: null, linkedinUrl: null, sourceUrl: null,
    title: null, companyName: null, companyDomain: null, ...o,
  });

  it("counts missing names, broken links, cross-campaign duplicates, unreconcilable", async () => {
    h.db = makeDb([
      // Named, healthy.
      row({ id: 1, firstName: "Scott", lastName: "Rodriguez", email: "s@nasahunch.org" }),
      // Name-less but linked person carries the name — display covered.
      row({ id: 2, personProspectId: 77, linkedinUrl: "https://linkedin.com/in/x-1" }),
      // Placeholder link + no identity at all → unreconcilable.
      row({ id: 3, linkedinUrl: "<UNKNOWN>", sourceUrl: "not a url" }),
      // The same person in TWO campaigns (email key) → cross-campaign dupe.
      row({ id: 4, campaignId: 1, firstName: "Amanda", lastName: "Pauley", email: "a@wcc.edu" }),
      row({ id: 5, campaignId: 2, firstName: "Amanda", lastName: "Pauley", email: "a@wcc.edu" }),
      // Skipped rows are invisible to the audit.
      row({ id: 6, sequenceStatus: "skipped" }),
    ], [{ id: 77, firstName: "Dana", lastName: "Whitfield" }]);

    const a = await auditQueueProspects(1);
    expect(a.scanned).toBe(5);
    expect(a.nameCoveredByPerson).toBe(1);
    expect(a.missingName).toBe(1); // row 3 only — 4/5 are named
    expect(a.badLinkedinUrl).toBe(1);
    expect(a.badSourceUrl).toBe(1);
    expect(a.unreconcilable).toBe(1);
    expect(a.flaggedRowIds).toEqual([3]);
    expect(a.duplicateGroups).toBe(1);
    expect(a.duplicateRows).toBe(1);
    expect(a.crossCampaignGroups).toBe(1);
    expect(a.unlinkedPerson).toBe(4);
  });
});

describe("exclusivity is enforced at every ingest seam", () => {
  const read = (p: string) => readFileSync(p, "utf8");

  it("engine discovery seeds the dedup index workspace-WIDE and logs exclusions", () => {
    const src = read("server/areEngine.ts");
    expect(src).toContain("excludedOtherCampaign");
    // The seed select must not narrow to the campaign — that was the old
    // within-campaign-only dedup that let siblings double-claim a person.
    const seedAt = src.indexOf("Seed the dedup index");
    const seed = src.slice(seedAt, src.indexOf(".orderBy(prospectQueue.id)", seedAt));
    expect(seed).toContain("eq(prospectQueue.workspaceId, campaign.workspaceId)");
    expect(seed).not.toContain("eq(prospectQueue.campaignId");
  });

  it("saveScrapeJobAndQueue carries the belt for every other scrape caller", () => {
    const src = read("server/routers/are/scraper.ts");
    expect(src).toContain("workspaceQueueIdentityIndex");
    expect(src).toContain("existingClaim(index, p)");
  });

  it("addManual refuses with a message naming the owning campaign", () => {
    const src = read("server/routers/are/prospects.ts");
    expect(src).toContain("already belongs to another campaign");
  });

  it("importRows dedups against the whole workspace and reports the split", () => {
    const src = read("server/routers/are/prospects.ts");
    expect(src).toContain("skippedOtherCampaign");
    expect(src).toContain("workspaceQueueIdentityIndex(ctx.workspace.id)");
  });

  it("one identity vocabulary — the engine imports it rather than keeping a copy", () => {
    const src = read("server/areEngine.ts");
    expect(src).toContain('from "./services/are/queueIdentity"');
    expect(src).not.toMatch(/function nameOrgDedupKey/);
  });
});

describe("the reconcile pass keeps its promises (structural)", () => {
  const src = readFileSync("server/services/are/prospectReconcile.ts", "utf8");

  it("flags to Rejections, never deletes", () => {
    expect(src).toContain('sequenceStatus: "skipped"');
    expect(src).not.toContain("db.delete(");
  });

  it("keeper of a duplicate group is the most-engaged row", () => {
    expect(src).toContain("STATUS_RANK[b.sequenceStatus]");
    expect(src).toContain("replied: 7");
  });

  it("LinkedIn discovery is confidence-gated: exact name AND company mention", () => {
    expect(src).toContain("canonicalText(h.name) === wantName");
    expect(src).toContain("companyMentioned");
  });

  it("never writes name/email person columns onto queue rows (the 0153 rule)", () => {
    // The pass may write: scrubbed links, discovered linkedinUrl, enrichment
    // re-queue stamps, and the skipped flag. Names and emails go through the
    // person + merge, not the queue.
    const sets = src.match(/\.set\(\{([^}]*)\}/g) ?? [];
    expect(sets.length).toBeGreaterThan(0);
    for (const s of sets) {
      expect(s).not.toMatch(/firstName|lastName|email:/);
    }
  });
});
