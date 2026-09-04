/**
 * The "Add existing" wizard on a Revenue Engine campaign (owner ask
 * 2026-09-03: bulk select, a table view, duplicate verification, and whether
 * and where each person already sits in other campaigns or sequences).
 *
 * The invariant worth pinning is not the UI — it is that the wizard's VERIFY
 * step and the push it precedes cannot disagree. Both go through ONE pure
 * classifier (classifyPushCandidate) over the same identity index and the
 * same active-sequence lookup; the preview adds duplicate grouping and
 * membership history on top. The classifier and the grouping are tested as
 * imported functions (real behaviour); the wiring is pinned as text so a
 * refactor that gives the preview its own copy of the rules fails here.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { classifyPushCandidate } from "./services/are/pushPeople";
import { groupSelectionByIdentity } from "./services/are/addExistingPreview";

const read = (...p: string[]) => readFileSync(join(__dirname, ...p), "utf8");
const client = (...p: string[]) => read("..", "client", "src", ...p);

type Index = Map<string, { rowId: number; campaignId: number | null }>;
const idx = (entries: Array<[string, { rowId: number; campaignId: number | null }]>): Index => new Map(entries);

describe("classifyPushCandidate — the one verdict the push and the preview share", () => {
  const jo = { email: "jo@acme.com", firstName: "Jo", lastName: "Bloggs", companyName: "Acme", companyDomain: "acme.com" };

  it("admits an identifiable, unclaimed person no sequence is working", () => {
    expect(classifyPushCandidate(jo, 7, idx([]), undefined)).toEqual({ kind: "ready", reason: null });
  });

  it("an active sequence wins over everything else, and names the sequence", () => {
    const v = classifyPushCandidate(jo, 7, idx([["e:jo@acme.com", { rowId: 1, campaignId: 7 }]]), [
      { sequenceId: 3, sequenceName: "Q4 nurture", status: "active", currentStep: 1 },
    ]);
    expect(v.kind).toBe("active_sequence");
    expect(v.reason).toContain('"Q4 nurture"');
    expect(v.reason).toContain("two engines");
  });

  it("refuses a person with no identity key before consulting the index", () => {
    const v = classifyPushCandidate({ firstName: "Jo", lastName: "Bloggs" }, 7, idx([["n:jo bloggs@acme com", { rowId: 1, campaignId: 7 }]]), undefined);
    expect(v.kind).toBe("unidentifiable");
    expect(v.reason).toBe("No email, LinkedIn URL, or name + company to identify them by");
  });

  it("names THIS campaign when the identity is already here", () => {
    const v = classifyPushCandidate(jo, 7, idx([["e:jo@acme.com", { rowId: 41, campaignId: 7 }]]), undefined);
    expect(v).toEqual({ kind: "already_here", reason: "Already in this campaign", rowId: 41 });
  });

  it("names the OTHER campaign holding the identity — exclusivity is workspace-wide", () => {
    const v = classifyPushCandidate(jo, 7, idx([["e:jo@acme.com", { rowId: 41, campaignId: 19 }]]), undefined);
    expect(v.kind).toBe("other_campaign");
    expect(v.reason).toContain("(id 19)");
    expect(v.reason).toContain("a prospect can only be in one at a time");
    if (v.kind === "other_campaign") expect(v.campaignId).toBe(19);
  });

  it("any ONE key claims the person — LinkedIn slug, not just email", () => {
    const shape = { email: "new@acme.com", linkedinUrl: "https://www.linkedin.com/in/jo-bloggs/" };
    const v = classifyPushCandidate(shape, 7, idx([["u:jo-bloggs", { rowId: 5, campaignId: 20 }]]), undefined);
    expect(v.kind).toBe("other_campaign");
  });
});

describe("groupSelectionByIdentity — one human picked twice", () => {
  it("maps every member of a group to the LOWEST id in it (the index's own tie-break)", () => {
    const g = groupSelectionByIdentity([
      { prospectId: 30, keys: ["e:a@x.com"] },
      { prospectId: 10, keys: ["e:a@x.com", "u:aaa"] },
      { prospectId: 20, keys: ["u:bbb"] },
    ]);
    expect(g.get(10)).toBe(10);
    expect(g.get(30)).toBe(10);
    expect(g.get(20)).toBe(20);
  });

  it("groups transitively: A shares email with B, B shares LinkedIn with C → one person", () => {
    const g = groupSelectionByIdentity([
      { prospectId: 1, keys: ["e:a@x.com"] },
      { prospectId: 2, keys: ["e:a@x.com", "u:slug"] },
      { prospectId: 3, keys: ["u:slug"] },
    ]);
    expect([g.get(1), g.get(2), g.get(3)]).toEqual([1, 1, 1]);
  });

  it("a person with no keys is their own group and never absorbs anyone", () => {
    const g = groupSelectionByIdentity([{ prospectId: 5, keys: [] }, { prospectId: 6, keys: [] }]);
    expect(g.get(5)).toBe(5);
    expect(g.get(6)).toBe(6);
  });

  it("does not depend on input order", () => {
    const a = groupSelectionByIdentity([{ prospectId: 9, keys: ["k"] }, { prospectId: 4, keys: ["k"] }]);
    const b = groupSelectionByIdentity([{ prospectId: 4, keys: ["k"] }, { prospectId: 9, keys: ["k"] }]);
    expect(Array.from(a.entries()).sort()).toEqual(Array.from(b.entries()).sort());
  });
});

describe("the preview rehearses the push with the push's own inputs", () => {
  const preview = read("services", "are", "addExistingPreview.ts");
  const write = read("services", "are", "pushPeople.ts");

  it("the push enriches SERIALLY: one background chain per push, one person at a time", () => {
    // 2026-09-04: one task per person fired 32 enrichments at once, tripped
    // the per-user LLM burst limit, and seven people failed their first
    // enrichment. The chain is still off the request path, still enrich
    // before sequence, and a failure for one person does not stop the rest.
    // lastIndexOf: the early no-db return uses the same literal above the chain.
    const tail = write.slice(write.indexOf("// Enrich → sequence, in that order"), write.lastIndexOf("return { added, skipped };"));
    expect(tail.length).toBeGreaterThan(200);
    expect(tail).toContain("if (added.length > 0) {");
    expect(tail).toContain("void (async () => {\n      for (const a of added) {\n        try {\n          await runEnrichAgent(a.queueId, workspaceId);");
    expect(tail).toContain("} catch (e) {\n          console.error(`[pushPeopleIntoCampaign] queue ${a.queueId}:`");
    // No per-person task: exactly ONE `void (async` in the tail.
    expect(tail.split("void (async").length - 1).toBe(1);
  });

  it("the write path decides through the classifier — not an inline copy of the rules", () => {
    expect(write).toContain("const verdict = classifyPushCandidate(shape, campaignId, index, inSequence.get(p.id));");
    expect(write).toContain('if (verdict.kind !== "ready") {');
  });

  it("the preview calls the SAME classifier over the SAME index and active lookup", () => {
    expect(preview).toContain("classifyPushCandidate(s.shape, campaign.id, index, activeSeq.get(s.p.id))");
    expect(preview).toContain("workspaceQueueIdentityIndex(workspaceId)");
    expect(preview).toContain("activeSequencesForProspects(workspaceId, peopleIds)");
    // And the identity shape is built by the write path's own helper.
    expect(preview).toContain("identityShapeOfPerson(p)");
    expect(write).toContain("const shape = identityShapeOfPerson(p);");
  });

  it("membership HISTORY comes from the cross-engine module with statuses: null, not a second query", () => {
    const svc = read("services", "crossEngineEnrollment.ts");
    expect(svc).toContain("export interface MembershipOpts { statuses?: readonly string[] | null }");
    expect(svc).toContain("statuses === null ? undefined : inArray(col, [...statuses] as any)");
    expect(svc).toContain("export const sequenceMembershipsForProspects");
    expect(svc).toContain("export const campaignMembershipsForProspects");
    expect(preview).toContain("sequenceMembershipsForProspects(workspaceId, peopleIds)");
    expect(preview).toContain("campaignMembershipsForProspects(workspaceId, peopleIds)");
    // The default stays the ACTIVE gate the write paths rely on.
    expect(svc).toContain("opts.statuses === undefined ? ACTIVE_ENROLLMENT_STATUSES : opts.statuses");
    expect(svc).toContain("opts.statuses === undefined ? ACTIVE_QUEUE_STATUSES : opts.statuses");
  });

  it("a ready person who is the same human as an earlier pick is marked duplicate, not pushed twice", () => {
    expect(preview).toContain('v.kind === "ready" && dupOf ? "duplicate" : v.kind');
  });

  it("CRM duplicates are exact email / LinkedIn matches, workspace-scoped, outside the selection", () => {
    expect(preview).toContain("notInArray(prospects.id, peopleIds)");
    expect(preview).toContain("inArray(sql`LOWER(${prospects.email})`, emails)");
    expect(preview).toContain("inArray(sql`LOWER(${prospects.linkedinUrl})`, urls)");
    expect(preview).toContain("eq(prospects.workspaceId, workspaceId)");
  });
});

describe("the procedure and the wizard are wired", () => {
  const router = read("routers", "are", "prospects.ts");
  const dialog = client("components", "usip", "are", "AddExistingProspectsDialog.tsx");
  const page = client("pages", "usip", "ARECampaignDetail.tsx");

  it("pushExistingPreview is a workspace-scoped QUERY that hands off to the service", () => {
    const proc = router.slice(router.indexOf("pushExistingPreview: workspaceProcedure"), router.indexOf("addManual: workspaceProcedure"));
    expect(proc).toContain(".query(async ({ ctx, input }) => {");
    expect(proc).toContain("eq(areCampaigns.workspaceId, ctx.workspace.id)");
    expect(proc).toContain("previewAddExisting(ctx.workspace.id, campaign, input.prospectIds)");
    expect(proc).not.toContain("db.insert(");
  });

  it("the wizard verifies through the preview and adds through the one write procedure", () => {
    expect(dialog).toContain("trpc.are.prospects.pushExistingPreview.useQuery");
    expect(dialog).toContain("trpc.are.prospects.pushExisting.useMutation");
    // Only rows the rehearsal marked ready can be sent.
    expect(dialog).toContain('previewRows.filter((r) => r.verdict === "ready")');
    expect(dialog).toContain("const ids = toAdd.map((r) => r.prospectId);");
  });

  it("bulk select is a table with select-all-on-page, a cap matching the preview's input limit, and a saved-list source", () => {
    expect(dialog).toContain("<Table>");
    expect(dialog).toContain("toggleAllOnPage");
    expect(dialog).toContain("const MAX_SELECTION = 200;");
    expect(router).toContain("prospectIds: z.array(z.number().int().positive()).min(1).max(200),");
    expect(dialog).toContain("trpc.recordLists.members.useQuery");
    // Runs above the push's per-call cap go in batches rather than failing.
    expect(dialog).toContain("const PUSH_BATCH = 100;");
    expect(dialog).toContain("ids.slice(i, i + PUSH_BATCH)");
  });

  it("step 1 shows where each visible person already is, from the batched map the People page uses", () => {
    expect(dialog).toContain("trpc.prospects.enrollmentsFor.useQuery");
    expect(dialog).toContain("<EnrollmentChip prospectId={p.id} map={props.enrollmentMap} />");
  });

  it("step 2 renders memberships (active and past), duplicates and every skip reason — nothing is swallowed", () => {
    expect(dialog).toContain("function WhereCell");
    expect(dialog).toContain("function DuplicatesCell");
    expect(dialog).toContain("row.campaigns.map((c) =>");
    expect(dialog).toContain("row.sequences.map((s) =>");
    expect(dialog).toContain("row.crmDuplicates.map((d) =>");
    expect(dialog).toContain("skipped.length > 0");
    expect(dialog).toContain("{s.reason}");
  });

  it("the campaign page mounts it with the campaign's name", () => {
    expect(page).toContain("<AddExistingProspectsDialog");
    expect(page).toContain("campaignName={campaign.name}");
  });
});
