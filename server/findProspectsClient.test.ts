/**
 * The client halves of batch Pd (audit 2026-10-20): Data enrichment, Find
 * prospects, Source search and the LinkedIn review. Read from source, block by
 * block, as the repo's other screen pins do; the one pure helper is imported.
 *
 *   L3 / P141  the Needs-review badge asks for a page size prospects.list takes
 *   P142  search, re-score and the LinkedIn import refresh what they changed
 *   P147  a run shows its raw finds        P148  a failed load says so
 *   P149  no LinkedIn search with nothing in it
 *   P150  a batch target over 200 says it will be cut
 *   P151  a sector pick adds its keywords to the typed ones
 *   P152  a card with links, not a button around them; reasons on the page
 *   P155  a failed Skip says so            P76  the card saves to People
 *   P77   the open search is in the address
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { applySectorFields } from "../client/src/components/usip/research/StartFromSector";

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
const ss = read("client/src/pages/usip/SourceSearch.tsx");

describe("Data enrichment's Needs-review badge (L3, P141)", () => {
  it("asks prospects.list for a page size it accepts, with no cast hiding the input", () => {
    const de = read("client/src/pages/usip/DataEnrichment.tsx");
    const call = de.match(/const needsReviewQ = trpc\.prospects\.list\.useQuery\((\{[^}]*\})([^;]*)\);/);
    expect(call, "the needs-review query").not.toBeNull();
    const asked = Number(call![1].match(/perPage: (\d+)/)![1]);
    const listInput = block(read("server/routers/prospects.ts"), "  list: workspaceProcedure", ".query(");
    const min = Number(listInput.match(/perPage: z\.number\(\)\.int\(\)\.min\((\d+)\)/)![1]);
    expect(asked).toBeGreaterThanOrEqual(min);
    expect(call![2]).not.toContain("as never");
  });
});

describe("Find prospects refreshes what each action changed (P142)", () => {
  it("search, re-score and the LinkedIn import", () => {
    const search = block(fp, "const search = trpc.discovery.search.useMutation({", "const runSearch = () => {");
    for (const r of ["utils.prospects.list.invalidate()", "utils.discovery.listRuns.invalidate()", "utils.discovery.getRun.invalidate(", "utils.discovery.getLogs.invalidate("]) expect(search).toContain(r);
    const reprocess = block(fp, "const reprocess = trpc.discovery.reprocess.useMutation({", "onError:");
    for (const r of ["utils.discovery.getRun.invalidate(", "utils.discovery.listRuns.invalidate()", "utils.prospects.list.invalidate()"]) expect(reprocess).toContain(r);
    const imp = block(fp, "const importPeople = trpc.unipile.importSearchHitsToPeople.useMutation({", "onError:");
    expect(imp).toContain("utils.prospects.list.invalidate()");
    expect(imp).toContain("utils.discovery.listRuns.invalidate()");
  });

  it("the toast counts what was saved and says when a running search was joined (P61, P72)", () => {
    const search = block(fp, "const search = trpc.discovery.search.useMutation({", "const runSearch = () => {");
    expect(search).toContain("r.prospectsSkipped");
    expect(search).toContain("r.accountsCreated");
    expect(search).toContain("r.joinedRunning");
    expect(search).toContain('r.status === "failed"');
  });
});

describe("a run shows its raw finds, and its failures (P147, P148)", () => {
  it("RunDetail reads the raw finds and says when the logs or finds fail to load", () => {
    const detail = block(fp, "function RunDetail(", "function RecentRuns(");
    expect(detail).toContain("trpc.discovery.getRawFinds.useQuery({ runId })");
    expect(detail).toContain('<QueryError what="this run\'s logs"');
    expect(detail).toContain('<QueryError what="this run\'s raw finds"');
    expect(detail).not.toContain("logs.length === 0 ? <div className=\"text-muted-foreground italic\">Loading logs…</div>");
  });

  it("Recent runs says when it could not load instead of vanishing", () => {
    const recent = block(fp, "function RecentRuns(", "/* ─── Saved prospect queue");
    // The error is answered before the empty-or-loading return, not hidden by it.
    const beforeEmpty = block(recent, "function RecentRuns(", "if (isLoading || runs.length === 0) return null;");
    expect(beforeEmpty).toContain('if (error && runs.length === 0) return <QueryError what="your recent discovery runs"');
  });
});

describe("the LinkedIn card (P76, P149)", () => {
  it("saves to People, sending the hits as they came", () => {
    const card = block(fp, "function LinkedInSearchCard()", "/* ─── Main panel");
    expect(card).not.toContain("importSearchHitsAsLeads");
    expect(card).toContain("importPeople.mutate({ hits: selectedHits })");
    expect(card).toContain("to People");
    expect(card).not.toContain("as leads");
  });

  it("refuses a search with nothing in it on either API", () => {
    const run = block(fp, "  const runSearch = () => {\n    const filters", "  const selectedHits");
    expect(run).toContain("if (!keywords.trim() && Object.keys(filters).length === 0) {");
    expect(run).not.toContain('api === "classic") { toast.error("Enter keywords"); return; }');
  });
});

describe("a sector pick (P151)", () => {
  it("replaces the title, fills blanks, and keeps the typed keywords", () => {
    const form = { jobTitle: "CFO", industry: "Nonprofit", location: "", keywords: ["grants", "Endowment"], seniority: "VP" };
    const out = applySectorFields(form, { jobTitle: "Treasurer", industry: "", location: "Texas", keywords: ["endowment", "audit"] });
    expect(out).toEqual({ jobTitle: "Treasurer", industry: "Nonprofit", location: "Texas", keywords: ["grants", "Endowment", "audit"], seniority: "VP" });
    expect(fp).toContain("onApply={(f) => setPersonForm((prev) => applySectorFields(prev, f))}");
  });
});

describe("Find prospects' cards, chips and reasons (P152)", () => {
  it("a result is a card with a link in it, not a button with links inside", () => {
    const row = block(fp, "function ProspectRow(", "/* ─── LinkedIn / Sales Navigator search");
    expect(row).not.toContain('role="button"');
    expect(row).toContain("<Link href={`/prospects/${p.id}`}");
    expect(row).toContain("aria-label={`${p.firstName} ${p.lastName} on LinkedIn`}");
  });

  it("a disabled source says why on the page, and a confidence chip says its tier in words", () => {
    const sources = block(fp, "{modeSources.map((id) => {", "</div>\n                <div className=\"text-[11px] text-muted-foreground\">");
    expect(sources).not.toContain("title={enabled ? undefined");
    expect(sources).toContain("(off in Settings → Revenue Engine)");
    const chip = block(fp, "function ConfidenceChip(", "/* ─── Result row");
    expect(chip).toContain('<span className="sr-only">confidence, {tier}</span>');
  });
});

describe("Source search (P68, P77, P150)", () => {
  it("keeps the open search in the address and reads it back on load", () => {
    expect(ss).toContain('export const SEARCH_RUN_PARAM = "searchRun";');
    expect(ss).toContain("useState<number | null>(runIdFromUrl)");
    expect(ss).toContain("const setRunId = (id: number | null) => { setRunIdState(id); writeRunIdToUrl(id); };");
    expect(ss).not.toContain("const [runId, setRunId] = useState<number | null>(null);");
    const start = block(ss, "const start = trpc.prospectSources.startSearch.useMutation({", "onError:");
    expect(start).toContain("r.alreadyRunning");
  });

  it("only real filters unlock Run, and a target over 200 is said, not quietly cut", () => {
    const run = block(ss, '<Button size="sm" className="gap-1.5" disabled={start.isPending', "</Button>");
    expect(run).toContain("narrowing.length === 0");
    expect(run).not.toContain("active.length === 0");
    expect(ss).toContain("{typedTarget > MAX_TARGET && <div");
  });
});

describe("LinkedIn review's Skip (P155)", () => {
  it("says when it fails", () => {
    const src = read("client/src/pages/usip/LinkedInEnrichmentImport.tsx");
    const skip = block(src, "const onSkip = async", "return (");
    expect(skip).toMatch(/\} catch \(e: any\) \{[\s\S]*toast\.error\(/);
  });
});
