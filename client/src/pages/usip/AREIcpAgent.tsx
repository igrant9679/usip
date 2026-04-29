/**
 * ARE ICP Agent — Enhanced
 *
 * Sections:
 *   1. PageHeader with confidence badge and Regenerate CTA
 *   2. ICP profile visual breakdown — industries, titles, geographies as tag clouds
 *   3. Buying triggers with weight bars, pain points with frequency dots
 *   4. Tech stack and company size / revenue ranges
 *   5. Override wizard — inline dialog to adjust any ICP dimension
 *   6. Version history timeline — previous ICP versions with expandable diff
 */
import { Shell, PageHeader, StatCard, EmptyState } from "@/components/usip/Shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { trpc } from "@/lib/trpc";
import {
  AlertTriangle,
  Brain,
  Building2,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  History,
  Loader2,
  MapPin,
  Pencil,
  RefreshCw,
  RotateCcw,
  Sparkles,
  Target,
  TrendingUp,
  Users,
  Wrench,
  Zap,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

/* ─── helpers ────────────────────────────────────────────────────────────── */
function parseJsonArray(v: unknown): string[] {
  if (!v) return [];
  if (Array.isArray(v)) return v.map(String);
  try {
    const p = JSON.parse(v as string);
    return Array.isArray(p) ? p.map(String) : [];
  } catch {
    return [];
  }
}

function parseJsonArrayOfObj<T>(v: unknown): T[] {
  if (!v) return [];
  if (Array.isArray(v)) return v as T[];
  try {
    const p = JSON.parse(v as string);
    return Array.isArray(p) ? (p as T[]) : [];
  } catch {
    return [];
  }
}

/* ─── Confidence badge ───────────────────────────────────────────────────── */
function ConfidenceBadge({ score }: { score: number }) {
  const color =
    score >= 70 ? "#34D399" : score >= 40 ? "#F59E0B" : "#F87171";
  const label =
    score >= 70 ? "High confidence" : score >= 40 ? "Medium confidence" : "Low confidence";
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium"
      style={{ backgroundColor: color + "22", color }}
    >
      <div className="size-1.5 rounded-full" style={{ backgroundColor: color }} />
      {label} ({score}%)
    </span>
  );
}

/* ─── Tag cloud ──────────────────────────────────────────────────────────── */
function TagCloud({ items, color = "#60A5FA" }: { items: string[]; color?: string }) {
  if (items.length === 0)
    return <div className="text-xs text-muted-foreground italic">None specified</div>;
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map((item, i) => (
        <span
          key={i}
          className="inline-flex items-center rounded-lg px-2.5 py-1 text-xs font-medium"
          style={{
            backgroundColor: color + "18",
            color,
            border: `1px solid ${color}30`,
          }}
        >
          {item}
        </span>
      ))}
    </div>
  );
}

/* ─── Section card ───────────────────────────────────────────────────────── */
function IcpSection({
  icon: Icon,
  title,
  color,
  children,
}: {
  icon: React.ElementType;
  title: string;
  color: string;
  children: React.ReactNode;
}) {
  return (
    <Card className="bg-card border">
      <CardHeader className="pb-2 pt-4 px-4">
        <div className="flex items-center gap-2">
          <div
            className="size-7 rounded-lg flex items-center justify-center"
            style={{ backgroundColor: color + "22" }}
          >
            <Icon className="size-3.5" style={{ color }} />
          </div>
          <CardTitle className="text-sm font-semibold">{title}</CardTitle>
        </div>
      </CardHeader>
      <CardContent className="px-4 pb-4">{children}</CardContent>
    </Card>
  );
}

/* ─── Bullet list ────────────────────────────────────────────────────────── */
function BulletList({ items, color }: { items: string[]; color: string }) {
  if (items.length === 0)
    return <div className="text-xs text-muted-foreground italic">None specified</div>;
  return (
    <ul className="space-y-1.5">
      {items.map((item, i) => (
        <li key={i} className="flex items-start gap-2 text-sm">
          <span
            className="mt-1.5 size-1.5 rounded-full shrink-0"
            style={{ backgroundColor: color }}
          />
          <span className="text-muted-foreground leading-relaxed">{item}</span>
        </li>
      ))}
    </ul>
  );
}

