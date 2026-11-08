/**
 * SettingsHub — the master Settings area (/v2/settings/:section?).
 *
 * Apollo-style full-screen settings shell: a dedicated left rail ("← Settings"
 * back link, search, grouped navigation, pinned Add Teammates) with a main
 * content panel. Sections come in two kinds:
 *   - INTERNAL subpages rendered in the content panel (Profile today; add a
 *     new entry to SECTIONS with a `render` to grow the hub), and
 *   - LINK sections that route to the existing dedicated pages (Team, Audit,
 *     legacy /settings tabs, imports, enrichment…), so every row goes
 *     somewhere real while those surfaces migrate into the hub over time.
 *
 * Profile is the default landing subpage — the sidebar "Admin Settings →
 * All settings" opens /v2/settings/profile. Its five tabs mirror the Apollo
 * reference and each is wired to real Velocity data:
 *   General        — account info, CRM connection, annual quota, LinkedIn
 *   MFA            — honest sign-in security state + password controls
 *   Custom fields  — live customFields.listDefs summary + manage link
 *   Email settings — sending prefs, sequence opt-out, mailbox links
 *   Conversations  — per-user notification routing (team.getNotifPrefs)
 */
import { Suspense, lazy, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useLocation, useParams, useSearch } from "wouter";
import { usePageTitle } from "@/lib/usePageTitle";
import { ShellEmbedContext } from "@/components/usip/Shell";
import { SignatureSection } from "@/components/usip/settings/SignatureSection";
import { HUB_SECTION_ALIASES, PROFILE_TAB_IDS, profileTabFrom, settingsMatches, type ProfileTabId } from "@/lib/settingsSearch";
import { trpc } from "@/lib/trpc";
import { usePermissions } from "@/hooks/usePermissions";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { WorkspaceSwitchList } from "@/components/usip/WorkspaceSwitchList";
import { Building2 as WsIcon, ChevronsUpDown as WsChevrons } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { QueryError } from "@/components/usip/Shell";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { MailboxesSection } from "@/components/usip/settings/MailboxesSection";
import { VoiceAgentsSection } from "@/components/usip/settings/VoiceAgentsSection";
import { KnowledgeSection } from "@/components/usip/settings/KnowledgeSection";
import { ApolloSourceCard } from "@/components/usip/settings/ApolloSourceCard";
import { ReoonVerifierCard } from "@/components/usip/settings/ReoonVerifierCard";
import { QuickEnrichSourceCard } from "@/components/usip/settings/QuickEnrichSourceCard";
import { WarmySenderSourceCard } from "@/components/usip/settings/WarmySenderSourceCard";
import { LeadOceanSourceCard } from "@/components/usip/settings/LeadOceanSourceCard";
import { ProspectSourceRegistryCard } from "@/components/usip/settings/ProspectSourceRegistryCard";
import { BrandingSection } from "@/components/usip/settings/BrandingSection";
import { TotpSetupDialog } from "@/components/usip/settings/TotpSetupDialog";
import { SocialAccountsSection } from "@/components/usip/settings/SocialAccountsSection";
import { LegacySettingsSection } from "@/pages/usip/Settings";
import { ResponsiveRail } from "@/components/usip/ResponsiveRail";
import {
  ArrowLeft,
  Menu,
  Search,
  User,
  Bell,
  Mail,
  Link2,
  Building2,
  Users,
  ShieldCheck,
  Plug,
  Palette,
  CreditCard,
  Activity,
  Tag,
  Upload,
  Sparkles,
  UserPlus,
  Loader2,
  Send,
  Pencil,
  Database,
  KeyRound,
  Smartphone,
  Phone,
  AudioLines,
  BookOpen,
  Monitor,
  FileText,
  Zap,
  AlertTriangle,
  ListChecks,
  PenLine,
} from "lucide-react";
import { BackupCodesPanel } from "@/components/usip/settings/BackupCodesPanel";
import { confirmAction } from "@/components/usip/Common";
import { isAdminRole } from "@shared/roleRank";
import { tablistProps, tabProps } from "@/lib/tabs";

/* ───────────────────────── section registry ───────────────────────────── */

type HubItem = {
  id: string;
  label: string;
  icon: any;
  /** Internal subpage id (renders in the content panel) … */
  internal?: boolean;
  /** … or an app route this row navigates to. */
  href?: string;
  /**
   * What else this row is called, for the search box (audit 2026-10-20, U9):
   * it matched labels only, so "MFA", "SMTP", "webhook" or "signature" found
   * nothing. Lower case.
   */
  keywords?: string[];
};
type HubGroup = { label: string; items: HubItem[] };

/*
 * The structure (audit 2026-10-20, G51 and U9; batch CONB, 2026-11-08; the
 * owner delegated the call). Personal holds what belongs to you; anything
 * that applies to the whole workspace sits under Workspace — Mailboxes (the
 * workspace's sending accounts) moved there, and "Phone numbers", which opened
 * the call queue, is the Voice agents section, where numbers are set. Your
 * signature has its own section, the one place signatures are edited.
 *
 * Users and teams, Audit log, Custom fields and Notifications are settings, so
 * they render inside the hub now (ShellEmbedContext); their pages still route
 * on their own for links and bookmarks. Three rows still link out, on
 * purpose: Tour builder is a full-screen authoring tool for super admins, not
 * a setting, and Imports and Data enrichment are places to work on records.
 *
 * The legacy /settings page collapsed into this hub 2026-09-15: every row
 * that used to round-trip into it is an internal section rendering the same
 * tab component via LegacySettingsSection.
 */
