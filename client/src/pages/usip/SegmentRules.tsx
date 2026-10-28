/**
 * Segment → Sequence Auto-Enroll Rules page
 */
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PageHeader, Shell } from "@/components/usip/Shell";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { trpc } from "@/lib/trpc";
import { CheckCircle2, Loader2, Play, Plus, Trash2, Users, Zap, SlidersHorizontal } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { isAdminRole } from "@shared/roleRank";

type RunSummary = {
  matched?: number; enrolled?: number; refused?: string;
  skipped?: { alreadyEnrolled?: number; invalidEmail?: number; inCampaign?: number; suppressed?: number };
};

/** "Matched 12 · enrolled 8 · skipped 2 already enrolled, 1 suppressed", or why it refused. */
function describeRun(r: RunSummary): string {
  if (r.refused) return r.refused;
  const skipped = r.skipped ?? {};
  const parts = [
    skipped.alreadyEnrolled ? `${skipped.alreadyEnrolled} already enrolled` : null,
    skipped.invalidEmail ? `${skipped.invalidEmail} invalid email` : null,
    skipped.inCampaign ? `${skipped.inCampaign} in a campaign` : null,
    skipped.suppressed ? `${skipped.suppressed} suppressed` : null,
  ].filter(Boolean);
  return `Matched ${r.matched ?? 0} · enrolled ${r.enrolled ?? 0}${parts.length ? ` · skipped ${parts.join(", ")}` : ""}`;
}

