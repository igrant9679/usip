/**
 * personLink — People-as-master guarantees:
 *
 *  - migration 0153 is declared in BOTH places (rawMigrations + drizzle);
 *  - a queue row qualifies for a person record only with a real person
 *    identity (name + at least one resolvable key);
 *  - conflicting stronger keys (email / LinkedIn slug) block name-based
 *    merging — the over-merge risk reconciled with the owner;
 *  - the ingest seam and the boot backfill are actually wired;
 *  - the backfill NEVER mutates queue person columns (emails a sequence
 *    already used stay byte-identical — owner risk-reconciliation).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NAME_TIER_CAP, hasPersonIdentity, keysConflict } from "./personLink";

const ROOT = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

describe("migration 0153 is declared in both places", () => {
  it("rawMigrations has the 0153 block", () => {
    const src = read("server/_core/rawMigrations.ts");
    expect(src).toContain("0153_person_link_and_catch_all_email.sql");
    expect(src).toMatch(/ALTER TABLE `prospects` ADD COLUMN `catch_all_email` varchar\(320\) NULL/);
    expect(src).toMatch(/ALTER TABLE `prospect_queue` ADD COLUMN `person_prospect_id` int NULL/);
    expect(src).toMatch(/CREATE INDEX `ix_pq_person` ON `prospect_queue`/);
  });
  it("drizzle/schema.ts declares both columns", () => {
    const src = read("drizzle/schema.ts");
    expect(src).toMatch(/catchAllEmail: varchar\("catch_all_email", \{ length: 320 \}\)/);
    expect(src).toMatch(/personProspectId: int\("person_prospect_id"\)/);
  });
});

describe("hasPersonIdentity — no person record without a person", () => {
  it("requires a name", () => {
    expect(hasPersonIdentity({ firstName: null, lastName: null, email: "a@b.com" })).toBe(false);
  });
  it("name + email / linkedin / full-name+company qualify", () => {
    expect(hasPersonIdentity({ firstName: "Jane", lastName: null, email: "jane@acme.com" })).toBe(true);
    expect(hasPersonIdentity({ firstName: "Jane", lastName: "Doe", linkedinUrl: "https://linkedin.com/in/jane" })).toBe(true);
    expect(hasPersonIdentity({ firstName: "Jane", lastName: "Doe", companyName: "Acme" })).toBe(true);
  });
  it("a bare name with no key does NOT qualify", () => {
    expect(hasPersonIdentity({ firstName: "Jane", lastName: "Doe" })).toBe(false);
    // Company alone isn't enough without BOTH name parts.
    expect(hasPersonIdentity({ firstName: "Jane", lastName: null, companyName: "Acme" })).toBe(false);
  });
});

describe("keysConflict — stronger keys block weaker-tier merging", () => {
  const person = { email: "jane@acme.com", linkedinUrl: "https://www.linkedin.com/in/jane-doe/" };
  it("different emails conflict; same or missing do not", () => {
    expect(keysConflict({ email: "other@acme.com" }, person)).toBe(true);
    expect(keysConflict({ email: "JANE@ACME.COM" }, person)).toBe(false);
    expect(keysConflict({ email: null }, person)).toBe(false);
  });
  it("different LinkedIn slugs conflict; URL noise does not", () => {
    expect(keysConflict({ linkedinUrl: "https://linkedin.com/in/someone-else" }, person)).toBe(true);
    expect(keysConflict({ linkedinUrl: "http://linkedin.com/in/jane-doe" }, person)).toBe(false);
  });
  it("a person with neither key can never conflict", () => {
    expect(keysConflict({ email: "x@y.com", linkedinUrl: "https://linkedin.com/in/x" }, { email: null, linkedinUrl: null })).toBe(false);
  });
});

describe("the flow is wired (structural)", () => {
  it("queue ingest fires the linker after insert", () => {
    const src = read("server/routers/are/scraper.ts");
    const anchor = src.indexOf("linkUnlinkedQueueRows");
    expect(anchor).toBeGreaterThan(-1);
    // Inside saveScrapeJobAndQueue, after the insert fallback block.
    expect(src.indexOf("saveScrapeJobAndQueue")).toBeLessThan(anchor);
  });
  it("the boot backfill cron is registered", () => {
    const src = read("server/_core/index.ts");
    const anchor = src.indexOf("runPersonLinkBackfill");
    expect(anchor).toBeGreaterThan(-1);
    expect(src.slice(anchor)).toContain("setInterval(runPersonLinkBackfill, 24 * 60 * 60 * 1000)");
  });
  it("the ARE enrich agent contributes its findings to the person", () => {
    const src = read("server/routers/are/prospects.ts");
    expect(src).toContain("mergeIntoPerson(workspaceId, prospect.personProspectId!");
  });
  it("linkUnlinkedQueueRows only ever writes the link column to the queue", () => {
    // The backfill promise: person columns on the queue are never mutated.
    // Bounded to the FUNCTION, not end-of-file — the 0160 contact section
    // below it legitimately writes other link columns.
    const src = read("server/services/personLink.ts");
    const start = src.indexOf("export async function linkUnlinkedQueueRows");
    const end = src.indexOf("CRM contacts → People", start);
    expect(end, "contact section marker moved — re-anchor").toBeGreaterThan(start);
    const fn = src.slice(start, end);
    const sets = fn.match(/\.set\(([^)]*)\)/g) ?? [];
    expect(sets.length).toBeGreaterThan(0);
    for (const s of sets) expect(s).toContain("personProspectId");
    for (const s of sets) {
      expect(s).not.toMatch(/email|firstName|lastName|companyName|phone|title/);
    }
  });
});

describe("the name tiers cannot be truncated into a false 'only match'", () => {
  // These tiers answer "is this the ONLY candidate?" — a verdict that is
  // meaningless over a truncated set. The read used to be a bare LIMIT 25
  // with no ORDER BY, so a name held by more people than that produced an
  // arbitrary window, and a single survivor inside that window was returned
  // as a CONFIDENT link (tier name_domain / name_company).
  //
  // Anchored to the function, not the file: an earlier test in this repo
  // silently widened its own scope by slicing to the end of an array.
  const src = read("server/services/personLink.ts");
  const start = src.indexOf("export async function findPersonForRow");
  const end = src.indexOf("function candidatesFromRow", start);
  const fn = src.slice(start, end);

  it("the function boundary is where we think it is", () => {
    expect(start, "findPersonForRow moved — re-anchor").toBeGreaterThan(-1);
    expect(end, "candidatesFromRow marker moved — re-anchor").toBeGreaterThan(start);
  });

  it("reads one row PAST the cap, so truncation is detectable", () => {
    // A read of exactly the cap cannot distinguish "25 of them" from
    // "25 of the 30 of them".
    expect(fn).toContain("limit(NAME_TIER_CAP + 1)");
  });

  it("refuses instead of deciding when the cap is exceeded", () => {
    expect(fn).toMatch(
      /if \(named\.length > NAME_TIER_CAP\) return \{ person: null, tier: "ambiguous" \}/,
    );
  });

  it("orders the window so the same row resolves the same way twice", () => {
    expect(fn).toContain(".orderBy(prospects.id)");
  });

  it("the cap is one shared constant, not a literal at the call site", () => {
    // If someone re-inlines `25`, the coupling between the read width and the
    // refuse-branch breaks silently and the bug returns.
    expect(NAME_TIER_CAP).toBe(25);
    expect(fn).not.toMatch(/\.limit\(\s*2[05]\s*\)/);
  });
});
