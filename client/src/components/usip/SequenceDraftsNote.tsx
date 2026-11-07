import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { Mail } from "lucide-react";
import { Link } from "wouter";
import { sequenceAutoSend } from "@shared/sequenceAutoSend";

/** Where a sequence's drafts wait to be reviewed. */
export const SEQUENCE_DRAFTS_HREF = "/v2/emails?status=awaiting&source=sequence";

/**
 * What an email step does (audit 2026-10-20, O48). No sequence page said it:
 * an email step writes a DRAFT, and nothing is sent until someone reviews and
 * sends it, or auto-send does. Read with auto-send's switch for this
 * workspace, so the note says which of the two applies here.
 */
export function SequenceDraftsNote({ className, sequenceSettings }: { className?: string; sequenceSettings?: unknown }) {
  const settings = trpc.emailAutoSend.getAutoSendSettings.useQuery(undefined as any, { retry: false });
  const ws = settings.data as { aiAutoSendEnabled?: boolean; aiAutoSendScoreMin?: number } | null | undefined;
  const autoSend = ws?.aiAutoSendEnabled;
  // On one sequence's page, its own choice wins over the workspace's (F22).
  const own = sequenceSettings === undefined ? null : sequenceAutoSend(sequenceSettings);
  return (
    <div role="note" className={cn("flex items-start gap-2 rounded-md border bg-muted/40 px-3 py-2 text-[12px] text-muted-foreground", className)}>
      <Mail className="size-3.5 mt-0.5 shrink-0" />
      <span>
        Email steps don't send by themselves. Each one writes a draft that waits in{" "}
        <Link href={SEQUENCE_DRAFTS_HREF} className="font-medium text-foreground underline underline-offset-2">Emails → Needs review</Link>{" "}
        until someone sends it
        {own?.mode === "review"
          ? ". This sequence always waits for review (its Settings tab), whatever the workspace does."
          : own?.mode === "auto"
            ? `, or auto-send sends it: this sequence auto-sends to people scoring ${own.scoreMin ?? ws?.aiAutoSendScoreMin ?? 70} or more (its Settings tab).`
            : autoSend === true
          ? ", or auto-send sends it: auto-send is on in this workspace, for recipients who meet its score."
          : autoSend === false
            ? ". Auto-send is off in this workspace."
            : ", or auto-send does, if it's on."}
      </span>
    </div>
  );
}
