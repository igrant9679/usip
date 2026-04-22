import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Section, StatusPill, fmt$ } from "@/components/usip/Common";
import { PageHeader, Shell, StatCard } from "@/components/usip/Shell";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { trpc } from "@/lib/trpc";
import { AlertTriangle, Bell, Building2, CheckCircle2, CreditCard, Download, ExternalLink, Loader2, Palette, Plug, ShieldCheck, TestTube2, Trash2, XCircle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

type NotifyPolicy = Record<string, { inApp: boolean; email: boolean }>;

const TABS = [
  { id: "general", label: "General", icon: Building2 },
  { id: "branding", label: "Branding", icon: Palette },
  { id: "security", label: "Security", icon: ShieldCheck },
  { id: "notifications", label: "Notifications", icon: Bell },
  { id: "integrations", label: "Integrations", icon: Plug },
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
      <PageHeader title="Workspace settings" description="Administrative configuration for this workspace." />
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
          {tab === "billing" && <BillingTab usage={usage.data} />}
          {tab === "danger" && <DangerTab canEdit={isAdmin} />}
        </div>
      </div>
    </Shell>
  );
}

/* ─── Tabs ─────────────────────────────────────────────────────────────── */

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
  useEffect(() => {
    if (settings?.timezone) setTimezone(settings.timezone);
  }, [settings?.timezone]);

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
    </>
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
  const [blockInvalid, setBlockInvalid] = useState(false);
  useEffect(() => {
    if (settingsQ.data) setBlockInvalid(Boolean((settingsQ.data as any).blockInvalidEmailsFromSequences));
  }, [settingsQ.data]);
  return (
    <Section
      title="Email Verification (Reoon)"
      description="Configure how email verification status affects sequence enrollment."
      right={
        isAdmin ? (
          <Button size="sm" onClick={() => saveMut.mutate({ blockInvalidEmailsFromSequences: blockInvalid })} disabled={saveMut.isPending}>
            {saveMut.isPending ? <Loader2 className="size-3.5 animate-spin mr-1" /> : null}Save
          </Button>
        ) : null
      }
    >
      <div className="p-4 space-y-4">
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
                <div className="text-sm font-mono tabular-nums font-semibold">{(balanceQ.data as any)?.daily_remaining ?? "—"}</div>
                <div className="text-xs text-muted-foreground">daily credits left</div>
              </div>
            )}
          </div>
        </div>
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
  return (
    <Section title="Danger zone" description="Destructive actions. Admin role required.">
      <div className="p-4 space-y-3">
        <div className="flex items-center gap-3">
          <div className="flex-1">
            <div className="text-sm font-medium">Export all workspace data</div>
            <div className="text-xs text-muted-foreground">Download a ZIP with accounts, contacts, leads, opportunities, activities.</div>
          </div>
          <Button
            variant="outline"
            size="sm"
            disabled={!canEdit}
            onClick={() => toast.info("Export queued — you'll get an email when it's ready")}
          >
            <Download className="size-4" /> Export
          </Button>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex-1">
            <div className="text-sm font-medium">Transfer ownership</div>
            <div className="text-xs text-muted-foreground">Move super_admin to another workspace member.</div>
          </div>
          <Button variant="outline" size="sm" disabled={!canEdit} onClick={() => toast.info("Coming soon")}>
            Transfer
          </Button>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex-1">
            <div className="text-sm font-medium text-rose-700">Archive workspace</div>
            <div className="text-xs text-muted-foreground">Members lose access. Data is retained for 90 days then purged.</div>
          </div>
          <Button variant="outline" size="sm" disabled={!canEdit} className="text-rose-700" onClick={() => toast.info("Coming soon")}>
            Archive
          </Button>
        </div>
      </div>
    </Section>
  );
}
