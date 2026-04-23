/**
 * AccountOverview — Apollo.io-style account detail panel.
 * Left column: company info (domain, industry, employees, revenue, region, ARR, notes).
 * Right column: associated contacts list (clickable rows).
 */
import { Globe, ExternalLink } from "lucide-react";
import { InfoPanel } from "./InfoPanel";
import { AssociatedEntitiesList, type AssociatedEntity } from "./AssociatedEntitiesList";

interface Account {
  id: number;
  name: string;
  domain?: string | null;
  industry?: string | null;
  employeeBand?: string | null;
  revenueBand?: string | null;
  region?: string | null;
  arr?: string | null;
  notes?: string | null;
  color?: string | null;
  customFields?: Record<string, unknown> | unknown | null;
}

interface Contact {
  id: number;
  firstName: string;
  lastName: string;
  title?: string | null;
  email?: string | null;
  emailVerificationStatus?: string | null;
}

interface AccountOverviewProps {
  account: Account;
  contacts: Contact[];
  isLoading?: boolean;
  onContactClick?: (contactId: number) => void;
}

function AccountInitials({ name, color }: { name: string; color?: string | null }) {
  const letters = name.slice(0, 2).toUpperCase();
  const bg = color ?? "#14B89A";
  return (
    <div
      className="size-14 rounded-xl flex items-center justify-center shrink-0"
      style={{ backgroundColor: `${bg}22`, border: `1.5px solid ${bg}44` }}
    >
      <span className="text-lg font-bold" style={{ color: bg }}>{letters}</span>
    </div>
  );
}

export function AccountOverview({ account, contacts, isLoading, onContactClick }: AccountOverviewProps) {
  if (isLoading) {
    return (
      <div className="space-y-3 animate-pulse">
        <div className="h-20 rounded-lg bg-muted" />
        <div className="h-48 rounded-lg bg-muted" />
        <div className="h-40 rounded-lg bg-muted" />
      </div>
    );
  }

  const customEntries = account.customFields
    ? Object.entries(account.customFields as Record<string, unknown>).filter(([, v]) => v !== null && v !== undefined && v !== "")
    : [];

  const contactEntities: AssociatedEntity[] = contacts.map((c) => ({
    id: c.id,
    name: `${c.firstName} ${c.lastName}`,
    subtitle: [c.title, c.email].filter(Boolean).join(" · "),
    badge: c.emailVerificationStatus === "safe" ? "Verified" : c.emailVerificationStatus === "invalid" ? "Invalid" : undefined,
    badgeTone: c.emailVerificationStatus === "safe" ? "success" : c.emailVerificationStatus === "invalid" ? "danger" : "neutral",
  }));

  return (
    <div className="space-y-3">
      {/* Hero card */}
      <div className="border rounded-lg bg-card px-4 py-4">
        <div className="flex items-start gap-4">
          <AccountInitials name={account.name} color={account.color} />
          <div className="flex-1 min-w-0">
            <h2 className="text-[16px] font-semibold text-foreground leading-tight">{account.name}</h2>
            {account.domain && (
              <a
                href={`https://${account.domain}`}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-[12px] text-[#14B89A] hover:underline mt-0.5"
              >
                <Globe className="size-3" />
                {account.domain}
                <ExternalLink className="size-2.5 opacity-60" />
              </a>
            )}
            <div className="flex items-center gap-3 mt-1.5 flex-wrap text-[11px] text-muted-foreground">
              {account.industry && <span>{account.industry}</span>}
              {account.region && <span>· {account.region}</span>}
              {account.employeeBand && <span>· {account.employeeBand} employees</span>}
            </div>
          </div>
        </div>
      </div>

      {/* Account details */}
      <InfoPanel
        title="Account information"
        fields={[
          { label: "DOMAIN", value: account.domain ? (
            <a href={`https://${account.domain}`} target="_blank" rel="noreferrer" className="text-[#14B89A] hover:underline inline-flex items-center gap-1">
              {account.domain} <ExternalLink className="size-2.5" />
            </a>
          ) : null, hideIfEmpty: true },
          { label: "INDUSTRY", value: account.industry, hideIfEmpty: true },
          { label: "EMPLOYEES", value: account.employeeBand, hideIfEmpty: true },
          { label: "REVENUE BAND", value: account.revenueBand, hideIfEmpty: true },
          { label: "REGION", value: account.region, hideIfEmpty: true },
          { label: "ARR", value: account.arr ? `$${Number(account.arr).toLocaleString()}` : null, hideIfEmpty: true },
          { label: "NOTES", value: account.notes, hideIfEmpty: true },
          ...customEntries.map(([k, v]) => ({
            label: k.replace(/([A-Z])/g, " $1").toUpperCase().trim(),
            value: String(v),
          })),
        ]}
      />

      {/* Associated contacts */}
      <AssociatedEntitiesList
        title="People"
        entities={contactEntities}
        onSelect={onContactClick ? (e) => onContactClick(e.id) : undefined}
        emptyMessage="No contacts associated with this account yet."
      />
    </div>
  );
}
