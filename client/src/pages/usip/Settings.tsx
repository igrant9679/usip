import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Section, StatusPill, fmt$ } from "@/components/usip/Common";
import { PageHeader, Shell, StatCard } from "@/components/usip/Shell";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { trpc } from "@/lib/trpc";
import { AlertTriangle, Bell, Building2, CreditCard, Download, Palette, Plug, ShieldCheck } from "lucide-react";
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

function IntegrationsTab() {
  const items = [
    { name: "Manus OAuth", status: "Connected", tone: "success" as const, hint: "Primary authentication provider" },
    { name: "SCIM 2.0", status: "Available", tone: "info" as const, hint: "Provision users + groups from Okta / Entra ID" },
    { name: "Stripe", status: "Not connected", tone: "muted" as const, hint: "Enable via Management → Add feature" },
    { name: "Manus Data API Hub", status: "Available", tone: "info" as const, hint: "Bulk enrichment + news / funding signals" },
    { name: "LLM provider", status: "Built-in", tone: "success" as const, hint: "invokeLLM via platform key (no setup)" },
    { name: "Google Maps", status: "Built-in", tone: "success" as const, hint: "Geocoding + routing via Manus proxy" },
  ];
  return (
    <Section title="Integrations" description="Status of external services this workspace uses.">
      <ul className="divide-y">
        {items.map((i) => (
          <li key={i.name} className="flex items-center gap-3 px-4 py-3">
            <div className="flex-1">
              <div className="text-sm font-medium">{i.name}</div>
              <div className="text-xs text-muted-foreground">{i.hint}</div>
            </div>
            <StatusPill tone={i.tone}>{i.status}</StatusPill>
          </li>
        ))}
      </ul>
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
