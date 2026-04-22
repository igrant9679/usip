import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FormDialog, SelectField, Section, StatusPill, fmtDate } from "@/components/usip/Common";
import { EmptyState, PageHeader, Shell } from "@/components/usip/Shell";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { trpc } from "@/lib/trpc";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Mail, Shield, UserMinus, UserPlus, Users } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";

type Role = "super_admin" | "admin" | "manager" | "rep";
const ROLES: Role[] = ["super_admin", "admin", "manager", "rep"];
const ROLE_RANK: Record<Role, number> = { super_admin: 4, admin: 3, manager: 2, rep: 1 };

function roleTone(r: Role) {
  return r === "super_admin" ? "danger" : r === "admin" ? "warning" : r === "manager" ? "info" : "muted";
}

export default function Team() {
  const { current } = useWorkspace();
  const myRole = (current?.role as Role) ?? "rep";
  const isAdmin = myRole === "admin" || myRole === "super_admin";

  const utils = trpc.useUtils();
  const { data, isLoading } = trpc.team.list.useQuery();

  const [filter, setFilter] = useState("");
  const [roleFilter, setRoleFilter] = useState<"all" | Role>("all");
  const [showInactive, setShowInactive] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());

  const [inviteOpen, setInviteOpen] = useState(false);
  const [deactivateTarget, setDeactivateTarget] = useState<any | null>(null);
  const [reassignTo, setReassignTo] = useState<number | null>(null);

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

  return (
    <Shell title="Team">
      <PageHeader title="Workspace team" description="Members, roles, quotas, and access controls.">
        {isAdmin && (
          <Button onClick={() => setInviteOpen(true)}>
            <UserPlus className="size-4" /> Invite
          </Button>
        )}
      </PageHeader>

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
                    <th className="px-3 py-2">Status</th>
                    <th className="px-3 py-2 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((m: any) => {
                    const isInactive = Boolean(m.deactivatedAt);
                    const editable = canChange(m.role, m.userId);
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
                            <div className="size-8 rounded-full bg-secondary flex items-center justify-center text-xs font-medium overflow-hidden">
                              {m.avatarUrl ? (
                                <img src={m.avatarUrl} alt="" className="size-8 object-cover" />
                              ) : (
                                (m.name ?? m.email ?? "?").slice(0, 1).toUpperCase()
                              )}
                            </div>
                            <div className="min-w-0">
                              <div className="font-medium truncate">{m.name ?? m.email}</div>
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
                        <td className="px-3 py-2">
                          {isInactive ? (
                            <StatusPill tone="muted">deactivated</StatusPill>
                          ) : (
                            <StatusPill tone="success">active</StatusPill>
                          )}
                        </td>
                        <td className="px-3 py-2 text-right">
                          {isAdmin && (
                            <div className="flex items-center gap-1 justify-end">
                              {isInactive ? (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  onClick={() => reactivate.mutate({ memberId: m.memberId })}
                                >
                                  Reactivate
                                </Button>
                              ) : (
                                editable && (
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    className="text-rose-600"
                                    onClick={() => {
                                      setDeactivateTarget(m);
                                      setReassignTo(null);
                                    }}
                                  >
                                    <UserMinus className="size-3.5" /> Deactivate
                                  </Button>
                                )
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
    </Shell>
  );
}