export default function SegmentRules() {
  const { current } = useWorkspace();
  const isAdmin = isAdminRole(current?.role);

  const utils = trpc.useUtils();
  const rules = trpc.segmentRules.list.useQuery();
  const segments = trpc.segments.list.useQuery();
  const sequences = trpc.sequences.list.useQuery();

  const save = trpc.segmentRules.save.useMutation({
    onSuccess: () => {
      utils.segmentRules.list.invalidate();
      toast.success("Auto-enroll rule saved");
      setNewSegmentId("");
      setNewSequenceId("");
    },
    onError: (e) => toast.error(e.message),
  });

  const del = trpc.segmentRules.delete.useMutation({
    onSuccess: () => { utils.segmentRules.list.invalidate(); toast.success("Rule removed"); },
    onError: (e) => toast.error(e.message),
  });

  const runNow = trpc.segmentRules.runEnrollment.useMutation({
    onSuccess: (data) => toast.success(`Enrollment complete — ${data.enrolled} enrolled, ${data.skipped} skipped`),
    onError: (e) => toast.error(e.message),
  });

  const [newSegmentId, setNewSegmentId] = useState("");
  const [newSequenceId, setNewSequenceId] = useState("");

  const segmentMap = new Map((segments.data ?? []).map((s) => [s.id, s]));
  const sequenceMap = new Map((sequences.data ?? []).map((s) => [s.id, s]));

  return (
    <Shell>
      <PageHeader title="Segment Auto-Enroll" description="Define auto-enrolment rules that keep your audience segments fresh as CRM data changes. Rules evaluate on every record update so segments always reflect your latest criteria." pageKey="segment-rules"
        icon={<SlidersHorizontal className="size-5" />}
      >
        {isAdmin && (
          <Button size="sm" variant="outline" onClick={() => runNow.mutate()} disabled={runNow.isPending}>
            {runNow.isPending ? <Loader2 className="size-4 animate-spin mr-1" /> : <Play className="size-4 mr-1" />}
            Run now
          </Button>
        )}
      </PageHeader>

      <div className="p-4 md:p-5 space-y-6">
        {isAdmin && (
          <div className="border border-border rounded-lg p-4 bg-card">
            <h3 className="text-sm font-medium mb-3 flex items-center gap-2">
              <Plus className="size-4" />
              Add auto-enroll rule
            </h3>
            <div className="flex items-end gap-3 flex-wrap">
              <div className="flex-1 min-w-[200px]">
                <label className="text-xs text-muted-foreground mb-1 block">Audience Segment</label>
                <Select value={newSegmentId} onValueChange={setNewSegmentId}>
                  <SelectTrigger><SelectValue placeholder="Select segment…" /></SelectTrigger>
                  <SelectContent>
                    {(segments.data ?? []).map((s) => (
                      <SelectItem key={s.id} value={String(s.id)}>{s.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex-1 min-w-[200px]">
                <label className="text-xs text-muted-foreground mb-1 block">Enroll into Sequence</label>
                <Select value={newSequenceId} onValueChange={setNewSequenceId}>
                  <SelectTrigger><SelectValue placeholder="Select sequence…" /></SelectTrigger>
                  <SelectContent>
                    {(sequences.data ?? []).filter((s) => s.status === "active").map((s) => (
                      <SelectItem key={s.id} value={String(s.id)}>{s.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Button
                size="sm"
                onClick={() => save.mutate({ segmentId: parseInt(newSegmentId), sequenceId: parseInt(newSequenceId), enabled: true })}
                disabled={!newSegmentId || !newSequenceId || save.isPending}
              >
                {save.isPending ? <Loader2 className="size-4 animate-spin mr-1" /> : <Zap className="size-4 mr-1" />}
                Add rule
              </Button>
            </div>
          </div>
        )}

        {rules.isLoading ? (
          <div className="flex items-center gap-2 text-muted-foreground text-sm py-8 justify-center">
            <Loader2 className="size-4 animate-spin" /> Loading rules…
          </div>
        ) : (rules.data ?? []).length === 0 ? (
          <div className="text-center py-16 text-muted-foreground">
            <Users className="size-10 mx-auto mb-3 opacity-30" />
            <p className="font-medium">No auto-enroll rules yet</p>
            <p className="text-sm mt-1">Add a rule above to automatically enroll contacts from a segment into a sequence.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {(rules.data ?? []).map((rule) => {
              const seg = segmentMap.get(rule.segmentId);
              const seq = sequenceMap.get(rule.sequenceId);
              return (
                <div key={rule.id} className={`flex flex-wrap items-center gap-x-4 gap-y-2 border border-border rounded-lg p-4 bg-card transition-opacity ${rule.enabled ? "" : "opacity-50"}`}>
                  {/* Segment → sequence keep a line of their own on a phone; the counts and buttons wrap under them. */}
                  <div className="flex items-center gap-2 flex-1 min-w-[8rem]">
                    <Users className="size-4 text-muted-foreground shrink-0" />
                    <div className="min-w-0">
                      <div className="text-sm font-medium truncate">{seg?.name ?? `Segment #${rule.segmentId}`}</div>
                      <div className="text-xs text-muted-foreground">audience segment</div>
                    </div>
                  </div>
                  <div className="text-muted-foreground text-sm shrink-0">→</div>
                  <div className="flex items-center gap-2 flex-1 min-w-[8rem]">
                    <Zap className="size-4 text-muted-foreground shrink-0" />
                    <div className="min-w-0">
                      <div className="text-sm font-medium truncate">{seq?.name ?? `Sequence #${rule.sequenceId}`}</div>
                      <div className="text-xs text-muted-foreground">{seq?.status ?? "sequence"}</div>
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="text-sm font-medium">{rule.enrolledCount ?? 0}</div>
                    <div className="text-xs text-muted-foreground">enrolled</div>
                  </div>
                  <div className="text-right shrink-0 hidden md:block">
                    <div className="text-xs text-muted-foreground">
                      {rule.lastRunAt ? new Date(rule.lastRunAt).toLocaleString() : "Never run"}
                    </div>
                    {/* What the last run did and why it left people out (audit 2026-10-20, P2). */}
                    {rule.lastRunSummary ? <div className="text-[11px] text-muted-foreground max-w-[260px]">{describeRun(rule.lastRunSummary as RunSummary)}</div> : null}
                  </div>
                  <Badge variant={rule.enabled ? "default" : "secondary"} className="shrink-0">
                    {rule.enabled ? <><CheckCircle2 className="size-3 mr-1" />Active</> : "Paused"}
                  </Badge>
                  {isAdmin && (
                    <div className="flex items-center gap-1 shrink-0">
                      <Button size="sm" variant="ghost" onClick={() => save.mutate({ id: rule.id, segmentId: rule.segmentId, sequenceId: rule.sequenceId, enabled: !rule.enabled })} className="text-xs">
                        {rule.enabled ? "Pause" : "Enable"}
                      </Button>
                      <Button aria-label="Delete rule" size="sm" variant="ghost" onClick={() => del.mutate({ id: rule.id })} className="text-destructive hover:text-destructive">
                        <Trash2 className="size-3.5" />
                      </Button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        <div className="border border-border rounded-lg p-4 bg-muted/30 text-sm text-muted-foreground space-y-1">
          <p className="font-medium text-foreground">How it works</p>
          <p>Every hour, Velocity evaluates all enabled rules. Contacts matching the segment's filter criteria that are not already enrolled in the linked sequence are automatically enrolled.</p>
          <p>Use <strong>Run now</strong> to trigger an immediate evaluation without waiting for the next hourly cycle.</p>
        </div>
      </div>
    </Shell>
  );
}
