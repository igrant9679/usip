/**
 * A public beacon may not name another tenant's contact.
 *
 * `/api/track` is unauthenticated by design — it is the first-party tracker
 * script's endpoint, with a CORS preflight and everything. It accepts a `vid`
 * parameter identifying the visitor as a known contact ("c123") or lead
 * ("l456"), and that value was inserted into `website_visits` WITHOUT checking
 * that the id belongs to the workspace being tracked.
 *
 * The read side then joined it by id ALONE:
 *
 *     .leftJoin(contacts, eq(contacts.id, websiteVisits.contactId))
 *
 * so the chain completed: anyone could POST `slug=<workspace>` with
 * `vid=c<id>` naming a contact in a DIFFERENT workspace, and
 * /v2/website-visitors would render that person's NAME and COMPANY to this
 * workspace. A high-intent path additionally spawned a follow-up task carrying
 * their record id.
 *
 * Fixed at both ends on purpose: the write now verifies the id against the
 * tracked workspace (dropping the attribution rather than rejecting the beacon —
 * a tracker that starts failing is worse than an anonymous page view), and the
 * read scopes both joins so rows ALREADY stored with a foreign id cannot
 * resolve to a name.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, sep } from "node:path";

const ROOT = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("the tracking beacon cannot claim a foreign identity", () => {
  const src = stripComments(read("server/websiteTracking.ts"));

  it("verifies the claimed vid against the tracked workspace before storing it", () => {
    expect(src).toMatch(/verifyVisitorIdentity\(/);
    // The raw parse result must not reach the insert directly.
    expect(src).not.toMatch(/const \{ contactId, leadId \} = parseVid\(/);
    const fn = src.slice(src.indexOf("async function verifyVisitorIdentity"), src.indexOf("function parseVid"));
    expect(fn.length).toBeGreaterThan(300); // floor: found the real function
    expect(fn).toMatch(/eq\(contacts\.workspaceId, workspaceId\)/);
    expect(fn).toMatch(/eq\(leads\.workspaceId, workspaceId\)/);
  });

  it("records the view anonymously rather than failing when the id is foreign", () => {
    // The beacon is fire-and-forget from a customer's website. Throwing here
    // would turn a tenancy check into an outage of the tracker.
    const fn = src.slice(src.indexOf("async function verifyVisitorIdentity"), src.indexOf("function parseVid"));
    expect(fn).toMatch(/catch/);
    expect(fn).not.toMatch(/throw/);
  });
});

describe("the visitors page cannot resolve a foreign record", () => {
  const src = stripComments(read("server/routers/websiteVisitors.ts"));

  it("scopes every join by workspace, not just the visit rows", () => {
    // Historical rows written before the beacon check exist and still carry
    // foreign ids; the read is what stops them becoming a name on screen.
    const joins = [...src.matchAll(/\.leftJoin\((\w+),\s*([\s\S]*?)\)\s*$/gm)].map((m) => `${m[1]}:${m[2]}`);
    expect(joins.length).toBeGreaterThan(0); // floor: the scan found the joins
    for (const j of joins) {
      expect(j, `join without a workspace term: ${j}`).toMatch(/workspaceId/);
    }
  });
});

/**
 * A repo-wide "unscoped leftJoin onto a name-bearing table" scan was written
 * here and then REMOVED, which is worth recording rather than silently
 * dropping.
 *
 * It found 18 such joins across 6 files. Every one sampled takes its id from a
 * row the same query already scoped — `opportunities.accountId`,
 * `reevalRuns.createdByUserId` — i.e. a column written by our own authenticated
 * code. The websiteVisits case is different in kind, not degree: its id column
 * is written by an UNAUTHENTICATED beacon, so the join was the second half of a
 * chain that started outside the trust boundary.
 *
 * Shipping the broad rule would have meant 18 entries in an allowlist on day
 * one, and a rule that flags eighteen correct call sites is a rule someone
 * switches off — the same judgement secretRandomness.test.ts already made about
 * Math.random(). The honest version of that check is "which id columns can a
 * public endpoint write?", which is a sweep, not a regex. It is logged as the
 * next lead in SESSION_STATUS with the count above.
 */
