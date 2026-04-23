/**
 * OpportunityOverview — Apollo/Salesforce-style deal detail panel.
 * Left column: deal info (stage badge, value, close date, win prob, next step, lost reason, days in stage).
 * Right column: associated account card + contacts with roles.
 */
import { Building2, ExternalLink, TrendingUp, Calendar, Clock } from "lucide-react";
import { InfoPanel } from "./InfoPanel";
import { AssociatedEntitiesList, type AssociatedEntity } from "./AssociatedEntitiesList";

const STAGE_COLORS: Record<string, string> = {
  discovery: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
  qualified: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300",
  proposal: "bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-300",
  negotiation: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
  won: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
  lost: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300",
};

const STAGE_LABELS: Record<string, string> = {
  discovery: "Discovery",
  qualified: "Qualified",
  proposal: "Proposal",
  negotiation: "Negotiation",
  won: "Won",
  lost: "Lost",
};

interface Opportunity {
  id: number;
  name: string;
  stage: string;
  value: string;
  winProb: number;
  closeDate?: Date | string | null;
  daysInStage?: number;
  nextStep?: string | null;
  lostReason?: string | null;
  aiNote?: string | null;
  customFields?: Record<string, unknown> | unknown | null;
}

interface Account {
  id: number;
  name: string;
  domain?: string | null;
  industry?: string | null;
}

interface ContactRole {
  id: number;
  contactId: number;
  role: string;
  isPrimary: boolean;
  contact: {
    id: number;
    firstName: string;
    lastName: string;
    title?: string | null;
    email?: string | null;
  } | null;
}

interface OpportunityOverviewProps {
  opportunity: Opportunity;
  account: Account | null;
  contactRoles: ContactRole[];
  isLoading?: boolean;
  onAccountClick?: (accountId: number) => void;
  onContactClick?: (contactId: number) => void;
}

