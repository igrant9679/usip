import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FormDialog, SelectField, Section, StatusPill, fmtDate } from "@/components/usip/Common";
import { EmptyState, PageHeader, Shell } from "@/components/usip/Shell";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { trpc } from "@/lib/trpc";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  CheckCircle2,
  Clock,
  Copy,
  KeyRound,
  Link2,
  LogIn,
  Mail,
  RefreshCw,
  Shield,
  UserMinus,
  UserPlus,
  Users,
  XCircle,
} from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";

type Role = "super_admin" | "admin" | "manager" | "rep";
const ROLES: Role[] = ["super_admin", "admin", "manager", "rep"];
const ROLE_RANK: Record<Role, number> = { super_admin: 4, admin: 3, manager: 2, rep: 1 };

function roleTone(r: Role) {
  return r === "super_admin" ? "danger" : r === "admin" ? "warning" : r === "manager" ? "info" : "muted";
}

type Tab = "members" | "login_history" | "settings";

export default function Team() {
  const { current } = useWorkspace();
  const myRole = (current?.role as Role) ?? "rep";
  const isAdmin = myRole === "admin" || myRole === "super_admin";

  const utils = trpc.useUtils();
  const { data, isLoading } = trpc.team.list.useQuery();

  const [activeTab, setActiveTab] = useState<Tab>("members");
  const [filter, setFilter] = useState("");
  const [roleFilter, setRoleFilter] = useState<"all" | Role>("all");
  const [showInactive, setShowInactive] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());

  const [inviteOpen, setInviteOpen] = useState(false);
  const [deactivateTarget, setDeactivateTarget] = useState<any | null>(null);
  const [reassignTo, setReassignTo] = useState<number | null>(null);

  // Set Password dialog
  const [pwTarget, setPwTarget] = useState<any | null>(null);
  const [pwValue, setPwValue] = useState("");
  const [pwConfirm, setPwConfirm] = useState("");

  // Login History
  const [historyTarget, setHistoryTarget] = useState<any | null>(null);
  const { data: loginHistoryData, isLoading: historyLoading } = trpc.team.getLoginHistory.useQuery(
    { memberId: historyTarget?.memberId ?? 0 },
    { enabled: !!historyTarget }
  );

  // Invite expiry settings
  const [expiryDays, setExpiryDays] = useState<string>("7");
  const { data: wsSettings } = trpc.settings.get.useQuery(undefined, {
    onSuccess: (d: any) => {
      if (d?.inviteExpiryDays != null) setExpiryDays(String(d.inviteExpiryDays));
      else setExpiryDays("7");
    },
  } as any);

  const filtered = useMemo(() => {
    const rows = data ?? [];
    return rows.filter((r: any) => {
      if (!showInactive && r.deactivatedAt) return false;
      if (roleFilter !== "all" && r.role !== roleFilter) return false;
      if (filter) {
        const q = filter.toLowerCase();
        return (
          (r.name ?? "").toLowerCase().includes(q) ||
          (r.email ?? "").toLowerCase().includes(q) ||
          (r.title ?? "").toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [data, filter, roleFilter, showInactive]);

  const invite = trpc.team.invite.useMutation({
    onSuccess: () => {
      utils.team.list.invalidate();
      setInviteOpen(false);
      toast.success("Member invited");
    },
    onError: (e) => toast.error(e.message),
  });
  const changeRole = trpc.team.changeRole.useMutation({
    onSuccess: () => {
      utils.team.list.invalidate();
      toast.success("Role updated");
    },
    onError: (e) => toast.error(e.message),
  });
  const deactivate = trpc.team.deactivate.useMutation({
    onSuccess: (res) => {
      utils.team.list.invalidate();
      setDeactivateTarget(null);
      setReassignTo(null);
      toast.success(`Deactivated — reassigned ${res.reassigned.leads} leads, ${res.reassigned.opportunities} opps, ${res.reassigned.openTasks} tasks`);
    },
    onError: (e) => toast.error(e.message),
  });
  const reactivate = trpc.team.reactivate.useMutation({
    onSuccess: () => {
      utils.team.list.invalidate();
      toast.success("Reactivated");
    },
  });
  const bulkChange = trpc.team.bulkChangeRole.useMutation({
    onSuccess: () => {
      utils.team.list.invalidate();
      setSelected(new Set());
      toast.success("Roles updated");
    },
    onError: (e) => toast.error(e.message),
  });

  const [bulkDeactivateOpen, setBulkDeactivateOpen] = useState(false);
  const [bulkReassignTo, setBulkReassignTo] = useState<number | null>(null);
  const allActiveOthers = (data ?? []).filter((m: any) => !m.deactivatedAt);

  const bulkDeactivate = trpc.team.bulkDeactivate.useMutation({
    onSuccess: (res) => {
      utils.team.list.invalidate();
      setSelected(new Set());
      setBulkDeactivateOpen(false);
      setBulkReassignTo(null);
      toast.success(`Deactivated ${res.deactivated} member(s)${res.skipped ? `, skipped ${res.skipped}` : ""}`);
    },
    onError: (e) => toast.error(e.message),
  });

  const setMemberPassword = trpc.team.setMemberPassword.useMutation({
    onSuccess: () => {
      setPwTarget(null);
      setPwValue("");
      setPwConfirm("");
      toast.success("Password updated successfully");
    },
    onError: (e) => toast.error(e.message),
  });

  const resendInvitation = trpc.team.resendInvitation.useMutation({
    onSuccess: () => toast.success("Invitation re-sent"),
    onError: (e) => toast.error(e.message),
  });

  const copyInviteLink = trpc.team.copyInviteLink.useMutation({
    onSuccess: (res) => {
      navigator.clipboard.writeText(res.url).then(() => {
        toast.success("Invite link copied to clipboard");
      }).catch(() => {
        toast.success(`Invite link: ${res.url}`);
      });
    },
    onError: (e) => toast.error(e.message),
  });

  const updateInviteExpiry = trpc.team.updateInviteExpiry.useMutation({
    onSuccess: () => {
      utils.settings.get.invalidate();
      toast.success("Invitation expiry updated");
    },
    onError: (e) => toast.error(e.message),
  });

  const pwMismatch = pwValue.length > 0 && pwConfirm.length > 0 && pwValue !== pwConfirm;
  const pwTooShort = pwValue.length > 0 && pwValue.length < 8;

  const canChange = (targetRole: Role, targetUserId: number) => {
    if (!isAdmin) return false;
    if (myRole === "super_admin") return true;
    if (targetUserId === (current as any)?.userId) return true;
    return ROLE_RANK[targetRole] < ROLE_RANK[myRole];
  };

  const toggleSelect = (id: number) => {
    setSelected((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  };

  const activeOthers = (data ?? []).filter((m: any) => !m.deactivatedAt && m.userId !== deactivateTarget?.userId);

  const TABS: { id: Tab; label: string }[] = [
    { id: "members", label: "Members" },
    { id: "login_history", label: "Login History" },
    ...(isAdmin ? [{ id: "settings" as Tab, label: "Settings" }] : []),
  ];

  function outcomeIcon(outcome: string) {
    if (outcome === "success") return <CheckCircle2 className="size-3.5 text-emerald-500" />;
    if (outcome === "failed") return <XCircle className="size-3.5 text-rose-500" />;
    return <Clock className="size-3.5 text-amber-500" />;
  }

  return (
    <Shell title="Team">
      <PageHeader title="Workspace team" description="Members, roles, quotas, and access controls.">
        {isAdmin && (
          <Button onClick={() => setInviteOpen(true)}>
            <UserPlus className="size-4" /> Invite
          </Button>
        )}
      </PageHeader>

      {/* Tab bar */}
      <div className="px-6 border-b flex items-center gap-1">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setActiveTab(t.id)}
            className={`px-3 py-2.5 text-sm font-medium border-b-2 transition-colors ${
              activeTab === t.id
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* ── Members tab ── */}
      {activeTab === "members" && (
        <div className="p-6 space-y-4">
          {/* Filter bar */}
          <div className="flex items-center gap-2 flex-wrap">
            <Input
              placeholder="Search name, email, title…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="max-w-xs"
            />
            <div className="flex items-center gap-1 bg-secondary rounded-md p-0.5">
              {(["all", ...ROLES] as const).map((r) => (
                <button
                  key={r}
                  onClick={() => setRoleFilter(r)}
                  className={`px-2 py-1 text-xs rounded ${roleFilter === r ? "bg-card shadow-sm" : "text-muted-foreground"}`}
                >
                  {r}
                </button>
              ))}
            </div>
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground ml-1">
              <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
              Show deactivated
            </label>
            <div className="ml-auto text-xs text-muted-foreground">
              {filtered.length} of {data?.length ?? 0} members
            </div>
          </div>

          {/* Bulk bar */}
          {isAdmin && selected.size > 0 && (
            <div className="flex items-center gap-2 rounded-md border bg-card p-2">
              <Shield className="size-4 text-muted-foreground" />
              <div className="text-sm">{selected.size} selected</div>
              <div className="ml-auto flex items-center gap-1">
                <span className="text-xs text-muted-foreground mr-1">Change role to:</span>
                {ROLES.filter((r) => ROLE_RANK[r] <= ROLE_RANK[myRole]).map((r) => (
                  <Button
                    key={r}
                    size="sm"
                    variant="ghost"
                    onClick={() => bulkChange.mutate({ memberIds: Array.from(selected), role: r })}
                  >
                    {r}
                  </Button>
                ))}
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-rose-600 hover:text-rose-700"
                  onClick={() => setBulkDeactivateOpen(true)}
                >
                  <UserMinus className="size-3.5" /> Deactivate
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
                  Clear
                </Button>
              </div>
            </div>
          )}

          <Section title={`Members (${filtered.length})`}>
            {isLoading ? (
              <div className="p-4 text-sm text-muted-foreground">Loading…</div>
            ) : filtered.length === 0 ? (
              <EmptyState icon={Users} title="No members match" />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-xs text-muted-foreground border-b">
                    <tr className="text-left">
                      {isAdmin && <th className="w-8 px-3 py-2" />}
                      <th className="px-3 py-2">Member</th>
                      <th className="px-3 py-2">Title</th>
                      <th className="px-3 py-2">Role</th>
                      <th className="px-3 py-2">Quota</th>
                      <th className="px-3 py-2">Last active</th>
                      <th className="px-3 py-2">Deactivated</th>
                      <th className="px-3 py-2">Status</th>
                      <th className="px-3 py-2 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((m: any) => {
                      const isInactive = Boolean(m.deactivatedAt);
                      const editable = canChange(m.role, m.userId);
                      const isPendingInvite = m.loginMethod === "invite";
                      const isExpiredInvite = m.loginMethod === "expired_invite";
                      return (
                        <tr key={m.memberId} className={`border-b ${isInactive ? "opacity-60" : ""}`}>
                          {isAdmin && (
                            <td className="px-3 py-2">
                              <input
                                type="checkbox"
                                checked={selected.has(m.memberId)}
                                onChange={() => toggleSelect(m.memberId)}
                                disabled={isInactive}
                              />
                            </td>
                          )}
                          <td className="px-3 py-2">
                            <div className="flex items-center gap-2 min-w-0">
                              <div className="size-8 rounded-full bg-secondary flex items-center justify-center text-xs font-medium shrink-0 overflow-hidden">
                                {m.avatarUrl ? (
                                  <img src={m.avatarUrl} alt="" className="size-8 object-cover" />
                                ) : (
                                  (m.name ?? m.email ?? "?").slice(0, 1).toUpperCase()
                                )}
                              </div>
                              <div className="min-w-0">
                                <div className="font-medium truncate flex items-center gap-1.5">
                                  {m.name ?? m.email}
                                  {isPendingInvite && (
                                    <span className="inline-flex items-center gap-0.5 text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">
                                      <Mail className="size-2.5" /> Pending
                                    </span>
                                  )}
                                  {isExpiredInvite && (
                                    <span className="inline-flex items-center gap-0.5 text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-400">
                                      <Clock className="size-2.5" /> Expired
                                    </span>
                                  )}
                                </div>
                                <div className="text-xs text-muted-foreground truncate">{m.email}</div>
                              </div>
                            </div>
                          </td>
                          <td className="px-3 py-2 text-xs text-muted-foreground">{m.title ?? "—"}</td>
                          <td className="px-3 py-2">
                            {editable ? (
                              <select
                                className="text-xs border rounded px-1.5 py-1 bg-background"
                                value={m.role}
                                onChange={(e) => changeRole.mutate({ memberId: m.memberId, role: e.target.value as Role })}
                              >
                                {ROLES.filter((r) => ROLE_RANK[r] <= ROLE_RANK[myRole] || r === m.role).map((r) => (
                                  <option key={r} value={r}>
                                    {r}
                                  </option>
                                ))}
                              </select>
                            ) : (
                              <StatusPill tone={roleTone(m.role)}>{m.role}</StatusPill>
                            )}
                          </td>
                          <td className="px-3 py-2 tabular-nums text-xs">
                            {m.quota ? `$${Number(m.quota).toLocaleString()}` : "—"}
                          </td>
                          <td className="px-3 py-2 text-xs text-muted-foreground">
                            {m.lastActiveAt ? fmtDate(m.lastActiveAt) : "—"}
                          </td>
                          <td className="px-3 py-2 text-xs text-muted-foreground">
                            {m.deactivatedAt ? fmtDate(m.deactivatedAt) : "—"}
                          </td>
                          <td className="px-3 py-2">
                            {isInactive ? (
                              <StatusPill tone="muted">deactivated</StatusPill>
                            ) : (
                              <StatusPill tone="success">active</StatusPill>
                            )}
                          </td>
                          <td className="px-3 py-2 text-right">
                            {isAdmin && (
                              <div className="flex items-center gap-1 justify-end flex-wrap">
                                {isInactive ? (
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    onClick={() => reactivate.mutate({ memberId: m.memberId })}
                                  >
                                    Reactivate
                                  </Button>
                                ) : (
                                  <>
                                    {editable && (
                                      <Button
                                        size="sm"
                                        variant="ghost"
                                        title="Set password"
                                        onClick={() => { setPwTarget(m); setPwValue(""); setPwConfirm(""); }}
                                      >
                                        <KeyRound className="size-3.5" />
                                        <span className="hidden sm:inline ml-1">Set Password</span>
                                      </Button>
                                    )}
                                    {(isPendingInvite || isExpiredInvite) && editable && (
                                      <>
                                        <Button
                                          size="sm"
                                          variant="ghost"
                                          title="Resend invitation email"
                                          disabled={resendInvitation.isPending}
                                          onClick={() => resendInvitation.mutate({ memberId: m.memberId })}
                                        >
                                          <RefreshCw className="size-3.5" />
                                          <span className="hidden sm:inline ml-1">Resend</span>
                                        </Button>
                                        <Button
                                          size="sm"
                                          variant="ghost"
                                          title="Copy invite link"
                                          disabled={copyInviteLink.isPending}
                                          onClick={() => copyInviteLink.mutate({ memberId: m.memberId, origin: window.location.origin })}
                                        >
                                          <Link2 className="size-3.5" />
                                          <span className="hidden sm:inline ml-1">Copy Link</span>
                                        </Button>
                                      </>
                                    )}
                                    <Button
                                      size="sm"
                                      variant="ghost"
                                      title="View login history"
                                      onClick={() => { setHistoryTarget(m); setActiveTab("login_history"); }}
                                    >
                                      <LogIn className="size-3.5" />
                                    </Button>
                                    {editable && (
                                      <Button
                                        size="sm"
                                        variant="ghost"
                                        className="text-rose-600"
                                        onClick={() => { setDeactivateTarget(m); setReassignTo(null); }}
                                      >
                                        <UserMinus className="size-3.5" /> Deactivate
                                      </Button>
                                    )}
                                  </>
                                )}
                              </div>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Section>
        </div>
      )}

      {/* ── Login History tab ── */}
      {activeTab === "login_history" && (
        <div className="p-6 space-y-4">
          <div className="flex items-center gap-3">
            <div className="text-sm text-muted-foreground">
              {historyTarget
                ? `Showing sign-in history for ${historyTarget.name ?? historyTarget.email}`
                : "Select a member from the Members tab to view their login history, or browse all recent events below."}
            </div>
            {historyTarget && (
              <Button size="sm" variant="ghost" onClick={() => setHistoryTarget(null)}>
                Clear filter
              </Button>
            )}
          </div>
          <Section title="Recent sign-in events">
            {historyLoading ? (
              <div className="p-4 text-sm text-muted-foreground">Loading…</div>
            ) : !historyTarget ? (
              <EmptyState icon={LogIn} title="Select a member to view their login history" description="Click the login history icon on any member row." />
            ) : !loginHistoryData || loginHistoryData.length === 0 ? (
              <EmptyState icon={LogIn} title="No login events found" description="This member has not signed in yet." />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-xs text-muted-foreground border-b">
                    <tr className="text-left">
                      <th className="px-3 py-2">Date / Time</th>
                      <th className="px-3 py-2">Outcome</th>
                      <th className="px-3 py-2">IP Address</th>
                      <th className="px-3 py-2">User Agent</th>
                    </tr>
                  </thead>
                  <tbody>
                    {loginHistoryData.map((row: any) => (
                      <tr key={row.id} className="border-b">
                        <td className="px-3 py-2 text-xs tabular-nums whitespace-nowrap">
                          {new Date(row.createdAt).toLocaleString()}
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex items-center gap-1.5">
                            {outcomeIcon(row.outcome)}
                            <span className={`text-xs font-medium ${
                              row.outcome === "success" ? "text-emerald-600" :
                              row.outcome === "failed" ? "text-rose-600" : "text-amber-600"
                            }`}>
                              {row.outcome}
                            </span>
                          </div>
                        </td>
                        <td className="px-3 py-2 text-xs text-muted-foreground font-mono">
                          {row.ipAddress || "—"}
                        </td>
                        <td className="px-3 py-2 text-xs text-muted-foreground max-w-xs truncate" title={row.userAgent}>
                          {row.userAgent || "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Section>
        </div>
      )}

      {/* ── Settings tab ── */}
      {activeTab === "settings" && isAdmin && (
        <div className="p-6 max-w-lg space-y-6">
          <Section title="Invitation expiry">
            <div className="p-4 space-y-4">
              <p className="text-sm text-muted-foreground">
                Pending invitations will automatically expire after the configured number of days. Set to <strong>0</strong> to disable expiry (invitations never expire).
              </p>
              <div className="flex items-end gap-3">
                <div className="space-y-1 flex-1">
                  <Label htmlFor="expiry-days">Expiry (days)</Label>
                  <Input
                    id="expiry-days"
                    type="number"
                    min={0}
                    max={365}
                    placeholder="7"
                    value={expiryDays}
                    onChange={(e) => setExpiryDays(e.target.value)}
                    className="max-w-xs"
                  />
                  <p className="text-xs text-muted-foreground">
                    Current: {wsSettings && (wsSettings as any).inviteExpiryDays != null
                      ? `${(wsSettings as any).inviteExpiryDays} days`
                      : "7 days (default)"}
                  </p>
                </div>
                <Button
                  disabled={updateInviteExpiry.isPending || expiryDays === ""}
                  onClick={() => {
                    const days = parseInt(expiryDays, 10);
                    if (isNaN(days) || days < 0 || days > 365) {
                      toast.error("Enter a number between 0 and 365");
                      return;
                    }
                    updateInviteExpiry.mutate({ days });
                  }}
                >
                  {updateInviteExpiry.isPending ? "Saving…" : "Save"}
                </Button>
              </div>
            </div>
          </Section>
        </div>
      )}

      {/* Invite dialog */}
      <FormDialog
        open={inviteOpen}
        onOpenChange={setInviteOpen}
        title="Invite member"
        isPending={invite.isPending}
        submitLabel="Send invite"
        onSubmit={(f) => {
          const quotaStr = String(f.get("quota") ?? "").trim();
          invite.mutate({
            email: String(f.get("email") ?? "").trim(),
            name: String(f.get("name") ?? "").trim() || undefined,
            role: (f.get("role") as Role) ?? "rep",
            title: String(f.get("title") ?? "").trim() || undefined,
            quota: quotaStr ? Number(quotaStr) : undefined,
          });
        }}
      >
        <Field name="email" label="Work email" type="email" required placeholder="sam@acme.com" />
        <Field name="name" label="Full name (optional)" />
        <Field name="title" label="Title (optional)" placeholder="Account Executive" />
        <SelectField
          name="role"
          label="Role"
          defaultValue="rep"
          options={ROLES.filter((r) => ROLE_RANK[r] <= ROLE_RANK[myRole]).map((r) => ({ value: r, label: r }))}
        />
        <Field name="quota" label="Annual quota (optional)" type="number" placeholder="250000" />
      </FormDialog>

      {/* Set Password dialog */}
      <Dialog open={!!pwTarget} onOpenChange={(v) => { if (!v) { setPwTarget(null); setPwValue(""); setPwConfirm(""); } }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Set password — {pwTarget?.name ?? pwTarget?.email}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <p className="text-sm text-muted-foreground">
              Set a local password for this member. They can use it to sign in directly if your workspace supports password-based login.
            </p>
            <div className="space-y-1">
              <Label htmlFor="pw-new">New password</Label>
              <Input
                id="pw-new"
                type="password"
                placeholder="Min. 8 characters"
                value={pwValue}
                onChange={(e) => setPwValue(e.target.value)}
                autoComplete="new-password"
              />
              {pwTooShort && <p className="text-xs text-rose-500">Password must be at least 8 characters.</p>}
            </div>
            <div className="space-y-1">
              <Label htmlFor="pw-confirm">Confirm password</Label>
              <Input
                id="pw-confirm"
                type="password"
                placeholder="Re-enter password"
                value={pwConfirm}
                onChange={(e) => setPwConfirm(e.target.value)}
                autoComplete="new-password"
              />
              {pwMismatch && <p className="text-xs text-rose-500">Passwords do not match.</p>}
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => { setPwTarget(null); setPwValue(""); setPwConfirm(""); }}>
              Cancel
            </Button>
            <Button
              disabled={!pwValue || !pwConfirm || pwMismatch || pwTooShort || setMemberPassword.isPending}
              onClick={() => {
                if (!pwTarget || !pwValue || pwMismatch || pwTooShort) return;
                setMemberPassword.mutate({ memberId: pwTarget.memberId, password: pwValue });
              }}
            >
              <KeyRound className="size-4" />
              {setMemberPassword.isPending ? "Saving…" : "Set password"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Deactivate dialog */}
      <Dialog open={!!deactivateTarget} onOpenChange={(v) => !v && setDeactivateTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Deactivate {deactivateTarget?.name ?? deactivateTarget?.email}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <p className="text-muted-foreground">
              Their open leads, opportunities, and open tasks must be reassigned to another active member before deactivation.
            </p>
            <div className="space-y-1">
              <Label>Reassign owned work to</Label>
              <select
                className="w-full border rounded-md px-2 py-1.5 bg-background"
                value={reassignTo ?? ""}
                onChange={(e) => setReassignTo(e.target.value ? Number(e.target.value) : null)}
              >
                <option value="">— select member —</option>
                {activeOthers.map((m: any) => (
                  <option key={m.userId} value={m.userId}>
                    {m.name ?? m.email} · {m.role}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeactivateTarget(null)}>
              Cancel
            </Button>
            <Button
              disabled={!reassignTo || deactivate.isPending}
              className="text-rose-700"
              onClick={() => {
                if (!deactivateTarget || !reassignTo) return;
                deactivate.mutate({ memberId: deactivateTarget.memberId, reassignToUserId: reassignTo });
              }}
            >
              <Mail className="size-4" /> Deactivate & reassign
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Bulk Deactivate Dialog */}
      <Dialog open={bulkDeactivateOpen} onOpenChange={(v) => { if (!v) { setBulkDeactivateOpen(false); setBulkReassignTo(null); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Bulk deactivate {selected.size} member(s)</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <p className="text-sm text-muted-foreground">
              All owned leads, opportunities, and open tasks will be reassigned to the selected member.
              Members who are already deactivated, yourself, or peers above your rank will be skipped.
            </p>
            <div>
              <label className="text-sm font-medium">Reassign work to</label>
              <select
                className="mt-1 w-full border rounded-md px-2 py-1.5 text-sm bg-background"
                value={bulkReassignTo ?? ""}
                onChange={(e) => setBulkReassignTo(Number(e.target.value) || null)}
              >
                <option value="">Select member…</option>
                {allActiveOthers
                  .filter((m: any) => !selected.has(m.memberId))
                  .map((m: any) => (
                    <option key={m.userId} value={m.userId}>{m.name ?? m.email} ({m.role})</option>
                  ))}
              </select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => { setBulkDeactivateOpen(false); setBulkReassignTo(null); }}>Cancel</Button>
            <Button
              variant="destructive"
              disabled={!bulkReassignTo || bulkDeactivate.isPending}
              onClick={() => {
                if (!bulkReassignTo) return;
                bulkDeactivate.mutate({ memberIds: Array.from(selected), reassignToUserId: bulkReassignTo });
              }}
            >
              {bulkDeactivate.isPending ? "Deactivating…" : `Deactivate ${selected.size} member(s)`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Shell>
  );
}
