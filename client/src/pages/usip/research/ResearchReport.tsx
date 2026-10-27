/**
 * A market's research as a set of reports (/research/markets/:id/report/:section),
 * like Downstream's pages (owner, 2026-10-15: "I should be able to see a full
 * set of reports like you see in the Downstream app"). Read-only: every
 * section is computed from the market and its sectors (@shared/researchReports),
 * so a report never disagrees with the research it summarises.
 */
import { useMemo, useState } from "react";
import { Link, useLocation, useParams } from "wouter";
import { Shell, PageHeader, QueryError, TableSkeleton } from "@/components/usip/Shell";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ChevronDown, Pencil, Telescope } from "lucide-react";
import { Crumbs, Section, StatusBadge } from "@/components/usip/research/ResearchFields";
import { MarketExtras } from "@/components/usip/research/MarketExtras";
import { RunStatusBadge } from "@/components/usip/research/ResearchRuns";
import { ExtLink, ReportTable, ScoreDots, StatTile, Td } from "@/components/usip/research/ReportBits";
import { SECTOR_SCORE_KEYS, SECTOR_SCORE_LABEL } from "@shared/researchShape";
import {
  DEFAULT_WEIGHTS, WEIGHT_CHOICES, cleanWeights, competitorsByCategory, headlineFigure, intermediaries,
  openQuestions, programsByAgency, scorecard, sourceCounts, statusCounts, weightedScore, type ScoreWeights,
} from "@shared/researchReports";
import { MIN_SAMPLE, pct } from "@shared/researchResults";
import { formatUsd } from "@shared/researchModels";
import { NotFoundState } from "@/components/usip/QueryState";

type Report = RouterOutputs["research"]["reports"]["market"];

const SECTIONS = [
  { key: "overview", label: "Overview" },
  { key: "scorecard", label: "Sector scorecard" },
  { key: "side-by-side", label: "Side by side" },
  { key: "messaging", label: "Messaging by sector" },
  { key: "funders", label: "Funders & programs" },
  { key: "competitors", label: "Competitive landscape" },
  { key: "glossary", label: "Glossary" },
  { key: "sources", label: "Sources & accuracy" },
  { key: "questions", label: "Open questions" },
  { key: "briefs", label: "Research briefs" },
  { key: "results", label: "Results" },
] as const;
type SectionKey = (typeof SECTIONS)[number]["key"];

const sectorReport = (id: number) => `/research/sectors/${id}/report`;
const day = (d: string | Date) => new Date(d).toLocaleDateString(undefined, { dateStyle: "medium" });

