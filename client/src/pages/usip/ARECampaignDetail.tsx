/**
 * ARE Campaign Detail — Enhanced
 *
 * Tabs: Overview · Prospects · Scraper · A/B Variants · Signal Feed
 *
 * Key improvements:
 *   - PageHeader with breadcrumb, status badge, and pause/activate CTA
 *   - StatCard row using Shell design system tokens
 *   - Prospect queue with ICP score ring, enrichment progress, and slide-over dossier
 *   - Intelligence dossier in a Sheet slide-over (not inline panel)
 *   - Sequence viewer with quality score bar
 *   - Scraper panel with source icons and live result count
 *   - A/B variant cards with reply-rate comparison bars
 *   - Signal feed with sentiment colour coding and action badges
 */
import { Shell, PageHeader, StatCard, EmptyState } from "@/components/usip/Shell";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { trpc } from "@/lib/trpc";
import {
  Activity,
  ArrowLeft,
  AtSign,
  Download,
  RefreshCcw,
  Bot,
  Brain,
  CheckCircle2,
  ChevronRight,
  Clock,
  ExternalLink,
  Eye,
  FlaskConical,
  Globe,
  Linkedin,
  Loader2,
  MessageSquare,
  Newspaper,
  Pause,
  Play,
  Plus,
  Radar,
  RefreshCw,
  Search,
  Settings,
  Sparkles,
  Pencil,
  Pin,
  StickyNote,
  Star,
  Target,
  Trash2,
  TrendingDown,
  TrendingUp,
  Users,
  X,
  XCircle,
  Zap,
} from "lucide-react";
import { useState } from "react";
import { Link, useParams } from "wouter";
import { toast } from "sonner";

/* ─── constants ────────────────────────────────────────────────────────────── */
const SOURCE_ICON: Record<string, React.ElementType> = {
  internal: Users,
  google_business: Globe,
  linkedin: Linkedin,
  web: Globe,
  news: Newspaper,
  ai_research: Brain,
};

const SOURCE_LABEL: Record<string, string> = {
  google_business: "Google Business",
  linkedin: "LinkedIn",
  web: "Web",
  news: "News",
};

const ENRICH_COLOR: Record<string, string> = {
  pending: "#94A3B8",
  enriching: "#F59E0B",
  complete: "#34D399",
  failed: "#F87171",
};

const SEQ_COLOR: Record<string, string> = {
  pending: "#94A3B8",
  approved: "#34D399",
  enrolled: "#60A5FA",
  skipped: "#F87171",
  completed: "#A78BFA",
  replied: "#FB923C",
};

const SIGNAL_COLORS: Record<string, string> = {
  positive: "#34D399",
  negative: "#F87171",
  objection: "#F59E0B",
  neutral: "#94A3B8",
};

const REJECT_TEMPLATES = [
  "Wrong industry",
  "Company too small",
  "Company too large",
  "Already a customer",
  "Competitor",
  "No decision-making authority",
  "Outside target geography",
  "Budget constraints",
  "Not the right timing",
  "Duplicate prospect",
];

/* ─── ICP score ring ───────────────────────────────────────────────────────── */
function IcpRing({ score }: { score: number }) {
  const color = score >= 70 ? "#34D399" : score >= 40 ? "#F59E0B" : "#F87171";
  const r = 14;
  const circ = 2 * Math.PI * r;
  const dash = (score / 100) * circ;
  return (
    <div className="relative size-9 shrink-0">
      <svg viewBox="0 0 36 36" className="size-9 -rotate-90">
        <circle cx="18" cy="18" r={r} fill="none" stroke="currentColor" strokeWidth="3" className="text-muted/30" />
        <circle
          cx="18" cy="18" r={r} fill="none"
          stroke={color} strokeWidth="3"
          strokeDasharray={`${dash} ${circ}`}
          strokeLinecap="round"
        />
      </svg>
      <div className="absolute inset-0 flex items-center justify-center">
        <span className="text-[9px] font-bold tabular-nums" style={{ color }}>{score}</span>
      </div>
    </div>
  );
}

/* ─── Prospect row ─────────────────────────────────────────────────────────── */
function ProspectRow({
  p, campaignId, onSelect, selected,
}: {
  p: any; campaignId: number; onSelect: (id: number) => void; selected: boolean;
}) {
  const utils = trpc.useUtils();

  const enrich = trpc.are.prospects.enrich.useMutation({
    onSuccess: () => { toast.success("Enrichment started"); setTimeout(() => utils.are.prospects.list.invalidate(), 3000); },
    onError: (e) => toast.error(e.message),
  });
  const approve = trpc.are.prospects.approve.useMutation({
    onSuccess: () => { toast.success("Approved"); utils.are.prospects.list.invalidate(); },
    onError: (e) => toast.error(e.message),
  });
  const skip = trpc.are.prospects.skip.useMutation({
    onSuccess: () => utils.are.prospects.list.invalidate(),
    onError: (e) => toast.error(e.message),
  });
  const genSeq = trpc.are.prospects.generateSequence.useMutation({
    onSuccess: () => { toast.success("Sequence generation started"); setTimeout(() => utils.are.prospects.list.invalidate(), 5000); },
    onError: (e) => toast.error(e.message),
  });

  const SrcIcon = SOURCE_ICON[p.sourceType] ?? Globe;
  const enrichColor = ENRICH_COLOR[p.enrichmentStatus] ?? "#94A3B8";
  const seqColor = SEQ_COLOR[p.sequenceStatus] ?? "#94A3B8";

  return (
    <div
      className={`group flex items-center gap-3 rounded-xl border px-3 py-2.5 cursor-pointer transition-all ${
        selected
          ? "border-primary/50 bg-primary/5 shadow-sm"
          : "border-border bg-card hover:border-primary/20 hover:shadow-sm"
      }`}
      onClick={() => onSelect(p.id)}
    >
      {/* ICP ring or source icon */}
      {p.icpMatchScore != null ? (
        <IcpRing score={p.icpMatchScore} />
      ) : (
        <div className="size-9 rounded-full bg-muted flex items-center justify-center shrink-0">
          <SrcIcon className="size-4 text-muted-foreground" />
        </div>
      )}

      {/* Name + company */}
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium truncate">{p.firstName} {p.lastName}</div>
        <div className="text-xs text-muted-foreground truncate">
          {[p.title, p.companyName].filter(Boolean).join(" · ") || "—"}
        </div>
      </div>

      {/* Status badges */}
      <div className="hidden sm:flex items-center gap-1.5 shrink-0">
        <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-5 border-0"
          style={{ backgroundColor: enrichColor + "22", color: enrichColor }}>
          {p.enrichmentStatus}
        </Badge>
        <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-5 border-0"
          style={{ backgroundColor: seqColor + "22", color: seqColor }}>
          {p.sequenceStatus}
        </Badge>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
        {p.enrichmentStatus === "pending" && (
          <Button size="sm" variant="ghost" className="h-7 px-2 text-xs text-blue-500 hover:text-blue-600"
            onClick={() => enrich.mutate({ prospectId: p.id })} disabled={enrich.isPending}>
            {enrich.isPending ? <Loader2 className="size-3 animate-spin" /> : <FlaskConical className="size-3" />}
          </Button>
        )}
        {p.enrichmentStatus === "complete" && p.sequenceStatus === "pending" && (
          <Button size="sm" variant="ghost" className="h-7 px-2 text-xs text-violet-500 hover:text-violet-600"
            onClick={() => genSeq.mutate({ prospectId: p.id, campaignId })} disabled={genSeq.isPending}>
            {genSeq.isPending ? <Loader2 className="size-3 animate-spin" /> : <Sparkles className="size-3" />}
          </Button>
        )}
        {p.enrichmentStatus === "complete" && p.sequenceStatus === "pending" && (
          <Button size="sm" variant="ghost" className="h-7 px-2 text-xs text-emerald-600 hover:text-emerald-700"
            onClick={() => approve.mutate({ prospectId: p.id })} disabled={approve.isPending}>
            {approve.isPending ? <Loader2 className="size-3 animate-spin" /> : <CheckCircle2 className="size-3" />}
          </Button>
        )}
        <Button size="sm" variant="ghost" className="h-7 px-2 text-xs text-muted-foreground hover:text-destructive"
          onClick={() => skip.mutate({ prospectId: p.id })} disabled={skip.isPending}>
          <X className="size-3" />
        </Button>
      </div>

      <ChevronRight className="size-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
    </div>
  );
}