/* ─── Range bar ──────────────────────────────────────────────────────────── */
function RangeBar({
  min,
  max,
  absMax,
  label,
  color,
}: {
  min: number;
  max: number;
  absMax: number;
  label: string;
  color: string;
}) {
  const left = (min / absMax) * 100;
  const width = ((max - min) / absMax) * 100;
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-medium tabular-nums">
          {min.toLocaleString()} – {max.toLocaleString()}
        </span>
      </div>
      <div className="h-2 rounded-full bg-muted overflow-hidden relative">
        <div
          className="absolute h-full rounded-full"
          style={{
            left: `${left}%`,
            width: `${Math.max(width, 4)}%`,
            backgroundColor: color,
          }}
        />
      </div>
    </div>
  );
}

/* ─── Override dialog ────────────────────────────────────────────────────── */
function OverrideDialog({
  icp,
  open,
  onClose,
}: {
  icp: any;
  open: boolean;
  onClose: () => void;
}) {
  const utils = trpc.useUtils();
  const [industries, setIndustries] = useState(
    parseJsonArray(icp?.targetIndustries).join(", ")
  );
  const [titles, setTitles] = useState(
    parseJsonArray(icp?.targetTitles).join(", ")
  );
  const [geos, setGeos] = useState(
    parseJsonArray(icp?.targetGeographies).join(", ")
  );
  const [tech, setTech] = useState(
    parseJsonArray(icp?.targetTechStack).join(", ")
  );
  const [antiPatterns, setAntiPatterns] = useState(
    parseJsonArray(icp?.antiPatterns).join(", ")
  );
  const [sizeMin, setSizeMin] = useState(String(icp?.targetCompanySizeMin ?? ""));
  const [sizeMax, setSizeMax] = useState(String(icp?.targetCompanySizeMax ?? ""));

  const override = trpc.are.icp.override.useMutation({
    onSuccess: () => {
      toast.success("ICP profile updated");
      utils.are.icp.getCurrent.invalidate();
      onClose();
    },
    onError: (e) => toast.error(e.message),
  });

  function toArray(s: string) {
    return s
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
  }

  function handleSave() {
    override.mutate({
      targetIndustries: toArray(industries),
      targetTitles: toArray(titles),
      targetGeographies: toArray(geos),
      targetTechStack: toArray(tech),
      antiPatterns: toArray(antiPatterns),
      targetCompanySizeMin: sizeMin ? parseInt(sizeMin) : undefined,
      targetCompanySizeMax: sizeMax ? parseInt(sizeMax) : undefined,
    });
  }

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Pencil className="size-4 text-primary" /> Override ICP Profile
          </DialogTitle>
          <p className="text-sm text-muted-foreground">
            Manually adjust any ICP dimension. Comma-separate multiple values. The AI will
            incorporate these overrides in the next enrichment cycle.
          </p>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">Target Industries</Label>
            <Textarea
              value={industries}
              onChange={(e) => setIndustries(e.target.value)}
              placeholder="e.g. SaaS, Fintech, Healthcare IT"
              className="text-sm resize-none h-16"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">Target Job Titles</Label>
            <Textarea
              value={titles}
              onChange={(e) => setTitles(e.target.value)}
              placeholder="e.g. VP Sales, Head of Revenue, CRO"
              className="text-sm resize-none h-16"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">Target Geographies</Label>
            <Input
              value={geos}
              onChange={(e) => setGeos(e.target.value)}
              placeholder="e.g. United States, United Kingdom, Germany"
              className="text-sm"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">Target Tech Stack</Label>
            <Input
              value={tech}
              onChange={(e) => setTech(e.target.value)}
              placeholder="e.g. Salesforce, HubSpot, Outreach"
              className="text-sm"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">Company Size Min (employees)</Label>
              <Input
                value={sizeMin}
                onChange={(e) => setSizeMin(e.target.value)}
                placeholder="e.g. 50"
                type="number"
                className="text-sm"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">Company Size Max</Label>
              <Input
                value={sizeMax}
                onChange={(e) => setSizeMax(e.target.value)}
                placeholder="e.g. 500"
                type="number"
                className="text-sm"
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs font-medium text-destructive">
              Anti-patterns (disqualifiers)
            </Label>
            <Textarea
              value={antiPatterns}
              onChange={(e) => setAntiPatterns(e.target.value)}
              placeholder="e.g. Early-stage startups, Government, Non-profit"
              className="text-sm resize-none h-16 border-destructive/30"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={override.isPending} className="gap-1.5">
            {override.isPending ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <CheckCircle2 className="size-3.5" />
            )}
            Save Override
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ─── Confidence trend sparkline ─────────────────────────────────────────── */
function ConfidenceTrend({ history }: { history: Array<{ version: number; confidenceScore: number; generatedAt: string }> }) {
  if (!history || history.length < 2) return null;
  const sorted = [...history].sort((a, b) => a.version - b.version);
  const maxScore = Math.max(...sorted.map(h => h.confidenceScore), 1);
  const width = 220;
  const height = 48;
  const pad = 6;
  const innerW = width - pad * 2;
  const innerH = height - pad * 2;
  const pts = sorted.map((h, i) => {
    const x = pad + (i / (sorted.length - 1)) * innerW;
    const y = pad + (1 - h.confidenceScore / maxScore) * innerH;
    return `${x},${y}`;
  });
  const polyline = pts.join(" ");
  const latest = sorted[sorted.length - 1];
  const prev = sorted[sorted.length - 2];
  const delta = latest.confidenceScore - prev.confidenceScore;
  return (
    <div className="flex items-center gap-3 px-4 py-3 rounded-xl border bg-card">
      <div>
        <div className="text-xs text-muted-foreground mb-1">Confidence Trend</div>
        <svg width={width} height={height} className="overflow-visible">
          <polyline points={polyline} fill="none" stroke="#A78BFA" strokeWidth="2" strokeLinejoin="round" />
          {sorted.map((h, i) => {
            const x = pad + (i / (sorted.length - 1)) * innerW;
            const y = pad + (1 - h.confidenceScore / maxScore) * innerH;
            return <circle key={i} cx={x} cy={y} r="3" fill="#A78BFA" />;
          })}
        </svg>
      </div>
      <div className="text-right">
        <div className="text-lg font-bold" style={{ color: delta >= 0 ? "#34D399" : "#F87171" }}>
          {delta >= 0 ? "+" : ""}{delta}%
        </div>
        <div className="text-xs text-muted-foreground">vs prev version</div>
      </div>
    </div>
  );
}

