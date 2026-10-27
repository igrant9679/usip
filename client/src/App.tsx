import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { WorkspaceProvider } from "@/contexts/WorkspaceContext";
import NotFound from "@/pages/NotFound";
import { TourEngineProvider } from "@/components/usip/TourEngine";
import { ElsieController } from "@/components/usip/Elsie";
import { Loader2, Eye, EyeOff, LogIn } from "lucide-react";
import { Route, Switch, useLocation } from "wouter";
import { Suspense, useEffect, useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import { WorkspaceBrandingSync } from "@/components/usip/WorkspaceBrandingSync";
import { ConfirmProvider } from "@/components/usip/Common";
import { safeReturnPath } from "@shared/returnPath";
import { lazyChunk } from "@/lib/lazyChunk";

/*
 * Every page is its own chunk, loaded when its route first renders (audit
 * 2026-10-20, Phase 4, X2.4). They were all imported up front, so the sign-in
 * page alone downloaded the whole app. See lib/lazyChunk.ts.
 */
const AccountRedirect = lazyChunk(() => import("@/pages/usip/AccountRedirect"));
const Audit = lazyChunk(() => import("@/pages/usip/Audit"));
const Campaigns = lazyChunk(() => import("@/pages/usip/Campaigns"));
const ContactRedirect = lazyChunk(() => import("@/pages/usip/ContactRedirect"));
const Customers = lazyChunk(() => import("@/pages/usip/Customers"));
const Dashboard = lazyChunk(() => import("@/pages/usip/Dashboard"));
const DashboardHome2 = lazyChunk(() => import("@/pages/usip/DashboardHome2"));
const Dashboards = lazyChunk(() => import("@/pages/usip/Dashboards"));
const Reports = lazyChunk(() => import("@/pages/usip/Reports"));
const EmailAnalytics = lazyChunk(() => import("@/pages/usip/EmailAnalytics"));
const EmailSuppressions = lazyChunk(() => import("@/pages/usip/EmailSuppressions").then((m) => ({ default: m.EmailSuppressions })));
const SendingAccounts = lazyChunk(() => import("@/pages/usip/SendingAccounts"));
const SenderPools = lazyChunk(() => import("@/pages/usip/SenderPools"));
const Inbox = lazyChunk(() => import("@/pages/usip/Inbox"));
const Mailbox = lazyChunk(() => import("@/pages/usip/Mailbox"));
const CalendarPage = lazyChunk(() => import("@/pages/usip/Calendar"));
const Leads = lazyChunk(() => import("@/pages/usip/Leads"));
const Prospects = lazyChunk(() => import("@/pages/usip/Prospects"));
const People = lazyChunk(() => import("@/pages/usip/People"));
const Companies = lazyChunk(() => import("@/pages/usip/Companies"));
const CompanyProfile = lazyChunk(() => import("@/pages/usip/CompanyProfile"));
const AIAssistant = lazyChunk(() => import("@/pages/usip/AIAssistant"));
const Deliverability = lazyChunk(() => import("@/pages/usip/Deliverability"));
const Calls = lazyChunk(() => import("@/pages/usip/Calls"));
const WebsiteVisitors = lazyChunk(() => import("@/pages/usip/WebsiteVisitors"));
const Lists = lazyChunk(() => import("@/pages/usip/Lists"));
const ListDetail = lazyChunk(() => import("@/pages/usip/ListDetail"));
const DataEnrichment = lazyChunk(() => import("@/pages/usip/DataEnrichment"));
const LinkedInEnrichmentImport = lazyChunk(() => import("@/pages/usip/LinkedInEnrichmentImport"));
const SequencesV2 = lazyChunk(() => import("@/pages/usip/SequencesV2"));
const SequenceEditor = lazyChunk(() => import("@/pages/usip/SequenceEditor"));
const Home = lazyChunk(() => import("@/pages/usip/Home"));
const Library = lazyChunk(() => import("@/pages/usip/Library"));
const ProspectDetail = lazyChunk(() => import("@/pages/usip/ProspectDetail"));
const LeadDetail = lazyChunk(() => import("@/pages/usip/LeadDetail"));
const OpportunityDetail = lazyChunk(() => import("@/pages/usip/OpportunityDetail"));
const SettingsPipelines = lazyChunk(() => import("@/pages/usip/SettingsPipelines"));
const LinkedInLimits = lazyChunk(() => import("@/pages/usip/LinkedInLimits"));
const Forecast = lazyChunk(() => import("@/pages/usip/Forecast"));
const FindProspects = lazyChunk(() => import("@/pages/usip/FindProspects"));
const Pipeline = lazyChunk(() => import("@/pages/usip/Pipeline"));
const Products = lazyChunk(() => import("@/pages/usip/Products"));
const QBRs = lazyChunk(() => import("@/pages/usip/QBRs"));
const Quotes = lazyChunk(() => import("@/pages/usip/Quotes"));
const Renewals = lazyChunk(() => import("@/pages/usip/Renewals"));
const SCIM = lazyChunk(() => import("@/pages/usip/SCIM"));
const Sequences = lazyChunk(() => import("@/pages/usip/Sequences"));
const Settings = lazyChunk(() => import("@/pages/usip/Settings"));
const SettingsHub = lazyChunk(() => import("@/pages/usip/SettingsHub"));
const Social = lazyChunk(() => import("@/pages/usip/Social"));
const Tasks = lazyChunk(() => import("@/pages/usip/Tasks"));
const TasksV2 = lazyChunk(() => import("@/pages/usip/TasksV2"));
const MeetingsV2 = lazyChunk(() => import("@/pages/usip/MeetingsV2"));
const ConversationsV2 = lazyChunk(() => import("@/pages/usip/ConversationsV2"));
const DealsV2 = lazyChunk(() => import("@/pages/usip/DealsV2"));
const WorkflowsV2 = lazyChunk(() => import("@/pages/usip/WorkflowsV2"));
const AnalyticsV2 = lazyChunk(() => import("@/pages/usip/AnalyticsV2"));
const EmailsV2 = lazyChunk(() => import("@/pages/usip/EmailsV2"));
const SavedRedirect = lazyChunk(() => import("@/pages/usip/SavedRedirect"));
const FormsV2 = lazyChunk(() => import("@/pages/usip/FormsV2"));
const PublicForm = lazyChunk(() => import("@/pages/PublicForm"));
const BookingPage = lazyChunk(() => import("@/pages/BookingPage"));
const MeetingPickPage = lazyChunk(() => import("@/pages/MeetingPickPage"));
const LandingPage = lazyChunk(() => import("@/pages/LandingPage"));
const ResetPassword = lazyChunk(() => import("@/pages/ResetPassword"));
const LandingPages = lazyChunk(() => import("@/pages/usip/LandingPages"));
const ChatPage = lazyChunk(() => import("@/pages/ChatPage"));
const ChatAgents = lazyChunk(() => import("@/pages/usip/ChatAgents"));
const Team = lazyChunk(() => import("@/pages/usip/Team"));
const Territories = lazyChunk(() => import("@/pages/usip/Territories"));
const Workflows = lazyChunk(() => import("@/pages/usip/Workflows"));
const NotificationPrefs = lazyChunk(() => import("@/pages/usip/NotificationPrefs"));
const LeadScoring = lazyChunk(() => import("@/pages/usip/LeadScoring"));
const LeadRouting = lazyChunk(() => import("@/pages/usip/LeadRouting"));
const SequenceCanvas = lazyChunk(() => import("@/pages/usip/SequenceCanvas"));
const ResearchPipeline = lazyChunk(() => import("@/pages/usip/ResearchPipeline"));
const Quota = lazyChunk(() => import("@/pages/usip/Quota"));
const CustomFields = lazyChunk(() => import("@/pages/usip/CustomFields"));
const EmailBuilder = lazyChunk(() => import("@/pages/usip/EmailBuilder"));
const Snippets = lazyChunk(() => import("@/pages/usip/Snippets"));
const BrandVoice = lazyChunk(() => import("@/pages/usip/BrandVoice"));
const Personas = lazyChunk(() => import("@/pages/usip/Personas"));
const ResearchHome = lazyChunk(() => import("@/pages/usip/research/ResearchHome"));
const ResearchMarket = lazyChunk(() => import("@/pages/usip/research/ResearchMarket"));
const ResearchSector = lazyChunk(() => import("@/pages/usip/research/ResearchSector"));
const ResearchRun = lazyChunk(() => import("@/pages/usip/research/ResearchRun"));
const ResearchReport = lazyChunk(() => import("@/pages/usip/research/ResearchReport"));
const ResearchSectorReport = lazyChunk(() => import("@/pages/usip/research/ResearchSectorReport"));
const PromptTemplates = lazyChunk(() => import("@/pages/usip/PromptTemplates"));
const ImportContacts = lazyChunk(() => import("@/pages/usip/ImportContacts"));
const DataHealth = lazyChunk(() => import("@/pages/usip/DataHealth"));
const Segments = lazyChunk(() => import("@/pages/usip/Segments"));
const PipelineAlerts = lazyChunk(() => import("@/pages/usip/PipelineAlerts"));
const SegmentRules = lazyChunk(() => import("@/pages/usip/SegmentRules"));
const ConnectedAccounts = lazyChunk(() => import("@/pages/usip/ConnectedAccounts"));
const UnifiedInbox = lazyChunk(() => import("@/pages/usip/UnifiedInbox"));
const InviteAccept = lazyChunk(() => import("@/pages/InviteAccept"));
const JoinViaLink = lazyChunk(() => import("@/pages/JoinViaLink"));
const Proposals = lazyChunk(() => import("@/pages/usip/Proposals"));
const ProposalDetail = lazyChunk(() => import("@/pages/usip/ProposalDetail"));
const ProposalPortal = lazyChunk(() => import("@/pages/ProposalPortal"));
const AREHub = lazyChunk(() => import("@/pages/usip/AREHub"));
const AREPerformance = lazyChunk(() => import("@/pages/usip/AREPerformance"));
const AREIcpAgent = lazyChunk(() => import("@/pages/usip/AREIcpAgent"));
const ARECampaigns = lazyChunk(() => import("@/pages/usip/ARECampaigns"));
const ARECampaignDetail = lazyChunk(() => import("@/pages/usip/ARECampaignDetail"));
const ARESettings = lazyChunk(() => import("@/pages/usip/ARESettings"));
const HelpCenter = lazyChunk(() => import("@/pages/usip/HelpCenter"));
const HelpArticle = lazyChunk(() => import("@/pages/usip/HelpArticle"));
const TourBuilder = lazyChunk(() => import("@/pages/usip/TourBuilder"));
const Mindmaps = lazyChunk(() => import("@/pages/usip/Mindmaps"));
const MindmapCanvas = lazyChunk(() => import("@/pages/usip/MindmapCanvas"));

const INVITE_RETURN_KEY = "usip_invite_return";

function Landing() {
  const params = new URLSearchParams(window.location.search);
  // Sanitised at the READ, not at the use: this value reaches
  // `window.location.href` below as the fallback when the server sends no
  // redirect, and `//evil.com` starts with "/". See @shared/returnPath.
  const returnPath = safeReturnPath(params.get("returnPath"));

  const [mode, setMode] = useState<"signin" | "signup" | "forgot">("signin");
  /** Forgot-password confirmation. Deliberately shown for ANY address — see below. */
  const [resetSent, setResetSent] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // MFA step: revealed after the server accepts the password but requires the
  // authenticator code (mfaRequired in the 401). TOTP/authenticator app only —
  // there is deliberately no SMS/text option.
  const [mfaStep, setMfaStep] = useState(false);
  const [totpCode, setTotpCode] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    // ── Forgot password ────────────────────────────────────────────────────
    // The server answers `{ ok: true }` for every address, known or not, so
    // this confirmation must be shown unconditionally too. Rendering "no such
    // account" here would leak exactly what the login handler's constant-time
    // compare exists to hide.
    if (mode === "forgot") {
      if (!email.trim()) {
        setError("Please enter your email address.");
        return;
      }
      setLoading(true);
      try {
        await fetch("/api/auth/forgot-password", {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ email: email.trim().toLowerCase() }),
          credentials: "include",
        });
        setResetSent(true);
      } catch {
        setError("Network error. Please check your connection and try again.");
      } finally {
        setLoading(false);
      }
      return;
    }

    if (!email.trim() || !password) {
      setError("Please enter your email and password.");
      return;
    }
    if (mode === "signup" && password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    if (mode === "signin" && mfaStep && !totpCode.trim()) {
      setError("Enter the 6-digit code from your authenticator app.");
      return;
    }
    setLoading(true);
    try {
      const endpoint = mode === "signup" ? "/api/auth/register" : "/api/auth/password-login";
      const body: Record<string, string> = {
        email: email.trim().toLowerCase(),
        password,
        returnPath,
      };
      if (mode === "signup" && name.trim()) body.name = name.trim();
      if (mfaStep && totpCode.trim()) body.totpCode = totpCode.trim();

      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(body),
        credentials: "include",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        // MFA-enabled account: the first mfaRequired 401 means the password was
        // accepted and the server now wants the authenticator code — reveal the
        // code field. A second mfaRequired means the code was wrong.
        if (data.mfaRequired) {
          if (!mfaStep) setMfaStep(true);
          else setError(data.error ?? "That authentication code didn't match — try again.");
          return;
        }
        setError(
          data.error ?? (mode === "signup" ? "Sign-up failed. Please try again." : "Login failed. Please try again."),
        );
        return;
      }
      // The server already sanitises `redirect`; re-checked here because this
      // is the sink, and a sink that trusts its caller is one refactor from
      // trusting the query string again.
      window.location.href = safeReturnPath(data.redirect ?? returnPath);
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
            <svg className="size-6 text-[#60A5FA] shrink-0" viewBox="0 0 24 24" fill="currentColor"><path d="M13 2L4.09 12.97 12 12l-1 9 8.91-10.97L12 11l1-9z"/></svg>
            <span className="text-3xl font-bold tracking-tight text-white">Velocity</span>
          </div>
          <p className="text-[#A5B4FC] text-sm tracking-wide">The Unified Revenue Intelligence Platform</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {mode === "signup" && (
            <div className="space-y-2">
              <Label htmlFor="signup-name" className="text-white/80">Name</Label>
              <Input
                id="signup-name"
                type="text"
                placeholder="Your name"
                value={name}
                onChange={(e) => { setName(e.target.value); setError(null); }}
                autoComplete="name"
                className="bg-white/10 border-white/20 text-white placeholder:text-white/30 focus:border-[#14B89A]"
                disabled={loading}
              />
            </div>
          )}
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
          {mode !== "forgot" && (
          <div className="space-y-2">
            <Label htmlFor="login-password" className="text-white/80">Password</Label>
            <div className="relative">
              <Input
                id="login-password"
                type={showPassword ? "text" : "password"}
                placeholder={mode === "signup" ? "At least 8 characters" : "Your password"}
                value={password}
                onChange={(e) => { setPassword(e.target.value); setError(null); }}
                autoComplete={mode === "signup" ? "new-password" : "current-password"}
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
            {mode === "signin" && !mfaStep && (
              <div className="text-right">
                <button
                  type="button"
                  className="text-xs text-white/50 hover:text-[#14B89A] hover:underline"
                  onClick={() => { setMode("forgot"); setError(null); setResetSent(false); setPassword(""); }}
                >
                  Forgot password?
                </button>
              </div>
            )}
          </div>
          )}
          {mode === "forgot" && !resetSent && (
            <p className="text-xs text-white/50">
              Enter your email and we'll send a link to choose a new password. The link works once and expires in an hour.
            </p>
          )}
          {mode === "forgot" && resetSent && (
            <p className="text-sm text-white/80 bg-[#14B89A]/10 border border-[#14B89A]/30 rounded-md px-3 py-2">
              If an account exists for <strong>{email.trim().toLowerCase()}</strong>, a reset link is on its way. Check your inbox and spam folder.
            </p>
          )}
          {mode === "signin" && mfaStep && (
            <div className="space-y-2">
              <Label htmlFor="login-totp" className="text-white/80">Authentication code</Label>
              <Input
                id="login-totp"
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="6-digit code"
                value={totpCode}
                onChange={(e) => { setTotpCode(e.target.value.replace(/[^\d\s]/g, "")); setError(null); }}
                className="bg-white/10 border-white/20 text-white placeholder:text-white/30 focus:border-[#14B89A] tracking-widest"
                disabled={loading}
                autoFocus
              />
              <p className="text-xs text-white/40">Open your authenticator app and enter the current code.</p>
            </div>
          )}
          {error && (
            <p className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-md px-3 py-2">
              {error}
            </p>
          )}
          {!(mode === "forgot" && resetSent) && (
          <Button
            type="submit"
            className="w-full bg-[#14B89A] hover:bg-[#0FA086] text-black font-semibold"
            disabled={loading}
          >
            {loading ? (
              <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> {mode === "signup" ? "Creating account…" : mode === "forgot" ? "Sending…" : mfaStep ? "Verifying…" : "Signing in…"}</>
            ) : (
              <><LogIn className="mr-2 h-4 w-4" /> {mode === "signup" ? "Create account" : mode === "forgot" ? "Send reset link" : mfaStep ? "Verify code" : "Sign in"}</>
            )}
          </Button>
          )}
        </form>

        <p className="text-sm text-white/60 text-center">
          {mode === "forgot" ? (
            <>
              Remembered it?{" "}
              <button
                type="button"
                className="text-[#14B89A] hover:underline font-medium"
                onClick={() => { setMode("signin"); setError(null); setResetSent(false); }}
              >
                Back to sign in
              </button>
            </>
          ) : mode === "signin" ? (
            <>
              Don't have an account?{" "}
              <button
                type="button"
                className="text-[#14B89A] hover:underline font-medium"
                onClick={() => { setMode("signup"); setError(null); setMfaStep(false); setTotpCode(""); }}
              >
                Create one
              </button>
            </>
          ) : (
            <>
              Already have an account?{" "}
              <button
                type="button"
                className="text-[#14B89A] hover:underline font-medium"
                onClick={() => { setMode("signin"); setError(null); setMfaStep(false); setTotpCode(""); }}
              >
                Sign in
              </button>
            </>
          )}
        </p>
      </div>
    </div>
  );
}

