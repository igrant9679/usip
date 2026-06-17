import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/_core/hooks/useAuth";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import {
  Activity,
  Bell,
  Building2,
  CalendarClock,
  Check,
  ChevronDown,
  ChevronsUpDown,
  ClipboardCheck,
  ClipboardList,
  Database,
  FileText,
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
  BarChart3,
  Filter,
  AlertTriangle,
  Ban,
  Mail,
  MailOpen,
  CalendarDays,
  Plug,
  MessageSquare,
  Bot,
  Radar,
  HelpCircle,
  GitFork,
  ScrollText,
} from "lucide-react";
import { ReactNode, useEffect, useLayoutEffect, useState, useRef, createContext, useContext } from "react";
import { Link, useLocation } from "wouter";
import { PageTransition } from "@/components/PageTransition";
import { useTheme } from "@/contexts/ThemeContext";
import { Moon, Sun, Pencil, Check as CheckIcon, X as XIcon } from "lucide-react";
// ── Accent colour context ────────────────────────────────────────────────────
const AccentContext = createContext<string>("#1D4ED8");
export function useAccentColor() { return useContext(AccentContext); }

// Entry kinds that can appear in a NavGroup's `items` array:
//   - default link (no `kind` field): renders as a clickable nav row
//   - subhead: small uppercase label inside the group (e.g. Acquire's
//     "Funnel" / "Tools" sub-headers)
//   - miniPipeline: compact horizontal pipeline at the TOP of a group
//     (Acquire) — letter-pill per stage, clickable, active-highlighting
type NavLinkItem = { href: string; label: string; icon: any };
type NavSubhead = { kind: "subhead"; label: string; color?: string; darkColor?: string };
type NavMiniPipeline = {
  kind: "miniPipeline";
  // `short` is kept for backwards compatibility but no longer rendered;
  // `icon` (a lucide component) is what shows in the chip now so the
  // pipeline reads at narrow widths instead of P→L→C→A→π noise.
  stages: { href: string; label: string; short: string; icon?: any }[];
};
type NavItem = NavLinkItem | NavSubhead | NavMiniPipeline;
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
    // Trimmed 4 → 1. ARE sub-pages (/are/icp, /are/campaigns, /are/settings)
    // are tabs of the same product — discovery links added in the ARE Hub
    // page header so they remain reachable without sidebar clutter.
    items: [
      { href: "/are", label: "ARE Hub", icon: Bot },
    ],
  },
  {
    label: "Acquire",
    color: "#B45309",
    darkColor: "#FCD34D",
    activeColor: "#B45309",
    activeBg: "rgba(180,83,9,0.10)",
    darkActiveBg: "rgba(252,211,77,0.12)",
    // Mini horizontal pipeline at the top reads as the "story" of this
    // section at a glance. Below it, the same stages plus support tools
    // are listed vertically under "Funnel" / "Tools" sub-headers.
    items: [
      {
        // The funnel the rep actually travels: Prospect → Lead → Opportunity
        // (Pipeline) → Customer (Closed Won). Contacts & Accounts are records
        // created along the way (see the "Records" sub-head), not stages.
        kind: "miniPipeline",
        stages: [
          { href: "/prospects", label: "Prospects", short: "P", icon: Radar },
          { href: "/leads", label: "Leads", short: "L", icon: Target },
          { href: "/pipeline", label: "Pipeline", short: "Π", icon: KanbanSquare },
          { href: "/customers", label: "Customers", short: "★", icon: Heart },
        ],
      },
      { kind: "subhead", label: "Prospect and enrich", color: "#0891B2", darkColor: "#22D3EE" },
      { href: "/prospects", label: "Prospects", icon: Radar },
      { href: "/leads", label: "Leads", icon: Target },
      { href: "/pipeline", label: "Pipeline", icon: KanbanSquare },
      { kind: "subhead", label: "Records", color: "#DB2777", darkColor: "#F472B6" },
      { href: "/contacts", label: "Contacts", icon: Users },
      { href: "/accounts", label: "Accounts", icon: Building2 },
      { kind: "subhead", label: "Tools", color: "#EA580C", darkColor: "#FB923C" },
      // Phase 1 of the multi-source prospect finder (Google Places now,
      // arbitrary-URL scrape + LinkedIn coming in phases 2-3).
      { href: "/find-prospects", label: "Find Prospects", icon: Search },
      { href: "/import", label: "Import Contacts", icon: Upload },
      { href: "/data-health", label: "Data Health", icon: BarChart3 },
      // Moved from Operate — Lead Routing manages how new leads are
      // assigned to reps, which is conceptually a funnel-stage tool.
      { href: "/lead-routing", label: "Lead Routing", icon: Sparkles },
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
    // Trimmed 16 → 8. Round 3 removed /research-pipeline (now opens
    // from /ai-pipeline) and renamed "AI Draft Queue" → "AI Pipeline"
    // since the two stages are now under one entry. Other removals:
    //   - /sender-pools         → opens from /sending-accounts
    //   - /snippets             → opens from /email-builder
    //   - /segment-rules        → opens from /segments
    //   - /email-drafts         → opens from /sequences + /unified-inbox
    //   - /email-analytics      → opens from /sequences + /dashboards
    //   - /connected-accounts   → opens from /sending-accounts
    //   - /email-suppressions   → opens from /sending-accounts
    items: [
      { href: "/sequences", label: "Sequences", icon: Activity },
      { href: "/campaigns", label: "Campaigns", icon: Megaphone },
      { href: "/segments", label: "Segments", icon: Filter },
      { href: "/sending-accounts", label: "Sending Accounts", icon: Mail },
      { href: "/email-builder", label: "Email Builder", icon: LayoutTemplate },
      { href: "/ai-pipeline", label: "AI Pipeline", icon: Sparkles },
      { href: "/unified-inbox", label: "Unified Inbox", icon: MessageSquare },
      { href: "/social", label: "Social", icon: Share2 },
    ],
  },
  {
    // Closed Won lands here: the won account becomes a Customer, then CS
    // retains it (renewals, QBRs). Closes the funnel that starts at Acquire.
    label: "Customers",
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
    // Trimmed 10 → 6. Removed:
    //   - /lead-routing  → moved to Acquire → Tools
    //   - /quota         → opens from /dashboards
    //   - /quotes        → opens from /proposals (similar customer-facing doc)
    //   - /territories   → opens from /lead-routing (routing config lives there)
    items: [
      { href: "/tasks", label: "Tasks", icon: ListChecks },
      { href: "/mindmaps", label: "Mindmaps", icon: GitFork },
      { href: "/workflows", label: "Workflows", icon: Workflow },
      { href: "/dashboards", label: "Dashboards", icon: PieChart },
      { href: "/products", label: "Products", icon: Package },
      { href: "/proposals", label: "Proposals", icon: ClipboardList },
    ],
  },
  {
    label: "Admin",
    color: "#475569",
    darkColor: "#CBD5E1",
    activeColor: "#475569",
    activeBg: "rgba(71,85,105,0.10)",
    darkActiveBg: "rgba(203,213,225,0.12)",
    // Trimmed 10 → 5. Removed (links added on adjacent pages):
    //   - /my-linkedin      → opens from /sending-accounts
    //   - /tour-builder     → opens from /settings (super-admin tool)
    //   - /audit            → opens from /settings
    //   - /scim             → opens from /team (identity provisioning)
    //   - /prompt-templates → opens from /brand-voice (both customize AI)
    items: [
      { href: "/team", label: "Team", icon: Users },
      { href: "/lead-scoring", label: "Lead Scoring", icon: Target },
      { href: "/custom-fields", label: "Custom Fields", icon: Database },
      { href: "/brand-voice", label: "Brand Voice", icon: Mic2 },
      { href: "/personas", label: "Personas", icon: Users },
      { href: "/settings", label: "Settings", icon: Settings },
    ],
  },
  // Removed Help group — now reached via the (?) button in the user
  // footer at the bottom of the sidebar. Saves an entire group header
  // for a one-item section.
];

