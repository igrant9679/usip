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
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { LinkedInUpdateIndicator, type LinkedInChangeSummary } from "./LinkedInEnrichment";
import { PriorityScoreCell } from "../scoring/ScoreBadge";
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
  Target,
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

/* ─────────────────────────── column registry ──────────────────────────── */

export type ColumnKey =
  | "name" | "title" | "fit" | "velocityScore" | "company" | "emails" | "phone"
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
  /** Velocity Priority Score for this row (batched via scoring.scoreMap). */
  scoreCell?: { priority?: number | string | null; priorityRating?: string | null } | null;
};

/** The full registry, keyed for quick lookup + ordered render. */
export const COLUMN_REGISTRY: Record<ColumnKey, ColumnDef> = {
  name: {
    key: "name",
    label: "Name",
    icon: User,
    locked: true,
    cell: (p, ctx) => (
      <div className="min-w-0">
        <div className="font-medium whitespace-nowrap truncate flex items-center gap-1.5">
          <span className="truncate">{p.firstName} {p.lastName}</span>
          {ctx.changeSummary ? <LinkedInUpdateIndicator summary={ctx.changeSummary} /> : null}
        </div>
        {p.linkedinUrl && (
          <a
            href={p.linkedinUrl}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="text-[11px] text-blue-600 hover:underline inline-flex items-center gap-0.5"
          >
            <ExternalLink className="size-2.5" /> LinkedIn
          </a>
        )}
      </div>
    ),
  },
  title: {
    key: "title",
    label: "Job title",
    icon: Briefcase,
    cell: (p) => <div className="max-w-[180px] truncate" title={p.title ?? undefined}>{p.title ?? "—"}</div>,
  },
  fit: {
    key: "fit",
    label: "Score",
    icon: Target,
    cell: (p) => fitBadge(p.confidenceScore),
  },
  velocityScore: {
    key: "velocityScore",
    label: "Velocity Score",
    icon: Gauge,
    cell: (p, ctx) => (
      <PriorityScoreCell
        objectType="person"
        objectId={p.id}
        priority={ctx.scoreCell?.priority ?? null}
        rating={(ctx.scoreCell?.priorityRating as any) ?? null}
      />
    ),
  },
  company: {
    key: "company",
    label: "Company",
    icon: Building2,
    cell: (p) => (
      <div className="flex items-center gap-1.5 max-w-[170px]">
        <Building2 className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate" title={p.company ?? undefined}>{p.company ?? "—"}</span>
      </div>
    ),
  },
  emails: {
    key: "emails",
    label: "Emails",
    icon: Mail,
    cell: (p) =>
      p.email ? (
        <div className="flex items-center gap-1 max-w-[210px]">
          <span className="text-xs truncate min-w-0" title={p.email}>{p.email}</span>
          {emailStatusBadge(p.emailStatus)}
        </div>
      ) : (
        <span className="text-xs text-muted-foreground inline-flex items-center gap-1"><Mail className="size-3" /> —</span>
      ),
  },
  phone: {
    key: "phone",
    label: "Phone numbers",
    icon: Phone,
    cell: (p) => (p.phone ? <span className="text-xs">{p.phone}</span> : <span className="text-xs text-muted-foreground">Request phone number</span>),
  },
  actions: {
    key: "actions",
    label: "Actions",
    icon: MousePointerClick,
    locked: true,
    cell: (p, ctx) => (
      <div className="flex items-center gap-0.5" onClick={(e) => e.stopPropagation()}>
        {[
          { a: "email", icon: Mail, title: "Email" },
          { a: "call", icon: Phone, title: "Call" },
          { a: "sequence", icon: Activity, title: "Add to sequence" },
        ].map(({ a, icon: Icon, title }) => (
          <button
            key={a}
            type="button"
            title={title}
            onClick={() => ctx.onAction?.(a, p)}
            className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted"
          >
            <Icon className="size-3.5" />
          </button>
        ))}
      </div>
    ),
  },
  links: {
    key: "links",
    label: "Links",
    icon: Link2,
    cell: (p) =>
      p.linkedinUrl ? (
        <a
          href={p.linkedinUrl}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          title="LinkedIn profile"
          className="inline-flex p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted"
        >
          <Link2 className="size-3.5" />
        </a>
      ) : (
        muted
      ),
  },
  location: {
    key: "location",
    label: "Location",
    icon: MapPin,
    cell: (p) => (
      <div className="max-w-[150px] truncate text-xs text-muted-foreground">
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

/** Default displayed columns, in order (≈ Apollo's default set). */
export const DEFAULT_COLUMNS: ColumnKey[] = [
  "name", "title", "velocityScore", "fit", "company", "emails", "phone", "actions", "links", "location", "industries", "keywords",
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
