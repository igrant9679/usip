/**
 * What someone who is signed in sees when they have no workspace to work in
 * (audit 2026-10-20, G35 and G36): a deactivated member, an invitation not yet
 * accepted, an account with no workspace, or a workspace that was archived.
 * It used to be the whole shell, with the switcher stuck on "Loading…" and
 * every query failing.
 *
 * Mounted once in AuthGate, inside WorkspaceProvider, around every authed page.
 */
import type { ReactNode } from "react";
import { useAuth } from "@/_core/hooks/useAuth";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { canOpenWorkspace } from "@/lib/activeWorkspace";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Archive, Loader2, MailQuestion, UserX } from "lucide-react";
import { EmailVerificationBanner } from "@/components/usip/EmailVerificationBanner";
import { PendingInvitations } from "@/components/usip/PendingInvitations";

export type AccessProblem = "deactivated" | "invite_pending" | "none" | "archived";

const COPY: Record<AccessProblem, { title: string; body: string }> = {
  deactivated: {
    title: "Your access has been removed",
    body: "An administrator deactivated your membership of this workspace. If you think that's a mistake, ask them to reactivate you.",
  },
  invite_pending: {
    title: "Your invitation is waiting",
    body: "Accept it below, or open the invitation link in your email. If it has expired, ask your administrator to send a new one.",
  },
  none: {
    title: "You're not in a workspace yet",
    body: "Your account is ready. Workspaces are set up by your administrator: ask them to invite you, or open the activation link they sent you.",
  },
  archived: {
    title: "This workspace is archived",
    body: "A super admin has archived it. Nothing has been deleted, and a super admin can restore it from Settings → Danger zone.",
  },
};

/** The screen itself, without data hooks, so it can be rendered on its own. */
export function WorkspaceAccessScreen({
  problem,
  workspaceName,
  others = [],
  onSwitch,
  onSignOut,
  notice,
  invitations,
}: {
  problem: AccessProblem;
  workspaceName?: string | null;
  others?: Array<{ id: number; name: string }>;
  onSwitch?: (id: number) => void;
  onSignOut?: () => void;
  /** Shown under the message: the email-confirmation banner (F1), when it applies. */
  notice?: ReactNode;
  /** Invitations waiting for this person, with Accept (U10). */
  invitations?: ReactNode;
}) {
  const copy = COPY[problem];
  const Icon = problem === "archived" ? Archive : problem === "invite_pending" ? MailQuestion : UserX;
  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-6">
      <div className="w-full max-w-md rounded-lg border border-border bg-card p-6 shadow-sm space-y-4" role="alert">
        <div className="flex items-start gap-3">
          <Icon className="size-5 shrink-0 text-amber-500 mt-0.5" aria-hidden="true" />
          <div className="space-y-1">
            <h1 className="text-base font-semibold">{copy.title}</h1>
            {problem === "archived" && workspaceName && <p className="text-sm font-medium">{workspaceName}</p>}
            <p className="text-sm text-muted-foreground">{copy.body}</p>
          </div>
        </div>
        {notice}
        {invitations}
        {others.length > 0 && onSwitch && (
          <div className="space-y-1.5">
            <p className="text-xs text-muted-foreground">You can carry on in another workspace:</p>
            {others.map((w) => (
              <Button key={w.id} variant="outline" size="sm" className="w-full justify-start" onClick={() => onSwitch(w.id)}>
                {w.name}
              </Button>
            ))}
          </div>
        )}
        <div className="flex justify-end pt-1">
          <Button variant="outline" size="sm" onClick={() => onSignOut?.()}>Sign out</Button>
        </div>
      </div>
    </div>
  );
}

export function WorkspaceAccessGate({ children }: { children: ReactNode }) {
  const { workspaces, current, isLoading, switchTo } = useWorkspace();
  const { logout } = useAuth();
  const empty = !isLoading && workspaces.length === 0;
  const access = trpc.workspace.access.useQuery(undefined, { enabled: empty });

  if (empty) {
    const state = access.data?.state;
    if (!state || state === "member") {
      return <div className="min-h-screen flex items-center justify-center"><Loader2 className="size-6 animate-spin text-muted-foreground" /></div>;
    }
    // A stranger who just signed up lands here, so the confirm-your-email
    // banner (F1) belongs here as well as in the shell.
    // Invitations waiting for this account can be accepted right here (U10).
    return <WorkspaceAccessScreen problem={state} onSignOut={() => void logout()} notice={<EmailVerificationBanner compact />} invitations={<PendingInvitations className="rounded-md border border-border" />} />;
  }
  if (current && !canOpenWorkspace(current)) {
    return (
      <WorkspaceAccessScreen
        problem="archived"
        workspaceName={current.name}
        others={workspaces.filter((w) => w.id !== current.id && canOpenWorkspace(w))}
        onSwitch={switchTo}
        onSignOut={() => void logout()}
      />
    );
  }
  return <>{children}</>;
}
