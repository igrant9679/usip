/**
 * A sequence's own send window in the v2 editor (audit 2026-10-20, U15): its
 * time zone (every IANA zone, the workspace's by default), the hours email
 * steps are drafted in, and whether weekends are skipped. The editor said to
 * go to the canvas for these. Saved through updateMeta, which merges into the
 * stored settings; no zone of its own clears back to the workspace's.
 */
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { TimezonePicker } from "@/components/usip/TimezonePicker";
import { useWorkspaceTimezone } from "@/hooks/useWorkspaceTimezone";

type Settings = { timezone?: string | null; sendWindowStart?: string | null; sendWindowEnd?: string | null; skipWeekends?: boolean | null };

export function SequenceScheduleSettings({ sequenceId, settings, accent, disabled }: { sequenceId: number; settings: unknown; accent: string; disabled?: boolean }) {
  const s = (settings ?? {}) as Settings;
  const [zone, setZone] = useState<string | null>(s.timezone ?? null);
  const [start, setStart] = useState(s.sendWindowStart || "08:00");
  const [end, setEnd] = useState(s.sendWindowEnd || "18:00");
  const [skipWeekends, setSkipWeekends] = useState(s.skipWeekends !== false);
  useEffect(() => {
    setZone(s.timezone ?? null);
    setStart(s.sendWindowStart || "08:00");
    setEnd(s.sendWindowEnd || "18:00");
    setSkipWeekends(s.skipWeekends !== false);
  }, [s.timezone, s.sendWindowStart, s.sendWindowEnd, s.skipWeekends]);
  const { timezone: wsZone } = useWorkspaceTimezone();
  const utils = trpc.useUtils();
  const save = trpc.sequences.updateMeta.useMutation({
    onSuccess: () => { utils.sequences.get.invalidate({ id: sequenceId }); toast.success("Send window saved"); },
    onError: (e) => toast.error(e.message),
  });
  const valid = /^\d{2}:\d{2}$/.test(start) && /^\d{2}:\d{2}$/.test(end) && start < end;
  const dirty = zone !== (s.timezone ?? null) || start !== (s.sendWindowStart || "08:00") || end !== (s.sendWindowEnd || "18:00") || skipWeekends !== (s.skipWeekends !== false);
  return (
    <div className="space-y-3">
      <div>
        <div className="text-[12px] font-medium mb-1">Time zone</div>
        <TimezonePicker label="Sequence time zone" value={zone} onChange={setZone} disabled={disabled} workspaceZone={wsZone} />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <label className="text-[12px] font-medium space-y-1 block">
          <span>Draft emails from</span>
          <input aria-label="Draft emails from" type="time" value={start} disabled={disabled} onChange={(e) => setStart(e.target.value)} className="h-9 w-full rounded-md border bg-background px-2 text-sm" />
        </label>
        <label className="text-[12px] font-medium space-y-1 block">
          <span>Until</span>
          <input aria-label="Draft emails until" type="time" value={end} disabled={disabled} onChange={(e) => setEnd(e.target.value)} className="h-9 w-full rounded-md border bg-background px-2 text-sm" />
        </label>
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[12px]">Skip weekends</span>
        <Switch aria-label="Skip weekends" checked={skipWeekends} disabled={disabled} onCheckedChange={setSkipWeekends} />
      </div>
      {!valid && <p className="text-[11px] text-rose-600">The window has to start before it ends.</p>}
      <div className="flex justify-end">
        <Button
          size="sm"
          style={{ backgroundColor: accent }}
          disabled={disabled || !dirty || !valid || save.isPending}
          onClick={() => save.mutate({ id: sequenceId, settings: { timezone: zone, sendWindowStart: start, sendWindowEnd: end, skipWeekends } })}
        >
          {save.isPending ? "Saving…" : "Save send window"}
        </Button>
      </div>
    </div>
  );
}
