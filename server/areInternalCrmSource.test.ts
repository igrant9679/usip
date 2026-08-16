/**
 * The ARE `internal` discovery source must not spend its page on rows that
 * get thrown away.
 *
 * Found by a sweep for the 320072b shape. discoverViaInternalCrm asked for 50
 * title-matching contacts with no ORDER BY, then dropped the un-actionable
 * ones (no email AND no company) in the loop — the code's own comment records
 * 1,500+ such rows in this workspace. A second discard sits even further
 * downstream: queueIdentity claims already-queued people, so those rows spend
 * a slot too and the loop cannot even see it happen. Between them the source
 * could return a full page and contribute nothing, every tick, permanently,
 * because an unordered page returns the same rows next time.
 *
 * Source assertions: the function needs a live DB. Mutation-checked against
 * the pre-fix source.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(join(__dirname, "areEngine.ts"), "utf8");

const start = src.indexOf("async function discoverViaInternalCrm");
const end = src.indexOf("async function discoverViaLinkedIn", start);
// No end-of-file fallback: a missing anchor must fail the boundary test rather
// than widening every assertion below to the whole 2,000-line engine.
const fn = src.slice(start, end);

describe("discoverViaInternalCrm filters before the limit, not after", () => {
  it("the function boundary is where we think it is", () => {
    expect(start, "discoverViaInternalCrm moved — re-anchor").toBeGreaterThan(-1);
    expect(end, "discoverViaLinkedIn moved — re-anchor").toBeGreaterThan(start);
  });

  it("actionability is a SQL predicate", () => {
    // Mirrors `!c.email && !c.companyDomain && !c.companyName` — and the empty
    // string matters, because that is what the loop treats as absent.
    expect(fn).toContain('ne(contacts.email, "")');
    expect(fn).toContain('ne(contacts.companyDomain, "")');
    expect(fn).toContain('ne(contacts.companyName, "")');
  });

  it("already-queued contacts are excluded in SQL", () => {
    expect(fn).toContain("notExists(");
    expect(fn).toMatch(/eq\(prospectQueue\.email,\s*contacts\.email\)/);
    // Contacts with no email must survive that exclusion rather than being
    // swept out by a NULL comparison.
    expect(fn).toContain("isNull(contacts.email)");
  });

  it("both pages are ordered", () => {
    expect(fn).toContain("orderBy(desc(contacts.id))");
    expect(fn).toContain("orderBy(desc(leads.id))");
  });

  it("every limit in here is preceded by an order", () => {
    // Cheap structural check: no `.limit(` may appear without an `.orderBy(`
    // earlier in the same chain.
    const chains = fn.split(/await db\b/).slice(1);
    const withLimit = chains.filter((c) => c.includes(".limit("));
    expect(withLimit.length).toBeGreaterThanOrEqual(2);
    for (const c of withLimit) {
      const upToLimit = c.slice(0, c.indexOf(".limit("));
      expect(upToLimit).toContain(".orderBy(");
    }
  });
});
