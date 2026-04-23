import { Button } from "@/components/ui/button";
import { useAuth } from "@/_core/hooks/useAuth";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import {
  Activity,
  Bell,
  BookOpen,
  Building2,
  CalendarClock,
  Check,
  ChevronDown,
  ChevronsUpDown,
  ClipboardCheck,
  ClipboardList,
  Database,
  FileText,
  FlaskConical,
  Heart,
  Inbox,
  KanbanSquare,
  LayoutDashboard,
  LayoutTemplate,
  ListChecks,
  LogOut,
  Megaphone,
  Mic2,
  Network,
  Package,
  PieChart,
  Search,
  Settings,
  Share2,
  Sparkles,
  Target,
  Users,
  Menu,
  Workflow,
  X,
  Zap,
  Upload,
  Linkedin,
  BarChart3,
  Filter,
  AlertTriangle,
  Ban,
} from "lucide-react";
import { ReactNode, useEffect, useState } from "react";
import { Link, useLocation } from "wouter";

type NavItem = { href: string; label: string; icon: any };
type NavGroup = { label: string; items: NavItem[] };

const NAV: NavGroup[] = [
  {
    label: "Overview",
    items: [
      { href: "/", label: "Dashboard", icon: LayoutDashboard },
      { href: "/inbox", label: "Inbox", icon: Inbox },
    ],
  },
  {
    label: "Acquire",
    items: [
      { href: "/leads", label: "Leads", icon: Target },
      { href: "/contacts", label: "Contacts", icon: Users },
      { href: "/import", label: "Import Contacts", icon: Upload },
      { href: "/data-health", label: "Data Health", icon: BarChart3 },
      { href: "/accounts", label: "Accounts", icon: Building2 },
      { href: "/pipeline", label: "Pipeline", icon: KanbanSquare },
      { href: "/pipeline-alerts", label: "Pipeline Alerts", icon: AlertTriangle },
    ],
  },
  {
    label: "Engage",
    items: [
      { href: "/segments", label: "Segments", icon: Filter },
      { href: "/segment-rules", label: "Segment Auto-Enroll", icon: Zap },
      { href: "/sequences", label: "Sequences", icon: Activity },
      { href: "/email-drafts", label: "Email Drafts", icon: FileText },
      { href: "/email-analytics", label: "Email Analytics", icon: BarChart3 },
      { href: "/email-suppressions", label: "Opt-Out Management", icon: Ban },
      { href: "/email-builder", label: "Email Builder", icon: LayoutTemplate },
      { href: "/snippets", label: "Snippet Library", icon: BookOpen },
      { href: "/research-pipeline", label: "AI Research Pipeline", icon: Sparkles },
      { href: "/ai-pipeline", label: "AI Draft Queue", icon: Sparkles },
      { href: "/social", label: "Social", icon: Share2 },
      { href: "/campaigns", label: "Campaigns", icon: Megaphone },
    ],
  },
  {
    label: "Retain",
    items: [
      { href: "/customers", label: "Customers", icon: Heart },
      { href: "/renewals", label: "Renewals", icon: CalendarClock },
      { href: "/qbrs", label: "QBRs", icon: ClipboardCheck },
    ],
  },
  {
    label: "Operate",
    items: [
      { href: "/tasks", label: "Tasks", icon: ListChecks },
      { href: "/workflows", label: "Workflows", icon: Workflow },
      { href: "/dashboards", label: "Dashboards", icon: PieChart },
      { href: "/products", label: "Products", icon: Package },
      { href: "/quotes", label: "Quotes", icon: FileText },
      { href: "/territories", label: "Territories", icon: Network },
      { href: "/lead-routing", label: "Lead Routing", icon: Sparkles },
      { href: "/quota", label: "Quota Management", icon: Target },
    ],
  },
  {
    label: "Admin",
    items: [
      { href: "/team", label: "Team", icon: Users },
      { href: "/lead-scoring", label: "Lead Scoring", icon: Target },
      { href: "/custom-fields", label: "Custom Fields", icon: Database },
      { href: "/prompt-templates", label: "Prompt Templates", icon: FlaskConical },
      { href: "/brand-voice", label: "Brand Voice", icon: Mic2 },
      { href: "/audit", label: "Audit Log", icon: Database },
      { href: "/scim", label: "SCIM", icon: Zap },
      { href: "/my-linkedin", label: "My LinkedIn", icon: Linkedin },
      { href: "/settings", label: "Settings", icon: Settings },
    ],
  },
];

