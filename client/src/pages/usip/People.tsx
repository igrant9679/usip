/**
 * People — the redesigned "Prospect and enrich → People" surface (/v2/people).
 *
 * Modelled on Apollo's "Find people" page: the LEFT FILTER RAIL is the fulcrum.
 * Every filter change re-shapes the centre view (results table) and the stats
 * strip. A right-hand detail panel opens for the selected person, and an AI
 * empty-state with quick filters shows when there's nothing to display.
 *
 * Data source: the existing `prospects.list` tRPC query (server-side paginated,
 * with confidence scoring + email/verification status from the ARE engine).
 *
 * Filter split (intentional, see comments at the query):
 *   - SERVER filters change the *whole-dataset* query (and therefore the Total
 *     stat + pagination): emailStatus, verificationStatus, promoted, hasEmail.
 *   - CLIENT refinement filters narrow the *loaded page* without another round
 *     trip: free-text name/title/company/location/industry, seniority,
 *     confidence tier, has-phone, has-linkedin, and the sort order.
 * This keeps the rail responsive while the heavy filters stay correct.
 */
import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import { Shell, useAccentColor } from "@/components/usip/Shell";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from "@/components/ui/dropdown-menu";
import {
  Search,
  Upload,
  ChevronDown,
  ChevronRight,
  Filter,
  X,
  Check,
  Sparkles,
  Plus,
  Save,
  ArrowUpDown,
  SlidersHorizontal,
  Settings2,
  Mail,
  Phone,
  ExternalLink,
  Building2,
  MapPin,
  Pin,
  PinOff,
  Users,
  Briefcase,
  GraduationCap,
  Globe,
  Target,
  ListChecks,
  BarChart3,
  Loader2,
  CheckCircle2,
  Workflow,
  Lock,
  Wand2,
  Layers,
  Bookmark,
} from "lucide-react";

/* ───────────────────────── badges / helpers ───────────────────────────── */

