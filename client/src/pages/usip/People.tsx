/**
 * People — the redesigned "Prospect and enrich → People" surface (/v2/people).
 *
 * Modelled on Apollo's "Find people" page: the LEFT FILTER RAIL is the fulcrum.
 * Every filter change re-shapes the centre view (results table) and the stats
 * strip. A right-hand detail panel opens for the selected person, and an AI
 * empty-state with quick filters shows when there's nothing to display.
 *
 * The top-action shelf (Default view · Research with AI · Create workflow ·
 * Save as new search · Sort · Search settings) and the selected-rows toolbar
 * live in dedicated components under components/usip/people/. The results table
 * is COLUMN-DRIVEN: `visibleColumns` (a list of ColumnKey) is rendered from the
 * shared COLUMN_REGISTRY, and the Search-settings → Fields panel mutates it.
 *
 * Data source: the existing `prospects.list` tRPC query (server-side paginated,
 * with confidence scoring + email/verification status from the ARE engine).
 *
 * Filter split (intentional, see comments at the query):
 *   - SERVER filters change the *whole-dataset* query (and therefore the Total
 *     stat + pagination): emailStatus, verificationStatus, promoted, hasEmail,
 *     enrolled, and the debounced text filters.
 *   - CLIENT refinement filters narrow the *loaded page* without another round
 *     trip: seniority, confidence tier, has-phone, has-linkedin, and the sort.
 */
import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { Shell, useAccentColor } from "@/components/usip/Shell";
import { ProspectAvatar } from "@/components/usip/ProspectAvatar";
import { BatchPhotoUpload } from "@/components/usip/BatchPhotoUpload";
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
} from "@/components/ui/dropdown-menu";
import {
  Search,
  Upload,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Filter,
  X,
  Sparkles,
  Plus,
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
  CheckCircle2,
  Workflow,
  Lock,
  Wand2,
  Layers,
  Bookmark,
  ImagePlus,
  Settings2,
  SlidersHorizontal,
} from "lucide-react";
import {
  type Prospect,
  type ColumnKey,
  type SortField,
  type SortDir,
  type SavedView,
  fitBadge,
  emailStatusBadge,
  fmtNum,

  COLUMN_REGISTRY,
  DEFAULT_COLUMNS,
} from "@/components/usip/people/peopleShared";
import { DefaultViewMenu } from "@/components/usip/people/DefaultViewMenu";
import { ResearchAiMenu } from "@/components/usip/people/ResearchAiMenu";
import { CreateWorkflowMenu } from "@/components/usip/people/CreateWorkflowMenu";
import { SortMenu } from "@/components/usip/people/SortMenu";
import { ProspectScoringPanel } from "@/components/usip/scoring/ProspectScoringPanel";
import { SelectionToolbar } from "@/components/usip/people/SelectionToolbar";
import { SearchSettingsSheet, type AppliedFilter } from "@/components/usip/people/SearchSettingsSheet";
import { LinkedInEnrichmentSummaryCard, EnrichButton } from "@/components/usip/people/LinkedInEnrichment";

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

const SENIORITY_OPTIONS = ["c-level", "vp", "director", "manager", "senior", "entry", "owner", "partner"];

