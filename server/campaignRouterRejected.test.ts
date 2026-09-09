/**
 * The router must not re-suggest a person for a campaign they already have a
 * queue row in — any status. 2026-09-09: all 43 accepted suggestions in
 * CommunityForce were skipped as duplicates because the people were already
 * `skipped` (rejected) rows in the very campaigns suggested.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const src = readFileSync(new URL("./services/campaignRouter.ts", import.meta.url), "utf8");

describe("campaign router excludes campaigns the person was ever in", () => {
  it("looks up memberships with statuses: null (every status) and scores only campaigns not yet tried", () => {
    expect(src).toContain("activeCampaignsForProspects(workspaceId, people.map((p) => p.id), { statuses: null })");
    expect(src).toContain("const tried = new Set((everSeen.get(p.id) ?? []).map((h) => h.campaignId));");
    expect(src).toContain("const eligible = campaigns.filter((c) => !tried.has(c.id));");
    expect(src).toContain("skipReason: \"Already tried in every campaign that fits");
    expect(src).toContain("const scores: CandidateScore[] = eligible.map(");
  });
});
