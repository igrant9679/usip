/**
 * What the Research module knows about a company (2026-10-16): where it came
 * from, the research sector it belongs to, and, for a company a Downstream
 * import brought in, its public award and the seller's fit. Renders nothing
 * for a company research has never touched.
 */
import { useState } from "react";
import { Link } from "wouter";
import { trpc } from "@/lib/trpc";
import { Badge } from "@/components/ui/badge";
import { companySourceLabel, isResearchSource } from "@shared/researchSource";
import { mostRelevantAward, storedAwards } from "@shared/downstreamMap";

type Award = { ref?: string; funder?: string; program?: string; project?: string; title?: string; amount?: string; year?: string; stage?: string; startDate?: string; endDate?: string; sourceUrl?: string };
type Fit = { product?: string; alsoFits?: string[]; flags?: string[]; reasons?: string[]; openingLine?: string };

const STAGE: Record<string, string> = {
  "closing-out": "Closing out",
  "ends-within-6-months": "Ends within 6 months",
  "ends-in-6-12-months": "Ends in 6 to 12 months",
  active: "Active",
  "starting-soon": "Starting soon",
  ended: "Ended",
};
const PRODUCT: Record<string, string> = { grantmaker: "Grantmaker", run: "Run", "discover-raise": "Discover & Raise" };
const FLAG: Record<string, string> = { "financial-distress": "Financial distress: do not contact now", "small-budget": "Small budget", "size-unknown": "Size unknown", "very-small": "Very small" };

export function CompanyResearchCard({ account }: { account: { sourceType?: string | null; researchSectorId?: number | null; customFields?: unknown } }) {
  const cf = (account.customFields && typeof account.customFields === "object" ? account.customFields : {}) as Record<string, unknown>;
  // Every award (2026-10-16); companies imported earlier may hold only the one they led with.
  const list = storedAwards(cf.downstreamAwards);
  // The same rule the copy uses (downstreamAccountFor), so the page and the copy agree.
  const lead = ((mostRelevantAward(list) ?? cf.downstreamAward) ?? null) as Award | null;
  const awards = (list.length ? list : lead ? [lead] : []) as Award[];
  const [showAll, setShowAll] = useState(false);
  const fit = (cf.downstreamFit ?? null) as Fit | null;
  const touched = isResearchSource(account.sourceType) || account.researchSectorId != null || !!cf.downstreamRef;
  const { data: sectors } = trpc.research.sectors.options.useQuery(undefined, { enabled: touched && account.researchSectorId != null, staleTime: 60_000 });
  if (!touched) return null;
  const sector = sectors?.find((s) => s.id === account.researchSectorId);

  return (
    <section className="rounded-lg border border-border p-4 space-y-3">
      <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Research</div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
        <div>
          <div className="text-[11px] text-muted-foreground">Source</div>
          <div className="flex items-center gap-1.5">
            {companySourceLabel(account.sourceType)}
            {isResearchSource(account.sourceType) && <Badge variant="outline" className="text-[10px] border-transparent bg-violet-500/15 text-violet-700 dark:text-violet-300">Research</Badge>}
          </div>
        </div>
        <div>
          <div className="text-[11px] text-muted-foreground">Research sector</div>
          {account.researchSectorId != null ? (
            <Link href={`/research/sectors/${account.researchSectorId}/report`} className="underline underline-offset-2">{sector ? `${sector.marketName} › ${sector.name}` : "Open the sector"}</Link>
          ) : <span className="text-muted-foreground">None</span>}
        </div>
      </div>

      {awards.length > 0 && (
        <div className="rounded-md border p-3 space-y-2 text-sm">
          <div className="text-[11px] text-muted-foreground">{awards.length === 1 ? "Public award" : `Public awards (${awards.length}), newest first`}</div>
          {(showAll ? awards : awards.slice(0, 5)).map((award, i) => {
            const leads = !!lead && (award.ref ? award.ref === lead.ref : award === lead);
            return (
              <div key={award.ref ?? i} className={`space-y-0.5 ${i > 0 ? "border-t pt-2" : ""}`}>
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="font-medium">{[award.funder, award.amount].filter(Boolean).join(" · ") || award.program}</span>
                  {(award.project || award.title) && <span>for {award.project || award.title}</span>}
                  {leads && awards.length > 1 && <Badge variant="outline" className="text-[10px] border-transparent bg-violet-500/15 text-violet-700 dark:text-violet-300" title="The award outreach copy leads with">Leads the copy</Badge>}
                </div>
                <div className="text-xs text-muted-foreground">
                  {[award.program, award.year, award.stage ? STAGE[award.stage] : null, [award.startDate, award.endDate].filter(Boolean).join(" to ")].filter(Boolean).join(" · ")}
                  {award.sourceUrl && <> · <a href={award.sourceUrl} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">Source</a></>}
                </div>
              </div>
            );
          })}
          {awards.length > 5 && (
            <button type="button" className="text-xs underline underline-offset-2" onClick={() => setShowAll((v) => !v)}>
              {showAll ? "Show fewer" : `Show all ${awards.length}`}
            </button>
          )}
        </div>
      )}

      {fit && (
        <div className="rounded-md border p-3 space-y-1.5 text-sm">
          <div className="text-[11px] text-muted-foreground">Fit for what you sell</div>
          {fit.product && <div><span className="font-medium">{PRODUCT[fit.product] ?? fit.product}</span>{fit.alsoFits?.length ? <span className="text-muted-foreground"> · also {fit.alsoFits.map((p) => PRODUCT[p] ?? p).join(", ")}</span> : null}</div>}
          {fit.flags && fit.flags.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {fit.flags.map((f) => (
                <Badge key={f} variant="outline" className={`text-[10px] ${f === "financial-distress" ? "border-destructive/40 text-destructive" : ""}`}>{FLAG[f] ?? f}</Badge>
              ))}
            </div>
          )}
          {fit.reasons && fit.reasons.length > 0 && <ul className="list-disc pl-4 text-xs text-muted-foreground space-y-0.5">{fit.reasons.slice(0, 4).map((r, i) => <li key={i}>{r}</li>)}</ul>}
          {fit.openingLine && <blockquote className="border-l-2 pl-2.5 text-xs italic">{fit.openingLine}</blockquote>}
        </div>
      )}
    </section>
  );
}
