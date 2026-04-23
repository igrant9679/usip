/**
 * ContactOverview — Apollo.io-style contact detail panel.
 * Left column: avatar, name, title, company link, location, email, phone, social links.
 * Right column: company info card + enrichment fields.
 */
import { Mail, Phone, MapPin, Building2, ShieldCheck, ShieldAlert, ShieldQuestion, ExternalLink } from "lucide-react";
import { InfoPanel } from "./InfoPanel";
import { SocialLinks } from "./SocialLinks";

interface Contact {
  id: number;
  firstName: string;
  lastName: string;
  title?: string | null;
  email?: string | null;
  phone?: string | null;
  linkedinUrl?: string | null;
  city?: string | null;
  seniority?: string | null;
  isPrimary?: boolean;
  emailVerificationStatus?: string | null;
  customFields?: Record<string, unknown> | unknown | null;
}

interface Account {
  id: number;
  name: string;
  domain?: string | null;
  industry?: string | null;
  employeeBand?: string | null;
  revenueBand?: string | null;
  region?: string | null;
  arr?: string | null;
}

interface ContactOverviewProps {
  contact: Contact;
  account: Account | null;
  isLoading?: boolean;
  onAccountClick?: (accountId: number) => void;
}

function VerificationBadge({ status }: { status?: string | null }) {
  if (!status || status === "unknown") return null;
  if (status === "safe")
    return (
      <span className="inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300">
        <ShieldCheck className="size-3" /> Verified
      </span>
    );
  if (status === "invalid")
    return (
      <span className="inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300">
        <ShieldAlert className="size-3" /> Invalid
      </span>
    );
  return (
    <span className="inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">
      <ShieldQuestion className="size-3" /> {status.replace(/_/g, " ")}
    </span>
  );
}

function Initials({ name }: { name: string }) {
  const parts = name.trim().split(/\s+/);
  const letters =
    parts.length >= 2
      ? `${parts[0]![0]}${parts[parts.length - 1]![0]}`
      : name.slice(0, 2);
  return (
    <div className="size-14 rounded-full bg-gradient-to-br from-[#14B89A] to-[#0e8a72] flex items-center justify-center shrink-0">
      <span className="text-lg font-bold text-white uppercase">{letters}</span>
    </div>
  );
}

export function ContactOverview({ contact, account, isLoading, onAccountClick }: ContactOverviewProps) {
  if (isLoading) {
    return (
      <div className="space-y-3 animate-pulse">
        <div className="h-20 rounded-lg bg-muted" />
        <div className="h-40 rounded-lg bg-muted" />
        <div className="h-32 rounded-lg bg-muted" />
      </div>
    );
  }

  const fullName = `${contact.firstName} ${contact.lastName}`;
  const customEntries = contact.customFields
    ? Object.entries(contact.customFields as Record<string, unknown>).filter(([, v]) => v !== null && v !== undefined && v !== "")
    : [];

  return (
    <div className="space-y-3">
      {/* Hero card */}
      <div className="border rounded-lg bg-card px-4 py-4">
        <div className="flex items-start gap-4">
          <Initials name={fullName} />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-[16px] font-semibold text-foreground leading-tight">{fullName}</h2>
              {contact.isPrimary && (
                <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-[#14B89A]/15 text-[#14B89A]">
                  Primary
                </span>
              )}
            </div>
            {contact.title && (
              <div className="text-[13px] text-muted-foreground mt-0.5">{contact.title}</div>
            )}
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
            <div className="flex items-center gap-3 mt-2 flex-wrap">
              {contact.city && (
                <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                  <MapPin className="size-3" /> {contact.city}
                </span>
              )}
              <VerificationBadge status={contact.emailVerificationStatus} />
            </div>
          </div>
        </div>

        {/* Contact channels */}
        <div className="mt-3 space-y-1.5 border-t pt-3">
          {contact.email && (
            <a
              href={`mailto:${contact.email}`}
              className="flex items-center gap-2 text-[12px] text-foreground/80 hover:text-foreground transition-colors"
            >
              <Mail className="size-3.5 text-muted-foreground shrink-0" />
              {contact.email}
            </a>
          )}
          {contact.phone && (
            <a
              href={`tel:${contact.phone}`}
              className="flex items-center gap-2 text-[12px] text-foreground/80 hover:text-foreground transition-colors"
            >
              <Phone className="size-3.5 text-muted-foreground shrink-0" />
              {contact.phone}
            </a>
          )}
          <SocialLinks linkedinUrl={contact.linkedinUrl} className="mt-1" />
        </div>
      </div>

      {/* Enrichment fields */}
      <InfoPanel
        title="Contact information"
        fields={[
          { label: "SENIORITY", value: contact.seniority, hideIfEmpty: true },
          { label: "EMAIL STATUS", value: <VerificationBadge status={contact.emailVerificationStatus} />, hideIfEmpty: true },
          ...customEntries.map(([k, v]) => ({
            label: k.replace(/([A-Z])/g, " $1").toUpperCase().trim(),
            value: String(v),
          })),
        ]}
      />

      {/* Company info */}
      {account && (
        <InfoPanel
          title="Company information"
          fields={[
            { label: "COMPANY", value: account.name },
            { label: "DOMAIN", value: account.domain ? (
              <a href={`https://${account.domain}`} target="_blank" rel="noreferrer" className="text-[#14B89A] hover:underline inline-flex items-center gap-1">
                {account.domain} <ExternalLink className="size-2.5" />
              </a>
            ) : null, hideIfEmpty: true },
            { label: "INDUSTRY", value: account.industry, hideIfEmpty: true },
            { label: "EMPLOYEES", value: account.employeeBand, hideIfEmpty: true },
            { label: "REVENUE", value: account.revenueBand, hideIfEmpty: true },
            { label: "REGION", value: account.region, hideIfEmpty: true },
            { label: "ARR", value: account.arr ? `$${Number(account.arr).toLocaleString()}` : null, hideIfEmpty: true },
          ]}
        />
      )}
    </div>
  );
}
