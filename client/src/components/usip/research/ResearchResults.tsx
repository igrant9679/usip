/**
 * Results (Research phase 6): what happened to the prospects whose Revenue
 * Engine copy a sector or persona shaped. Which pains, lead-with points,
 * hooks and opening lines got replies, and how often the brief check passed.
 * Rates appear only once enough prospects were contacted to compare
 * (MIN_SAMPLE); below that the counts are shown as they are.
 */
import { useState } from "react";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { QueryError, TableSkeleton } from "@/components/usip/Shell";
import { BarChart3 } from "lucide-react";
import { MIN_SAMPLE, hookLabel, pct, replyLabel, type Tally } from "@shared/researchResults";
import { Section } from "./ResearchFields";

type Results = RouterOutputs["research"]["results"]["sector"];

const fmtDate = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "");

function Summary({ r, what }: { r: Results; what: string }) {
  const t = r.total;
  const c = r.check;
  return (
    <div className="space-y-1 text-sm">
      <p>
        <span className="font-medium">{t.written}</span> {t.written === 1 ? "prospect's" : "prospects'"} copy written with this {what}
        {r.since ? ` since ${fmtDate(r.since)}` : ""}: <span className="font-medium">{t.contacted}</span> contacted, {replyLabel(t)}
        {t.positive ? `, ${t.positive} positive` : ""}, {t.meetings} {t.meetings === 1 ? "meeting" : "meetings"}.
      </p>
      {c.checked > 0 && (
        <p className="text-muted-foreground">
          Brief check: {c.passed} of {c.checked} passed{c.checked >= MIN_SAMPLE ? ` (${pct(c.passed, c.checked)}%)` : ""}
          {c.held ? `; ${c.held} held for breaking an avoid rule` : ""}{c.errors ? `; ${c.errors} could not be checked` : ""}.
        </p>
      )}
      {r.capped && <p className="text-xs text-muted-foreground">Counting the newest 5,000 prospects.</p>}
    </div>
  );
}

