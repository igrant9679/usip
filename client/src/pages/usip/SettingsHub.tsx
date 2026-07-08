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
 * All settings" opens /v2/settings/profile.
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
import { useTheme, PALETTES } from "@/contexts/ThemeContext";
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
  KeyRound,
  CheckCircle2,
  Loader2,
  Send,
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
      { id: "notifications", label: "Notifications", icon: Bell, href: "/notification-prefs" },
      { id: "mailboxes", label: "Mailboxes & accounts", icon: Mail, href: "/connected-accounts" },
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
      { id: "email-delivery", label: "Email delivery", icon: Send, href: "/settings?tab=smtp" },
      { id: "branding", label: "Branding", icon: Palette, href: "/settings?tab=branding" },
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
                          ? "bg-foreground text-background font-medium"
                          : "text-foreground/85 hover:bg-muted hover:text-foreground",
                      )}
                    >
                      <it.icon className={cn("size-3.5 shrink-0", active ? "text-background" : "text-muted-foreground")} />
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
      </main>
    </div>
  );
}

/* ───────────────────────── Profile subpage ────────────────────────────── */

const PROFILE_TABS = [
  { id: "general", label: "General" },
  { id: "appearance", label: "Appearance" },
] as const;
type ProfileTab = (typeof PROFILE_TABS)[number]["id"];

function ProfileSection() {
  const [, navigate] = useLocation();
  const [tab, setTab] = useState<ProfileTab>("general");
  const utils = trpc.useUtils();

  const me = trpc.profile.getMe.useQuery();
  const sig = trpc.profile.getMySignature.useQuery();

  // form state, seeded from the server once loaded
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [title, setTitle] = useState("");
  const [signature, setSignature] = useState("");
  const [seeded, setSeeded] = useState(false);
  useEffect(() => {
    if (!seeded && me.data && sig.data) {
      const parts = (me.data.name ?? "").trim().split(/\s+/);
      setFirstName(parts[0] ?? "");
      setLastName(parts.slice(1).join(" "));
      setTitle(me.data.title ?? "");
      setSignature(sig.data.emailSignature ?? "");
      setSeeded(true);
    }
  }, [me.data, sig.data, seeded]);

  const savedName = (me.data?.name ?? "").trim();
  const formName = `${firstName.trim()} ${lastName.trim()}`.trim();
  const dirty =
    seeded &&
    (formName !== savedName ||
      title.trim() !== (me.data?.title ?? "").trim() ||
      signature.trim() !== (sig.data?.emailSignature ?? "").trim());

  const updateMe = trpc.profile.updateMe.useMutation();
  const updateSig = trpc.profile.updateMySignature.useMutation();
  const [saving, setSaving] = useState(false);
  const saveAll = async () => {
    if (!formName) { toast.error("Name is required"); return; }
    setSaving(true);
    try {
      await updateMe.mutateAsync({ name: formName, title: title.trim() || null });
      if (signature.trim() !== (sig.data?.emailSignature ?? "").trim()) {
        await updateSig.mutateAsync({ emailSignature: signature.trim() || null });
      }
      utils.profile.getMe.invalidate();
      utils.profile.getMySignature.invalidate();
      toast.success("Profile saved");
    } catch (e: any) {
      toast.error(e?.message ?? "Could not save profile");
    } finally {
      setSaving(false);
    }
  };

  const [pwOpen, setPwOpen] = useState(false);

  return (
    <>
      {/* header: title + save */}
      <div className="shrink-0 px-6 pt-5 flex items-start justify-between gap-3">
        <h1 className="text-xl font-semibold tracking-tight">Profile</h1>
        <Button size="sm" disabled={!dirty || saving} onClick={saveAll} className="gap-1.5">
          {saving ? <Loader2 className="size-3.5 animate-spin" /> : null} Save
        </Button>
      </div>

      {/* tab strip */}
      <div className="shrink-0 px-6 mt-3 border-b border-border flex items-center gap-5">
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

      {/* body */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-6 py-6 space-y-5">
          {me.isLoading ? (
            <div className="space-y-4">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="h-40 rounded-xl bg-muted/50 animate-pulse" />
              ))}
            </div>
          ) : tab === "general" ? (
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
                  <p className="text-xs text-muted-foreground">Shown to teammates and used in email merge fields.</p>
                </div>
                <div className="space-y-1.5">
                  <Label>Login email</Label>
                  <Input value={me.data?.email ?? ""} disabled className="bg-muted/40" />
                  <p className="text-xs text-muted-foreground">Your sign-in identity. Contact an admin to change it.</p>
                </div>
                <div className="space-y-1.5">
                  <Label>Password</Label>
                  <div className="flex items-center gap-2">
                    <Input value={me.data?.hasPassword ? "••••••••••" : ""} placeholder="No password set" disabled className="bg-muted/40" />
                    <Button variant="outline" size="sm" className="shrink-0 gap-1.5" onClick={() => setPwOpen(true)}>
                      <KeyRound className="size-3.5" /> {me.data?.hasPassword ? "Change" : "Set password"}
                    </Button>
                  </div>
                </div>
              </SettingsCard>

              {/* Email signature */}
              <SettingsCard title="Email signature">
                <p className="text-[13px] text-muted-foreground -mt-1">
                  Used in emails sent from your mailbox. Leave empty to use the workspace default signature.
                </p>
                <textarea
                  value={signature}
                  onChange={(e) => setSignature(e.target.value)}
                  rows={5}
                  placeholder={"Best regards,\nYour name"}
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-[13px] outline-none focus:ring-2 focus:ring-ring"
                />
              </SettingsCard>

              {/* Connected accounts */}
              <SettingsCard title="Connected accounts">
                <p className="text-[13px] text-muted-foreground -mt-1">
                  Your Outlook mailbox powers calendar invites and sequenced email; your LinkedIn account powers
                  social outreach and enrichment. Each teammate connects their own.
                </p>
                <div>
                  <Button variant="outline" size="sm" className="gap-1.5" onClick={() => navigate("/connected-accounts")}>
                    <Plug className="size-3.5" /> Manage connected accounts
                  </Button>
                </div>
              </SettingsCard>
            </>
          ) : (
            <AppearanceTab />
          )}
        </div>
      </div>

      <ChangePasswordDialog open={pwOpen} onClose={() => setPwOpen(false)} hasPassword={!!me.data?.hasPassword} />
    </>
  );
}

function SettingsCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-border bg-card p-5 sm:p-6 space-y-4">
      <h2 className="text-[15px] font-semibold">{title}</h2>
      {children}
    </section>
  );
}

/* ───────────────────────── change password ────────────────────────────── */

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

/* ─────────────────────────── appearance tab ───────────────────────────── */

function AppearanceTab() {
  const { theme, toggleTheme, palette, setPalette } = useTheme();
  const save = trpc.profile.updateMyAppearance.useMutation({
    onError: (e: any) => toast.error(e?.message ?? "Could not save theme"),
  });
  const pick = (id: (typeof PALETTES)[number]["id"]) => {
    setPalette(id);
    save.mutate({ themePalette: id });
  };
  return (
    <SettingsCard title="Appearance">
      <div className="space-y-1.5">
        <Label>Mode</Label>
        <div className="flex items-center gap-2">
          {(["light", "dark"] as const).map((m) => (
            <Button
              key={m}
              type="button"
              size="sm"
              variant={theme === m ? "default" : "outline"}
              className="capitalize"
              onClick={() => { if (theme !== m) toggleTheme?.(); }}
            >
              {m}
            </Button>
          ))}
        </div>
      </div>
      <div className="space-y-1.5">
        <Label>Colour theme</Label>
        <div className="flex flex-wrap gap-2">
          {PALETTES.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => pick(p.id)}
              title={p.label}
              className={cn(
                "flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-[13px] transition-colors hover:bg-muted",
                palette === p.id && "border-foreground/50 bg-muted font-medium",
              )}
            >
              <span className="size-4 rounded-full border shadow-sm" style={{ backgroundColor: p.swatch }} />
              {p.label}
              {palette === p.id && <CheckCircle2 className="size-3.5 text-muted-foreground" />}
            </button>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          Synced to your account — the theme follows you across devices.
        </p>
      </div>
    </SettingsCard>
  );
}
