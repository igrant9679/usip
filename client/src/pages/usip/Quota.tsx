import { useState, useMemo } from "react";
import { trpc } from "@/lib/trpc";
import { Shell, PageHeader } from "@/components/usip/Shell";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Progress } from "@/components/ui/progress";
import { Pencil, Plus, Trash2, TrendingUp } from "lucide-react";
import { toast } from "sonner";

function fmt$(n: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n);
}

function AttainmentBar({ label, pct }: { label: string; pct: number | null }) {
  if (pct === null) return null;
  const color = pct >= 100 ? "bg-emerald-500" : pct >= 75 ? "bg-blue-500" : pct >= 50 ? "bg-amber-500" : "bg-red-400";
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs text-muted-foreground">
        <span>{label}</span>
        <span className={pct >= 100 ? "text-emerald-600 font-semibold" : ""}>{pct}%</span>
      </div>
      <div className="h-2 rounded-full bg-muted overflow-hidden">
        <div className={`h-full rounded-full transition-all ${color}`} style={{ width: `${Math.min(pct, 100)}%` }} />
      </div>
    </div>
  );
}

function currentPeriod() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export default function Quota() {
  const [period, setPeriod] = useState(currentPeriod);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<any>(null);
  const [form, setForm] = useState({ userId: "", periodType: "monthly", revenueTarget: "", dealsTarget: "", activitiesTarget: "" });

  const { data: members = [] } = trpc.team.list.useQuery(undefined);
  const { data: targets = [], refetch } = trpc.quota.list.useQuery({ period });
  const utils = trpc.useUtils();

  const setQuota = trpc.quota.set.useMutation({
    onSuccess: () => { refetch(); setDialogOpen(false); toast.success("Quota saved"); },
    onError: (e) => toast.error(e.message),
  });
  const removeQuota = trpc.quota.remove.useMutation({
    onSuccess: () => { refetch(); toast.success("Quota removed"); },
    onError: (e) => toast.error(e.message),
  });

  const activeMembers = members.filter((m: any) => !m.deactivatedAt);

  function openAdd() {
    setEditTarget(null);
    setForm({ userId: "", periodType: "monthly", revenueTarget: "", dealsTarget: "", activitiesTarget: "" });
    setDialogOpen(true);
  }
  function openEdit(t: any) {
    setEditTarget(t);
    setForm({
      userId: String(t.userId),
      periodType: t.periodType,
      revenueTarget: String(t.revenueTarget),
      dealsTarget: String(t.dealsTarget),
      activitiesTarget: String(t.activitiesTarget),
    });
    setDialogOpen(true);
  }
  function handleSave() {
    if (!form.userId) return;
    setQuota.mutate({
      userId: Number(form.userId),
      period,
      periodType: form.periodType as any,
      revenueTarget: Number(form.revenueTarget) || 0,
      dealsTarget: Number(form.dealsTarget) || 0,
      activitiesTarget: Number(form.activitiesTarget) || 0,
    });
  }

  // Generate period options: last 12 months + next 3
  const periodOptions = useMemo(() => {
    const opts: string[] = [];
    const now = new Date();
    for (let i = -12; i <= 3; i++) {
      const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
      opts.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
    }
    return opts;
  }, []);

  return (
    <Shell title="Quota Management">
      <PageHeader title="Quota Management" description="Set and track revenue, deal, and activity quotas per rep and per period." pageKey="quota"
        icon={<TrendingUp className="size-5" />}
      >
        <div className="flex items-center gap-3">
          <Select value={period} onValueChange={setPeriod}>
            <SelectTrigger className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {periodOptions.map((p) => (
                <SelectItem key={p} value={p}>{p}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button onClick={openAdd} size="sm">
            <Plus className="h-4 w-4 mr-1" /> Add Target
          </Button>
        </div>
      </PageHeader>
      <div className="p-6 max-w-5xl mx-auto space-y-6">

        {/* Quota cards */}
        {targets.length === 0 && (
          <Card className="flex items-center justify-center h-48">
            <div className="text-center text-muted-foreground">
              <TrendingUp className="h-10 w-10 mx-auto mb-3 opacity-30" />
              <p className="text-sm">No quota targets set for {period}</p>
              <Button variant="outline" size="sm" className="mt-3" onClick={openAdd}>Set first target</Button>
            </div>
          </Card>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {targets.map((t: any) => {
            const member = activeMembers.find((m: any) => m.userId === t.userId);
            const name = member ? (member.name ?? member.email ?? `User #${t.userId}`) : `User #${t.userId}`;
            return (
              <QuotaCard
                key={t.id}
                target={t}
                name={name}
                workspaceId={t.workspaceId}
                period={period}
                onEdit={() => openEdit(t)}
                onRemove={() => removeQuota.mutate({ id: t.id })}
              />
            );
          })}
        </div>

        {/* Add/Edit dialog */}
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{editTarget ? "Edit Quota Target" : "Add Quota Target"}</DialogTitle>
            </DialogHeader>
            <div className="space-y-4 py-2">
              <div className="space-y-1.5">
                <Label>Team Member</Label>
                <Select value={form.userId} onValueChange={(v) => setForm((f) => ({ ...f, userId: v }))} disabled={!!editTarget}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select member…" />
                  </SelectTrigger>
                  <SelectContent>
                    {activeMembers.map((m: any) => (
                      <SelectItem key={m.userId} value={String(m.userId)}>
                        {m.name ?? m.email ?? `User #${m.userId}`}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Period Type</Label>
                <Select value={form.periodType} onValueChange={(v) => setForm((f) => ({ ...f, periodType: v }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="monthly">Monthly</SelectItem>
                    <SelectItem value="quarterly">Quarterly</SelectItem>
                    <SelectItem value="annual">Annual</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div className="space-y-1.5">
                  <Label>Revenue ($)</Label>
                  <Input type="number" min="0" value={form.revenueTarget} onChange={(e) => setForm((f) => ({ ...f, revenueTarget: e.target.value }))} placeholder="0" />
                </div>
                <div className="space-y-1.5">
                  <Label>Deals</Label>
                  <Input type="number" min="0" value={form.dealsTarget} onChange={(e) => setForm((f) => ({ ...f, dealsTarget: e.target.value }))} placeholder="0" />
                </div>
                <div className="space-y-1.5">
                  <Label>Activities</Label>
                  <Input type="number" min="0" value={form.activitiesTarget} onChange={(e) => setForm((f) => ({ ...f, activitiesTarget: e.target.value }))} placeholder="0" />
                </div>
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
              <Button onClick={handleSave} disabled={setQuota.isPending || !form.userId}>Save</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </Shell>
  );
}

function QuotaCard({ target, name, workspaceId, period, onEdit, onRemove }: any) {
  const { data: progress } = trpc.quota.progress.useQuery({ userId: target.userId, period });

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base truncate">{name}</CardTitle>
          <div className="flex gap-1 shrink-0">
            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onEdit}><Pencil className="h-3.5 w-3.5" /></Button>
            <Button variant="ghost" size="icon" className="h-7 w-7 text-red-500 hover:text-red-600" onClick={onRemove}><Trash2 className="h-3.5 w-3.5" /></Button>
          </div>
        </div>
        <Badge variant="outline" className="w-fit text-xs">{target.periodType}</Badge>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Targets */}
        <div className="grid grid-cols-3 gap-2 text-center">
          <div>
            <p className="text-xs text-muted-foreground">Revenue</p>
            <p className="text-sm font-semibold">{fmt$(Number(target.revenueTarget))}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Deals</p>
            <p className="text-sm font-semibold">{target.dealsTarget}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Activities</p>
            <p className="text-sm font-semibold">{target.activitiesTarget}</p>
          </div>
        </div>

        {/* Attainment */}
        {progress && (
          <div className="space-y-2.5 pt-1 border-t">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Attainment</p>
            <AttainmentBar label={`Revenue: ${fmt$(progress.actual.revenue)}`} pct={progress.attainment.revenue} />
            <AttainmentBar label={`Deals: ${progress.actual.deals}`} pct={progress.attainment.deals} />
            <AttainmentBar label={`Activities: ${progress.actual.activities}`} pct={progress.attainment.activities} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
