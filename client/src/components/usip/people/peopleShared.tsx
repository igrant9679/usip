/**
 * peopleShared — shared model for the People page top-action controls.
 *
 * Centralises everything the People surface and its dropdowns/panels need so
 * the page JSX stays thin (per the build brief): the Prospect row type, the
 * small badge/number helpers, the COLUMN REGISTRY that drives which table
 * columns render, the catalogue of *available* fields (Person/Company groups
 * for the "Add fields to table" picker), the sort-field catalogue, and a
 * generic comparator. Mirrors Apollo's People table fields by label while
 * mapping each onto the data Velocity actually has (unknown → em-dash).
 */
import { useState, type ReactNode, type MouseEvent } from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { InitialsAvatar } from "../ProspectAvatar";
import { LinkedInUpdateIndicator, RowEnrichAction, type LinkedInChangeSummary } from "./LinkedInEnrichment";
import { AddToListMenu, SequenceMenu } from "./SelectionToolbar";
import { ScoreBadge, ScorePopover } from "../scoring/ScoreBadge";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import {
  User,
  Gauge,
  Briefcase,
  Building2,
  Mail,
  Phone,
  MousePointerClick,
  Link2,
  MapPin,
  Users,
  Factory,
  Tag,
  GraduationCap,
  Globe,
  CheckCircle2,
  Bookmark,
  Activity,
  Award,
  ListChecks,
  Calendar,
  Eye,
  FileText,
  ExternalLink,
  Copy,
  ListPlus,
  Send,
  MoreHorizontal,
} from "lucide-react";

/* ─────────────────────────────── types ────────────────────────────────── */

export type Prospect = {
  id: number;
  firstName: string;
  lastName: string;
  title?: string | null;
  seniority?: string | null;
  email?: string | null;
  emailStatus?: string | null;
  phone?: string | null;
  linkedinUrl?: string | null;
  city?: string | null;
  state?: string | null;
  country?: string | null;
  company?: string | null;
  companyDomain?: string | null;
  industry?: string | null;
  education?: string | null;
  confidenceScore?: number | null;
  confidenceTier?: string | null;
  verificationStatus?: string | null;
  linkedLeadId?: number | null;
  linkedContactId?: number | null;
};

/* ───────────────────────── badges / helpers ───────────────────────────── */

/** Email-status pill matching the Prospects page styling. */
export function emailStatusBadge(status?: string | null) {
  if (!status) return null;
  const map: Record<string, { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
    valid: { label: "Valid", variant: "default" },
    verified: { label: "Verified", variant: "default" },
    accept_all: { label: "Catch-all", variant: "secondary" },
    risky: { label: "Risky", variant: "secondary" },
    invalid: { label: "Invalid", variant: "destructive" },
    unverified: { label: "Unverified", variant: "secondary" },
    unavailable: { label: "Unavailable", variant: "outline" },
  };
  const s = map[status] ?? { label: status, variant: "outline" as const };
  return <Badge variant={s.variant} className="text-[10px] px-1.5 py-0">{s.label}</Badge>;
}

/** ICP-fit pill from a 0–100 confidence score. */
export function fitBadge(score?: number | null) {
  if (score === null || score === undefined) return <span className="text-xs text-muted-foreground">—</span>;
  const color = score >= 70 ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300"
    : score >= 40 ? "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300"
    : "bg-rose-100 text-rose-800 dark:bg-rose-900/30 dark:text-rose-300";
  return <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs font-semibold tabular-nums ${color}`} title="ICP-fit confidence score">{score}</span>;
}

/** Compact human number for the stats strip (1.2k etc.). */
export function fmtNum(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n % 1_000 === 0 ? 0 : 1)}k`;
  return String(n);
}

const muted = <span className="text-xs text-muted-foreground">—</span>;

/* ─────────────────────── redesigned cell building blocks ──────────────── */

/** Tiny "in" chip linking to the prospect's LinkedIn profile (Name cell). */
function LinkedInChip({ url, className }: { url: string; className?: string }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
      title="Open LinkedIn profile"
      className={cn(
        "inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[3px] bg-[#0A66C2] text-[8px] font-bold leading-none text-white transition-opacity hover:opacity-80",
        className,
      )}
    >
      in
    </a>
  );
}

