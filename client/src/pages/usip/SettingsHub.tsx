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
 *   General        — account info, CRM connection, credit limit, LinkedIn
 *   MFA            — honest sign-in security state + password controls
 *   Custom fields  — live customFields.listDefs summary + manage link
 *   Email settings — sending prefs, sequence opt-out, mailbox links
 *   Conversations  — per-user notification routing (team.getNotifPrefs)
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useLocation, useParams } from "wouter";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
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
import { ApolloSourceCard } from "@/components/usip/settings/ApolloSourceCard";
import { BrandingSection } from "@/components/usip/settings/BrandingSection";
import {
  ArrowLeft,
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
  Plus,
  Cloud,
  Database,
  Share2,
  KeyRound,
  Smartphone,
  Phone,
  Copy,
  AudioLines,
} from "lucide-react";

/* ───────────────────────── section registry ───────────────────────────── */

type HubItem = {
  id: string;
  label: string;
  icon: any;
  /** Internal subpage id (renders in the content panel) … */
  internal?: boolean;
  /** … or an app route this row navigates to. */
  href?: string;
};
type HubGroup = { label: string; items: HubItem[] };

const GROUPS: HubGroup[] = [
  {
    label: "Personal settings",
    items: [
      { id: "profile", label: "Profile", icon: User, internal: true },
      { id: "mailboxes", label: "Mailboxes", icon: Mail, internal: true },
      { id: "phone-numbers", label: "Phone numbers", icon: Phone, href: "/v2/calls" },
      { id: "notifications", label: "Notifications", icon: Bell, href: "/notification-prefs" },
      { id: "my-linkedin", label: "My LinkedIn", icon: Link2, href: "/my-linkedin" },
    ],
  },
  {
    label: "Workspace settings",
    items: [
      { id: "workspace", label: "Workspace overview", icon: Building2, href: "/settings?tab=general" },
      { id: "users-teams", label: "Users and teams", icon: Users, href: "/team" },
      { id: "security", label: "Security", icon: ShieldCheck, href: "/settings?tab=security" },
      { id: "integrations", label: "Integrations", icon: Plug, href: "/settings?tab=integrations" },
      { id: "voice-agents", label: "Voice agents", icon: AudioLines, internal: true },
      { id: "data-sources", label: "Data sources", icon: Database, internal: true },
      { id: "email-delivery", label: "Email delivery", icon: Send, href: "/settings?tab=smtp" },
      { id: "branding", label: "Branding", icon: Palette, internal: true },
      { id: "billing", label: "Billing and credits", icon: CreditCard, href: "/settings?tab=billing" },
      { id: "system-activity", label: "System activity", icon: Activity, href: "/audit" },
    ],
  },
  {
    label: "Data management",
    items: [
      { id: "custom-fields", label: "Custom fields", icon: Tag, href: "/custom-fields" },
      { id: "imports", label: "Imports and exports", icon: Upload, href: "/import" },
      { id: "enrichment", label: "Data enrichment", icon: Sparkles, href: "/v2/data-enrichment" },
    ],
  },
];

/* ─────────────────────────────── page ─────────────────────────────────── */