const GROUPS: HubGroup[] = [
  {
    label: "Personal settings",
    items: [
      { id: "profile", label: "Profile", icon: User, internal: true, keywords: ["name", "title", "login email", "password", "quota", "annual quota", "linkedin", "mfa", "2fa", "two-factor", "authenticator", "backup codes", "sessions", "sign out everywhere"] },
      { id: "appearance", label: "Appearance", icon: Monitor, internal: true, keywords: ["theme", "dark mode", "light mode", "colour", "color", "palette"] },
      { id: "signature", label: "Email signature", icon: PenLine, internal: true, keywords: ["signature", "email signature", "sign-off", "sign off", "footer"] },
      { id: "notifications", label: "Notifications", icon: Bell, internal: true, keywords: ["alerts", "email notifications", "in-app", "bell", "mute"] },
      { id: "social-accounts", label: "Social accounts", icon: Link2, internal: true, keywords: ["linkedin", "unipile", "whatsapp", "instagram", "social"] },
    ],
  },
  {
    label: "Workspace settings",
    items: [
      { id: "workspace", label: "Workspace overview", icon: Building2, internal: true, keywords: ["workspace name", "slug", "plan", "time zone", "timezone", "fiscal year", "currency", "general"] },
      { id: "users-teams", label: "Users and teams", icon: Users, internal: true, keywords: ["team", "users", "members", "invite", "invitations", "roles", "permissions", "seats", "deactivate"] },
      { id: "mailboxes", label: "Mailboxes", icon: Mail, internal: true, keywords: ["mailbox", "sending accounts", "smtp", "imap", "gmail", "google", "outlook", "warmup", "sending limits", "opt-out"] },
      { id: "voice-agents", label: "Voice agents and numbers", icon: AudioLines, internal: true, keywords: ["voice", "phone", "phone numbers", "calls", "dialer", "plivo", "xai"] },
      { id: "security", label: "Security", icon: ShieldCheck, internal: true, keywords: ["mfa", "2fa", "two-factor", "require 2fa", "sso", "ip allowlist", "session timeout", "password"] },
      { id: "notification-policy", label: "Notification policy", icon: Bell, internal: true, keywords: ["notifications", "notify", "policy"] },
      { id: "integrations", label: "Integrations", icon: Plug, internal: true, keywords: ["webhook", "webhooks", "api key", "api keys", "ai providers", "openai", "anthropic", "gemini", "slack", "teams", "google maps", "sendgrid"] },
      { id: "knowledge", label: "Knowledge base", icon: BookOpen, internal: true, keywords: ["documents", "faq", "knowledge"] },
      { id: "data-sources", label: "Data sources", icon: Database, internal: true, keywords: ["apollo", "reoon", "quickenrich", "warmysender", "leadocean", "vendors", "api key", "api keys", "verification", "providers"] },
      { id: "email-delivery", label: "Email delivery", icon: Send, internal: true, keywords: ["smtp", "from name", "sender", "deliverability", "email identity", "system email"] },
      { id: "branding", label: "Branding", icon: Palette, internal: true, keywords: ["brand", "logo", "colours", "colors", "brand voice"] },
      { id: "proposals", label: "Proposals", icon: FileText, internal: true, keywords: ["quote", "quotes", "e-signature", "portal", "expiry"] },
      { id: "billing", label: "Billing and credits", icon: CreditCard, internal: true, keywords: ["billing", "credits", "plan", "usage", "spend", "cost", "invoice", "caps"] },
      // "Audit log", the page's own title: as "System activity" it read as a
      // different page (the Shell's admin menu made the same fix) (G51).
      { id: "system-activity", label: "Audit log", icon: Activity, internal: true, keywords: ["audit", "history", "activity log", "who changed"] },
      { id: "tour-builder", label: "Tour builder", icon: Zap, href: "/tour-builder", keywords: ["tours", "onboarding", "guide"] },
      { id: "danger", label: "Danger zone", icon: AlertTriangle, internal: true, keywords: ["delete workspace", "archive", "danger"] },
    ],
  },
  {
    label: "Data management",
    items: [
      { id: "custom-fields", label: "Custom fields", icon: Tag, internal: true, keywords: ["fields", "properties", "custom"] },
      { id: "imports", label: "Imports and exports", icon: Upload, href: "/v2/data-enrichment?tab=import-contacts", keywords: ["import", "export", "csv", "upload"] },
      { id: "enrichment", label: "Data enrichment", icon: Sparkles, href: "/v2/data-enrichment", keywords: ["enrich", "enrichment"] },
      { id: "enrichment-sweep", label: "Enrichment sweep", icon: Database, internal: true, keywords: ["sweep", "enrichment schedule"] },
    ],
  },
];

/** The registry, for its tests (search keywords, groups). */
export const SETTINGS_GROUPS = GROUPS;

/** The settings pages that render inside the hub (U9), loaded when opened. */
const EmbeddedTeam = lazy(() => import("@/pages/usip/Team"));
const EmbeddedAudit = lazy(() => import("@/pages/usip/Audit"));
const EmbeddedCustomFields = lazy(() => import("@/pages/usip/CustomFields"));
const EmbeddedNotificationPrefs = lazy(() => import("@/pages/usip/NotificationPrefs"));

/** A whole page, shown in the hub's content panel without its own frame. */
function Embedded({ children }: { children: ReactNode }) {
  return (
    <ShellEmbedContext.Provider value={true}>
      <Suspense fallback={<div className="p-6"><div className="h-40 rounded-xl bg-muted/50 animate-pulse" /></div>}>
        <div className="flex-1 min-h-0 flex flex-col">{children}</div>
      </Suspense>
    </ShellEmbedContext.Provider>
  );
}

/* ─────────────────────────────── page ─────────────────────────────────── */

