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
  Mail,
  Layers,
  MailOpen,
  CalendarDays,
} from "lucide-react";
import { ReactNode, useEffect, useState, createContext, useContext } from "react";
import { Link, useLocation } from "wouter";
import { useTheme } from "@/contexts/ThemeContext";
import { Moon, Sun } from "lucide-react";

// ── Accent colour context ────────────────────────────────────────────────────
const AccentContext = createContext<string>("#60A5FA");
export function useAccentColor() { return useContext(AccentContext); }

type NavItem = { href: string; label: string; icon: any };
type NavGroup = { label: string; items: NavItem[]; color: string; activeColor: string; activeBg: string };

const NAV: NavGroup[] = [
  {
    label: "Overview",
    color: "#60A5FA",
    activeColor: "#60A5FA",
    activeBg: "rgba(96,165,250,0.12)",
    items: [
      { href: "/", label: "Dashboard", icon: LayoutDashboard },
      { href: "/inbox", label: "Inbox", icon: Inbox },
      { href: "/mailbox", label: "My Mailbox", icon: MailOpen },
      { href: "/calendar", label: "My Calendar", icon: CalendarDays },
    ],
  },
  {
    label: "Acquire",
    color: "#FCD34D",
    activeColor: "#FCD34D",
    activeBg: "rgba(252,211,77,0.12)",
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
    color: "#C084FC",
    activeColor: "#C084FC",
    activeBg: "rgba(192,132,252,0.12)",
    items: [
      { href: "/segments", label: "Segments", icon: Filter },
      { href: "/segment-rules", label: "Segment Auto-Enroll", icon: Zap },
      { href: "/sequences", label: "Sequences", icon: Activity },
      { href: "/email-drafts", label: "Email Drafts", icon: FileText },
      { href: "/email-analytics", label: "Email Analytics", icon: BarChart3 },
      { href: "/email-suppressions", label: "Opt-Out Management", icon: Ban },
      { href: "/sending-accounts", label: "Sending Accounts", icon: Mail },
      { href: "/sender-pools", label: "Sender Pools", icon: Layers },
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
    color: "#F87171",
    activeColor: "#F87171",
    activeBg: "rgba(248,113,113,0.12)",
    items: [
      { href: "/customers", label: "Customers", icon: Heart },
      { href: "/renewals", label: "Renewals", icon: CalendarClock },
      { href: "/qbrs", label: "QBRs", icon: ClipboardCheck },
    ],
  },
  {
    label: "Operate",
    color: "#2DD4BF",
    activeColor: "#2DD4BF",
    activeBg: "rgba(45,212,191,0.12)",
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
    color: "#94A3B8",
    activeColor: "#94A3B8",
    activeBg: "rgba(148,163,184,0.12)",
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
  const { theme, toggleTheme } = useTheme();

  // Derive current category accent from active route
  const activeGroup = NAV.find(g => g.items.some(i => i.href === location || (i.href !== "/" && location.startsWith(i.href))));
  const accentColor = activeGroup?.color ?? "#60A5FA";

  // close dropdowns/drawers on route change
  useEffect(() => {
    setWsOpen(false);
    setMobileOpen(false);
  }, [location]);
  return (
    <AccentContext.Provider value={accentColor}>
    <div className="h-full flex bg-background text-foreground">
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
        <div className="px-4 pt-4 pb-3 border-b border-white/10">
          <div className="flex items-center gap-2 mb-1">
            <svg className="size-5 text-[#60A5FA] shrink-0" viewBox="0 0 24 24" fill="currentColor"><path d="M13 2L4.09 12.97 12 12l-1 9 8.91-10.97L12 11l1-9z"/></svg>
            <span className="text-[18px] font-bold tracking-tight text-white">Velocity</span>
          </div>
          <div className="text-[9.5px] text-[#A5B4FC] leading-tight pl-0.5">The Unified Revenue Intelligence Platform</div>
        </div>

        <nav className="flex-1 overflow-y-auto py-3 px-0 space-y-2">
          {NAV.map((group) => (
            <div key={group.label}>
              {/* Section header with left stripe */}
              <div
                className="flex items-center gap-1.5 pl-3 pr-2 pb-1 pt-0.5"
                style={{ borderLeft: `3px solid ${group.color}` }}
              >
                <span
                  className="text-[10px] font-bold uppercase tracking-widest"
                  style={{ color: group.color }}
                >
                  {group.label}
                </span>
              </div>
              <div className="space-y-0.5 pl-0">
                {group.items.map((item) => {
                  const active = location === item.href || (item.href !== "/" && location.startsWith(item.href));
                  const Icon = item.icon;
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      className={cn(
                        "flex items-center gap-2.5 pl-3 pr-2 py-1.5 text-[13px] transition-all duration-150",
                        active ? "text-white" : "text-white/60 hover:text-white/90",
                      )}
                      style={active ? {
                        borderLeft: `3px solid ${group.color}`,
                        backgroundColor: group.activeBg,
                        paddingLeft: '12px',
                      } : {
                        borderLeft: '3px solid transparent',
                        paddingLeft: '12px',
                      }}
                    >
                      <Icon
                        className="size-4 shrink-0 transition-colors"
                        style={{ color: active ? group.color : group.color + 'aa' }}
                      />
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

          {/* Dark / light mode toggle */}
          {toggleTheme && (
            <button
              onClick={toggleTheme}
              className="p-2 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors"
              title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            >
              {theme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
            </button>
          )}

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
    </AccentContext.Provider>
  );
}

export function PageHeader({ title, description, children }: { title: string; description?: string; children?: ReactNode }) {
  const accent = useAccentColor();
  return (
    <div
      className="px-4 md:px-6 py-4 md:py-5 border-b flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-4"
      style={{
        borderLeftWidth: '4px',
        borderLeftStyle: 'solid',
        borderLeftColor: accent,
        background: `linear-gradient(to right, ${accent}12 0%, transparent 60%)`,
      }}
    >
      <div className="flex-1 min-w-0">
        <h1 className="text-lg md:text-xl font-semibold tracking-tight truncate" style={{ color: accent }}>{title}</h1>
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
