import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { getLoginUrl } from "@/const";
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
import { Loader2 } from "lucide-react";
import { Route, Switch } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";

function Landing() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-[#0F1F1B] text-[#FAF8F2] px-6">
      <div className="max-w-xl space-y-6">
        <div className="flex items-center gap-2 mb-1">
          <svg className="size-6 text-[#60A5FA] shrink-0" viewBox="0 0 24 24" fill="currentColor"><path d="M13 2L4.09 12.97 12 12l-1 9 8.91-10.97L12 11l1-9z"/></svg>
          <span className="text-3xl font-bold tracking-tight text-white">Velocity</span>
        </div>
        <p className="text-[#A5B4FC] text-sm tracking-wide">The Unified Revenue Intelligence Platform</p>
        <h1 className="font-serif text-4xl leading-tight">Full-lifecycle revenue intelligence, from first touch to renewal.</h1>
        <p className="text-[#FAF8F2]/70 text-sm leading-relaxed">CRM, sequences, customer success, social, campaigns, custom dashboards, workflow automation, and CPQ. Multi-workspace, role-aware, AI-native.</p>
        <Button onClick={() => (window.location.href = getLoginUrl())} className="bg-[#14B89A] hover:bg-[#0FA086] text-black">Sign in</Button>
        <p className="text-[#FAF8F2]/40 text-xs">A demo workspace is provisioned automatically on first sign-in.</p>
      </div>
    </div>
  );
}

function AuthGate({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="min-h-screen flex items-center justify-center"><Loader2 className="size-6 animate-spin text-muted-foreground" /></div>;
  if (!user) return <Landing />;
  return <WorkspaceProvider>{children}</WorkspaceProvider>;
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
      <Route path="/data-health"><AuthGate><DataHealth /></AuthGate></Route>
      <Route path="/segments"><AuthGate><Segments /></AuthGate></Route>
      <Route path="/segments/:id"><AuthGate><Segments /></AuthGate></Route>
      <Route path="/segment-rules"><AuthGate><SegmentRules /></AuthGate></Route>
      <Route path="/settings"><AuthGate><Settings /></AuthGate></Route>
      <Route path="/notification-prefs"><AuthGate><NotificationPrefs /></AuthGate></Route>
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
          <Toaster />
          <Router />
        </TooltipProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;
