/**
 * A sector as a report (/research/sectors/:id/report): everything the
 * research holds about it, laid out to read, like Downstream's segment page.
 * Read-only; "Edit" opens the sector's own page.
 */
import { Link, useParams } from "wouter";
import { Shell, PageHeader, QueryError, TableSkeleton } from "@/components/usip/Shell";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Pencil, Telescope } from "lucide-react";
import { Crumbs, Section, StatusBadge } from "@/components/usip/research/ResearchFields";
import { MoneyFlow } from "@/components/usip/research/MoneyFlow";
import { RunsForRecord } from "@/components/usip/research/ResearchRuns";
import { ScoreDots } from "@/components/usip/research/ReportBits";
import { SECTOR_SCORE_KEYS, SECTOR_SCORE_LABEL } from "@shared/researchShape";

const List = ({ items }: { items: string[] }) =>
  items.length ? <ul className="list-disc pl-5 space-y-1 text-sm">{items.map((x, i) => <li key={i}>{x}</li>)}</ul> : <p className="text-sm text-muted-foreground">Nothing recorded yet.</p>;

const Chips = ({ items }: { items: string[] }) =>
  items.length ? <div className="flex flex-wrap gap-1.5">{items.map((x) => <Badge key={x} variant="secondary" className="text-xs font-normal">{x}</Badge>)}</div> : <span className="text-sm text-muted-foreground">None</span>;

const Ext = ({ url, children }: { url: string; children: React.ReactNode }) =>
  url ? <a href={url} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">{children}</a> : <>{children}</>;

