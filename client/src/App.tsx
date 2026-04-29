import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { WorkspaceProvider } from "@/contexts/WorkspaceContext";
import NotFound from "@/pages/NotFound";
import Accounts from "@/pages/usip/Accounts";
import Audit from "@/pages/usip/Audit";
import Campaigns from "@/pages/usip/Campaigns";
import Contacts from "@/pages/usip/Contacts";
import Customers from "@/pages/usip/Customers";
import Dashboard from "@/pages/usip/Dashboard";
import DashboardHome2 from "@/pages/usip/DashboardHome2";
import Dashboards from "@/pages/usip/Dashboards";
import EmailDrafts from "@/pages/usip/EmailDrafts";
import EmailAnalytics from "@/pages/usip/EmailAnalytics";
import { EmailSuppressions } from "@/pages/usip/EmailSuppressions";
import SendingAccounts from "@/pages/usip/SendingAccounts";
import SenderPools from "@/pages/usip/SenderPools";
import Inbox from "@/pages/usip/Inbox";
import Mailbox from "@/pages/usip/Mailbox";
import CalendarPage from "@/pages/usip/Calendar";
import Leads from "@/pages/usip/Leads";
import Prospects from "@/pages/usip/Prospects";
import Pipeline from "@/pages/usip/Pipeline";
import Products from "@/pages/usip/Products";
import QBRs from "@/pages/usip/QBRs";
import Quotes from "@/pages/usip/Quotes";
import Renewals from "@/pages/usip/Renewals";
import SCIM from "@/pages/usip/SCIM";
import Sequences from "@/pages/usip/Sequences";
import Settings from "@/pages/usip/Settings";
import Social from "@/pages/usip/Social";
import Tasks from "@/pages/usip/Tasks";
import Team from "@/pages/usip/Team";
import Territories from "@/pages/usip/Territories";
import Workflows from "@/pages/usip/Workflows";
import NotificationPrefs from "@/pages/usip/NotificationPrefs";
import LeadScoring from "@/pages/usip/LeadScoring";
import LeadRouting from "@/pages/usip/LeadRouting";
import SequenceCanvas from "@/pages/usip/SequenceCanvas";
import ResearchPipeline from "@/pages/usip/ResearchPipeline";
import Quota from "@/pages/usip/Quota";
import CustomFields from "@/pages/usip/CustomFields";
import EmailBuilder from "@/pages/usip/EmailBuilder";
import Snippets from "@/pages/usip/Snippets";
import BrandVoice from "@/pages/usip/BrandVoice";
import PromptTemplates from "@/pages/usip/PromptTemplates";
import ImportContacts from "@/pages/usip/ImportContacts";
import MyLinkedIn from "@/pages/usip/MyLinkedIn";
import DataHealth from "@/pages/usip/DataHealth";
import Segments from "@/pages/usip/Segments";
import AIPipelineQueue from "@/pages/usip/AIPipelineQueue";
import PipelineAlerts from "@/pages/usip/PipelineAlerts";
import SegmentRules from "@/pages/usip/SegmentRules";
import ConnectedAccounts from "@/pages/usip/ConnectedAccounts";
import UnifiedInbox from "@/pages/usip/UnifiedInbox";
import InviteAccept from "@/pages/InviteAccept";
import Proposals from "@/pages/usip/Proposals";
import ProposalDetail from "@/pages/usip/ProposalDetail";
import ProposalPortal from "@/pages/ProposalPortal";
import AREHub from "@/pages/usip/AREHub";
import AREIcpAgent from "@/pages/usip/AREIcpAgent";
import ARECampaigns from "@/pages/usip/ARECampaigns";
import ARECampaignDetail from "@/pages/usip/ARECampaignDetail";
import ARESettings from "@/pages/usip/ARESettings";
import HelpCenter from "@/pages/usip/HelpCenter";
import TourBuilder from "@/pages/usip/TourBuilder";
import { HelpButton } from "@/components/usip/HelpDrawer";
import { TourEngineProvider } from "@/components/usip/TourEngine";
import { Loader2, Eye, EyeOff, LogIn } from "lucide-react";
import { Route, Switch, useLocation } from "wouter";
import { useEffect, useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";

const INVITE_RETURN_KEY = "usip_invite_return";

function Landing() {
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
      window.location.href = data.redirect ?? returnPath;
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
  if (loading) return <div className="min-h-screen flex items-center justify-center"><Loader2 className="size-6 animate-spin text-muted-foreground" /></div>;
  if (!user) return <Landing />;
  return <WorkspaceProvider><InviteReturnRedirect />{children}</WorkspaceProvider>;
}

function Router() {
  return (
    <Switch>
      <Route path="/"><AuthGate><Dashboard /></AuthGate></Route>
      <Route path="/dashboard"><AuthGate><Dashboard /></AuthGate></Route>
      <Route path="/inbox"><AuthGate><Inbox /></AuthGate></Route>
      <Route path="/mailbox"><AuthGate><Mailbox /></AuthGate></Route>
      <Route path="/calendar"><AuthGate><CalendarPage /></AuthGate></Route>
      <Route path="/leads"><AuthGate><Leads /></AuthGate></Route>
      <Route path="/prospects"><AuthGate><Prospects /></AuthGate></Route>
      <Route path="/contacts"><AuthGate><Contacts /></AuthGate></Route>
      <Route path="/accounts"><AuthGate><Accounts /></AuthGate></Route>
      <Route path="/pipeline"><AuthGate><Pipeline /></AuthGate></Route>
      <Route path="/sequences"><AuthGate><Sequences /></AuthGate></Route>
      <Route path="/sequences/:id/canvas"><AuthGate><SequenceCanvas /></AuthGate></Route>
      <Route path="/email-drafts"><AuthGate><EmailDrafts /></AuthGate></Route>
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
      <Route path="/ai-pipeline"><AuthGate><AIPipelineQueue /></AuthGate></Route>
      <Route path="/pipeline-alerts"><AuthGate><PipelineAlerts /></AuthGate></Route>
      <Route path="/quota"><AuthGate><Quota /></AuthGate></Route>
      <Route path="/custom-fields"><AuthGate><CustomFields /></AuthGate></Route>
      <Route path="/email-builder"><AuthGate><EmailBuilder /></AuthGate></Route>
      <Route path="/email-builder/:id"><AuthGate><EmailBuilder /></AuthGate></Route>
      <Route path="/snippets"><AuthGate><Snippets /></AuthGate></Route>
      <Route path="/brand-voice"><AuthGate><BrandVoice /></AuthGate></Route>
      <Route path="/prompt-templates"><AuthGate><PromptTemplates /></AuthGate></Route>
      <Route path="/import"><AuthGate><ImportContacts /></AuthGate></Route>
      <Route path="/my-linkedin"><AuthGate><MyLinkedIn /></AuthGate></Route>
      <Route path="/connected-accounts"><AuthGate><ConnectedAccounts /></AuthGate></Route>
      <Route path="/unified-inbox"><AuthGate><UnifiedInbox /></AuthGate></Route>
      <Route path="/data-health"><AuthGate><DataHealth /></AuthGate></Route>
      <Route path="/segments"><AuthGate><Segments /></AuthGate></Route>
      <Route path="/segments/:id"><AuthGate><Segments /></AuthGate></Route>
      <Route path="/segment-rules"><AuthGate><SegmentRules /></AuthGate></Route>
      <Route path="/settings"><AuthGate><Settings /></AuthGate></Route>
      <Route path="/notification-prefs"><AuthGate><NotificationPrefs /></AuthGate></Route>
      <Route path="/proposals"><AuthGate><Proposals /></AuthGate></Route>
      <Route path="/proposals/:id"><AuthGate><ProposalDetail /></AuthGate></Route>
      <Route path="/are"><AuthGate><AREHub /></AuthGate></Route>
      <Route path="/are/icp"><AuthGate><AREIcpAgent /></AuthGate></Route>
      <Route path="/are/campaigns"><AuthGate><ARECampaigns /></AuthGate></Route>
      <Route path="/are/campaigns/:id"><AuthGate><ARECampaignDetail /></AuthGate></Route>
      <Route path="/are/settings"><AuthGate><ARESettings /></AuthGate></Route>
      <Route path="/p/:token"><ProposalPortal /></Route>
      <Route path="/invite/accept"><InviteAccept /></Route>
      <Route path="/help"><AuthGate><HelpCenter /></AuthGate></Route>
      <Route path="/tour-builder"><AuthGate><TourBuilder /></AuthGate></Route>
      <Route path="/404"><NotFound /></Route>
      <Route><NotFound /></Route>
    </Switch>
  );
}

function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider defaultTheme="light" switchable={true}>
        <TooltipProvider>
          <TourEngineProvider>
            <Toaster />
            <Router />
            <HelpButton />
          </TourEngineProvider>
        </TooltipProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;