/** Key used by Dashboards.tsx to persist the user's chosen home dashboard. */
export const HOME_DASHBOARD_KEY = "velocity_home_dashboard";

export function Shell({ children, title, actions }: { children: ReactNode; title?: string; actions?: ReactNode }) {
  const [location] = useLocation();
  const { user, logout } = useAuth();
  const { workspaces, current, switchTo, isLoading } = useWorkspace();
  const [wsOpen, setWsOpen] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const navRef = useRef<HTMLElement>(null);
  // Collapsible nav groups — persisted to localStorage so the choice survives
  // Shell's per-navigation remount (each page renders its own <Shell>).
  const NAV_COLLAPSED_KEY = "velocity_nav_collapsed";
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(NAV_COLLAPSED_KEY);
      if (raw) return new Set<string>(JSON.parse(raw));
    } catch { /* ignore */ }
    return new Set<string>();
  });
  const toggleGroup = (label: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label); else next.add(label);
      try { localStorage.setItem(NAV_COLLAPSED_KEY, JSON.stringify([...next])); } catch { /* ignore */ }
      return next;
    });
  };
  // Preserve sidebar scroll position across route changes so clicking a nav
  // item deep in the list never causes the sidebar to jump back to the top.
  //
  // The previous in-memory useRef silently failed because every page
  // component renders its own <Shell>, which means Shell unmounts and
  // remounts on every navigation — the ref reinitialised to 0 each
  // time. Persisting to sessionStorage survives the remount; using
  // session (not local) storage so the position resets on tab close,
  // which is the expected behavior.
  const SIDEBAR_SCROLL_KEY = "velocity_sidebar_scrollTop";
  useLayoutEffect(() => {
    const el = navRef.current;
    if (!el) return;
    try {
      const saved = sessionStorage.getItem(SIDEBAR_SCROLL_KEY);
      if (saved) {
        const n = Number(saved);
        if (Number.isFinite(n)) el.scrollTop = n;
      }
    } catch {
      // sessionStorage can throw in strict privacy modes; safe to ignore.
    }
  }, []);
  const { data: unread } = trpc.notifications.unreadCount.useQuery(undefined, { enabled: !!current, refetchInterval: 30_000 });
  const { theme, toggleTheme } = useTheme();

  // Respect the user's "Set as Home" preference for the Dashboard nav link
  const homeDashboardHref = (typeof window !== "undefined" ? localStorage.getItem(HOME_DASHBOARD_KEY) : null) ?? "/";

  // Build effective nav with the resolved home href. Non-link items
  // (subheads, miniPipeline — see Acquire section) pass through unchanged.
  const effectiveNav = NAV.map((g) => ({
    ...g,
    items: g.items.map((i) =>
      "href" in i && i.href === "/" ? { ...i, href: homeDashboardHref } : i,
    ),
  }));

  // Derive current category accent from active route. Only `link` items
  // contribute hrefs to the active-group match.
  const activeGroup = effectiveNav.find((g) =>
    g.items.some(
      (i) =>
        "href" in i &&
        (i.href === location ||
          (i.href !== "/" && i.href !== homeDashboardHref && location.startsWith(i.href))),
    ),
  );
  const isDark = theme === "dark";
  // Per-section accent: the active group's colour drives the PageHeader accent
  // rule + icon chip, StatCard borders, and the SubNav active pill — so the
  // whole app visibly reflects which section you're working in.
  const accentColor = isDark
    ? (activeGroup?.darkColor ?? "#5EEAD4")
    : (activeGroup?.color ?? "#14B89A");

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
      <aside data-tour-id="sidebar-nav" className={cn(
        "w-60 shrink-0 bg-sidebar text-sidebar-foreground flex flex-col border-r border-sidebar-border",
        "fixed inset-y-0 left-0 z-50 transform transition-transform duration-200 md:translate-x-0 md:static md:transform-none",
        mobileOpen ? "translate-x-0" : "-translate-x-full",
      )}>
        <div className="px-4 pt-4 pb-3 border-b border-white/10">
          <div className="flex items-center gap-2.5 mb-1">
            <svg className="size-7 text-[#1D4ED8] shrink-0" viewBox="0 0 24 24" fill="currentColor"><path d="M13 2L4.09 12.97 12 12l-1 9 8.91-10.97L12 11l1-9z"/></svg>
            <span className="text-[22px] font-bold tracking-tight text-white">Velocity</span>
          </div>
          <div className="text-[10px] tracking-tight whitespace-nowrap text-[#A5B4FC] leading-tight pl-0.5">The Unified Revenue Intelligence Platform</div>
        </div>

        <nav
          ref={navRef}
          className="flex-1 overflow-y-auto py-3 px-0 space-y-2"
          onScroll={(e) => {
            // Cheap direct write — sessionStorage handles scroll-event
            // frequency fine in modern browsers. No debouncing needed.
            try { sessionStorage.setItem(SIDEBAR_SCROLL_KEY, String((e.currentTarget as HTMLElement).scrollTop)); } catch {}
          }}
        >
          {effectiveNav.map((group) => {
            // Per-group colour — each section gets its own hue for separation.
            const gc = isDark ? group.darkColor : group.color;
            const gBg = isDark ? group.darkActiveBg : group.activeBg;
            const isActiveGroup = group === activeGroup;
            const isCollapsed = collapsedGroups.has(group.label);
            // Collect all hrefs in this group so we can detect prefix collisions.
            // An item is only active via startsWith when no sibling has a longer
            // href that also matches — this prevents /are matching /are/icp etc.
            // Only `link` items contribute hrefs to the prefix-collision check.
            const groupHrefs = group.items
              .filter((i): i is typeof i & { href: string } => "href" in i)
              .map((i) => i.href);
            // Per-item accent: items inherit the colour of the most recent
            // coloured subhead above them (Funnel cyan / Records pink / Tools
            // orange), falling back to the group colour. So each item's icon +
            // active highlight matches the sub-section label it lives under.
            const itemColors: string[] = (() => {
              let running = gc;
              return group.items.map((it) => {
                if ("kind" in it && it.kind === "subhead") {
                  running = (isDark ? it.darkColor : it.color) ?? gc;
                }
                return running;
              });
            })();
            return (
            <div key={group.label}>
              {/* Collapsible, colour-coded section header. When the current
                  route is in this group the whole header lights up (tinted bg
                  + bright colour + left stripe) so you clearly see where you are. */}
              <button
                type="button"
                onClick={() => toggleGroup(group.label)}
                aria-expanded={!isCollapsed}
                className="group/nav w-full flex items-center gap-1.5 pl-3 pr-2 py-1.5 rounded-r-md transition-colors hover:bg-white/5 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-white/30"
                style={{
                  borderLeft: `3px solid ${isActiveGroup ? gc : "transparent"}`,
                  backgroundColor: isActiveGroup ? gBg : undefined,
                }}
              >
                <span
                  className="text-[10px] font-bold uppercase tracking-widest transition-colors"
                  style={{ color: isActiveGroup ? gc : gc + "b0" }}
                >
                  {group.label}
                </span>
                {/* Collapse/expand affordance — a rounded chip with a clear
                    background + a bold, bright chevron so the toggle is easy to
                    see on the dark rail regardless of the section's hue. */}
                <span
                  aria-hidden
                  className="ml-auto shrink-0 flex items-center justify-center size-5 rounded-md bg-white/10 group-hover/nav:bg-white/15 transition-colors"
                >
                  <ChevronDown
                    className="size-3.5 transition-transform duration-150"
                    strokeWidth={2.75}
                    style={{ color: group.darkColor, transform: isCollapsed ? "rotate(-90deg)" : undefined }}
                  />
                </span>
              </button>
              {!isCollapsed && (
              <div className="space-y-0.5 pl-0 pt-0.5">
                {group.items.map((item, idx) => {
                  // Mini horizontal pipeline (P→L→C→A→Π at top of Acquire).
                  if ("kind" in item && item.kind === "miniPipeline") {
                    return (
                      <div
                        key={`pipeline-${idx}`}
                        className="px-3 pt-2 pb-3"
                      >
                        <div className="flex items-center justify-between gap-0.5">
                          {item.stages.map((stage, sIdx) => {
                            const stageActive =
                              location === stage.href ||
                              (stage.href !== "/" && location.startsWith(stage.href + "/"));
                            return (
                              <div
                                key={stage.href}
                                className="flex items-center gap-0.5 flex-1 last:flex-initial"
                              >
                                <Link
                                  href={stage.href}
                                  title={stage.label}
                                  aria-label={stage.label}
                                  className={cn(
                                    "flex items-center justify-center size-7 rounded transition-all",
                                    stageActive
                                      ? "text-white shadow-sm"
                                      : "text-white/70 hover:text-white",
                                  )}
                                  style={
                                    stageActive
                                      ? { backgroundColor: gc }
                                      : {
                                          backgroundColor: gc + "22" /* 13% */,
                                          border: `1px solid ${gc}55` /* 33% */,
                                        }
                                  }
                                >
                                  {(stage as any).icon
                                    ? (() => { const Ico = (stage as any).icon; return <Ico className="size-3.5" />; })()
                                    : <span className="text-[10px] font-bold">{stage.short}</span>}
                                </Link>
                                {sIdx < item.stages.length - 1 && (
                                  <span
                                    className="text-[9px] flex-1 text-center select-none pointer-events-none"
                                    style={{ color: gc + "88" /* 53% */ }}
                                    aria-hidden="true"
                                  >
                                    →
                                  </span>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    );
                  }
                  // Sub-section header (e.g. Acquire "Funnel" / "Records" /
                  // "Tools") — each carries its own unique colour so every
                  // labelled section in the rail reads as distinct.
                  if ("kind" in item && item.kind === "subhead") {
                    const sc = isDark ? item.darkColor : item.color;
                    return (
                      <div
                        key={`subhead-${item.label}-${idx}`}
                        className="pt-2 pb-0.5 pl-3 pr-2"
                      >
                        <span
                          className="text-[9px] font-semibold uppercase tracking-wider"
                          style={{ color: sc ?? "rgba(255,255,255,0.4)" }}
                        >
                          {item.label}
                        </span>
                      </div>
                    );
                  }
                  // Normal link item.
                  // An item is active if:
                  //   1. Exact match, OR
                  //   2. location starts with item.href AND no sibling href is a
                  //      longer prefix of location (prevents /are matching /are/icp).
                  const isExact = location === item.href;
                  const isPrefixMatch =
                    item.href !== "/" &&
                    location.startsWith(item.href) &&
                    !groupHrefs.some(
                      (h) => h !== item.href && h.startsWith(item.href) && location.startsWith(h),
                    );
                  const active = isExact || isPrefixMatch;
                  const Icon = item.icon;
                  // Colour for THIS item — its sub-section's hue (Funnel/
                  // Records/Tools) or the group colour. Drives the icon and the
                  // active highlight so items match their subhead label.
                  const ic = itemColors[idx];
                  const inactiveIconColor = ic + "cc";
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      className={cn(
                        "flex items-center gap-2.5 pl-3 pr-2 py-1.5 text-[13px] transition-all duration-150",
                        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#2DD4BF]/70",
                        active ? "text-white font-medium" : "text-white/70 hover:text-white/95 hover:bg-white/5",
                      )}
                      style={active ? {
                        borderLeft: `3px solid ${ic}`,
                        backgroundColor: ic + "33",
                        paddingLeft: '12px',
                        boxShadow: `inset 0 0 0 1px ${ic}33`,
                      } : {
                        borderLeft: '3px solid transparent',
                        paddingLeft: '12px',
                      }}
                    >
                      <Icon
                        className="size-4 shrink-0 transition-colors"
                        style={{ color: active ? ic : inactiveIconColor }}
                      />
                      <span className="truncate">{item.label}</span>
                    </Link>
                  );
                })}
              </div>
              )}
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
          <Link
            href="/help"
            className="text-white/60 hover:text-white shrink-0"
            title="Help Center"
          >
            <HelpCircle className="size-4" />
          </Link>
          <button onClick={() => logout()} className="text-white/60 hover:text-white shrink-0" title="Sign out">
            <LogOut className="size-4" />
          </button>
        </div>
      </aside>

      {/* Main column */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Topbar */}
        <header
          className="h-14 border-b bg-card/60 backdrop-blur px-3 md:px-4 flex items-center gap-2 md:gap-3 sticky top-0 z-30"
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

export function PageHeader({ title, description: defaultDescription, pageKey, icon, children, className, style }: { title: string; description?: string; pageKey?: string; icon?: ReactNode; children?: ReactNode; className?: string; style?: React.CSSProperties }) {
  const accent = useAccentColor();
  const { user } = useAuth();
  // users.role is a global "user" | "admin" enum — workspace-level
  // super_admin lives on workspace_members.role, accessed via useWorkspace().
  const isAdmin = user?.role === "admin";

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
      className={`relative shrink-0 px-4 md:px-6 py-5 border-b border-border bg-card/40 flex flex-col sm:flex-row sm:items-center sm:flex-wrap gap-3 sm:gap-4${className ? ` ${className}` : ""}`}
      style={style}
    >
      {/* Thin accent rule along the top — section wayfinding without the old heavy box */}
      <span aria-hidden className="absolute inset-x-0 top-0 h-0.5" style={{ backgroundColor: accent }} />
      <div className="flex-1 min-w-0 sm:min-w-[14rem]">
        <div className="flex items-center gap-3">
          {icon && (
            <span
              className="shrink-0 size-10 rounded-xl flex items-center justify-center [&_svg]:size-5"
              style={{ backgroundColor: `${accent}1f`, color: accent }}
            >
              {icon}
            </span>
          )}
          <h1 className="text-xl md:text-2xl font-semibold tracking-tight line-clamp-1" title={title}>{title}</h1>
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

/** Skeleton placeholder for a loading list/table — drop in where rows render
 *  so the layout appears instantly instead of a blank spinner. */
export function TableSkeleton({ rows = 6, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn("p-3 space-y-2.5", className)} aria-busy="true" aria-live="polite">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-3">
          <Skeleton className="h-4 w-4 rounded" />
          <Skeleton className="h-4 flex-1" />
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-4 w-16" />
        </div>
      ))}
    </div>
  );
}

/** Error state for a failed query, distinct from "empty", with a Retry. */
export function QueryError({ message, onRetry }: { message?: string; onRetry?: () => void }) {
  return (
    <div className="text-center py-16 px-4">
      <div className="mx-auto size-12 rounded-full bg-destructive/10 flex items-center justify-center mb-3">
        <AlertTriangle className="size-5 text-destructive" />
      </div>
      <h3 className="text-sm font-semibold">Couldn’t load this</h3>
      <p className="text-sm text-muted-foreground mt-1 max-w-sm mx-auto break-words">{message ?? "Something went wrong fetching this data."}</p>
      {onRetry && <div className="mt-4"><Button variant="outline" size="sm" onClick={onRetry}>Retry</Button></div>}
    </div>
  );
}

/** One pill in the SubNav strip. Every pill is shaded with the current
 *  section accent — a subtle tint when inactive, a stronger fill + solid
 *  border + bold text when active — so the in-page nav reads as part of the
 *  section you're in while keeping a clear active/inactive hierarchy. Hover
 *  is tracked locally so the tint can deepen on the dynamic accent colour
 *  (which can't be expressed with a static Tailwind hover class). */
function SubNavPill({ href, label, title, active, accent }: { href: string; label: string; title?: string; active: boolean; accent: string }) {
  const [hover, setHover] = useState(false);
  const bg = active ? `${accent}30` : hover ? `${accent}1f` : `${accent}12`;
  const border = active ? accent : hover ? `${accent}66` : `${accent}3a`;
  return (
    <Link
      href={href}
      title={title}
      aria-current={active ? "page" : undefined}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className={cn(
        "inline-flex items-center gap-2 text-[13px] px-4 py-2 rounded-lg border transition-all",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        active ? "font-semibold shadow-sm" : "font-medium",
      )}
      style={{ backgroundColor: bg, borderColor: border, color: accent }}
    >
      <span aria-hidden className="size-2 rounded-full" style={{ backgroundColor: accent, opacity: active ? 1 : 0.55 }} />
      {label}
    </Link>
  );
}

/** Secondary navigation strip for related pages — replaces the cramped inline
 *  "Foo →" links that used to sit in the PageHeader action row. Highlights the
 *  active route. Render directly under <PageHeader>. */
export function SubNav({ items }: { items: Array<{ href: string; label: string; title?: string }> }) {
  const [loc] = useLocation();
  const accent = useAccentColor();
  return (
    <nav className="flex items-center gap-2 px-4 md:px-6 py-3.5 flex-wrap shrink-0" aria-label="Section navigation">
      {items.map((it) => (
        <SubNavPill key={it.href} href={it.href} label={it.label} title={it.title} active={loc === it.href} accent={accent} />
      ))}
    </nav>
  );
}
