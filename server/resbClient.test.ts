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

describe("spend is said before it happens (F8, U16)", () => {
  it("the launchers show each source's allowance left today before running (U16)", () => {
    const panel = block(fp, "export function FindProspectsPanel()", "{/* ── LinkedIn / Sales Navigator search ── */}");
    expect(panel).toContain("<SourceBudgetLine sources={runSources} />");
    const launcher = block(camp, "function CampaignDiscoveryLauncher(", "function LogsTab(");
    expect(launcher).toContain('<SourceBudgetLine sources={["linkedin", "news", "apollo", "quickenrich"]} />');
    // The same four the launcher's discovery fans out to (pinned to the service elsewhere).
    const sp = read("client/src/components/usip/SpendPreview.tsx");
    expect(sp).toContain("trpc.spend.budgets.useQuery(");
    expect(sp).toContain("launcherBudgetLine(sources, q.data)");
  });

  it("Verify on the person page and in the contact drawer asks first, with the credit and today's allowance", () => {
    const pd = read("client/src/pages/usip/ProspectDetail.tsx");
    expect(pd).toContain('onClick={() => confirmPaidLookup({ title: `Verify ${p.email}?`, vendor: "Reoon", count: 1, unit: "daily credit"');
    expect(pd).not.toContain("onClick={() => verify.mutate({ prospectId: id })}");
    const rd = read("client/src/components/usip/RecordDrawer.tsx");
    const onVerify = block(rd, "onVerify={() => {", "/>");
    expect(onVerify).not.toContain("                  verifySingle.mutate({ contactId: relatedId });");
    expect(rd).toContain('confirmPaidLookup({ title: `Verify ${contactData.data.email}?`, vendor: "Reoon", count: 1, unit: "daily credit"');
    expect(rd).toContain("() => verifySingle.mutate({ contactId: relatedId }));");
  });

  it("every LinkedIn enrich asks first; Enrich fully's own LinkedIn follow-up is already in its count", () => {
    const li = read("client/src/components/usip/people/LinkedInEnrichment.tsx");
    const ret = block(li, "  const askThen = (count: number | null, go: () => void) => {", "/** Compact enrich action");
    expect(ret).toContain('opts.confirmed ? runMut.mutate({ prospectIds, triggerType }) : askThen(prospectIds.length, () => runMut.mutate({ prospectIds, triggerType }))');
    expect(ret).toContain("askThen(opts.enrichAll ? null : (opts.prospectIds?.length ?? null), () => runListMut.mutate({ listId, ...opts }))");
    expect(ret).toContain('unit: "profile lookup"');
    // 2026-11-07 (CRMP, R66): Enrich fully is a server job now, and the job
    // itself queues the one LinkedIn follow-up when it ends, for the people
    // still without a profile; that lookup is already in the confirmation's
    // count (enrichFullyText counts one LinkedIn lookup a person).
    const svc = read("server/services/bulkByFilter.ts");
    expect(svc).toContain('await caller.linkedinEnrichment.run({ prospectIds: need.slice(i, i + 500), triggerType: "people_bulk_action" });');
  });

  it("Enrich fully, in bulk and in the drawer, states the most it can spend and asks", () => {
    const st = read("client/src/components/usip/people/SelectionToolbar.tsx");
    // 2026-11-07 (CRMP, F30/R66): the count is the selection or all matching
    // (n), and the confirmation also says it runs on the server; Confirm
    // still starts it, and only Confirm.
    const item = block(st, "<DropdownMenuItem disabled={busy || n > 5000} onClick={() => confirmAction({", "\"Enrich fully (all sources)\"}</DropdownMenuItem>");
    // 2026-11-08 (audit U5): the spend is a typed `cost` the confirm words
    // through enrichFullyText, with the count beside it.
    expect(item).toContain("cost: { kind: \"enrichFully\", people: n, budgets: budgets.data },");
    expect(item).toContain("count: { n, one: \"person\", many: \"people\" },");
    expect(item).toContain("}, startFull)}");
    expect(st).not.toContain("onClick={startFull}");
    const people = read("client/src/pages/usip/People.tsx");
    // 2026-11-08 (audit U5): the same sentence, as a typed cost.
    expect(people).toContain("cost: { kind: \"enrichFully\", people: 1, budgets: enrichBudgets.data }, confirmLabel: \"Spend and enrich\" }, () => enrichFull.mutate({ prospectId: p.id }))");
    expect(people).not.toContain("onClick={() => enrichFull.mutate({ prospectId: p.id })}");
  });

  it("ICP inference (Infer) says it is one AI call, with the month's budget, and asks", () => {
    const icp = read("client/src/pages/usip/AREIcpAgent.tsx");
    expect(icp).toContain('description: aiCallText(1, icpBudgets.data?.ai, "over up to 200 won and 100 lost deals")');
    expect(icp).not.toContain("onClick={() => regenerate.mutate()}");
    expect(icp.match(/onClick=\{askRegenerate\}/g)).toHaveLength(2);
  });

  it("Run now on re-verify reads the run's own plan, then states count and credits", () => {
    const st = read("client/src/pages/usip/Settings.tsx");
    const ask = block(st, "const askReverifyNow = async () => {", "const [blockInvalid, setBlockInvalid]");
    expect(ask).toContain("await utils.emailVerification.reverifyPreview.fetch()");
    expect(ask).toContain('unit: "bulk credit"');
    expect(ask).toContain("() => triggerNowMut.mutate()");
    expect(st).toContain("onClick={askReverifyNow}");
    expect(st).not.toContain("onClick={() => triggerNowMut.mutate()}");
  });

  it("Link all unlinked says it spends nothing", () => {
    expect(read("client/src/pages/usip/DataHealth.tsx")).toContain("It reads only what Velocity holds and spends no credits.");
  });

  it("a research run shows its estimate and takes a ceiling", () => {
    const rr = read("client/src/components/usip/research/ResearchRuns.tsx");
    const dlg = block(rr, "export function StartRunDialog(", "/** The workspace's recent runs");
    expect(dlg).toContain("trpc.research.runs.estimate.useQuery(undefined, { enabled: open })");
    expect(dlg).toContain("costCeilingUsd: ceilingUsd,");
    expect(dlg).toContain("Estimated cost: about");
    expect(dlg).toContain('<Label htmlFor="run-ceiling">Stop at (USD)</Label>');
  });

  it("Billing has a monthly spend card above the per-day report", () => {
    const sr = read("client/src/components/usip/SpendReport.tsx");
    expect(sr).toContain("const q = trpc.spend.month.useQuery();");
    const section = block(sr, "export function SpendSection() {", "function SharedKeyCell(");
    expect(section).toContain("<MonthSpendCard />");
  });
});