export default function SettingsHub() {
  const params = useParams<{ section?: string }>();
  const [, navigate] = useLocation();
  const [query, setQuery] = useState("");

  // Unknown/absent section → Profile (the default landing subpage).
  const section = GROUPS.flatMap((g) => g.items).some((i) => i.internal && i.id === params.section)
    ? (params.section as string)
    : "profile";

  const filteredGroups = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return GROUPS;
    return GROUPS.map((g) => ({ ...g, items: g.items.filter((i) => i.label.toLowerCase().includes(q)) }))
      .filter((g) => g.items.length > 0);
  }, [query]);

  const go = (it: HubItem) => {
    if (it.internal) navigate(`/v2/settings/${it.id}`);
    else if (it.href) navigate(it.href);
  };

  return (
    <div className="h-screen flex bg-background text-foreground">
      {/* ── settings rail ── */}
      <aside className="hidden md:flex w-60 shrink-0 flex-col min-h-0 border-r border-border bg-card/30">
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
          <div className="flex h-8 items-center gap-2 rounded-md border border-border bg-background px-2">
            <Search className="size-3.5 shrink-0 text-muted-foreground" />
            <input
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
                  return (
                    <button
                      key={it.id}
                      type="button"
                      onClick={() => go(it)}
                      className={cn(
                        "w-full flex items-center gap-2.5 rounded-md px-3 py-1.5 text-left text-[13px] transition-colors",
                        active
                          ? "bg-primary/15 font-medium text-foreground"
                          : "text-foreground/85 hover:bg-muted hover:text-foreground",
                      )}
                    >
                      <it.icon className={cn("size-3.5 shrink-0", active ? "text-primary" : "text-muted-foreground")} />
                      <span className="truncate">{it.label}</span>
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
          <Button variant="outline" size="sm" className="w-full gap-1.5" onClick={() => navigate("/team")}>
            <UserPlus className="size-4" /> Add Teammates
          </Button>
        </div>
      </aside>

      {/* ── content panel ── */}
      <main className="flex-1 min-w-0 flex flex-col min-h-0">
        {/* mobile top bar (rail is hidden below md) */}
        <div className="md:hidden shrink-0 flex items-center gap-2 border-b border-border px-4 h-12">
          <button type="button" onClick={() => navigate("/")} className="flex items-center gap-1.5 text-sm font-semibold">
            <ArrowLeft className="size-4" /> Settings
          </button>
        </div>
        {section === "profile" && <ProfileSection />}
        {section === "mailboxes" && <MailboxesSection />}
        {section === "voice-agents" && <VoiceAgentsSection />}
        {section === "branding" && <BrandingSection />}
        {section === "data-sources" && (
          <div className="space-y-4">
            <ApolloSourceCard />
          </div>
        )}
      </main>
    </div>
  );
}

/* ───────────────────────── Profile subpage ────────────────────────────── */

const PROFILE_TABS = [
  { id: "general", label: "General" },
  { id: "mfa", label: "Multi-factor authentication" },
  { id: "email-settings", label: "Email settings" },
] as const;
type ProfileTab = (typeof PROFILE_TABS)[number]["id"];