export function Shell({ children, title, actions }: { children: ReactNode; title?: string; actions?: ReactNode }) {
  const [location] = useLocation();
  const { user, logout } = useAuth();
  const { workspaces, current, switchTo, isLoading } = useWorkspace();
  const [wsOpen, setWsOpen] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const { data: unread } = trpc.notifications.unreadCount.useQuery(undefined, { enabled: !!current, refetchInterval: 30_000 });

  // close dropdowns/drawers on route change
  useEffect(() => {
    setWsOpen(false);
    setMobileOpen(false);
  }, [location]);

  return (
    <div className="min-h-screen flex bg-background text-foreground">
      {/* Mobile backdrop */}
      {mobileOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-40 md:hidden"
          onClick={() => setMobileOpen(false)}
          aria-hidden="true"
        />
      )}
      {/* Sidebar */}
      <aside className={cn(
        "w-60 shrink-0 bg-sidebar text-sidebar-foreground flex flex-col",
        "fixed inset-y-0 left-0 z-50 transform transition-transform duration-200 md:translate-x-0 md:static md:transform-none",
        mobileOpen ? "translate-x-0" : "-translate-x-full",
      )}>
        <div className="px-4 py-4 border-b border-white/10">
          <div className="bg-white rounded-md px-3 py-2 flex items-center justify-center">
            <img src="/manus-storage/LSiMediaBadge180x48_fdf5dbe6.png" alt="LSI Media" className="h-7 w-auto max-w-full" />
          </div>
          <div className="text-[10px] text-white/55 tracking-wider uppercase mt-2 text-center">USIP · Sales Intelligence</div>
        </div>

        <nav className="flex-1 overflow-y-auto py-3 px-2 space-y-3">
          {NAV.map((group) => (
            <div key={group.label}>
              <div className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-white/40">{group.label}</div>
              <div className="space-y-0.5">
                {group.items.map((item) => {
                  const active = location === item.href || (item.href !== "/" && location.startsWith(item.href));
                  const Icon = item.icon;
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      className={cn(
                        "flex items-center gap-2.5 px-2 py-1.5 rounded-md text-[13px] transition-colors",
                        active ? "bg-primary/15 text-primary" : "text-white/75 hover:bg-white/5 hover:text-white",
                      )}
                    >
                      <Icon className="size-4 shrink-0" />
                      <span className="truncate">{item.label}</span>
                    </Link>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>

        <div className="px-3 py-3 border-t border-white/10 text-[12px] text-white/60 flex items-center gap-2">
          <div className="size-7 rounded-full bg-white/10 flex items-center justify-center">{(user?.name ?? "?").slice(0, 1).toUpperCase()}</div>
          <div className="flex-1 min-w-0">
            <div className="text-white truncate text-[13px]">{user?.name ?? "Anonymous"}</div>
            <div className="truncate">{current?.role ?? ""}</div>
          </div>
          <button onClick={() => logout()} className="text-white/60 hover:text-white" title="Sign out">
            <LogOut className="size-4" />
          </button>
        </div>
      </aside>

      {/* Main column */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Topbar */}
        <header className="h-14 border-b bg-card/60 backdrop-blur px-3 md:px-4 flex items-center gap-2 md:gap-3 sticky top-0 z-30">
          {/* Mobile hamburger */}
          <button
            className="md:hidden p-2 rounded-md hover:bg-secondary"
            onClick={() => setMobileOpen((v) => !v)}
            aria-label={mobileOpen ? "Close menu" : "Open menu"}
          >
            {mobileOpen ? <X className="size-4" /> : <Menu className="size-4" />}
          </button>
          {/* Workspace switcher */}
          <div className="relative min-w-0 max-w-[55vw] md:max-w-none">
            <button
              onClick={() => setWsOpen((v) => !v)}
              className="flex items-center gap-2 px-2.5 py-1.5 rounded-md hover:bg-secondary text-sm min-w-0 max-w-full"
              disabled={isLoading || !current}
            >
              <Building2 className="size-4 text-muted-foreground shrink-0" />
              <span className="font-medium truncate">{current?.name ?? "Loading…"}</span>
              <ChevronsUpDown className="size-3.5 text-muted-foreground shrink-0" />
            </button>
            {wsOpen && (
              <div className="absolute top-full mt-1 left-0 w-64 bg-popover border rounded-md shadow-lg p-1 z-40">
                {workspaces.map((w) => (
                  <button
                    key={w.id}
                    onClick={() => switchTo(w.id)}
                    className="w-full flex items-center gap-2 px-2 py-1.5 rounded-sm text-sm hover:bg-secondary"
                  >
                    {current?.id === w.id ? <Check className="size-3.5 text-primary" /> : <span className="size-3.5" />}
                    <div className="flex-1 text-left">
                      <div>{w.name}</div>
                      <div className="text-[11px] text-muted-foreground">{w.role} · {w.plan}</div>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>

          {title && <div className="hidden sm:block text-sm text-muted-foreground truncate">/ {title}</div>}
          <div className="flex-1" />

          <div className="hidden md:flex items-center gap-2 px-2.5 py-1.5 rounded-md bg-secondary text-sm w-72">
            <Search className="size-4 text-muted-foreground" />
            <input className="bg-transparent outline-none flex-1 text-sm" placeholder="Search…" />
            <kbd className="text-[10px] text-muted-foreground border px-1 rounded">⌘K</kbd>
          </div>

          {actions}

          <Link href="/inbox" className="relative p-2 rounded-md hover:bg-secondary" title="Notifications">
            <Bell className="size-4" />
            {unread && unread > 0 ? (
              <span className="absolute top-1 right-1 size-2 rounded-full bg-primary" />
            ) : null}
          </Link>
        </header>

        <main className="flex-1 overflow-auto bg-background">{children}</main>
      </div>
    </div>
  );
}

export function PageHeader({ title, description, children }: { title: string; description?: string; children?: ReactNode }) {
  return (
    <div className="px-4 md:px-6 py-4 md:py-5 border-b bg-card/30 flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-4">
      <div className="flex-1 min-w-0">
        <h1 className="text-lg md:text-xl font-semibold tracking-tight truncate">{title}</h1>
        {description && <p className="text-sm text-muted-foreground mt-0.5 line-clamp-2">{description}</p>}
      </div>
      {children && <div className="flex items-center gap-2 flex-wrap">{children}</div>}
    </div>
  );
}

export function StatCard({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: string; tone?: "default" | "success" | "warning" | "danger" }) {
  const toneCls = tone === "success" ? "text-emerald-700 bg-emerald-50 border-emerald-200"
    : tone === "warning" ? "text-amber-800 bg-amber-50 border-amber-200"
    : tone === "danger" ? "text-rose-800 bg-rose-50 border-rose-200"
    : "";
  const titleStr = typeof value === "string" || typeof value === "number" ? String(value) : undefined;
  return (
    <div className={cn("rounded-lg border bg-card p-4 min-w-0 overflow-hidden", toneCls)}>
      <div className="text-[11px] uppercase tracking-wider text-muted-foreground font-medium truncate">{label}</div>
      <div
        className="text-xl @[14rem]:text-2xl font-semibold font-mono mt-1 tabular-nums truncate"
        title={titleStr}
      >
        {value}
      </div>
      {hint && <div className="text-[11px] text-muted-foreground mt-1 truncate" title={hint}>{hint}</div>}
    </div>
  );
}

export function EmptyState({ icon: Icon = Sparkles, title, description, action }: { icon?: any; title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="text-center py-16 px-4">
      <div className="mx-auto size-12 rounded-full bg-secondary flex items-center justify-center mb-3">
        <Icon className="size-5 text-muted-foreground" />
      </div>
      <h3 className="text-sm font-semibold">{title}</h3>
      {description && <p className="text-sm text-muted-foreground mt-1 max-w-sm mx-auto">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
