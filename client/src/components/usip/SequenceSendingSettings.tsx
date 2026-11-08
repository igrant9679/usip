/**
 * SequenceSendingSettings — how this sequence's emails go out, set on the
 * sequence itself (audit 2026-10-20, F22 and F18).
 *
 *  · Review or auto-send (F22): follow the workspace switch (the default, so
 *    nothing changes until someone picks), always wait for review, or
 *    auto-send drafts to people scoring at least a threshold of its own. The
 *    pause, the send window and the daily caps hold either way.
 *  · Send in each person's time zone (F18): off by default. When on, each
 *    step comes due inside the send window in the person's zone. Timing only.
 */
import { useEffect, useId, useState } from "react";
import { Send } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { describeSequenceAutoSend, sequenceAutoSend, type SequenceAutoSendMode } from "@shared/sequenceAutoSend";
import { invalidateSequenceReads } from "@/lib/entityCache";

export function SequenceSendingSettings({ sequenceId, settings, accent }: { sequenceId: number; settings: unknown; accent?: string }) {
  const utils = trpc.useUtils();
  const wsAuto = trpc.emailAutoSend.getAutoSendSettings.useQuery(undefined as any, { retry: false });
  const saved = sequenceAutoSend(settings);
  const savedRecipientTime = !!(settings && typeof settings === "object" && (settings as { recipientTime?: unknown }).recipientTime === true);
  const [mode, setMode] = useState<SequenceAutoSendMode>(saved.mode);
  const [scoreMin, setScoreMin] = useState<string>(saved.scoreMin == null ? "" : String(saved.scoreMin));
  const [allowUnscored, setAllowUnscored] = useState<boolean>(saved.allowUnscored ?? false);
  const [recipientTime, setRecipientTime] = useState<boolean>(savedRecipientTime);
  useEffect(() => {
    setMode(saved.mode);
    setScoreMin(saved.scoreMin == null ? "" : String(saved.scoreMin));
    setAllowUnscored(saved.allowUnscored ?? false);
    setRecipientTime(savedRecipientTime);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(settings ?? null)]);

  const save = trpc.sequences.updateMeta.useMutation({
    onSuccess: () => { invalidateSequenceReads(utils); toast.success("Sending settings saved"); },
    onError: (e) => toast.error(e.message),
  });
  const modeId = useId();
  const scoreId = useId();
  const ws = wsAuto.data as { aiAutoSendEnabled?: boolean; aiAutoSendScoreMin?: number } | null | undefined;
  const parsedScore = scoreMin.trim() === "" ? null : Math.max(0, Math.min(100, Math.round(Number(scoreMin))));
  const scoreBad = scoreMin.trim() !== "" && !Number.isFinite(Number(scoreMin));
  const preview = describeSequenceAutoSend({ mode, scoreMin: parsedScore, allowUnscored }, ws);

  return (
    <div className="rounded-xl border bg-card shadow-sm p-4 space-y-4">
      <h2 className="text-sm font-semibold flex items-center gap-2"><Send className="size-4" style={{ color: accent }} /> Sending</h2>

      <div className="space-y-1.5">
        <Label htmlFor={modeId} className="text-[12px] font-medium">Review or auto-send</Label>
        <select
          id={modeId}
          value={mode}
          onChange={(e) => setMode(e.target.value as SequenceAutoSendMode)}
          className="w-full rounded-md border bg-background px-3 py-2 text-sm"
        >
          <option value="workspace">Follow the workspace setting</option>
          <option value="review">Always review before sending</option>
          <option value="auto">Auto-send above a score</option>
        </select>
        <p className="text-[12px] text-muted-foreground">{preview}</p>
      </div>

      {mode === "auto" && (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor={scoreId} className="text-[12px] font-medium">Lowest score that sends</Label>
            <Input id={scoreId} inputMode="numeric" value={scoreMin} onChange={(e) => setScoreMin(e.target.value)} placeholder={`Workspace's: ${ws?.aiAutoSendScoreMin ?? 70}`} />
            <p className="text-[11px] text-muted-foreground">0–100. Leads by lead score, contacts by relationship strength, people by priority score.</p>
          </div>
          <div className="flex items-start gap-2 pt-6">
            <Switch id={`${scoreId}-unscored`} checked={allowUnscored} onCheckedChange={setAllowUnscored} />
            <Label htmlFor={`${scoreId}-unscored`} className="text-[12px] cursor-pointer">Send to people with no score too</Label>
          </div>
        </div>
      )}

      <div className="flex items-start gap-2">
        <Switch id={`${modeId}-tz`} checked={recipientTime} onCheckedChange={setRecipientTime} />
        <div>
          <Label htmlFor={`${modeId}-tz`} className="text-[12px] font-medium cursor-pointer">Send in each person's time zone</Label>
          <p className="text-[11px] text-muted-foreground">
            Each step comes due inside this sequence's send window in the person's own zone: the one on their People record, else their state or province (US and Canada), else the sequence's.
            It changes when emails go, not how many. The workspace send window and the pause still apply.
          </p>
        </div>
      </div>

      <p className="text-[11px] text-muted-foreground">Nothing sends while outbound is paused, whatever is chosen here.</p>

      <div className="flex justify-end">
        <Button
          size="sm"
          style={accent ? { backgroundColor: accent } : undefined}
          disabled={save.isPending || scoreBad}
          onClick={() => save.mutate({
            id: sequenceId,
            settings: {
              autoSend: mode === "workspace" ? null : mode,
              autoSendScoreMin: mode === "auto" ? parsedScore : null,
              autoSendAllowUnscored: mode === "auto" ? allowUnscored : null,
              recipientTime: recipientTime ? true : null,
            },
          })}
        >
          {save.isPending ? "Saving…" : "Save sending settings"}
        </Button>
      </div>
    </div>
  );
}