export default function ResearchSectorReport() {
  const id = Number(useParams<{ id: string }>().id);
  const q = trpc.research.sectors.get.useQuery({ id }, { enabled: Number.isFinite(id) && id > 0 });

  if (q.error) return <Shell title="Sector report"><div className="p-6"><QueryError message={q.error.message} onRetry={() => q.refetch()} /></div></Shell>;
  if (!q.data) return <Shell title="Sector report"><div className="p-6"><TableSkeleton rows={6} /></div></Shell>;
  const { sector, market, personas } = q.data;
  const c = sector.content;
  const f = c.facts;
  const sizeRange = c.targeting.employeeMin != null || c.targeting.employeeMax != null
    ? `${c.targeting.employeeMin ?? 0} to ${c.targeting.employeeMax ?? "any"} employees` : "Any size";

  return (
    <Shell title={c.name}>
      <Crumbs items={[{ href: "/research", label: "Research" }, { href: `/research/markets/${market.id}/report`, label: market.name }, { label: c.name }]} />
      <PageHeader icon={<Telescope className="size-5" />} title={c.name} description={c.tagline || "A sector of this market."}>
        <StatusBadge status={c.status} />
        <Link href={`/research/sectors/${id}`}><Button variant="outline" size="sm"><Pencil className="size-4 mr-1" /> Edit</Button></Link>
      </PageHeader>

      <div className="p-4 md:p-6 space-y-4 w-full max-w-5xl">
        <Section title="Overview" description={c.asOf ? `Describes the sector as of ${c.asOf}.` : undefined}>
          {c.summary ? <p className="text-sm leading-relaxed whitespace-pre-wrap">{c.summary}</p> : <p className="text-sm text-muted-foreground">No summary yet.</p>}
          {f.marketSize.some((m) => m.value) && (
            <div className="grid gap-3 grid-cols-2 md:grid-cols-4">
              {f.marketSize.filter((m) => m.value).map((m, i) => (
                <div key={i} className="rounded-md border p-3">
                  <div className="text-lg font-semibold">{m.value}</div>
                  <div className="text-xs text-muted-foreground">{m.source ? <Ext url={m.source}>{m.label}</Ext> : m.label}</div>
                </div>
              ))}
            </div>
          )}
          <div className="flex flex-wrap gap-x-6 gap-y-2 text-xs">
            {SECTOR_SCORE_KEYS.map((k) => (
              <div key={k} className="flex items-center gap-2"><span className="text-muted-foreground w-12">{SECTOR_SCORE_LABEL[k]}</span><ScoreDots value={c.scores[k]} /></div>
            ))}
          </div>
        </Section>

        {(f.moneyFlow.sources.length > 0 || f.moneyFlow.intermediaries.length > 0 || f.moneyFlow.recipients.length > 0) && (
          <Section title="How the money flows">
            <MoneyFlow flow={f.moneyFlow} />
          </Section>
        )}

        {f.programs.length > 0 && (
          <Section title="Key programs">
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead><tr className="text-left text-muted-foreground border-b"><th className="py-1.5 pr-3 font-medium">Program</th><th className="py-1.5 pr-3 font-medium">Agency</th><th className="py-1.5 pr-3 font-medium">Flow</th><th className="py-1.5 pr-3 font-medium">Purpose</th><th className="py-1.5 font-medium">Typical award</th></tr></thead>
                <tbody>
                  {f.programs.map((p, i) => (
                    <tr key={i} className="border-b last:border-0 align-top">
                      <td className="py-1.5 pr-3 font-medium"><Ext url={p.url}>{p.name}</Ext></td>
                      <td className="py-1.5 pr-3">{p.agency}</td>
                      <td className="py-1.5 pr-3">{p.flow}</td>
                      <td className="py-1.5 pr-3">{p.purpose}</td>
                      <td className="py-1.5">{p.typicalAward}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>
        )}

        <div className="grid gap-4 md:grid-cols-2">
          <Section title="How they buy"><List items={f.buying} /></Section>
          <Section title="What they must report or comply with"><List items={f.obligations} /></Section>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <Section title="Who buys"><Chips items={c.buyers.roles} /></Section>
          <Section title="Who helps them today"><List items={f.helpers} /></Section>
        </div>

        <Section title="Pain points"><List items={c.buyers.painPoints} /></Section>

        {personas.length > 0 && (
          <Section title="Personas" description="The buyers in this sector.">
            <div className="grid gap-3 md:grid-cols-2">
              {personas.map((p: any) => (
                <div key={p.id} className="rounded-md border p-3 space-y-1.5 text-sm">
                  <div className="font-medium">{p.name}</div>
                  {p.cares && <p className="text-xs"><span className="text-muted-foreground">Cares about: </span>{p.cares}</p>}
                  {Array.isArray(p.pains) && p.pains.length > 0 && <p className="text-xs"><span className="text-muted-foreground">Pains: </span>{p.pains.join("; ")}</p>}
                  {Array.isArray(p.objections) && p.objections.length > 0 && <p className="text-xs"><span className="text-muted-foreground">Objections: </span>{p.objections.join("; ")}</p>}
                  {p.angle && <p className="text-xs"><span className="text-muted-foreground">The angle that works: </span>{p.angle}</p>}
                </div>
              ))}
            </div>
          </Section>
        )}

        <Section title="Messaging">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-1.5"><div className="text-sm font-medium">Lead with</div><List items={c.messaging.leadWith} /></div>
            <div className="space-y-1.5"><div className="text-sm font-medium">Never say or imply</div><List items={c.messaging.avoid} /></div>
          </div>
          <div className="space-y-1.5"><div className="text-sm font-medium">Their words</div><Chips items={c.messaging.vocabulary} /></div>
          {c.messaging.sampleOpening && (
            <div className="space-y-1.5">
              <div className="text-sm font-medium">Sample opening line</div>
              <blockquote className="border-l-2 pl-3 text-sm italic">{c.messaging.sampleOpening}</blockquote>
            </div>
          )}
        </Section>

        <Section title="Targeting" description="What Create campaign and Find Prospects search with.">
          <div className="grid gap-3 md:grid-cols-2 text-sm">
            <div className="space-y-1"><div className="text-xs text-muted-foreground">Job titles</div><Chips items={c.targeting.titles} /></div>
            <div className="space-y-1"><div className="text-xs text-muted-foreground">Industries</div><Chips items={c.targeting.industries} /></div>
            <div className="space-y-1"><div className="text-xs text-muted-foreground">Places</div><Chips items={c.targeting.geographies} /></div>
            <div className="space-y-1"><div className="text-xs text-muted-foreground">Organization types</div><Chips items={c.targeting.organizationTypes} /></div>
            <div className="space-y-1"><div className="text-xs text-muted-foreground">Keywords</div><Chips items={c.targeting.keywords} /></div>
            <div className="space-y-1"><div className="text-xs text-muted-foreground">Company size</div><div>{sizeRange}</div></div>
            <div className="space-y-1 md:col-span-2"><div className="text-xs text-muted-foreground">Never target</div><Chips items={c.targeting.exclude} /></div>
          </div>
        </Section>

        {f.policyWatch.length > 0 && <Section title="Policy watch"><List items={f.policyWatch} /></Section>}
        <Section title="Open questions"><List items={c.openQuestions} /></Section>

        <Section title="Sources" description={`${c.sources.length} cited.`}>
          {c.sources.length ? (
            <ol className="list-decimal pl-5 space-y-1 text-xs break-words">
              {c.sources.map((s, i) => <li key={i}><Ext url={s.url}>{s.title || s.url}</Ext></li>)}
            </ol>
          ) : <p className="text-sm text-muted-foreground">No sources yet.</p>}
        </Section>

        <RunsForRecord kind="sector" id={id} />
        <p className="text-xs text-muted-foreground">
          What happened to the prospects this sector's research shaped is under <Link href={`/research/sectors/${id}#results`} className="underline">Results</Link> on the sector's page.
        </p>
      </div>
    </Shell>
  );
}
