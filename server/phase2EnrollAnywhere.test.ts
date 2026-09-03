/**
 * Phase 2 of the seams audit (owner: "Start phase 2", 2026-09-02):
 * enroll from anywhere. Before: the only way into an ARE campaign was a
 * button inside that campaign's page, accepting People rows only; sequences
 * were reachable from People but not Companies, Lists or Leads; the two
 * engines never checked each other; and nothing showed, from a person's
 * row, that they were in outreach at all.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (...p: string[]) => readFileSync(join(__dirname, ...p), "utf8");
const client = (...p: string[]) => read("..", "client", "src", ...p);

describe("one shared Add-to action, on every person surface", () => {
  const menu = client("components", "usip", "AddToMenu.tsx");

  it("names the choice the user is making: Campaign (per-person AI copy) vs Sequence (one fixed message)", () => {
    expect(menu).toContain("The engine writes every email for each person");
    expect(menu).toContain("One fixed message per step, the same to everyone");
    expect(menu).toContain("trpc.are.prospects.pushExisting.useMutation");
    expect(menu).toContain("trpc.sequences.bulkEnroll.useMutation");
  });

  it("is mounted on People (row, bulk bar, drawer), Company profile, Lists, Leads, and both detail pages", () => {
    const mounts: Array<[string, string[]]> = [
      ["People row", ["components", "usip", "people", "peopleShared.tsx"]],
      ["People bulk bar", ["components", "usip", "people", "SelectionToolbar.tsx"]],
      ["People drawer", ["pages", "usip", "People.tsx"]],
      ["Company profile", ["pages", "usip", "CompanyProfile.tsx"]],
      ["List detail", ["pages", "usip", "ListDetail.tsx"]],
      ["Leads list", ["pages", "usip", "Leads.tsx"]],
      ["Lead detail", ["pages", "usip", "LeadDetail.tsx"]],
      ["Prospect detail", ["pages", "usip", "ProspectDetail.tsx"]],
    ];
    for (const [label, segs] of mounts) {
      expect(client(...segs), label).toContain("<AddToMenu");
    }
    // Company profile and Leads pass NON-prospect ids — the point of the change.
    expect(client("pages", "usip", "CompanyProfile.tsx")).toContain("contactIds={(contacts ?? []).map(");
    expect(client("pages", "usip", "Leads.tsx")).toContain("leadIds={Array.from(selectedIds)}");
  });
});

describe("any person type can enter an ARE campaign", () => {
  const router = read("routers", "are", "prospects.ts");
  it("pushExisting accepts contacts and leads and resolves them to People rows", () => {
    const fn = router.slice(router.indexOf("pushExisting: workspaceProcedure"), router.indexOf("addManual: workspaceProcedure"));
    expect(fn).toContain("contactIds: z.array(z.number().int().positive()).max(100).default([])");
    expect(fn).toContain("leadIds: z.array(z.number().int().positive()).max(100).default([])");
    expect(fn).toContain("resolveToPeopleIds(ctx.workspace.id, input)");
  });
});

describe("the two engines check each other before a manual add", () => {
  const svc = read("services", "crossEngineEnrollment.ts");
  it("one module owns both directions", () => {
    expect(svc).toContain("export async function activeSequencesForProspects");
    expect(svc).toContain("export async function activeCampaignsForProspects");
    expect(svc).toContain("export async function resolveToPeopleIds");
  });
  it("a campaign push refuses someone a sequence is working", () => {
    // The check lives in the ONE write path (services/are/pushPeople.ts,
    // phase 3) that both the manual push and the router go through.
    const write = read("services", "are", "pushPeople.ts");
    expect(write).toContain("activeSequencesForProspects(workspaceId, people.map((p) => p.id))");
    expect(write).toContain("In an active sequence");
    expect(read("routers", "are", "prospects.ts")).toContain('await import("../../services/are/pushPeople")');
  });
  it("a sequence enroll refuses someone a campaign is working, and says so", () => {
    const seq = read("routers", "sequences.ts");
    const fn = seq.slice(seq.indexOf("bulkEnroll: repProcedure"), seq.indexOf("pauseEnrollment: repProcedure"));
    expect(fn).toContain("activeCampaignsForProspects(ctx.workspace.id, resolved.prospectIds)");
    expect(fn).toContain("skippedInCampaign,");
    expect(client("components", "usip", "AddToMenu.tsx")).toContain("a campaign is already working them");
  });
});

describe("the reverse links that were missing", () => {
  it("a person's row shows where they are (batched), linking to the campaign or sequence", () => {
    expect(read("routers", "prospects.ts")).toContain("enrollmentsFor: workspaceProcedure");
    expect(client("pages", "usip", "People.tsx")).toContain("trpc.prospects.enrollmentsFor.useQuery");
    const shared = client("components", "usip", "people", "peopleShared.tsx");
    expect(shared).toContain("<EnrollmentChip prospectId={p.id} map={ctx.enrollments} />");
    const menu = client("components", "usip", "AddToMenu.tsx");
    expect(menu).toContain("href={`/are/campaigns/${c.campaignId}`}");
    expect(menu).toContain("href={`/v2/sequences/${s.sequenceId}`}");
  });
  it("a reply opens its prospect and its campaign", () => {
    const conv = client("pages", "usip", "ConversationsV2.tsx");
    expect(conv).toContain("if (r.prospectId) return `/prospects/${r.prospectId}`;");
    expect(conv).toContain("href={`/are/campaigns/${reply.campaignId}`}");
  });
  it("a meeting opens the reply that booked it", () => {
    expect(read("routers", "meetings.ts")).toContain("sourceReplyId: sourceByMeeting.get(m.id) ?? null");
    expect(client("pages", "usip", "MeetingsV2.tsx")).toContain("the reply that booked this");
  });
});