function fmtDate(d: Date | string | null | undefined): string {
  if (!d) return "—";
  const dt = d instanceof Date ? d : new Date(d);
  return dt.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function fmtCurrency(v: string | number): string {
  const n = Number(v);
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}K`;
  return `$${n.toLocaleString()}`;
}

function WinProbBar({ prob }: { prob: number }) {
  const color = prob >= 70 ? "#14B89A" : prob >= 40 ? "#f59e0b" : "#ef4444";
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
        <div className="h-full rounded-full transition-all" style={{ width: `${prob}%`, backgroundColor: color }} />
      </div>
      <span className="text-[12px] font-medium" style={{ color }}>{prob}%</span>
    </div>
  );
}

export function OpportunityOverview({
  opportunity,
  account,
  contactRoles,
  isLoading,
  onAccountClick,
  onContactClick,
}: OpportunityOverviewProps) {
  if (isLoading) {
    return (
      <div className="space-y-3 animate-pulse">
        <div className="h-24 rounded-lg bg-muted" />
        <div className="h-48 rounded-lg bg-muted" />
        <div className="h-32 rounded-lg bg-muted" />
      </div>
    );
  }

  const customEntries = opportunity.customFields
    ? Object.entries(opportunity.customFields as Record<string, unknown>).filter(([, v]) => v !== null && v !== undefined && v !== "")
    : [];

  const contactEntities: AssociatedEntity[] = contactRoles
    .filter((r) => r.contact)
    .map((r) => ({
      id: r.contact!.id,
      name: `${r.contact!.firstName} ${r.contact!.lastName}`,
      subtitle: [r.contact!.title, r.role.replace(/_/g, " ")].filter(Boolean).join(" · "),
      badge: r.isPrimary ? "Primary" : undefined,
      badgeTone: "success" as const,
    }));

  return (
    <div className="space-y-3">
      {/* Hero card */}
      <div className="border rounded-lg bg-card px-4 py-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <h2 className="text-[15px] font-semibold text-foreground leading-tight truncate">{opportunity.name}</h2>
            {account && (
              <button
                type="button"
                onClick={() => onAccountClick?.(account.id)}
                className="inline-flex items-center gap-1 text-[12px] text-[#14B89A] hover:underline mt-0.5"
              >
                <Building2 className="size-3" />
                {account.name}
                <ExternalLink className="size-2.5 opacity-60" />
              </button>
            )}
          </div>
          <span className={`text-[11px] font-semibold px-2.5 py-1 rounded-full shrink-0 ${STAGE_COLORS[opportunity.stage] ?? STAGE_COLORS.discovery}`}>
            {STAGE_LABELS[opportunity.stage] ?? opportunity.stage}
          </span>
        </div>

        {/* KPI row */}
        <div className="mt-3 grid grid-cols-3 gap-3 border-t pt-3">
          <div>
            <div className="text-[10px] uppercase tracking-widest text-muted-foreground font-medium mb-0.5">Value</div>
            <div className="text-[15px] font-bold text-foreground">{fmtCurrency(opportunity.value)}</div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-widest text-muted-foreground font-medium mb-0.5">Close date</div>
            <div className="text-[13px] font-medium text-foreground flex items-center gap-1">
              <Calendar className="size-3 text-muted-foreground" />
              {fmtDate(opportunity.closeDate)}
            </div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-widest text-muted-foreground font-medium mb-1">Win prob</div>
            <WinProbBar prob={opportunity.winProb} />
          </div>
        </div>
      </div>

      {/* Deal information */}
      <InfoPanel
        title="Deal information"
        fields={[
          { label: "STAGE", value: (
            <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${STAGE_COLORS[opportunity.stage] ?? ""}`}>
              {STAGE_LABELS[opportunity.stage] ?? opportunity.stage}
            </span>
          )},
          { label: "VALUE", value: fmtCurrency(opportunity.value) },
          { label: "WIN PROBABILITY", value: <WinProbBar prob={opportunity.winProb} /> },
          { label: "CLOSE DATE", value: fmtDate(opportunity.closeDate) },
          { label: "DAYS IN STAGE", value: opportunity.daysInStage != null ? (
            <span className="inline-flex items-center gap-1">
              <Clock className="size-3 text-muted-foreground" />
              {opportunity.daysInStage} day{opportunity.daysInStage === 1 ? "" : "s"}
            </span>
          ) : null, hideIfEmpty: true },
          { label: "NEXT STEP", value: opportunity.nextStep, hideIfEmpty: true },
          { label: "LOST REASON", value: opportunity.lostReason, hideIfEmpty: true },
          { label: "AI NOTE", value: opportunity.aiNote, hideIfEmpty: true },
          ...customEntries.map(([k, v]) => ({
            label: k.replace(/([A-Z])/g, " $1").toUpperCase().trim(),
            value: String(v),
          })),
        ]}
      />

      {/* Account card */}
      {account && (
        <InfoPanel
          title="Account"
          collapsible={false}
          fields={[
            { label: "NAME", value: (
              <button type="button" onClick={() => onAccountClick?.(account.id)} className="text-[#14B89A] hover:underline text-left">
                {account.name}
              </button>
            )},
            { label: "DOMAIN", value: account.domain ? (
              <a href={`https://${account.domain}`} target="_blank" rel="noreferrer" className="text-[#14B89A] hover:underline inline-flex items-center gap-1">
                {account.domain} <ExternalLink className="size-2.5" />
              </a>
            ) : null, hideIfEmpty: true },
            { label: "INDUSTRY", value: account.industry, hideIfEmpty: true },
          ]}
        />
      )}

      {/* Contact roles */}
      <AssociatedEntitiesList
        title="Key contacts"
        entities={contactEntities}
        onSelect={onContactClick ? (e) => onContactClick(e.id) : undefined}
        emptyMessage="No contacts linked to this deal yet."
      />
    </div>
  );
}