export default function SettingsHub() {
  const params = useParams<{ section?: string }>();
  const [, navigate] = useLocation();
  const [query, setQuery] = useState("");

  // Absent section → Profile (the default landing subpage). A row that links
  // out, reached by its id, goes where the rail would send it; an id that is no
  // section says so. Both used to show Profile as if it had been asked for (G51).
  // An id a row used to have still lands (phone-numbers → voice-agents).
  const askedId = params.section ? (HUB_SECTION_ALIASES[params.section] ?? params.section) : undefined;
  const askedItem = askedId ? GROUPS.flatMap((g) => g.items).find((i) => i.id === askedId) : undefined;
  const unknownSection = !!params.section && !askedItem ? params.section : null;
  useEffect(() => {
    if (askedItem && !askedItem.internal && askedItem.href) navigate(askedItem.href, { replace: true });
    else if (askedItem && params.section && askedItem.id !== params.section) navigate(`/v2/settings/${askedItem.id}`, { replace: true });
  }, [askedItem, navigate, params.section]);
  const section = askedItem?.internal ? askedItem.id : "profile";

  // "Billing and credits" is the one section behind a per-member permission
  // (access_billing). Granted by default — only an explicit deny row on the
  // Team page removes it — so for almost every member this filter is a no-op.
  const { can } = usePermissions();
  const canBilling = can("access_billing");
  const { current: currentWorkspace } = useWorkspace();

  const filteredGroups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const visible = GROUPS.map((g) => ({ ...g, items: g.items.filter((i) => i.id !== "billing" || canBilling) }));
    if (!q) return visible.filter((g) => g.items.length > 0);
    // Labels and keywords (U9): "mfa", "smtp", "webhook", "signature".
    return visible.map((g) => ({ ...g, items: g.items.filter((i) => settingsMatches(q, i.label, i.keywords)) }))
      .filter((g) => g.items.length > 0);
  }, [query, canBilling]);

  // Below md the rail is a sheet, opened from the top bar (G27).
  const [navOpen, setNavOpen] = useState(false);
  const sectionLabel = GROUPS.flatMap((g) => g.items).find((i) => i.id === section)?.label ?? "Profile";
  // The tab says which section is open (the workspace name rides along: U10).
  usePageTitle(unknownSection ? "Settings" : `${sectionLabel} · Settings`);
  // The Profile tab a search result or a link asked for (?tab=, U9).
  const search = useSearch();

  const go = (it: HubItem) => {
    setNavOpen(false);
    if (it.internal) navigate(`/v2/settings/${it.id}`);
    else if (it.href) navigate(it.href);
  };

  return (
    <div className="h-screen flex bg-background text-foreground">
      {/* ── settings rail ── */}
      <ResponsiveRail
        title="Settings sections"
        open={navOpen}
        onOpenChange={setNavOpen}
        className="w-60 shrink-0 flex-col min-h-0 border-r border-border bg-card/30"
      >
        <div className="shrink-0 px-3 pt-4 pb-2">
          <button
            type="button"
            onClick={() => navigate("/")}
            className="flex items-center gap-2 rounded-md px-2 py-1 text-[15px] font-semibold hover:bg-muted transition-colors"
          >
            <ArrowLeft className="size-4" /> Settings
          </button>
        </div>
        <div className="shrink-0 px-3 pb-2">
          <SettingsWorkspaceSwitcher />
        </div>
        <div className="shrink-0 px-3 pb-2">
          <div className="flex h-8 items-center gap-2 rounded-md border border-border bg-background px-2">
            <Search className="size-3.5 shrink-0 text-muted-foreground" />
            <input aria-label="Search settings"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search settings"
              className="min-w-0 flex-1 bg-transparent text-[13px] outline-none"
            />
          </div>
        </div>
        <nav className="flex-1 min-h-0 overflow-y-auto px-2 pb-2">
          {filteredGroups.map((g) => (
            <div key={g.label}>
              <div className="px-3 pt-3 pb-1 text-[11px] font-medium text-muted-foreground">{g.label}</div>
              <div className="space-y-0.5">
                {g.items.map((it) => {
                  const active = it.internal && it.id === section;
                  // A Profile hit for "mfa" or "password" opens that tab (U9).
                  const tabHit = it.id === "profile" && query.trim() ? profileTabFrom(query) : null;
                  return (
                    <button
                      key={it.id}
                      type="button"
                      onClick={() => (tabHit ? (setNavOpen(false), navigate(`/v2/settings/profile?tab=${tabHit}`)) : go(it))}
                      className={cn(
                        "w-full flex items-center gap-2.5 rounded-md px-3 py-1.5 text-left text-[13px] transition-colors",
                        active
                          ? "bg-primary/15 font-medium text-foreground"
                          : "text-foreground/85 hover:bg-muted hover:text-foreground",
                      )}
                    >
                      <it.icon className={cn("size-3.5 shrink-0", active ? "text-primary" : "text-muted-foreground")} />
                      <span className="truncate">{it.label}{tabHit ? ` › ${PROFILE_TABS.find((t) => t.id === tabHit)?.label}` : ""}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
          {filteredGroups.length === 0 && (
            <p className="px-3 py-6 text-center text-[12px] text-muted-foreground">No settings match "{query}"</p>
          )}
        </nav>
        <div className="shrink-0 border-t border-border p-3">
          <Button variant="outline" size="sm" className="w-full gap-1.5" onClick={() => navigate("/v2/settings/users-teams")}>
            <UserPlus className="size-4" /> Add Teammates
          </Button>
        </div>
      </ResponsiveRail>

      {/* ── content panel ── */}
      {/* Keyed by workspace: switching remounts every section, so a form
          half-edited in one workspace can never be saved into the next one
          (several sections copy their query data into local state once). */}
      <main key={currentWorkspace?.id ?? 0} className="flex-1 min-w-0 flex flex-col min-h-0">
        {/* mobile top bar (rail is a sheet below md, opened from here) */}
        <div className="md:hidden shrink-0 flex items-center gap-2 border-b border-border px-3 h-12">
          <button type="button" onClick={() => navigate("/")} aria-label="Leave settings" className="shrink-0 rounded-md p-1 hover:bg-muted">
            <ArrowLeft className="size-4" />
          </button>
          <Button
            variant="outline"
            size="sm"
            className="h-8 min-w-0 gap-1.5"
            aria-haspopup="dialog"
            aria-expanded={navOpen}
            onClick={() => setNavOpen(true)}
          >
            <Menu className="size-3.5 shrink-0" />
            <span className="truncate">{sectionLabel}</span>
          </Button>
          <div className="ml-auto w-36 min-w-0 shrink">
            <SettingsWorkspaceSwitcher />
          </div>
        </div>
        {unknownSection ? (
          <div role="alert" className="max-w-xl rounded-xl border bg-card p-5">
            <div className="text-sm font-semibold">There is no settings section called “{unknownSection}”</div>
            <p className="mt-1 text-sm text-muted-foreground">The link may be out of date. Pick a section on the left, or go to your profile.</p>
            <button type="button" onClick={() => navigate("/v2/settings/profile", { replace: true })} className="mt-3 text-sm font-medium text-primary hover:underline">
              Go to Profile
            </button>
          </div>
        ) : section === "profile" && <ProfileSection tabParam={new URLSearchParams(search).get("tab")} />}
        {section === "signature" && <SignatureSectionForMe />}
        {section === "users-teams" && <Embedded><EmbeddedTeam /></Embedded>}
        {section === "system-activity" && <Embedded><EmbeddedAudit /></Embedded>}
        {section === "custom-fields" && <Embedded><EmbeddedCustomFields /></Embedded>}
        {section === "notifications" && <Embedded><EmbeddedNotificationPrefs /></Embedded>}
        {section === "mailboxes" && <MailboxesSection />}
        {section === "voice-agents" && <VoiceAgentsSection />}
        {section === "knowledge" && <KnowledgeSection />}
        {section === "branding" && <BrandingSection />}
        {section === "social-accounts" && <SocialAccountsSection />}
        {section === "data-sources" && (
          <div className="space-y-4" data-tour-id="settings-data-sources">
            <ProspectSourceRegistryCard />
            <WarmySenderSourceCard />
            <QuickEnrichSourceCard />
            <ApolloSourceCard />
            <LeadOceanSourceCard />
            <ReoonVerifierCard />
          </div>
        )}
        {/* Legacy /settings tabs, collapsed into the hub 2026-09-15. */}
        {section === "workspace" && <LegacySettingsSection tab="general" title="Workspace overview" />}
        {section === "appearance" && <LegacySettingsSection tab="my-profile" title="Appearance" />}
        {section === "security" && <LegacySettingsSection tab="security" title="Security" />}
        {section === "notification-policy" && <LegacySettingsSection tab="notifications" title="Notification policy" />}
        {section === "integrations" && <LegacySettingsSection tab="integrations" title="Integrations" />}
        {section === "email-delivery" && <LegacySettingsSection tab="smtp" title="Email delivery" />}
        {section === "proposals" && <LegacySettingsSection tab="proposals" title="Proposals" />}
        {section === "billing" && <LegacySettingsSection tab="billing" title="Billing and credits" />}
        {section === "enrichment-sweep" && <LegacySettingsSection tab="enrichment" title="Enrichment sweep" />}
        {section === "danger" && <LegacySettingsSection tab="danger" title="Danger zone" />}
      </main>
    </div>
  );
}

/* ───────────────────────── Profile subpage ────────────────────────────── */

const PROFILE_TABS: ReadonlyArray<{ id: ProfileTabId; label: string }> = [
  { id: "general", label: "General" },
  // "Security" since 2026-11-07 (F3, G15): 2FA, backup codes and where you are signed in.
  { id: "mfa", label: "Security" },
  { id: "email-settings", label: "Email settings" },
];
type ProfileTab = ProfileTabId;

/** The signature section, with whether this person may edit the workspace default. */
function SignatureSectionForMe() {
  const me = trpc.profile.getMe.useQuery();
  return <SignatureSection isAdmin={isAdminRole(me.data?.role)} />;
}

function ProfileSection({ tabParam }: { tabParam?: string | null }) {
  // Deep links to a tab (U9): /v2/settings/profile?tab=mfa opens Security.
  // Picking a tab writes it back, so the address is shareable.
  const [, navigateTab] = useLocation();
  const asked: ProfileTab = (PROFILE_TAB_IDS as readonly string[]).includes(tabParam === "security" ? "mfa" : tabParam ?? "") ? ((tabParam === "security" ? "mfa" : tabParam) as ProfileTab) : "general";
  const [tab, setTabState] = useState<ProfileTab>(asked);
  useEffect(() => { setTabState(asked); }, [asked]);
  const setTab = (t: ProfileTab) => { setTabState(t); navigateTab(t === "general" ? "/v2/settings/profile" : `/v2/settings/profile?tab=${t}`, { replace: true }); };
  const utils = trpc.useUtils();

  const me = trpc.profile.getMe.useQuery();
  const wsSettings = trpc.settings.get.useQuery();
  const isAdmin = isAdminRole(me.data?.role);

  // form state, seeded from the server once loaded
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [title, setTitle] = useState("");
  const [quotaStr, setQuotaStr] = useState("");
  // workspace email sending prefs (migration 0117/0119) — admin-editable
  const [emailPrefs, setEmailPrefs] = useState({ unsubHeader: false, openTracking: true, clickTracking: true });
  const [optOut, setOptOut] = useState({ enabled: false, message: "" });
  const [seeded, setSeeded] = useState(false);
  useEffect(() => {
    if (!seeded && me.data && wsSettings.data) {
      const parts = (me.data.name ?? "").trim().split(/\s+/);
      setFirstName(parts[0] ?? "");
      setLastName(parts.slice(1).join(" "));
      setTitle(me.data.title ?? "");
      setQuotaStr(me.data.quota == null ? "" : String(me.data.quota));
      setEmailPrefs({
        unsubHeader: (wsSettings.data as any).emailUnsubscribeHeader === true,
        openTracking: (wsSettings.data as any).emailOpenTracking !== false,
        clickTracking: (wsSettings.data as any).emailClickTracking !== false,
      });
      setOptOut({
        enabled: (wsSettings.data as any).emailSequenceOptOutEnabled === true,
        message: (wsSettings.data as any).emailSequenceOptOutMessage ?? "",
      });
      setSeeded(true);
    }
  }, [me.data, wsSettings.data, seeded]);

  const savedName = (me.data?.name ?? "").trim();
  const formName = `${firstName.trim()} ${lastName.trim()}`.trim();
  const savedQuotaStr = me.data?.quota == null ? "" : String(me.data.quota);
  const emailPrefsDirty =
    seeded && !!wsSettings.data &&
    (emailPrefs.unsubHeader !== ((wsSettings.data as any).emailUnsubscribeHeader === true) ||
      emailPrefs.openTracking !== ((wsSettings.data as any).emailOpenTracking !== false) ||
      emailPrefs.clickTracking !== ((wsSettings.data as any).emailClickTracking !== false));
  const optOutDirty =
    seeded && !!wsSettings.data &&
    (optOut.enabled !== ((wsSettings.data as any).emailSequenceOptOutEnabled === true) ||
      optOut.message.trim() !== ((wsSettings.data as any).emailSequenceOptOutMessage ?? "").trim());
  const dirty =
    seeded &&
    (formName !== savedName ||
      title.trim() !== (me.data?.title ?? "").trim() ||
      (isAdmin && quotaStr.trim() !== savedQuotaStr) ||
      (isAdmin && (emailPrefsDirty || optOutDirty)));

  const updateMe = trpc.profile.updateMe.useMutation();
  const saveSettings = trpc.settings.save.useMutation();
  const [saving, setSaving] = useState(false);
  const saveAll = async () => {
    if (!formName) { toast.error("Name is required"); return; }
    const quotaNum = quotaStr.trim() === "" ? null : Number(quotaStr);
    if (isAdmin && quotaNum != null && (!Number.isFinite(quotaNum) || quotaNum < 0)) {
      toast.error("Annual quota must be a positive number");
      return;
    }
    setSaving(true);
    try {
      await updateMe.mutateAsync({
        name: formName,
        title: title.trim() || null,
        ...(isAdmin && quotaStr.trim() !== savedQuotaStr ? { quota: quotaNum } : {}),
      });
      if (isAdmin && (emailPrefsDirty || optOutDirty)) {
        await saveSettings.mutateAsync({
          emailUnsubscribeHeader: emailPrefs.unsubHeader,
          emailOpenTracking: emailPrefs.openTracking,
          emailClickTracking: emailPrefs.clickTracking,
          emailSequenceOptOutEnabled: optOut.enabled,
          emailSequenceOptOutMessage: optOut.message.trim() || null,
        } as any);
        utils.settings.get.invalidate();
      }
      utils.profile.getMe.invalidate();
      toast.success("Profile saved");
    } catch (e: any) {
      toast.error(e?.message ?? "Could not save profile");
    } finally {
      setSaving(false);
    }
  };

  const [pwOpen, setPwOpen] = useState(false);
  const [emailOpen, setEmailOpen] = useState(false);

  // Without the profile the form is blank, and Save would write the blanks
  // (audit X1.6): say it failed instead of offering an empty form.
  if (me.error && !me.data) {
    return <div className="px-4 sm:px-6 pt-4"><QueryError what="your profile" message={me.error.message} onRetry={() => { void me.refetch(); }} /></div>;
  }

  return (
    <>
      {/* header: title + save */}
      <div className="shrink-0 px-4 sm:px-6 pt-4 flex flex-wrap items-start justify-between gap-3">
        <h1 className="text-xl font-semibold tracking-tight">Profile</h1>
        <Button size="sm" disabled={!dirty || saving} onClick={saveAll} className="gap-1.5">
          {saving ? <Loader2 className="size-3.5 animate-spin" /> : null} Save
        </Button>
      </div>

      {/* tab strip */}
      <div {...tablistProps("Profile sections")} className="shrink-0 px-6 mt-2 border-b border-border flex items-center gap-5 overflow-x-auto">
        {PROFILE_TABS.map((t) => (
          <button {...tabProps(tab === t.id)}
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={cn(
              "pb-2.5 -mb-px border-b-2 text-[13px] whitespace-nowrap transition-colors",
              tab === t.id
                ? "border-foreground font-medium text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* body — light-grey canvas with centred white cards */}
      <div className="flex-1 min-h-0 overflow-y-auto bg-muted/40">
        <div className="mx-auto w-full max-w-[820px] px-4 sm:px-6 py-6 space-y-5">
          {me.isLoading ? (
            <div className="space-y-4">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="h-40 rounded-xl bg-card/70 animate-pulse" />
              ))}
            </div>
          ) : tab === "general" ? (
            <GeneralTab
              me={me.data}
              firstName={firstName} setFirstName={setFirstName}
              lastName={lastName} setLastName={setLastName}
              title={title} setTitle={setTitle}
              quotaStr={quotaStr} setQuotaStr={setQuotaStr}
              isAdmin={isAdmin}
              onEditEmail={() => setEmailOpen(true)}
              onEditPassword={() => setPwOpen(true)}
            />
          ) : tab === "mfa" ? (
            <MfaTab me={me.data} onEditPassword={() => setPwOpen(true)} />
          ) : (
            <EmailSettingsTab
              isAdmin={isAdmin}
              emailPrefs={emailPrefs}
              setEmailPrefs={setEmailPrefs}
              optOut={optOut}
              setOptOut={setOptOut}
            />
          )}
        </div>
      </div>

      <ChangePasswordDialog open={pwOpen} onClose={() => setPwOpen(false)} hasPassword={!!me.data?.hasPassword} />
      <ChangeEmailDialog open={emailOpen} onClose={() => setEmailOpen(false)} hasPassword={!!me.data?.hasPassword} currentEmail={me.data?.email ?? ""} />
    </>
  );
}

function SettingsCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-border/70 bg-card p-5 sm:p-6 space-y-4 shadow-sm">
      <h2 className="text-[15px] font-semibold">{title}</h2>
      {children}
    </section>
  );
}

/* ─────────────────────────── General tab ──────────────────────────────── */

function GeneralTab(props: {
  me: any;
  firstName: string; setFirstName: (v: string) => void;
  lastName: string; setLastName: (v: string) => void;
  title: string; setTitle: (v: string) => void;
  quotaStr: string; setQuotaStr: (v: string) => void;
  isAdmin: boolean;
  onEditEmail: () => void;
  onEditPassword: () => void;
}) {
  const { me, firstName, setFirstName, lastName, setLastName, title, setTitle, quotaStr, setQuotaStr, isAdmin, onEditEmail, onEditPassword } = props;
  const [, navigate] = useLocation();

  // Real per-user LinkedIn connection state (Unipile, scoped to the caller).
  const accounts = trpc.unipile.listConnectedAccounts.useQuery();
  const li = ((accounts.data ?? []) as any[]).find((a) => String(a.provider).toUpperCase().includes("LINKEDIN"));

  return (
    <>
      {/* Account Info */}
      <SettingsCard title="Account Info">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label>First name</Label>
            <Input aria-label="First name" value={firstName} onChange={(e) => setFirstName(e.target.value)} placeholder="First name" />
          </div>
          <div className="space-y-1.5">
            <Label>Last name</Label>
            <Input aria-label="Last name" value={lastName} onChange={(e) => setLastName(e.target.value)} placeholder="Last name" />
          </div>
        </div>
        <div className="space-y-1.5">
          <Label>Title</Label>
          <Input aria-label="Title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title" />
        </div>
        <div className="space-y-1.5">
          <Label>Login email</Label>
          <div className="flex items-center gap-2">
            <Input aria-label="Login email" value={me?.email ?? ""} disabled className="bg-muted/50" />
            <Button variant="outline" size="sm" className="shrink-0 gap-1.5" onClick={onEditEmail}>
              <Pencil className="size-3.5" /> Edit
            </Button>
          </div>
        </div>
        <div className="space-y-1.5">
          <Label>Password</Label>
          <div className="flex items-center gap-2">
            <Input aria-label="Password" value={me?.hasPassword ? "••••••••••" : ""} placeholder="No password set" disabled className="bg-muted/50" />
            <Button variant="outline" size="sm" className="shrink-0 gap-1.5" onClick={onEditPassword}>
              <Pencil className="size-3.5" /> Edit
            </Button>
          </div>
        </div>
      </SettingsCard>

      {/* CRM connection. Says what is true (audit 2026-10-20, G68): it used to
          show three made-up CRM tiles and "Your team has not connected a CRM",
          but there is no CRM integration to connect. Velocity is the CRM. */}
      <SettingsCard title="CRM connection">
        <div className="flex items-start gap-5">
          <div className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground"><Database className="size-6" aria-hidden="true" /></div>
          <div className="space-y-2 pt-1">
            <p className="text-[13px] text-muted-foreground">
              Your accounts, people and deals live in Velocity. Connecting an outside CRM such as Salesforce or HubSpot isn't available yet.
            </p>
            <Button variant="outline" size="sm" onClick={() => navigate("/v2/settings/integrations")}>See integrations</Button>
          </div>
        </div>
      </SettingsCard>

      {/* One label for the one number (G51): this is workspace_members.quota,
          the sales quota the Team page and Quota Management call "Annual
          quota". As "Credit Limit" it read as a spending cap, which it is not. */}
      <SettingsCard title="Quota">
        <div className="space-y-1.5 max-w-sm">
          <Label>Annual quota ($)</Label>
          <Input aria-label="Annual quota ($)"
            type="number"
            min={0}
            value={quotaStr}
            onChange={(e) => setQuotaStr(e.target.value)}
            disabled={!isAdmin}
            className={cn(!isAdmin && "bg-muted/50")}
          />
          <p className="text-xs text-muted-foreground">
            {isAdmin
              ? "Your sales target for the year in this workspace. Leave it blank for none."
              : "Your sales target for the year, set by a workspace admin. Blank means none is set."}
          </p>
        </div>
      </SettingsCard>

      {/* LinkedIn Prospector */}
      <SettingsCard title="LinkedIn Prospector">
        <p className="text-[13px] text-muted-foreground -mt-1">How would you like to prospect on LinkedIn?</p>
        <div className="flex items-center gap-3 rounded-lg border border-border/70 bg-muted/30 px-4 py-3">
          <span
            className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-[5px] bg-[#0A66C2] text-[11px] font-bold leading-none text-white"
            aria-hidden
          >
            in
          </span>
          {li ? (
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] font-medium">{li.displayName ?? "LinkedIn account"}</div>
              <div className="text-[11px] text-muted-foreground">
                {String(li.status).toUpperCase() === "OK" ? "Connected — powering social outreach and enrichment" : `Status: ${li.status}`}
              </div>
            </div>
          ) : (
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-medium">No LinkedIn account connected</div>
              <div className="text-[11px] text-muted-foreground">Connect your own account to search, message, and enrich compliantly.</div>
            </div>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" className="gap-1.5" onClick={() => navigate("/connected-accounts")}>
            <Plug className="size-3.5" /> {li ? "Manage connection" : "Connect LinkedIn"}
          </Button>
          <Button variant="outline" size="sm" className="gap-1.5" onClick={() => navigate("/find-prospects")}>
            <Search className="size-3.5" /> Search LinkedIn for prospects
          </Button>
        </div>
      </SettingsCard>
    </>
  );
}

/* ─────────────────────────── other tabs ───────────────────────────────── */

function StatusBadge({ connected }: { connected: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium",
        connected
          ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300"
          : "bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300",
      )}
    >
      {connected ? "Connected" : "Not connected"}
    </span>
  );
}

function MfaMethodRow({
  icon: Icon,
  name,
  connected,
  actionLabel,
  onAction,
}: {
  icon: any;
  name: string;
  connected: boolean;
  actionLabel: string;
  onAction: () => void;
}) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-border/70 bg-card px-4 py-3.5 shadow-sm">
      <Icon className="size-4 shrink-0 text-foreground/70" />
      <span className="text-[14px] font-medium">{name}</span>
      <StatusBadge connected={connected} />
      <div className="flex-1" />
      <Button variant="outline" size="sm" onClick={onAction}>{actionLabel}</Button>
    </div>
  );
}

function MfaTab({ me, onEditPassword: _onEditPassword }: { me: any; onEditPassword: () => void }) {
  const status = trpc.profile.getMfaStatus.useQuery();
  const totpConnected = !!status.data?.totp.connected;
  const backupLeft = Number(status.data?.backupCodes?.left ?? 0);
  const [totpOpen, setTotpOpen] = useState(false);
  const [disconnectOpen, setDisconnectOpen] = useState(false);
  const [backupOpen, setBackupOpen] = useState(false);
  const [smsOpen, setSmsOpen] = useState(false);

  return (
    <>
      <section className="rounded-xl border border-border/70 bg-card shadow-sm">
        <div className="border-b border-border/60 px-5 py-3.5 text-[13px] font-medium">Multi-factor authentication</div>
        <div className="space-y-3 p-4">
          {status.isLoading ? (
            <div className="h-24 rounded-xl bg-muted/50 animate-pulse" />
          ) : (
            <>
              <MfaMethodRow
                icon={KeyRound}
                name="Authenticator App"
                connected={totpConnected}
                actionLabel={totpConnected ? "Disconnect" : "Set up"}
                onAction={() => (totpConnected ? setDisconnectOpen(true) : setTotpOpen(true))}
              />
              {totpConnected && (
                /* Backup codes (audit 2026-10-20, G15): how many are left, and a
                   new set on demand, which replaces the old one. */
                <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border/70 bg-card px-4 py-3.5 shadow-sm" data-testid="backup-codes-row">
                  <ListChecks className="size-4 shrink-0 text-foreground/70" />
                  <span className="text-[14px] font-medium">Backup codes</span>
                  <span
                    className={cn(
                      "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium",
                      backupLeft > 2
                        ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300"
                        : "bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300",
                    )}
                  >
                    {backupLeft === 1 ? "1 code left" : `${backupLeft} codes left`}
                  </span>
                  <div className="flex-1" />
                  <Button variant="outline" size="sm" onClick={() => setBackupOpen(true)}>
                    {backupLeft > 0 ? "Make new codes" : "Make backup codes"}
                  </Button>
                </div>
              )}
              <MfaMethodRow
                icon={Smartphone}
                name="SMS authentication"
                connected={false}
                actionLabel="Set up"
                onAction={() => setSmsOpen(true)}
              />
            </>
          )}
        </div>
      </section>

      <SessionsCard />

      <TotpSetupDialog open={totpOpen} onClose={() => setTotpOpen(false)} />
      <TotpDisconnectDialog open={disconnectOpen} onClose={() => setDisconnectOpen(false)} hasPassword={!!me?.hasPassword} />
      <BackupCodesDialog open={backupOpen} onClose={() => setBackupOpen(false)} hasPassword={!!me?.hasPassword} />

      {/* SMS — honest unavailability, no fake flow */}
      <Dialog open={smsOpen} onOpenChange={(o) => !o && setSmsOpen(false)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>SMS authentication</DialogTitle>
            <DialogDescription>
              SMS codes need an SMS gateway, which isn't configured for this workspace yet. Use the
              Authenticator App method instead — it's more secure and works offline.
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="outline" size="sm" onClick={() => setSmsOpen(false)}>Close</Button>
            <Button size="sm" onClick={() => { setSmsOpen(false); setTotpOpen(true); }}>Set up authenticator app</Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

function TotpDisconnectDialog({ open, onClose, hasPassword }: { open: boolean; onClose: () => void; hasPassword: boolean }) {
  const utils = trpc.useUtils();
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const disable = trpc.profile.disableTotp.useMutation({
    onSuccess: () => {
      toast.success("Authenticator app disconnected");
      utils.profile.getMfaStatus.invalidate();
      setCode(""); setPassword("");
      onClose();
    },
    onError: (e: any) => toast.error(e?.message ?? "Could not disconnect"),
  });
  const valid = code.replace(/\s+/g, "").length === 6 || (hasPassword && password.length > 0);
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Disconnect authenticator app</DialogTitle>
          <DialogDescription>
            Password sign-ins will stop asking for a code. Confirm with a current authenticator code{hasPassword ? " or your password" : ""}.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>Authenticator code</Label>
            <Input aria-label="Authenticator code"
              inputMode="numeric"
              placeholder="6-digit code"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/[^\d\s]/g, ""))}
              className="tracking-widest"
            />
          </div>
          {hasPassword && (
            <div className="space-y-1.5">
              <Label>… or your password</Label>
              <Input aria-label="… or your password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
            </div>
          )}
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="outline" size="sm" onClick={onClose}>Cancel</Button>
          <Button
            variant="destructive"
            size="sm"
            disabled={!valid || disable.isPending}
            onClick={() => disable.mutate({
              code: code.replace(/\s+/g, "") || undefined,
              currentPassword: password || undefined,
            })}
            className="gap-1.5"
          >
            {disable.isPending ? <Loader2 className="size-3.5 animate-spin" /> : null} Disconnect
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Where you are signed in, and Sign out everywhere (audit 2026-10-20, F3).
 * Built from login history: each sign-in since 2026-11-07 records the session
 * it started, so the list is the ones still alive. Older sessions are not
 * listed, and the note says Sign out everywhere ends them too.
 */
function SessionsCard() {
  const utils = trpc.useUtils();
  const sessions = trpc.profile.listMySessions.useQuery();
  const signOutOne = trpc.profile.signOutSession.useMutation({
    onSuccess: () => { toast.success("That session is signed out"); utils.profile.listMySessions.invalidate(); },
    onError: (e: any) => toast.error(e?.message ?? "Could not sign that session out"),
  });
  const signOutAll = trpc.profile.signOutEverywhere.useMutation({
    onSuccess: () => { toast.success("Signed out everywhere else. This browser stays signed in."); utils.profile.listMySessions.invalidate(); },
    onError: (e: any) => toast.error(e?.message ?? "Could not sign out everywhere"),
  });
  const list = (sessions.data ?? []) as Array<{ id: number; device: string; ipAddress: string | null; signedInAt: string | Date; current: boolean }>;
  return (
    <section className="rounded-xl border border-border/70 bg-card shadow-sm" data-testid="sessions-card">
      <div className="flex flex-wrap items-center gap-2 border-b border-border/60 px-5 py-3.5">
        <span className="text-[13px] font-medium">Where you're signed in</span>
        <div className="flex-1" />
        <Button
          variant="outline"
          size="sm"
          disabled={signOutAll.isPending}
          onClick={() => confirmAction({
            title: "Sign out everywhere?",
            description: "Every session on every other device and browser ends now, including any you can't see in this list. This browser stays signed in.",
            confirmLabel: "Sign out everywhere",
          }, () => signOutAll.mutate())}
        >
          {signOutAll.isPending ? <Loader2 className="size-3.5 animate-spin" /> : null} Sign out everywhere
        </Button>
      </div>
      <div className="p-4 space-y-2">
        {sessions.isLoading ? (
          <div className="h-16 rounded-xl bg-muted/50 animate-pulse" />
        ) : list.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">No sessions recorded yet. Sign-ins from now on are listed here.</p>
        ) : (
          <ul className="divide-y divide-border/60">
            {list.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-3 py-2.5">
                <Monitor className="size-4 shrink-0 text-foreground/70" aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-medium">
                    {s.device}
                    {s.current && <span className="ml-2 rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-medium text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300">This browser</span>}
                  </div>
                  <div className="text-[11px] text-muted-foreground">
                    {s.ipAddress ?? "Unknown address"} · signed in {new Date(s.signedInAt).toLocaleString()}
                  </div>
                </div>
                {!s.current && (
                  <Button variant="ghost" size="sm" disabled={signOutOne.isPending} onClick={() => signOutOne.mutate({ id: s.id })}>
                    Sign out
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
        <p className="text-[11px] text-muted-foreground">
          Sessions started before 7 November 2026 aren't listed. Sign out everywhere ends them too.
        </p>
      </div>
    </section>
  );
}

/**
 * A new set of backup codes (G15): confirmed with a current authenticator code
 * or the password, then shown once. The old set stops working.
 */
function BackupCodesDialog({ open, onClose, hasPassword }: { open: boolean; onClose: () => void; hasPassword: boolean }) {
  const utils = trpc.useUtils();
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [codes, setCodes] = useState<string[] | null>(null);
  const close = () => { setCode(""); setPassword(""); setCodes(null); onClose(); };
  const regen = trpc.profile.regenerateBackupCodes.useMutation({
    onSuccess: (r: any) => {
      setCodes(r?.backupCodes ?? []);
      utils.profile.getMfaStatus.invalidate();
    },
    onError: (e: any) => toast.error(e?.message ?? "Could not make new backup codes"),
  });
  const valid = code.replace(/\s+/g, "").length === 6 || (hasPassword && password.length > 0);
  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{codes ? "Your new backup codes" : "Make new backup codes"}</DialogTitle>
          <DialogDescription>
            {codes
              ? "Your old codes no longer work."
              : `A new set replaces your old codes, which stop working. Confirm with a current authenticator code${hasPassword ? " or your password" : ""}.`}
          </DialogDescription>
        </DialogHeader>
        {codes ? (
          <div className="space-y-4">
            <BackupCodesPanel codes={codes} />
            <div className="flex justify-end pt-1">
              <Button size="sm" onClick={close}>I've saved them</Button>
            </div>
          </div>
        ) : (
          <>
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label>Authenticator code</Label>
                <Input aria-label="Authenticator code"
                  inputMode="numeric"
                  placeholder="6-digit code"
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/[^\d\s]/g, ""))}
                  className="tracking-widest"
                />
              </div>
              {hasPassword && (
                <div className="space-y-1.5">
                  <Label>… or your password</Label>
                  <Input aria-label="… or your password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
                </div>
              )}
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <Button variant="outline" size="sm" onClick={close}>Cancel</Button>
              <Button
                size="sm"
                disabled={!valid || regen.isPending}
                onClick={() => regen.mutate({
                  code: code.replace(/\s+/g, "") || undefined,
                  currentPassword: password || undefined,
                })}
                className="gap-1.5"
              >
                {regen.isPending ? <Loader2 className="size-3.5 animate-spin" /> : null} Make new codes
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

type EmailPrefs = { unsubHeader: boolean; openTracking: boolean; clickTracking: boolean };
type OptOut = { enabled: boolean; message: string };

function EmailSettingsTab({
  isAdmin,
  emailPrefs,
  setEmailPrefs,
  optOut,
  setOptOut,
}: {
  isAdmin: boolean;
  emailPrefs: EmailPrefs;
  setEmailPrefs: (p: EmailPrefs) => void;
  optOut: OptOut;
  setOptOut: (p: OptOut) => void;
}) {
  const [, navigate] = useLocation();
  const adminHint = isAdmin ? undefined : "Only workspace admins can change sending preferences";

  const CheckRow = ({
    checked,
    onChange,
    label,
    helper,
  }: {
    checked: boolean;
    onChange: (v: boolean) => void;
    label: string;
    helper?: string;
  }) => (
    <div title={adminHint}>
      <label className={cn("flex items-center gap-2.5 text-[13px]", isAdmin ? "cursor-pointer" : "opacity-70")}>
        <Checkbox checked={checked} disabled={!isAdmin} onCheckedChange={(v) => onChange(v === true)} />
        {label}
      </label>
      {helper && <p className="mt-1 pl-[26px] text-xs text-muted-foreground">{helper}</p>}
    </div>
  );

  return (
    <>
      <SettingsCard title="Email Settings">
        {/* wide bordered mailboxes button */}
        <Button
          variant="outline"
          className="w-full justify-center text-[13px] font-medium"
          onClick={() => navigate("/v2/settings/mailboxes")}
        >
          Manage Mailboxes
        </Button>

        {/* The signature lives on one page (G51); this said it was set per
            mailbox, which is true only of mail sent through a mailbox. */}
        <p className="text-[13px] text-muted-foreground">
          Your signature, the workspace default and each mailbox's are on{" "}
          <button
            type="button"
            onClick={() => navigate("/v2/settings/signature")}
            className="font-medium text-foreground underline underline-offset-2 hover:opacity-80"
          >
            Email signature
          </button>.
        </p>

        <div className="space-y-3 pt-1">
          {/* Always on since 2026-10-26 (audit O15): every sales email carries an
              unsubscribe link and the one-click headers, so this is no longer a choice. */}
          <p className="text-xs text-muted-foreground">
            Every email includes an unsubscribe link and one-click unsubscribe headers. Gmail and Yahoo require them.
          </p>
          <CheckRow
            checked={emailPrefs.openTracking}
            onChange={(v) => setEmailPrefs({ ...emailPrefs, openTracking: v })}
            label="Enable open tracking"
            helper="Applies to every send path, including Revenue Engine campaigns."
          />
          <CheckRow
            checked={emailPrefs.clickTracking}
            onChange={(v) => setEmailPrefs({ ...emailPrefs, clickTracking: v })}
            label="Enable click tracking"
            helper="Applies to inbox and sequence sends. Revenue Engine campaigns never rewrite links — a tracking domain on every URL is a known spam signal for cold outbound."
          />
        </div>

        {/* sequence opt-out footer (migration 0119) — appended after the body
            in sequence sends; the <%...%> bracket becomes a one-click
            unsubscribe link. Admin-gated like the other sending prefs. */}
        <div className="space-y-2 pt-1" title={adminHint}>
          <label className={cn("flex items-center gap-2.5 text-[13px]", isAdmin ? "cursor-pointer" : "opacity-70")}>
            <Switch
              checked={optOut.enabled}
              disabled={!isAdmin}
              onCheckedChange={(v) => setOptOut({ ...optOut, enabled: v })}
            />
            Append a sequences opt-out message after my signature
          </label>
          <textarea aria-label="Append a sequences opt-out message after my signature"
            rows={4}
            disabled={!isAdmin || !optOut.enabled}
            value={optOut.message}
            onChange={(e) => setOptOut({ ...optOut, message: e.target.value })}
            placeholder={"If you don't want to hear from me again, please <%let me know%>."}
            className={cn(
              "w-full rounded-md border px-3 py-2 text-[13px] outline-none transition-colors",
              isAdmin && optOut.enabled
                ? "border-border bg-background focus:ring-2 focus:ring-ring"
                : "border-border/60 bg-muted/50 text-muted-foreground/70",
            )}
          />
          <p className="text-xs text-muted-foreground">
            {"Surround your opt-out link with brackets '<%' and '%>'. E.g. If you don't want to hear from me, you can <%unsubscribe here%>."}
          </p>
        </div>

        {isAdmin && (
          <div className="pt-1">
            <Button variant="outline" size="sm" className="gap-1.5" onClick={() => navigate("/v2/settings/email-delivery")}>
              <Send className="size-3.5" /> Workspace email delivery
            </Button>
          </div>
        )}
      </SettingsCard>
    </>
  );
}

/* ───────────────────── change password / email ────────────────────────── */

function ChangePasswordDialog({ open, onClose, hasPassword }: { open: boolean; onClose: () => void; hasPassword: boolean }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const change = trpc.profile.changeMyPassword.useMutation({
    onSuccess: () => {
      toast.success(hasPassword ? "Password changed" : "Password set");
      setCurrent(""); setNext(""); setConfirm("");
      onClose();
    },
    onError: (e: any) => toast.error(e?.message ?? "Could not change password"),
  });
  const valid = next.length >= 8 && next === confirm && (!hasPassword || current.length > 0);
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{hasPassword ? "Change password" : "Set a password"}</DialogTitle>
          <DialogDescription>
            {hasPassword
              ? "Enter your current password, then choose a new one (8+ characters)."
              : "Add a password so you can sign in with email + password (8+ characters)."}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {hasPassword && (
            <div className="space-y-1.5">
              <Label>Current password</Label>
              <Input aria-label="Current password" type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" />
            </div>
          )}
          <div className="space-y-1.5">
            <Label>New password</Label>
            <Input aria-label="New password" type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" />
          </div>
          <div className="space-y-1.5">
            <Label>Confirm new password</Label>
            <Input aria-label="Confirm new password" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
            {confirm && next !== confirm && <p className="text-xs text-rose-600">Passwords don't match.</p>}
          </div>
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="outline" size="sm" onClick={onClose}>Cancel</Button>
          <Button
            size="sm"
            disabled={!valid || change.isPending}
            onClick={() => change.mutate({ currentPassword: hasPassword ? current : undefined, newPassword: next })}
            className="gap-1.5"
          >
            {change.isPending ? <Loader2 className="size-3.5 animate-spin" /> : null}
            {hasPassword ? "Change password" : "Set password"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ChangeEmailDialog({ open, onClose, hasPassword, currentEmail }: { open: boolean; onClose: () => void; hasPassword: boolean; currentEmail: string }) {
  const utils = trpc.useUtils();
  const [next, setNext] = useState("");
  const [password, setPassword] = useState("");
  const change = trpc.profile.changeMyEmail.useMutation({
    onSuccess: (r: any) => {
      // Nothing has changed yet (audit G32): the new address must confirm.
      toast.success(`We sent a confirmation link to ${r.email}. Your login email changes when you open it.`);
      utils.profile.getMe.invalidate();
      setNext(""); setPassword("");
      onClose();
    },
    onError: (e: any) => toast.error(e?.message ?? "Could not change email"),
  });
  const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(next.trim()) && password.length > 0;
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Change login email</DialogTitle>
          <DialogDescription>
            {hasPassword
              ? `Currently ${currentEmail}. Confirm with your password. We'll email a link to the new address, and tell ${currentEmail}; the change happens when the link is opened.`
              : "Your sign-in is managed by your identity provider, so the login email can't be changed here."}
          </DialogDescription>
        </DialogHeader>
        {hasPassword ? (
          <>
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label>New email</Label>
                <Input aria-label="New email" type="email" value={next} onChange={(e) => setNext(e.target.value)} placeholder="you@company.com" autoComplete="email" />
              </div>
              <div className="space-y-1.5">
                <Label>Current password</Label>
                <Input aria-label="Current password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <Button variant="outline" size="sm" onClick={onClose}>Cancel</Button>
              <Button
                size="sm"
                disabled={!valid || change.isPending}
                onClick={() => change.mutate({ newEmail: next.trim(), currentPassword: password })}
                className="gap-1.5"
              >
                {change.isPending ? <Loader2 className="size-3.5 animate-spin" /> : null} Change email
              </Button>
            </div>
          </>
        ) : (
          <div className="flex justify-end pt-1">
            <Button variant="outline" size="sm" onClick={onClose}>Close</Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * Which workspace these settings belong to, and a way to change it without
 * leaving Settings (owner ask 2026-09-24: "most, if not all settings should
 * have a workspace switcher"). The hub renders outside the main Shell, so it
 * had no switcher and never said which workspace it was showing: an admin of
 * several workspaces edited whichever one they last picked elsewhere. The
 * switch itself is the shared one (WorkspaceContext.switchTo), which
 * invalidates every query; the hub's content is keyed by workspace id so
 * local form state resets with it.
 */
function SettingsWorkspaceSwitcher() {
  const { workspaces, current, switchTo, isLoading } = useWorkspace();
  const [open, setOpenState] = useState(false);
  // Search, once the list is long (U10); cleared when the panel closes.
  const [query, setQuery] = useState("");
  const setOpen = (v: boolean | ((o: boolean) => boolean)) => setOpenState((o) => {
    const next = typeof v === "function" ? v(o) : v;
    if (!next) setQuery("");
    return next;
  });
  const triggerRef = useRef<HTMLButtonElement>(null);
  // Hand-rolled disclosure, so the semantics Radix supplies for free have to be
  // written out (a11y 2026-10-28): the trigger says it opens a popup and
  // whether it is open, and Escape closes the panel and puts focus back on the
  // trigger rather than leaving it stranded. Same keydown shape as
  // ChatLauncher/HelpDrawer; same aria pair as Shell's AdminSettingsMenu.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
  return (
    <div className="relative min-w-0">
      <button
        ref={triggerRef}
        type="button"
        aria-label="Switch workspace"
        title="Which workspace these settings belong to"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={isLoading || !current}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full min-w-0 items-center gap-2 rounded-md border border-border bg-background px-2 py-1.5 text-[13px] hover:bg-muted"
      >
        <WsIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-left font-medium">{current?.name ?? "Loading…"}</span>
        <WsChevrons className="size-3.5 shrink-0 text-muted-foreground" />
      </button>
      {open && (
        <div className="absolute left-0 right-0 top-full z-40 mt-1 rounded-md border bg-popover p-1 shadow-lg">
          {/* Archived: badged, and open to super admins only (G36); a search
              box once the list is long (U10). The same list as the Shell's. */}
          <WorkspaceSwitchList
            workspaces={workspaces}
            currentId={current?.id}
            query={query}
            onQuery={setQuery}
            onPick={(id) => { setOpen(false); if (id !== current?.id) switchTo(id); }}
          />
        </div>
      )}
    </div>
  );
}