/** Deterministic hue for the company letter-tile fallback (mirrors the
 *  initials-avatar approach — original palette, not copied from anywhere). */
function hueFor(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
}

/** Company logo tile: favicon when a domain is known, letter tile otherwise.
 *  Never breaks row alignment — every state renders the same 20px square. */
function CompanyLogo({ name, domain }: { name?: string | null; domain?: string | null }) {
  const [failed, setFailed] = useState(false);
  if (domain && !failed) {
    return (
      <img
        src={`https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=32`}
        onError={() => setFailed(true)}
        alt=""
        loading="lazy"
        className="size-5 shrink-0 rounded-[4px] bg-white object-contain ring-1 ring-border/60"
      />
    );
  }
  if (name) {
    const hue = hueFor(name);
    return (
      <div
        aria-hidden
        className="flex size-5 shrink-0 items-center justify-center rounded-[4px] text-[10px] font-semibold ring-1 ring-border/60 select-none"
        style={{ backgroundColor: `hsl(${hue} 45% 92%)`, color: `hsl(${hue} 55% 32%)` }}
      >
        {name.trim().charAt(0).toUpperCase()}
      </div>
    );
  }
  return (
    <div className="flex size-5 shrink-0 items-center justify-center rounded-[4px] bg-muted ring-1 ring-border/60">
      <Building2 className="size-3 text-muted-foreground" />
    </div>
  );
}

/** Stacked icon-over-label row action (Actions column), matching the enrich
 *  action's stacked variant so the group reads as one control cluster. */
const rowActionCls =
  "flex flex-col items-center gap-0.5 rounded-md px-1.5 py-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50";

function RowActionButton({
  icon: Icon,
  label,
  title,
  onClick,
}: {
  icon: any;
  label: string;
  title?: string;
  onClick: (e: MouseEvent<HTMLButtonElement>) => void;
}) {
  return (
    <button type="button" title={title ?? label} onClick={onClick} className={rowActionCls}>
      <Icon className="size-3.5" />
      <span className="text-[9px] font-medium leading-none whitespace-nowrap">{label}</span>
    </button>
  );
}

/** Small icon link for the Links column; renders a muted placeholder when the
 *  target is missing so the icons stay vertically aligned across rows. */
function LinkIcon({ href, icon: Icon, title }: { href?: string | null; icon: any; title: string }) {
  if (!href) {
    return (
      <span className="inline-flex p-1 text-muted-foreground/30" aria-hidden>
        <Icon className="size-3.5" />
      </span>
    );
  }
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
      title={title}
      className="inline-flex rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
    >
      <Icon className="size-3.5" />
    </a>
  );
}

/* ─────────────────────────── column registry ──────────────────────────── */

export type ColumnKey =
  | "name" | "title" | "velocityScore" | "company" | "emails" | "phone"
  | "actions" | "links" | "location" | "employees" | "industries" | "keywords";

export type ColumnDef = {
  key: ColumnKey;
  /** Header + Fields-panel label (matches Apollo wording). */
  label: string;
  icon: any;
  /** Core columns that can't be removed from the table (greyed in Fields). */
  locked?: boolean;
  /** Header alignment helper. */
  headClassName?: string;
  cell: (p: Prospect, ctx: ColumnCellCtx) => ReactNode;
};

export type ColumnCellCtx = {
  /** Row action handlers, wired by the page. */
  onAction?: (action: string, p: Prospect) => void;
  /** Compact LinkedIn change summary for this row (People table indicator). */
  changeSummary?: LinkedInChangeSummary | null;
  /** Primary Fit score for this row (batched via scoring.scoreMap). The
   *  breakdown popover also surfaces the blended Velocity Priority Score. */
  scoreCell?: { score?: number | string | null; rating?: string | null } | null;
};

