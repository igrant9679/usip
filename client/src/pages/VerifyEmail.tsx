/**
 * /verify-email?token=… — where a new account's confirmation link lands
 * (audit 2026-10-20, F1).
 *
 * PUBLIC, like /reset-password and /confirm-email: the link may be opened in
 * a browser that is not signed in. It acts on a button press, not on load,
 * so a mail scanner that fetches the link confirms nothing.
 */
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Loader2, MailCheck } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { usePageTitle } from "@/lib/usePageTitle";

export default function VerifyEmail() {
  usePageTitle("Confirm your email");
  const token = new URLSearchParams(window.location.search).get("token") ?? "";
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const confirm = trpc.accountVerification.confirm.useMutation({
    onSuccess: (r) => setDone(r.email ?? "your address"),
    onError: (e) => setError(e.message),
  });

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#0F1F1B] text-[#FAF8F2] px-6">
      <div className="w-full max-w-sm space-y-6">
        <div className="space-y-1">
          <h1 className="text-3xl font-bold tracking-tight text-white">Velocity</h1>
          <p className="text-[#A5B4FC] text-sm tracking-wide">Confirm your email address</p>
        </div>
        {!token ? (
          <p className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-md px-3 py-2">
            This link is missing its token. Sign in and press Resend link for a new one.
          </p>
        ) : done ? (
          <div className="space-y-4">
            <p className="text-sm text-white/80 bg-[#14B89A]/10 border border-[#14B89A]/30 rounded-md px-3 py-2">
              Thanks: {done} is confirmed.
            </p>
            <Button className="w-full bg-[#14B89A] hover:bg-[#0FA086] text-black font-semibold" onClick={() => { window.location.href = "/"; }}>
              Go to Velocity
            </Button>
          </div>
        ) : (
          <div className="space-y-4">
            {error && (
              <p className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-md px-3 py-2">{error}</p>
            )}
            <Button
              className="w-full bg-[#14B89A] hover:bg-[#0FA086] text-black font-semibold"
              disabled={confirm.isPending}
              onClick={() => { setError(null); confirm.mutate({ token }); }}
            >
              {confirm.isPending
                ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Confirming…</>
                : <><MailCheck className="mr-2 h-4 w-4" /> Confirm my email</>}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
