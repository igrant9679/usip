import { Button } from "@/components/ui/button";
import { ConfirmButton } from "@/components/usip/Common";
import { trpc } from "@/lib/trpc";
import { invalidateEnrollmentReads } from "@/lib/enrollmentCache";
import { toast } from "sonner";

/**
 * Pause, resume or take one person out of a sequence. Pause is pauseEnrollment,
 * not the pauseOnReply that legacy /sequences calls: that one files a "Reply
 * detected" task, which would be untrue when nobody replied. Exit asks first,
 * because it ends the person's place in the sequence.
 */
export function SequenceEnrollmentActions({ enrollment, sequenceId }: {
  enrollment: { id: number; status?: unknown; personName?: string | null };
  sequenceId: number;
}) {
  const utils = trpc.useUtils();
  const name = enrollment.personName || "this person";
  // Also after a refusal: it means the row moved on, and the list is stale.
  // Through the shared list, which has the two legacy reads this one missed.
  const refresh = () => invalidateEnrollmentReads(utils, sequenceId);
  const done = (message: string) => () => { refresh(); toast.success(message); };
  const failed = (e: { message: string }) => { refresh(); toast.error(e.message); };
  const pause = trpc.sequences.pauseEnrollment.useMutation({ onSuccess: done(`Paused ${name}`), onError: failed });
  const resume = trpc.sequences.resumeEnrollment.useMutation({ onSuccess: done(`Resumed ${name}`), onError: failed });
  const exit = trpc.sequences.exitEnrollment.useMutation({ onSuccess: done(`Took ${name} out of this sequence`), onError: failed });
  const busy = pause.isPending || resume.isPending || exit.isPending;

  if (enrollment.status !== "active" && enrollment.status !== "paused") return null;
  return (
    <div className="flex items-center gap-1 shrink-0">
      {enrollment.status === "active" && (
        <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" disabled={busy} onClick={() => pause.mutate({ id: enrollment.id })}>Pause</Button>
      )}
      {enrollment.status === "paused" && (
        <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" disabled={busy} onClick={() => resume.mutate({ id: enrollment.id })}>Resume</Button>
      )}
      <ConfirmButton
        className="h-6 px-2 text-xs text-muted-foreground"
        disabled={busy}
        title={`Take ${name} out of this sequence?`}
        description="They won't get any more steps from it. To bring them back, enrol them again from the start."
        confirmLabel="Exit sequence"
        onConfirm={() => exit.mutate({ id: enrollment.id })}
      >
        Exit
      </ConfirmButton>
    </div>
  );
}
