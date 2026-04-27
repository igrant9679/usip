/**
 * SendingAccounts — Multi-provider sending account management page.
 * Lists all connected accounts with health stats, allows add/edit/delete,
 * and provides a per-account connection test action.
 */
import { useState, useEffect } from "react";
import { PageHeader, Shell } from "@/components/usip/Shell";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  AlertCircle,
  CheckCircle2,
  ChevronRight,
  Clock,
  HelpCircle,
  Mail,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  Zap, AtSign
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

type Provider = "gmail_oauth" | "outlook_oauth" | "amazon_ses" | "generic_smtp";
type WarmupStatus = "not_started" | "in_progress" | "complete";
type ConnectionStatus = "connected" | "error" | "untested";
type ReputationTier = "excellent" | "good" | "fair" | "poor";

interface AccountForm {
  name: string;
  provider: Provider;
  fromEmail: string;
  fromName: string;
  replyTo: string;
  oauthAccessToken: string;
  oauthRefreshToken: string;
  smtpHost: string;
  smtpPort: string;
  smtpSecure: boolean;
  smtpUsername: string;
  smtpPassword: string;
  sesRegion: string;
  imapHost: string;
  imapPort: string;
  imapSecure: boolean;
  imapUsername: string;
  imapPassword: string;
  dailySendLimit: string;
  warmupStatus: WarmupStatus;
}

const defaultForm: AccountForm = {
  name: "",
  provider: "generic_smtp",
  fromEmail: "",
  fromName: "",
  replyTo: "",
  oauthAccessToken: "",
  oauthRefreshToken: "",
  smtpHost: "",
  smtpPort: "587",
  smtpSecure: false,
  smtpUsername: "",
  smtpPassword: "",
  sesRegion: "us-east-1",
  imapHost: "",
  imapPort: "993",
  imapSecure: true,
  imapUsername: "",
  imapPassword: "",
  dailySendLimit: "500",
  warmupStatus: "not_started",
};