/* ─── Version diff view ──────────────────────────────────────────────────── */
function VersionDiff({ a, b }: { a: any; b: any }) {
  const fields: Array<{ label: string; key: string }> = [
    { label: "Industries", key: "targetIndustries" },
    { label: "Titles", key: "targetTitles" },
    { label: "Geographies", key: "targetGeographies" },
    { label: "Tech Stack", key: "targetTechStack" },
    { label: "Anti-Patterns", key: "antiPatterns" },
  ];
  return (
    <div className="rounded-xl border bg-card overflow-hidden">
      <div className="grid grid-cols-2 divide-x">
        <div className="px-3 py-2 bg-muted/30 text-xs font-semibold text-muted-foreground">v{a.version} (older)</div>
        <div className="px-3 py-2 bg-primary/5 text-xs font-semibold text-primary">v{b.version} (newer)</div>
      </div>
      {fields.map(({ label, key }) => {
        const aItems = parseJsonArray(a[key]);
        const bItems = parseJsonArray(b[key]);
        const added = bItems.filter(x => !aItems.includes(x));
        const removed = aItems.filter(x => !bItems.includes(x));
        const unchanged = aItems.filter(x => bItems.includes(x));
        if (aItems.length === 0 && bItems.length === 0) return null;
        return (
          <div key={key} className="border-t">
            <div className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground bg-muted/20">{label}</div>
            <div className="grid grid-cols-2 divide-x">
              <div className="px-3 py-2 text-xs space-y-1">
                {aItems.map((item, i) => (
                  <div key={i} className={removed.includes(item) ? "line-through text-rose-400" : "text-muted-foreground"}>{item}</div>
                ))}
              </div>
              <div className="px-3 py-2 text-xs space-y-1">
                {unchanged.map((item, i) => <div key={i} className="text-muted-foreground">{item}</div>)}
                {added.map((item, i) => <div key={i} className="text-emerald-500 font-medium">+ {item}</div>)}
              </div>
            </div>
          </div>
        );
      })}
      {(a.confidenceScore != null || b.confidenceScore != null) && (
        <div className="border-t grid grid-cols-2 divide-x">
          <div className="px-3 py-2 text-xs text-muted-foreground">Confidence: {a.confidenceScore ?? "—"}%</div>
          <div className="px-3 py-2 text-xs font-medium" style={{ color: (b.confidenceScore ?? 0) >= (a.confidenceScore ?? 0) ? "#34D399" : "#F87171" }}>
            Confidence: {b.confidenceScore ?? "—"}% {(b.confidenceScore ?? 0) > (a.confidenceScore ?? 0) ? "▲" : (b.confidenceScore ?? 0) < (a.confidenceScore ?? 0) ? "▼" : ""}
          </div>
        </div>
      )}
    </div>
  );
}

