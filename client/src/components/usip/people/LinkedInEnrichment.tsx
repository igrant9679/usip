/**
 * LinkedIn enrichment UI — the compact update indicators + profile cards.
 *
 * Surfaces the change data from the Unipile-backed enrichment backend
 * (trpc.linkedinEnrichment.*) across the People experience:
 *
 *  - LinkedInUpdateIndicator — the small, subtle "Title changed" /
 *    "3 LinkedIn updates" / "Checked today" pill shown next to a prospect's
 *    name (People table + list rows) and in the profile views. Click → a
 *    popover with field · old → new · detected date · Source: Unipile.
 *  - LinkedInEnrichmentSummaryCard — the open/quick-profile drawer card.
 *  - LinkedInEnrichmentFullPanel — the full-profile section: enriched fields,
 *    source metadata, last retrieved/checked, change history, manual refresh,
 *    acknowledge, link to the LinkedIn URL, and stale/blocked warnings.
 *
 * The table never shows full enrichment detail — only the compact indicator.
 */
import { useMemo } from "react";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { toast } from "sonner";
import {
  Link2,
  Check,
  RefreshCw,
  ExternalLink,
  Clock,
  AlertTriangle,
  Loader2,
  ArrowRight,
} from "lucide-react";

/* ───────────────────────────── shared types ───────────────────────────── */

export interface LinkedInChange {
  id: number;
  field_name: string;
  change_type: string;
  label: string;
  old_value: string | null;
  new_value: string | null;
  priority: string;
  detected_at: string | Date;
}
export interface LinkedInChangeSummary {
  prospect_id: number;
  has_updates: boolean;
  unacknowledged_count: number;
  highest_priority: "high" | "medium" | "low" | "normal";
  display_text: string | null;
  last_checked_at: string | Date | null;
  changes: LinkedInChange[];
}

const PRIORITY_STYLES: Record<string, string> = {
  high: "bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-900/30 dark:text-amber-300 dark:border-amber-900",
  medium: "bg-sky-100 text-sky-800 border-sky-200 dark:bg-sky-900/30 dark:text-sky-300 dark:border-sky-900",
  low: "bg-secondary text-muted-foreground border-border",
  normal: "bg-secondary text-muted-foreground border-border",
};

function fmtDate(d: string | Date | null | undefined): string {
  if (!d) return "—";
  const dt = typeof d === "string" ? new Date(d) : d;
  if (Number.isNaN(dt.getTime())) return "—";
  return dt.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function isToday(d: string | Date | null | undefined): boolean {
  if (!d) return false;
  const dt = typeof d === "string" ? new Date(d) : d;
  const now = new Date();
  return dt.toDateString() === now.toDateString();
}

/* ─────────────────────── compact update indicator ─────────────────────── */

/**
 * The compact indicator. Renders nothing when there are no unacknowledged
 * updates — unless `showChecked` (profile contexts), where a quiet
 * "Checked today/date" chip is shown instead.
 */
export function LinkedInUpdateIndicator({
  summary,
  showChecked = false,
  className,
}: {
  summary: LinkedInChangeSummary | null | undefined;
  showChecked?: boolean;
  className?: string;
}) {
  if (!summary) return null;

  if (!summary.has_updates) {
    if (!showChecked || !summary.last_checked_at) return null;
    return (
      <span
        className={cn("inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground", className)}
        title={`LinkedIn checked ${fmtDate(summary.last_checked_at)} · via Unipile`}
      >
        <Clock className="size-3" /> {isToday(summary.last_checked_at) ? "Checked today" : `Checked ${fmtDate(summary.last_checked_at)}`}
      </span>
    );
  }

  const style = PRIORITY_STYLES[summary.highest_priority] ?? PRIORITY_STYLES.low;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          onClick={(e) => e.stopPropagation()}
          className={cn(
            "inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] font-medium leading-none transition-colors hover:brightness-95",
            style,
            className,
          )}
          title="LinkedIn updates — click for details"
        >
          <Link2 className="size-3 shrink-0" />
          <span className="truncate max-w-[120px]">{summary.display_text}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-0" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b px-3 py-2">
          <div className="text-[13px] font-semibold inline-flex items-center gap-1.5">
            <Link2 className="size-3.5 text-sky-600" /> LinkedIn changes
          </div>
          <span className="text-[11px] text-muted-foreground">Source: Unipile</span>
        </div>
        <div className="max-h-72 overflow-y-auto divide-y">
          {summary.changes.map((c) => (
            <div key={c.id} className="px-3 py-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[12px] font-medium">{c.label}</span>
                <span className="text-[10px] text-muted-foreground shrink-0">{fmtDate(c.detected_at)}</span>
              </div>
              {(c.old_value || c.new_value) && c.change_type !== "profile_unavailable" && (
                <div className="mt-1 flex items-center gap-1.5 text-[11px] text-muted-foreground min-w-0">
                  {c.old_value && <span className="line-through truncate max-w-[110px]" title={c.old_value}>{c.old_value}</span>}
                  <ArrowRight className="size-3 shrink-0" />
                  <span className="text-foreground truncate max-w-[120px]" title={c.new_value ?? ""}>{c.new_value ?? "—"}</span>
                </div>
              )}
            </div>
          ))}
        </div>
        <div className="border-t px-3 py-2">
          <AcknowledgeButton prospectId={summary.prospect_id} />
        </div>
      </PopoverContent>
    </Popover>
  );
}

