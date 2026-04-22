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
import Dashboards from "@/pages/usip/Dashboards";
import EmailDrafts from "@/pages/usip/EmailDrafts";
import Inbox from "@/pages/usip/Inbox";
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
import { Loader2 } from "lucide-react";
import { Route, Switch } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";

function Landing() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-[#0F1F1B] text-[#FAF8F2] px-6">
      <div className="max-w-xl space-y-6">
        <div className="text-xs uppercase tracking-[0.2em] text-[#14B89A]">USIP</div>
        <h1 className="font-serif text-5xl leading-tight">Unified sales intelligence for the full revenue lifecycle.</h1>
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
      <Route path="/leads"><AuthGate><Leads /></AuthGate></Route>
      <Route path="/contacts"><AuthGate><Contacts /></AuthGate></Route>
      <Route path="/accounts"><AuthGate><Accounts /></AuthGate></Route>
      <Route path="/pipeline"><AuthGate><Pipeline /></AuthGate></Route>
      <Route path="/sequences"><AuthGate><Sequences /></AuthGate></Route>
      <Route path="/email-drafts"><AuthGate><EmailDrafts /></AuthGate></Route>
      <Route path="/social"><AuthGate><Social /></AuthGate></Route>
      <Route path="/campaigns"><AuthGate><Campaigns /></AuthGate></Route>
      <Route path="/customers"><AuthGate><Customers /></AuthGate></Route>
      <Route path="/renewals"><AuthGate><Renewals /></AuthGate></Route>
      <Route path="/qbrs"><AuthGate><QBRs /></AuthGate></Route>
      <Route path="/tasks"><AuthGate><Tasks /></AuthGate></Route>
      <Route path="/workflows"><AuthGate><Workflows /></AuthGate></Route>
      <Route path="/dashboards"><AuthGate><Dashboards /></AuthGate></Route>
      <Route path="/products"><AuthGate><Products /></AuthGate></Route>
      <Route path="/quotes"><AuthGate><Quotes /></AuthGate></Route>
      <Route path="/territories"><AuthGate><Territories /></AuthGate></Route>
      <Route path="/team"><AuthGate><Team /></AuthGate></Route>
      <Route path="/audit"><AuthGate><Audit /></AuthGate></Route>
      <Route path="/scim"><AuthGate><SCIM /></AuthGate></Route>
      <Route path="/settings"><AuthGate><Settings /></AuthGate></Route>
      <Route path="/404"><NotFound /></Route>
      <Route><NotFound /></Route>
    </Switch>
  );
}

function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider defaultTheme="light">
        <TooltipProvider>
          <Toaster />
          <Router />
        </TooltipProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;