/** The full registry, keyed for quick lookup + ordered render. */
export const COLUMN_REGISTRY: Record<ColumnKey, ColumnDef> = {
  name: {
    key: "name",
    label: "Name",
    icon: User,
    locked: true,
    cell: (p, ctx) => {
      const fullName = `${p.firstName} ${p.lastName}`.trim();
      return (
        <div className="flex min-w-0 items-center gap-2.5">
          {/* Initials only — profile images are policy-restricted to the full
              record / preview panel (see ProspectAvatar), never the table. */}
          <InitialsAvatar name={fullName} size="sm" className="!size-7 !text-[10px]" />
          <div className="min-w-0 leading-tight">
            <div className="flex min-w-0 items-center gap-1.5">
              <span className="truncate text-[13px] font-semibold text-foreground">{fullName}</span>
              {ctx.changeSummary ? <LinkedInUpdateIndicator summary={ctx.changeSummary} /> : null}
            </div>
            {p.linkedinUrl ? <LinkedInChip url={p.linkedinUrl} className="mt-0.5" /> : null}
          </div>
        </div>
      );
    },
  },
  title: {
    key: "title",
    label: "Job title",
    icon: Briefcase,
    cell: (p) => (
      <div className="max-w-[190px] truncate text-[13px] text-foreground/90" title={p.title ?? undefined}>
        {p.title ?? "—"}
      </div>
    ),
  },
  velocityScore: {
    key: "velocityScore",
    label: "Score",
    icon: Gauge,
    cell: (p, ctx) => (
      <ScorePopover objectType="person" objectId={p.id}>
        <ScoreBadge
          score={ctx.scoreCell?.score ?? null}
          rating={(ctx.scoreCell?.rating as any) ?? null}
          muted
          className="min-w-8 justify-center rounded-md px-2 py-0.5 font-semibold"
        />
      </ScorePopover>
    ),
  },
  company: {
    key: "company",
    label: "Company",
    icon: Building2,
    cell: (p) => (
      <div className="flex min-w-0 max-w-[180px] items-center gap-2">
        <CompanyLogo name={p.company} domain={p.companyDomain} />
        <span className="truncate text-[13px]" title={p.company ?? undefined}>{p.company ?? "—"}</span>
      </div>
    ),
  },
  emails: {
    key: "emails",
    label: "Emails",
    icon: Mail,
    cell: (p) =>
      p.email ? (
        <div className="group/email flex min-w-0 max-w-[230px] items-center gap-1.5">
          <span className="min-w-0 truncate text-[12px]" title={p.email}>{p.email}</span>
          {emailStatusBadge(p.emailStatus)}
          <button
            type="button"
            title="Copy email"
            onClick={(e) => {
              e.stopPropagation();
              const write = navigator.clipboard?.writeText(p.email!);
              if (write) write.then(() => toast.success("Email copied"), () => toast.error("Could not copy"));
              else toast.error("Clipboard unavailable");
            }}
            className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover/email:opacity-100"
          >
            <Copy className="size-3" />
          </button>
        </div>
      ) : (
        <span className="text-[12px] text-muted-foreground">—</span>
      ),
  },
  phone: {
    key: "phone",
    label: "Phone numbers",
    icon: Phone,
    cell: (p) =>
      p.phone ? (
        <span className="text-[12px] tabular-nums">{p.phone}</span>
      ) : (
        <span className="whitespace-nowrap text-[12px] text-muted-foreground/80">Request phone number</span>
      ),
  },
  actions: {
    key: "actions",
    label: "Actions",
    icon: MousePointerClick,
    locked: true,
    cell: (p, ctx) => (
      <div className="flex items-center gap-0.5" onClick={(e) => e.stopPropagation()}>
        <AddToListMenu
          selectedIds={[p.id]}
          trigger={
            <button type="button" title="Add to list" className={rowActionCls}>
              <ListPlus className="size-3.5" />
              <span className="text-[9px] font-medium leading-none whitespace-nowrap">Add to list</span>
            </button>
          }
        />
        {p.email ? (
          <a
            href={`mailto:${p.email}`}
            onClick={(e) => e.stopPropagation()}
            title={`Email ${p.email}`}
            className={rowActionCls}
          >
            <Mail className="size-3.5" />
            <span className="text-[9px] font-medium leading-none whitespace-nowrap">Send email</span>
          </a>
        ) : (
          <RowActionButton icon={Mail} label="Send email" title="No email yet — open preview" onClick={() => ctx.onAction?.("email", p)} />
        )}
        <SequenceMenu
          selectedIds={[p.id]}
          trigger={
            <button type="button" title="Add to sequence" className={rowActionCls}>
              <Send className="size-3.5" />
              <span className="text-[9px] font-medium leading-none whitespace-nowrap">Sequence</span>
            </button>
          }
        />
        <RowEnrichAction prospectId={p.id} label="Enrich" />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" title="More actions" className={rowActionCls}>
              <MoreHorizontal className="size-3.5" />
              <span className="text-[9px] font-medium leading-none whitespace-nowrap">More</span>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuItem onClick={() => ctx.onAction?.("preview", p)}>
              <Eye className="size-4 mr-2" /> Quick preview
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => ctx.onAction?.("open", p)}>
              <ExternalLink className="size-4 mr-2" /> Open full record
            </DropdownMenuItem>
            {p.phone ? (
              <DropdownMenuItem onClick={() => { window.location.href = `tel:${p.phone}`; }}>
                <Phone className="size-4 mr-2" /> Call {p.phone}
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    ),
  },
  links: {
    key: "links",
    label: "Links",
    icon: Link2,
    cell: (p, ctx) => (
      <div className="flex items-center gap-0.5" onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          title="Open full record"
          onClick={() => ctx.onAction?.("open", p)}
          className="inline-flex rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <ExternalLink className="size-3.5" />
        </button>
        <LinkIcon href={p.linkedinUrl} icon={Link2} title="LinkedIn profile" />
        <LinkIcon
          href={p.companyDomain ? `https://${p.companyDomain.replace(/^https?:\/\//, "")}` : null}
          icon={Globe}
          title={p.companyDomain ? `Visit ${p.companyDomain}` : "Website"}
        />
      </div>
    ),
  },
  location: {
    key: "location",
    label: "Location",
    icon: MapPin,
    cell: (p) => (
      <div className="max-w-[160px] truncate text-[12px] text-muted-foreground" title={[p.city, p.state, p.country].filter(Boolean).join(", ") || undefined}>
        {[p.city, p.state, p.country].filter(Boolean).join(", ") || "—"}
      </div>
    ),
  },
  employees: {
    key: "employees",
    label: "Company · Number of employees",
    icon: Users,
    cell: () => muted,
  },
  industries: {
    key: "industries",
    label: "Company · Industries",
    icon: Factory,
    cell: (p) => (p.industry ? <span className="text-xs truncate max-w-[150px] inline-block">{p.industry}</span> : muted),
  },
  keywords: {
    key: "keywords",
    label: "Company · Keywords",
    icon: Tag,
    cell: () => muted,
  },
};

/** Default displayed columns, in order. Industries/keywords stay available
 *  via Search settings → Fields (column customization), not the default view. */
export const DEFAULT_COLUMNS: ColumnKey[] = [
  "name", "title", "velocityScore", "company", "emails", "phone", "actions", "links", "location",
];

/* ─────────────── "Add fields to table" — available field catalogue ─────── */

export type FieldOption = {
  /** Maps to a ColumnKey when the field is a real table column; else null. */
  columnKey: ColumnKey | null;
  label: string;
  icon: any;
  /** Count badge as seen in Apollo (purely cosmetic). */
  count?: number;
  /** Has a nested drill-in chevron in Apollo. */
  drill?: boolean;
};

export type FieldGroup = { title: string; fields: FieldOption[] };

export const PERSON_FIELD_GROUPS: FieldGroup[] = [
  {
    title: "Basic information",
    fields: [
      { columnKey: "name", label: "Name", icon: User, count: 2, drill: true },
      { columnKey: "title", label: "Job title", icon: Briefcase },
      { columnKey: "company", label: "Company", icon: Building2 },
      { columnKey: "phone", label: "Phone numbers", icon: Phone },
      { columnKey: "emails", label: "Emails", icon: Mail },
      { columnKey: null, label: "Certifications", icon: CheckCircle2 },
      { columnKey: null, label: "Awards", icon: Award },
      { columnKey: "location", label: "Location", icon: MapPin },
      { columnKey: "links", label: "Links", icon: Globe },
      { columnKey: null, label: "Owner", icon: User },
      { columnKey: null, label: "Stage", icon: Bookmark },
      { columnKey: null, label: "Lists", icon: ListChecks },
      { columnKey: null, label: "Sequences", icon: Activity },
      { columnKey: null, label: "Source", icon: FileText },
    ],
  },
  {
    title: "Person activity",
    fields: [
      { columnKey: null, label: "Engagement graph", icon: Activity },
      { columnKey: null, label: "Last activity date", icon: Calendar },
      { columnKey: null, label: "Created date", icon: Calendar },
      { columnKey: null, label: "Created by", icon: User },
      { columnKey: null, label: "Website last visit", icon: Eye },
      { columnKey: null, label: "Total visits", icon: Eye },
      { columnKey: null, label: "Page views", icon: Eye },
      { columnKey: null, label: "Pages", icon: FileText },
    ],
  },
];

export const COMPANY_FIELD_GROUPS: FieldGroup[] = [
  {
    title: "Basic information",
    fields: [
      { columnKey: "location", label: "Location", icon: MapPin, count: 5, drill: true },
      { columnKey: null, label: "Headcount growth", icon: Users, count: 3, drill: true },
      { columnKey: "company", label: "Domain", icon: Globe },
      { columnKey: "industries", label: "Industries", icon: Factory },
      { columnKey: "keywords", label: "Keywords", icon: Tag },
      { columnKey: "employees", label: "Number of employees", icon: Users },
      { columnKey: "links", label: "Links", icon: Globe },
      { columnKey: null, label: "Parent company", icon: Building2 },
      { columnKey: null, label: "Owner", icon: User },
      { columnKey: null, label: "Stage", icon: Bookmark },
      { columnKey: null, label: "Lists", icon: ListChecks },
    ],
  },
  {
    title: "Company activity",
    fields: [
      { columnKey: null, label: "Engagement graph", icon: Activity },
      { columnKey: null, label: "Last activity date", icon: Calendar },
      { columnKey: null, label: "Created date", icon: Calendar },
    ],
  },
];

/* ────────────────────────────── sorting ───────────────────────────────── */

export type SortField =
  | "relevance" | "name" | "title" | "emails" | "company" | "phone" | "employees" | "industries";
export type SortDir = "asc" | "desc";

export const SORT_FIELDS: { value: SortField; label: string }[] = [
  { value: "relevance", label: "Relevance" },
  { value: "name", label: "Name" },
  { value: "title", label: "Job title" },
  { value: "emails", label: "Emails" },
  { value: "company", label: "Company" },
  { value: "phone", label: "Phone numbers" },
  { value: "employees", label: "Company · Number of employees" },
  { value: "industries", label: "Company · Industries" },
];

/** Generic comparator over the loaded page. */
export function sortRows(rows: Prospect[], field: SortField, dir: SortDir): Prospect[] {
  const sign = dir === "asc" ? 1 : -1;
  const num = (n?: number | null) => (n ?? -1);
  const str = (s?: string | null) => (s ?? "").toLowerCase();
  const cmp = (a: Prospect, b: Prospect) => {
    switch (field) {
      case "relevance":
        return num(b.confidenceScore) - num(a.confidenceScore); // relevance is inherently high→low
      case "name":
        return `${a.firstName} ${a.lastName}`.toLowerCase().localeCompare(`${b.firstName} ${b.lastName}`.toLowerCase()) * sign;
      case "title":
        return str(a.title).localeCompare(str(b.title)) * sign;
      case "emails":
        return str(a.email).localeCompare(str(b.email)) * sign;
      case "company":
      case "employees": // no employee count → fall back to company name
        return str(a.company).localeCompare(str(b.company)) * sign;
      case "phone":
        return (Number(!!b.phone) - Number(!!a.phone)) * (dir === "asc" ? -1 : 1);
      case "industries":
        return str(a.industry).localeCompare(str(b.industry)) * sign;
      default:
        return 0;
    }
  };
  return [...rows].sort(cmp);
}

/** Default saved view: every workspace starts with the system "Default view". */
export type SavedView = {
  id: string;
  name: string;
  system?: boolean;
  starred?: boolean;
  scope?: "yours" | "shared";
  columns: ColumnKey[];
};