/* ─── Version history row ────────────────────────────────────────────────── */
function VersionRow({ v, isActive, onRestore, isRestoring }: { v: any; isActive: boolean; onRestore?: () => void; isRestoring?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const rationale = v.rationale ?? v.icpRationale ?? v.aiRationale ?? "";
  const buyingTriggers = parseJsonArray(v.buyingTriggers);
  const industries = parseJsonArray(v.targetIndustries);

  return (
    <div
      className={`rounded-xl border overflow-hidden ${
        isActive ? "border-primary/30 bg-primary/5" : "border-border bg-card"
      }`}
    >
      <button
        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-muted/30 transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <div
          className={`size-2 rounded-full shrink-0 ${
            isActive ? "bg-emerald-400" : "bg-muted-foreground/30"
          }`}
        />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">Version {v.version}</span>
            {isActive && (
              <Badge
                variant="outline"
                className="text-[10px] px-1.5 py-0 h-4 border-emerald-500/30 text-emerald-600 bg-emerald-500/10"
              >
                Active
              </Badge>
            )}
            {v.confidenceScore != null && (
              <ConfidenceBadge score={v.confidenceScore} />
            )}
          </div>
          <div className="text-xs text-muted-foreground mt-0.5">
            {new Date(v.createdAt).toLocaleDateString([], {
              year: "numeric",
              month: "short",
              day: "numeric",
            })}
            {industries.length > 0 &&
              ` · ${industries.slice(0, 2).join(", ")}${industries.length > 2 ? ` +${industries.length - 2}` : ""}`}
          </div>
        </div>
        {expanded ? (
          <ChevronDown className="size-4 text-muted-foreground shrink-0" />
        ) : (
          <ChevronRight className="size-4 text-muted-foreground shrink-0" />
        )}
      </button>

      {expanded && (
        <div className="px-4 pb-4 pt-0 border-t space-y-3">
          {rationale && (
            <div className="pt-3">
              <div className="text-xs font-medium text-muted-foreground mb-1">AI Rationale</div>
              <p className="text-xs text-muted-foreground leading-relaxed">{rationale}</p>
            </div>
          )}
          {industries.length > 0 && (
            <div>
              <div className="text-xs font-medium text-muted-foreground mb-1.5">Industries</div>
              <TagCloud items={industries} color="#60A5FA" />
            </div>
          )}
          {buyingTriggers.length > 0 && (
            <div>
              <div className="text-xs font-medium text-muted-foreground mb-1.5">Buying Triggers</div>
              <BulletList items={buyingTriggers} color="#F59E0B" />
            </div>
          )}
          {!isActive && onRestore && (
            <div className="pt-2 border-t">
              <Button
                size="sm"
                variant="outline"
                className="gap-1.5 text-xs bg-violet-500/10 border-violet-500/30 text-violet-600 hover:bg-violet-500/20"
                onClick={(e) => { e.stopPropagation(); onRestore(); }}
                disabled={isRestoring}
              >
                {isRestoring ? <Loader2 className="size-3 animate-spin" /> : <RotateCcw className="size-3" />}
                Restore this version
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ─── Main page ──────────────────────────────────────────────────────────── */
export default function AREIcpAgent() {
  const utils = trpc.useUtils();
  const { data: icp, isLoading } = trpc.are.icp.getCurrent.useQuery();
  const { data: history, isLoading: loadingHistory } = trpc.are.icp.getHistory.useQuery();
  const [overrideOpen, setOverrideOpen] = useState(false);

  const regenerate = trpc.are.icp.regenerate.useMutation({
    onSuccess: () => {
      toast.success("ICP regeneration started — this may take a moment");
      setTimeout(() => utils.are.icp.getCurrent.invalidate(), 5000);
      setTimeout(() => utils.are.icp.getHistory.invalidate(), 5000);
    },
    onError: (e) => toast.error(e.message),
  });
  const [restoringId, setRestoringId] = useState<number | null>(null);
  const [diffPair, setDiffPair] = useState<[any, any] | null>(null);
  const restore = trpc.are.icp.restore.useMutation({
    onSuccess: (_, vars) => {
      toast.success("ICP version restored successfully");
      setRestoringId(null);
      utils.are.icp.getCurrent.invalidate();
      utils.are.icp.getHistory.invalidate();
    },
    onError: (e) => { toast.error(e.message); setRestoringId(null); },
  });

  /* parse ICP fields */
  const industries = parseJsonArray(icp?.targetIndustries);
  const titles = parseJsonArray(icp?.targetTitles);
  const geos = parseJsonArray(icp?.targetGeographies);
  const techStack = parseJsonArray(icp?.targetTechStack);
  const antiPatterns = parseJsonArray(icp?.antiPatterns);
  const buyingTriggers = parseJsonArrayOfObj<{ trigger: string; weight: number }>(
    icp?.buyingTriggers
  );
  const painPoints = parseJsonArrayOfObj<{
    pain: string;
    evidence: string;
    frequency: number;
  }>(icp?.painPoints);

  const maxWeight = buyingTriggers.reduce((m, t) => Math.max(m, t.weight ?? 0), 0) || 1;

  return (
    <Shell title="ICP Agent">
      {/* ── Header ── */}
      <PageHeader
        title="ICP Agent" pageKey="are-icp-agent"
        description="Define and continuously refine your Ideal Customer Profile to sharpen prospect qualification. The AI infers your ICP from won and lost deals and updates it automatically."
      
        icon={<Target className="size-5" />}
      >
        {icp?.confidenceScore != null && (
          <ConfidenceBadge score={icp.confidenceScore} />
        )}
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5 text-xs"
          onClick={() => setOverrideOpen(true)}
          disabled={!icp}
        >
          <Pencil className="size-3.5" /> Override
        </Button>
        <Button
          size="sm"
          className="gap-1.5 text-xs"
          onClick={() => regenerate.mutate()}
          disabled={regenerate.isPending}
        >
          {regenerate.isPending ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <RefreshCw className="size-3.5" />
          )}
          {regenerate.isPending ? "Regenerating…" : "Regenerate ICP"}
        </Button>
      </PageHeader>

      <div className="p-4 md:p-6 space-y-8 max-w-6xl mx-auto">
        {isLoading ? (
          <div className="flex items-center gap-2 text-muted-foreground py-24 justify-center">
            <Loader2 className="size-5 animate-spin" /> Loading ICP profile…
          </div>
        ) : !icp ? (
          <EmptyState
            icon={Brain}
            title="No ICP profile yet"
            description="The ICP Agent needs at least a few won and lost deals in your CRM to infer a profile. Click Regenerate to run the first inference."
            action={
              <Button
                onClick={() => regenerate.mutate()}
                disabled={regenerate.isPending}
                className="gap-1.5"
              >
                {regenerate.isPending ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Sparkles className="size-4" />
                )}
                Run ICP Inference
              </Button>
            }
          />
        ) : (
          <>
            {/* ── Confidence + meta stats ── */}
            <section>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <StatCard
                  label="Confidence Score"
                  value={`${icp.confidenceScore ?? 0}%`}
                  hint="AI inference quality"
                  tone={
                    (icp.confidenceScore ?? 0) >= 70
                      ? "success"
                      : (icp.confidenceScore ?? 0) >= 40
                      ? "warning"
                      : "danger"
                  }
                />
                <StatCard label="Version" value={icp.version ?? 1} hint="current profile version" />
                <StatCard label="Industries" value={industries.length} hint="target verticals" />
                <StatCard label="Job Titles" value={titles.length} hint="target personas" />
              </div>
            </section>

            {/* ── AI Rationale ── */}
            {icp.icpRationale && (
              <section>
                <div className="flex items-center gap-2 mb-3">
                  <Brain className="size-4 text-violet-500" />
                  <h2 className="text-sm font-semibold">AI Rationale</h2>
                </div>
                <Card className="bg-muted/30 border-dashed">
                  <CardContent className="pt-4 pb-4">
                    <p className="text-sm text-muted-foreground leading-relaxed">
                      {icp.icpRationale}
                    </p>
                  </CardContent>
                </Card>
              </section>
            )}

            {/* ── Core profile grid ── */}
            <section>
              <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-4">
                Target Profile
              </h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                <IcpSection icon={Building2} title="Industries" color="#60A5FA">
                  <TagCloud items={industries} color="#60A5FA" />
                </IcpSection>
                <IcpSection icon={Users} title="Job Titles" color="#A78BFA">
                  <TagCloud items={titles} color="#A78BFA" />
                </IcpSection>
                <IcpSection icon={MapPin} title="Geographies" color="#34D399">
                  <TagCloud items={geos} color="#34D399" />
                </IcpSection>
                <IcpSection icon={Wrench} title="Tech Stack" color="#F59E0B">
                  <TagCloud items={techStack} color="#F59E0B" />
                </IcpSection>
                <IcpSection icon={AlertTriangle} title="Anti-patterns (Disqualifiers)" color="#F87171">
                  <TagCloud items={antiPatterns} color="#F87171" />
                </IcpSection>
                <IcpSection icon={TrendingUp} title="Company Sizing" color="#FB923C">
                  <div className="space-y-3">
                    {icp.targetCompanySizeMin != null && icp.targetCompanySizeMax != null ? (
                      <RangeBar
                        min={icp.targetCompanySizeMin}
                        max={icp.targetCompanySizeMax}
                        absMax={icp.targetCompanySizeMax * 1.5}
                        label="Employees"
                        color="#FB923C"
                      />
                    ) : null}
                    {icp.targetRevenueMin != null && icp.targetRevenueMax != null ? (
                      <RangeBar
                        min={parseFloat(icp.targetRevenueMin)}
                        max={parseFloat(icp.targetRevenueMax)}
                        absMax={parseFloat(icp.targetRevenueMax) * 1.5}
                        label="Revenue ($)"
                        color="#FB923C"
                      />
                    ) : null}
                    {icp.targetCompanySizeMin == null && icp.targetRevenueMin == null && (
                      <div className="text-xs text-muted-foreground italic">Not yet inferred</div>
                    )}
                  </div>
                </IcpSection>
              </div>
            </section>

            {/* ── Buying triggers ── */}
            {buyingTriggers.length > 0 && (
              <section>
                <div className="flex items-center gap-2 mb-4">
                  <Zap className="size-4 text-amber-500" />
                  <h2 className="text-sm font-semibold">Buying Triggers</h2>
                  <span className="text-xs text-muted-foreground">
                    — events that indicate purchase readiness
                  </span>
                </div>
                <Card className="bg-card border">
                  <CardContent className="pt-4 pb-4 space-y-3">
                    {buyingTriggers.map((t, i) => (
                      <div key={i} className="space-y-1">
                        <div className="flex items-center justify-between text-sm">
                          <span className="font-medium">{t.trigger}</span>
                          <span className="text-xs text-muted-foreground tabular-nums">
                            {t.weight ?? 0}/10
                          </span>
                        </div>
                        <div className="h-2 rounded-full bg-muted overflow-hidden">
                          <div
                            className="h-full rounded-full bg-amber-400 transition-all"
                            style={{ width: `${((t.weight ?? 0) / maxWeight) * 100}%` }}
                          />
                        </div>
                      </div>
                    ))}
                  </CardContent>
                </Card>
              </section>
            )}

            {/* ── Pain points ── */}
            {painPoints.length > 0 && (
              <section>
                <div className="flex items-center gap-2 mb-4">
                  <Target className="size-4 text-red-500" />
                  <h2 className="text-sm font-semibold">Pain Points</h2>
                  <span className="text-xs text-muted-foreground">
                    — recurring problems in won deals
                  </span>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {painPoints.map((p, i) => (
                    <Card key={i} className="bg-card border">
                      <CardContent className="pt-4 pb-4">
                        <div className="flex items-start justify-between gap-2 mb-1.5">
                          <span className="text-sm font-medium">{p.pain}</span>
                          <div className="flex items-center gap-0.5 shrink-0">
                            {Array.from({ length: 5 }).map((_, j) => (
                              <div
                                key={j}
                                className={`size-1.5 rounded-full ${
                                  j < (p.frequency ?? 0) ? "bg-red-500" : "bg-muted"
                                }`}
                              />
                            ))}
                          </div>
                        </div>
                        {p.evidence && (
                          <p className="text-xs text-muted-foreground leading-relaxed">
                            {p.evidence}
                          </p>
                        )}
                      </CardContent>
                    </Card>
                  ))}
                </div>
              </section>
            )}
          </>
        )}

        {/* ── Version history ── */}
        <section>
          <div className="flex items-center gap-2 mb-4">
            <History className="size-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold">Version History</h2>
            {loadingHistory && (
              <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
            )}
          </div>

          {!history || history.length === 0 ? (
            <div className="text-sm text-muted-foreground italic">No previous versions yet.</div>
          ) : (
            <div className="space-y-4">
              {history.length >= 2 && (
                <ConfidenceTrend
                  history={history.map(h => ({
                    version: h.version,
                    confidenceScore: h.confidenceScore ?? 0,
                    generatedAt: h.createdAt ? String(h.createdAt) : "",
                  }))}
                />
              )}
              {history.length >= 2 && (
                <div className="flex items-center gap-2">
                  <button
                    className="text-xs text-violet-500 hover:text-violet-400 underline underline-offset-2"
                    onClick={() => {
                      const sorted = [...history].sort((a, b) => b.version - a.version);
                      setDiffPair(diffPair ? null : [sorted[1], sorted[0]]);
                    }}
                  >
                    {diffPair ? "Hide diff view" : "Compare last 2 versions"}
                  </button>
                </div>
              )}
              {diffPair && <VersionDiff a={diffPair[0]} b={diffPair[1]} />}
              <div className="space-y-2">
                {[...history].sort((a, b) => b.version - a.version).map((v) => (
                  <VersionRow
                    key={v.id}
                    v={v}
                    isActive={!!v.isActive}
                    onRestore={() => { setRestoringId(v.id); restore.mutate({ id: v.id }); }}
                    isRestoring={restoringId === v.id}
                  />
                ))}
              </div>
            </div>
          )}
        </section>

        {/* ── How it works ── */}
        <section>
          <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-4">
            How the ICP Agent Works
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            {[
              {
                step: "01",
                title: "Reads your CRM",
                color: "#60A5FA",
                desc: "The agent reads every opportunity (won and lost), account, and contact in your workspace to build a training dataset.",
              },
              {
                step: "02",
                title: "LLM Pattern Extraction",
                color: "#A78BFA",
                desc: "An LLM analyses the dataset to extract patterns: which industries close fastest, which titles champion deals, which pain points recur in won deals.",
              },
              {
                step: "03",
                title: "Structured ICP Output",
                color: "#34D399",
                desc: "The result is a versioned, structured ICP with confidence scores, buying triggers, pain points, and anti-patterns — ready to score every new prospect.",
              },
            ].map(({ step, title, desc, color }) => (
              <div key={step} className="rounded-xl border bg-card p-4 space-y-2">
                <div className="flex items-center gap-2">
                  <div
                    className="text-[10px] font-bold font-mono px-1.5 py-0.5 rounded"
                    style={{ backgroundColor: color + "22", color }}
                  >
                    {step}
                  </div>
                  <span className="text-sm font-semibold">{title}</span>
                </div>
                <p className="text-xs text-muted-foreground leading-relaxed">{desc}</p>
              </div>
            ))}
          </div>
        </section>
      </div>

      {/* ── Override dialog ── */}
      {icp && (
        <OverrideDialog icp={icp} open={overrideOpen} onClose={() => setOverrideOpen(false)} />
      )}
    </Shell>
  );
}
