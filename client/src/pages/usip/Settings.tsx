import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Section, StatusPill, fmt$ } from "@/components/usip/Common";
import { PageHeader, Shell, StatCard } from "@/components/usip/Shell";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { trpc } from "@/lib/trpc";
import { AlertTriangle, Bell, Building2, CheckCircle2, CreditCard, Download, ExternalLink, Loader2, Mail, Palette, Plug, ShieldCheck, TestTube2, Trash2, XCircle, Zap, Settings as SettingsIcon } from "lucide-react";
import { useReduceMotion } from "@/components/PageTransition";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

type NotifyPolicy = Record<string, { inApp: boolean; email: boolean }>;

const TABS = [
  { id: "general", label: "General", icon: Building2 },
  { id: "branding", label: "Branding", icon: Palette },
  { id: "security", label: "Security", icon: ShieldCheck },
  { id: "notifications", label: "Notifications", icon: Bell },
  { id: "integrations", label: "Integrations", icon: Plug },
  { id: "smtp", label: "Email Delivery", icon: Mail },
  { id: "proposals", label: "Proposals", icon: Zap },
  { id: "billing", label: "Billing", icon: CreditCard },
  { id: "danger", label: "Danger zone", icon: AlertTriangle },
] as const;

type TabId = (typeof TABS)[number]["id"];

const NOTIFY_EVENTS = [
  { key: "newLeadRouted", label: "New lead routed to me" },
  { key: "salesReadyCrossed", label: "A lead becomes Sales-Ready" },
  { key: "dealMoved", label: "A deal I own moves stage" },
  { key: "taskOverdue", label: "One of my tasks is overdue" },
  { key: "mention", label: "Someone @mentions me" },
];

export default function Settings() {
  const { current } = useWorkspace();
  const isAdmin = current?.role === "admin" || current?.role === "super_admin";
  const [tab, setTab] = useState<TabId>("general");

  const summary = trpc.workspace.summary.useQuery();
  const settings = trpc.settings.get.useQuery();
  const usage = trpc.usage.currentMonth.useQuery();
  const utils = trpc.useUtils();
  const save = trpc.settings.save.useMutation({
    onSuccess: () => {
      utils.settings.get.invalidate();
      toast.success("Settings saved");
    },
    onError: (e) => toast.error(e.message),
  });

  return (
    <Shell title="Settings">
      <PageHeader title="Workspace settings" description="Workspace settings covering general configuration, billing, integrations, and notification preferences. Changes here apply to all members unless overridden at the individual user level." pageKey="settings" 
        icon={<SettingsIcon className="size-5" />}
      />
      <div className="p-6 grid grid-cols-1 md:grid-cols-[220px_1fr] gap-6">
        {/* Tab nav */}
        <nav className="space-y-1">
          {TABS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={`w-full text-left flex items-center gap-2 px-3 py-2 rounded-md text-sm transition ${
                tab === id ? "bg-secondary font-medium" : "hover:bg-secondary/50 text-muted-foreground"
              }`}
            >
              <Icon className="size-4" />
              {label}
            </button>
          ))}
        </nav>

        {/* Right pane */}
        <div className="space-y-4 min-w-0">
          {/* Always-visible identity strip */}
          <Section title="Workspace">
            <div className="p-4 grid grid-cols-2 md:grid-cols-4 gap-4 text-sm min-w-0">
              <div className="min-w-0">
                <div className="text-xs text-muted-foreground">Name</div>
                <div className="font-medium truncate" title={current?.name ?? "—"}>
                  {current?.name ?? "—"}
                </div>
              </div>
              <div className="min-w-0">
                <div className="text-xs text-muted-foreground">Slug</div>
                <div className="font-mono truncate" title={current?.slug ?? "—"}>
                  {current?.slug ?? "—"}
                </div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Plan</div>
                <StatusPill tone="info">{current?.plan ?? "—"}</StatusPill>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Your role</div>
                <StatusPill
                  tone={
                    current?.role === "super_admin"
                      ? "danger"
                      : current?.role === "admin"
                        ? "warning"
                        : current?.role === "manager"
                          ? "info"
                          : "muted"
                  }
                >
                  {current?.role ?? "—"}
                </StatusPill>
              </div>
            </div>
          </Section>

          {tab === "general" && <GeneralTab settings={settings.data} save={save.mutate} canEdit={isAdmin} summary={summary.data} />}
          {tab === "branding" && <BrandingTab settings={settings.data} save={save.mutate} canEdit={isAdmin} />}
          {tab === "security" && <SecurityTab settings={settings.data} save={save.mutate} canEdit={isAdmin} />}
          {tab === "notifications" && <NotificationsTab settings={settings.data} save={save.mutate} canEdit={isAdmin} />}
          {tab === "integrations" && <IntegrationsTab />}
          {tab === "smtp" && <SmtpTab canEdit={isAdmin} />}
          {tab === "proposals" && <ProposalsTab settings={settings.data} save={save.mutate} canEdit={isAdmin} />}
          {tab === "billing" && <BillingTab usage={usage.data} />}
          {tab === "danger" && <DangerTab canEdit={isAdmin} />}
        </div>
      </div>
    </Shell>
  );
}

/* ─── Tabs ─────────────────────────────────────────────────────────────── */

