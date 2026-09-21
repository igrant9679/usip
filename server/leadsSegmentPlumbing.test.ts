/**
 * The Leads page used to offer "Add to Campaign" and "Add to Segment", and both
 * handed LEAD ids to inputs keyed on CONTACTS:
 * `addMut.mutate({ segmentId, contactIds: leadIds })`.
 *
 * Two things reviewers get wrong about this, and the reason for the shape of
 * the assertions below:
 *
 * (a) It produced NO tsc error. `contactIds` and `leadIds` are both `number[]`,
 *     so the compiler had nothing to object to — which is why it survived in a
 *     shipped page. Only a check on the SHAPE of the call catches it, and that
 *     is test 1.
 *
 * (b) The server-side guards added alongside (2026-09-20) are NOT the fix and
 *     must not be read as one. A lead id that happens to collide with a contact
 *     id in the same workspace resolves fine and passes every one of them; the
 *     harm case is exactly the case they cannot see. Ids are bare numbers on
 *     both sides, so no server check can tell the two apart. The fix is that no
 *     surface passes lead ids any more. The guards catch stale and foreign ids,
 *     which is worth having, and nothing more.
 *
 * Leads reach outreach through AddToMenu → `are.prospects.pushExisting` /
 * `sequences.bulkEnroll`, which resolve a lead to its People row. That route is
 * pinned by phase2EnrollAnywhere.test.ts; this file does not duplicate it.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

describe("the Leads page has exactly one route into outreach", () => {
  const leads = read("client/src/pages/usip/Leads.tsx");

  it("keeps AddToMenu, fed lead ids as lead ids", () => {
    expect(leads).toContain("<AddToMenu");
    expect(leads).toContain("leadIds={Array.from(selectedIds)}");
  });

  it("never hands lead ids to a contact-keyed input again", () => {
    expect(leads, "lead ids are being passed under a contact-keyed input again")
      .not.toMatch(/contactIds:\s*leadIds/);
    expect(leads).not.toContain("trpc.campaigns.addAudience");
    expect(leads).not.toContain("trpc.segments.addContacts");
    expect(leads).not.toContain("AddToCampaignModal");
    expect(leads).not.toContain("AddToSegmentModal");
  });
});

describe("a segment says so when it cannot take what it was handed", () => {
  const seg = read("server/routers/segments.ts");
  const fn = seg.slice(
    seg.indexOf("addContacts: workspaceProcedure"),
    seg.indexOf("getContacts: workspaceProcedure"),
  );

  it("sliced the procedure it meant to", () => {
    expect(fn.length).toBeGreaterThan(400);
  });

  it("refuses an id that is not a contact in this workspace instead of dropping it", () => {
    expect(fn).toContain("rows.length !== input.contactIds.length");
    expect(fn).toContain("TRPCError");
    expect(fn).toContain("Segments are contact-keyed");
    // The guard has to run before the rule set is built, or the rules are
    // already written from a short row set by the time anyone complains.
    expect(fn.indexOf("rows.length !== input.contactIds.length")).toBeLessThan(fn.indexOf("manual-"));
  });

  it("refuses to collapse an ALL-match segment instead of silently destroying it", () => {
    // Membership rules are email-EQUALS. Appending one to a segment that
    // already has a rule, under the default matchType "all", made the segment
    // match nobody — and contactCount was overwritten with that number, so the
    // button reported success. See segments.ts addContacts.
    expect(fn).toContain('effectiveMatch === "all"');
    expect(fn).toContain("would make it match nobody");
  });
});

describe("a broadcast audience cannot be handed a lead id, and cannot silently drop a segment", () => {
  const ops = read("server/routers/operations.ts");
  const fn = ops.slice(ops.indexOf("addAudience: workspaceProcedure"));

  it("sliced the procedure it meant to", () => {
    expect(fn.length).toBeGreaterThan(300);
  });

  it("no longer accepts a lead-ids array beside contactIds", () => {
    expect(fn, "the lead-ids input is back on a contact-keyed audience").not.toContain("leadIds");
  });

  it("checks the ids are contacts in this workspace before merging them", () => {
    expect(fn).toContain("inArray(contacts.id, input.contactIds)");
    expect(fn.indexOf("inArray(contacts.id, input.contactIds)")).toBeLessThan(fn.indexOf("db.update(campaigns)"));
  });

  it("refuses rather than flipping a segment-audience broadcast to a contact list", () => {
    expect(fn).toContain('c.audienceType === "segment"');
  });
});

describe("Contacts keeps its legitimate use", () => {
  // The regression anchor: these two calls pass REAL contact ids and must keep
  // working. An over-eager sweep of "addAudience"/"addContacts" would take them
  // out with the leads ones.
  const contactsPage = read("client/src/pages/usip/Contacts.tsx");

  it("still adds contacts to campaigns and segments from the Contacts page", () => {
    expect(contactsPage).toContain("trpc.campaigns.addAudience.useMutation");
    expect(contactsPage).toContain("trpc.segments.addContacts.useMutation");
    expect(contactsPage).toContain("addMut.mutate({ campaignId: Number(campaignId), contactIds })");
  });
});
