/**
 * The client halves of batch RESB (audit 2026-10-20), read from source block
 * by block as the repo's other screen pins do. The server halves are in
 * resbDiscoveryJob.test.ts and the other resb*.test.ts files.
 *
 *   P72  Find prospects and the campaign launcher follow a background run
 *   F38  the run's finds and the LinkedIn hits say who is already in People;
 *        a run can be kept for review and saved from its card
 *   F43  the LinkedIn card loads the next page
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8").replace(/\r\n/g, "\n");
/** The text from `start` up to (not including) `end`, failing loudly when either is missing. */
const block = (src: string, start: string, end: string) => {
  const i = src.indexOf(start);
  expect(i, `start anchor: ${start}`).toBeGreaterThan(-1);
  const j = src.indexOf(end, i + start.length);
  expect(j, `end anchor: ${end}`).toBeGreaterThan(-1);
  return src.slice(i, j);
};

const fp = read("client/src/pages/usip/FindProspects.tsx");
const camp = read("client/src/pages/usip/ARECampaignDetail.tsx");
const lib = read("client/src/lib/discoveryRun.ts");

describe("a discovery run is followed, not awaited (P72)", () => {
  it("Find prospects arms the run it started and summarises it when it ends", () => {
    const panel = block(fp, "export function FindProspectsPanel()", "const runSearch = () => {");
    expect(panel).toContain("const follow = useFollowRun(activeRunId, (run) => {");
    expect(panel).toContain("follow.arm(r.runId);");
    expect(panel).toContain("setActiveRunId(r.runId);");
    // The old in-request summary is gone from the mutation: a queued answer has no counts.
    const search = block(fp, "const search = trpc.discovery.search.useMutation({", "const runSearch = () => {");
    expect(search).not.toContain("r.rawFindCount");
  });

  it("the campaign launcher follows its run the same way, and stays busy while it runs", () => {
    const launcher = block(camp, "function CampaignDiscoveryLauncher(", "function LogsTab(");
    expect(launcher).toContain("useFollowRun(runId, (run) => {");
    expect(launcher).toContain("follow.arm(r.runId);");
    expect(launcher).toContain("runSummary(run)");
    expect(launcher).toContain("disabled={launch.isPending || running || !ready}");
    expect(launcher).not.toContain("r.rawFindCount");
  });

  it("useFollowRun polls only while running and fires once for an armed run", () => {
    const hook = block(lib, "export function useFollowRun(", "\n}\n");
    expect(hook).toContain('=== "running" ? 3000 : false');
    expect(hook).toContain("if (seenRunning.current === runId) {");
    expect(hook).toContain("arm: (id: number) => { seenRunning.current = id; }");
  });

  it("Re-enrich on the person page names the run it started", () => {
    const pd = read("client/src/pages/usip/ProspectDetail.tsx");
    const re = block(pd, "const reEnrich = trpc.prospects.reEnrich.useMutation({", "onError:");
    expect(re).toContain("r.runId");
    expect(re).not.toContain("r.rawFindCount");
  });
});

describe("already in People, before saving (F38)", () => {
  it("each raw find of a run carries its label, and the run counts them", () => {
    const detail = block(fp, "function RunDetail(", "function RecentRuns(");
    expect(detail).toContain("<KnownBadge knownAs={f.knownAs} prospectId={f.knownProspectId} />");
    expect(detail).toContain("already in People");
  });

  it("a run kept for review is saved from its card through reprocess, after a confirmation", () => {
    const detail = block(fp, "function RunDetail(", "function RecentRuns(");
    const held = block(detail, "{held ? (", ") : run.status !== \"running\" && (");
    expect(held).toContain("title: `Save run #${run.id} to People?`");
    expect(held).toContain("reprocess.mutate({ runId })");
    // The option is on the search form and reaches the server.
    expect(fp).toContain("search.mutate({ mode: \"person\", input: { ...i, keywords: i.keywords.length ? i.keywords : undefined }, sources: runSources, holdForReview });");
    expect(fp).toContain("search.mutate({ mode: \"account\", input: { ...i, keywords: i.keywords.length ? i.keywords : undefined }, sources: runSources, holdForReview });");
    expect(fp).toContain("Review before saving");
  });

  it("the LinkedIn card checks its hits with the shared check and leaves those already in People unticked", () => {
    const card = block(fp, "function LinkedInSearchCard()", "/* ─── Main panel");
    expect(card).toContain("utils.discovery.checkInPeople.fetch({ records: items.map(hitIdentity) })");
    expect(card).toContain('if (k.status === "in_people") next[offset + i] = false;');
    expect(card).toContain("<KnownBadge knownAs={known[i]?.status} prospectId={known[i]?.prospectId} />");
  });
});

describe("LinkedIn result paging (F43)", () => {
  it("Load the next 10 sends the cursor of the page before and appends", () => {
    const card = block(fp, "function LinkedInSearchCard()", "/* ─── Main panel");
    expect(card).toContain("more.mutate({ api: lastQuery.api, category: \"people\", keywords: lastQuery.keywords, filters: lastQuery.filters, limit: 10, cursor });");
    expect(card).toContain("setHits((prev) => [...prev, ...items]);");
    expect(card).toContain("{cursor && (");
  });
});