function SmtpTab({ canEdit }: { canEdit: boolean }) {
  const utils = trpc.useUtils();
  const cfg = trpc.smtpConfig.get.useQuery();
  const save = trpc.smtpConfig.save.useMutation({
    onSuccess: () => { utils.smtpConfig.get.invalidate(); toast.success("SMTP config saved"); },
    onError: (e) => toast.error(e.message),
  });
  const test = trpc.smtpConfig.test.useMutation({
    onSuccess: () => toast.success("Test email sent successfully!"),
    onError: (e) => toast.error(e.message),
  });

  const [host, setHost] = useState("");
  const [port, setPort] = useState("587");
  const [secure, setSecure] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [fromName, setFromName] = useState("");
  const [fromEmail, setFromEmail] = useState("");
  const [replyTo, setReplyTo] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [testEmail, setTestEmail] = useState("");

  useEffect(() => {
    if (cfg.data) {
      setHost(cfg.data.host ?? "");
      setPort(String(cfg.data.port ?? 587));
      setSecure(cfg.data.secure ?? false);
      setUsername(cfg.data.username ?? "");
      setFromName(cfg.data.fromName ?? "");
      setFromEmail(cfg.data.fromEmail ?? "");
      setReplyTo(cfg.data.replyTo ?? "");
      setEnabled(cfg.data.enabled ?? true);
    }
  }, [cfg.data]);

  return (
    <Section title="Email Delivery (SMTP)" description="Configure outbound SMTP so approved email drafts are sent via your own mail server.">
      <div className="grid gap-4 max-w-xl">
        {cfg.data?.lastTestStatus && (
          <div className={`flex items-center gap-2 text-sm px-3 py-2 rounded-md ${cfg.data.lastTestStatus === "ok" ? "bg-green-500/10 text-green-600" : "bg-red-500/10 text-red-600"}`}>
            {cfg.data.lastTestStatus === "ok" ? <CheckCircle2 className="size-4" /> : <XCircle className="size-4" />}
            Last test: {cfg.data.lastTestStatus === "ok" ? "Connection verified" : cfg.data.lastTestError ?? "Error"}
            {cfg.data.lastTestedAt && <span className="ml-auto text-xs text-muted-foreground">{new Date(cfg.data.lastTestedAt).toLocaleString()}</span>}
          </div>
        )}
        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2">
            <Label>SMTP Host</Label>
            <Input placeholder="smtp.gmail.com" value={host} onChange={(e) => setHost(e.target.value)} disabled={!canEdit} />
          </div>
          <div>
            <Label>Port</Label>
            <Input type="number" placeholder="587" value={port} onChange={(e) => setPort(e.target.value)} disabled={!canEdit} />
          </div>
          <div className="flex items-end gap-2">
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input type="checkbox" checked={secure} onChange={(e) => setSecure(e.target.checked)} disabled={!canEdit} className="rounded" />
              TLS/SSL (port 465)
            </label>
          </div>
          <div className="col-span-2">
            <Label>Username / Email</Label>
            <Input placeholder="you@example.com" value={username} onChange={(e) => setUsername(e.target.value)} disabled={!canEdit} />
          </div>
          <div className="col-span-2">
            <Label>Password {cfg.data ? "(leave blank to keep existing)" : ""}</Label>
            <Input type="password" placeholder={cfg.data ? "••••••••" : "App password"} value={password} onChange={(e) => setPassword(e.target.value)} disabled={!canEdit} />
          </div>
          <div>
            <Label>From Name</Label>
            <Input placeholder="Acme Sales" value={fromName} onChange={(e) => setFromName(e.target.value)} disabled={!canEdit} />
          </div>
          <div>
            <Label>From Email</Label>
            <Input placeholder="sales@acme.com" value={fromEmail} onChange={(e) => setFromEmail(e.target.value)} disabled={!canEdit} />
          </div>
          <div className="col-span-2">
            <Label>Reply-To (optional)</Label>
            <Input placeholder="replies@acme.com" value={replyTo} onChange={(e) => setReplyTo(e.target.value)} disabled={!canEdit} />
          </div>
        </div>
        {canEdit && (
          <div className="flex gap-2 flex-wrap">
            <Button
              size="sm"
              onClick={() => save.mutate({ host, port: parseInt(port) || 587, secure, username, password: password || undefined, fromName: fromName || undefined, fromEmail, replyTo: replyTo || undefined, enabled })}
              disabled={save.isPending || !host || !username || !fromEmail}
            >
              {save.isPending ? <Loader2 className="size-4 animate-spin mr-1" /> : null}
              Save config
            </Button>
            {cfg.data && (
              <div className="flex items-center gap-2">
                <Input placeholder="Test recipient email" value={testEmail} onChange={(e) => setTestEmail(e.target.value)} className="w-52" />
                <Button
                  size="sm" variant="outline"
                  onClick={() => test.mutate({ toEmail: testEmail })}
                  disabled={test.isPending || !testEmail}
                >
                  {test.isPending ? <Loader2 className="size-4 animate-spin mr-1" /> : <TestTube2 className="size-4 mr-1" />}
                  Send test
                </Button>
              </div>
            )}
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          Common settings: Gmail → smtp.gmail.com:587 (STARTTLS), port 465 (TLS). Outlook → smtp.office365.com:587. SendGrid → smtp.sendgrid.net:587 (username: apikey).
        </p>
      </div>
    </Section>
  );
}

function GeneralTab({
  settings,
  save,
  canEdit,
  summary,
}: {
  settings: any;
  save: (v: any) => void;
  canEdit: boolean;
  summary: any;
}) {
  const [timezone, setTimezone] = useState<string>("UTC");
  const [nightlyEnabled, setNightlyEnabled] = useState(false);
  const [nightlyThreshold, setNightlyThreshold] = useState(60);
  const [reduceMotion, setReduceMotionPref] = useReduceMotion();
  useEffect(() => {
    if (settings?.timezone) setTimezone(settings.timezone);
    if (settings?.nightlyPipelineEnabled !== undefined) setNightlyEnabled(!!settings.nightlyPipelineEnabled);
    if (settings?.nightlyScoreThreshold !== undefined) setNightlyThreshold(Number(settings.nightlyScoreThreshold));
  }, [settings?.timezone, settings?.nightlyPipelineEnabled, settings?.nightlyScoreThreshold]);

  return (
    <>
      <Section
        title="General"
        description="Default locale & workspace-wide timezone used for scheduling, reporting, and activity timestamps."
        right={
          canEdit ? (
            <Button size="sm" onClick={() => save({ timezone })}>
              Save
            </Button>
          ) : null
        }
      >
        <div className="p-4 grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-1">
            <Label>Timezone</Label>
            <Input value={timezone} onChange={(e) => setTimezone(e.target.value)} disabled={!canEdit} placeholder="UTC" />
            <div className="text-xs text-muted-foreground">Use an IANA zone (e.g. UTC, America/New_York, Europe/London).</div>
          </div>
        </div>
      </Section>

      <Section
        title="AI Nightly Pipeline"
        description="Automatically run the AI Research-to-Email pipeline each night for leads above a score threshold."
        right={
          canEdit ? (
            <Button size="sm" onClick={() => save({ nightlyPipelineEnabled: nightlyEnabled, nightlyScoreThreshold: nightlyThreshold })}>
              Save
            </Button>
          ) : null
        }
      >
        <div className="p-4 space-y-5">
          <div className="flex items-center gap-3">
            <Switch
              id="nightly-enabled"
              checked={nightlyEnabled}
              onCheckedChange={(v) => { if (canEdit) setNightlyEnabled(v); }}
              disabled={!canEdit}
            />
            <Label htmlFor="nightly-enabled" className="cursor-pointer">
              {nightlyEnabled ? "Enabled — runs every night at midnight (workspace timezone)" : "Disabled"}
            </Label>
          </div>
          <div className="space-y-2 max-w-sm">
            <div className="flex items-center justify-between">
              <Label>Minimum lead score to include</Label>
              <span className="text-sm font-semibold tabular-nums">{nightlyThreshold}</span>
            </div>
            <Slider
              min={0}
              max={100}
              step={5}
              value={[nightlyThreshold]}
              onValueChange={([v]) => setNightlyThreshold(v)}
              disabled={!canEdit || !nightlyEnabled}
            />
            <div className="text-xs text-muted-foreground">Only leads with a score ≥ {nightlyThreshold} will be included in the nightly batch.</div>
          </div>
        </div>
      </Section>

      <Section
        title="Appearance"
        description="Visual preferences stored locally in your browser — not synced across devices."
      >
        <div className="p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="rounded-lg p-2 bg-violet-500/10">
                <Zap className="size-4 text-violet-500" />
              </div>
              <div>
                <Label htmlFor="reduce-motion" className="cursor-pointer font-medium">Reduce motion</Label>
                <div className="text-xs text-muted-foreground mt-0.5">Disables page transition animations for a snappier feel or accessibility needs.</div>
              </div>
            </div>
            <Switch
              id="reduce-motion"
              checked={reduceMotion}
              onCheckedChange={setReduceMotionPref}
            />
          </div>
        </div>
      </Section>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
        <StatCard label="Accounts" value={summary?.accounts ?? 0} />
        <StatCard label="Contacts" value={summary?.contacts ?? 0} />
        <StatCard label="Leads" value={summary?.leads ?? 0} />
        <StatCard label="Opportunities" value={summary?.opportunities ?? 0} />
        <StatCard label="Open tasks" value={summary?.openTasks ?? 0} />
        <StatCard label="Pipeline value" value={fmt$(summary?.pipelineValue ?? 0)} />
        <StatCard label="Closed-won" value={fmt$(summary?.closedWon ?? 0)} tone="success" />
        <StatCard label="Customers" value={summary?.customers ?? 0} />
      </div>
    </>
  );
}

function BrandingTab({ settings, save, canEdit }: { settings: any; save: (v: any) => void; canEdit: boolean }) {
  const [primary, setPrimary] = useState("#14B89A");
  const [accent, setAccent] = useState("#0F766E");
  const [fromName, setFromName] = useState<string>("");
  const [sig, setSig] = useState<string>("");

  useEffect(() => {
    if (!settings) return;
    setPrimary(settings.brandPrimary ?? "#14B89A");
    setAccent(settings.brandAccent ?? "#0F766E");
    setFromName(settings.emailFromName ?? "");
    setSig(settings.emailSignature ?? "");
  }, [settings]);

  return (
    <Section
      title="Branding & email defaults"
      description="Drives color tokens, outbound email From-name, and signature appended to AI-drafted sends."
      right={
        canEdit ? (
          <Button
            size="sm"
            onClick={() => save({ brandPrimary: primary, brandAccent: accent, emailFromName: fromName || null, emailSignature: sig || null })}
          >
            Save
          </Button>
        ) : null
      }
    >
      <div className="p-4 grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="space-y-1">
          <Label>Primary color</Label>
          <div className="flex items-center gap-2">
            <Input type="color" value={primary} onChange={(e) => setPrimary(e.target.value)} disabled={!canEdit} className="w-16 p-1" />
            <Input value={primary} onChange={(e) => setPrimary(e.target.value)} disabled={!canEdit} className="font-mono" />
          </div>
        </div>
        <div className="space-y-1">
          <Label>Accent color</Label>
          <div className="flex items-center gap-2">
            <Input type="color" value={accent} onChange={(e) => setAccent(e.target.value)} disabled={!canEdit} className="w-16 p-1" />
            <Input value={accent} onChange={(e) => setAccent(e.target.value)} disabled={!canEdit} className="font-mono" />
          </div>
        </div>
        <div className="space-y-1 md:col-span-2">
          <Label>Email From-name</Label>
          <Input value={fromName} onChange={(e) => setFromName(e.target.value)} disabled={!canEdit} placeholder="LSI Media Sales" />
        </div>
        <div className="space-y-1 md:col-span-2">
          <Label>Default signature</Label>
          <textarea
            className="w-full min-h-28 rounded-md border bg-transparent px-3 py-2 text-sm"
            value={sig}
            onChange={(e) => setSig(e.target.value)}
            disabled={!canEdit}
            placeholder={"Best,\nJane Doe\nAE, LSI Media"}
          />
        </div>
      </div>
    </Section>
  );
}

function SecurityTab({ settings, save, canEdit }: { settings: any; save: (v: any) => void; canEdit: boolean }) {
  const [timeout_, setTimeout_] = useState<number>(480);
  const [ip, setIp] = useState<string>("");
  const [enforce2fa, setEnforce2fa] = useState<boolean>(false);

  useEffect(() => {
    if (!settings) return;
    setTimeout_(settings.sessionTimeoutMin ?? 480);
    setIp((Array.isArray(settings.ipAllowlist) ? settings.ipAllowlist : []).join("\n"));
    setEnforce2fa(Boolean(settings.enforce2fa));
  }, [settings]);

  return (
    <Section
      title="Security"
      description="Session lifetime, IP allowlist, and MFA policy."
      right={
        canEdit ? (
          <Button
            size="sm"
            onClick={() =>
              save({
                sessionTimeoutMin: Number(timeout_),
                ipAllowlist: ip
                  .split(/\r?\n/)
                  .map((s) => s.trim())
                  .filter(Boolean),
                enforce2fa,
              })
            }
          >
            Save
          </Button>
        ) : null
      }
    >
      <div className="p-4 grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="space-y-1">
          <Label>Session timeout (minutes)</Label>
          <Input
            type="number"
            value={timeout_}
            onChange={(e) => setTimeout_(Number(e.target.value))}
            disabled={!canEdit}
            min={15}
            max={60 * 24 * 7}
          />
          <div className="text-xs text-muted-foreground">Users re-authenticate after this interval (15 min – 7 days).</div>
        </div>
        <div className="space-y-1">
          <Label>Enforce 2FA</Label>
          <label className="flex items-center gap-2 text-sm pt-1">
            <input
              type="checkbox"
              checked={enforce2fa}
              onChange={(e) => setEnforce2fa(e.target.checked)}
              disabled={!canEdit}
            />
            Require 2FA for all members
          </label>
          <div className="text-xs text-muted-foreground">Enforced on next login after save. UX surface is planned; policy is recorded now.</div>
        </div>
        <div className="space-y-1 md:col-span-2">
          <Label>IP allowlist (one per line, CIDR supported)</Label>
          <textarea
            className="w-full min-h-28 rounded-md border bg-transparent px-3 py-2 text-sm font-mono"
            value={ip}
            onChange={(e) => setIp(e.target.value)}
            disabled={!canEdit}
            placeholder={"203.0.113.0/24\n198.51.100.42"}
          />
          <div className="text-xs text-muted-foreground">Leave empty to allow all. Policy is recorded; edge enforcement pending.</div>
        </div>
      </div>
    </Section>
  );
}

function NotificationsTab({ settings, save, canEdit }: { settings: any; save: (v: any) => void; canEdit: boolean }) {
  const initial: NotifyPolicy = useMemo(() => {
    const p = (settings?.notifyPolicy ?? {}) as NotifyPolicy;
    const merged: NotifyPolicy = {};
    for (const { key } of NOTIFY_EVENTS) {
      merged[key] = p[key] ?? { inApp: true, email: false };
    }
    return merged;
  }, [settings]);
  const [policy, setPolicy] = useState<NotifyPolicy>(initial);
  useEffect(() => setPolicy(initial), [initial]);

  return (
    <Section
      title="Notifications"
      description="Defaults for in-app bell and email notifications. Individual members can override these in their profile."
      right={
        canEdit ? (
          <Button size="sm" onClick={() => save({ notifyPolicy: policy })}>
            Save
          </Button>
        ) : null
      }
    >
      <div className="p-4">
        <table className="w-full text-sm">
          <thead className="text-xs text-muted-foreground">
            <tr className="text-left">
              <th className="py-2">Event</th>
              <th className="py-2 w-24 text-center">In-app</th>
              <th className="py-2 w-24 text-center">Email</th>
            </tr>
          </thead>
          <tbody>
            {NOTIFY_EVENTS.map((ev) => (
              <tr key={ev.key} className="border-t">
                <td className="py-2">{ev.label}</td>
                <td className="py-2 text-center">
                  <input
                    type="checkbox"
                    checked={policy[ev.key]?.inApp ?? false}
                    onChange={(e) => setPolicy((p) => ({ ...p, [ev.key]: { ...p[ev.key], inApp: e.target.checked } }))}
                    disabled={!canEdit}
                  />
                </td>
                <td className="py-2 text-center">
                  <input
                    type="checkbox"
                    checked={policy[ev.key]?.email ?? false}
                    onChange={(e) => setPolicy((p) => ({ ...p, [ev.key]: { ...p[ev.key], email: e.target.checked } }))}
                    disabled={!canEdit}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

/* ─── Provider metadata ──────────────────────────────────────────────── */
const PROVIDER_META: Record<string, { name: string; hint: string; builtIn?: boolean; configFields?: { key: string; label: string; type?: string }[]; docsUrl?: string }> = {
  manus_oauth: { name: "Manus OAuth", hint: "Primary authentication — always connected via the platform.", builtIn: true },
  data_api: { name: "Manus Data API Hub", hint: "Bulk enrichment + news / funding signals. Built-in, no setup required.", builtIn: true },
  llm: { name: "LLM Provider", hint: "AI email compose, lead scoring, research pipeline. Built-in via platform key.", builtIn: true },
  google_maps: { name: "Google Maps", hint: "Geocoding + routing via Manus proxy. No API key required.", builtIn: true },
  scim: {
    name: "SCIM 2.0",
    hint: "Provision users + groups from Okta, Entra ID, or any SCIM-compatible IdP.",
    docsUrl: "/scim",
    configFields: [{ key: "bearerToken", label: "Bearer token (auto-generated)", type: "password" }],
  },
  stripe: {
    name: "Stripe",
    hint: "Payment processing for CPQ / quotes. Requires Stripe publishable + secret keys.",
    configFields: [
      { key: "publishableKey", label: "Publishable key" },
      { key: "secretKey", label: "Secret key", type: "password" },
    ],
  },
  webhook: {
    name: "Custom Webhook",
    hint: "POST JSON events to an external URL on CRM triggers.",
    configFields: [
      { key: "url", label: "Endpoint URL" },
      { key: "secret", label: "Signing secret", type: "password" },
    ],
  },
};

const ALL_PROVIDERS = Object.keys(PROVIDER_META);

function IntegrationsTab() {
  const { current } = useWorkspace();
  const isAdmin = current?.role === "admin" || current?.role === "super_admin";
  const utils = trpc.useUtils();

  const listQ = trpc.integrations.list.useQuery();
  const saveMut = trpc.integrations.save.useMutation({
    onSuccess: () => { utils.integrations.list.invalidate(); toast.success("Integration saved"); },
    onError: (e) => toast.error(e.message),
  });
  const testMut = trpc.integrations.test.useMutation({
    onSuccess: (d) => { utils.integrations.list.invalidate(); toast[d.ok ? "success" : "error"](d.result); },
    onError: (e) => toast.error(e.message),
  });
  const removeMut = trpc.integrations.remove.useMutation({
    onSuccess: () => { utils.integrations.list.invalidate(); toast.success("Integration removed"); },
    onError: (e) => toast.error(e.message),
  });

  const [configOpen, setConfigOpen] = useState<string | null>(null);
  const [configDraft, setConfigDraft] = useState<Record<string, string>>({});

  // Build a map of provider → row
  const rowMap = useMemo(() => {
    const m: Record<string, any> = {};
    (listQ.data ?? []).forEach((r: any) => { m[r.provider] = r; });
    return m;
  }, [listQ.data]);

  // Merge server rows with static provider list
  const providers = ALL_PROVIDERS.map((p) => ({
    provider: p,
    meta: PROVIDER_META[p],
    row: rowMap[p] ?? null,
  }));

  const openConfig = (provider: string) => {
    const row = rowMap[provider];
    setConfigDraft((row?.config as Record<string, string>) ?? {});
    setConfigOpen(provider);
  };

  const saveConfig = (provider: string) => {
    saveMut.mutate({ provider, config: configDraft, status: "connected" });
    setConfigOpen(null);
  };

  const statusIcon = (status: string | null) => {
    if (status === "connected") return <CheckCircle2 className="size-4 text-green-600" />;
    if (status === "error") return <XCircle className="size-4 text-red-500" />;
    return <div className="size-4 rounded-full border-2 border-muted-foreground/30" />;
  };

  return (
    <>
      <Section title="Integrations" description="Connect and configure external services. Built-in integrations are always active with no setup required.">
        {listQ.isLoading ? (
          <div className="p-6 flex justify-center"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>
        ) : (
          <ul className="divide-y">
            {providers.map(({ provider, meta, row }) => (
              <li key={provider} className="px-4 py-3">
                <div className="flex items-center gap-3">
                  {statusIcon(row?.status ?? null)}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{meta.name}</span>
                      {meta.builtIn && <span className="text-[10px] bg-muted text-muted-foreground px-1.5 py-0.5 rounded-full">built-in</span>}
                      {row?.status === "connected" && !meta.builtIn && <span className="text-[10px] bg-green-100 text-green-700 px-1.5 py-0.5 rounded-full">connected</span>}
                      {row?.status === "error" && <span className="text-[10px] bg-red-100 text-red-700 px-1.5 py-0.5 rounded-full">error</span>}
                    </div>
                    <div className="text-xs text-muted-foreground">{meta.hint}</div>
                    {row?.lastTestResult && (
                      <div className={`text-xs mt-0.5 ${row.status === "error" ? "text-red-500" : "text-muted-foreground"}`}>
                        Last test: {row.lastTestResult}
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    {meta.docsUrl && (
                      <Button size="sm" variant="ghost" asChild>
                        <a href={meta.docsUrl} target="_blank" rel="noreferrer"><ExternalLink className="size-3.5" /></a>
                      </Button>
                    )}
                    <Button
                      size="sm" variant="ghost"
                      disabled={testMut.isPending}
                      onClick={() => testMut.mutate({ provider })}
                    >
                      {testMut.isPending && testMut.variables?.provider === provider
                        ? <Loader2 className="size-3.5 animate-spin" />
                        : <TestTube2 className="size-3.5" />}
                      Test
                    </Button>
                    {!meta.builtIn && isAdmin && (
                      <>
                        <Button size="sm" variant="outline" onClick={() => openConfig(provider)}>Configure</Button>
                        {row && (
                          <Button size="sm" variant="ghost" className="text-destructive" onClick={() => removeMut.mutate({ provider })}>
                            <Trash2 className="size-3.5" />
                          </Button>
                        )}
                      </>
                    )}
                  </div>
                </div>

                {/* Inline config form */}
                {configOpen === provider && (
                  <div className="mt-3 ml-7 space-y-2 border rounded-md p-3 bg-muted/30">
                    {(meta.configFields ?? []).map((f) => (
                      <div key={f.key} className="space-y-1">
                        <Label className="text-xs">{f.label}</Label>
                        <Input
                          type={f.type ?? "text"}
                          value={configDraft[f.key] ?? ""}
                          onChange={(e) => setConfigDraft((d) => ({ ...d, [f.key]: e.target.value }))}
                          placeholder={f.type === "password" ? "••••••••" : ""}
                          className="h-8 text-xs"
                        />
                      </div>
                    ))}
                    <div className="flex gap-2 pt-1">
                      <Button size="sm" onClick={() => saveConfig(provider)} disabled={saveMut.isPending}>Save</Button>
                      <Button size="sm" variant="ghost" onClick={() => setConfigOpen(null)}>Cancel</Button>
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>
      {/* Email Verification Settings */}
      <EmailVerificationSettingsSection isAdmin={isAdmin} />
      {/* Slack / Teams / System Sender */}
      <WorkspaceMessagingSection isAdmin={isAdmin} />
    </>
  );
}

/* ─── Proposals Tab ────────────────────────────────────────────────────── */
function ProposalsTab({ settings, save, canEdit }: { settings: any; save: (patch: any) => void; canEdit: boolean }) {
  const [autoExtend, setAutoExtend] = useState(false);
  const [autoExtendDays, setAutoExtendDays] = useState(7);

  useEffect(() => {
    if (settings?.autoExtendOnOpen !== undefined) setAutoExtend(!!settings.autoExtendOnOpen);
    if (settings?.autoExtendDays !== undefined) setAutoExtendDays(Number(settings.autoExtendDays) || 7);
  }, [settings?.autoExtendOnOpen, settings?.autoExtendDays]);

  return (
    <Section
      title="Proposal Expiry"
      description="Configure how proposal expiry dates behave when clients interact with sent proposals."
    >
      <div className="p-4 space-y-6">
        {/* Auto-extend on open */}
        <div className="flex items-start gap-4">
          <div className="flex-1 space-y-1">
            <div className="text-sm font-medium">Auto-extend expiry when client opens email</div>
            <div className="text-xs text-muted-foreground">
              When enabled, if a client opens the proposal email and the expiry date is within 7 days (but not yet expired), the expiry date is automatically extended by the number of days below. This prevents active proposals from silently expiring on engaged clients.
            </div>
          </div>
          <Switch
            checked={autoExtend}
            onCheckedChange={(v) => {
              if (!canEdit) return;
              setAutoExtend(v);
              save({ autoExtendOnOpen: v });
            }}
            disabled={!canEdit}
          />
        </div>

        {/* Extension days */}
        {autoExtend && (
          <div className="flex items-center gap-4 pl-0">
            <div className="flex-1 space-y-1">
              <div className="text-sm font-medium">Extension duration (days)</div>
              <div className="text-xs text-muted-foreground">
                Number of days to add to the expiry date when auto-extend fires.
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Input
                type="number"
                min={1}
                max={365}
                value={autoExtendDays}
                onChange={(e) => setAutoExtendDays(Number(e.target.value))}
                className="w-20 text-center"
                disabled={!canEdit}
              />
              <span className="text-sm text-muted-foreground">days</span>
              <Button
                size="sm"
                disabled={!canEdit}
                onClick={() => save({ autoExtendDays })}
              >
                Save
              </Button>
            </div>
          </div>
        )}
      </div>
    </Section>
  );
}

function WorkspaceMessagingSection({ isAdmin }: { isAdmin: boolean }) {
  const utils = trpc.useUtils();
  const settingsQ = trpc.settings.get.useQuery();
  const sendingAccountsQ = trpc.sendingAccounts.list.useQuery();
  const saveMut = trpc.settings.save.useMutation({
    onSuccess: () => { utils.settings.get.invalidate(); toast.success("Messaging settings saved"); },
    onError: (e) => toast.error(e.message),
  });

  const [slackUrl, setSlackUrl] = useState("");
  const [teamsUrl, setTeamsUrl] = useState("");
  const [systemSenderId, setSystemSenderId] = useState<string>("");

  useEffect(() => {
    if (!settingsQ.data) return;
    const s = settingsQ.data as any;
    setSlackUrl(s.slackWebhookUrl ?? "");
    setTeamsUrl(s.teamsWebhookUrl ?? "");
    setSystemSenderId(s.systemSenderAccountId ? String(s.systemSenderAccountId) : "");
  }, [settingsQ.data]);

  const handleSave = () => {
    saveMut.mutate({
      slackWebhookUrl: slackUrl || null,
      teamsWebhookUrl: teamsUrl || null,
      systemSenderAccountId: systemSenderId ? Number(systemSenderId) : null,
    } as any);
  };

  const accounts = (sendingAccountsQ.data ?? []) as any[];

  return (
    <Section
      title="Messaging & Notifications"
      description="Configure Slack and Microsoft Teams webhook URLs for workflow actions, and designate a system sending account for invitation emails."
      right={
        isAdmin ? (
          <Button size="sm" onClick={handleSave} disabled={saveMut.isPending}>
            {saveMut.isPending ? <Loader2 className="size-3.5 animate-spin mr-1" /> : null}
            Save
          </Button>
        ) : null
      }
    >
      <div className="p-4 space-y-5">
        <div className="space-y-1">
          <Label>Slack Incoming Webhook URL</Label>
          <Input
            value={slackUrl}
            onChange={(e) => setSlackUrl(e.target.value)}
            disabled={!isAdmin}
            placeholder="https://hooks.slack.com/services/..."
            type="url"
          />
          <p className="text-xs text-muted-foreground">Used by workflow &quot;Post to Slack&quot; actions. Create one in your Slack app&apos;s Incoming Webhooks settings.</p>
        </div>
        <div className="space-y-1">
          <Label>Microsoft Teams Incoming Webhook URL</Label>
          <Input
            value={teamsUrl}
            onChange={(e) => setTeamsUrl(e.target.value)}
            disabled={!isAdmin}
            placeholder="https://outlook.office.com/webhook/..."
            type="url"
          />
          <p className="text-xs text-muted-foreground">Used by workflow &quot;Notify Teams&quot; actions. Create one via Connectors in your Teams channel settings.</p>
        </div>
        <div className="space-y-1">
          <Label>System Sender Account</Label>
          <select
            className="w-full rounded-md border bg-transparent px-3 py-2 text-sm"
            value={systemSenderId}
            onChange={(e) => setSystemSenderId(e.target.value)}
            disabled={!isAdmin}
          >
            <option value="">— None (invitation emails disabled) —</option>
            {accounts.map((a: any) => (
              <option key={a.id} value={String(a.id)}>
                {a.name} ({a.fromEmail})
              </option>
            ))}
          </select>
          <p className="text-xs text-muted-foreground">When set, team invitation emails are sent from this account using its SMTP credentials.</p>
        </div>
      </div>
    </Section>
  );
}

function EmailVerificationSettingsSection({ isAdmin }: { isAdmin: boolean }) {
  const utils = trpc.useUtils();
  const settingsQ = trpc.settings.get.useQuery();
  const saveMut = trpc.settings.save.useMutation({
    onSuccess: () => { utils.settings.get.invalidate(); toast.success("Email verification settings saved"); },
    onError: (e) => toast.error(e.message),
  });
  const balanceQ = trpc.emailVerification.getAccountBalance.useQuery(undefined, { retry: false });
  const reverifyQ = trpc.emailVerification.getReverifySettings.useQuery();
  const saveReverifyMut = trpc.emailVerification.saveReverifySettings.useMutation({
    onSuccess: () => { reverifyQ.refetch(); toast.success("Auto re-verify settings saved"); },
    onError: (e) => toast.error(e.message),
  });
  const triggerNowMut = trpc.emailVerification.triggerReverifyNow.useMutation({
    onSuccess: () => toast.success("Re-verify job started — check the Contacts page for progress"),
    onError: (e) => toast.error(e.message),
  });
  const [blockInvalid, setBlockInvalid] = useState(false);
  const [reverifyInterval, setReverifyInterval] = useState<string>("disabled");
  const [reverifyRisky, setReverifyRisky] = useState(true);
  const [reverifyAcceptAll, setReverifyAcceptAll] = useState(true);

  useEffect(() => {
    if (settingsQ.data) setBlockInvalid(Boolean((settingsQ.data as any).blockInvalidEmailsFromSequences));
  }, [settingsQ.data]);

  useEffect(() => {
    if (reverifyQ.data) {
      setReverifyInterval(reverifyQ.data.reverifyIntervalDays ? String(reverifyQ.data.reverifyIntervalDays) : "disabled");
      setReverifyRisky(reverifyQ.data.reverifyStatuses.includes("risky"));
      setReverifyAcceptAll(reverifyQ.data.reverifyStatuses.includes("accept_all"));
    }
  }, [reverifyQ.data]);

  const handleSaveReverify = () => {
    const statuses: string[] = [];
    if (reverifyRisky) statuses.push("risky");
    if (reverifyAcceptAll) statuses.push("accept_all");
    saveReverifyMut.mutate({
      reverifyIntervalDays: reverifyInterval === "disabled" ? null : Number(reverifyInterval),
      reverifyStatuses: statuses,
    });
  };

  // Compute "next run" estimate: oldest emailVerifiedAt + interval
  const nextRunLabel = reverifyInterval !== "disabled"
    ? `Runs daily — contacts verified more than ${reverifyInterval} days ago will be re-checked`
    : "Disabled";

  return (
    <Section
      title="Email Verification (Reoon)"
      description="Configure how email verification status affects sequence enrollment and automatic re-verification."
      right={
        isAdmin ? (
          <Button size="sm" onClick={() => saveMut.mutate({ blockInvalidEmailsFromSequences: blockInvalid })} disabled={saveMut.isPending}>
            {saveMut.isPending ? <Loader2 className="size-3.5 animate-spin mr-1" /> : null}Save Guard
          </Button>
        ) : null
      }
    >
      <div className="p-4 space-y-4">
        {/* API status card */}
        <div className="flex items-center gap-3 p-3 border rounded-lg bg-muted/30">
          <ShieldCheck className="size-5 text-[#14B89A] shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium">Reoon Email Verifier</div>
            <div className="text-xs text-muted-foreground">API key configured via environment variable REOON_API_KEY</div>
          </div>
          <div className="text-right shrink-0">
            {balanceQ.isLoading ? (
              <Loader2 className="size-4 animate-spin text-muted-foreground" />
            ) : balanceQ.error ? (
              <span className="text-xs text-destructive">Check API key</span>
            ) : (
              <div>
                <div className="text-sm font-mono tabular-nums font-semibold">{(balanceQ.data as any)?.remaining_daily_credits ?? "—"}</div>
                <div className="text-xs text-muted-foreground">daily credits left</div>
              </div>
            )}
          </div>
        </div>

        {/* Enrollment guard */}
        <div className="flex items-start gap-3 p-3 border rounded-lg">
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium">Block invalid emails from sequences</div>
            <div className="text-xs text-muted-foreground mt-0.5">
              When enabled, contacts with a Reoon verification status of <span className="font-mono text-rose-600">invalid</span> cannot be enrolled in any sequence. Contacts with <span className="font-mono text-yellow-600">risky</span> or <span className="font-mono text-yellow-600">accept_all</span> status are still allowed.
            </div>
          </div>
          <label className="flex items-center gap-2 shrink-0 pt-0.5 cursor-pointer">
            <input
              type="checkbox"
              checked={blockInvalid}
              onChange={(e) => setBlockInvalid(e.target.checked)}
              disabled={!isAdmin}
              className="size-4"
            />
            <span className="text-sm">{blockInvalid ? "Enabled" : "Disabled"}</span>
          </label>
        </div>

        {/* Auto re-verify scheduler */}
        <div className="p-3 border rounded-lg space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm font-medium">Auto Re-Verify Schedule</div>
              <div className="text-xs text-muted-foreground mt-0.5">
                Automatically re-verify contacts whose status may have changed over time.
              </div>
            </div>
            {isAdmin && (
              <div className="flex items-center gap-2 shrink-0">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => triggerNowMut.mutate()}
                  disabled={triggerNowMut.isPending || reverifyInterval === "disabled"}
                  title="Run re-verify now for all qualifying contacts"
                >
                  {triggerNowMut.isPending ? <Loader2 className="size-3.5 animate-spin mr-1" /> : null}
                  Run Now
                </Button>
                <Button size="sm" onClick={handleSaveReverify} disabled={saveReverifyMut.isPending}>
                  {saveReverifyMut.isPending ? <Loader2 className="size-3.5 animate-spin mr-1" /> : null}
                  Save
                </Button>
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Re-verify interval</label>
              <select
                value={reverifyInterval}
                onChange={(e) => setReverifyInterval(e.target.value)}
                disabled={!isAdmin}
                className="w-full h-8 px-2 text-sm border rounded-md bg-background"
              >
                <option value="disabled">Disabled</option>
                <option value="30">Every 30 days</option>
                <option value="60">Every 60 days</option>
                <option value="90">Every 90 days</option>
              </select>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Re-verify these statuses</label>
              <div className="flex flex-col gap-1.5 pt-0.5">
                <label className="flex items-center gap-2 text-sm cursor-pointer">
                  <input type="checkbox" checked={reverifyRisky} onChange={(e) => setReverifyRisky(e.target.checked)} disabled={!isAdmin || reverifyInterval === "disabled"} className="size-3.5" />
                  <span className="text-orange-600 font-medium">Risky</span>
                </label>
                <label className="flex items-center gap-2 text-sm cursor-pointer">
                  <input type="checkbox" checked={reverifyAcceptAll} onChange={(e) => setReverifyAcceptAll(e.target.checked)} disabled={!isAdmin || reverifyInterval === "disabled"} className="size-3.5" />
                  <span className="text-yellow-600 font-medium">Accept-All</span>
                </label>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="inline-block size-1.5 rounded-full bg-[#14B89A] shrink-0" />
            {nextRunLabel}
          </div>
        </div>
      </div>
    </Section>
  );
}

function BillingTab({ usage }: { usage: any }) {
  return (
    <>
      <Section title="Billing" description="Plan tier, seat count, and this month's usage counters.">
        <div className="p-4 grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatCard label="Seats used" value={usage?.seatsUsed ?? 0} />
          <StatCard label="Emails sent" value={Number(usage?.emailsSent ?? 0).toLocaleString()} />
          <StatCard label="LLM tokens" value={Number(usage?.llmTokens ?? 0).toLocaleString()} />
          <StatCard label="Month" value={usage?.month ?? "—"} />
        </div>
      </Section>
      <Section title="Invoices" description="Placeholder — invoice history appears here once billing is activated.">
        <div className="p-4 text-sm text-muted-foreground">No invoices yet.</div>
      </Section>
    </>
  );
}

function DangerTab({ canEdit }: { canEdit: boolean }) {
  const [exportResult, setExportResult] = useState<Record<string, number> | null>(null);
  const [transferUserId, setTransferUserId] = useState("");
  const [archiveConfirm, setArchiveConfirm] = useState("");
  const [showTransfer, setShowTransfer] = useState(false);
  const [showArchive, setShowArchive] = useState(false);

  const membersQ = trpc.team.list.useQuery();
  const activeMembers = (membersQ.data ?? []).filter((m) => !m.deactivatedAt);

  const exportMut = trpc.dangerZone.exportData.useMutation({
    onSuccess: (data) => {
      setExportResult(data.summary);
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `workspace-export-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success("Export downloaded");
    },
    onError: (e) => toast.error(e.message),
  });

  const transferMut = trpc.dangerZone.transferOwnership.useMutation({
    onSuccess: () => { toast.success("Ownership transferred"); setShowTransfer(false); setTransferUserId(""); },
    onError: (e) => toast.error(e.message),
  });

  const archiveMut = trpc.dangerZone.archiveWorkspace.useMutation({
    onSuccess: () => { toast.success("Workspace archived"); setShowArchive(false); },
    onError: (e) => toast.error(e.message),
  });

  return (
    <Section title="Danger zone" description="Destructive actions. Super admin role required.">
      <div className="p-4 space-y-4">
        {/* Export */}
        <div className="flex items-start gap-3">
          <div className="flex-1">
            <div className="text-sm font-medium">Export all workspace data</div>
            <div className="text-xs text-muted-foreground">Downloads a JSON summary with record counts for all entity types.</div>
            {exportResult && (
              <div className="mt-1 text-xs text-emerald-600">
                Exported: {Object.entries(exportResult).map(([k, v]) => `${v} ${k}`).join(" · ")}
              </div>
            )}
          </div>
          <Button variant="outline" size="sm" disabled={!canEdit || exportMut.isPending} onClick={() => exportMut.mutate()}>
            {exportMut.isPending ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
            Export
          </Button>
        </div>

        {/* Transfer ownership */}
        <div className="space-y-2">
          <div className="flex items-start gap-3">
            <div className="flex-1">
              <div className="text-sm font-medium">Transfer ownership</div>
              <div className="text-xs text-muted-foreground">Move super_admin to another active workspace member.</div>
            </div>
            <Button variant="outline" size="sm" disabled={!canEdit} onClick={() => setShowTransfer((v) => !v)}>
              Transfer
            </Button>
          </div>
          {showTransfer && (
            <div className="flex gap-2 pl-0">
              <select
                className="flex-1 border rounded-md px-2 py-1 text-sm bg-background"
                value={transferUserId}
                onChange={(e) => setTransferUserId(e.target.value)}
              >
                <option value="">Select new owner…</option>
                {activeMembers.map((m) => (
                  <option key={m.userId} value={String(m.userId)}>{m.name} ({m.role})</option>
                ))}
              </select>
              <Button
                size="sm"
                disabled={!transferUserId || transferMut.isPending}
                onClick={() => transferMut.mutate({ newOwnerUserId: Number(transferUserId) })}
              >
                {transferMut.isPending ? <Loader2 className="size-4 animate-spin" /> : "Confirm"}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setShowTransfer(false)}>Cancel</Button>
            </div>
          )}
        </div>

        {/* Archive workspace */}
        <div className="space-y-2">
          <div className="flex items-start gap-3">
            <div className="flex-1">
              <div className="text-sm font-medium text-rose-700">Archive workspace</div>
              <div className="text-xs text-muted-foreground">Members lose access. Data is retained for 90 days then purged.</div>
            </div>
            <Button variant="outline" size="sm" disabled={!canEdit} className="text-rose-700" onClick={() => setShowArchive((v) => !v)}>
              Archive
            </Button>
          </div>
          {showArchive && (
            <div className="space-y-2 border border-rose-200 rounded-md p-3 bg-rose-50 dark:bg-rose-950/20">
              <p className="text-xs text-rose-700">Type <strong>ARCHIVE</strong> to confirm:</p>
              <div className="flex gap-2">
                <Input
                  className="flex-1 text-sm"
                  placeholder="ARCHIVE"
                  value={archiveConfirm}
                  onChange={(e) => setArchiveConfirm(e.target.value)}
                />
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={archiveConfirm !== "ARCHIVE" || archiveMut.isPending}
                  onClick={() => archiveMut.mutate()}
                >
                  {archiveMut.isPending ? <Loader2 className="size-4 animate-spin" /> : "Confirm archive"}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => { setShowArchive(false); setArchiveConfirm(""); }}>Cancel</Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </Section>
  );
}