/* ─── Intelligence dossier (Sheet content) ─────────────────────────────────── */
function IntelligenceDossier({ prospect }: { prospect: any }) {
  const { data: intel, isLoading } = trpc.are.prospects.getIntelligence.useQuery(
    { prospectId: prospect.id },
    { enabled: !!prospect.id },
  );

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground py-16 justify-center">
        <Loader2 className="size-4 animate-spin" /> Building intelligence dossier…
      </div>
    );
  }

  if (!intel) {
    return (
      <EmptyState
        icon={FlaskConical}
        title="No intelligence yet"
        description="Run the Enrich Agent on this prospect to generate their intelligence dossier."
      />
    );
  }

  const hooks = (intel.personalisationHooks as Array<{ hook: string; hookType: string }> | null) ?? [];
  const triggers = (intel.triggerEvents as Array<{ type: string; description: string; date?: string }> | null) ?? [];
  const pains = (intel.painSignals as Array<{ signal: string; evidence: string; strength: number }> | null) ?? [];
  const news = (intel.recentNews as Array<{ headline: string; url?: string; date?: string; sentiment?: string }> | null) ?? [];
  const events = (intel.industryEvents as Array<{ eventName: string; date?: string; role?: string }> | null) ?? [];
  const sequence = (intel.generatedSequence as Array<{ stepIndex: number; day: number; channel: string; subject?: string; body: string }> | null) ?? [];
  const qualityScore = intel.sequenceQualityScore ?? 0;

  return (
    <div className="space-y-6 pb-8">
      {/* Confidence + channel */}
      <div className="flex items-center gap-4 p-3 rounded-xl bg-muted/50 border">
        <div className="text-center">
          <div className="text-2xl font-bold tabular-nums" style={{ color: (intel.enrichmentConfidence ?? 0) >= 70 ? "#34D399" : "#F59E0B" }}>
            {intel.enrichmentConfidence ?? 0}%
          </div>
          <div className="text-[10px] text-muted-foreground uppercase tracking-wider">Confidence</div>
        </div>
        <Separator orientation="vertical" className="h-10" />
        <div>
          <div className="text-sm font-medium capitalize">{intel.recommendedChannel ?? "email"}</div>
          <div className="text-[10px] text-muted-foreground">Recommended channel</div>
        </div>
        {intel.recommendedTiming && (
          <>
            <Separator orientation="vertical" className="h-10" />
            <div>
              <div className="text-sm font-medium">{intel.recommendedTiming}</div>
              <div className="text-[10px] text-muted-foreground">Best timing</div>
            </div>
          </>
        )}
      </div>

      {/* Company one-liner */}
      {intel.companyOneLiner && (
        <blockquote className="border-l-4 border-primary/40 pl-3 py-1 text-sm text-muted-foreground italic">
          {intel.companyOneLiner}
        </blockquote>
      )}

      {/* Personalisation hooks */}
      {hooks.length > 0 && (
        <div>
          <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
            <Sparkles className="size-3 text-emerald-500" /> Personalisation Hooks
          </div>
          <div className="space-y-2">
            {hooks.map((h, i) => (
              <div key={i} className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-3 py-2.5">
                <div className="text-xs leading-relaxed">{h.hook}</div>
                <div className="text-[10px] text-muted-foreground mt-1 capitalize">{h.hookType?.replace(/_/g, " ")}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Trigger events */}
      {triggers.length > 0 && (
        <div>
          <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
            <Zap className="size-3 text-amber-500" /> Trigger Events
          </div>
          <div className="space-y-1.5">
            {triggers.map((t, i) => (
              <div key={i} className="flex items-start gap-2 text-xs">
                <span className="text-amber-500 mt-0.5 shrink-0">▸</span>
                <div>
                  <span className="font-medium">{t.type}: </span>
                  <span className="text-muted-foreground">{t.description}</span>
                  {t.date && <span className="text-muted-foreground/60 ml-1">({t.date})</span>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Pain signals */}
      {pains.length > 0 && (
        <div>
          <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
            <Target className="size-3 text-red-500" /> Pain Signals
          </div>
          <div className="space-y-2">
            {pains.map((p, i) => (
              <div key={i} className="rounded-lg border bg-card px-3 py-2">
                <div className="flex items-center justify-between gap-2 mb-1">
                  <span className="text-xs font-medium">{p.signal}</span>
                  <div className="flex items-center gap-1">
                    {Array.from({ length: 5 }).map((_, j) => (
                      <div key={j} className={`size-1.5 rounded-full ${j < (p.strength ?? 0) ? "bg-red-500" : "bg-muted"}`} />
                    ))}
                  </div>
                </div>
                <div className="text-[11px] text-muted-foreground">{p.evidence}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Recent news */}
      {news.length > 0 && (
        <div>
          <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
            <Newspaper className="size-3 text-blue-500" /> Recent News
          </div>
          <div className="space-y-1.5">
            {news.map((n, i) => (
              <div key={i} className="flex items-start gap-2 text-xs">
                <div className="size-1.5 rounded-full bg-blue-400 mt-1.5 shrink-0" />
                <div>
                  <span className="text-blue-600 dark:text-blue-400">{n.headline}</span>
                  {n.date && <span className="text-muted-foreground ml-2">{n.date}</span>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Industry events */}
      {events.length > 0 && (
        <div>
          <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
            <Activity className="size-3 text-violet-500" /> Industry Events
          </div>
          <div className="space-y-1.5">
            {events.map((e, i) => (
              <div key={i} className="flex items-start gap-2 text-xs">
                <div className="size-1.5 rounded-full bg-violet-400 mt-1.5 shrink-0" />
                <div>
                  <span className="font-medium">{e.eventName}</span>
                  {e.date && <span className="text-muted-foreground ml-2">{e.date}</span>}
                  {e.role && <span className="text-muted-foreground"> · {e.role}</span>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Generated sequence */}
      {sequence.length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              <MessageSquare className="size-3 text-emerald-500" /> Generated Sequence
            </div>
            <div className="flex items-center gap-2">
              <div className="text-[11px] text-muted-foreground">Quality</div>
              <div className="w-20">
                <Progress value={(qualityScore / 40) * 100} className="h-1.5" />
              </div>
              <div className="text-[11px] font-mono tabular-nums text-emerald-600">{qualityScore}/40</div>
            </div>
          </div>
          <div className="space-y-3">
            {sequence.map((step) => (
              <div key={step.stepIndex} className="rounded-xl border bg-card p-3">
                <div className="flex items-center gap-2 mb-2">
                  <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-5">Day {step.day}</Badge>
                  <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-5 border-blue-500/30 text-blue-600 bg-blue-500/10 capitalize">
                    {step.channel}
                  </Badge>
                  {step.subject && (
                    <span className="text-xs font-medium truncate flex-1">{step.subject}</span>
                  )}
                </div>
                <p className="text-xs text-muted-foreground leading-relaxed whitespace-pre-wrap">{step.body}</p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* ─── Prospect notes ──────────────────────────────────────────────────────── */
function ProspectNotes({ prospectId, campaignId }: { prospectId: number; campaignId: number }) {
  const utils = trpc.useUtils();
  const { data: notes, isLoading } = trpc.are.prospects.listNotes.useQuery({ prospectId });
  const [draft, setDraft] = useState("");
  const [draftCategory, setDraftCategory] = useState<"general" | "qualification" | "objection" | "follow_up" | "intel">("general");
  const [search, setSearch] = useState("");
  const [filterCategory, setFilterCategory] = useState<string>("all");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editBody, setEditBody] = useState("");
  const { data: workspaceMembers } = trpc.are.prospects.getWorkspaceMembers.useQuery();
  const [mentionQuery, setMentionQuery] = useState("");
  const [showMentionPicker, setShowMentionPicker] = useState(false);
  const [mentionAnchor, setMentionAnchor] = useState<number>(-1);

  const invalidate = () => utils.are.prospects.listNotes.invalidate({ prospectId });

  const addNote = trpc.are.prospects.addNote.useMutation({
    onSuccess: () => { setDraft(""); invalidate(); },
    onError: (e) => toast.error(e.message),
  });
  // campaignId is passed through to addNote for deep-link generation in mention notifications
  const editNote = trpc.are.prospects.editNote.useMutation({
    onSuccess: () => { setEditingId(null); invalidate(); },
    onError: (e) => toast.error(e.message),
  });
  const deleteNote = trpc.are.prospects.deleteNote.useMutation({
    onSuccess: invalidate,
    onError: (e) => toast.error(e.message),
  });
  const pinNote = trpc.are.prospects.pinNote.useMutation({
    onSuccess: invalidate,
    onError: (e) => toast.error(e.message),
  });

  const CATEGORIES = [
    { value: "general", label: "General", color: "bg-muted text-muted-foreground" },
    { value: "qualification", label: "Qualification", color: "bg-blue-500/10 text-blue-600" },
    { value: "objection", label: "Objection", color: "bg-red-500/10 text-red-600" },
    { value: "follow_up", label: "Follow-up", color: "bg-amber-500/10 text-amber-600" },
    { value: "intel", label: "Intel", color: "bg-violet-500/10 text-violet-600" },
  ];
  const catColor = (cat: string) => CATEGORIES.find(c => c.value === cat)?.color ?? "bg-muted text-muted-foreground";
  const catLabel = (cat: string) => CATEGORIES.find(c => c.value === cat)?.label ?? cat;

  const filtered = (notes ?? []).filter(n => {
    const matchCat = filterCategory === "all" || n.category === filterCategory;
    const matchSearch = !search || n.body?.toLowerCase().includes(search.toLowerCase());
    return matchCat && matchSearch;
  }).sort((a, b) => (b.isPinned ? 1 : 0) - (a.isPinned ? 1 : 0));

  return (
    <div className="space-y-3 pb-8">
      {/* Search + filter bar */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground pointer-events-none" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search notes..."
            className="w-full pl-8 pr-3 py-1.5 text-xs rounded-lg border bg-background focus:outline-none focus:ring-1 focus:ring-primary/50"
          />
        </div>
        <select
          value={filterCategory}
          onChange={(e) => setFilterCategory(e.target.value)}
          className="text-xs rounded-lg border bg-background px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-primary/50"
        >
          <option value="all">All categories</option>
          {CATEGORIES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
        </select>
      </div>

      {/* Compose */}
      <div className="space-y-2 rounded-xl border border-dashed border-border p-3 bg-muted/20">
        <div className="flex items-center gap-1.5 flex-wrap">
          {CATEGORIES.map(c => (
            <button
              key={c.value}
              onClick={() => setDraftCategory(c.value as typeof draftCategory)}
              className={`text-[10px] px-2 py-0.5 rounded-full border transition-all ${
                draftCategory === c.value
                  ? c.color + " border-transparent font-medium"
                  : "border-border text-muted-foreground hover:border-primary/30"
              }`}
            >
              {c.label}
            </button>
          ))}
        </div>
        <div className="relative">
          <Textarea
            value={draft}
            onChange={(e) => {
              const val = e.target.value;
              setDraft(val);
              // Detect @mention trigger
              const cursor = e.target.selectionStart ?? val.length;
              const textBefore = val.slice(0, cursor);
              const atIdx = textBefore.lastIndexOf("@");
              if (atIdx !== -1 && !textBefore.slice(atIdx).includes(" ")) {
                setMentionAnchor(atIdx);
                setMentionQuery(textBefore.slice(atIdx + 1));
                setShowMentionPicker(true);
              } else {
                setShowMentionPicker(false);
                setMentionAnchor(-1);
              }
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") setShowMentionPicker(false);
            }}
            placeholder="Add a note… type @ to mention a teammate"
            className="text-sm min-h-[72px] resize-none"
            maxLength={4000}
          />
          {showMentionPicker && (workspaceMembers ?? []).filter(m =>
            !mentionQuery || m.name?.toLowerCase().includes(mentionQuery.toLowerCase())
          ).length > 0 && (
            <div className="absolute z-50 bottom-full mb-1 left-0 w-56 rounded-xl border bg-popover shadow-lg overflow-hidden">
              <div className="px-2 py-1 text-[10px] text-muted-foreground border-b flex items-center gap-1">
                <AtSign className="size-3" /> Mention a teammate
              </div>
              {(workspaceMembers ?? [])
                .filter(m => !mentionQuery || m.name?.toLowerCase().includes(mentionQuery.toLowerCase()))
                .slice(0, 6)
                .map((m) => (
                  <button
                    key={m.userId}
                    type="button"
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-accent transition-colors text-left"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      // Replace the @query with @name
                      const before = draft.slice(0, mentionAnchor);
                      const after = draft.slice(mentionAnchor + mentionQuery.length + 1);
                      setDraft(before + "@" + m.name + " " + after);
                      setShowMentionPicker(false);
                      setMentionQuery("");
                    }}
                  >
                    <div className="size-5 rounded-full bg-primary/10 flex items-center justify-center text-[10px] font-medium text-primary shrink-0">
                      {(m.name ?? "?")[0].toUpperCase()}
                    </div>
                    <span className="truncate">{m.name}</span>
                    {m.title && <span className="text-muted-foreground truncate text-[10px]">{m.title}</span>}
                  </button>
                ))}
            </div>
          )}
        </div>
        <div className="flex items-center justify-between">
          <span className="text-[10px] text-muted-foreground">{draft.length}/4000</span>
          <Button
            size="sm" className="gap-1.5 text-xs"
            onClick={() => addNote.mutate({ prospectId, campaignId, body: draft, category: draftCategory })}
            disabled={!draft.trim() || addNote.isPending}
          >
            {addNote.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <StickyNote className="size-3.5" />}
            Save Note
          </Button>
        </div>
      </div>

      {/* Notes list */}
      {isLoading ? (
        <div className="flex items-center gap-2 text-muted-foreground py-8 justify-center">
          <Loader2 className="size-4 animate-spin" /> Loading notes...
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-10 text-muted-foreground">
          <StickyNote className="size-8 opacity-30" />
          <div className="text-sm">{search || filterCategory !== "all" ? "No matching notes" : "No notes yet"}</div>
          <div className="text-xs opacity-60">Notes are private to your workspace.</div>
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map((note) => (
            <div key={note.id} className={`rounded-xl border px-3 py-2.5 space-y-1.5 transition-all ${
              note.isPinned ? "border-amber-500/30 bg-amber-500/5" : "border-border bg-card"
            }`}>
              {editingId === note.id ? (
                <div className="space-y-2">
                  <Textarea
                    value={editBody}
                    onChange={(e) => setEditBody(e.target.value)}
                    className="text-xs min-h-[72px] resize-none"
                    maxLength={4000}
                    autoFocus
                  />
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] text-muted-foreground">{editBody.length}/4000</span>
                    <div className="flex gap-1.5">
                      <Button size="sm" variant="ghost" className="text-xs h-7" onClick={() => setEditingId(null)}>Cancel</Button>
                      <Button size="sm" className="text-xs h-7 gap-1" onClick={() => editNote.mutate({ noteId: note.id, body: editBody })} disabled={!editBody.trim() || editNote.isPending}>
                        {editNote.isPending ? <Loader2 className="size-3 animate-spin" /> : null}
                        Save
                      </Button>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="flex items-start gap-2">
                  {note.isPinned && <Pin className="size-3 text-amber-500 mt-0.5 shrink-0" />}
                  <p className="text-xs leading-relaxed flex-1 whitespace-pre-wrap">
                    {note.body.split(/(@[\w.\- ]+)/).map((part, i) =>
                      part.startsWith("@") ? (
                        <span key={i} className="inline-flex items-center gap-0.5 px-1 py-0.5 rounded bg-violet-500/10 text-violet-600 font-medium text-[10px]">
                          <AtSign className="size-2.5" />{part.slice(1)}
                        </span>
                      ) : part
                    )}
                  </p>
                  <div className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
                    <button
                      className="p-1 rounded hover:bg-muted transition-colors"
                      onClick={() => { setEditingId(note.id); setEditBody(note.body); }}
                      title="Edit"
                    >
                      <Pencil className="size-3 text-muted-foreground" />
                    </button>
                    <button
                      className="p-1 rounded hover:bg-muted transition-colors"
                      onClick={() => pinNote.mutate({ noteId: note.id, isPinned: !note.isPinned })}
                      title={note.isPinned ? "Unpin" : "Pin"}
                    >
                      <Pin className={`size-3 ${note.isPinned ? "text-amber-500" : "text-muted-foreground"}`} />
                    </button>
                    <button
                      className="p-1 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
                      onClick={() => deleteNote.mutate({ noteId: note.id })}
                      title="Delete"
                    >
                      <Trash2 className="size-3" />
                    </button>
                  </div>
                </div>
              )}
              <div className="flex items-center gap-2">
                <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${catColor(note.category ?? "general")}`}>
                  {catLabel(note.category ?? "general")}
                </span>
                <span className="text-[10px] text-muted-foreground">
                  {new Date(note.createdAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                  {note.editedAt && <span className="ml-1 opacity-60">(edited)</span>}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}


/* ─── Main page ────────────────────────────────────────────────────────────── */
export default function ARECampaignDetail() {
  const { id } = useParams<{ id: string }>();
  const campaignId = parseInt(id ?? "0");
  const utils = trpc.useUtils();

  const { data: campaign, isLoading: loadingCampaign } = trpc.are.campaigns.get.useQuery({ id: campaignId });
  const { data: prospects, isLoading: loadingProspects } = trpc.are.prospects.list.useQuery({ campaignId, limit: 100 });
  const { data: signals } = trpc.are.execution.getSignalLog.useQuery({ campaignId, limit: 50 });
  const { data: abVariants } = trpc.are.prospects.getAbVariants.useQuery({ campaignId });
  const { data: rejectionStats } = trpc.are.prospects.getRejectionStats.useQuery({ campaignId });
  const { data: csvData, refetch: fetchCsv } = trpc.are.prospects.exportRejections.useQuery(
    { campaignId },
    { enabled: false }
  );
  const reEvaluate = trpc.are.prospects.reEvaluate.useMutation({
    onSuccess: (d) => {
      toast.success(
        d.newStatus === "pending"
          ? `Re-qualified! New ICP score: ${d.newScore}`
          : `Still below threshold. New score: ${d.newScore}`
      );
      utils.are.prospects.getRejectionStats.invalidate({ campaignId });
      utils.are.prospects.list.invalidate({ campaignId });
    },
    onError: (e) => toast.error(e.message),
  });
  const reEvaluateAll = trpc.are.prospects.reEvaluateAll.useMutation({
    onSuccess: (d) => {
      toast.success(
        d.requalified > 0
          ? `Re-evaluated ${d.processed} prospects — ${d.requalified} re-qualified!`
          : `Re-evaluated ${d.processed} prospects — none met the threshold.`
      );
      utils.are.prospects.getRejectionStats.invalidate({ campaignId });
      utils.are.prospects.list.invalidate({ campaignId });
    },
    onError: (e) => toast.error(e.message),
  });
  const handleExportCsv = async () => {
    const result = await fetchCsv();
    if (!result.data?.csv) { toast.error("No data to export"); return; }
    const blob = new Blob([result.data.csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `rejections-campaign-${campaignId}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success(`Exported ${result.data.count} rejections`);
  };

  const [selectedProspectId, setSelectedProspectId] = useState<number | null>(null);
  const [dossierOpen, setDossierOpen] = useState(false);
  const [scrapeQuery, setScrapeQuery] = useState("");
  const [scrapeSource, setScrapeSource] = useState<"google_business" | "linkedin" | "web" | "news">("google_business");
  const [thresholdDraft, setThresholdDraft] = useState<number | null>(null);
  const [s2oEnabled, setS2oEnabled] = useState<boolean | null>(null);
  // Bulk selection
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [rejectDialogOpen, setRejectDialogOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const [dossierTab, setDossierTab] = useState<"intel" | "notes">("intel");
  const bulkApprove = trpc.are.prospects.bulkApprove.useMutation({
    onSuccess: (d) => {
      toast.success(`Approved ${d.approved} prospects`);
      setSelectedIds(new Set());
      utils.are.prospects.list.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });
  const bulkReject = trpc.are.prospects.bulkReject.useMutation({
    onSuccess: (d) => {
      toast.success(`Rejected ${d.rejected} prospects`);
      setSelectedIds(new Set());
      setRejectDialogOpen(false);
      setRejectReason("");
      utils.are.prospects.list.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });
  const toggleSelect = (id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const toggleSelectAll = () => {
    if (!prospects) return;
    if (selectedIds.size === prospects.length) setSelectedIds(new Set());
    else setSelectedIds(new Set(prospects.map((p) => p.id)));
  };

  const updateCampaign = trpc.are.campaigns.update.useMutation({
    onSuccess: () => {
      toast.success("Campaign settings saved");
      utils.are.campaigns.get.invalidate({ id: campaignId });
      setThresholdDraft(null);
      setS2oEnabled(null);
    },
    onError: (e) => toast.error(e.message),
  });

  const setStatus = trpc.are.campaigns.setStatus.useMutation({
    onSuccess: () => utils.are.campaigns.get.invalidate({ id: campaignId }),
    onError: (e) => toast.error(e.message),
  });

  const enrichBatch = trpc.are.prospects.enrichBatch.useMutation({
    onSuccess: (d) => {
      toast.success(`Enrichment started for ${d.started} prospects`);
      setTimeout(() => utils.are.prospects.list.invalidate(), 3000);
    },
    onError: (e) => toast.error(e.message),
  });

  const scrape = trpc.are.scraper.run.useMutation({
    onSuccess: (d) => {
      toast.success(`Scraped ${d.prospectsAdded} prospects from ${d.source.replace(/_/g, " ")}`);
      utils.are.prospects.list.invalidate();
      utils.are.campaigns.get.invalidate({ id: campaignId });
    },
    onError: (e) => toast.error(e.message),
  });

  if (loadingCampaign) {
    return (
      <Shell title="Campaign">
        <div className="flex items-center gap-2 text-muted-foreground py-24 justify-center">
          <Loader2 className="size-5 animate-spin" /> Loading campaign…
        </div>
      </Shell>
    );
  }

  if (!campaign) {
    return (
      <Shell title="Campaign">
        <div className="p-6 text-muted-foreground">Campaign not found.</div>
      </Shell>
    );
  }

  const selectedProspect = prospects?.find((p) => p.id === selectedProspectId);
  const pendingEnrich = prospects?.filter((p) => p.enrichmentStatus === "pending").length ?? 0;
  const awaitingApproval = prospects?.filter((p) => p.sequenceStatus === "pending" && p.enrichmentStatus === "complete").length ?? 0;
  const autoThreshold = thresholdDraft !== null ? thresholdDraft : (campaign?.autoApproveThreshold ?? null);
  const s2oActive = s2oEnabled !== null ? s2oEnabled : (campaign?.signalToOpportunityEnabled ?? false);

  const statusColor = campaign.status === "active" ? "#34D399" : campaign.status === "paused" ? "#F59E0B" : "#94A3B8";
  const autonomyColor =
    campaign.autonomyMode === "full" ? "border-emerald-500/30 text-emerald-600 bg-emerald-500/10"
    : campaign.autonomyMode === "batch_approval" ? "border-blue-500/30 text-blue-600 bg-blue-500/10"
    : "border-amber-500/30 text-amber-600 bg-amber-500/10";

  return (
    <Shell title={campaign.name}>
      {/* ── Header ── */}
      <PageHeader
        title={campaign.name}
        description={campaign.description ?? undefined}
      >
        <Link href="/are/campaigns">
          <Button variant="ghost" size="sm" className="gap-1.5 text-xs text-muted-foreground">
            <ArrowLeft className="size-3.5" /> All Campaigns
          </Button>
        </Link>
        <Badge variant="outline" className={`text-[10px] px-2 py-0.5 border ${autonomyColor}`}>
          {campaign.autonomyMode?.replace(/_/g, " ")}
        </Badge>
        <Badge variant="outline" className="text-[10px] px-2 py-0.5 border-0"
          style={{ backgroundColor: statusColor + "22", color: statusColor }}>
          {campaign.status}
        </Badge>
        {campaign.status === "active" ? (
          <Button size="sm" variant="outline" className="gap-1.5 text-xs"
            onClick={() => setStatus.mutate({ id: campaignId, status: "paused" })}
            disabled={setStatus.isPending}>
            {setStatus.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Pause className="size-3.5" />}
            Pause
          </Button>
        ) : (
          <Button size="sm" className="gap-1.5 text-xs"
            onClick={() => setStatus.mutate({ id: campaignId, status: "active" })}
            disabled={setStatus.isPending}>
            {setStatus.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
            Activate
          </Button>
        )}
      </PageHeader>

      <div className="p-4 md:p-6 space-y-6 max-w-7xl mx-auto">

        {/* ── Metrics row ── */}
        <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-7 gap-3">
          <StatCard label="Discovered" value={campaign.prospectsDiscovered ?? 0} />
          <StatCard label="Enriched" value={campaign.prospectsEnriched ?? 0} />
          <StatCard label="Approved" value={campaign.prospectsApproved ?? 0} />
          <StatCard label="Enrolled" value={campaign.prospectsEnrolled ?? 0} />
          <StatCard label="Contacted" value={campaign.prospectsContacted ?? 0} />
          <StatCard label="Replied" value={campaign.prospectsReplied ?? 0} tone={(campaign.prospectsReplied ?? 0) > 0 ? "success" : undefined} />
          <StatCard label="Meetings" value={campaign.meetingsBooked ?? 0} tone={(campaign.meetingsBooked ?? 0) > 0 ? "success" : undefined} />
        </div>

        {/* ── Tabs ── */}
        <Tabs defaultValue="prospects">
          <TabsList className="bg-muted/50 border">
            <TabsTrigger value="prospects" className="text-xs gap-1.5">
              <Users className="size-3.5" />
              Prospects
              {(prospects?.length ?? 0) > 0 && (
                <span className="ml-1 text-[10px] bg-primary/20 text-primary rounded-full px-1.5 py-0.5 font-medium">
                  {prospects?.length}
                </span>
              )}
            </TabsTrigger>
            <TabsTrigger value="scraper" className="text-xs gap-1.5">
              <Search className="size-3.5" /> Scraper
            </TabsTrigger>
            <TabsTrigger value="ab" className="text-xs gap-1.5">
              <Sparkles className="size-3.5" /> A/B Variants
              {(abVariants?.length ?? 0) > 0 && (
                <span className="ml-1 text-[10px] bg-primary/20 text-primary rounded-full px-1.5 py-0.5 font-medium">
                  {abVariants?.length}
                </span>
              )}
            </TabsTrigger>
            <TabsTrigger value="signals" className="text-xs gap-1.5">
              <Activity className="size-3.5" /> Signals
              {(signals?.length ?? 0) > 0 && (
                <span className="ml-1 text-[10px] bg-primary/20 text-primary rounded-full px-1.5 py-0.5 font-medium">
                  {signals?.length}
                </span>
              )}
            </TabsTrigger>
            <TabsTrigger value="settings" className="text-xs gap-1.5">
              <Settings className="size-3.5" /> Settings
            </TabsTrigger>
            <TabsTrigger value="rejections" className="text-xs gap-1.5">
              <XCircle className="size-3.5" /> Rejections
              {(rejectionStats?.total ?? 0) > 0 && (
                <span className="ml-1 text-[10px] bg-destructive/15 text-destructive rounded-full px-1.5 py-0.5 font-medium">
                  {rejectionStats?.total}
                </span>
              )}
            </TabsTrigger>
          </TabsList>

          {/* ── Prospects tab ── */}
          <TabsContent value="prospects" className="mt-4">
            {/* Action bar */}
            <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
              <div className="flex items-center gap-3 text-xs text-muted-foreground">
                {pendingEnrich > 0 && (
                  <span className="flex items-center gap-1">
                    <div className="size-1.5 rounded-full bg-amber-400" />
                    {pendingEnrich} pending enrichment
                  </span>
                )}
                {awaitingApproval > 0 && (
                  <span className="flex items-center gap-1">
                    <div className="size-1.5 rounded-full bg-emerald-400" />
                    {awaitingApproval} awaiting approval
                  </span>
                )}
              </div>
              <Button
                size="sm" variant="outline" className="gap-1.5 text-xs"
                onClick={() => enrichBatch.mutate({ campaignId, limit: 20 })}
                disabled={enrichBatch.isPending || pendingEnrich === 0}
              >
                {enrichBatch.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <FlaskConical className="size-3.5" />}
                Enrich Batch (20)
              </Button>
            </div>

            {/* Select-all + legend row */}
            <div className="flex items-center gap-4 mb-3 text-[11px] text-muted-foreground">
              {prospects && prospects.length > 0 && (
                <label className="flex items-center gap-1.5 cursor-pointer select-none">
                  <Checkbox
                    checked={selectedIds.size === prospects.length && prospects.length > 0}
                    onCheckedChange={toggleSelectAll}
                    className="size-3.5"
                  />
                  <span>All</span>
                </label>
              )}
              <span className="flex items-center gap-1"><div className="size-2 rounded-full bg-[#34D399]" /> complete</span>
              <span className="flex items-center gap-1"><div className="size-2 rounded-full bg-[#F59E0B]" /> enriching</span>
              <span className="flex items-center gap-1"><div className="size-2 rounded-full bg-[#94A3B8]" /> pending</span>
              <span className="flex items-center gap-1"><div className="size-2 rounded-full bg-[#F87171]" /> failed</span>
              <span className="ml-auto flex items-center gap-1"><Eye className="size-3" /> Click row to view dossier</span>
            </div>
            {/* Floating bulk action bar */}
            {selectedIds.size > 0 && (
              <div className="flex items-center gap-3 mb-3 px-4 py-2.5 rounded-xl border border-primary/30 bg-primary/5 shadow-sm">
                <span className="text-xs font-medium text-primary">{selectedIds.size} selected</span>
                <div className="flex items-center gap-2 ml-auto">
                  <Button
                    size="sm" variant="outline"
                    className="h-7 px-3 text-xs gap-1.5 border-emerald-500/30 text-emerald-600 hover:bg-emerald-500/10"
                    onClick={() => bulkApprove.mutate({ prospectIds: Array.from(selectedIds) })}
                    disabled={bulkApprove.isPending}
                  >
                    {bulkApprove.isPending ? <Loader2 className="size-3 animate-spin" /> : <CheckCircle2 className="size-3" />}
                    Approve All
                  </Button>
                  <Button
                    size="sm" variant="outline"
                    className="h-7 px-3 text-xs gap-1.5 border-destructive/30 text-destructive hover:bg-destructive/10"
                    onClick={() => setRejectDialogOpen(true)}
                  >
                    <XCircle className="size-3" /> Reject All
                  </Button>
                  <Button
                    size="sm" variant="ghost"
                    className="h-7 px-2 text-xs text-muted-foreground"
                    onClick={() => setSelectedIds(new Set())}
                  >
                    <X className="size-3" />
                  </Button>
                </div>
              </div>
            )}

            {loadingProspects ? (
              <div className="flex items-center gap-2 text-muted-foreground py-12 justify-center">
                <Loader2 className="size-4 animate-spin" /> Loading prospects…
              </div>
            ) : !prospects || prospects.length === 0 ? (
              <EmptyState
                icon={Radar}
                title="No prospects yet"
                description="Use the Scraper tab to discover prospects from Google Business, LinkedIn, news, or the web."
                action={<Button size="sm" variant="outline" onClick={() => {}}>Go to Scraper</Button>}
              />
            ) : (
              <div className="space-y-2">
                {prospects.map((p) => (
                  <div key={p.id} className="flex items-center gap-2">
                    <Checkbox
                      checked={selectedIds.has(p.id)}
                      onCheckedChange={() => toggleSelect(p.id)}
                      className="size-3.5 shrink-0"
                      onClick={(e) => e.stopPropagation()}
                    />
                    <div className="flex-1 min-w-0">
                      <ProspectRow
                        p={p}
                        campaignId={campaignId}
                        onSelect={(id) => { setSelectedProspectId(id); setDossierOpen(true); setDossierTab("intel"); }}
                        selected={selectedProspectId === p.id}
                      />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </TabsContent>

          {/* ── Scraper tab ── */}
          <TabsContent value="scraper" className="mt-4">
            <div className="max-w-2xl space-y-5">
              <p className="text-sm text-muted-foreground leading-relaxed">
                Discover new prospects from external sources. The AI extraction engine normalises all results into structured prospect records and scores them against the active ICP.
              </p>

              {/* Source selector */}
              <div>
                <div className="text-xs font-medium text-muted-foreground mb-2">Source</div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  {(["google_business", "linkedin", "web", "news"] as const).map((s) => {
                    const Icon = SOURCE_ICON[s] ?? Globe;
                    const active = scrapeSource === s;
                    return (
                      <button
                        key={s}
                        onClick={() => setScrapeSource(s)}
                        className={`flex flex-col items-center gap-1.5 rounded-xl border p-3 text-xs transition-all ${
                          active
                            ? "border-primary/50 bg-primary/5 text-primary shadow-sm"
                            : "border-border bg-card text-muted-foreground hover:border-primary/20 hover:bg-muted/50"
                        }`}
                      >
                        <Icon className="size-5" />
                        <span className="font-medium">{SOURCE_LABEL[s]}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Query input */}
              <div>
                <div className="text-xs font-medium text-muted-foreground mb-2">Search Query</div>
                <div className="flex gap-2">
                  <input
                    value={scrapeQuery}
                    onChange={(e) => setScrapeQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && scrapeQuery.trim()) {
                        scrape.mutate({ campaignId, source: scrapeSource, query: scrapeQuery, limit: 20 });
                      }
                    }}
                    placeholder={
                      scrapeSource === "google_business" ? "e.g. SaaS companies London"
                      : scrapeSource === "linkedin" ? "e.g. VP Sales fintech"
                      : scrapeSource === "news" ? "e.g. Series B funding 2024"
                      : "e.g. B2B software companies hiring"
                    }
                    className="flex-1 rounded-lg border bg-background text-sm px-3 py-2 placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/30"
                  />
                  <Button
                    onClick={() => scrape.mutate({ campaignId, source: scrapeSource, query: scrapeQuery, limit: 20 })}
                    disabled={scrape.isPending || !scrapeQuery.trim()}
                    className="gap-1.5"
                  >
                    {scrape.isPending ? <Loader2 className="size-4 animate-spin" /> : <Search className="size-4" />}
                    {scrape.isPending ? "Scraping…" : "Scrape"}
                  </Button>
                </div>
              </div>

              {/* Source descriptions */}
              <Card className="bg-muted/30 border-dashed">
                <CardContent className="pt-4 pb-4">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs text-muted-foreground">
                    <div className="flex items-start gap-2">
                      <Globe className="size-3.5 mt-0.5 text-blue-500 shrink-0" />
                      <div><strong className="text-foreground">Google Business</strong> — Company listings with contact info, reviews, and location data.</div>
                    </div>
                    <div className="flex items-start gap-2">
                      <Linkedin className="size-3.5 mt-0.5 text-blue-600 shrink-0" />
                      <div><strong className="text-foreground">LinkedIn</strong> — People and company profiles via Unipile integration.</div>
                    </div>
                    <div className="flex items-start gap-2">
                      <Newspaper className="size-3.5 mt-0.5 text-amber-500 shrink-0" />
                      <div><strong className="text-foreground">News</strong> — Companies making relevant announcements (funding, hiring, launches).</div>
                    </div>
                    <div className="flex items-start gap-2">
                      <Globe className="size-3.5 mt-0.5 text-emerald-500 shrink-0" />
                      <div><strong className="text-foreground">Web</strong> — General directory and company listing pages.</div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>
          </TabsContent>

          {/* ── A/B Variants tab ── */}
          <TabsContent value="ab" className="mt-4">
            {!abVariants || abVariants.length === 0 ? (
              <EmptyState
                icon={Sparkles}
                title="No A/B variants yet"
                description="Generate sequences for prospects to see variant performance here. The Sequence Agent automatically creates two variants per step."
              />
            ) : (
              <div className="space-y-4">
                <p className="text-sm text-muted-foreground">
                  The Sequence Agent generates two variants per step: <strong>Variant A</strong> uses a personalisation hook, <strong>Variant B</strong> uses a trigger event hook. Performance updates as messages are sent.
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
                  {abVariants.map((v) => {
                    const replyRate = v.sentCount > 0 ? ((v.replyCount / v.sentCount) * 100) : 0;
                    const isA = v.variantKey === "A";
                    return (
                      <Card key={v.id} className="bg-card border">
                        <CardHeader className="pb-2 pt-4 px-4">
                          <div className="flex items-center gap-2">
                            <Badge variant="outline" className={`text-[10px] px-2 py-0.5 border font-bold ${isA ? "border-emerald-500/30 text-emerald-600 bg-emerald-500/10" : "border-blue-500/30 text-blue-600 bg-blue-500/10"}`}>
                              Variant {v.variantKey}
                            </Badge>
                            <span className="text-xs text-muted-foreground">Step {v.stepIndex}</span>
                            {v.hookType && (
                              <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 ml-auto capitalize">
                                {v.hookType.replace(/_/g, " ")}
                              </Badge>
                            )}
                          </div>
                          {v.subjectLine && (
                            <div className="text-xs font-medium mt-1.5 line-clamp-1">{v.subjectLine}</div>
                          )}
                        </CardHeader>
                        <CardContent className="px-4 pb-4 space-y-3">
                          <p className="text-xs text-muted-foreground leading-relaxed line-clamp-3">{v.bodyPreview}</p>
                          <div className="space-y-1.5">
                            <div className="flex items-center justify-between text-[11px]">
                              <span className="text-muted-foreground">Reply rate</span>
                              <span className={`font-semibold tabular-nums ${replyRate > 0 ? "text-emerald-600" : "text-muted-foreground"}`}>
                                {replyRate.toFixed(1)}%
                              </span>
                            </div>
                            <Progress value={replyRate} className="h-1.5" />
                            <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
                              <span>Sent: {v.sentCount}</span>
                              <span>Opens: {v.openCount}</span>
                              <span>Replies: {v.replyCount}</span>
                            </div>
                          </div>
                        </CardContent>
                      </Card>
                    );
                  })}
                </div>
              </div>
            )}
          </TabsContent>

          {/* ── Signal Feed tab ── */}
          <TabsContent value="signals" className="mt-4">
            {!signals || signals.length === 0 ? (
              <EmptyState
                icon={Activity}
                title="No signals yet"
                description="Signals appear here as prospects reply, open emails, or book meetings."
              />
            ) : (
              <div className="space-y-2">
                {signals.map((s) => {
                  const color = SIGNAL_COLORS[s.sentiment] ?? SIGNAL_COLORS.neutral;
                  const actionLabel = s.actionTaken && s.actionTaken !== "no_action"
                    ? s.actionTaken.replace(/_/g, " ")
                    : null;
                  return (
                    <div key={s.id} className="flex items-start gap-3 rounded-xl border bg-card px-4 py-3">
                      <div className="size-2 rounded-full mt-2 shrink-0" style={{ backgroundColor: color }} />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm font-medium capitalize">{s.signalType.replace(/_/g, " ")}</span>
                          <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 border-0 capitalize"
                            style={{ backgroundColor: color + "22", color }}>
                            {s.sentiment}
                          </Badge>
                          {actionLabel && (
                            <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 border-emerald-500/30 text-emerald-600 bg-emerald-500/10">
                              {actionLabel}
                            </Badge>
                          )}
                        </div>
                        {s.sentimentReason && (
                          <div className="text-xs text-muted-foreground mt-0.5">{s.sentimentReason}</div>
                        )}
                      </div>
                      <div className="text-[10px] text-muted-foreground shrink-0 mt-0.5">
                        {new Date(s.processedAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
           </TabsContent>

          {/* ── Settings tab ── */}
          <TabsContent value="settings" className="mt-4">
            <div className="max-w-xl space-y-6">
              <p className="text-sm text-muted-foreground leading-relaxed">
                Configure automation behaviour for this campaign. Changes take effect immediately on the next agent run.
              </p>

              {/* Auto-approve threshold */}
              <Card className="bg-card border">
                <CardHeader className="pb-2 pt-4 px-4">
                  <CardTitle className="text-sm flex items-center gap-2">
                    <CheckCircle2 className="size-4 text-emerald-500" />
                    Auto-Approve Threshold
                  </CardTitle>
                </CardHeader>
                <CardContent className="px-4 pb-4 space-y-4">
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    Prospects whose ICP match score meets or exceeds this threshold are automatically approved and skip the manual review queue. Set to <strong>Off</strong> to require manual approval for all prospects.
                  </p>
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-medium">Threshold</span>
                      <div className="flex items-center gap-2">
                        {autoThreshold !== null ? (
                          <span className="text-sm font-bold tabular-nums" style={{ color: autoThreshold >= 70 ? "#34D399" : autoThreshold >= 40 ? "#F59E0B" : "#F87171" }}>
                            {autoThreshold}
                          </span>
                        ) : (
                          <span className="text-xs text-muted-foreground">Off (manual review)</span>
                        )}
                        <Button
                          size="sm" variant="outline" className="h-6 px-2 text-[10px]"
                          onClick={() => setThresholdDraft(autoThreshold === null ? 70 : null)}
                        >
                          {autoThreshold === null ? "Enable" : "Disable"}
                        </Button>
                      </div>
                    </div>
                    {autoThreshold !== null && (
                      <div className="space-y-2">
                        <input
                          type="range" min={0} max={100} step={5}
                          value={autoThreshold}
                          onChange={(e) => setThresholdDraft(parseInt(e.target.value))}
                          className="w-full accent-emerald-500"
                        />
                        <div className="flex justify-between text-[10px] text-muted-foreground">
                          <span>0 — approve all</span>
                          <span>50 — moderate</span>
                          <span>100 — perfect match only</span>
                        </div>
                        <div className="flex items-center gap-2 p-2 rounded-lg bg-muted/50 text-xs">
                          <div className="size-2 rounded-full shrink-0" style={{ backgroundColor: autoThreshold >= 70 ? "#34D399" : autoThreshold >= 40 ? "#F59E0B" : "#F87171" }} />
                          <span>
                            {autoThreshold >= 70 ? "High precision — only strong ICP matches will be auto-approved."
                              : autoThreshold >= 40 ? "Balanced — moderate and strong matches will be auto-approved."
                              : "High volume — most prospects will be auto-approved regardless of fit."}
                          </span>
                        </div>
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>

              {/* Signal → Opportunity */}
              <Card className="bg-card border">
                <CardHeader className="pb-2 pt-4 px-4">
                  <CardTitle className="text-sm flex items-center gap-2">
                    <Bot className="size-4 text-violet-500" />
                    Signal → Opportunity Automation
                  </CardTitle>
                </CardHeader>
                <CardContent className="px-4 pb-4 space-y-4">
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    When a <strong>meeting_booked</strong> signal is received, the AI automatically creates a CRM account, contact, and opportunity pre-filled with the prospect’s intelligence dossier (hooks, pain signals, recommended timing). The campaign owner is notified via in-app notification.
                  </p>
                  <div className="flex items-center justify-between p-3 rounded-xl border bg-muted/30">
                    <div className="space-y-0.5">
                      <div className="text-xs font-medium">Auto-create opportunity on meeting booked</div>
                      <div className="text-[11px] text-muted-foreground">Creates account + contact + opportunity in the CRM pipeline</div>
                    </div>
                    <button
                      onClick={() => setS2oEnabled(!s2oActive)}
                      className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${
                        s2oActive ? "bg-violet-500" : "bg-muted"
                      }`}
                      role="switch"
                      aria-checked={s2oActive}
                    >
                      <span className={`pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${
                        s2oActive ? "translate-x-4" : "translate-x-0"
                      }`} />
                    </button>
                  </div>
                  {s2oActive && (
                    <div className="flex items-start gap-2 p-2.5 rounded-lg border border-violet-500/20 bg-violet-500/5 text-xs">
                      <Zap className="size-3.5 text-violet-500 mt-0.5 shrink-0" />
                      <span className="text-violet-700 dark:text-violet-300">
                        Active — the next <code className="bg-violet-500/10 px-1 rounded">meeting_booked</code> signal will automatically create a discovery-stage opportunity in the pipeline.
                      </span>
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* Save button */}
              {(thresholdDraft !== null || s2oEnabled !== null) && (
                <div className="flex items-center gap-3">
                  <Button
                    onClick={() => updateCampaign.mutate({
                      id: campaignId,
                      autoApproveThreshold: autoThreshold,
                      signalToOpportunityEnabled: s2oActive,
                    })}
                    disabled={updateCampaign.isPending}
                    className="gap-1.5"
                  >
                    {updateCampaign.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <CheckCircle2 className="size-3.5" />}
                    Save Settings
                  </Button>
                  <Button
                    variant="ghost" size="sm" className="text-xs text-muted-foreground"
                    onClick={() => { setThresholdDraft(null); setS2oEnabled(null); }}
                  >
                    Discard
                  </Button>
                </div>
              )}
            </div>
          </TabsContent>
          {/* -- Rejections audit trail tab -- */}
          <TabsContent value="rejections" className="mt-4">
            {(rejectionStats?.total ?? 0) === 0 ? (
              <EmptyState
                icon={XCircle}
                title="No rejections yet"
                description="Prospects you reject will appear here with their reasons and timestamps."
              />
            ) : (
              <div className="space-y-2">
                <div className="flex items-center justify-between mb-3">
                  <p className="text-xs text-muted-foreground">
                    {rejectionStats?.total} prospect{(rejectionStats?.total ?? 0) !== 1 ? "s" : ""} rejected.
                    Use this log to refine your ICP or adjust scraper sources.
                  </p>
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      className="text-xs h-7 gap-1.5"
                      onClick={() => reEvaluateAll.mutate({ campaignId })}
                      disabled={reEvaluateAll.isPending}
                    >
                      {reEvaluateAll.isPending ? (
                        <Loader2 className="size-3 animate-spin" />
                      ) : (
                        <RefreshCcw className="size-3" />
                      )}
                      Re-evaluate All
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="text-xs h-7 gap-1.5"
                      onClick={handleExportCsv}
                    >
                      <Download className="size-3" />
                      Export CSV
                    </Button>
                  </div>
                </div>
                {(rejectionStats?.items ?? []).map((item: any) => (
                  <div key={item.id} className="flex items-start gap-3 rounded-xl border px-3 py-2.5 bg-card">
                    <XCircle className="size-4 text-destructive/60 mt-0.5 shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium truncate">
                        {item.contactName || [item.firstName, item.lastName].filter(Boolean).join(" ") || "Unknown"}
                      </div>
                      <div className="text-xs text-muted-foreground truncate">{item.companyName ?? "—"}</div>
                      {item.contactTitle && (
                        <div className="text-[10px] text-muted-foreground">{item.contactTitle}</div>
                      )}
                    </div>
                    <div className="shrink-0 text-right space-y-0.5">
                      {item.rejectionReason ? (
                        <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-5 border-destructive/20 text-destructive/80 max-w-[160px] truncate block">
                          {item.rejectionReason}
                        </Badge>
                      ) : (
                        <span className="text-[10px] text-muted-foreground italic">No reason given</span>
                      )}
                      {item.rejectedAt && (
                        <div className="text-[10px] text-muted-foreground">
                          {new Date(item.rejectedAt).toLocaleDateString([], { month: "short", day: "numeric" })}
                        </div>
                      )}
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-[10px] h-6 px-2 gap-1 text-violet-600 hover:text-violet-700 hover:bg-violet-500/10 mt-0.5"
                        onClick={() => reEvaluate.mutate({ prospectId: item.id })}
                        disabled={reEvaluate.isPending}
                      >
                        {reEvaluate.isPending ? (
                          <Loader2 className="size-3 animate-spin" />
                        ) : (
                          <RefreshCcw className="size-3" />
                        )}
                        Re-evaluate
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </TabsContent>
        </Tabs>
      </div>
      {/* ── Intelligence Dossier Sheet ── */}
      <Sheet open={dossierOpen} onOpenChange={setDossierOpen}>
        <SheetContent side="right" className="w-full sm:max-w-xl overflow-y-auto">
          <SheetHeader className="pb-4 border-b">
            <SheetTitle className="flex items-center gap-2">
              <Brain className="size-4 text-violet-500" />
              Intelligence Dossier
            </SheetTitle>
            {selectedProspect && (
              <div>
                <div className="text-sm font-medium">{selectedProspect.firstName} {selectedProspect.lastName}</div>
                <div className="text-xs text-muted-foreground">
                  {[selectedProspect.title, selectedProspect.companyName].filter(Boolean).join(" · ")}
                </div>
              </div>
            )}
          </SheetHeader>
          {/* Dossier tabs: Intel | Notes */}
          <div className="mt-3 border-b">
            <div className="flex gap-0">
              <button
                onClick={() => setDossierTab("intel")}
                className={`px-4 py-2 text-xs font-medium border-b-2 transition-colors ${
                  dossierTab === "intel"
                    ? "border-primary text-primary"
                    : "border-transparent text-muted-foreground hover:text-foreground"
                }`}
              >
                <span className="flex items-center gap-1.5"><Brain className="size-3" /> Intelligence</span>
              </button>
              <button
                onClick={() => setDossierTab("notes")}
                className={`px-4 py-2 text-xs font-medium border-b-2 transition-colors ${
                  dossierTab === "notes"
                    ? "border-primary text-primary"
                    : "border-transparent text-muted-foreground hover:text-foreground"
                }`}
              >
                <span className="flex items-center gap-1.5"><StickyNote className="size-3" /> Notes</span>
              </button>
            </div>
          </div>
          <div className="mt-4">
            {!selectedProspect ? (
              <EmptyState icon={Eye} title="No prospect selected" description="Select a prospect from the queue to view their dossier." />
            ) : dossierTab === "intel" ? (
              <IntelligenceDossier prospect={selectedProspect} />
            ) : (
              <ProspectNotes prospectId={selectedProspect.id} campaignId={campaignId} />
            )}
          </div>
        </SheetContent>
      </Sheet>

      {/* ── Reject Dialog ── */}
      <Dialog open={rejectDialogOpen} onOpenChange={setRejectDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <XCircle className="size-4 text-destructive" />
              Reject {selectedIds.size} Prospect{selectedIds.size !== 1 ? "s" : ""}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <p className="text-sm text-muted-foreground">
              These prospects will be marked as rejected and removed from the review queue. You can optionally provide a reason for the rejection.
            </p>
            <div className="flex flex-wrap gap-1.5">
              {REJECT_TEMPLATES.map((t) => (
                <button
                  key={t}
                  onClick={() => setRejectReason(t)}
                  className={`text-[10px] px-2 py-0.5 rounded-full border transition-all ${
                    rejectReason === t
                      ? "border-destructive/50 bg-destructive/10 text-destructive font-medium"
                      : "border-border text-muted-foreground hover:border-destructive/30 hover:text-destructive/80"
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>
            <Textarea
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              placeholder="Or type a custom reason…"
              className="text-sm min-h-[60px] resize-none"
            />
          </div>
          <DialogFooter className="gap-2">
            <Button variant="ghost" size="sm" onClick={() => setRejectDialogOpen(false)}>Cancel</Button>
            <Button
              variant="destructive" size="sm" className="gap-1.5"
              onClick={() => bulkReject.mutate({ prospectIds: Array.from(selectedIds), reason: rejectReason || undefined })}
              disabled={bulkReject.isPending}
            >
              {bulkReject.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <XCircle className="size-3.5" />}
              Confirm Rejection
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Shell>
  );
}
