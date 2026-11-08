import { ConfirmButton } from "@/components/usip/Common";
import { trpc } from "@/lib/trpc";
import { invalidateEnrollmentReads } from "@/lib/enrollmentCache";
import { toast } from "sonner";

/**
 * "Mark replied" on a Contacts-tab row: the legacy /sequences action, moved
 * into the v2 editor with U14 (one sequence editor, 2026-11-07).
 *
 * It IS `pauseOnReply`: the person is paused and a "Reply detected" task is
 * filed for tomorrow. That is why it is its own button, apart from the plain
 * Pause in SequenceEnrollmentActions, and why it asks first: it is for someone
 * who answered somewhere the reply poller does not read, and the task it files
 * says a reply happened.
 */
export function SequenceMarkReply({ enrollment, sequenceId }: {
  enrollment: { id: number; status?: unknown; personName?: string | null };
  sequenceId: number;
}) {
  const utils = trpc.useUtils();
  const name = enrollment.personName || "this person";
  const replied = trpc.sequences.pauseOnReply.useMutation({
    onSuccess: () => { invalidateEnrollmentReads(utils, sequenceId); toast.success(`Paused ${name} and filed a task to follow up their reply`); },
    onError: (e) => { invalidateEnrollmentReads(utils, sequenceId); toast.error(e.message); },
  });
  if (enrollment.status !== "active") return null;
  return (
    <ConfirmButton
      className="h-6 px-2 text-xs text-amber-700 dark:text-amber-300"
      destructive={false}
      disabled={replied.isPending}
      title={`Mark ${name} as replied?`}
      description="They are paused in this sequence and a task to follow up their reply is filed for tomorrow. Use it when they answered somewhere Velocity does not read."
      confirmLabel="Mark replied"
      onConfirm={() => replied.mutate({ enrollmentId: enrollment.id })}
    >
      Mark replied
    </ConfirmButton>
  );
}