function Rows<T extends Tally>({ title, hint, rows, label }: { title: string; hint?: string; rows: T[]; label: (r: T) => React.ReactNode }) {
  if (!rows.length) return null;
  return (
    <div className="space-y-1.5">
      <div className="text-sm font-medium">{title}</div>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-muted-foreground border-b">
              <th className="py-1 pr-3 font-normal">&nbsp;</th>
              <th className="py-1 px-2 font-normal text-right whitespace-nowrap">Written</th>
              <th className="py-1 px-2 font-normal text-right whitespace-nowrap">Contacted</th>
              <th className="py-1 px-2 font-normal text-right whitespace-nowrap">Replied</th>
              <th className="py-1 pl-2 font-normal text-right whitespace-nowrap">Meetings</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const few = r.contacted < MIN_SAMPLE;
              return (
                <tr key={i} className={`border-b last:border-0 align-top ${r.written === 0 ? "text-muted-foreground" : ""}`}>
                  <td className="py-1.5 pr-3">{label(r)}</td>
                  <td className="py-1.5 px-2 text-right tabular-nums">{r.written}</td>
                  <td className="py-1.5 px-2 text-right tabular-nums">{r.contacted}</td>
                  <td className="py-1.5 px-2 text-right tabular-nums whitespace-nowrap">
                    {r.replied}{!few && r.contacted ? <span className="text-muted-foreground"> ({pct(r.replied, r.contacted)}%)</span> : null}
                  </td>
                  <td className="py-1.5 pl-2 text-right tabular-nums">{r.meetings}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ResultsBody({ r, what, showPersonas }: { r: Results; what: string; showPersonas: boolean }) {
  if (r.total.written === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No Revenue Engine copy has been written with this {what} yet. Results appear here once a campaign writes and sends sequences with it:
        who was contacted, who replied, and which pains and opening lines the replies came from.
      </p>
    );
  }
  const rankHint = `Best first, by reply rate. A rate shows once ${MIN_SAMPLE} or more were contacted; below that the counts are too few to compare.`;
  return (
    <div className="space-y-5">
      <Summary r={r} what={what} />
      {showPersonas && <Rows title="By persona" rows={r.personas} label={(p) => p.name} />}
      <Rows
        title="Pains"
        hint={`The pains the brief check found in each prospect's copy. ${rankHint}`}
        rows={r.pains}
        label={(p) => (
          <span>
            {p.text}
            {!p.inResearch && <Badge variant="outline" className="ml-1 text-[10px]">no longer in the research</Badge>}
            {p.written === 0 && <span className="ml-1 text-[10px]">(not used yet)</span>}
          </span>
        )}
      />
      <Rows
        title="Lead-with points"
        hint="The points each prospect's first message opened on."
        rows={r.leads}
        label={(p) => (
          <span>
            {p.text}
            {!p.inResearch && <Badge variant="outline" className="ml-1 text-[10px]">no longer in the research</Badge>}
            {p.written === 0 && <span className="ml-1 text-[10px]">(not used yet)</span>}
          </span>
        )}
      />
      <Rows title="What the opener was built on" hint="The hook the Revenue Engine opened each sequence with." rows={r.hooks} label={(h) => hookLabel(h.hookType)} />
      <div className="space-y-1.5">
        <div className="text-sm font-medium">Opening lines that got replies</div>
        {r.repliedOpeners.length === 0 ? (
          <p className="text-xs text-muted-foreground">No replies yet.</p>
        ) : (
          <ul className="space-y-2">
            {r.repliedOpeners.map((o, i) => (
              <li key={i} className="text-xs border-l-2 pl-2.5">
                <div className="text-sm">“{o.line}”</div>
                <div className="text-muted-foreground mt-0.5 flex flex-wrap items-center gap-1.5">
                  {[o.title, o.company].filter(Boolean).join(", ") || "A prospect"}
                  {o.at && <span>· replied {fmtDate(o.at)}</span>}
                  {o.positive && <Badge variant="secondary" className="text-[10px]">positive</Badge>}
                  {o.meeting && <Badge variant="secondary" className="text-[10px]">meeting</Badge>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/** The Results section of a sector page. */
export function SectorResults({ sectorId }: { sectorId: number }) {
  const q = trpc.research.results.sector.useQuery({ id: sectorId });
  return (
    <Section
      id="results"
      title="Results"
      description="What happened to the prospects whose Revenue Engine copy this sector shaped: replies and meetings by persona, pain, lead-with point and opener."
    >
      {q.error ? <QueryError message={q.error.message} onRetry={() => q.refetch()} /> : !q.data ? <TableSkeleton rows={3} /> : <ResultsBody r={q.data} what="sector" showPersonas />}
    </Section>
  );
}

/** Contacted and replied for every persona, for persona lists. */
export function usePersonaResultSummaries() {
  return trpc.research.results.personas.useQuery(undefined, { staleTime: 60_000 }).data ?? {};
}

/** A persona's results in one badge; it opens the full results. Nothing when no copy used the persona yet. */
export function PersonaResultsBadge({ personaId, name, tally }: { personaId: number; name: string; tally: Tally | undefined }) {
  const [open, setOpen] = useState(false);
  if (!tally || tally.written === 0) return null;
  return (
    <>
      <Badge variant="outline" className="text-[10px] gap-1 cursor-pointer hover:bg-accent" onClick={() => setOpen(true)} title="See this persona's results">
        <BarChart3 className="size-3" /> {tally.contacted ? replyLabel(tally) : `${tally.written} written, none sent yet`}
      </Badge>
      {open && <PersonaResultsDialog personaId={personaId} name={name} onClose={() => setOpen(false)} />}
    </>
  );
}

function PersonaResultsDialog({ personaId, name, onClose }: { personaId: number; name: string; onClose: () => void }) {
  const q = trpc.research.results.persona.useQuery({ id: personaId });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Results: {name}</DialogTitle>
          <DialogDescription>What happened to the prospects whose Revenue Engine copy this persona shaped.</DialogDescription>
        </DialogHeader>
        {q.error ? <QueryError message={q.error.message} onRetry={() => q.refetch()} /> : !q.data ? <TableSkeleton rows={3} /> : <ResultsBody r={q.data} what="persona" showPersonas={false} />}
      </DialogContent>
    </Dialog>
  );
}