/** Default IMAP host/port hints per provider */
const IMAP_DEFAULTS: Record<Provider, { host: string; port: string }> = {
  gmail_oauth: { host: "imap.gmail.com", port: "993" },
  outlook_oauth: { host: "outlook.office365.com", port: "993" },
  amazon_ses: { host: "", port: "993" },
  generic_smtp: { host: "", port: "993" },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

const PROVIDER_LABELS: Record<Provider, string> = {
  gmail_oauth: "Gmail (OAuth)",
  outlook_oauth: "Outlook / M365 (OAuth)",
  amazon_ses: "Amazon SES",
  generic_smtp: "Generic SMTP",
};

const PROVIDER_ICONS: Record<Provider, string> = {
  gmail_oauth: "G",
  outlook_oauth: "O",
  amazon_ses: "A",
  generic_smtp: "S",
};

const PROVIDER_COLORS: Record<Provider, string> = {
  gmail_oauth: "bg-red-100 text-red-700",
  outlook_oauth: "bg-blue-100 text-blue-700",
  amazon_ses: "bg-orange-100 text-orange-700",
  generic_smtp: "bg-zinc-100 text-zinc-700",
};

function ConnectionBadge({ status }: { status: ConnectionStatus }) {
  if (status === "connected")
    return (
      <Badge className="gap-1 bg-emerald-100 text-emerald-700 border-emerald-200">
        <CheckCircle2 className="w-3 h-3" /> Connected
      </Badge>
    );
  if (status === "error")
    return (
      <Badge className="gap-1 bg-red-100 text-red-700 border-red-200">
        <AlertCircle className="w-3 h-3" /> Error
      </Badge>
    );
  return (
    <Badge className="gap-1 bg-zinc-100 text-zinc-500 border-zinc-200">
      <HelpCircle className="w-3 h-3" /> Untested
    </Badge>
  );
}

function ReputationBadge({ tier }: { tier: ReputationTier }) {
  const map: Record<ReputationTier, { label: string; cls: string }> = {
    excellent: { label: "Excellent", cls: "bg-emerald-100 text-emerald-700 border-emerald-200" },
    good: { label: "Good", cls: "bg-blue-100 text-blue-700 border-blue-200" },
    fair: { label: "Fair", cls: "bg-yellow-100 text-yellow-700 border-yellow-200" },
    poor: { label: "Poor", cls: "bg-red-100 text-red-700 border-red-200" },
  };
  const { label, cls } = map[tier] ?? map.fair;
  return <Badge className={`${cls} text-xs`}>{label}</Badge>;
}

function WarmupBadge({ status }: { status: WarmupStatus }) {
  const map: Record<WarmupStatus, { label: string; cls: string }> = {
    not_started: { label: "Warmup: Not started", cls: "bg-zinc-100 text-zinc-500 border-zinc-200" },
    in_progress: { label: "Warming up", cls: "bg-amber-100 text-amber-700 border-amber-200" },
    complete: { label: "Warmed up", cls: "bg-emerald-100 text-emerald-700 border-emerald-200" },
  };
  const { label, cls } = map[status] ?? map.not_started;
  return <Badge className={`${cls} text-xs`}>{label}</Badge>;
}

function UsageBar({ sent, limit }: { sent: number; limit: number }) {
  const pct = limit > 0 ? Math.min(100, Math.round((sent / limit) * 100)) : 0;
  const color =
    pct >= 90 ? "bg-red-500" : pct >= 70 ? "bg-amber-400" : "bg-emerald-500";
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs text-muted-foreground">
        <span>{sent.toLocaleString()} sent today</span>
        <span>{limit.toLocaleString()} limit</span>
      </div>
      <div className="h-1.5 bg-muted rounded-full overflow-hidden">
        <div className={`h-full ${color} rounded-full transition-all`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

// ─── Account Form Dialog ──────────────────────────────────────────────────────

function AccountFormDialog({
  open,
  onClose,
  editId,
}: {
  open: boolean;
  onClose: () => void;
  editId?: number;
}) {
  const utils = trpc.useUtils();
  const [form, setForm] = useState<AccountForm>(defaultForm);

  // Fetch existing account data when editing
  const existingAccount = trpc.sendingAccounts.get.useQuery(
    { id: editId! },
    { enabled: !!editId && open },
  );

  // Pre-fill form when existing data loads
  useEffect(() => {
    if (editId && existingAccount.data) {
      const a = existingAccount.data;
      setForm({
        name: a.name ?? "",
        provider: (a.provider as Provider) ?? "generic_smtp",
        fromEmail: a.fromEmail ?? "",
        fromName: a.fromName ?? "",
        replyTo: a.replyTo ?? "",
        oauthAccessToken: "", // never pre-fill secrets
        oauthRefreshToken: "",
        smtpHost: a.smtpHost ?? "",
        smtpPort: a.smtpPort ? String(a.smtpPort) : "587",
        smtpSecure: a.smtpSecure ?? false,
        smtpUsername: a.smtpUsername ?? "",
        smtpPassword: "", // never pre-fill secrets
        sesRegion: a.sesRegion ?? "us-east-1",
        imapHost: a.imapHost ?? "",
        imapPort: a.imapPort ? String(a.imapPort) : "993",
        imapSecure: a.imapSecure ?? true,
        imapUsername: a.imapUsername ?? "",
        imapPassword: "", // never pre-fill secrets
        dailySendLimit: String(a.dailySendLimit ?? 500),
        warmupStatus: (a.warmupStatus as WarmupStatus) ?? "not_started",
      });
    } else if (!editId) {
      setForm(defaultForm);
    }
  }, [editId, existingAccount.data]);

  // Reset form when dialog closes
  useEffect(() => {
    if (!open) setForm(defaultForm);
  }, [open]);

  const createMutation = trpc.sendingAccounts.create.useMutation({
    onSuccess: () => {
      utils.sendingAccounts.list.invalidate();
      toast.success("Account connected");
      onClose();
    },
    onError: (e) => toast.error(e.message),
  });

  const updateMutation = trpc.sendingAccounts.update.useMutation({
    onSuccess: () => {
      utils.sendingAccounts.list.invalidate();
      toast.success("Account updated");
      onClose();
    },
    onError: (e) => toast.error(e.message),
  });

  function set(field: keyof AccountForm, value: string | boolean) {
    setForm((f) => {
      const next = { ...f, [field]: value };
      // When provider changes, auto-fill IMAP host/port hints if currently empty
      if (field === "provider") {
        const hints = IMAP_DEFAULTS[value as Provider];
        if (!f.imapHost) next.imapHost = hints.host;
        if (!f.imapPort || f.imapPort === "993") next.imapPort = hints.port;
      }
      return next;
    });
  }

  function handleSubmit() {
    const payload = {
      name: form.name,
      provider: form.provider,
      fromEmail: form.fromEmail,
      fromName: form.fromName || undefined,
      replyTo: form.replyTo || undefined,
      oauthAccessToken: form.oauthAccessToken || undefined,
      oauthRefreshToken: form.oauthRefreshToken || undefined,
      smtpHost: form.smtpHost || undefined,
      smtpPort: form.smtpPort ? parseInt(form.smtpPort) : undefined,
      smtpSecure: form.smtpSecure,
      smtpUsername: form.smtpUsername || undefined,
      smtpPassword: form.smtpPassword || undefined,
      sesRegion: form.sesRegion || undefined,
      imapHost: form.imapHost || undefined,
      imapPort: form.imapPort ? parseInt(form.imapPort) : undefined,
      imapSecure: form.imapSecure,
      imapUsername: form.imapUsername || undefined,
      imapPassword: form.imapPassword || undefined,
      dailySendLimit: parseInt(form.dailySendLimit) || 500,
      warmupStatus: form.warmupStatus,
    };
    if (editId) {
      updateMutation.mutate({ id: editId, ...payload });
    } else {
      createMutation.mutate(payload);
    }
  }

  const isOAuth = form.provider === "gmail_oauth" || form.provider === "outlook_oauth";
  const isSES = form.provider === "amazon_ses";
  const isSMTP = form.provider === "generic_smtp";
  const isBusy = createMutation.isPending || updateMutation.isPending || existingAccount.isLoading;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{editId ? "Edit Sending Account" : "Connect Sending Account"}</DialogTitle>
        </DialogHeader>

        {existingAccount.isLoading && editId ? (
          <div className="py-8 flex items-center justify-center text-sm text-muted-foreground gap-2">
            <RefreshCw className="w-4 h-4 animate-spin" /> Loading account…
          </div>
        ) : (
          <div className="space-y-4 py-2">
            {/* Name */}
            <div className="space-y-1.5">
              <Label>Account name</Label>
              <Input
                placeholder="e.g. Sales outreach — Outlook"
                value={form.name}
                onChange={(e) => set("name", e.target.value)}
              />
            </div>

            {/* Provider */}
            <div className="space-y-1.5">
              <Label>Provider</Label>
              <Select value={form.provider} onValueChange={(v) => set("provider", v as Provider)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.entries(PROVIDER_LABELS) as [Provider, string][]).map(([k, v]) => (
                    <SelectItem key={k} value={k}>{v}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* From email / name */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>From email</Label>
                <Input
                  type="email"
                  placeholder="you@company.com"
                  value={form.fromEmail}
                  onChange={(e) => set("fromEmail", e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label>From name</Label>
                <Input
                  placeholder="Your Name"
                  value={form.fromName}
                  onChange={(e) => set("fromName", e.target.value)}
                />
              </div>
            </div>

            {/* Reply-to */}
            <div className="space-y-1.5">
              <Label>Reply-to <span className="text-muted-foreground text-xs">(optional)</span></Label>
              <Input
                type="email"
                placeholder="replies@company.com"
                value={form.replyTo}
                onChange={(e) => set("replyTo", e.target.value)}
              />
            </div>

            {/* OAuth fields */}
            {isOAuth && (
              <div className="space-y-3 border rounded-lg p-3 bg-muted/30">
                <p className="text-xs text-muted-foreground font-medium uppercase tracking-wide">OAuth credentials</p>
                {editId && (
                  <p className="text-xs text-amber-600">Leave blank to keep existing tokens. Only fill in to replace them.</p>
                )}
                <div className="space-y-1.5">
                  <Label>Access token</Label>
                  <Input
                    type="password"
                    placeholder={editId ? "••••••• (unchanged)" : "ya29.xxx or EwA..."}
                    value={form.oauthAccessToken}
                    onChange={(e) => set("oauthAccessToken", e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>Refresh token</Label>
                  <Input
                    type="password"
                    placeholder={editId ? "••••••• (unchanged)" : "1//xxx or M.C..."}
                    value={form.oauthRefreshToken}
                    onChange={(e) => set("oauthRefreshToken", e.target.value)}
                  />
                </div>
              </div>
            )}

            {/* SES fields */}
            {isSES && (
              <div className="space-y-3 border rounded-lg p-3 bg-muted/30">
                <p className="text-xs text-muted-foreground font-medium uppercase tracking-wide">Amazon SES</p>
                <div className="space-y-1.5">
                  <Label>AWS Region</Label>
                  <Select value={form.sesRegion} onValueChange={(v) => set("sesRegion", v)}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {["us-east-1","us-west-2","eu-west-1","eu-central-1","ap-southeast-1","ap-northeast-1"].map((r) => (
                        <SelectItem key={r} value={r}>{r}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label>SMTP username</Label>
                    <Input
                      placeholder="AKIAIOSFODNN7EXAMPLE"
                      value={form.smtpUsername}
                      onChange={(e) => set("smtpUsername", e.target.value)}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label>SMTP password</Label>
                    <Input
                      type="password"
                      placeholder={editId ? "••••••• (unchanged)" : "SES SMTP password"}
                      value={form.smtpPassword}
                      onChange={(e) => set("smtpPassword", e.target.value)}
                    />
                  </div>
                </div>
              </div>
            )}

            {/* Generic SMTP fields */}
            {isSMTP && (
              <div className="space-y-3 border rounded-lg p-3 bg-muted/30">
                <p className="text-xs text-muted-foreground font-medium uppercase tracking-wide">SMTP credentials</p>
                <div className="grid grid-cols-3 gap-3">
                  <div className="col-span-2 space-y-1.5">
                    <Label>Host</Label>
                    <Input
                      placeholder="smtp.office365.com"
                      value={form.smtpHost}
                      onChange={(e) => set("smtpHost", e.target.value)}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Port</Label>
                    <Input
                      type="number"
                      placeholder="587"
                      value={form.smtpPort}
                      onChange={(e) => set("smtpPort", e.target.value)}
                    />
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Switch
                    checked={form.smtpSecure}
                    onCheckedChange={(v) => set("smtpSecure", v)}
                    id="smtpSecure"
                  />
                  <Label htmlFor="smtpSecure">Use TLS/SSL (port 465)</Label>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label>Username</Label>
                    <Input
                      placeholder="you@example.com"
                      value={form.smtpUsername}
                      onChange={(e) => set("smtpUsername", e.target.value)}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Password / App password</Label>
                    <Input
                      type="password"
                      placeholder={editId ? "••••••• (unchanged)" : "App password"}
                      value={form.smtpPassword}
                      onChange={(e) => set("smtpPassword", e.target.value)}
                    />
                  </div>
                </div>
              </div>
            )}

            {/* IMAP fields — shown for all providers */}
            <div className="space-y-3 border rounded-lg p-3 bg-muted/30">
              <div className="flex items-center justify-between">
                <p className="text-xs text-muted-foreground font-medium uppercase tracking-wide">IMAP — inbox reading</p>
                <span className="text-xs text-muted-foreground">Required for My Mailbox</span>
              </div>
              {form.provider === "outlook_oauth" && (
                <p className="text-xs text-blue-600 bg-blue-50 rounded px-2 py-1">
                  Office 365: host <strong>outlook.office365.com</strong>, port <strong>993</strong>, SSL on. Use an App Password if MFA is enabled.
                </p>
              )}
              {form.provider === "gmail_oauth" && (
                <p className="text-xs text-red-600 bg-red-50 rounded px-2 py-1">
                  Gmail: host <strong>imap.gmail.com</strong>, port <strong>993</strong>, SSL on. Use an App Password from myaccount.google.com.
                </p>
              )}
              <div className="grid grid-cols-3 gap-3">
                <div className="col-span-2 space-y-1.5">
                  <Label>IMAP host</Label>
                  <Input
                    placeholder={IMAP_DEFAULTS[form.provider].host || "imap.example.com"}
                    value={form.imapHost}
                    onChange={(e) => set("imapHost", e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>Port</Label>
                  <Input
                    type="number"
                    placeholder="993"
                    value={form.imapPort}
                    onChange={(e) => set("imapPort", e.target.value)}
                  />
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Switch
                  checked={form.imapSecure}
                  onCheckedChange={(v) => set("imapSecure", v)}
                  id="imapSecure"
                />
                <Label htmlFor="imapSecure">Use SSL/TLS (recommended — port 993)</Label>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label>IMAP username</Label>
                  <Input
                    placeholder="you@company.com"
                    value={form.imapUsername}
                    onChange={(e) => set("imapUsername", e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>IMAP password / App password</Label>
                  <Input
                    type="password"
                    placeholder={editId ? "••••••• (unchanged)" : "App password"}
                    value={form.imapPassword}
                    onChange={(e) => set("imapPassword", e.target.value)}
                  />
                </div>
              </div>
            </div>

            {/* Limits */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Daily send limit</Label>
                <Input
                  type="number"
                  placeholder="500"
                  value={form.dailySendLimit}
                  onChange={(e) => set("dailySendLimit", e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label>Warmup status</Label>
                <Select value={form.warmupStatus} onValueChange={(v) => set("warmupStatus", v as WarmupStatus)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="not_started">Not started</SelectItem>
                    <SelectItem value="in_progress">In progress</SelectItem>
                    <SelectItem value="complete">Complete</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={isBusy}>Cancel</Button>
          <Button onClick={handleSubmit} disabled={isBusy || !form.name || !form.fromEmail}>
            {isBusy ? "Saving..." : editId ? "Save changes" : "Connect account"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Account Card ─────────────────────────────────────────────────────────────

function AccountCard({ account, onEdit }: { account: any; onEdit: (id: number) => void }) {
  const utils = trpc.useUtils();

  const testMutation = trpc.sendingAccounts.testConnection.useMutation({
    onSuccess: (r) => {
      utils.sendingAccounts.list.invalidate();
      if (r.ok) {
        toast.success("Connection verified");
      } else {
        toast.error(r.error ?? "Connection failed");
      }
    },
  });

  const toggleMutation = trpc.sendingAccounts.toggleEnabled.useMutation({
    onSuccess: () => utils.sendingAccounts.list.invalidate(),
  });

  const deleteMutation = trpc.sendingAccounts.delete.useMutation({
    onSuccess: () => {
      utils.sendingAccounts.list.invalidate();
      toast.success("Account removed");
    },
  });

  return (
    <Card className={`transition-all ${!account.enabled ? "opacity-60" : ""}`}>
      <CardContent className="p-4">
        <div className="flex items-start gap-3">
          {/* Provider icon */}
          <div
            className={`w-9 h-9 rounded-lg flex items-center justify-center font-bold text-sm flex-shrink-0 ${PROVIDER_COLORS[account.provider as Provider]}`}
          >
            {PROVIDER_ICONS[account.provider as Provider]}
          </div>

          {/* Main info */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-medium text-sm truncate">{account.name}</span>
              <ConnectionBadge status={account.connectionStatus as ConnectionStatus} />
              <WarmupBadge status={account.warmupStatus as WarmupStatus} />
              <ReputationBadge tier={account.reputationTier as ReputationTier} />
              {account.imapHost && (
                <Badge className="gap-1 bg-indigo-100 text-indigo-700 border-indigo-200 text-xs">
                  IMAP
                </Badge>
              )}
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">
              {account.fromEmail}
              {account.fromName ? ` · ${account.fromName}` : ""}
              {" · "}
              <span className="text-foreground/70">{PROVIDER_LABELS[account.provider as Provider]}</span>
              {account.imapHost && (
                <span className="ml-1 text-indigo-600">· {account.imapHost}:{account.imapPort ?? 993}</span>
              )}
            </p>

            {/* Usage bar */}
            <div className="mt-2">
              <UsageBar sent={account.sentToday ?? 0} limit={account.dailySendLimit} />
            </div>

            {/* Last test error */}
            {account.connectionStatus === "error" && account.lastTestError && (
              <p className="text-xs text-red-600 mt-1.5 flex items-center gap-1">
                <AlertCircle className="w-3 h-3 flex-shrink-0" />
                {account.lastTestError}
              </p>
            )}

            {/* Last tested */}
            {account.lastTestedAt && (
              <p className="text-xs text-muted-foreground mt-1 flex items-center gap-1">
                <Clock className="w-3 h-3" />
                Last tested {new Date(account.lastTestedAt).toLocaleString()}
              </p>
            )}
          </div>

          {/* Actions */}
          <div className="flex items-center gap-1.5 flex-shrink-0">
            <Switch
              checked={account.enabled}
              onCheckedChange={(v) => toggleMutation.mutate({ id: account.id, enabled: v })}
              title={account.enabled ? "Disable account" : "Enable account"}
            />
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7"
              title="Edit account"
              onClick={() => onEdit(account.id)}
            >
              <Pencil className="w-3.5 h-3.5" />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7"
              title="Test connection"
              disabled={testMutation.isPending}
              onClick={() => testMutation.mutate({ id: account.id })}
            >
              <RefreshCw className={`w-3.5 h-3.5 ${testMutation.isPending ? "animate-spin" : ""}`} />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7 text-destructive hover:text-destructive"
              title="Remove account"
              onClick={() => {
                if (confirm(`Remove "${account.name}"?`)) {
                  deleteMutation.mutate({ id: account.id });
                }
              }}
            >
              <Trash2 className="w-3.5 h-3.5" />
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function SendingAccounts() {
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState<number | undefined>(undefined);
  const { data: accounts = [], isLoading } = trpc.sendingAccounts.list.useQuery();

  const connected = accounts.filter((a) => a.connectionStatus === "connected").length;
  const totalCapacity = accounts.reduce((s, a) => s + (a.enabled ? a.dailySendLimit : 0), 0);
  const sentToday = accounts.reduce((s, a) => s + (a.sentToday ?? 0), 0);

  function openAdd() {
    setEditId(undefined);
    setShowForm(true);
  }

  function openEdit(id: number) {
    setEditId(id);
    setShowForm(true);
  }

  function closeForm() {
    setShowForm(false);
    setEditId(undefined);
  }

  return (
    <Shell title="Sending Accounts">
      <div className="space-y-6">
        <PageHeader
          title="Sending Accounts" pageKey="sending-accounts"
          description="Connect and manage the email accounts used for outbound sending."
        
        icon={<AtSign className="size-5" />}
      >
          <Button onClick={openAdd} className="gap-2">
            <Plus className="w-4 h-4" /> Connect account
          </Button>
        </PageHeader>

        {/* Summary KPIs */}
        <div className="grid grid-cols-3 gap-4">
          <Card>
            <CardContent className="p-4">
              <p className="text-xs text-muted-foreground uppercase tracking-wide">Accounts</p>
              <p className="text-2xl font-bold mt-1">{accounts.length}</p>
              <p className="text-xs text-muted-foreground">{connected} connected</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <p className="text-xs text-muted-foreground uppercase tracking-wide">Daily capacity</p>
              <p className="text-2xl font-bold mt-1">{totalCapacity.toLocaleString()}</p>
              <p className="text-xs text-muted-foreground">emails / day</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <p className="text-xs text-muted-foreground uppercase tracking-wide">Sent today</p>
              <p className="text-2xl font-bold mt-1">{sentToday.toLocaleString()}</p>
              <p className="text-xs text-muted-foreground">
                {totalCapacity > 0 ? `${Math.round((sentToday / totalCapacity) * 100)}% of capacity` : "—"}
              </p>
            </CardContent>
          </Card>
        </div>

        {/* Account list */}
        {isLoading ? (
          <div className="space-y-3">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-24 bg-muted/40 rounded-lg animate-pulse" />
            ))}
          </div>
        ) : accounts.length === 0 ? (
          <Card>
            <CardContent className="py-16 flex flex-col items-center gap-3 text-center">
              <div className="w-12 h-12 rounded-full bg-muted flex items-center justify-center">
                <Mail className="w-6 h-6 text-muted-foreground" />
              </div>
              <div>
                <p className="font-medium">No sending accounts connected</p>
                <p className="text-sm text-muted-foreground mt-1">
                  Connect Gmail, Outlook, Amazon SES, or any SMTP provider to start sending.
                </p>
              </div>
              <Button onClick={openAdd} className="gap-2 mt-2">
                <Plus className="w-4 h-4" /> Connect your first account
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-3">
            {accounts.map((a) => (
              <AccountCard key={a.id} account={a} onEdit={openEdit} />
            ))}
          </div>
        )}

        {/* Sender Pools CTA */}
        {accounts.length >= 2 && (
          <Card className="border-dashed">
            <CardContent className="p-4 flex items-center gap-3">
              <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center flex-shrink-0">
                <Zap className="w-4 h-4 text-primary" />
              </div>
              <div className="flex-1">
                <p className="text-sm font-medium">Create a Sender Pool</p>
                <p className="text-xs text-muted-foreground">
                  Group multiple accounts for round-robin, weighted, or random rotation with automatic daily-limit failover.
                </p>
              </div>
              <Button variant="outline" size="sm" className="gap-1 flex-shrink-0" asChild>
                <a href="/sender-pools">
                  Manage pools <ChevronRight className="w-3.5 h-3.5" />
                </a>
              </Button>
            </CardContent>
          </Card>
        )}
      </div>

      <AccountFormDialog open={showForm} onClose={closeForm} editId={editId} />
    </Shell>
  );
}
