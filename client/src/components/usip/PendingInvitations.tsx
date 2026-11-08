/**
 * Invitations waiting for you (audit 2026-10-20, U10; batch CONB,
 * 2026-11-08). An existing user invited to another workspace had only the
 * email to go on; nothing in the app said an invitation was waiting. This
 * lists them, in the workspace switcher and on the no-workspace screen, with
 * Accept, which goes through the server's own invitation path
 * (team.acceptMyInvitation → the same acceptance as the emailed link; an
 * account still confirming its email is pointed at the email, which proves
 * the address).
 */
import { toast } from "sonner";
import { MailPlus } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { Button } from "@/components/ui/button";

export type PendingInvitation = { memberId: number; workspaceId: number; workspaceName: string; role: string; expiresAt?: Date | string | null };

/** The signed-in user's waiting invitations (one cached read for every place that shows them). */
export function usePendingInvitations() {
  return trpc.team.myInvitations.useQuery(undefined, { staleTime: 60_000 });
}

export function PendingInvitations({ onAccepted, className }: { onAccepted?: () => void; className?: string }) {
  const utils = trpc.useUtils();
  const { switchTo } = useWorkspace();
  const invitations = (usePendingInvitations().data ?? []) as PendingInvitation[];
  const accept = trpc.team.acceptMyInvitation.useMutation({
    onSuccess: async (r) => {
      toast.success(`You joined ${r.workspaceName}`);
      // The switcher's list now holds it; open it.
      await utils.workspace.list.invalidate();
      void utils.team.myInvitations.invalidate();
      switchTo(r.workspaceId);
      onAccepted?.();
    },
    onError: (e) => toast.error(e.message),
  });
  if (invitations.length === 0) return null;
  return (
    <div className={className} role="region" aria-label="Invitations waiting for you">
      <div className="px-2 pt-1 pb-1 text-[11px] font-medium text-muted-foreground flex items-center gap-1.5">
        <MailPlus className="size-3.5" aria-hidden /> Invitations waiting for you ({invitations.length})
      </div>
      {invitations.map((inv) => (
        <div key={inv.memberId} className="flex items-center gap-2 px-2 py-1.5 text-[13px]">
          <span className="min-w-0 flex-1">
            <span className="block truncate font-medium">{inv.workspaceName}</span>
            <span className="block text-[11px] text-muted-foreground">
              as {inv.role}{inv.expiresAt ? ` · expires ${new Date(inv.expiresAt).toLocaleDateString()}` : ""}
            </span>
          </span>
          <Button size="sm" variant="outline" className="h-7 shrink-0 text-xs" disabled={accept.isPending}
            aria-label={`Accept the invitation to ${inv.workspaceName}`}
            onClick={() => accept.mutate({ memberId: inv.memberId })}>
            Accept
          </Button>
        </div>
      ))}
    </div>
  );
}
