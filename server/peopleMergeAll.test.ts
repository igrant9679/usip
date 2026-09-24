/**
 * "Merge all shown" on Data Health (owner ask 2026-09-24): one confirmed
 * click for every duplicate-People cluster on screen. The merge itself is
 * unchanged; what matters is WHAT the button sends. It must echo each
 * cluster's survivor and loser ids exactly as rendered, never a bare key,
 * because executePersonMerge refuses a cluster whose rows no longer match
 * the ids the human approved; a key alone would let the server re-resolve
 * who dies.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const page = readFileSync("client/src/pages/usip/DataHealth.tsx", "utf8");
const section = page.slice(page.indexOf("function PeopleMergeSection("), page.indexOf("<Dialog open={open !== null}"));

describe("Merge all shown", () => {
  it("sends every rendered cluster with its survivor and loser ids", () => {
    expect(section).toContain('merge.mutate({ by: "linkedin", clusters: clusters.map((c) => ({ key: c.key, survivorId: c.survivorId, loserIds: c.loserIds })) });');
    expect(section).toContain("merge.mutate({ clusters: withEmail.map((c) => ({ email: c.email!, survivorId: c.survivorId, loserIds: c.loserIds })) });");
  });

  it("goes through a confirmation that names the count and every dropped address", () => {
    expect(section).toContain("<ConfirmButton");
    expect(section).toContain("onConfirm={mergeAll}");
    expect(section).toContain("title={`Merge all ${clusters.length} and delete ${allDeleted} People row");
    expect(section).toContain("${allDropped.join(\", \")}");
  });

  it("is not offered when the server would refuse, or for a single cluster", () => {
    expect(section).toContain("{clusters.length > 1 && !plan.data?.proposalsCapped && (");
  });

  it("the server still requires explicit clusters: there is no merge-everything call", () => {
    const router = readFileSync("server/routers/dataHealth.ts", "utf8");
    expect(router).toContain("loserIds: z.array(z.number().int().positive()).min(1).max(50),");
    expect(router).toMatch(/\}\)\.refine\(\(c\) => !!\(c\.email \|\| c\.key\)[\s\S]{0,120}\.min\(1\)\.max\(50\)/);
  });
});