const cap = (s: string) => s.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

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
  const [educationQ, setEducationQ] = useState("");
  const [linkedinQ, setLinkedinQ] = useState("");
  const [enrolled, setEnrolled] = useState<"all" | "yes" | "no">("all");
  const [hasPhone, setHasPhone] = useState(false);
  const [hasLinkedin, setHasLinkedin] = useState(false);
  const [tiers, setTiers] = useState<Set<string>>(new Set());
  const [seniorities, setSeniorities] = useState<Set<string>>(new Set());

  // ── sort (field + direction, applied by the Sort popover) ──
  const [sortField, setSortField] = useState<SortField>("relevance");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  // ── view / column state ──
  const [visibleColumns, setVisibleColumns] = useState<ColumnKey[]>(DEFAULT_COLUMNS);
  const [views, setViews] = useState<SavedView[]>([
    { id: "default", name: "Default view", system: true, scope: "yours", columns: DEFAULT_COLUMNS },
  ]);
  const [activeViewId, setActiveViewId] = useState("default");

  // ── view state ──
  const [hideFilters, setHideFilters] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [photoBatchOpen, setPhotoBatchOpen] = useState(false);
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const [moreOpen, setMoreOpen] = useState(false);
  const [aiPrompt, setAiPrompt] = useState("");
  const [settings, setSettings] = useState<{ open: boolean; mode: "settings" | "create"; initialView?: "main" | "fields" | "filters" }>({
    open: false,
    mode: "settings",
  });
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

  // Debounce the text filters so server queries fire after typing settles
  // (not per keystroke). Changing any text filter resets to page 1.
  const [qText, setQText] = useState({
    search: "", titleQ: "", companyQ: "", locationQ: "", industryQ: "", educationQ: "", linkedinQ: "",
  });
  useEffect(() => {
    const t = setTimeout(() => {
      setQText({ search, titleQ, companyQ, locationQ, industryQ, educationQ, linkedinQ });
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [search, titleQ, companyQ, locationQ, industryQ, educationQ, linkedinQ]);

  // ── server query ──
  // Client SortField → prospects.list sort enum ("relevance" = fit score).
  const SERVER_SORT: Record<SortField, "fit" | "name" | "title" | "company" | "email" | "phone" | "industry"> = {
    relevance: "fit", name: "name", title: "title", emails: "email",
    company: "company", phone: "phone", employees: "company", industries: "industry",
  };
  // Tier / seniority / sort are whole-dataset (server) filters — reset paging
  // whenever they change so Total + page 1 reflect the new query.
  useEffect(() => { setPage(1); }, [tiers, seniorities, sortField, sortDir]);
  const { data, isLoading, error, refetch } = trpc.prospects.list.useQuery({
    page,
    perPage,
    emailStatus: emailStatus || undefined,
    hasEmail: hasEmail || undefined,
    verificationStatus: (verification || undefined) as any,
    promoted: promoted === "promoted" ? true : promoted === "not" ? false : undefined,
    enrolled: enrolled === "all" ? undefined : enrolled,
    search: qText.search || undefined,
    titleQ: qText.titleQ || undefined,
    companyQ: qText.companyQ || undefined,
    locationQ: qText.locationQ || undefined,
    industryQ: qText.industryQ || undefined,
    educationQ: qText.educationQ || undefined,
    linkedinQ: qText.linkedinQ || undefined,
    tiers: tiers.size ? ([...tiers] as ("high" | "medium" | "low")[]) : undefined,
    seniorities: seniorities.size ? [...seniorities] : undefined,
    sortField: SERVER_SORT[sortField],
    sortDir,
  });

  const total = data?.total ?? 0;
  const pageRows = (data?.data ?? []) as Prospect[];

  // ── client refinement ──
  // Tier / seniority / sort moved SERVER-side (whole-dataset; see the query).
  // Only the contact-info checkboxes remain page-local refinements.
  const rows = useMemo(() => {
    return pageRows.filter((p) => {
      if (hasPhone && !p.phone) return false;
      if (hasLinkedin && !p.linkedinUrl) return false;
      return true;
    });
  }, [pageRows, hasPhone, hasLinkedin]);

  const selected = useMemo(() => rows.find((r) => r.id === selectedId) ?? pageRows.find((r) => r.id === selectedId) ?? null, [rows, pageRows, selectedId]);

  // Compact LinkedIn change indicators for the visible rows (batched — returns
  // only prospects that have unacknowledged updates, so the table stays light).
  const visibleIds = useMemo(() => rows.map((r) => r.id), [rows]);
  const { data: liSummaries } = trpc.linkedinEnrichment.getChangeSummaries.useQuery(
    { prospectIds: visibleIds },
    { enabled: visibleIds.length > 0 },
  );
  const liSummaryMap = useMemo(
    () => new Map((liSummaries ?? []).map((s: any) => [s.prospect_id, s])),
    [liSummaries],
  );

  // Velocity Priority Scores for the visible rows (batched). Drives the Score
  // column badge; the popover fetches the full breakdown lazily on open.
  const { data: scoreData } = trpc.scoring.scoreMap.useQuery(
    { objectType: "person", ids: visibleIds },
    { enabled: visibleIds.length > 0, staleTime: 30_000 },
  );
  const scoreMap = useMemo(
    () => new Map(Object.entries((scoreData?.fit ?? {}) as Record<string, { normalized: number; rating: string }>)
      .map(([id, v]) => [Number(id), { score: v.normalized, rating: v.rating }])),
    [scoreData],
  );

  // stats (Total = whole dataset; net-new / saved computed on the loaded page)
  const savedOnPage = pageRows.filter((p) => p.linkedLeadId || p.linkedContactId).length;
  const netNewOnPage = pageRows.length - savedOnPage;

  // whether any *server-backed* filter is set — distinguishes "no results for
  // this query" (show the adjust-filters state) from "empty workspace".
  const serverFilterActive = !!(
    emailStatus || hasEmail || verification || promoted !== "all" || enrolled !== "all" ||
    qText.search || qText.titleQ || qText.companyQ || qText.locationQ || qText.industryQ || qText.educationQ || qText.linkedinQ
  );

  // active filter count for "Clear all" / "Hide filters" / Search settings
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
    (educationQ ? 1 : 0) +
    (linkedinQ ? 1 : 0) +
    (enrolled !== "all" ? 1 : 0) +
    (hasPhone ? 1 : 0) +
    (hasLinkedin ? 1 : 0) +
    tiers.size +
    seniorities.size;

  // applied filters for the Search-settings → Filters panel (removable pills)
  const appliedFilters = useMemo<AppliedFilter[]>(() => {
    const f: AppliedFilter[] = [];
    if (emailStatus) f.push({ id: "emailStatus", group: "Email Status", label: cap(emailStatus) });
    if (hasEmail) f.push({ id: "hasEmail", group: "Email Status", label: "Has email" });
    if (verification) f.push({ id: "verification", group: "Stage", label: cap(verification) });
    if (promoted !== "all") f.push({ id: "promoted", group: "Saved status", label: promoted === "promoted" ? "Saved" : "Net new" });
    if (enrolled !== "all") f.push({ id: "enrolled", group: "Sequence", label: enrolled === "yes" ? "In a sequence" : "Not in a sequence" });
    if (qText.search) f.push({ id: "search", group: "Keywords", label: qText.search });
    if (qText.titleQ) f.push({ id: "titleQ", group: "Job titles", label: qText.titleQ });
    if (qText.companyQ) f.push({ id: "companyQ", group: "Company", label: qText.companyQ });
    if (qText.locationQ) f.push({ id: "locationQ", group: "Location", label: qText.locationQ });
    if (qText.industryQ) f.push({ id: "industryQ", group: "Industry", label: qText.industryQ });
    if (qText.educationQ) f.push({ id: "educationQ", group: "Education", label: qText.educationQ });
    if (qText.linkedinQ) f.push({ id: "linkedinQ", group: "Work URLs", label: qText.linkedinQ });
    if (hasPhone) f.push({ id: "hasPhone", group: "Contact info", label: "Has phone" });
    if (hasLinkedin) f.push({ id: "hasLinkedin", group: "Contact info", label: "Has LinkedIn" });
    tiers.forEach((t) => f.push({ id: `tier:${t}`, group: "ICP fit", label: cap(t) }));
    seniorities.forEach((s) => f.push({ id: `sen:${s}`, group: "Management level", label: cap(s) }));
    return f;
  }, [emailStatus, hasEmail, verification, promoted, enrolled, qText, hasPhone, hasLinkedin, tiers, seniorities]);

  const removeFilter = (id: string) => {
    if (id.startsWith("tier:")) { const v = id.slice(5); setTiers((p) => { const n = new Set(p); n.delete(v); return n; }); return; }
    if (id.startsWith("sen:")) { const v = id.slice(4); setSeniorities((p) => { const n = new Set(p); n.delete(v); return n; }); return; }
    switch (id) {
      case "emailStatus": setEmailStatus(""); resetPage(); break;
      case "hasEmail": setHasEmail(false); resetPage(); break;
      case "verification": setVerification(""); resetPage(); break;
      case "promoted": setPromoted("all"); resetPage(); break;
      case "enrolled": setEnrolled("all"); resetPage(); break;
      case "search": setSearch(""); break;
      case "titleQ": setTitleQ(""); break;
      case "companyQ": setCompanyQ(""); break;
      case "locationQ": setLocationQ(""); break;
      case "industryQ": setIndustryQ(""); break;
      case "educationQ": setEducationQ(""); break;
      case "linkedinQ": setLinkedinQ(""); break;
      case "hasPhone": setHasPhone(false); break;
      case "hasLinkedin": setHasLinkedin(false); break;
    }
  };

  const clearAll = () => {
    setEmailStatus(""); setHasEmail(false); setVerification(""); setPromoted("all");
    setSearch(""); setTitleQ(""); setCompanyQ(""); setLocationQ(""); setIndustryQ(""); setEducationQ("");
    setLinkedinQ(""); setEnrolled("all");
    setHasPhone(false); setHasLinkedin(false); setTiers(new Set()); setSeniorities(new Set());
    setPage(1);
  };

  // changing a server filter should reset to page 1
  const resetPage = () => setPage(1);

  // ── saved views ──
  const applyView = (v: SavedView) => {
    setActiveViewId(v.id);
    setVisibleColumns(v.columns);
  };
  const createSavedSearch = (name: string) => {
    if (!name) return;
    const id = `v_${Date.now()}`;
    setViews((prev) => [...prev, { id, name, scope: "yours", columns: visibleColumns }]);
    setActiveViewId(id);
  };

  // row quick-actions (Actions/Links columns): "open" navigates to the full
  // record; everything else opens the Quick Preview panel. Add-to-list,
  // sequence, enrich and mailto are real controls rendered inside the cell.
  const onAction = (action: string, p: Prospect) => {
    if (action === "open") { setLocation(`/prospects/${p.id}`); return; }
    setSelectedId(p.id);
  };

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
  const groupOrder = ["quick", "lists", "sequence", "emailStatus", "verification", "saved", "jobTitles", "seniority", "company", "location", "industry", "education", "linkedinUrl", "fit", "contactInfo"];
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
                <CheckRow key={s} checked={seniorities.has(s)} onChange={() => toggleIn(seniorities, setSeniorities, s)} label={cap(s)} />
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
      case "education":
        return (
          <FilterGroup key={id} {...common} label="Education" icon={GraduationCap} count={educationQ ? 1 : 0}>
            <Input value={educationQ} onChange={(e) => setEducationQ(e.target.value)} placeholder="School or university…" className="h-7 text-[13px]" />
            <p className="text-[11px] text-muted-foreground">Matches the prospect's school/university. Populated as prospects are enriched.</p>
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
      case "sequence":
        return (
          <FilterGroup key={id} {...common} label="Sequence" icon={Workflow} count={enrolled !== "all" ? 1 : 0}>
            <div className="space-y-0.5">
              {[
                { v: "all", l: "Any" },
                { v: "yes", l: "In a sequence" },
                { v: "no", l: "Not in a sequence" },
              ].map((o) => (
                <CheckRow
                  key={o.v}
                  checked={enrolled === o.v}
                  onChange={() => { setEnrolled(enrolled === o.v ? "all" : (o.v as "all" | "yes" | "no")); resetPage(); }}
                  label={o.l}
                />
              ))}
            </div>
          </FilterGroup>
        );
      case "linkedinUrl":
        return (
          <FilterGroup key={id} {...common} label="Work URLs" icon={ExternalLink} count={linkedinQ ? 1 : 0}>
            <Input value={linkedinQ} onChange={(e) => setLinkedinQ(e.target.value)} placeholder="LinkedIn / work URL…" className="h-7 text-[13px]" />
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

  return (
    <Shell title="People">
      <div className="flex flex-col h-full min-h-0" style={{ ["--people-accent" as any]: accent }}>
        {/* Compact title row */}
        <div className="relative shrink-0 flex items-center gap-2 px-4 h-11 border-b border-border bg-card/40">
          <span aria-hidden className="absolute inset-x-0 top-0 h-0.5" style={{ backgroundColor: accent }} />
          <Users className="size-4" style={{ color: accent }} />
          <h1 className="text-[15px] font-semibold tracking-tight">Find people</h1>
          <div className="flex-1" />
          <Button variant="outline" size="sm" className="h-7 gap-1.5" onClick={() => setPhotoBatchOpen(true)}>
            <ImagePlus className="size-3.5" /> Photos
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="h-7 gap-1.5">
                <Upload className="size-3.5" /> Import <ChevronDown className="size-3 opacity-60" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => setLocation("/import")}><Upload className="size-4 mr-2" /> Import a CSV</DropdownMenuItem>
              <DropdownMenuItem onClick={() => setLocation("/v2/data-enrichment/linkedin")}><ExternalLink className="size-4 mr-2" /> Enrich from LinkedIn</DropdownMenuItem>
              <DropdownMenuItem onClick={() => setLocation("/find-prospects")}><Search className="size-4 mr-2" /> Find prospects</DropdownMenuItem>
              <DropdownMenuItem onClick={() => setLocation("/are")}><Sparkles className="size-4 mr-2" /> Auto-discover (ARE)</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {/* body: filter rail | results | detail panel */}
        <div className="flex flex-1 min-h-0">
          {/* ── filter rail (the fulcrum) ── */}
          {!hideFilters && (
            <aside className="w-64 shrink-0 border-r border-border flex flex-col min-h-0 bg-card/30">
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
            <div className="shrink-0 border-b border-border px-3 py-1.5 flex items-center gap-0.5 flex-nowrap min-w-0 overflow-x-auto bg-card/40 [&_button]:h-7 [&_button]:px-1.5 [&_button]:gap-1 [&_button]:text-[11px] [&_button]:shrink-0 [&_button]:whitespace-nowrap [&_button_svg]:size-3">
              <DefaultViewMenu
                views={views}
                activeViewId={activeViewId}
                onSelect={applyView}
                onCreate={() => setSettings({ open: true, mode: "create" })}
              />

              <Button variant="ghost" size="sm" className="gap-1.5" onClick={() => setHideFilters((v) => !v)}>
                <Filter className="size-4" /> {hideFilters ? "Show" : "Hide"} filters{activeCount ? ` (${activeCount})` : ""}
              </Button>

              <div className="flex items-center gap-1.5 px-2 h-7 rounded-md border bg-background text-[11px] min-w-[104px] flex-1 max-w-[160px]">
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

              <ResearchAiMenu />
              <CreateWorkflowMenu />
              <Button variant="outline" size="sm" onClick={() => setSettings({ open: true, mode: "create" })}>Save as new search</Button>
              <SortMenu onApply={(field, dir) => { setSortField(field); setSortDir(dir); }} />
              <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setSettings({ open: true, mode: "settings" })}>
                <Settings2 className="size-4" /> Search settings
              </Button>
            </div>

            {/* selection action bar */}
            {checked.size > 0 && (
              <SelectionToolbar selectedIds={[...checked]} onClear={() => setChecked(new Set())} />
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
                <table className="w-full border-separate border-spacing-0 text-[13px]">
                  {/* Sticky axes live on the CELLS (not thead/tr): every th is
                      sticky-top; the checkbox + name cells are also sticky-left
                      so identity stays visible under horizontal scroll. Body
                      sticky cells use bg-inherit — row bg tokens are solid so
                      scrolled content never bleeds through. */}
                  <thead>
                    <tr className="text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                      <th className="sticky left-0 top-0 z-30 w-10 min-w-10 border-b border-border bg-card px-3 py-2">
                        <Checkbox checked={allOnPageChecked} onCheckedChange={toggleAll} className="size-3.5" />
                      </th>
                      {visibleColumns.map((key) => (
                        <th
                          key={key}
                          className={cn(
                            "sticky top-0 z-20 border-b border-border bg-card px-2 py-2 font-semibold whitespace-nowrap",
                            key === "name" && "left-10 z-30 min-w-[200px]",
                          )}
                        >
                          {COLUMN_REGISTRY[key].label}
                        </th>
                      ))}
                      <th className="sticky top-0 z-20 w-28 border-b border-border bg-card px-2 py-2">
                        <button
                          type="button"
                          onClick={() => setSettings({ open: true, mode: "settings", initialView: "fields" })}
                          className="inline-flex items-center gap-1 text-[11px] font-medium normal-case text-muted-foreground hover:text-foreground"
                        >
                          <Plus className="size-3.5" /> Add column
                        </button>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((p) => (
                      <tr
                        key={p.id}
                        onClick={() => setSelectedId(p.id)}
                        className={cn(
                          "cursor-pointer bg-background transition-colors hover:bg-muted",
                          selectedId === p.id && "bg-muted",
                        )}
                      >
                        <td className="sticky left-0 z-10 w-10 min-w-10 border-b border-border/60 bg-inherit px-3 py-1.5" onClick={(e) => e.stopPropagation()}>
                          {selectedId === p.id && (
                            <span aria-hidden className="absolute inset-y-0 left-0 w-[3px]" style={{ backgroundColor: "var(--people-accent, hsl(var(--foreground)))" }} />
                          )}
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
                        {visibleColumns.map((key) => (
                          <td
                            key={key}
                            className={cn(
                              "border-b border-border/60 px-2 py-1.5 align-middle",
                              key === "name" && "sticky left-10 z-10 bg-inherit",
                            )}
                          >
                            {COLUMN_REGISTRY[key].cell(p, { onAction, changeSummary: liSummaryMap.get(p.id), scoreCell: scoreMap.get(p.id) })}
                          </td>
                        ))}
                        <td className="border-b border-border/60 px-2 py-1.5" />
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            {/* pagination — count left, compact pager right, stuck under the table */}
            {total > 0 && (
              <div className="shrink-0 flex h-10 items-center justify-between border-t border-border bg-card/40 px-3 text-[12px]">
                <span className="text-muted-foreground tabular-nums">
                  {rangeStart} - {rangeEnd} of {fmtNum(total)}
                  {rows.length !== pageRows.length && <span className="ml-1">· {rows.length} shown</span>}
                </span>
                <div className="flex items-center gap-1">
                  <Button variant="outline" size="sm" className="h-7 gap-1 px-2 text-[12px]" disabled={page <= 1} onClick={() => { setPage((p) => Math.max(1, p - 1)); setChecked(new Set()); }}>
                    <ChevronLeft className="size-3.5" /> Prev
                  </Button>
                  <span className="min-w-12 text-center text-muted-foreground tabular-nums">{page} / {totalPages}</span>
                  <Button variant="outline" size="sm" className="h-7 gap-1 px-2 text-[12px]" disabled={page >= totalPages} onClick={() => { setPage((p) => Math.min(totalPages, p + 1)); setChecked(new Set()); }}>
                    Next <ChevronRight className="size-3.5" />
                  </Button>
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
      <BatchPhotoUpload open={photoBatchOpen} onClose={() => setPhotoBatchOpen(false)} />
      <SearchSettingsSheet
        open={settings.open}
        onOpenChange={(o) => setSettings((s) => ({ ...s, open: o }))}
        mode={settings.mode}
        initialView={settings.initialView}
        columns={visibleColumns}
        onColumnsChange={setVisibleColumns}
        filters={appliedFilters}
        onRemoveFilter={removeFilter}
        onCreateSearch={createSavedSearch}
      />
    </Shell>
  );
}

/* ─────────────────── Quick Preview panel (detail panel) ───────────────── */

const fmtShortDate = (d: string | Date | null | undefined) => {
  if (!d) return null;
  const dt = typeof d === "string" ? new Date(d) : d;
  if (Number.isNaN(dt.getTime())) return null;
  return dt.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
};

function DetailPanel({ p, onClose, onOpenFull }: { p: Prospect; onClose: () => void; onOpenFull: () => void }) {
  // The list row (p) renders instantly; the full record carries the resolved
  // profile_image (stripped from search results) so the avatar can show here.
  const { data: full } = trpc.prospects.get.useQuery({ id: p.id });
  // Enrichment record powers Recent activity (field-change history + current
  // company) and the Professional summary (LinkedIn About / headline).
  const { data: enr } = trpc.linkedinEnrichment.getProspectEnrichment.useQuery({ prospectId: p.id });
  const d = (full ?? p) as Prospect & { profile_image?: any };
  const e = (enr as any)?.enrichment;
  const history = ((enr as any)?.history ?? []) as any[];
  const loc = [d.city, d.state, d.country].filter(Boolean).join(", ");
  const fullName = `${d.firstName} ${d.lastName}`.trim();

  const activity: { label: string; sub?: string | null }[] = [];
  if (e?.currentCompanyName || d.company) {
    activity.push({
      label: `Current company — ${e?.currentCompanyName ?? d.company}`,
      sub: e?.currentCompanyStartDate ? `Since ${fmtShortDate(e.currentCompanyStartDate)}` : null,
    });
  }
  for (const h of history.slice(0, 4)) {
    activity.push({
      label: `${cap(String(h.fieldName ?? h.changeType ?? "profile"))} updated${h.newValue ? ` → ${h.newValue}` : ""}`,
      sub: fmtShortDate(h.detectedAt),
    });
  }
  const summary: string | null = e?.summaryAbout || e?.linkedinHeadline || null;

  return (
    <aside className="w-96 shrink-0 border-l border-border flex flex-col min-h-0 bg-card shadow-lg">
      {/* panel header */}
      <div className="relative shrink-0 flex h-11 items-center justify-between border-b border-border px-4">
        <span aria-hidden className="absolute inset-x-0 top-0 h-0.5" style={{ backgroundColor: "var(--people-accent, hsl(var(--foreground)))" }} />
        <span className="text-sm font-semibold">Quick Preview</span>
        <button onClick={onClose} className="rounded p-1 text-muted-foreground hover:text-foreground" aria-label="Close preview">
          <X className="size-4" />
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {/* identity */}
        <div className="flex flex-col items-center gap-2 border-b border-border/60 bg-muted/30 px-4 pb-4 pt-5 text-center">
          <ProspectAvatar image={(full as any)?.profile_image} name={fullName} size="lg" />
          <div className="min-w-0 w-full px-2">
            <div className="flex items-center justify-center gap-1.5 min-w-0">
              <span className="truncate text-base font-semibold leading-tight">{fullName}</span>
              {d.linkedinUrl ? (
                <a
                  href={d.linkedinUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  title="Open LinkedIn profile"
                  className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-[3px] bg-[#0A66C2] text-[9px] font-bold leading-none text-white hover:opacity-80"
                >
                  in
                </a>
              ) : null}
            </div>
            <div className="truncate text-sm text-muted-foreground">{d.title || "—"}</div>
            {d.company ? <div className="mt-0.5 truncate text-xs text-muted-foreground">{d.company}</div> : null}
          </div>
        </div>

        <div className="p-4 space-y-5 text-sm">
          <Section title="Recent activity">
            {activity.length === 0 ? (
              <p className="text-[12px] text-muted-foreground">
                No activity captured yet — run Enrich via LinkedIn to pull the latest profile.
              </p>
            ) : (
              <div className="space-y-2">
                {activity.map((a, i) => (
                  <div key={i} className="flex gap-2">
                    <span
                      aria-hidden
                      className={cn("mt-1.5 size-1.5 shrink-0 rounded-full", i > 0 && "bg-border")}
                      style={i === 0 ? { backgroundColor: "var(--people-accent, hsl(var(--foreground)))" } : undefined}
                    />
                    <div className="min-w-0">
                      <div className="truncate text-[12px] leading-snug" title={a.label}>{a.label}</div>
                      {a.sub ? <div className="text-[11px] text-muted-foreground">{a.sub}</div> : null}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Section>

          <Section title="Contact info">
            <Field icon={Mail} label="Email" value={d.email} extra={emailStatusBadge(d.emailStatus)} />
            <Field icon={Phone} label="Phone" value={d.phone} />
            <Field icon={MapPin} label="Location" value={loc || null} />
            {d.linkedinUrl ? (
              <a href={d.linkedinUrl} target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 text-blue-600 hover:underline">
                <ExternalLink className="size-4 shrink-0" /> <span className="truncate">LinkedIn profile</span>
              </a>
            ) : null}
          </Section>

          <Section title="Professional summary">
            {summary ? (
              <p className="whitespace-pre-line text-[12px] leading-relaxed text-foreground/90">{summary}</p>
            ) : (
              <p className="text-[12px] text-muted-foreground">
                No summary yet — enrich this prospect to pull their LinkedIn About section.
              </p>
            )}
          </Section>

          <Section title="Fit & signals">
            <div className="flex flex-wrap items-center gap-2">
              {fitBadge(d.confidenceScore)}
              {d.confidenceTier && <Badge variant="outline" className="text-[10px] capitalize">{d.confidenceTier} fit</Badge>}
              {d.verificationStatus && <Badge variant="secondary" className="text-[10px] capitalize">{d.verificationStatus.replace(/_/g, " ")}</Badge>}
              {d.seniority && <Badge variant="outline" className="text-[10px] capitalize">{d.seniority}</Badge>}
            </div>
          </Section>

          <Section title="Company">
            <Field icon={Building2} label="Company" value={d.company} />
            <Field icon={Globe} label="Domain" value={d.companyDomain} />
            <Field icon={Briefcase} label="Industry" value={d.industry} />
            <Field icon={GraduationCap} label="Education" value={d.education} />
          </Section>

          <div className="rounded-lg border border-border p-3">
            <ProspectScoringPanel objectType="person" objectId={d.id} />
          </div>

          <LinkedInEnrichmentSummaryCard prospectId={d.id} />
        </div>
      </div>

      <div className="shrink-0 border-t border-border p-3 space-y-2">
        <Button className="w-full gap-1.5" onClick={onOpenFull}><ExternalLink className="size-4" /> Open full record</Button>
        <EnrichButton prospectIds={[p.id]} triggerType="open_profile_action" label="Enrich via LinkedIn" className="w-full" />
        <div className="grid grid-cols-2 gap-2">
          <Button variant="outline" size="sm" className="gap-1.5"><Sparkles className="size-4" /> Sequence</Button>
          <Button variant="outline" size="sm" className="gap-1.5"><Bookmark className="size-4" /> Save</Button>
        </div>
      </div>
    </aside>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{title}</div>
      {children}
    </div>
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
        { label: "Person location" }, { label: "Education" }, { label: "Work URLs" },
      ],
    },
    {
      title: "Company info",
      items: [
        { label: "Company" }, { label: "Industry & keywords" },
      ],
    },
    {
      title: "Engagement",
      items: [
        { label: "ICP fit score" }, { label: "Saved status" }, { label: "Stage" },
        { label: "Lists" }, { label: "Sequence" },
      ],
    },
  ];
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>More filters</DialogTitle>
          <DialogDescription>
            Every filter here is functional. Pin any filter to keep it at the top of the rail.
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