describe("verify People from the screen (F39) and the credits card (F10)", () => {
  it("People's toolbar verifies a selection through the bulk procedure, after the cost confirmation, and follows the job", () => {
    const st = read("client/src/components/usip/people/SelectionToolbar.tsx");
    const menu = block(st, "function EnrichMenu(", "function MoreMenu(");
    const ask = block(menu, "const askVerify = () => confirmPaidLookup({", "const verifying =");
    expect(ask).toContain('vendor: "Reoon"');
    // 2026-11-07 (CRMP, F30): the count is the selection or all matching; all
    // matching goes through bulkByFilter's verify, which keeps the same checks.
    expect(ask).toContain("count: n,");
    expect(ask).toContain(": verifyBulk.mutate({ ids: selectedIds })));");
    expect(ask).toContain(`enrichByFilter.mutate({ action: "verify", filter: matching.filter as any, expectedTotal: matching.total })`);
    expect(menu).toContain("trpc.prospects.verifyEmailBulk.useMutation({");
    expect(menu).toContain("trpc.prospects.verifyJob.useQuery({ jobId: verifyJobId ?? 0 }");
    expect(menu).toContain("utils.dataHealth.getMetrics.invalidate();");
    expect(menu).toContain("{isManager && (");
    expect(menu).toContain("onClick={askVerify}");
  });

  it("the Data health center's credits card replaces the placeholder", () => {
    const de = read("client/src/pages/usip/DataEnrichment.tsx");
    const center = block(de, '{tab === "Data health center" && (', '{tab === "CRM" && (');
    expect(center).toContain("<CreditsCard />");
    expect(center).not.toContain("What enrichment has cost");
    const card = block(de, "function CreditsCard() {", "/* ── inline donut chart ── */");
    expect(card).toContain("trpc.dataHealth.credits.useQuery(");
    expect(card).toContain("Reoon balance");
    expect(card).toContain("LinkedIn lookups");
    expect(card).toContain("QuickEnrich");
    // A failed read is said, never a zero.
    expect(card).toContain('row("Reoon balance", "unavailable", c.reoon.error ?? undefined)');
  });
});

describe("the source health strip shows the rest of the yield and the spend (F12)", () => {
  it("each row shows admitted, last success, AI tokens on the campaign, and LinkedIn's lookups left", () => {
    const strip = read("client/src/components/usip/are/CampaignSourceHealth.tsx");
    const row = block(strip, "function SourceRow(", "export function CampaignSourceHealth(");
    expect(row).toContain("{s.yield.admitted.toLocaleString()} admitted");
    expect(row).toContain("last found people ${when(s.lastSuccessAt)}");
    expect(row).toContain("{s.tokensToday.toLocaleString()} AI tokens on this campaign");
    expect(row).toContain("{s.lookupsLeftToday.toLocaleString()} lookups left today");
    expect(row).toContain("up to {s.aiCallsPerRun} AI");
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