export default function ResearchReport() {
  const params = useParams<{ id: string; section?: string }>();
  const id = Number(params.id);
  const [, navigate] = useLocation();
  const section: SectionKey = (SECTIONS.find((s) => s.key === params.section)?.key ?? "overview");
  const q = trpc.research.reports.market.useQuery({ id }, { enabled: Number.isFinite(id) && id > 0 });

  // A non-numeric id never queried and showed a skeleton forever (audit
  // 2026-10-20, P104).
  if (!(Number.isFinite(id) && id > 0)) return <Shell title="Research"><NotFoundState what="market" backHref="/research" backLabel="Research" /></Shell>;
  if (q.error) return <Shell title="Market report"><div className="p-6"><QueryError message={q.error.message} onRetry={() => q.refetch()} /></div></Shell>;
  if (!q.data) return <Shell title="Market report"><div className="p-6"><TableSkeleton rows={6} /></div></Shell>;
  const r = q.data;
  const counts = countsOf(r);
  const go = (k: SectionKey) => navigate(`/research/markets/${id}/report/${k}`);

  return (
    <Shell title={`${r.market.content.name}: report`}>
      <Crumbs items={[{ href: "/research", label: "Research" }, { label: r.market.content.name }]} />
      <PageHeader icon={<Telescope className="size-5" />} title={r.market.content.name} description={r.market.content.tagline || "Reports on this market's research."}>
        <StatusBadge status={r.market.content.status} />
        <Link href={`/research/markets/${id}`}><Button variant="outline" size="sm"><Pencil className="size-4 mr-1" /> Edit research</Button></Link>
      </PageHeader>

      <div className="p-4 md:p-6 w-full max-w-7xl flex flex-col md:flex-row gap-4 md:gap-6">
        <nav aria-label="Reports" className="md:w-52 shrink-0">
          <div className="md:hidden">
            <Select value={section} onValueChange={(v) => go(v as SectionKey)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>{SECTIONS.map((s) => <SelectItem key={s.key} value={s.key}>{s.label}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <ul className="hidden md:block sticky top-4 space-y-0.5">
            {SECTIONS.map((s) => (
              <li key={s.key}>
                <Link
                  href={`/research/markets/${id}/report/${s.key}`}
                  className={`flex items-center justify-between rounded-md px-2.5 py-1.5 text-sm ${section === s.key ? "bg-accent font-medium" : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"}`}
                >
                  {s.label}
                  {counts[s.key] != null && <span className="text-[10px] tabular-nums text-muted-foreground">{counts[s.key]}</span>}
                </Link>
              </li>
            ))}
          </ul>
        </nav>

        <main className="flex-1 min-w-0 space-y-4">
          {section === "overview" && <Overview r={r} />}
          {section === "scorecard" && <Scorecard r={r} />}
          {section === "side-by-side" && <SideBySide r={r} />}
          {section === "messaging" && <Messaging r={r} />}
          {section === "funders" && <Funders r={r} />}
          {section === "competitors" && <Competitors r={r} />}
          {section === "glossary" && <Glossary r={r} />}
          {section === "sources" && <Sources r={r} />}
          {section === "questions" && <Questions r={r} />}
          {section === "briefs" && <Briefs r={r} />}
          {section === "results" && <Results r={r} />}
        </main>
      </div>
    </Shell>
  );
}

function countsOf(r: Report): Partial<Record<SectionKey, number>> {
  return {
    scorecard: r.sectors.length,
    competitors: r.market.content.competitors.length,
    glossary: r.market.content.glossary.length,
    questions: openQuestions(r.market, r.sectors).length,
    briefs: r.runs.filter((x) => x.brief).length,
  };
}

const Empty = ({ children }: { children: React.ReactNode }) => <p className="text-sm text-muted-foreground">{children}</p>;

/* ── Overview ───────────────────────────────────────────────────────────── */

function Overview({ r }: { r: Report }) {
  const m = r.market.content;
  const st = statusCounts(r.sectors);
  const programs = programsByAgency(r.sectors).reduce((n, g) => n + g.programs.length, 0);
  const src = sourceCounts(r.market, r.sectors);
  const spent = r.runs.reduce((n, x) => n + Number(x.costUsd ?? 0), 0);
  const names = new Set(r.sectors.map((s) => s.content.name.trim().toLowerCase()));
  const notAdded = m.suggestedSectors.filter((s) => s.name.trim() && !names.has(s.name.trim().toLowerCase()));
  return (
    <>
      {(m.overview.headline || m.overview.lede) && (
        <div className="rounded-lg border bg-gradient-to-br from-teal-500/5 to-transparent p-5 space-y-2">
          {m.overview.headline && <h2 className="text-xl font-semibold leading-snug">{m.overview.headline}</h2>}
          {m.overview.lede && <p className="text-sm text-muted-foreground leading-relaxed whitespace-pre-wrap">{m.overview.lede}</p>}
        </div>
      )}
      <div className="grid gap-3 grid-cols-2 lg:grid-cols-5">
        <StatTile value={r.sectors.length} label="Sectors mapped" note={`${st.verified} verified · ${st.researched} researched · ${st.draft} draft`} />
        <StatTile value={r.personas.length} label="Buyer personas" />
        <StatTile value={programs} label="Programs catalogued" />
        <StatTile value={src.distinct} label="Sources cited" />
        <StatTile value={r.runs.length} label="AI research runs" note={r.runs.length ? `${formatUsd(spent)} spent` : undefined} />
      </div>
      <MarketExtras extras={r.market.extras} />
      <Section title="Sectors" description="Each sector's own report has its money flow, programs, buyers, messaging and sources.">
        {r.sectors.length === 0 ? <Empty>No sectors yet. Add one on the market's page, or have AI research one.</Empty> : (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {r.sectors.map((s) => {
              const fig = headlineFigure(s.content);
              const score = weightedScore(s.content.scores, DEFAULT_WEIGHTS);
              return (
                <Link key={s.id} href={sectorReport(s.id)} className="rounded-lg border p-3.5 hover:bg-accent/40 space-y-1.5 block">
                  <div className="font-medium text-sm leading-snug">{s.content.name}</div>
                  {s.content.tagline && <p className="text-xs text-muted-foreground line-clamp-2">{s.content.tagline}</p>}
                  {fig && <p className="text-xs"><span className="font-semibold">{fig.value}</span> {fig.label}</p>}
                  <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                    <StatusBadge status={s.content.status} />
                    <span className="text-[11px] text-muted-foreground">{s.content.facts.programs.length} {s.content.facts.programs.length === 1 ? "program" : "programs"}</span>
                    {score != null && <span className="text-[11px] text-muted-foreground">· score {score}</span>}
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </Section>
      {notAdded.length > 0 && (
        <Section title="Suggested sectors not yet added">
          <ul className="space-y-1.5 text-sm">{notAdded.map((s) => <li key={s.name}><span className="font-medium">{s.name}</span>{s.why ? <span className="text-muted-foreground"> · {s.why}</span> : null}</li>)}</ul>
        </Section>
      )}
    </>
  );
}

/* ── Scorecard ──────────────────────────────────────────────────────────── */

function useWeights(marketId: number): [ScoreWeights, (w: ScoreWeights) => void] {
  const key = `usip:research:weights:${marketId}`;
  const [w, setW] = useState<ScoreWeights>(() => {
    try { return cleanWeights(JSON.parse(window.localStorage.getItem(key) ?? "null")); } catch { return DEFAULT_WEIGHTS; }
  });
  return [w, (next) => { setW(next); try { window.localStorage.setItem(key, JSON.stringify(next)); } catch { /* not remembered */ } }];
}

function Scorecard({ r }: { r: Report }) {
  const [weights, setWeights] = useWeights(r.market.id);
  const rows = scorecard(r.sectors, weights);
  return (
    <Section title="Sector scorecard" description="The 1 to 5 scores set on each sector, weighted. Change a weight to see how priorities shift; your weights are kept in this browser only.">
      <div className="flex flex-wrap gap-3 text-xs">
        {SECTOR_SCORE_KEYS.map((k) => (
          <label key={k} className="flex items-center gap-1.5">
            <span className="text-muted-foreground">{SECTOR_SCORE_LABEL[k]}</span>
            <Select value={String(weights[k])} onValueChange={(v) => setWeights({ ...weights, [k]: Number(v) })}>
              <SelectTrigger className="h-7 w-16 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>{WEIGHT_CHOICES.map((n) => <SelectItem key={n} value={String(n)}>×{n}</SelectItem>)}</SelectContent>
            </Select>
          </label>
        ))}
      </div>
      {rows.length === 0 ? <Empty>No sectors yet.</Empty> : (
        <ReportTable head={["#", "Sector", ...SECTOR_SCORE_KEYS.map((k) => SECTOR_SCORE_LABEL[k]), "Score", "Why"]}>
          {rows.map((s, i) => (
            <tr key={s.id}>
              <Td className="text-muted-foreground">{i + 1}</Td>
              <Td className="font-medium min-w-40"><Link href={sectorReport(s.id)} className="underline underline-offset-2">{s.content.name}</Link></Td>
              {SECTOR_SCORE_KEYS.map((k) => <Td key={k}><ScoreDots value={s.content.scores[k]} /></Td>)}
              <Td className="min-w-24">
                {s.score == null ? <span className="text-muted-foreground">—</span> : (
                  <span className="flex items-center gap-2"><span className="h-1.5 w-12 rounded bg-muted overflow-hidden"><span className="block h-full bg-teal-700 dark:bg-teal-400" style={{ width: `${s.score}%` }} /></span><span className="tabular-nums">{s.score}</span></span>
                )}
              </Td>
              <Td className="text-muted-foreground min-w-64">{s.content.tagline || s.content.summary.slice(0, 160)}</Td>
            </tr>
          ))}
        </ReportTable>
      )}
    </Section>
  );
}

/* ── Side by side ───────────────────────────────────────────────────────── */

function SideBySide({ r }: { r: Report }) {
  return (
    <Section title="Side by side" description="Where each sector's money comes from, who helps its organizations today, and what to lead with.">
      {r.sectors.length === 0 ? <Empty>No sectors yet.</Empty> : (
        <ReportTable head={["Sector", "Where the money comes from", "Who helps them today", "Lead with"]}>
          {r.sectors.map((s) => {
            const f = s.content.facts;
            const money = [...f.moneyFlow.intermediaries.map((i) => i.name), ...f.moneyFlow.sources].filter(Boolean).slice(0, 3);
            return (
              <tr key={s.id}>
                <Td className="font-medium min-w-40"><Link href={sectorReport(s.id)} className="underline underline-offset-2">{s.content.name}</Link></Td>
                <Td className="min-w-56">{money.join("; ") || <span className="text-muted-foreground">—</span>}</Td>
                <Td className="min-w-56">{f.helpers.slice(0, 3).join("; ") || <span className="text-muted-foreground">—</span>}</Td>
                <Td className="min-w-56">{s.content.messaging.leadWith.slice(0, 2).join(" ") || <span className="text-muted-foreground">—</span>}</Td>
              </tr>
            );
          })}
        </ReportTable>
      )}
    </Section>
  );
}

/* ── Messaging ──────────────────────────────────────────────────────────── */

function Messaging({ r }: { r: Report }) {
  return (
    <>
      <Section title="Messaging by sector" description="Every AI writer reads this. A message that would make sense sent to everyone is wrong for everyone.">
        {r.sectors.length === 0 ? <Empty>No sectors yet.</Empty> : (
          <ReportTable head={["Sector", "Opening line", "Lead with", "Never say"]}>
            {r.sectors.map((s) => (
              <tr key={s.id}>
                <Td className="font-medium min-w-36"><Link href={sectorReport(s.id)} className="underline underline-offset-2">{s.content.name}</Link></Td>
                <Td className="min-w-64 italic">{s.content.messaging.sampleOpening || <span className="not-italic text-muted-foreground">—</span>}</Td>
                <Td className="min-w-56">{s.content.messaging.leadWith.length ? <ul className="list-disc pl-4 space-y-0.5">{s.content.messaging.leadWith.map((x, i) => <li key={i}>{x}</li>)}</ul> : "—"}</Td>
                <Td className="min-w-56">{s.content.messaging.avoid.length ? <ul className="list-disc pl-4 space-y-0.5">{s.content.messaging.avoid.map((x, i) => <li key={i}>{x}</li>)}</ul> : "—"}</Td>
              </tr>
            ))}
          </ReportTable>
        )}
      </Section>
      {r.personas.length > 0 && (
        <Section title="The angle that works, by persona">
          <ReportTable head={["Persona", "Sector", "Cares about", "The angle"]}>
            {r.personas.map((p) => (
              <tr key={p.id}>
                <Td className="font-medium">{p.name}</Td>
                <Td>{r.sectors.find((s) => s.id === p.sectorId)?.content.name ?? "—"}</Td>
                <Td>{p.cares || "—"}</Td>
                <Td>{p.angle || "—"}</Td>
              </tr>
            ))}
          </ReportTable>
        </Section>
      )}
    </>
  );
}

/* ── Funders and programs ───────────────────────────────────────────────── */

function Funders({ r }: { r: Report }) {
  const groups = programsByAgency(r.sectors);
  const passers = intermediaries(r.sectors);
  const dsFunders = r.market.extras?.funders ?? [];
  return (
    <>
      {dsFunders.length > 0 && <MarketExtras extras={{ stats: null, funders: dsFunders }} />}
      <Section title="Who passes the money on" description="The intermediaries the sectors name: who takes money in and hands it out.">
        {passers.length === 0 ? <Empty>None recorded yet.</Empty> : (
          <ReportTable head={["Name", "Role", "How many", "Sectors"]}>
            {passers.map((p) => (
              <tr key={p.name}><Td className="font-medium">{p.name}</Td><Td>{p.role || "—"}</Td><Td>{p.count || "—"}</Td><Td>{p.sectors.join(", ")}</Td></tr>
            ))}
          </ReportTable>
        )}
      </Section>
      <Section title="Programs, by agency" description="Every program the sectors catalogue, once each.">
        {groups.length === 0 ? <Empty>No programs catalogued yet.</Empty> : groups.map((g) => (
          <div key={g.agency} className="space-y-1.5">
            <div className="text-sm font-medium">{g.agency} <span className="text-xs text-muted-foreground font-normal">· {g.programs.length}</span></div>
            <ReportTable head={["Program", "Flow", "Purpose", "Typical award", "Sectors"]}>
              {g.programs.map((p) => (
                <tr key={p.name}>
                  <Td className="font-medium min-w-48"><ExtLink url={p.url}>{p.name}</ExtLink></Td>
                  <Td>{p.flow || "—"}</Td><Td className="min-w-56">{p.purpose || "—"}</Td><Td>{p.typicalAward || "—"}</Td><Td>{p.sectors.join(", ")}</Td>
                </tr>
              ))}
            </ReportTable>
          </div>
        ))}
      </Section>
    </>
  );
}

/* ── Competitors ────────────────────────────────────────────────────────── */

function Competitors({ r }: { r: Report }) {
  const groups = competitorsByCategory(r.market.content);
  return (
    <Section title="Competitive landscape" description="Who else sells into this market, how they position, and what they charge.">
      {groups.length === 0 ? <Empty>No competitors recorded yet. Add them on the market's page.</Empty> : groups.map((g) => (
        <div key={g.category} className="space-y-1.5">
          <div className="text-sm font-medium">{g.category} <span className="text-xs text-muted-foreground font-normal">· {g.competitors.length}</span></div>
          <ReportTable head={["Product", "Positioning", "Public pricing"]}>
            {g.competitors.map((c, i) => (
              <tr key={i}><Td className="font-medium min-w-40"><ExtLink url={c.url}>{c.name}</ExtLink></Td><Td className="min-w-64">{c.positioning || "—"}</Td><Td className="min-w-48">{c.pricing || "—"}</Td></tr>
            ))}
          </ReportTable>
        </div>
      ))}
    </Section>
  );
}

/* ── Glossary ───────────────────────────────────────────────────────────── */

function Glossary({ r }: { r: Report }) {
  const [find, setFind] = useState("");
  const terms = useMemo(() => {
    const f = find.trim().toLowerCase();
    return [...r.market.content.glossary]
      .sort((a, b) => a.term.localeCompare(b.term))
      .filter((g) => !f || g.term.toLowerCase().includes(f) || g.definition.toLowerCase().includes(f));
  }, [r.market.content.glossary, find]);
  return (
    <Section title="Glossary" description={`${r.market.content.glossary.length} terms this market uses.`}>
      <Input aria-label="Find a term" placeholder="Find a term…" value={find} onChange={(e) => setFind(e.target.value)} className="max-w-sm h-8 text-sm" />
      {terms.length === 0 ? <Empty>{r.market.content.glossary.length ? "No term matches." : "No terms yet. Add them on the market's page."}</Empty> : (
        <dl className="divide-y rounded-md border">
          {terms.map((g, i) => (
            <div key={i} className="p-3 grid gap-1 md:grid-cols-[14rem_1fr] text-sm">
              <dt className="font-medium">{g.term}</dt>
              <dd className="text-muted-foreground">{g.definition}{g.source ? <> · <ExtLink url={g.source}>source</ExtLink></> : null}</dd>
            </div>
          ))}
        </dl>
      )}
    </Section>
  );
}

/* ── Sources and accuracy ───────────────────────────────────────────────── */

const STATUS_MEANING = {
  verified: "Checked against a primary source by a person.",
  researched: "Researched with sources, by a person or AI; a person still needs to check it.",
  draft: "Written from general knowledge or a meeting; needs sources.",
} as const;

function Sources({ r }: { r: Report }) {
  const { pages, distinct } = sourceCounts(r.market, r.sectors);
  const unverified = pages.filter((p) => p.status !== "verified");
  const all = new Map<string, { title: string; url: string; pages: string[] }>();
  const collect = (name: string, list: { title: string; url: string }[]) => {
    for (const s of list) {
      const k = s.url.trim().toLowerCase().replace(/\/+$/, "");
      if (!k) continue;
      const row = all.get(k);
      if (row) { if (!row.pages.includes(name)) row.pages.push(name); } else all.set(k, { title: s.title, url: s.url, pages: [name] });
    }
  };
  collect(r.market.content.name, r.market.content.sources);
  for (const s of r.sectors) collect(s.content.name, s.content.sources);
  return (
    <>
      <Section title="Sources & accuracy" description="Treat anything not Verified as a lead to confirm, not a fact to quote to a customer.">
        <div className="grid gap-3 md:grid-cols-3">
          {(["verified", "researched", "draft"] as const).map((k) => (
            <div key={k} className="rounded-md border p-3 space-y-1">
              <div className="flex items-center gap-2"><StatusBadge status={k} /><span className="text-xs tabular-nums text-muted-foreground">{pages.filter((p) => p.status === k).length} {pages.filter((p) => p.status === k).length === 1 ? "page" : "pages"}</span></div>
              <p className="text-xs text-muted-foreground">{STATUS_MEANING[k]}</p>
            </div>
          ))}
        </div>
        <p className="text-sm">{distinct} distinct sources cited.</p>
        <ReportTable head={["Page", "Status", "Sources"]}>
          {pages.map((p) => (
            <tr key={`${p.kind}${p.id}`}>
              <Td className="font-medium"><Link href={p.kind === "market" ? `/research/markets/${p.id}` : sectorReport(p.id)} className="underline underline-offset-2">{p.name}</Link>{p.kind === "market" ? <span className="text-muted-foreground font-normal"> (market)</span> : null}</Td>
              <Td><StatusBadge status={p.status} /></Td>
              <Td className="tabular-nums">{p.sources}</Td>
            </tr>
          ))}
        </ReportTable>
        {unverified.length > 0 && <p className="text-xs text-muted-foreground">{unverified.length} of {pages.length} pages are not Verified yet. Mark one Verified on its page once a person has checked it.</p>}
      </Section>
      <Section title="Every source" description="Once each, with the pages that cite it.">
        {all.size === 0 ? <Empty>No sources yet.</Empty> : (
          <ol className="list-decimal pl-5 space-y-1 text-xs break-words">
            {Array.from(all.values()).map((s) => <li key={s.url}><ExtLink url={s.url}>{s.title || s.url}</ExtLink> <span className="text-muted-foreground">· {s.pages.join(", ")}</span></li>)}
          </ol>
        )}
      </Section>
    </>
  );
}

/* ── Open questions ─────────────────────────────────────────────────────── */

function Questions({ r }: { r: Report }) {
  const qs = openQuestions(r.market, r.sectors);
  const byPage = new Map<string, typeof qs>();
  for (const x of qs) byPage.set(`${x.kind}:${x.id}`, [...(byPage.get(`${x.kind}:${x.id}`) ?? []), x]);
  return (
    <Section title="Open questions" description={`${qs.length} questions the research could not answer yet. Answer one on its page, then remove it there.`}>
      {qs.length === 0 ? <Empty>No open questions.</Empty> : Array.from(byPage.values()).map((list) => (
        <div key={`${list[0].kind}${list[0].id}`} className="space-y-1">
          <div className="text-sm font-medium">
            <Link href={list[0].kind === "market" ? `/research/markets/${list[0].id}` : `/research/sectors/${list[0].id}`} className="underline underline-offset-2">{list[0].name}</Link>
            <span className="text-xs text-muted-foreground font-normal"> · {list.length}</span>
          </div>
          <ul className="list-disc pl-5 space-y-0.5 text-sm">{list.map((x, i) => <li key={i}>{x.question}</li>)}</ul>
        </div>
      ))}
    </Section>
  );
}

/* ── Research briefs ────────────────────────────────────────────────────── */

function Briefs({ r }: { r: Report }) {
  const runs = r.runs.filter((x) => x.brief);
  const [open, setOpen] = useState<number | null>(runs[0]?.id ?? null);
  return (
    <Section title="Research briefs" description="What each AI research run found, in its own words, with the source of every figure. Removed runs are included.">
      {runs.length === 0 ? <Empty>No AI research has been run for this market yet.</Empty> : (
        <div className="divide-y rounded-md border">
          {runs.map((x) => (
            <div key={x.id}>
              <button type="button" className="w-full flex items-center gap-3 p-3 text-left hover:bg-accent/40" onClick={() => setOpen(open === x.id ? null : x.id)} aria-expanded={open === x.id}>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium truncate">{x.subject} <span className="text-muted-foreground font-normal">· {x.kind}</span></div>
                  <div className="text-xs text-muted-foreground">{x.byName} · {day(x.createdAt)} · {formatUsd(x.costUsd)} · {x.searches} searches · {x.fetches} pages read{x.removedAt ? " · removed from the Research page" : ""}</div>
                </div>
                <RunStatusBadge status={x.status} outcome={x.outcome} />
                <ChevronDown className={`size-4 shrink-0 transition-transform ${open === x.id ? "rotate-180" : ""}`} />
              </button>
              {open === x.id && (
                <div className="px-3 pb-4 space-y-2">
                  <div className="whitespace-pre-wrap break-words text-sm leading-relaxed">{x.brief}</div>
                  <Link href={`/research/runs/${x.id}`} className="text-xs underline">Open the run</Link>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}

/* ── Results ────────────────────────────────────────────────────────────── */

function Results({ r }: { r: Report }) {
  const q = trpc.research.reports.results.useQuery({ marketId: r.market.id });
  const tallies = q.data ?? {};
  const rows = r.sectors.map((s) => ({ s, t: tallies[s.id] }));
  const any = rows.some((x) => x.t && x.t.written > 0);
  return (
    <Section title="Results" description={`What happened to the prospects whose Revenue Engine copy each sector shaped. A reply rate shows once ${MIN_SAMPLE} or more were contacted.`}>
      {q.error ? <QueryError message={q.error.message} onRetry={() => q.refetch()} /> : !q.data ? <TableSkeleton rows={3} /> : !any ? (
        <Empty>No Revenue Engine copy has been written with this market's sectors yet. Results appear once a campaign writes and sends sequences with them.</Empty>
      ) : (
        <ReportTable head={["Sector", "Written", "Contacted", "Replied", "Positive", "Meetings"]}>
          {rows.map(({ s, t }) => (
            <tr key={s.id}>
              <Td className="font-medium"><Link href={`/research/sectors/${s.id}#results`} className="underline underline-offset-2">{s.content.name}</Link></Td>
              <Td className="tabular-nums">{t?.written ?? 0}</Td>
              <Td className="tabular-nums">{t?.contacted ?? 0}</Td>
              <Td className="tabular-nums">{t?.replied ?? 0}{t && t.contacted >= MIN_SAMPLE ? <span className="text-muted-foreground"> ({pct(t.replied, t.contacted)}%)</span> : null}</Td>
              <Td className="tabular-nums">{t?.positive ?? 0}</Td>
              <Td className="tabular-nums">{t?.meetings ?? 0}</Td>
            </tr>
          ))}
        </ReportTable>
      )}
    </Section>
  );
}

