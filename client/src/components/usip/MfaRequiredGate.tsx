/**
 * Full-screen interstitial for workspace `enforce2fa` (2026-09-20).
 *
 * WHY AN INTERSTITIAL AND NOT A REDIRECT. The obvious answer — send the
 * blocked member to Settings → Profile → MFA — does not work. That page needs
 * `profile.getMe` and `settings.get`, and the shell around it fires
 * `notifications.unreadCount`, `profile.getMyAppearance`, `workspace.getBranding`
 * and `pageDescriptions.get`. All six are workspaceProcedure, so all six are
 * behind the very gate that refused them: the member would arrive at a page of
 * failed queries. Only the four enrolment procedures are exempt on the server,
 * and this panel is the surface that uses exactly those four.
 *
 * It listens for an event rather than reading a query, because main.tsx sends
 * every tRPC call through one httpBatchLink — a gated call and an exempt call
 * share a single HTTP response, so the only reliable signal is the individual
 * error message, which the cache subscriber in main.tsx turns into this event.
 *
 * Non-dismissable by design. The two ways out are the ones that actually
 * resolve it: enrol, or sign out.
 */
import { useEffect, useState } from "react";
import { useAuth } from "@/_core/hooks/useAuth";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { ShieldAlert } from "lucide-react";
import { TotpSetupDialog } from "@/components/usip/settings/TotpSetupDialog";
// Raised by main.tsx's cache subscriber on MFA_REQUIRED_ERR_MSG.
import { MFA_REQUIRED_EVENT } from "@/lib/authRedirect";

export function MfaRequiredGate() {
  const [blocked, setBlocked] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);
  const { logout } = useAuth();
  const utils = trpc.useUtils();

  useEffect(() => {
    const onBlocked = () => setBlocked(true);
    window.addEventListener(MFA_REQUIRED_EVENT, onBlocked);
    return () => window.removeEventListener(MFA_REQUIRED_EVENT, onBlocked);
  }, []);

  if (!blocked) return null;

  return (
    <>
      <div className="fixed inset-0 z-[100] flex items-center justify-center bg-background/95 backdrop-blur-sm p-6">
        <div className="w-full max-w-md rounded-lg border border-border bg-card p-6 shadow-lg space-y-4">
          <div className="flex items-start gap-3">
            <ShieldAlert className="size-5 shrink-0 text-amber-500 mt-0.5" />
            <div className="space-y-1">
              <h2 className="text-base font-semibold">Two-factor authentication required</h2>
              <p className="text-sm text-muted-foreground">
                Your administrator requires an authenticator app on this workspace. Connect one to
                carry on — it takes about a minute, and you will need a TOTP app such as Google
                Authenticator, Microsoft Authenticator or 1Password.
              </p>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Lost the phone your codes were on? An admin can reset your 2FA from the Team page —
            there are no backup codes.
          </p>
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="outline" size="sm" onClick={() => logout()}>Sign out</Button>
            <Button size="sm" onClick={() => setSetupOpen(true)}>Connect authenticator app</Button>
          </div>
        </div>
      </div>
      <TotpSetupDialog
        open={setupOpen}
        onClose={() => setSetupOpen(false)}
        onConfirmed={() => {
          // The gate reads mfaTotpEnabledAt straight off the session user, so
          // there is no server cache to wait out — refetching everything the
          // gate refused is enough to bring the app back.
          setBlocked(false);
          utils.invalidate();
        }}
      />
    </>
  );
}
