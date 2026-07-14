/**
 * ARE Campaigns — list and create autonomous prospecting campaigns
 */
import { Shell, PageHeader } from "@/components/usip/Shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { RichTextEditor } from "@/components/usip/RichTextEditor";
import { Checkbox } from "@/components/ui/checkbox";
import { trpc } from "@/lib/trpc";
import {
  ArrowLeft,
  ArrowRight,
  Bot,
  CheckCircle2,
  Loader2,
  Pause,
  Play,
  Plus,
  Radar,
  Rocket,
  Target,
  Trash2,
  X,
  Zap,
  Megaphone,
  Sparkles,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useLocation } from "wouter";
import { toast } from "sonner";

const STATUS_COLOR: Record<string, string> = {
  draft: "#94A3B8",
  active: "#34D399",
  paused: "#F59E0B",
  completed: "#60A5FA",
};

const SOURCE_OPTIONS = [
  { id: "internal", label: "Internal CRM" },
  { id: "google_business", label: "Google Business" },
  { id: "linkedin", label: "LinkedIn" },
  { id: "web", label: "Web Scraping" },
  { id: "news", label: "News & Events" },
  { id: "ai_research", label: "AI Research" },
];

const EMPLOYEE_BANDS = [
  { value: "any", label: "Any size", min: undefined, max: undefined },
  { value: "1-10", label: "1–10", min: 1, max: 10 },
  { value: "11-50", label: "11–50", min: 11, max: 50 },
  { value: "51-200", label: "51–200", min: 51, max: 200 },
  { value: "201-500", label: "201–500", min: 201, max: 500 },
  { value: "501-1000", label: "501–1,000", min: 501, max: 1000 },
  { value: "1001-5000", label: "1,001–5,000", min: 1001, max: 5000 },
  { value: "5000+", label: "5,000+", min: 5000, max: undefined },
] as const;

/** Persona picker for the wizard step 2 — applies a saved/preset persona's
 *  targeting fields onto the form in one click. */
function PersonaApplyPicker({ onApply }: { onApply: (p: any) => void }) {
  const { data: saved = [] } = trpc.personas.list.useQuery();
  const { data: presets = [] } = trpc.personas.listPresets.useQuery();
  const [value, setValue] = useState<string>("");
  const apply = (v: string) => {
    setValue(v);
    if (v.startsWith("saved:")) {
      const id = Number(v.slice(6));
      const p = saved.find((x: any) => x.id === id);
      if (p) onApply(p);
    } else if (v.startsWith("preset:")) {
      const key = v.slice(7);
      const p = presets.find((x: any) => x.key === key);
      if (p) onApply(p);
    }
  };
  if (saved.length === 0 && presets.length === 0) return null;
  return (
    <div>
      <Label className="text-xs text-muted-foreground mb-1.5 block">Apply persona (optional)</Label>
      <Select value={value} onValueChange={apply}>
        <SelectTrigger className="text-sm"><SelectValue placeholder="Choose a persona to auto-fill targeting…" /></SelectTrigger>
        <SelectContent>
          {saved.length > 0 && (
            <>
              <div className="px-2 py-1 text-[10px] uppercase text-muted-foreground">Your personas</div>
              {saved.map((p: any) => (
                <SelectItem key={"s" + p.id} value={`saved:${p.id}`}>{p.name}</SelectItem>
              ))}
            </>
          )}
          {presets.length > 0 && (
            <>
              <div className="px-2 py-1 text-[10px] uppercase text-muted-foreground">Presets</div>
              {presets.map((p: any) => (
                <SelectItem key={"p" + p.key} value={`preset:${p.key}`}>{p.name}</SelectItem>
              ))}
            </>
          )}
        </SelectContent>
      </Select>
    </div>
  );
}