function InviteReturnRedirect() {
  const [, navigate] = useLocation();
  const { user, loading } = useAuth();
  useEffect(() => {
    if (!loading && user) {
      const returnPath = sessionStorage.getItem(INVITE_RETURN_KEY);
      if (returnPath && returnPath.startsWith("/invite/accept")) {
        sessionStorage.removeItem(INVITE_RETURN_KEY);
        navigate(returnPath);
      }
    }
  }, [loading, user, navigate]);
  return null;
}

function AuthGate({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <PageLoading />;
  if (!user) return <Landing />;
  // WorkspaceBrandingSync sits here, not in Shell — the settings hub renders
  // without Shell, so brand colours would otherwise never reach it.
  return <WorkspaceProvider><InviteReturnRedirect /><WorkspaceBrandingSync />{children}</WorkspaceProvider>;
}

function PageLoading() {
  return <div className="min-h-screen flex items-center justify-center"><Loader2 className="size-6 animate-spin text-muted-foreground" /></div>;
}

function Router() {
  return (
    <Suspense fallback={<PageLoading />}>
    <Switch>
      <Route path="/"><AuthGate><Dashboard /></AuthGate></Route>
      <Route path="/dashboard"><AuthGate><Dashboard /></AuthGate></Route>
      <Route path="/inbox"><AuthGate><Inbox /></AuthGate></Route>
      <Route path="/mailbox"><AuthGate><Mailbox /></AuthGate></Route>
      <Route path="/calendar"><AuthGate><CalendarPage /></AuthGate></Route>
      <Route path="/leads"><AuthGate><Leads /></AuthGate></Route>
      <Route path="/prospects"><AuthGate><Prospects /></AuthGate></Route>
      <Route path="/prospects/:id"><AuthGate><ProspectDetail /></AuthGate></Route>
      <Route path="/find-prospects"><AuthGate><FindProspects /></AuthGate></Route>
      {/* Retired 2026-08-17 (owner: one location for every person record).
          Both routes resolve to People — /contacts/:id lands on the contact's
          linked PERSON so old deep links keep working. See ContactRedirect. */}
      <Route path="/contacts"><AuthGate><ContactRedirect /></AuthGate></Route>
      <Route path="/contacts/:id"><AuthGate><ContactRedirect /></AuthGate></Route>
      {/* The legacy Accounts list and AccountDetail page were a second company
          surface over the same rows Companies / CompanyProfile render.
          Retired in phase 5 (2026-09-02); ids are preserved in the redirect. */}
      <Route path="/accounts"><AuthGate><AccountRedirect /></AuthGate></Route>
      <Route path="/accounts/:id"><AuthGate><AccountRedirect /></AuthGate></Route>
      <Route path="/leads/:id"><AuthGate><LeadDetail /></AuthGate></Route>
      <Route path="/opportunities/:id"><AuthGate><OpportunityDetail /></AuthGate></Route>
      <Route path="/pipeline"><AuthGate><Pipeline /></AuthGate></Route>
      <Route path="/settings/pipelines"><AuthGate><SettingsPipelines /></AuthGate></Route>
      <Route path="/settings/linkedin-limits"><AuthGate><LinkedInLimits /></AuthGate></Route>
      <Route path="/forecast"><AuthGate><Forecast /></AuthGate></Route>
      <Route path="/sequences"><AuthGate><Sequences /></AuthGate></Route>
      <Route path="/sequences/:id/canvas"><AuthGate><SequenceCanvas /></AuthGate></Route>
      <Route path="/email-analytics"><AuthGate><EmailAnalytics /></AuthGate></Route>
      <Route path="/email-suppressions"><AuthGate><EmailSuppressions /></AuthGate></Route>
      <Route path="/sending-accounts"><AuthGate><SendingAccounts /></AuthGate></Route>
      <Route path="/sender-pools"><AuthGate><SenderPools /></AuthGate></Route>
      <Route path="/social"><AuthGate><Social /></AuthGate></Route>
      <Route path="/campaigns"><AuthGate><Campaigns /></AuthGate></Route>
      <Route path="/customers"><AuthGate><Customers /></AuthGate></Route>
      <Route path="/renewals"><AuthGate><Renewals /></AuthGate></Route>
      <Route path="/qbrs"><AuthGate><QBRs /></AuthGate></Route>
      <Route path="/tasks"><AuthGate><Tasks /></AuthGate></Route>
      <Route path="/workflows"><AuthGate><Workflows /></AuthGate></Route>
      <Route path="/dashboards"><AuthGate><Dashboards /></AuthGate></Route>
      <Route path="/reports"><AuthGate><Reports /></AuthGate></Route>
      <Route path="/dashboard-home2"><AuthGate><DashboardHome2 /></AuthGate></Route>
      <Route path="/products"><AuthGate><Products /></AuthGate></Route>
      <Route path="/quotes"><AuthGate><Quotes /></AuthGate></Route>
      <Route path="/territories"><AuthGate><Territories /></AuthGate></Route>
      <Route path="/team"><AuthGate><Team /></AuthGate></Route>
      <Route path="/audit"><AuthGate><Audit /></AuthGate></Route>
      <Route path="/scim"><AuthGate><SCIM /></AuthGate></Route>
      <Route path="/lead-scoring"><AuthGate><LeadScoring /></AuthGate></Route>
      <Route path="/lead-routing"><AuthGate><LeadRouting /></AuthGate></Route>
      <Route path="/research-pipeline"><AuthGate><ResearchPipeline /></AuthGate></Route>
      <Route path="/pipeline-alerts"><AuthGate><PipelineAlerts /></AuthGate></Route>
      <Route path="/quota"><AuthGate><Quota /></AuthGate></Route>
      <Route path="/custom-fields"><AuthGate><CustomFields /></AuthGate></Route>
      <Route path="/email-builder"><AuthGate><EmailBuilder /></AuthGate></Route>
      <Route path="/email-builder/:id"><AuthGate><EmailBuilder /></AuthGate></Route>
      <Route path="/snippets"><AuthGate><Snippets /></AuthGate></Route>
      <Route path="/brand-voice"><AuthGate><BrandVoice /></AuthGate></Route>
      <Route path="/personas"><AuthGate><Personas /></AuthGate></Route>
      {/* Research (phase 1, 2026-10-14): markets, then sectors. */}
      <Route path="/research"><AuthGate><ResearchHome /></AuthGate></Route>
      <Route path="/research/markets/:id/report/:section"><AuthGate><ResearchReport /></AuthGate></Route>
      <Route path="/research/markets/:id/report"><AuthGate><ResearchReport /></AuthGate></Route>
      <Route path="/research/sectors/:id/report"><AuthGate><ResearchSectorReport /></AuthGate></Route>
      <Route path="/research/markets/:id"><AuthGate><ResearchMarket /></AuthGate></Route>
      <Route path="/research/sectors/:id"><AuthGate><ResearchSector /></AuthGate></Route>
      <Route path="/research/runs/:id"><AuthGate><ResearchRun /></AuthGate></Route>
      <Route path="/prompt-templates"><AuthGate><PromptTemplates /></AuthGate></Route>
      <Route path="/import"><AuthGate><ImportContacts /></AuthGate></Route>
      <Route path="/connected-accounts"><AuthGate><ConnectedAccounts /></AuthGate></Route>
      <Route path="/unified-inbox"><AuthGate><UnifiedInbox /></AuthGate></Route>
      <Route path="/data-health"><AuthGate><DataHealth /></AuthGate></Route>
      <Route path="/segments"><AuthGate><Segments /></AuthGate></Route>
      <Route path="/segments/:id"><AuthGate><Segments /></AuthGate></Route>
      <Route path="/segment-rules"><AuthGate><SegmentRules /></AuthGate></Route>
      <Route path="/settings"><AuthGate><Settings /></AuthGate></Route>
      <Route path="/v2/settings/:section?"><AuthGate><SettingsHub /></AuthGate></Route>
      <Route path="/notification-prefs"><AuthGate><NotificationPrefs /></AuthGate></Route>
      <Route path="/proposals"><AuthGate><Proposals /></AuthGate></Route>
      <Route path="/proposals/:id"><AuthGate><ProposalDetail /></AuthGate></Route>
      <Route path="/are"><AuthGate><AREHub /></AuthGate></Route>
      <Route path="/are/performance"><AuthGate><AREPerformance /></AuthGate></Route>
      <Route path="/are/icp"><AuthGate><AREIcpAgent /></AuthGate></Route>
      <Route path="/are/campaigns"><AuthGate><ARECampaigns /></AuthGate></Route>
      <Route path="/are/campaigns/:id"><AuthGate><ARECampaignDetail /></AuthGate></Route>
      <Route path="/are/settings"><AuthGate><ARESettings /></AuthGate></Route>
      <Route path="/p/:token"><ProposalPortal /></Route>
      <Route path="/invite/accept"><InviteAccept /></Route>
      <Route path="/join"><JoinViaLink /></Route>

      {/*
        Redesigned sidebar — new IA routes.
        Bespoke new pages we're actively building (kept):
          People, Companies, AI Assistant, Deliverability suite, Calls,
          Website visitors.
        The remaining items are intentionally NOT linked to the existing pages
        yet — they render placeholders so the new pages can be built fresh. The
        existing, fully-working pages stay reachable via the "More" section
        (Segments, Data Health, Sequences, Mailbox, Tasks, Calendar, Unified
        Inbox, Pipeline, Workflows, Dashboards, Contacts, Accounts).
      */}
      <Route path="/v2/home"><AuthGate><Home /></AuthGate></Route>
      <Route path="/v2/library"><AuthGate><Library /></AuthGate></Route>
      <Route path="/v2/ai-assistant"><AuthGate><AIAssistant /></AuthGate></Route>
      <Route path="/v2/people"><AuthGate><People /></AuthGate></Route>
      <Route path="/v2/companies/:id"><AuthGate><CompanyProfile /></AuthGate></Route>
      <Route path="/v2/companies"><AuthGate><Companies /></AuthGate></Route>
      <Route path="/v2/lists/:id"><AuthGate><ListDetail /></AuthGate></Route>
      <Route path="/v2/lists"><AuthGate><Lists /></AuthGate></Route>
      <Route path="/v2/data-enrichment/linkedin"><AuthGate><LinkedInEnrichmentImport /></AuthGate></Route>
      <Route path="/v2/data-enrichment"><AuthGate><DataEnrichment /></AuthGate></Route>
      <Route path="/v2/sequences/:id"><AuthGate><SequenceEditor /></AuthGate></Route>
      <Route path="/v2/sequences"><AuthGate><SequencesV2 /></AuthGate></Route>
      <Route path="/v2/emails"><AuthGate><EmailsV2 /></AuthGate></Route>
      <Route path="/v2/calls"><AuthGate><Calls /></AuthGate></Route>
      <Route path="/v2/tasks"><AuthGate><TasksV2 /></AuthGate></Route>
      <Route path="/v2/meetings"><AuthGate><MeetingsV2 /></AuthGate></Route>
      <Route path="/v2/conversations"><AuthGate><ConversationsV2 /></AuthGate></Route>
      <Route path="/v2/deals"><AuthGate><DealsV2 /></AuthGate></Route>
      <Route path="/v2/workflows"><AuthGate><WorkflowsV2 /></AuthGate></Route>
      <Route path="/v2/analytics"><AuthGate><AnalyticsV2 /></AuthGate></Route>
      <Route path="/v2/website-visitors"><AuthGate><WebsiteVisitors /></AuthGate></Route>
      <Route path="/v2/forms"><AuthGate><FormsV2 /></AuthGate></Route>
      <Route path="/f/:publicId"><PublicForm /></Route>
      <Route path="/b/:slug"><BookingPage /></Route>
      {/* A proposal email's time links (2026-10-06): public, books only on Confirm. */}
      <Route path="/m/:token"><MeetingPickPage /></Route>
      <Route path="/l/:slug"><LandingPage /></Route>
      {/* PUBLIC by necessity — the visitor cannot sign in, that is why they
          are here. No AuthGate. */}
      <Route path="/reset-password"><ResetPassword /></Route>
      <Route path="/c/:slug"><ChatPage /></Route>
      <Route path="/v2/landing-pages"><AuthGate><LandingPages /></AuthGate></Route>
      <Route path="/v2/chat"><AuthGate><ChatAgents /></AuthGate></Route>
      {/* Saved People / Companies were Lists filtered by type — folded into Lists (phase 4, 2026-09-02); the type survives the redirect. */}
      <Route path="/v2/saved-people"><AuthGate><SavedRedirect entityType="people" /></AuthGate></Route>
      <Route path="/v2/saved-companies"><AuthGate><SavedRedirect entityType="companies" /></AuthGate></Route>
      <Route path="/v2/deliverability"><AuthGate><Deliverability /></AuthGate></Route>
      <Route path="/help"><AuthGate><HelpCenter /></AuthGate></Route>
      {/* Article cards in the Help Center have always linked here; the route
          was never registered, so all 39 articles 404'd. */}
      <Route path="/help/articles/:slug"><AuthGate><HelpArticle /></AuthGate></Route>
      <Route path="/tour-builder"><AuthGate><TourBuilder /></AuthGate></Route>
      <Route path="/mindmaps"><AuthGate><Mindmaps /></AuthGate></Route>
      <Route path="/mindmaps/:id"><AuthGate><MindmapCanvas /></AuthGate></Route>
      <Route path="/404"><NotFound /></Route>
      <Route><NotFound /></Route>
    </Switch>
    </Suspense>
  );
}

function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider defaultTheme="light" switchable={true}>
        {/* One provider for the whole app so Radix can share hover state.
            delayDuration: a tooltip that fires on every glance is a strobe;
            lingering is the "I'm not sure" signal worth answering.
            skipDelayDuration: once one HAS opened, the next shows instantly —
            which is what makes scanning down the sidebar to learn the app feel
            fluid instead of making you wait at every single item.
            Components needing instant tooltips (the collapsed icon rail) still
            declare their own nested provider and override this. */}
        <TooltipProvider delayDuration={300} skipDelayDuration={400}>
          <TourEngineProvider>
            {/* Backs useConfirm() — the in-app replacement for native confirm() */}
            <ConfirmProvider>
              <Toaster />
              <Router />
              {/* Inside TourEngineProvider — Elsie hands tours to it. */}
              <ElsieController />
            </ConfirmProvider>
          </TourEngineProvider>
        </TooltipProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;
