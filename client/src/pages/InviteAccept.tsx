/**
 * /invite/accept — Public invitation acceptance page.
 *
 * Flow:
 * 1. Read ?token= from URL.
 * 2. Call team.acceptInvitePreview (public) to validate the token and fetch
 *    workspace/role info.
 * 3. Show a branded card with workspace name, role, and expiry.
 * 4. "Sign in to accept" button builds a login URL that encodes a returnPath
 *    back to this page so the OAuth callback redirects here after login.
 * 5. On return (user is now signed in), call team.finaliseAcceptance (protected)
 *    automatically, then redirect to the dashboard.
 */
import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Loader2, CheckCircle2, XCircle, Building2, UserCheck } from "lucide-react";

function getLoginUrlWithReturn(returnPath: string): string {
  const oauthPortalUrl = import.meta.env.VITE_OAUTH_PORTAL_URL as string;
  const appId = import.meta.env.VITE_APP_ID as string;
  const redirectUri = `${window.location.origin}/api/oauth/callback`;
  // Encode returnPath into state so the OAuth callback redirects back here
  const state = btoa(JSON.stringify({ redirectUri, returnPath }));
  const url = new URL(`${oauthPortalUrl}/app-auth`);
  url.searchParams.set("appId", appId);
  url.searchParams.set("redirectUri", redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("type", "signIn");
  return url.toString();
}

const ROLE_LABELS: Record<string, string> = {
  super_admin: "Super Admin",
  admin: "Admin",
  manager: "Manager",
  rep: "Sales Rep",
};

export default function InviteAccept() {
  const [, navigate] = useLocation();
  const { user, isLoading: authLoading } = useAuth();

  // Extract token from URL
  const params = new URLSearchParams(window.location.search);
  const token = params.get("token") ?? "";

  // Step 1: preview query (public — always runs)
  const previewQuery = trpc.team.acceptInvitePreview.useQuery(
    { token },
    {
      enabled: !!token,
      retry: false,
    },
  );

  // Step 2: finalise mutation (protected — only called when user is signed in)
  const finaliseMutation = trpc.team.finaliseAcceptance.useMutation({
    onSuccess: (data) => {
      setFinalised(true);
      setFinalResult({ workspaceName: data.workspaceName, role: data.role });
    },
    onError: (err) => {
      setFinaliseError(err.message);
    },
  });

  const [finalised, setFinalised] = useState(false);
  const [finalResult, setFinalResult] = useState<{ workspaceName: string; role: string } | null>(null);
  const [finaliseError, setFinaliseError] = useState<string | null>(null);
  const [autoFinaliseAttempted, setAutoFinaliseAttempted] = useState(false);

  // When user signs in and returns to this page, auto-finalise
  useEffect(() => {
    if (
      !authLoading &&
      user &&
      token &&
      !finalised &&
      !autoFinaliseAttempted &&
      !finaliseMutation.isPending &&
      previewQuery.data // token is valid
    ) {
      setAutoFinaliseAttempted(true);
      finaliseMutation.mutate({ token });
    }
  }, [authLoading, user, token, finalised, autoFinaliseAttempted, previewQuery.data]);

  // Redirect to dashboard 3 seconds after successful acceptance
  useEffect(() => {
    if (finalised) {
      const t = setTimeout(() => navigate("/"), 3000);
      return () => clearTimeout(t);
    }
  }, [finalised, navigate]);

  // ── Render states ──────────────────────────────────────────────────────────

  if (!token) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-4">
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            <XCircle className="mx-auto h-12 w-12 text-destructive mb-2" />
            <CardTitle>Invalid Invite Link</CardTitle>
            <CardDescription>This invite link is missing a token. Please use the link from your invitation email.</CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  if (previewQuery.isLoading || authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (previewQuery.error) {
    const msg = previewQuery.error.message;
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-4">
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            <XCircle className="mx-auto h-12 w-12 text-destructive mb-2" />
            <CardTitle>Invite Link Problem</CardTitle>
            <CardDescription>{msg}</CardDescription>
          </CardHeader>
          <CardContent className="text-center text-sm text-muted-foreground">
            Please contact your workspace administrator for a new invitation.
          </CardContent>
        </Card>
      </div>
    );
  }

  // Successful finalisation
  if (finalised && finalResult) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-4">
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            <CheckCircle2 className="mx-auto h-12 w-12 text-green-500 mb-2" />
            <CardTitle>Welcome to {finalResult.workspaceName}!</CardTitle>
            <CardDescription>
              You have successfully joined as a{" "}
              <strong>{ROLE_LABELS[finalResult.role] ?? finalResult.role}</strong>.
              Redirecting you to the dashboard…
            </CardDescription>
          </CardHeader>
          <CardContent className="flex justify-center">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </CardContent>
        </Card>
      </div>
    );
  }

  // Finalise error (e.g., email mismatch)
  if (finaliseError) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-4">
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            <XCircle className="mx-auto h-12 w-12 text-destructive mb-2" />
            <CardTitle>Could Not Accept Invitation</CardTitle>
            <CardDescription>{finaliseError}</CardDescription>
          </CardHeader>
          <CardContent className="text-center">
            <Button variant="outline" onClick={() => navigate("/")}>
              Go to Dashboard
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Auto-finalising in progress (user is signed in, mutation is running)
  if (user && finaliseMutation.isPending) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="text-center space-y-3">
          <Loader2 className="mx-auto h-8 w-8 animate-spin text-primary" />
          <p className="text-sm text-muted-foreground">Accepting your invitation…</p>
        </div>
      </div>
    );
  }

  // Main state: show invite card
  const preview = previewQuery.data!;
  const returnPath = `/invite/accept?token=${encodeURIComponent(token)}`;
  const loginUrl = getLoginUrlWithReturn(returnPath);

  const expiresAt = preview.expiresAt ? new Date(preview.expiresAt) : null;
  const hoursLeft = expiresAt
    ? Math.max(0, Math.round((expiresAt.getTime() - Date.now()) / 3_600_000))
    : null;

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-background to-muted/30 p-4">
      <Card className="w-full max-w-md shadow-lg">
        <CardHeader className="text-center pb-2">
          <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-full bg-primary/10">
            <Building2 className="h-7 w-7 text-primary" />
          </div>
          <CardTitle className="text-2xl">You're Invited!</CardTitle>
          <CardDescription className="text-base mt-1">
            You have been invited to join{" "}
            <strong className="text-foreground">{preview.workspaceName}</strong>
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-5 pt-4">
          {/* Role badge */}
          <div className="flex items-center justify-center gap-2">
            <UserCheck className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm text-muted-foreground">Your role:</span>
            <Badge variant="secondary" className="text-sm font-medium">
              {ROLE_LABELS[preview.role] ?? preview.role}
            </Badge>
          </div>

          {/* Invited email */}
          {preview.userEmail && (
            <p className="text-center text-sm text-muted-foreground">
              This invite was sent to{" "}
              <span className="font-medium text-foreground">{preview.userEmail}</span>.
              Please sign in with that email address.
            </p>
          )}

          {/* Expiry warning */}
          {hoursLeft !== null && hoursLeft <= 48 && (
            <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-center text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
              {hoursLeft === 0
                ? "This invitation has just expired."
                : `This invitation expires in ${hoursLeft} hour${hoursLeft === 1 ? "" : "s"}.`}
            </div>
          )}

          {/* CTA */}
          {user ? (
            // User is signed in but finalise hasn't run yet (shouldn't normally show)
            <Button
              className="w-full"
              onClick={() => {
                setAutoFinaliseAttempted(false);
                finaliseMutation.mutate({ token });
              }}
              disabled={finaliseMutation.isPending}
            >
              {finaliseMutation.isPending ? (
                <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Accepting…</>
              ) : (
                "Accept Invitation"
              )}
            </Button>
          ) : (
            <Button className="w-full" asChild>
              <a href={loginUrl}>Sign in to Accept Invitation</a>
            </Button>
          )}

          <p className="text-center text-xs text-muted-foreground">
            By accepting, you agree to join this workspace and its data policies.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
