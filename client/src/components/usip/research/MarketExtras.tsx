/**
 * What a Downstream import brought to a market beyond its overview (Research
 * phase 5): market statistics (counts and shares across the footprint, never
 * facts about one prospect) and the funders' public rules.
 */
import type { DownstreamMarketExtras } from "@shared/downstreamMap";
import { Section } from "./ResearchFields";

const STAT_LABEL: Record<string, string> = {
  organizations: "Organizations",
  realisticBuyers: "Realistic buyers",
  manageSizableGrants: "Manage sizable grants",
  fileFederalAudit: "File a federal audit",
  auditFindings: "With audit findings",
  auditFindingsSharePct: "Audit findings share (%)",
  fundedByCommission: "Funded by a commission",
  sizableGrantsNoCommissionAwardPct: "Sizable grants, no commission award (%)",
  federalSpendingPerYear: "Federal spending per year ($)",
  largest500SharePct: "Largest 500's share (%)",
  passOnToSubrecipients: "Pass money on to subrecipients",
  passedOnPerYear: "Passed on per year ($)",
  repeatGrantees: "Repeat grantees",
  buyersWithEmailPct: "Buyers with an email (%)",
};

const fmt = (v: unknown) => (typeof v === "number" ? v.toLocaleString() : String(v ?? ""));

export function MarketExtras({ extras }: { extras: DownstreamMarketExtras | null | undefined }) {
  if (!extras || (!extras.stats && !extras.funders.length)) return null;
  const st = extras.stats ?? {};
  const scalar = Object.entries(st).filter(([k, v]) => STAT_LABEL[k] && (typeof v === "number" || typeof v === "string"));
  return (
    <Section title="From Downstream" description="Market statistics and the funders' public rules, from the last Downstream import. Statistics describe the whole market, never one organization.">
      {scalar.length > 0 && (
        <div className="space-y-1">
          <div className="text-sm font-medium">Market statistics{st.asOf ? ` (as of ${String(st.asOf).slice(0, 10)})` : ""}</div>
          {st.basis ? <p className="text-xs text-muted-foreground">{String(st.basis)}</p> : null}
          <div className="grid gap-x-6 gap-y-1 sm:grid-cols-2 text-xs">
            {scalar.map(([k, v]) => (
              <div key={k} className="flex justify-between gap-3 border-b py-1">
                <span className="text-muted-foreground">{STAT_LABEL[k]}</span>
                <span className="font-medium tabular-nums">{fmt(v)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      {extras.funders.length > 0 && (
        <div className="space-y-2">
          <div className="text-sm font-medium">Funders</div>
          {extras.funders.map((f) => (
            <div key={f.ref} className="rounded-md border p-2.5 text-xs space-y-1">
              <div className="font-medium">
                {f.website ? <a href={f.website} target="_blank" rel="noopener noreferrer" className="underline">{f.name}</a> : f.name}
                {f.shortName && f.shortName !== f.name ? <span className="text-muted-foreground"> ({f.shortName})</span> : null}
              </div>
              {f.summary && <p className="text-muted-foreground">{f.summary}</p>}
              {f.programs.length > 0 && <p><span className="text-muted-foreground">Programs:</span> {f.programs.map((p) => p.name).filter(Boolean).join(", ")}</p>}
              {f.reportingCalendar && <p><span className="text-muted-foreground">Reporting:</span> {f.reportingCalendar}</p>}
              {f.closeoutDays != null && <p><span className="text-muted-foreground">Close-out:</span> {f.closeoutDays} days</p>}
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}