function ProfileSection() {
  const [tab, setTab] = useState<ProfileTab>("general");
  const utils = trpc.useUtils();

  const me = trpc.profile.getMe.useQuery();
  const wsSettings = trpc.settings.get.useQuery();
  const isAdmin = me.data?.role === "admin" || me.data?.role === "super_admin";

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
      toast.error("Credit limit must be a positive number");
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

  return (
    <>
      {/* header: title + save */}
      <div className="shrink-0 px-6 pt-4 flex items-start justify-between gap-3">
        <h1 className="text-xl font-semibold tracking-tight">Profile</h1>
        <Button size="sm" disabled={!dirty || saving} onClick={saveAll} className="gap-1.5">
          {saving ? <Loader2 className="size-3.5 animate-spin" /> : null} Save
        </Button>
      </div>

      {/* tab strip */}
      <div className="shrink-0 px-6 mt-2 border-b border-border flex items-center gap-5 overflow-x-auto">
        {PROFILE_TABS.map((t) => (
          <button
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
            <Input value={firstName} onChange={(e) => setFirstName(e.target.value)} placeholder="First name" />
          </div>
          <div className="space-y-1.5">
            <Label>Last name</Label>
            <Input value={lastName} onChange={(e) => setLastName(e.target.value)} placeholder="Last name" />
          </div>
        </div>
        <div className="space-y-1.5">
          <Label>Title</Label>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title" />
        </div>
        <div className="space-y-1.5">
          <Label>Login email</Label>
          <div className="flex items-center gap-2">
            <Input value={me?.email ?? ""} disabled className="bg-muted/50" />
            <Button variant="outline" size="sm" className="shrink-0 gap-1.5" onClick={onEditEmail}>
              <Pencil className="size-3.5" /> Edit
            </Button>
          </div>
        </div>
        <div className="space-y-1.5">
          <Label>Password</Label>
          <div className="flex items-center gap-2">
            <Input value={me?.hasPassword ? "••••••••••" : ""} placeholder="No password set" disabled className="bg-muted/50" />
            <Button variant="outline" size="sm" className="shrink-0 gap-1.5" onClick={onEditPassword}>
              <Pencil className="size-3.5" /> Edit
            </Button>
          </div>
        </div>
      </SettingsCard>

      {/* CRM connection */}
      <SettingsCard title="CRM connection">
        <div className="flex items-start gap-5">
          <div className="grid grid-cols-2 gap-2 shrink-0">
            <button
              type="button"
              title="Browse integrations"
              onClick={() => navigate("/settings?tab=integrations")}
              className="flex size-12 items-center justify-center rounded-xl border-2 border-dashed border-amber-400/70 text-amber-500 transition-colors hover:bg-amber-50 dark:hover:bg-amber-950/30"
            >
              <Plus className="size-6" />
            </button>
            <div className="flex size-12 items-center justify-center rounded-xl bg-orange-500 text-white shadow-sm"><Share2 className="size-6" /></div>
            <div className="flex size-12 items-center justify-center rounded-xl bg-emerald-600 text-white shadow-sm"><Database className="size-6" /></div>
            <div className="flex size-12 items-center justify-center rounded-xl bg-sky-500 text-white shadow-sm"><Cloud className="size-6" /></div>
          </div>
          <p className="text-[13px] text-muted-foreground pt-1">Your team has not connected a CRM</p>
        </div>
      </SettingsCard>

      {/* Restrictions */}
      <SettingsCard title="Restrictions">
        <div className="space-y-1.5 max-w-sm">
          <Label>Credit Limit</Label>
          <Input
            type="number"
            min={0}
            value={quotaStr}
            onChange={(e) => setQuotaStr(e.target.value)}
            disabled={!isAdmin}
            className={cn(!isAdmin && "bg-muted/50")}
          />
          <p className="text-xs text-muted-foreground">
            {isAdmin
              ? "Leave this field blank if no limit is required"
              : "Set by your workspace admin. Leave blank means no limit."}
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
  const [totpOpen, setTotpOpen] = useState(false);
  const [disconnectOpen, setDisconnectOpen] = useState(false);
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

      <TotpSetupDialog open={totpOpen} onClose={() => setTotpOpen(false)} />
      <TotpDisconnectDialog open={disconnectOpen} onClose={() => setDisconnectOpen(false)} hasPassword={!!me?.hasPassword} />

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

/** Two-step authenticator enrollment: show the minted secret, then confirm a live code. */
function TotpSetupDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const utils = trpc.useUtils();
  const [enroll, setEnroll] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [code, setCode] = useState("");
  const start = trpc.profile.startTotpEnrollment.useMutation({
    onSuccess: (r: any) => setEnroll(r),
    onError: (e: any) => { toast.error(e?.message ?? "Could not start enrollment"); onClose(); },
  });
  const confirm = trpc.profile.confirmTotpEnrollment.useMutation({
    onSuccess: () => {
      toast.success("Authenticator app connected — codes are now required at password sign-in");
      utils.profile.getMfaStatus.invalidate();
      setEnroll(null); setCode("");
      onClose();
    },
    onError: (e: any) => toast.error(e?.message ?? "Could not confirm the code"),
  });

  // Mint a fresh secret each time the dialog opens.
  useEffect(() => {
    if (open && !enroll && !start.isPending) start.mutate();
    if (!open) { setEnroll(null); setCode(""); }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const groupedSecret = enroll ? (enroll.secret.match(/.{1,4}/g) ?? []).join(" ") : "";

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Set up authenticator app</DialogTitle>
          <DialogDescription>
            Add Velocity to Google Authenticator, Microsoft Authenticator, 1Password or any TOTP app,
            then confirm with the 6-digit code it shows.
          </DialogDescription>
        </DialogHeader>
        {!enroll ? (
          <div className="flex items-center justify-center py-8 text-muted-foreground">
            <Loader2 className="size-5 animate-spin" />
          </div>
        ) : (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label>Setup key (enter manually in your app)</Label>
              <div className="flex items-center gap-2">
                <code className="flex-1 rounded-md border border-border bg-muted/40 px-3 py-2 text-[13px] tracking-wider break-all">
                  {groupedSecret}
                </code>
                <Button
                  variant="outline"
                  size="sm"
                  className="shrink-0"
                  title="Copy setup key"
                  onClick={() => {
                    const w = navigator.clipboard?.writeText(enroll.secret);
                    if (w) w.then(() => toast.success("Setup key copied"), () => toast.error("Could not copy"));
                  }}
                >
                  <Copy className="size-3.5" />
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                On this device? <a href={enroll.otpauthUrl} className="font-medium text-foreground underline underline-offset-2">Open in authenticator app</a>
              </p>
            </div>
            <div className="space-y-1.5">
              <Label>Verification code</Label>
              <Input
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="6-digit code"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/[^\d\s]/g, ""))}
                className="tracking-widest"
              />
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <Button variant="outline" size="sm" onClick={onClose}>Cancel</Button>
              <Button
                size="sm"
                disabled={code.replace(/\s+/g, "").length !== 6 || confirm.isPending}
                onClick={() => confirm.mutate({ code: code.replace(/\s+/g, "") })}
                className="gap-1.5"
              >
                {confirm.isPending ? <Loader2 className="size-3.5 animate-spin" /> : null} Verify & connect
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
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
            <Input
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
              <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
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

        <p className="text-[13px] text-muted-foreground">
          Your signature is set per mailbox — open a mailbox from{" "}
          <button
            type="button"
            onClick={() => navigate("/v2/settings/mailboxes")}
            className="font-medium text-foreground underline underline-offset-2 hover:opacity-80"
          >
            Mailboxes
          </button>{" "}
          to edit its signature.
        </p>

        <div className="space-y-3 pt-1">
          <CheckRow
            checked={emailPrefs.unsubHeader}
            onChange={(v) => setEmailPrefs({ ...emailPrefs, unsubHeader: v })}
            label="Include one-click unsubscribe headers"
            helper="Recommended for organizations that send 5,000 emails or more within a 24-hour period."
          />
          <CheckRow
            checked={emailPrefs.openTracking}
            onChange={(v) => setEmailPrefs({ ...emailPrefs, openTracking: v })}
            label="Enable open tracking"
          />
          <CheckRow
            checked={emailPrefs.clickTracking}
            onChange={(v) => setEmailPrefs({ ...emailPrefs, clickTracking: v })}
            label="Enable click tracking"
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
          <textarea
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
            <Button variant="outline" size="sm" className="gap-1.5" onClick={() => navigate("/settings?tab=smtp")}>
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
              <Input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" />
            </div>
          )}
          <div className="space-y-1.5">
            <Label>New password</Label>
            <Input type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" />
          </div>
          <div className="space-y-1.5">
            <Label>Confirm new password</Label>
            <Input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
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
      toast.success(`Login email changed to ${r.email}`);
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
              ? `Currently ${currentEmail}. Confirm with your password — you'll use the new email at your next sign-in.`
              : "Your sign-in is managed by your identity provider, so the login email can't be changed here."}
          </DialogDescription>
        </DialogHeader>
        {hasPassword ? (
          <>
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label>New email</Label>
                <Input type="email" value={next} onChange={(e) => setNext(e.target.value)} placeholder="you@company.com" autoComplete="email" />
              </div>
              <div className="space-y-1.5">
                <Label>Current password</Label>
                <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
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
