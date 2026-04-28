/**
 * /login — Password-based sign-in page.
 *
 * Accepts email + password, POSTs to /api/auth/password-login, and
 * redirects to the dashboard (or ?returnPath=) on success.
 */
import { useState } from "react";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, Eye, EyeOff, LogIn } from "lucide-react";

export default function PasswordLogin() {
  const [, navigate] = useLocation();
  const params = new URLSearchParams(window.location.search);
  const returnPath = params.get("returnPath") ?? "/";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!email.trim() || !password) {
      setError("Please enter your email and password.");
      return;
    }
    setLoading(true);
    try {
      const res = await fetch("/api/auth/password-login", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ email: email.trim().toLowerCase(), password, returnPath }),
        credentials: "include",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? "Login failed. Please try again.");
        return;
      }
      // Session cookie set — navigate to returnPath
      window.location.href = data.redirect ?? returnPath;
    } catch {
      setError("Network error. Please check your connection and try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-[#0F1F1B] to-[#162820] p-4">
      <div className="w-full max-w-md space-y-4">
        {/* Logo */}
        <div className="flex items-center justify-center gap-2 mb-2">
          <svg className="size-6 text-[#60A5FA] shrink-0" viewBox="0 0 24 24" fill="currentColor">
            <path d="M13 2L4.09 12.97 12 12l-1 9 8.91-10.97L12 11l1-9z" />
          </svg>
          <span className="text-2xl font-bold tracking-tight text-white">Velocity</span>
        </div>

        <Card className="border-white/10 bg-white/5 backdrop-blur-sm shadow-2xl">
          <CardHeader className="text-center pb-2">
            <CardTitle className="text-xl text-white">Sign in to your account</CardTitle>
            <CardDescription className="text-white/50">
              Enter your email and password to continue.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5 pt-2">
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="login-email" className="text-white/80">Email</Label>
                <Input
                  id="login-email"
                  type="email"
                  placeholder="you@company.com"
                  value={email}
                  onChange={(e) => { setEmail(e.target.value); setError(null); }}
                  autoComplete="email"
                  className="bg-white/10 border-white/20 text-white placeholder:text-white/30 focus:border-[#14B89A]"
                  disabled={loading}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="login-password" className="text-white/80">Password</Label>
                <div className="relative">
                  <Input
                    id="login-password"
                    type={showPassword ? "text" : "password"}
                    placeholder="Your password"
                    value={password}
                    onChange={(e) => { setPassword(e.target.value); setError(null); }}
                    autoComplete="current-password"
                    className="bg-white/10 border-white/20 text-white placeholder:text-white/30 focus:border-[#14B89A] pr-10"
                    disabled={loading}
                  />
                  <button
                    type="button"
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-white/40 hover:text-white/70"
                    onClick={() => setShowPassword((v) => !v)}
                    tabIndex={-1}
                  >
                    {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
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
                {loading ? (
                  <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Signing in…</>
                ) : (
                  <><LogIn className="mr-2 h-4 w-4" /> Sign in</>
                )}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