/** Chip-style multi-value text input used by the wizard targeting step. */
function TagInput({
  values,
  onChange,
  placeholder,
}: {
  values: string[];
  onChange: (v: string[]) => void;
  placeholder?: string;
}) {
  const [input, setInput] = useState("");
  const add = () => {
    const v = input.trim();
    if (v && !values.includes(v)) onChange([...values, v]);
    setInput("");
  };
  return (
    <div className="space-y-1.5">
      {values.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {values.map((v) => (
            <Badge key={v} variant="secondary" className="gap-1 pl-2 pr-1 py-0.5 text-xs">
              {v}
              <button
                onClick={() => onChange(values.filter((x) => x !== v))}
                className="hover:bg-muted-foreground/20 rounded p-0.5"
                title="Remove"
                type="button"
              >
                <X className="size-2.5" />
              </button>
            </Badge>
          ))}
        </div>
      )}
      <div className="flex gap-1">
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              add();
            }
          }}
          placeholder={placeholder}
          className="text-sm h-8"
        />
        <Button type="button" size="sm" variant="outline" onClick={add} disabled={!input.trim()}>
          <Plus className="size-3" />
        </Button>
      </div>
    </div>
  );
}

export default function ARECampaigns() {
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();
  const { data: campaigns, isLoading } = trpc.are.campaigns.list.useQuery({});
  const [showCreate, setShowCreate] = useState(false);

  const [step, setStep] = useState(1);
  const TOTAL_STEPS = 4;
  const blankForm = () => ({
    name: "",
    description: "",
    autonomyMode: "full" as "full" | "batch_approval" | "review_release",
    goalType: "reply" as "meeting_booked" | "reply" | "opportunity_created",
    targetProspectCount: 100,
    dailySendCap: 50,
    autoApproveThreshold: 60,
    prospectSources: ["google_business", "news", "web"] as string[],
    channelsEnabled: { email: true, linkedin: false, sms: false, voice: false },
    // Per-campaign targeting (stored as icpOverrides on save)
    targetTitles: [] as string[],
    targetIndustries: [] as string[],
    targetGeographies: [] as string[],
    employeeBand: "any" as (typeof EMPLOYEE_BANDS)[number]["value"],
    keywords: [] as string[],
  });
  const [form, setForm] = useState(blankForm);
  // AI targeting generation — describe the audience, AI fills the filters.
  const [aiAudience, setAiAudience] = useState("");
  const genTargeting = trpc.are.campaigns.generateTargeting.useMutation({
    onSuccess: (t) => {
      setForm((f) => ({
        ...f,
        targetTitles: t.targetTitles.length ? t.targetTitles : f.targetTitles,
        targetIndustries: t.targetIndustries.length ? t.targetIndustries : f.targetIndustries,
        targetGeographies: t.targetGeographies.length ? t.targetGeographies : f.targetGeographies,
        keywords: t.keywords.length ? t.keywords : f.keywords,
      }));
      toast.success("AI filled your targeting — review and tweak below.");
    },
    onError: (e) => toast.error(e.message),
  });

  // Reset wizard whenever the dialog reopens.
  useEffect(() => {
    if (showCreate) {
      setStep(1);
      setForm(blankForm());
    }
  }, [showCreate]);

  const create = trpc.are.campaigns.create.useMutation({
    onSuccess: (data) => {
      toast.success(
        data.launched
          ? "Campaign launched — engine is running. First tick fires now, then every 10 min."
          : "Campaign saved as draft. Activate it whenever you're ready.",
      );
      utils.are.campaigns.list.invalidate();
      setShowCreate(false);
      navigate(`/are/campaigns/${data.id}`);
    },
    onError: (e) => toast.error(e.message),
  });

  const setStatus = trpc.are.campaigns.setStatus.useMutation({
    onSuccess: () => utils.are.campaigns.list.invalidate(),
    onError: (e) => toast.error(e.message),
  });

  const deleteCampaign = trpc.are.campaigns.delete.useMutation({
    onSuccess: () => {
      toast.success("Campaign deleted");
      utils.are.campaigns.list.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const toggleSource = (id: string) => {
    setForm((f) => ({
      ...f,
      prospectSources: f.prospectSources.includes(id)
        ? f.prospectSources.filter((s) => s !== id)
        : [...f.prospectSources, id],
    }));
  };

  // Build the create payload — folds the wizard's targeting fields into
  // icpOverrides (where the engine's discovery phase reads them).
  const submitCampaign = (launch: boolean) => {
    const band = EMPLOYEE_BANDS.find((b) => b.value === form.employeeBand);
    const icpOverrides = {
      targetTitles: form.targetTitles,
      targetIndustries: form.targetIndustries,
      targetGeographies: form.targetGeographies,
      ...(band?.min !== undefined ? { employeeMin: band.min } : {}),
      ...(band?.max !== undefined ? { employeeMax: band.max } : {}),
      keywords: form.keywords,
    };
    create.mutate({
      name: form.name,
      description: form.description || undefined,
      autonomyMode: form.autonomyMode,
      goalType: form.goalType,
      targetProspectCount: form.targetProspectCount,
      dailySendCap: form.dailySendCap,
      autoApproveThreshold: form.autoApproveThreshold,
      prospectSources: form.prospectSources,
      channelsEnabled: form.channelsEnabled,
      icpOverrides,
      launch,
    });
  };

  return (
    <Shell title="ARE Campaigns">
      <PageHeader
        title="Autonomous Campaigns" pageKey="are-campaigns"
        description="Create and manage autonomous outbound campaigns that source, score, and sequence prospects. The AI handles enrichment, copywriting, and send scheduling end-to-end."
      
        icon={<Megaphone className="size-5" />}
      >
        <Button onClick={() => setShowCreate(true)} className="gap-2">
          <Plus className="size-4" /> New Campaign
        </Button>
      </PageHeader>

      <div className="p-4 md:p-6 space-y-4 max-w-5xl">
        {/* Campaign list */}
        {isLoading ? (
          <div className="flex items-center gap-2 text-muted-foreground py-12 justify-center">
            <Loader2 className="size-5 animate-spin" /> Loading campaigns…
          </div>
        ) : !campaigns || campaigns.length === 0 ? (
          <div className="rounded-xl border border-dashed p-12 text-center">
            <Bot className="size-10 text-muted-foreground/40 mx-auto mb-3" />
            <p className="text-sm text-muted-foreground mb-4">No campaigns yet. Create your first autonomous prospecting campaign.</p>
            <Button onClick={() => setShowCreate(true)} className="gap-2">
              <Plus className="size-4" /> Create Campaign
            </Button>
          </div>
        ) : (
          <div className="space-y-2">
            {campaigns.map((c) => (
              <div key={c.id} className="rounded-xl border bg-card p-4 flex items-center gap-4 hover:bg-muted/30 transition-colors">
                <div className="size-2.5 rounded-full shrink-0" style={{ backgroundColor: STATUS_COLOR[c.status] ?? "#94A3B8" }} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-0.5 flex-wrap">
                    <span className="text-sm font-medium text-foreground truncate">{c.name}</span>
                    <Badge variant="outline" className="text-[10px] capitalize">{c.status}</Badge>
                    <Badge variant="secondary" className="text-[10px]">{c.autonomyMode}</Badge>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {c.prospectsDiscovered} discovered · {c.prospectsEnriched} enriched · {c.prospectsContacted} contacted · {c.prospectsReplied} replied · {c.meetingsBooked} meetings
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  {c.status === "active" ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-amber-600 hover:text-amber-700 gap-1 text-xs"
                      onClick={() => setStatus.mutate({ id: c.id, status: "paused" })}
                    >
                      <Pause className="size-3" /> Pause
                    </Button>
                  ) : c.status === "paused" || c.status === "draft" ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-emerald-600 hover:text-emerald-700 gap-1 text-xs"
                      onClick={() => setStatus.mutate({ id: c.id, status: "active" })}
                    >
                      <Play className="size-3" /> Activate
                    </Button>
                  ) : null}
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-destructive/60 hover:text-destructive gap-1 text-xs"
                    onClick={() => {
                      if (confirm("Delete this campaign?")) deleteCampaign.mutate({ id: c.id });
                    }}
                  >
                    <Trash2 className="size-3" />
                  </Button>
                  <Link href={`/are/campaigns/${c.id}`}>
                    <Button size="sm" variant="ghost" className="gap-1 text-xs">
                      Open <ArrowRight className="size-3" />
                    </Button>
                  </Link>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Create Campaign — multi-step wizard */}
      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent className="max-w-[calc(100%-2rem)] sm:max-w-xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Bot className="size-4 text-primary" />
              New Autonomous Campaign
            </DialogTitle>
            {/* Step progress */}
            <div className="flex items-center gap-2 pt-2">
              {[
                { n: 1, label: "Basics" },
                { n: 2, label: "Targeting" },
                { n: 3, label: "Sourcing" },
                { n: 4, label: "Review" },
              ].map((s, i) => (
                <div key={s.n} className="flex items-center gap-2 flex-1">
                  <div
                    className={`size-6 rounded-full flex items-center justify-center text-[11px] font-semibold ${
                      step === s.n
                        ? "bg-primary text-primary-foreground"
                        : step > s.n
                          ? "bg-emerald-500 text-white"
                          : "bg-muted text-muted-foreground"
                    }`}
                  >
                    {step > s.n ? <CheckCircle2 className="size-3.5" /> : s.n}
                  </div>
                  <span
                    className={`text-[11px] ${step === s.n ? "font-medium text-foreground" : "text-muted-foreground"}`}
                  >
                    {s.label}
                  </span>
                  {i < 3 && <div className="flex-1 h-px bg-border" />}
                </div>
              ))}
            </div>
          </DialogHeader>

          {/* ── Step 1: Basics ───────────────────────────────────────── */}
          {step === 1 && (
            <div className="space-y-4 py-2">
              <div>
                <Label className="text-xs text-muted-foreground mb-1.5 block">Campaign Name *</Label>
                <Input
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  placeholder="e.g. Q2 SaaS RevOps VPs"
                  autoFocus
                />
              </div>
              <div>
                <Label className="text-xs text-muted-foreground mb-1.5 block">Description (optional)</Label>
                <RichTextEditor
                  value={form.description}
                  onChange={(html) => setForm((f) => ({ ...f, description: html }))}
                  placeholder="What is this campaign targeting and why?"
                  minHeight="60px"
                  maxHeight="160px"
                  compact
                />
              </div>
              <div>
                <Label className="text-xs text-muted-foreground mb-1.5 block">Primary Goal</Label>
                <Select
                  value={form.goalType}
                  onValueChange={(v) => setForm((f) => ({ ...f, goalType: v as typeof form.goalType }))}
                >
                  <SelectTrigger className="text-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="reply">Get a reply</SelectItem>
                    <SelectItem value="meeting_booked">Book a meeting</SelectItem>
                    <SelectItem value="opportunity_created">Create an opportunity</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}

          {/* ── Step 2: Targeting filters ────────────────────────────── */}
          {step === 2 && (
            <div className="space-y-4 py-2">
              {/* AI targeting — describe the audience, AI fills the filters (hands-off setup) */}
              <div className="rounded-lg border border-primary/30 bg-primary/5 p-3 space-y-2">
                <Label className="text-xs font-medium flex items-center gap-1.5">
                  <Sparkles className="size-3.5 text-primary" /> Describe your ideal audience — AI fills the targeting
                </Label>
                <div className="flex gap-2">
                  <Input
                    value={aiAudience}
                    onChange={(e) => setAiAudience(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter" && aiAudience.trim() && !genTargeting.isPending) { e.preventDefault(); genTargeting.mutate({ description: aiAudience.trim() }); } }}
                    placeholder="e.g. Nonprofit executive directors at grant-making foundations in the US"
                    className="text-sm"
                  />
                  <Button
                    type="button" size="sm" className="gap-1.5 shrink-0"
                    disabled={!aiAudience.trim() || genTargeting.isPending}
                    onClick={() => genTargeting.mutate({ description: aiAudience.trim() })}
                  >
                    {genTargeting.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}
                    Generate
                  </Button>
                </div>
                <p className="text-[11px] text-muted-foreground">AI turns your description into titles, industries, geographies, and keywords below — then edit anything.</p>
              </div>
              <div className="rounded-md bg-muted/40 px-3 py-2 text-[11px] text-muted-foreground flex items-start gap-2">
                <Target className="size-3.5 mt-0.5 flex-shrink-0" />
                <span>
                  These filters drive the engine's discovery queries (which prospects to scrape) and feed
                  the per-prospect AI enrichment context. Add as many values per field as you like — comma or Enter to add.
                </span>
              </div>
              <PersonaApplyPicker
                onApply={(p) => setForm((f) => ({
                  ...f,
                  targetTitles: (p.targetTitles as string[]) ?? f.targetTitles,
                  targetIndustries: (p.targetIndustries as string[]) ?? f.targetIndustries,
                  keywords: (p.keywords as string[]) ?? f.keywords,
                }))}
              />
              <div>
                <Label className="text-xs text-muted-foreground mb-1.5 block">Job Titles</Label>
                <TagInput
                  values={form.targetTitles}
                  onChange={(v) => setForm((f) => ({ ...f, targetTitles: v }))}
                  placeholder="e.g. VP Revenue Operations"
                />
              </div>
              <div>
                <Label className="text-xs text-muted-foreground mb-1.5 block">Industries</Label>
                <TagInput
                  values={form.targetIndustries}
                  onChange={(v) => setForm((f) => ({ ...f, targetIndustries: v }))}
                  placeholder="e.g. SaaS, Fintech"
                />
              </div>
              <div>
                <Label className="text-xs text-muted-foreground mb-1.5 block">Geographies</Label>
                <TagInput
                  values={form.targetGeographies}
                  onChange={(v) => setForm((f) => ({ ...f, targetGeographies: v }))}
                  placeholder="e.g. United States, London"
                />
              </div>
              <div>
                <Label className="text-xs text-muted-foreground mb-1.5 block">Company Size (employees)</Label>
                <Select
                  value={form.employeeBand}
                  onValueChange={(v) => setForm((f) => ({ ...f, employeeBand: v as typeof form.employeeBand }))}
                >
                  <SelectTrigger className="text-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {EMPLOYEE_BANDS.map((b) => (
                      <SelectItem key={b.value} value={b.value}>{b.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-xs text-muted-foreground mb-1.5 block">Keywords (intent / trigger signals)</Label>
                <TagInput
                  values={form.keywords}
                  onChange={(v) => setForm((f) => ({ ...f, keywords: v }))}
                  placeholder="e.g. forecast accuracy, pipeline visibility"
                />
              </div>
            </div>
          )}

          {/* ── Step 3: Sourcing + Autonomy ──────────────────────────── */}
          {step === 3 && (
            <div className="space-y-4 py-2">
              <div>
                <Label className="text-xs text-muted-foreground mb-2 block">Where to find prospects</Label>
                <div className="grid grid-cols-2 gap-2">
                  {SOURCE_OPTIONS.map((s) => (
                    <label key={s.id} className="flex items-center gap-2 cursor-pointer">
                      <Checkbox
                        checked={form.prospectSources.includes(s.id)}
                        onCheckedChange={() => toggleSource(s.id)}
                      />
                      <span className="text-xs text-foreground">{s.label}</span>
                    </label>
                  ))}
                </div>
              </div>
              <div>
                <Label className="text-xs text-muted-foreground mb-1.5 block">Autonomy</Label>
                <Select
                  value={form.autonomyMode}
                  onValueChange={(v) => setForm((f) => ({ ...f, autonomyMode: v as typeof form.autonomyMode }))}
                >
                  <SelectTrigger className="text-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="full">Full Auto — engine approves, sequences, and sends end-to-end</SelectItem>
                    <SelectItem value="batch_approval">Batch Approval — you approve batches of enriched prospects</SelectItem>
                    <SelectItem value="review_release">Review &amp; Release — every prospect requires individual approval</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-[11px] text-muted-foreground mt-1">
                  Full Auto is required for true 24/7 unattended operation.
                </p>
              </div>
              <div>
                <Label className="text-xs text-muted-foreground mb-1.5 block">
                  Auto-approve ICP score floor: <span className="font-semibold text-foreground">{form.autoApproveThreshold}</span>
                </Label>
                <input
                  type="range"
                  min={1}
                  max={100}
                  value={form.autoApproveThreshold}
                  onChange={(e) => setForm((f) => ({ ...f, autoApproveThreshold: parseInt(e.target.value) }))}
                  className="w-full"
                />
                <p className="text-[11px] text-muted-foreground mt-0.5">
                  In Full Auto, enriched prospects ≥ this score are auto-approved. Lower = looser, higher = stricter.
                </p>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label className="text-xs text-muted-foreground mb-1.5 block">Target prospects</Label>
                  <Input
                    type="number"
                    value={form.targetProspectCount}
                    onChange={(e) => setForm((f) => ({ ...f, targetProspectCount: parseInt(e.target.value) || 100 }))}
                  />
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground mb-1.5 block">Daily send cap</Label>
                  <Input
                    type="number"
                    value={form.dailySendCap}
                    onChange={(e) => setForm((f) => ({ ...f, dailySendCap: parseInt(e.target.value) || 50 }))}
                  />
                </div>
              </div>
              <div>
                <Label className="text-xs text-muted-foreground mb-2 block">Channels</Label>
                <div className="flex gap-4">
                  {(["email", "linkedin", "sms", "voice"] as const).map((ch) => (
                    <label key={ch} className="flex items-center gap-1.5 cursor-pointer">
                      <Checkbox
                        checked={form.channelsEnabled[ch]}
                        onCheckedChange={(v) => setForm((f) => ({ ...f, channelsEnabled: { ...f.channelsEnabled, [ch]: !!v } }))}
                      />
                      <span className="text-xs text-foreground capitalize">
                        {ch}
                        {ch !== "email" && <span className="text-muted-foreground/60 ml-1">(coming)</span>}
                      </span>
                    </label>
                  ))}
                </div>
                <p className="text-[11px] text-muted-foreground mt-1">
                  v1 engine sends email only — non-email steps are skipped cleanly.
                </p>
              </div>
            </div>
          )}

          {/* ── Step 4: Review + Launch ──────────────────────────────── */}
          {step === 4 && (
            <div className="space-y-3 py-2 text-sm">
              <div className="rounded-md border bg-card p-3 space-y-2">
                <div className="flex items-center gap-2 font-semibold">
                  <Rocket className="size-4 text-primary" />
                  {form.name || <span className="text-muted-foreground italic">Untitled</span>}
                </div>
                <dl className="text-xs space-y-1 [&>div]:flex [&>div]:gap-2 [&_dt]:w-32 [&_dt]:text-muted-foreground [&_dd]:flex-1">
                  <div><dt>Goal</dt><dd className="capitalize">{form.goalType.replace(/_/g, " ")}</dd></div>
                  <div><dt>Autonomy</dt><dd className="capitalize">{form.autonomyMode.replace(/_/g, " ")}</dd></div>
                  <div><dt>Titles</dt><dd>{form.targetTitles.join(", ") || <span className="text-muted-foreground italic">—</span>}</dd></div>
                  <div><dt>Industries</dt><dd>{form.targetIndustries.join(", ") || <span className="text-muted-foreground italic">—</span>}</dd></div>
                  <div><dt>Company size</dt><dd>{EMPLOYEE_BANDS.find((b) => b.value === form.employeeBand)?.label}</dd></div>
                  <div><dt>Keywords</dt><dd>{form.keywords.join(", ") || <span className="text-muted-foreground italic">—</span>}</dd></div>
                  <div><dt>Sources</dt><dd>{form.prospectSources.join(", ") || <span className="text-muted-foreground italic">none</span>}</dd></div>
                  <div><dt>Target / Daily cap</dt><dd>{form.targetProspectCount} prospects · {form.dailySendCap}/day</dd></div>
                  <div><dt>Approve floor</dt><dd>ICP ≥ {form.autoApproveThreshold}/100</dd></div>
                </dl>
              </div>
              <div className="rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-xs text-emerald-900 flex items-start gap-2">
                <Zap className="size-3.5 mt-0.5 flex-shrink-0" />
                <span>
                  <strong>Launch now</strong> activates the campaign immediately. The ARE engine will
                  fire once within seconds and then continue every 10 minutes <strong>24/7 until you
                  pause or complete it</strong> — scraping prospects, enriching, generating A/B
                  sequence variants, enrolling, and dispatching email autonomously.
                </span>
              </div>
            </div>
          )}

          <DialogFooter className="gap-2">
            {step > 1 && (
              <Button variant="ghost" onClick={() => setStep((s) => s - 1)} className="gap-1.5">
                <ArrowLeft className="size-3.5" /> Back
              </Button>
            )}
            <div className="flex-1" />
            <Button variant="ghost" onClick={() => setShowCreate(false)}>Cancel</Button>
            {step < TOTAL_STEPS ? (
              <Button
                onClick={() => setStep((s) => s + 1)}
                disabled={step === 1 && !form.name.trim()}
                className="gap-1.5"
              >
                Next <ArrowRight className="size-3.5" />
              </Button>
            ) : (
              <>
                <Button
                  variant="outline"
                  onClick={() => submitCampaign(false)}
                  disabled={create.isPending || !form.name.trim()}
                  title="Save as a draft you can review and launch later"
                >
                  Save as draft
                </Button>
                <Button
                  onClick={() => submitCampaign(true)}
                  disabled={create.isPending || !form.name.trim()}
                  className="gap-2"
                >
                  {create.isPending ? <Loader2 className="size-4 animate-spin" /> : <Rocket className="size-4" />}
                  Launch 24/7
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Shell>
  );
}