function AcknowledgeButton({ prospectId, onDone }: { prospectId: number; onDone?: () => void }) {
  const utils = trpc.useUtils();
  const ack = trpc.linkedinEnrichment.acknowledgeChanges.useMutation({
    onSuccess: () => {
      toast.success("LinkedIn updates acknowledged");
      utils.linkedinEnrichment.getChangeSummaries.invalidate();
      utils.linkedinEnrichment.getProspectChanges.invalidate({ prospectId });
      onDone?.();
    },
    onError: (e) => toast.error(e.message),
  });
  return (
    <Button
      variant="ghost"
      size="sm"
      className="h-7 w-full justify-center gap-1.5 text-[12px]"
      disabled={ack.isPending}
      onClick={() => ack.mutate({ prospectId })}
    >
      {ack.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />} Mark as seen
    </Button>
  );
}

/* ─── indicator that fetches its own summary (single-prospect contexts) ─── */

export function LinkedInUpdateIndicatorForProspect({ prospectId, showChecked }: { prospectId: number; showChecked?: boolean }) {
  const { data } = trpc.linkedinEnrichment.getProspectChanges.useQuery({ prospectId });
  return <LinkedInUpdateIndicator summary={(data as LinkedInChangeSummary) ?? null} showChecked={showChecked} />;
}

/* ──────────────────────── open-profile summary card ────────────────────── */

export function LinkedInEnrichmentSummaryCard({ prospectId }: { prospectId: number }) {
  const enrichQ = trpc.linkedinEnrichment.getProspectEnrichment.useQuery({ prospectId });
  const changesQ = trpc.linkedinEnrichment.getProspectChanges.useQuery({ prospectId });
  const e = (enrichQ.data as any)?.enrichment;
  if (enrichQ.isLoading) return <div className="h-20 rounded-lg bg-muted/40 animate-pulse" />;
  if (!e) return null;

  return (
    <div className="rounded-lg border bg-card/50 p-3 space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-[12px] font-semibold inline-flex items-center gap-1.5">
          <Link2 className="size-3.5 text-sky-600" /> LinkedIn
        </div>
        <StatusBadge status={e.linkedinDataStatus} matchStatus={e.linkedinMatchStatus} />
      </div>
      <dl className="grid grid-cols-3 gap-x-2 gap-y-1 text-[12px]">
        <CardRow label="Title" value={e.currentTitle ?? e.linkedinHeadline} />
        <CardRow label="Company" value={e.currentCompanyName} />
        <CardRow label="Location" value={e.linkedinLocation} />
      </dl>
      <div className="flex items-center justify-between pt-1">
        <LinkedInUpdateIndicator summary={(changesQ.data as LinkedInChangeSummary) ?? null} showChecked />
        {e.linkedinProfileUrl && (
          <a href={e.linkedinProfileUrl} target="_blank" rel="noopener noreferrer" className="text-[11px] text-sky-600 hover:underline inline-flex items-center gap-1">
            <ExternalLink className="size-3" /> Profile
          </a>
        )}
      </div>
    </div>
  );
}