/** Email-status pill matching the Prospects page styling. */
function emailStatusBadge(status?: string | null) {
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
function fitBadge(score?: number | null) {
  if (score === null || score === undefined) return <span className="text-xs text-muted-foreground">—</span>;
  const color = score >= 70 ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300"
    : score >= 40 ? "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300"
    : "bg-rose-100 text-rose-800 dark:bg-rose-900/30 dark:text-rose-300";
  return <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs font-semibold tabular-nums ${color}`} title="ICP-fit confidence score">{score}</span>;
}

/** Compact human number for the stats strip (1.2k etc.). */
function fmtNum(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n % 1_000 === 0 ? 0 : 1)}k`;
  return String(n);
}

/* ─────────────────────────── filter rail ──────────────────────────────── */

/** A single collapsible, pinnable filter group in the left rail. */
function FilterGroup({
  id,
  label,
  icon: Icon,
  count,
  open,
  pinned,
  locked,
  onToggle,
  onPin,
  children,
}: {
  id: string;
  label: string;
  icon: any;
  count?: number;
  open: boolean;
  pinned?: boolean;
  locked?: boolean;
  onToggle: (id: string) => void;
  onPin?: (id: string) => void;
  children?: React.ReactNode;
}) {
  return (
    <div className="border-b border-border/60">
      <div className="group/grp flex items-center gap-1.5 px-3 py-1.5">
        <button
          type="button"
          onClick={() => !locked && onToggle(id)}
          className="flex flex-1 items-center gap-2 text-[13px] font-medium text-foreground min-w-0"
          aria-expanded={open}
        >
          <Icon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate text-left">{label}</span>
          {count ? (
            <span
              className="ml-0.5 inline-flex items-center justify-center rounded-full text-white text-[10px] font-semibold size-4 shrink-0"
              style={{ backgroundColor: "var(--people-accent, hsl(var(--foreground)))" }}
            >
              {count}
            </span>
          ) : null}
        </button>
        {locked ? (
          <Lock className="size-3.5 shrink-0 text-muted-foreground/70" />
        ) : (
          <>
            {onPin && (
              <button
                type="button"
                onClick={() => onPin(id)}
                title={pinned ? "Unpin filter" : "Pin filter"}
                className={cn(
                  "shrink-0 p-0.5 rounded text-muted-foreground hover:text-foreground transition-opacity",
                  pinned ? "opacity-100 text-foreground" : "opacity-0 group-hover/grp:opacity-100",
                )}
              >
                {pinned ? <Pin className="size-3.5" /> : <PinOff className="size-3.5" />}
              </button>
            )}
            <button
              type="button"
              onClick={() => onToggle(id)}
              className="shrink-0 p-0.5 text-muted-foreground hover:text-foreground"
              aria-label={open ? "Collapse" : "Expand"}
            >
              <ChevronDown className={cn("size-4 transition-transform", !open && "-rotate-90")} />
            </button>
          </>
        )}
      </div>
      {open && !locked && children && <div className="px-3 pb-2 pt-0 space-y-1.5">{children}</div>}
    </div>
  );
}

/** A labelled checkbox row used inside filter groups. */
function CheckRow({ checked, onChange, label, hint }: { checked: boolean; onChange: () => void; label: string; hint?: string }) {
  return (
    <label className="flex items-center gap-2 cursor-pointer text-[13px] text-foreground py-0.5">
      <Checkbox checked={checked} onCheckedChange={onChange} className="size-3.5" />
      <span className="flex-1 truncate">{label}</span>
      {hint && <span className="text-[11px] text-muted-foreground tabular-nums">{hint}</span>}
    </label>
  );
}

/* ─────────────────────────────── types ────────────────────────────────── */

type Prospect = {
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
  confidenceScore?: number | null;
  confidenceTier?: string | null;
  verificationStatus?: string | null;
  linkedLeadId?: number | null;
  linkedContactId?: number | null;
};

const SENIORITY_OPTIONS = ["c-level", "vp", "director", "manager", "senior", "entry", "owner", "partner"];

/* ─────────────────────────────── page ─────────────────────────────────── */

export default function People() {
  const [, setLocation] = useLocation();
  const accent = useAccentColor();

  // ── server-backed filters (drive prospects.list → Total + pagination) ──
  const [emailStatus, setEmailStatus] = useState<string>(""); // "" = any
  const [hasEmail, setHasEmail] = useState(false);
  const [verification, setVerification] = useState<string>(""); // verified | needs_review | rejected
  const [promoted, setPromoted] = useState<"all" | "promoted" | "not">("all");
  const [page, setPage] = useState(1);
  const perPage = 50;

  // ── client refinement filters (narrow the loaded page) ──
  const [search, setSearch] = useState("");
  const [titleQ, setTitleQ] = useState("");
  const [companyQ, setCompanyQ] = useState("");
  const [locationQ, setLocationQ] = useState("");
  const [industryQ, setIndustryQ] = useState("");
  const [hasPhone, setHasPhone] = useState(false);
  const [hasLinkedin, setHasLinkedin] = useState(false);
  const [tiers, setTiers] = useState<Set<string>>(new Set());
  const [seniorities, setSeniorities] = useState<Set<string>>(new Set());
  const [sort, setSort] = useState("fit_desc");

  // ── view state ──
  const [hideFilters, setHideFilters] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const [moreOpen, setMoreOpen] = useState(false);
  const [aiPrompt, setAiPrompt] = useState("");
  const [pinned, setPinned] = useState<Set<string>>(new Set(["emailStatus", "jobTitles"]));
  const [openGroups, setOpenGroups] = useState<Set<string>>(
    new Set(["quick", "emailStatus", "jobTitles", "fit"]),
  );

  const toggleGroup = (id: string) =>
    setOpenGroups((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  const togglePin = (id: string) =>
    setPinned((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  const toggleIn = (set: Set<string>, setter: (s: Set<string>) => void, v: string) => {
    const next = new Set(set);
    next.has(v) ? next.delete(v) : next.add(v);
    setter(next);
  };

  // ── server query ──
  const { data, isLoading, error, refetch } = trpc.prospects.list.useQuery({
    page,
    perPage,
    emailStatus: emailStatus || undefined,
    hasEmail: hasEmail || undefined,
    verificationStatus: (verification || undefined) as any,
    promoted: promoted === "promoted" ? true : promoted === "not" ? false : undefined,
  });

  const total = data?.total ?? 0;
  const pageRows = (data?.data ?? []) as Prospect[];

  // ── client refinement + sort ──
  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    const out = pageRows.filter((p) => {
      if (q) {
        const hay = `${p.firstName} ${p.lastName} ${p.title ?? ""} ${p.company ?? ""} ${p.email ?? ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (titleQ && !(p.title ?? "").toLowerCase().includes(titleQ.toLowerCase())) return false;
      if (companyQ && !(p.company ?? "").toLowerCase().includes(companyQ.toLowerCase())) return false;
      if (locationQ) {
        const loc = [p.city, p.state, p.country].filter(Boolean).join(", ").toLowerCase();
        if (!loc.includes(locationQ.toLowerCase())) return false;
      }
      if (industryQ && !(p.industry ?? "").toLowerCase().includes(industryQ.toLowerCase())) return false;
      if (hasPhone && !p.phone) return false;
      if (hasLinkedin && !p.linkedinUrl) return false;
      if (tiers.size && !tiers.has((p.confidenceTier ?? "").toLowerCase())) return false;
      if (seniorities.size) {
        const s = (p.seniority ?? "").toLowerCase();
        if (![...seniorities].some((x) => s.includes(x))) return false;
      }
      return true;
    });
    const cmp: Record<string, (a: Prospect, b: Prospect) => number> = {
      fit_desc: (a, b) => (b.confidenceScore ?? -1) - (a.confidenceScore ?? -1),
      fit_asc: (a, b) => (a.confidenceScore ?? 999) - (b.confidenceScore ?? 999),
      name_asc: (a, b) => `${a.firstName} ${a.lastName}`.localeCompare(`${b.firstName} ${b.lastName}`),
      company_asc: (a, b) => (a.company ?? "").localeCompare(b.company ?? ""),
    };
    return [...out].sort(cmp[sort] ?? cmp.fit_desc);
  }, [pageRows, search, titleQ, companyQ, locationQ, industryQ, hasPhone, hasLinkedin, tiers, seniorities, sort]);

  const selected = useMemo(() => rows.find((r) => r.id === selectedId) ?? pageRows.find((r) => r.id === selectedId) ?? null, [rows, pageRows, selectedId]);

  // stats (Total = whole dataset; net-new / saved computed on the loaded page)
  const savedOnPage = pageRows.filter((p) => p.linkedLeadId || p.linkedContactId).length;
  const netNewOnPage = pageRows.length - savedOnPage;

  // whether any *server-backed* filter is set — distinguishes "no results for
  // this query" (show the adjust-filters state) from "empty workspace" (show
  // the AI onboarding empty state).
  const serverFilterActive = !!(emailStatus || hasEmail || verification || promoted !== "all");

  // active filter count for "Clear all" / "Hide filters"
  const activeCount =
    (emailStatus ? 1 : 0) +
    (hasEmail ? 1 : 0) +
    (verification ? 1 : 0) +
    (promoted !== "all" ? 1 : 0) +
    (search ? 1 : 0) +
    (titleQ ? 1 : 0) +
    (companyQ ? 1 : 0) +
    (locationQ ? 1 : 0) +
    (industryQ ? 1 : 0) +
    (hasPhone ? 1 : 0) +
    (hasLinkedin ? 1 : 0) +
    tiers.size +
    seniorities.size;

  const clearAll = () => {
    setEmailStatus(""); setHasEmail(false); setVerification(""); setPromoted("all");
    setSearch(""); setTitleQ(""); setCompanyQ(""); setLocationQ(""); setIndustryQ("");
    setHasPhone(false); setHasLinkedin(false); setTiers(new Set()); setSeniorities(new Set());
    setPage(1);
  };

  // changing a server filter should reset to page 1
  const resetPage = () => setPage(1);

  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const rangeStart = total === 0 ? 0 : (page - 1) * perPage + 1;
  const rangeEnd = Math.min(page * perPage, rangeStart + pageRows.length - 1);

  const allOnPageChecked = rows.length > 0 && rows.every((r) => checked.has(r.id));
  const toggleAll = () => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (allOnPageChecked) rows.forEach((r) => next.delete(r.id));
      else rows.forEach((r) => next.add(r.id));
      return next;
    });
  };

  /* ── pinned groups render first ── */
  const groupOrder = ["quick", "lists", "emailStatus", "verification", "saved", "jobTitles", "seniority", "company", "location", "industry", "fit", "contactInfo"];
  const orderedGroups = [...groupOrder].sort((a, b) => Number(pinned.has(b)) - Number(pinned.has(a)));

  /* ── render a single filter group by id ── */
  const renderGroup = (id: string) => {
    const common = {
      id,
      open: openGroups.has(id),
      pinned: pinned.has(id),
      onToggle: toggleGroup,
      onPin: togglePin,
    };
    switch (id) {
      case "quick":
        return (
          <FilterGroup key={id} {...common} label="Quick search" icon={Search} onPin={undefined}>
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Name, title, company, email…"
              className="h-7 text-[13px]"
            />
          </FilterGroup>
        );
      case "lists":
        return (
          <FilterGroup key={id} {...common} label="Lists" icon={ListChecks}>
            <p className="text-[12px] text-muted-foreground">No saved lists yet. Save a search to create one.</p>
          </FilterGroup>
        );
      case "emailStatus":
        return (
          <FilterGroup key={id} {...common} label="Email status" icon={Mail} count={(emailStatus ? 1 : 0) + (hasEmail ? 1 : 0)}>
            <div className="space-y-0.5">
              {[
                { v: "verified", l: "Verified" },
                { v: "unverified", l: "Unverified" },
                { v: "unavailable", l: "Unavailable" },
              ].map((o) => (
                <CheckRow
                  key={o.v}
                  checked={emailStatus === o.v}
                  onChange={() => { setEmailStatus(emailStatus === o.v ? "" : o.v); resetPage(); }}
                  label={o.l}
                />
              ))}
            </div>
            <div className="pt-1 border-t border-border/60">
              <CheckRow checked={hasEmail} onChange={() => { setHasEmail(!hasEmail); resetPage(); }} label="Has an email address" />
            </div>
          </FilterGroup>
        );
      case "verification":
        return (
          <FilterGroup key={id} {...common} label="Stage" icon={CheckCircle2} count={verification ? 1 : 0}>
            <div className="space-y-0.5">
              {[
                { v: "verified", l: "Verified" },
                { v: "needs_review", l: "Needs review" },
                { v: "rejected", l: "Rejected" },
              ].map((o) => (
                <CheckRow
                  key={o.v}
                  checked={verification === o.v}
                  onChange={() => { setVerification(verification === o.v ? "" : o.v); resetPage(); }}
                  label={o.l}
                />
              ))}
            </div>
          </FilterGroup>
        );
      case "saved":
        return (
          <FilterGroup key={id} {...common} label="Saved status" icon={Bookmark} count={promoted !== "all" ? 1 : 0}>
            <div className="space-y-0.5">
              {[
                { v: "all", l: "Any" },
                { v: "promoted", l: "Saved (converted to lead)" },
                { v: "not", l: "Net new (not yet saved)" },
              ].map((o) => (
                <CheckRow
                  key={o.v}
                  checked={promoted === o.v}
                  onChange={() => { setPromoted(o.v as any); resetPage(); }}
                  label={o.l}
                />
              ))}
            </div>
          </FilterGroup>
        );
      case "jobTitles":
        return (
          <FilterGroup key={id} {...common} label="Job titles" icon={Briefcase} count={titleQ ? 1 : 0}>
            <Input value={titleQ} onChange={(e) => setTitleQ(e.target.value)} placeholder="e.g. VP of Sales" className="h-7 text-[13px]" />
          </FilterGroup>
        );
      case "seniority":
        return (
          <FilterGroup key={id} {...common} label="Management level" icon={Layers} count={seniorities.size}>
            <div className="space-y-0.5">
              {SENIORITY_OPTIONS.map((s) => (
                <CheckRow key={s} checked={seniorities.has(s)} onChange={() => toggleIn(seniorities, setSeniorities, s)} label={s.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())} />
              ))}
            </div>
          </FilterGroup>
        );
      case "company":
        return (
          <FilterGroup key={id} {...common} label="Company" icon={Building2} count={companyQ ? 1 : 0}>
            <Input value={companyQ} onChange={(e) => setCompanyQ(e.target.value)} placeholder="Company name…" className="h-7 text-[13px]" />
          </FilterGroup>
        );
      case "location":
        return (
          <FilterGroup key={id} {...common} label="Location" icon={MapPin} count={locationQ ? 1 : 0}>
            <Input value={locationQ} onChange={(e) => setLocationQ(e.target.value)} placeholder="City, state, or country…" className="h-7 text-[13px]" />
          </FilterGroup>
        );
      case "industry":
        return (
          <FilterGroup key={id} {...common} label="Industry & keywords" icon={Globe} count={industryQ ? 1 : 0}>
            <Input value={industryQ} onChange={(e) => setIndustryQ(e.target.value)} placeholder="e.g. SaaS, Fintech…" className="h-7 text-[13px]" />
          </FilterGroup>
        );
      case "fit":
        return (
          <FilterGroup key={id} {...common} label="ICP fit score" icon={Target} count={tiers.size}>
            <div className="space-y-0.5">
              {[
                { v: "high", l: "High (70–100)" },
                { v: "medium", l: "Medium (40–69)" },
                { v: "low", l: "Low (0–39)" },
              ].map((o) => (
                <CheckRow key={o.v} checked={tiers.has(o.v)} onChange={() => toggleIn(tiers, setTiers, o.v)} label={o.l} />
              ))}
            </div>
          </FilterGroup>
        );
      case "contactInfo":
        return (
          <FilterGroup key={id} {...common} label="Contact info" icon={Phone} count={(hasPhone ? 1 : 0) + (hasLinkedin ? 1 : 0)}>
            <CheckRow checked={hasPhone} onChange={() => setHasPhone(!hasPhone)} label="Has a phone number" />
            <CheckRow checked={hasLinkedin} onChange={() => setHasLinkedin(!hasLinkedin)} label="Has a LinkedIn profile" />
          </FilterGroup>
        );
      default:
        return null;
    }
  };

  /* ── locked premium filters (visual parity with Apollo) ── */
  const LOCKED = [
    { id: "lookalikes", label: "Lookalikes", icon: Users },
    { id: "technologies", label: "Technologies", icon: Settings2 },
    { id: "revenue", label: "Revenue", icon: BarChart3 },
    { id: "funding", label: "Funding", icon: BarChart3 },
    { id: "intent", label: "Buying intent", icon: Target },
    { id: "education", label: "Education", icon: GraduationCap },
  ];

  return (
    <Shell title="People">
      <div className="flex flex-col h-full min-h-0" style={{ ["--people-accent" as any]: accent }}>
        {/* Compact title row — kept deliberately thin so the filter rail and
            results fit the viewport with minimal scrolling (Apollo-style). */}
        <div className="relative shrink-0 flex items-center gap-2 px-4 h-11 border-b border-border bg-card/40">
          <span aria-hidden className="absolute inset-x-0 top-0 h-0.5" style={{ backgroundColor: accent }} />
          <Users className="size-4" style={{ color: accent }} />
          <h1 className="text-[15px] font-semibold tracking-tight">Find people</h1>
          <div className="flex-1" />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="h-7 gap-1.5">
                <Upload className="size-3.5" /> Import <ChevronDown className="size-3 opacity-60" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => setLocation("/import")}><Upload className="size-4 mr-2" /> Import a CSV</DropdownMenuItem>
              <DropdownMenuItem onClick={() => setLocation("/find-prospects")}><Search className="size-4 mr-2" /> Find prospects</DropdownMenuItem>
              <DropdownMenuItem onClick={() => setLocation("/are")}><Sparkles className="size-4 mr-2" /> Auto-discover (ARE)</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {/* body: filter rail | results | detail panel */}
        <div className="flex flex-1 min-h-0">
          {/* ── filter rail (the fulcrum) ── */}
          {!hideFilters && (
            <aside className="w-72 shrink-0 border-r border-border flex flex-col min-h-0 bg-card/30">
              {/* stats strip */}
              <div className="grid grid-cols-3 gap-px bg-border/60 shrink-0">
                {[
                  { l: "Total", v: fmtNum(total) },
                  { l: "Net new", v: fmtNum(netNewOnPage) },
                  { l: "Saved", v: fmtNum(savedOnPage) },
                ].map((s) => (
                  <div
                    key={s.l}
                    className="bg-card px-2 py-1.5 text-center leading-tight"
                    style={{ backgroundImage: `linear-gradient(180deg, ${accent}1f, transparent)` }}
                  >
                    <div className="text-[13px] font-bold tabular-nums" style={{ color: accent }}>{s.v}</div>
                    <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{s.l}</div>
                  </div>
                ))}
              </div>

              {/* filter groups */}
              <div className="flex-1 min-h-0 overflow-y-auto">
                {orderedGroups.map((id) => renderGroup(id))}

                {/* locked / premium */}
                <div className="px-3 pt-2 pb-0.5 text-[11px] uppercase tracking-wide text-muted-foreground">Advanced (upgrade)</div>
                {LOCKED.map((f) => (
                  <FilterGroup key={f.id} id={f.id} label={f.label} icon={f.icon} locked open={false} onToggle={() => {}} />
                ))}
              </div>

              {/* footer */}
              <div className="shrink-0 border-t border-border flex items-center justify-between px-3 py-2 bg-card">
                <button
                  type="button"
                  onClick={clearAll}
                  disabled={activeCount === 0}
                  className="text-[12px] text-muted-foreground hover:text-foreground disabled:opacity-40 inline-flex items-center gap-1"
                >
                  <X className="size-3.5" /> Clear all{activeCount ? ` (${activeCount})` : ""}
                </button>
                <button
                  type="button"
                  onClick={() => setMoreOpen(true)}
                  className="text-[12px] font-medium text-foreground hover:underline inline-flex items-center gap-1"
                >
                  <SlidersHorizontal className="size-3.5" /> More filters
                </button>
              </div>
            </aside>
          )}

          {/* ── centre column ── */}
          <section className="flex-1 min-w-0 flex flex-col min-h-0">
            {/* toolbar */}
            <div className="shrink-0 border-b border-border px-3 py-1.5 flex items-center gap-1.5 flex-wrap bg-card/40 [&_button]:h-7">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" className="gap-1.5">Default view <ChevronDown className="size-3.5 opacity-60" /></Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  <DropdownMenuItem>Default view</DropdownMenuItem>
                  <DropdownMenuItem>Net new this week</DropdownMenuItem>
                  <DropdownMenuItem>High-fit only</DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem><Plus className="size-4 mr-2" /> Save current as view</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>

              <Button variant="ghost" size="sm" className="gap-1.5" onClick={() => setHideFilters((v) => !v)}>
                <Filter className="size-4" /> {hideFilters ? "Show" : "Hide"} filters{activeCount ? ` (${activeCount})` : ""}
              </Button>

              <div className="flex items-center gap-2 px-2.5 h-7 rounded-md border bg-background text-sm min-w-0 flex-1 max-w-xs">
                <Search className="size-4 text-muted-foreground shrink-0" />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="bg-transparent outline-none flex-1 min-w-0 text-[13px]"
                  placeholder="Search people"
                />
                {search && <button onClick={() => setSearch("")}><X className="size-3.5 text-muted-foreground" /></button>}
              </div>

              <div className="flex-1" />

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" className="gap-1.5"><Wand2 className="size-4" /> Research with AI <ChevronDown className="size-3.5 opacity-60" /></Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem>Run custom AI prompt</DropdownMenuItem>
                  <DropdownMenuItem>Generate AI formula</DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setLocation("/v2/ai-assistant")}><Sparkles className="size-4 mr-2" /> Use Velocity Assistant</DropdownMenuItem>
                  <DropdownMenuItem>Start with a template</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" className="gap-1.5"><Workflow className="size-4" /> Create workflow <ChevronDown className="size-3.5 opacity-60" /></Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => setLocation("/sequences")}>Auto-add to sequence</DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setLocation("/v2/lists")}>Auto-add to lists</DropdownMenuItem>
                  <DropdownMenuItem>Auto-update records</DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => setLocation("/workflows")}>Create from scratch</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>

              <Button variant="ghost" size="sm" className="gap-1.5"><Save className="size-4" /> Save search</Button>

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon-sm" title="Sort"><ArrowUpDown className="size-4" /></Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuLabel>Sort by</DropdownMenuLabel>
                  <DropdownMenuRadioGroup value={sort} onValueChange={setSort}>
                    <DropdownMenuRadioItem value="fit_desc">ICP fit (high → low)</DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="fit_asc">ICP fit (low → high)</DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="name_asc">Name (A → Z)</DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="company_asc">Company (A → Z)</DropdownMenuRadioItem>
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>

              <Button variant="ghost" size="icon-sm" title="Search settings"><Settings2 className="size-4" /></Button>
            </div>

            {/* selection action bar */}
            {checked.size > 0 && (
              <div className="shrink-0 border-b border-border px-3 py-1.5 flex items-center gap-3 text-white text-[13px]" style={{ backgroundColor: accent }}>
                <span className="font-medium">{checked.size} selected</span>
                <Button variant="secondary" size="sm" className="h-7" onClick={() => setLocation("/sequences")}>Add to sequence</Button>
                <Button variant="secondary" size="sm" className="h-7" onClick={() => setLocation("/v2/lists")}>Add to list</Button>
                <div className="flex-1" />
                <button onClick={() => setChecked(new Set())} className="opacity-80 hover:opacity-100 inline-flex items-center gap-1"><X className="size-3.5" /> Clear</button>
              </div>
            )}

            {/* results / states */}
            <div className="flex-1 min-h-0 overflow-auto">
              {isLoading ? (
                <div className="p-3 space-y-2">
                  {Array.from({ length: 8 }).map((_, i) => (
                    <div key={i} className="h-12 rounded-md bg-muted/50 animate-pulse" />
                  ))}
                </div>
              ) : error ? (
                <div className="text-center py-20 px-4">
                  <p className="text-sm text-muted-foreground">Couldn’t load people. {error.message}</p>
                  <Button variant="outline" size="sm" className="mt-3" onClick={() => refetch()}>Retry</Button>
                </div>
              ) : total === 0 && !serverFilterActive ? (
                <AiEmptyState
                  prompt={aiPrompt}
                  setPrompt={setAiPrompt}
                  onQuick={(setter) => setter()}
                  quick={{
                    highFit: () => { setTiers(new Set(["high"])); if (!openGroups.has("fit")) toggleGroup("fit"); },
                    hasEmail: () => { setHasEmail(true); resetPage(); },
                    verified: () => { setEmailStatus("verified"); resetPage(); },
                    cLevel: () => { setSeniorities(new Set(["c-level", "vp"])); },
                  }}
                  onImport={() => setLocation("/import")}
                  onDiscover={() => setLocation("/find-prospects")}
                />
              ) : rows.length === 0 ? (
                <div className="text-center py-20 px-4">
                  <div className="mx-auto size-12 rounded-full bg-secondary flex items-center justify-center mb-3">
                    <Filter className="size-5 text-muted-foreground" />
                  </div>
                  <h3 className="text-sm font-semibold">No people match these filters</h3>
                  <p className="text-sm text-muted-foreground mt-1">Try loosening the filters on the left.</p>
                  <Button variant="outline" size="sm" className="mt-3" onClick={clearAll}>Clear all filters</Button>
                </div>
              ) : (
                <table className="w-full text-sm">
                  <thead className="sticky top-0 z-10 bg-card border-b border-border">
                    <tr className="text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                      <th className="w-10 px-3 py-1.5"><Checkbox checked={allOnPageChecked} onCheckedChange={toggleAll} className="size-3.5" /></th>
                      <th className="px-2 py-1.5 font-medium">Name</th>
                      <th className="px-2 py-1.5 font-medium">Title</th>
                      <th className="px-2 py-1.5 font-medium">Fit</th>
                      <th className="px-2 py-1.5 font-medium">Company</th>
                      <th className="px-2 py-1.5 font-medium">Location</th>
                      <th className="px-2 py-1.5 font-medium">Email</th>
                      <th className="px-2 py-1.5 font-medium">Phone</th>
                      <th className="w-8 px-2 py-1.5" />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((p) => (
                      <tr
                        key={p.id}
                        onClick={() => setSelectedId(p.id)}
                        className={cn(
                          "border-b border-border/60 cursor-pointer hover:bg-muted/50",
                          selectedId === p.id && "bg-muted",
                        )}
                      >
                        <td className="px-3 py-1.5" onClick={(e) => e.stopPropagation()}>
                          <Checkbox
                            checked={checked.has(p.id)}
                            onCheckedChange={() =>
                              setChecked((prev) => {
                                const next = new Set(prev);
                                next.has(p.id) ? next.delete(p.id) : next.add(p.id);
                                return next;
                              })
                            }
                            className="size-3.5"
                          />
                        </td>
                        <td className="px-2 py-1.5">
                          <div className="font-medium">{p.firstName} {p.lastName}</div>
                          {p.linkedinUrl && (
                            <a href={p.linkedinUrl} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} className="text-[11px] text-blue-600 hover:underline inline-flex items-center gap-0.5">
                              <ExternalLink className="size-2.5" /> LinkedIn
                            </a>
                          )}
                        </td>
                        <td className="px-2 py-1.5"><div className="max-w-[160px] truncate" title={p.title ?? undefined}>{p.title ?? "—"}</div></td>
                        <td className="px-2 py-1.5">{fitBadge(p.confidenceScore)}</td>
                        <td className="px-2 py-1.5"><div className="max-w-[150px] truncate" title={p.company ?? undefined}>{p.company ?? "—"}</div></td>
                        <td className="px-2 py-1.5 text-xs text-muted-foreground"><div className="max-w-[140px] truncate">{[p.city, p.state, p.country].filter(Boolean).join(", ") || "—"}</div></td>
                        <td className="px-2 py-1.5">
                          {p.email ? (
                            <div className="flex items-center gap-1 max-w-[200px]">
                              <span className="text-xs truncate min-w-0" title={p.email}>{p.email}</span>
                              {emailStatusBadge(p.emailStatus)}
                            </div>
                          ) : (
                            <span className="text-xs text-muted-foreground inline-flex items-center gap-1"><Mail className="size-3" /> —</span>
                          )}
                        </td>
                        <td className="px-2 py-1.5">{p.phone ? <span className="text-xs">{p.phone}</span> : <span className="text-xs text-muted-foreground">—</span>}</td>
                        <td className="px-2 py-1.5 text-right"><ChevronRight className="size-4 text-muted-foreground" /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            {/* pagination */}
            {total > 0 && (
              <div className="shrink-0 border-t border-border px-3 py-2 flex items-center justify-between text-[13px] bg-card/40">
                <span className="text-muted-foreground tabular-nums">
                  {rangeStart}–{rangeEnd} of {fmtNum(total)}
                  {rows.length !== pageRows.length && <span className="ml-1">· {rows.length} shown</span>}
                </span>
                <div className="flex items-center gap-1">
                  <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => { setPage((p) => Math.max(1, p - 1)); setChecked(new Set()); }}>Prev</Button>
                  <span className="px-2 text-muted-foreground tabular-nums">{page} / {totalPages}</span>
                  <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => { setPage((p) => Math.min(totalPages, p + 1)); setChecked(new Set()); }}>Next</Button>
                </div>
              </div>
            )}
          </section>

          {/* ── detail panel ── */}
          {selected && (
            <DetailPanel
              p={selected}
              onClose={() => setSelectedId(null)}
              onOpenFull={() => setLocation(`/prospects/${selected.id}`)}
            />
          )}
        </div>
      </div>

      <MoreFiltersDialog open={moreOpen} onClose={() => setMoreOpen(false)} count={total} />
    </Shell>
  );
}

/* ───────────────────────── detail panel ───────────────────────────────── */

function DetailPanel({ p, onClose, onOpenFull }: { p: Prospect; onClose: () => void; onOpenFull: () => void }) {
  const loc = [p.city, p.state, p.country].filter(Boolean).join(", ");
  return (
    <aside className="w-96 shrink-0 border-l border-border flex flex-col min-h-0 bg-card shadow-sm">
      <div className="relative shrink-0 flex items-start justify-between px-4 py-3 border-b border-border">
        <span aria-hidden className="absolute inset-x-0 top-0 h-0.5" style={{ backgroundColor: "var(--people-accent, hsl(var(--foreground)))" }} />
        <div className="min-w-0">
          <div className="text-base font-semibold truncate">{p.firstName} {p.lastName}</div>
          <div className="text-sm text-muted-foreground truncate">{p.title ?? "—"}</div>
        </div>
        <button onClick={onClose} className="shrink-0 p-1 text-muted-foreground hover:text-foreground" aria-label="Close"><X className="size-4" /></button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4 text-sm">
        {/* fit */}
        <div className="flex items-center gap-2">
          {fitBadge(p.confidenceScore)}
          {p.confidenceTier && <Badge variant="outline" className="text-[10px] capitalize">{p.confidenceTier} fit</Badge>}
          {p.verificationStatus && <Badge variant="secondary" className="text-[10px] capitalize">{p.verificationStatus.replace(/_/g, " ")}</Badge>}
        </div>

        {/* contact */}
        <div className="space-y-2">
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Contact</div>
          <Field icon={Mail} label="Email" value={p.email} extra={emailStatusBadge(p.emailStatus)} />
          <Field icon={Phone} label="Phone" value={p.phone} />
          <Field icon={MapPin} label="Location" value={loc || null} />
          {p.linkedinUrl ? (
            <a href={p.linkedinUrl} target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 text-blue-600 hover:underline">
              <ExternalLink className="size-4 shrink-0" /> <span className="truncate">LinkedIn profile</span>
            </a>
          ) : null}
        </div>

        {/* company */}
        <div className="space-y-2">
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Company</div>
          <Field icon={Building2} label="Company" value={p.company} />
          <Field icon={Globe} label="Domain" value={p.companyDomain} />
          <Field icon={Briefcase} label="Industry" value={p.industry} />
          <Field icon={Layers} label="Seniority" value={p.seniority} />
        </div>
      </div>

      <div className="shrink-0 border-t border-border p-3 space-y-2">
        <Button className="w-full gap-1.5" onClick={onOpenFull}><ExternalLink className="size-4" /> Open full record</Button>
        <div className="grid grid-cols-2 gap-2">
          <Button variant="outline" size="sm" className="gap-1.5"><Sparkles className="size-4" /> Sequence</Button>
          <Button variant="outline" size="sm" className="gap-1.5"><Bookmark className="size-4" /> Save</Button>
        </div>
      </div>
    </aside>
  );
}

function Field({ icon: Icon, label, value, extra }: { icon: any; label: string; value?: string | null; extra?: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2">
      <Icon className="size-4 mt-0.5 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="text-[11px] text-muted-foreground">{label}</div>
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="truncate">{value || <span className="text-muted-foreground">—</span>}</span>
          {value && extra}
        </div>
      </div>
    </div>
  );
}

/* ───────────────────────── AI empty state ─────────────────────────────── */

function AiEmptyState({
  prompt,
  setPrompt,
  quick,
  onImport,
  onDiscover,
}: {
  prompt: string;
  setPrompt: (s: string) => void;
  onQuick?: (fn: () => void) => void;
  quick: { highFit: () => void; hasEmail: () => void; verified: () => void; cLevel: () => void };
  onImport: () => void;
  onDiscover: () => void;
}) {
  return (
    <div className="max-w-2xl mx-auto px-4 py-14 text-center">
      <div
        className="mx-auto size-12 rounded-xl text-white flex items-center justify-center mb-4 shadow-sm"
        style={{ backgroundColor: "var(--people-accent, hsl(var(--foreground)))" }}
      >
        <Sparkles className="size-6" />
      </div>
      <h2 className="text-lg font-semibold">Use Velocity AI to find the right prospects</h2>
      <p className="text-sm text-muted-foreground mt-1">Describe who you're looking for, or import data to get started.</p>

      <div className="mt-5 flex items-center gap-2 rounded-xl border bg-background p-2 shadow-sm">
        <Wand2 className="size-4 text-muted-foreground ml-1 shrink-0" />
        <input
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="e.g. VPs of Sales at SaaS companies in the US with a verified email"
          className="flex-1 bg-transparent outline-none text-sm min-w-0"
        />
        <Button size="sm" className="gap-1.5"><Sparkles className="size-4" /> Find people</Button>
      </div>

      <div className="mt-6 rounded-xl border bg-card/50 p-4 text-left">
        <div className="text-[11px] uppercase tracking-wide text-muted-foreground mb-2">Quick filters</div>
        <div className="flex flex-wrap gap-2">
          <QuickChip icon={Target} label="High ICP fit" onClick={quick.highFit} />
          <QuickChip icon={Mail} label="Has email" onClick={quick.hasEmail} />
          <QuickChip icon={CheckCircle2} label="Verified email" onClick={quick.verified} />
          <QuickChip icon={Layers} label="C-level & VP" onClick={quick.cLevel} />
        </div>
      </div>

      <div className="mt-6 flex items-center justify-center gap-2">
        <Button variant="outline" size="sm" className="gap-1.5" onClick={onImport}><Upload className="size-4" /> Import a CSV</Button>
        <Button variant="outline" size="sm" className="gap-1.5" onClick={onDiscover}><Search className="size-4" /> Discover prospects</Button>
      </div>
    </div>
  );
}

function QuickChip({ icon: Icon, label, onClick }: { icon: any; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1.5 rounded-full border bg-background px-3 py-1.5 text-[13px] hover:bg-muted transition-colors"
    >
      <Icon className="size-3.5 text-muted-foreground" /> {label}
    </button>
  );
}

/* ──────────────────────── More Filters dialog ─────────────────────────── */

function MoreFiltersDialog({ open, onClose, count }: { open: boolean; onClose: () => void; count: number }) {
  const COLUMNS: { title: string; items: { label: string; locked?: boolean }[] }[] = [
    {
      title: "Person info",
      items: [
        { label: "Name" }, { label: "Job titles" }, { label: "Management level" },
        { label: "Seniority" }, { label: "Contact info" }, { label: "Email status" },
        { label: "Person location" }, { label: "Education", locked: true },
      ],
    },
    {
      title: "Company info",
      items: [
        { label: "Company" }, { label: "Industry & keywords" }, { label: "# Employees", locked: true },
        { label: "Revenue", locked: true }, { label: "Funding", locked: true }, { label: "Technologies", locked: true },
        { label: "SIC & NAICS", locked: true },
      ],
    },
    {
      title: "Engagement & intent",
      items: [
        { label: "ICP fit score" }, { label: "Saved status" }, { label: "Stage" },
        { label: "Buying intent", locked: true }, { label: "Job changes", locked: true }, { label: "Lookalikes", locked: true },
      ],
    },
  ];
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>More filters</DialogTitle>
          <DialogDescription>
            Pin any filter to keep it in the rail. Locked filters are part of an upgraded plan.
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-5 py-1">
          {COLUMNS.map((col) => (
            <div key={col.title}>
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground mb-2">{col.title}</div>
              <div className="space-y-1">
                {col.items.map((it) => (
                  <div key={it.label} className={cn("flex items-center justify-between rounded-md px-2 py-1.5 text-[13px]", it.locked ? "text-muted-foreground" : "hover:bg-muted cursor-pointer")}>
                    <span>{it.label}</span>
                    {it.locked ? <Lock className="size-3.5" /> : <Plus className="size-3.5 text-muted-foreground" />}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
        <div className="flex items-center justify-between border-t pt-3">
          <span className="text-[13px] text-muted-foreground tabular-nums">{fmtNum(count)} records</span>
          <Button onClick={onClose}>Apply filters</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
