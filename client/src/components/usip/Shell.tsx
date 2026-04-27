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
  Plug,
  MessageSquare,
  Bot,
  Cpu,
  Radar,
} from "lucide-react";
import { ReactNode, useEffect, useState, useRef, createContext, useContext } from "react";
import { Link, useLocation } from "wouter";
import { PageTransition } from "@/components/PageTransition";
import { useTheme } from "@/contexts/ThemeContext";
import { Moon, Sun, Pencil, Check as CheckIcon, X as XIcon } from "lucide-react";
// ── Accent colour context ────────────────────────────────────────────────────
const AccentContext = createContext<string>("#1D4ED8");
export function useAccentColor() { return useContext(AccentContext); }

type NavItem = { href: string; label: string; icon: any };
type NavGroup = { label: string; items: NavItem[]; color: string; darkColor: string; activeColor: string; activeBg: string; darkActiveBg: string };

const NAV: NavGroup[] = [
  {
    label: "Overview",
    color: "#1D4ED8",
    darkColor: "#93C5FD",
    activeColor: "#1D4ED8",
    activeBg: "rgba(29,78,216,0.10)",
    darkActiveBg: "rgba(147,197,253,0.12)",
    items: [
      { href: "/", label: "Dashboard", icon: LayoutDashboard },
      { href: "/inbox", label: "Inbox", icon: Inbox },
      { href: "/mailbox", label: "My Mailbox", icon: MailOpen },
      { href: "/calendar", label: "My Calendar", icon: CalendarDays },
    ],
  },
  {
    label: "Revenue Engine",
    color: "#059669",
    darkColor: "#6EE7B7",
    activeColor: "#059669",
    activeBg: "rgba(5,150,105,0.10)",
    darkActiveBg: "rgba(110,231,183,0.12)",
    items: [
      { href: "/are", label: "ARE Hub", icon: Bot },
      { href: "/are/icp", label: "ICP Agent", icon: Cpu },
      { href: "/are/campaigns", label: "Campaigns", icon: Radar },
      { href: "/are/settings", label: "ARE Settings", icon: Settings },
    ],
  },
  {
    label: "Acquire",
    color: "#B45309",
    darkColor: "#FCD34D",
    activeColor: "#B45309",
    activeBg: "rgba(180,83,9,0.10)",
    darkActiveBg: "rgba(252,211,77,0.12)",
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
    color: "#7C3AED",
    darkColor: "#C4B5FD",
    activeColor: "#7C3AED",
    activeBg: "rgba(124,58,237,0.10)",
    darkActiveBg: "rgba(196,181,253,0.12)",
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
      { href: "/unified-inbox", label: "Unified Inbox", icon: MessageSquare },
      { href: "/connected-accounts", label: "Connected Accounts", icon: Plug },
      { href: "/social", label: "Social", icon: Share2 },
      { href: "/campaigns", label: "Campaigns", icon: Megaphone },
    ],
  },
  {
    label: "Retain",
    color: "#DC2626",
    darkColor: "#FCA5A5",
    activeColor: "#DC2626",
    activeBg: "rgba(220,38,38,0.10)",
    darkActiveBg: "rgba(252,165,165,0.12)",
    items: [
      { href: "/customers", label: "Customers", icon: Heart },
      { href: "/renewals", label: "Renewals", icon: CalendarClock },
      { href: "/qbrs", label: "QBRs", icon: ClipboardCheck },
    ],
  },
  {
    label: "Operate",
    color: "#0F766E",
    darkColor: "#5EEAD4",
    activeColor: "#0F766E",
    activeBg: "rgba(15,118,110,0.10)",
    darkActiveBg: "rgba(94,234,212,0.12)",
    items: [
      { href: "/tasks", label: "Tasks", icon: ListChecks },
      { href: "/workflows", label: "Workflows", icon: Workflow },
      { href: "/dashboards", label: "Dashboards", icon: PieChart },
      { href: "/products", label: "Products", icon: Package },
      { href: "/proposals", label: "Proposals", icon: ClipboardList },
      { href: "/quotes", label: "Quotes", icon: FileText },
      { href: "/territories", label: "Territories", icon: Network },
      { href: "/lead-routing", label: "Lead Routing", icon: Sparkles },
      { href: "/quota", label: "Quota Management", icon: Target },
    ],
  },
  {
    label: "Admin",
    color: "#475569",
    darkColor: "#CBD5E1",
    activeColor: "#475569",
    activeBg: "rgba(71,85,105,0.10)",
    darkActiveBg: "rgba(203,213,225,0.12)",
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

/** Key used by Dashboards.tsx to persist the user's chosen home dashboard. */
export const HOME_DASHBOARD_KEY = "velocity_home_dashboard";

export function Shell({ children, title, actions }: { children: ReactNode; title?: string; actions?: ReactNode }) {
  const [location] = useLocation();
  const { user, logout } = useAuth();
  const { workspaces, current, switchTo, isLoading } = useWorkspace();
  const [wsOpen, setWsOpen] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const { data: unread } = trpc.notifications.unreadCount.useQuery(undefined, { enabled: !!current, refetchInterval: 30_000 });
  const { theme, toggleTheme } = useTheme();

  // Respect the user's "Set as Home" preference for the Dashboard nav link
  const homeDashboardHref = (typeof window !== "undefined" ? localStorage.getItem(HOME_DASHBOARD_KEY) : null) ?? "/";

  // Build effective nav with the resolved home href
  const effectiveNav = NAV.map((g) => ({
    ...g,
    items: g.items.map((i) => i.href === "/" ? { ...i, href: homeDashboardHref } : i),
  }));

  // Derive current category accent from active route
  const activeGroup = effectiveNav.find(g => g.items.some(i => i.href === location || (i.href !== "/" && i.href !== homeDashboardHref && location.startsWith(i.href)) || i.href === location));
  const isDark = theme === "dark";
  const accentColor = isDark
    ? (activeGroup?.darkColor ?? "#93C5FD")
    : (activeGroup?.color ?? "#1D4ED8");

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
            <svg className="size-5 text-[#1D4ED8] shrink-0" viewBox="0 0 24 24" fill="currentColor"><path d="M13 2L4.09 12.97 12 12l-1 9 8.91-10.97L12 11l1-9z"/></svg>
            <span className="text-[18px] font-bold tracking-tight text-white">Velocity</span>
          </div>
          <div className="text-[9.5px] text-[#A5B4FC] leading-tight pl-0.5">The Unified Revenue Intelligence Platform</div>
        </div>

        <nav className="flex-1 overflow-y-auto py-3 px-0 space-y-2">
          {effectiveNav.map((group) => {
            const gc = isDark ? group.darkColor : group.color;
            const gBg = isDark ? group.darkActiveBg : group.activeBg;
            return (
            <div key={group.label}>
              {/* Section header with left stripe */}
              <div
                className="flex items-center gap-1.5 pl-3 pr-2 pb-1 pt-0.5"
                style={{ borderLeft: `3px solid ${gc}` }}
              >
                <span
                  className="text-[10px] font-bold uppercase tracking-widest"
                  style={{ color: gc }}
                >
                  {group.label}
                </span>
              </div>
              <div className="space-y-0.5 pl-0">
                {group.items.map((item) => {
                  const active = location === item.href || (item.href !== "/" && location.startsWith(item.href));
                  const Icon = item.icon;
                  // Inactive icon: use group color at 70% opacity (cc) for minimum legibility
                  const inactiveIconColor = gc + 'cc';
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      className={cn(
                        "flex items-center gap-2.5 pl-3 pr-2 py-1.5 text-[13px] transition-all duration-150",
                        active ? "text-white" : "text-white/70 hover:text-white/95",
                      )}
                      style={active ? {
                        borderLeft: `3px solid ${gc}`,
                        backgroundColor: gBg,
                        paddingLeft: '12px',
                      } : {
                        borderLeft: '3px solid transparent',
                        paddingLeft: '12px',
                      }}
                    >
                      <Icon
                        className="size-4 shrink-0 transition-colors"
                        style={{ color: active ? gc : inactiveIconColor }}
                      />
                      <span className="truncate">{item.label}</span>
                    </Link>
                  );
                })}
              </div>
            </div>
            );
          })}
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
        <header
          className="h-14 border-b bg-card/60 backdrop-blur px-3 md:px-4 flex items-center gap-2 md:gap-3 sticky top-0 z-30"
          style={{ boxShadow: `0 2px 0 0 ${accentColor}` }}
        >
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

        <main className="flex-1 overflow-auto bg-background">
          <PageTransition>{children}</PageTransition>
        </main>
      </div>
    </div>
    </AccentContext.Provider>
  );
}