function CardRow({ label, value }: { label: string; value?: string | null }) {
  return (
    <div className="col-span-3 grid grid-cols-3 gap-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="col-span-2 truncate" title={value ?? undefined}>{value || "—"}</dd>
    </div>
  );
}

function StatusBadge({ status, matchStatus }: { status?: string; matchStatus?: string }) {
  const blocked = status === "blocked_by_policy" || status === "source_unavailable";
  return (
    <Badge variant={blocked ? "destructive" : "secondary"} className="text-[10px] capitalize">
      {blocked ? (status ?? "").replace(/_/g, " ") : (matchStatus ?? status ?? "enriched").replace(/_/g, " ")}
    </Badge>
  );
}

/* ─────────────────────────── full-profile panel ───────────────────────── */

export function LinkedInEnrichmentFullPanel({ prospectId, canRefresh = true }: { prospectId: number; canRefresh?: boolean }) {
  const utils = trpc.useUtils();
  const enrichQ = trpc.linkedinEnrichment.getProspectEnrichment.useQuery({ prospectId });
  const refresh = trpc.linkedinEnrichment.manualRefresh.useMutation({
    onSuccess: (r: any) => {
      toast.success(r.changes?.length ? `Refreshed — ${r.changes.length} change(s) detected` : "Refreshed — no changes");
      utils.linkedinEnrichment.getProspectEnrichment.invalidate({ prospectId });
      utils.linkedinEnrichment.getProspectChanges.invalidate({ prospectId });
      utils.linkedinEnrichment.getChangeSummaries.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const data = enrichQ.data as any;
  const e = data?.enrichment;
  const history: LinkedInChange[] = (data?.history ?? []).map((h: any) => ({
    id: h.id, field_name: h.fieldName, change_type: h.changeType, label: h.changeType,
    old_value: h.oldValue, new_value: h.newValue, priority: h.displayPriority, detected_at: h.detectedAt,
  }));

  if (enrichQ.isLoading) return <div className="h-32 rounded-lg bg-muted/40 animate-pulse" />;
  if (!e) {
    return (
      <div className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">
        <Link2 className="size-5 mx-auto mb-1.5 text-muted-foreground/60" />
        No LinkedIn enrichment yet. Import this prospect's LinkedIn URL to enrich via Unipile.
      </div>
    );
  }

  const stale = e.linkedinDataStatus === "source_unavailable" || e.linkedinDataStatus === "blocked_by_policy";
  const exp: any[] = Array.isArray(e.experienceHistoryJson) ? e.experienceHistoryJson : [];
  const edu: any[] = Array.isArray(e.educationHistoryJson) ? e.educationHistoryJson : [];
  const skills: string[] = Array.isArray(e.skillsJson) ? e.skillsJson : [];

  return (
    <div className="rounded-lg border bg-card">
      <div className="flex items-center justify-between border-b px-4 py-2.5">
        <div className="text-sm font-semibold inline-flex items-center gap-2">
          <Link2 className="size-4 text-sky-600" /> LinkedIn enrichment
          <StatusBadge status={e.linkedinDataStatus} matchStatus={e.linkedinMatchStatus} />
        </div>
        {canRefresh && (
          <Button variant="outline" size="sm" className="h-7 gap-1.5" disabled={refresh.isPending} onClick={() => refresh.mutate({ prospectId })}>
            {refresh.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />} Refresh
          </Button>
        )}
      </div>

      {stale && (
        <div className="mx-4 mt-3 flex items-start gap-2 rounded-md bg-amber-50 dark:bg-amber-950/30 px-3 py-2 text-[12px] text-amber-800 dark:text-amber-300">
          <AlertTriangle className="size-3.5 mt-0.5 shrink-0" />
          {e.linkedinDataStatus === "blocked_by_policy"
            ? "This profile is blocked by policy — enrichment is not displayed."
            : "The LinkedIn profile couldn't be retrieved on the last check. Showing the last known data."}
        </div>
      )}

      <div className="p-4 grid grid-cols-2 gap-x-6 gap-y-2.5 text-[13px]">
        <Field label="Headline" value={e.linkedinHeadline} span />
        <Field label="Current title" value={e.currentTitle} />
        <Field label="Current company" value={e.currentCompanyName} />
        <Field label="Location" value={e.linkedinLocation} />
        <Field label="Industry" value={e.industry} />
        {skills.length > 0 && <Field label="Skills" value={skills.slice(0, 12).join(", ")} span />}
        {e.summaryAbout && <Field label="About" value={e.summaryAbout} span />}
      </div>

      {(exp.length > 0 || edu.length > 0) && (
        <div className="px-4 pb-3 grid grid-cols-2 gap-6">
          {exp.length > 0 && (
            <div>
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1">Experience</div>
              <ul className="space-y-1 text-[12px]">
                {exp.slice(0, 5).map((x, i) => (
                  <li key={i} className="truncate">{[x.title, x.company].filter(Boolean).join(" · ") || "—"}</li>
                ))}
              </ul>
            </div>
          )}
          {edu.length > 0 && (
            <div>
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1">Education</div>
              <ul className="space-y-1 text-[12px]">
                {edu.slice(0, 5).map((x, i) => (
                  <li key={i} className="truncate">{[x.school, x.degree].filter(Boolean).join(" · ") || "—"}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {/* source metadata */}
      <div className="border-t px-4 py-2.5 grid grid-cols-2 gap-x-6 gap-y-1 text-[11px] text-muted-foreground">
        <span>Source: <span className="text-foreground">{(e.linkedinSourceType ?? "").replace(/_/g, " ")} ({e.linkedinSourceVendor})</span></span>
        <span>Match: <span className="text-foreground capitalize">{(e.linkedinMatchStatus ?? "").replace(/_/g, " ")}</span></span>
        <span>Last retrieved: <span className="text-foreground">{fmtDate(e.linkedinLastRetrievedAt)}</span></span>
        <span>Last checked: <span className="text-foreground">{fmtDate(e.linkedinLastCheckedAt)}</span></span>
        {e.linkedinProfileUrl && (
          <a href={e.linkedinProfileUrl} target="_blank" rel="noopener noreferrer" className="col-span-2 text-sky-600 hover:underline inline-flex items-center gap-1">
            <ExternalLink className="size-3" /> {e.linkedinProfileUrl}
          </a>
        )}
      </div>

      {/* change history */}
      {history.length > 0 && (
        <div className="border-t">
          <div className="px-4 pt-2.5 pb-1 text-[11px] uppercase tracking-wide text-muted-foreground">Change history</div>
          <div className="max-h-56 overflow-y-auto divide-y">
            {history.map((h) => (
              <div key={h.id} className="px-4 py-1.5 text-[12px] flex items-center justify-between gap-2">
                <span className="truncate">
                  <span className="font-medium">{h.field_name.replace(/_/g, " ")}</span>
                  {(h.old_value || h.new_value) && (
                    <span className="text-muted-foreground"> · {h.old_value ?? "—"} → {h.new_value ?? "—"}</span>
                  )}
                </span>
                <span className="text-[10px] text-muted-foreground shrink-0">{fmtDate(h.detected_at)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Field({ label, value, span }: { label: string; value?: string | null; span?: boolean }) {
  return (
    <div className={span ? "col-span-2" : ""}>
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="truncate" title={value ?? undefined}>{value || "—"}</div>
    </div>
  );
}
