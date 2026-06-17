/**
 * /join — Public self-registration via a role-scoped activation link.
 *
 * Unlike /invite/accept (which is bound to a specific invited email), an
 * activation link carries no email. The recipient:
 *   1. Opens /join?token=… — we validate the token via team.inviteLinkPreview.
 *   2. Sees which workspace + role they're joining.
 *   3. Enters their OWN email + password (+ optional name).
 *   4. POSTs /api/auth/register with the token. The server creates the user,
 *      consumes the (single-use) link, adds them to the workspace at the link's
 *      role, and issues a session cookie. We then redirect to the dashboard.
 */
import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, CheckCircle2, XCircle, Building2, Eye, EyeOff, Lock } from "lucide-react";

const ROLE_LABELS: Record<string, string> = {
  super_admin: "Super Admin",
  admin: "Admin",
  manager: "Manager",
  rep: "Sales Rep",
};

const INVALID_REASON: Record<string, string> = {
  not_found: "This activation link is not valid.",
  used: "This activation link has already been used.",
  expired: "This activation link has expired.",
  unavailable: "Something went wrong. Please try again shortly.",
};

export default function JoinViaLink() {
  const params = new URLSearchParams(window.location.search);
  const token = params.get("token") ?? "";

  const preview = trpc.team.inviteLinkPreview.useQuery(
    { token },
    { enabled: !!token, retry: false },
  );

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function register() {
    setError(null);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) {
      setError("Please enter a valid email address.");
      return;
    }
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    if (password !== confirm) {
      setError("Passwords do not match.");
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        credentials: "include",
        body: JSON.stringify({
          email: email.trim(),
          password,
          name: name.trim() || undefined,
          inviteLinkToken: token,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? "Could not create your account. Please try again.");
        return;
      }
      window.location.href = data.redirect ?? "/";
    } catch {
      setError("Network error. Please check your connection and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  // ── No token ───────────────────────────────────────────────────────
  if (!token) {
    return (
      <Shell>
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            <XCircle className="size-10 text-rose-500 mx-auto mb-2" />
            <CardTitle>Invalid link</CardTitle>
            <CardDescription>This activation link is missing a token.</CardDescription>
          </CardHeader>
        </Card>
      </Shell>
    );
  }

  // ── Validating ─────────────────────────────────────────────────────
  if (preview.isLoading) {
    return (
      <Shell>
        <Card className="w-full max-w-md">
          <CardContent className="py-10 text-center">
            <Loader2 className="size-7 animate-spin text-muted-foreground mx-auto mb-3" />
            <p className="text-sm text-muted-foreground">Checking your invitation…</p>
          </CardContent>
        </Card>
      </Shell>
    );
  }

  // ── Invalid / used / expired ───────────────────────────────────────
  if (!preview.data || !preview.data.valid) {
    const reason = (preview.data && "reason" in preview.data ? preview.data.reason : undefined) ?? "not_found";
    return (
      <Shell>
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            <XCircle className="size-10 text-rose-500 mx-auto mb-2" />
            <CardTitle>Link unavailable</CardTitle>
            <CardDescription>{INVALID_REASON[reason] ?? INVALID_REASON.not_found}</CardDescription>
          </CardHeader>
          <CardContent className="text-center">
            <p className="text-xs text-muted-foreground">Ask whoever shared the link to send you a fresh one.</p>
          </CardContent>
        </Card>
      </Shell>
    );
  }

  // ── Valid → registration form ──────────────────────────────────────
  const { workspaceName, role } = preview.data;
  return (
    <Shell>
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <Building2 className="size-9 text-primary mx-auto mb-2" />
          <CardTitle>Join {workspaceName}</CardTitle>
          <CardDescription className="flex items-center justify-center gap-1.5">
            You're joining as
            <Badge variant="secondary">{ROLE_LABELS[role] ?? role}</Badge>
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="space-y-3"
            onSubmit={(e) => { e.preventDefault(); register(); }}
          >
            <div className="space-y-1">
              <Label htmlFor="name">Full name (optional)</Label>
              <Input id="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Sam Carter" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="email">Work email</Label>
              <Input id="email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="sam@acme.com" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="password">Password</Label>
              <div className="relative">
                <Input
                  id="password"
                  type={showPassword ? "text" : "password"}
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="At least 8 characters"
                  className="pr-9"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((s) => !s)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground"
                  tabIndex={-1}
                >
                  {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </button>
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="confirm">Confirm password</Label>
              <Input id="confirm" type={showPassword ? "text" : "password"} required value={confirm} onChange={(e) => setConfirm(e.target.value)} />
            </div>

            {error && <p className="text-sm text-rose-600">{error}</p>}

            <Button type="submit" className="w-full" disabled={submitting}>
              {submitting ? <Loader2 className="size-4 mr-1 animate-spin" /> : <CheckCircle2 className="size-4 mr-1" />}
              Create account & join
            </Button>
            <p className="text-[11px] text-muted-foreground text-center flex items-center justify-center gap-1">
              <Lock className="size-3" /> Your password is encrypted and never shared.
            </p>
          </form>
        </CardContent>
      </Card>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-muted/30 p-4">
      {children}
    </div>
  );
}
