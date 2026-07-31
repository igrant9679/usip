/**
 * /reset-password?token=… — where the emailed reset link lands.
 *
 * PUBLIC: routed outside AuthGate, because the whole point is that the visitor
 * cannot sign in. It reads the token from the query string, takes a new
 * password, and on success sends them to the sign-in form.
 *
 * It deliberately does NOT log the user in. The server issues no session here:
 * an account with an authenticator app must still pass it, and a reset that
 * signed you straight in would be a way around MFA.
 */
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Eye, EyeOff, Loader2, KeyRound } from "lucide-react";

export default function ResetPassword() {
  const token = new URLSearchParams(window.location.search).get("token") ?? "";

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [show, setShow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    if (password !== confirm) {
      setError("Those passwords don't match.");
      return;
    }
    setLoading(true);
    try {
      const res = await fetch("/api/auth/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ token, password }),
        credentials: "include",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? "Could not reset your password. Request a new link and try again.");
        return;
      }
      setDone(true);
    } catch {
      setError("Network error. Please check your connection and try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#0F1F1B] text-[#FAF8F2] px-6">
      <div className="w-full max-w-sm space-y-6">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <svg className="size-6 text-[#60A5FA] shrink-0" viewBox="0 0 24 24" fill="currentColor"><path d="M13 2L4.09 12.97 12 12l-1 9 8.91-10.97L12 11l1-9z" /></svg>
            <span className="text-3xl font-bold tracking-tight text-white">Velocity</span>
          </div>
          <p className="text-[#A5B4FC] text-sm tracking-wide">Choose a new password</p>
        </div>

        {!token ? (
          <p className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-md px-3 py-2">
            This link is missing its token. Request a new reset link from the sign-in page.
          </p>
        ) : done ? (
          <div className="space-y-4">
            <p className="text-sm text-white/80 bg-[#14B89A]/10 border border-[#14B89A]/30 rounded-md px-3 py-2">
              Your password has been changed. Sign in with it now.
            </p>
            <Button
              className="w-full bg-[#14B89A] hover:bg-[#0FA086] text-black font-semibold"
              onClick={() => { window.location.href = "/"; }}
            >
              Go to sign in
            </Button>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="new-password" className="text-white/80">New password</Label>
              <div className="relative">
                <Input
                  id="new-password"
                  type={show ? "text" : "password"}
                  placeholder="At least 8 characters"
                  value={password}
                  onChange={(e) => { setPassword(e.target.value); setError(null); }}
                  autoComplete="new-password"
                  className="bg-white/10 border-white/20 text-white placeholder:text-white/30 focus:border-[#14B89A] pr-10"
                  disabled={loading}
                  autoFocus
                />
                <button
                  type="button"
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-white/40 hover:text-white/70"
                  onClick={() => setShow((v) => !v)}
                  tabIndex={-1}
                >
                  {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="confirm-password" className="text-white/80">Confirm password</Label>
              <Input
                id="confirm-password"
                type={show ? "text" : "password"}
                placeholder="Type it again"
                value={confirm}
                onChange={(e) => { setConfirm(e.target.value); setError(null); }}
                autoComplete="new-password"
                className="bg-white/10 border-white/20 text-white placeholder:text-white/30 focus:border-[#14B89A]"
                disabled={loading}
              />
            </div>
            {error && (
              <p className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-md px-3 py-2">
                {error}
              </p>
            )}
            <Button
              type="submit"
              className="w-full bg-[#14B89A] hover:bg-[#0FA086] text-black font-semibold"
              disabled={loading}
            >
              {loading
                ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Saving…</>
                : <><KeyRound className="mr-2 h-4 w-4" /> Set new password</>}
            </Button>
          </form>
        )}
      </div>
    </div>
  );
}
