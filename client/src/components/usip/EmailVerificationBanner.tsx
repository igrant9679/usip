/**
 * "Confirm your email" for an account that registered itself and has not
 * opened its link yet (audit 2026-10-20, F1), with Resend. Shown in the app
 * shell and on the no-workspace screen, which is where a new stranger lands.
 * Renders nothing for everyone else: every account from before 2026-11-07,
 * and every invitee, counts as verified.
 */
import { useState } from "react";
import { toast } from "sonner";
import { MailWarning, Loader2 } from "lucide-react";
import { useAuth } from "@/_core/hooks/useAuth";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";

export function EmailVerificationBanner({ compact = false }: { compact?: boolean }) {
  const { user } = useAuth();
  const [note, setNote] = useState<string | null>(null);
  const utils = trpc.useUtils();
  const resend = trpc.accountVerification.resend.useMutation({
    onSuccess: (r) => {
      setNote(r.message);
      if (r.alreadyVerified) void utils.auth.me.invalidate();
      else if (r.sent) toast.success(r.message);
    },
    onError: (e) => toast.error(e.message ?? "Could not send a new link"),
  });
  if (!(user as { emailVerificationPending?: boolean } | null)?.emailVerificationPending) return null;
  return (
    <div
      role="status"
      data-testid="email-verification-banner"
      className={compact
        ? "rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-amber-800 dark:text-amber-300 space-y-1.5"
        : "flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-amber-500/40 bg-amber-500/10 px-4 py-2 text-[13px] text-amber-900 dark:text-amber-200"}
    >
      <span className="inline-flex items-center gap-1.5">
        <MailWarning className="size-4 shrink-0" aria-hidden="true" />
        Confirm your email address: we sent a link to {user?.email ?? "your inbox"}.
      </span>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-7 gap-1.5"
        disabled={resend.isPending}
        onClick={() => resend.mutate()}
      >
        {resend.isPending ? <Loader2 className="size-3.5 animate-spin" /> : null} Resend link
      </Button>
      {note && <span className="text-xs opacity-80">{note}</span>}
    </div>
  );
}