export function PageHeader({ title, description: defaultDescription, pageKey, icon, children }: { title: string; description?: string; pageKey?: string; icon?: ReactNode; children?: ReactNode }) {
  const accent = useAccentColor();
  const { user } = useAuth();
  const isAdmin = user?.role === "admin" || user?.role === "super_admin";

  // Load DB description if pageKey provided
  const { data: dbDesc } = trpc.pageDescriptions.get.useQuery(
    { pageKey: pageKey ?? "" },
    { enabled: !!pageKey }
  );
  const updateDesc = trpc.pageDescriptions.update.useMutation();

  const resolvedDescription = dbDesc?.description ?? defaultDescription;

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) {
      setDraft(resolvedDescription ?? "");
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [editing]);

  const handleSave = async () => {
    if (!pageKey) return;
    await updateDesc.mutateAsync({ pageKey, description: draft.trim() });
    setEditing(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") handleSave();
    if (e.key === "Escape") setEditing(false);
  };

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
        <div className="flex items-center gap-2">
          {icon && <span className="shrink-0" style={{ color: accent }}>{icon}</span>}
          <h1 className="text-lg md:text-xl font-semibold tracking-tight line-clamp-1" title={title} style={{ color: accent }}>{title}</h1>
        </div>
        <div className="flex items-center gap-1.5 mt-0.5 group/desc">
          {editing ? (
            <>
              <input
                ref={inputRef}
                value={draft}
                onChange={e => setDraft(e.target.value)}
                onKeyDown={handleKeyDown}
                maxLength={500}
                className="flex-1 text-sm bg-transparent border-b border-muted-foreground/40 focus:border-foreground outline-none text-muted-foreground py-0.5 min-w-0"
                placeholder="Add a page description…"
              />
              <button onClick={handleSave} className="shrink-0 p-0.5 rounded hover:bg-secondary text-emerald-600" title="Save">
                <CheckIcon className="size-3.5" />
              </button>
              <button onClick={() => setEditing(false)} className="shrink-0 p-0.5 rounded hover:bg-secondary text-muted-foreground" title="Cancel">
                <XIcon className="size-3.5" />
              </button>
            </>
          ) : (
            <>
              {resolvedDescription && (
                <p className="text-sm text-muted-foreground line-clamp-1" title={resolvedDescription}>{resolvedDescription}</p>
              )}
              {isAdmin && pageKey && (
                <button
                  onClick={() => setEditing(true)}
                  className="shrink-0 p-0.5 rounded opacity-0 group-hover/desc:opacity-100 hover:bg-secondary text-muted-foreground transition-opacity"
                  title="Edit description"
                >
                  <Pencil className="size-3" />
                </button>
              )}
            </>
          )}
        </div>
      </div>
      {children && <div className="flex items-center gap-2 flex-wrap">{children}</div>}
    </div>
  );
}

export function StatCard({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: string; tone?: "default" | "success" | "warning" | "danger" }) {
  const accent = useAccentColor();
  const toneCls = tone === "success" ? "text-emerald-700 bg-emerald-50 border-emerald-200"
    : tone === "warning" ? "text-amber-800 bg-amber-50 border-amber-200"
    : tone === "danger" ? "text-rose-800 bg-rose-50 border-rose-200"
    : "";
  const titleStr = typeof value === "string" || typeof value === "number" ? String(value) : undefined;
  return (
    <div
      className={cn("rounded-lg border bg-card p-4 min-w-0 overflow-hidden", toneCls)}
      style={!tone ? {
        borderLeftWidth: "3px",
        borderLeftStyle: "solid",
        borderLeftColor: accent,
      } : undefined}
    >
      <div className="text-[11px] uppercase tracking-wider text-muted-foreground font-medium truncate">{label}</div>
      <div
        className="text-xl @[14rem]:text-2xl font-semibold font-mono mt-1 tabular-nums truncate"
        title={titleStr}
        style={!tone ? { color: accent } : undefined}
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
