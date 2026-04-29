/**
 * Campaigns — full outreach campaign management
 * List + detail/analytics layout consistent with Apollo-style CRM.
 */
import { useState } from "react";
import { Shell, PageHeader, EmptyState, StatCard } from "@/components/usip/Shell";
import { trpc } from "@/lib/trpc";
import { EntityPicker } from "@/components/usip/EntityPicker";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Progress } from "@/components/ui/progress";
import {
  Megaphone, Plus, Rocket, Pause, Trash2, Settings2,
  Mail, MousePointerClick, Reply, AlertTriangle,
  BarChart3, Loader2, GitBranch, Users, Layers, CheckSquare, Square, CheckCircle2, Layers3
} from "lucide-react";
import { toast } from "sonner";

/* ─── Status helpers ─────────────────────────────────────────────────── */
const STATUS_COLORS: Record<string, string> = {
  planning:  "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
  scheduled: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300",
  live:      "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300",
  paused:    "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-300",
  completed: "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300",
};

function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium capitalize ${STATUS_COLORS[status] ?? STATUS_COLORS.planning}`}>
      {status}
    </span>
  );
}

function pct(num: number, den: number) {
  return den > 0 ? Math.round((num / den) * 100) : 0;
}

/* ─── Create / Edit Dialog ───────────────────────────────────────────── */
interface CampaignDialogProps {
  open: boolean;
  onClose: () => void;
  initial?: any;
}

function CampaignDialog({ open, onClose, initial }: CampaignDialogProps) {
  const utils = trpc.useUtils();
  const isEdit = !!initial;

  const [name, setName] = useState(initial?.name ?? "");
  const [objective, setObjective] = useState(initial?.objective ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [audienceType, setAudienceType] = useState<"contacts" | "segment">(initial?.audienceType ?? "contacts");
  const [audienceIds, setAudienceIds] = useState<number[]>(initial?.audienceIds ?? []);
  const [audienceSegmentId, setAudienceSegmentId] = useState<number[]>(
    initial?.audienceSegmentId ? [initial.audienceSegmentId] : []
  );
  const [sequenceId, setSequenceId] = useState<number[]>(
    initial?.sequenceId ? [initial.sequenceId] : []
  );
  const [senderType, setSenderType] = useState<"account" | "pool">(initial?.senderType ?? "account");
  const [sendingAccountId, setSendingAccountId] = useState<number[]>(
    initial?.sendingAccountId ? [initial.sendingAccountId] : []
  );
  const [senderPoolId, setSenderPoolId] = useState<number[]>(
    initial?.senderPoolId ? [initial.senderPoolId] : []
  );
  const [rotationStrategy, setRotationStrategy] = useState(initial?.rotationStrategy ?? "round_robin");
  const [throttlePerHour, setThrottlePerHour] = useState(String(initial?.throttlePerHour ?? 50));
  const [throttlePerDay, setThrottlePerDay] = useState(String(initial?.throttlePerDay ?? 500));

  const create = trpc.campaigns.create.useMutation({
    onSuccess: () => {
      utils.campaigns.list.invalidate();
      toast.success("Campaign created");
      onClose();
    },
    onError: (e) => toast.error(e.message),
  });

  const updateOutreach = trpc.campaigns.updateOutreach.useMutation({
    onSuccess: () => {
      utils.campaigns.list.invalidate();
      utils.campaigns.getWithDetails.invalidate();
      toast.success("Campaign updated");
      onClose();
    },
    onError: (e) => toast.error(e.message),
  });

  function handleSubmit() {
    if (!name.trim()) { toast.error("Name is required"); return; }
    if (isEdit) {
      updateOutreach.mutate({
        id: initial.id,
        audienceType,
        audienceIds: audienceType === "contacts" ? audienceIds : [],
        audienceSegmentId: audienceType === "segment" ? (audienceSegmentId[0] ?? null) : null,
        sequenceId: sequenceId[0] ?? null,
        senderType,
        sendingAccountId: senderType === "account" ? (sendingAccountId[0] ?? null) : null,
        senderPoolId: senderType === "pool" ? (senderPoolId[0] ?? null) : null,
        rotationStrategy: rotationStrategy as any,
        throttlePerHour: parseInt(throttlePerHour) || 50,
        throttlePerDay: parseInt(throttlePerDay) || 500,
      });
    } else {
      create.mutate({ name, objective, description } as any);
    }
  }

  const pending = create.isPending || updateOutreach.isPending;

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit Campaign" : "New Campaign"}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Basic info */}
          <div className="space-y-2">
            <Label>Campaign name *</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Q3 Outreach — Enterprise SaaS" />
          </div>
          <div className="space-y-2">
            <Label>Objective</Label>
            <Input value={objective} onChange={(e) => setObjective(e.target.value)} placeholder="Book 20 demos" />
          </div>
          <div className="space-y-2">
            <Label>Description</Label>
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} placeholder="Optional notes…" />
          </div>

          <Separator />

          {/* Audience */}
          <div className="space-y-3">
            <Label className="text-sm font-semibold">Audience</Label>
            <div className="flex gap-2">
              <Button size="sm" variant={audienceType === "contacts" ? "default" : "outline"} onClick={() => setAudienceType("contacts")}>
                <Users className="h-3.5 w-3.5 mr-1" /> Contacts
              </Button>
              <Button size="sm" variant={audienceType === "segment" ? "default" : "outline"} onClick={() => setAudienceType("segment")}>
                <Layers className="h-3.5 w-3.5 mr-1" /> Segment
              </Button>
            </div>
            {audienceType === "contacts" ? (
              <EntityPicker type="contacts" mode="multi" value={audienceIds} onChange={setAudienceIds} placeholder="Select contacts…" />
            ) : (
              <EntityPicker type="segments" mode="single" value={audienceSegmentId} onChange={setAudienceSegmentId} placeholder="Select segment…" />
            )}
          </div>

          <Separator />

          {/* Sequence */}
          <div className="space-y-2">
            <Label className="text-sm font-semibold">Sequence</Label>
            <EntityPicker type="sequences" mode="single" value={sequenceId} onChange={setSequenceId} placeholder="Select sequence…" />
          </div>

          <Separator />

          {/* Sender */}
          <div className="space-y-3">
            <Label className="text-sm font-semibold">Sender</Label>
            <div className="flex gap-2">
              <Button size="sm" variant={senderType === "account" ? "default" : "outline"} onClick={() => setSenderType("account")}>
                <Mail className="h-3.5 w-3.5 mr-1" /> Single Account
              </Button>
              <Button size="sm" variant={senderType === "pool" ? "default" : "outline"} onClick={() => setSenderType("pool")}>
                <Layers className="h-3.5 w-3.5 mr-1" /> Sender Pool
              </Button>
            </div>
            {senderType === "account" ? (
              <EntityPicker type="sendingAccounts" mode="single" value={sendingAccountId} onChange={setSendingAccountId} placeholder="Select sending account…" />
            ) : (
              <div className="space-y-2">
                <EntityPicker type="senderPools" mode="single" value={senderPoolId} onChange={setSenderPoolId} placeholder="Select sender pool…" />
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">Rotation strategy</Label>
                  <Select value={rotationStrategy} onValueChange={setRotationStrategy}>
                    <SelectTrigger className="h-8 text-sm">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="round_robin">Round Robin</SelectItem>
                      <SelectItem value="weighted">Weighted</SelectItem>
                      <SelectItem value="random">Random</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            )}
          </div>

          <Separator />

          {/* Throttle */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="text-xs">Emails / hour</Label>
              <Input type="number" value={throttlePerHour} onChange={(e) => setThrottlePerHour(e.target.value)} min={1} max={1000} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Emails / day</Label>
              <Input type="number" value={throttlePerDay} onChange={(e) => setThrottlePerDay(e.target.value)} min={1} max={10000} />
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={handleSubmit} disabled={pending}>
            {pending && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
            {isEdit ? "Save changes" : "Create campaign"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ─── Campaign Detail Panel ──────────────────────────────────────────── */
function CampaignDetail({ id, onEdit }: { id: number; onEdit: () => void }) {
  const utils = trpc.useUtils();
  const detail = trpc.campaigns.getWithDetails.useQuery({ id });
  const analytics = trpc.campaigns.getAnalytics.useQuery({ id });
  const stepStats = trpc.campaigns.getStepStats.useQuery({ campaignId: id });

  const launch = trpc.campaigns.launch.useMutation({
    onSuccess: () => {
      utils.campaigns.list.invalidate();
      utils.campaigns.getWithDetails.invalidate();
      toast.success("Campaign launched");
    },
    onError: (e) => toast.error(e.message),
  });
  const pause = trpc.campaigns.pause.useMutation({
    onSuccess: () => {
      utils.campaigns.list.invalidate();
      utils.campaigns.getWithDetails.invalidate();
      toast.success("Campaign paused");
    },
    onError: (e) => toast.error(e.message),
  });
  const del = trpc.campaigns.delete.useMutation({
    onSuccess: () => {
      utils.campaigns.list.invalidate();
      toast.success("Deleted");
    },
    onError: (e) => toast.error(e.message),
  });

  const c = detail.data as any;
  const a = analytics.data as any;
  const steps: any[] = stepStats.data ?? [];

  if (detail.isLoading) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground gap-2">
        <Loader2 className="h-5 w-5 animate-spin" /> Loading…
      </div>
    );
  }
  if (!c) return <EmptyState icon={Megaphone} title="Campaign not found" />;

  const isLive = c.status === "live";
  const canLaunch = c.status === "planning" || c.status === "paused";

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className="text-lg font-semibold truncate">{c.name}</h2>
            <StatusBadge status={c.status} />
          </div>
          {c.objective && <p className="text-sm text-muted-foreground mt-0.5">{c.objective}</p>}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Button size="sm" variant="outline" onClick={onEdit}>
            <Settings2 className="h-3.5 w-3.5 mr-1" /> Edit
          </Button>
          {canLaunch && (
            <Button
              size="sm"
              className="bg-emerald-600 hover:bg-emerald-700 text-white"
              onClick={() => launch.mutate({ id })}
              disabled={launch.isPending}
            >
              {launch.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <Rocket className="h-3.5 w-3.5 mr-1" />}
              Launch
            </Button>
          )}
          {isLive && (
            <Button size="sm" variant="outline" onClick={() => pause.mutate({ id })} disabled={pause.isPending}>
              {pause.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <Pause className="h-3.5 w-3.5 mr-1" />}
              Pause
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            className="text-destructive hover:text-destructive"
            onClick={() => del.mutate({ id })}
            disabled={del.isPending}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      <Tabs defaultValue="overview">
        <TabsList className="h-8">
          <TabsTrigger value="overview" className="text-xs">Overview</TabsTrigger>
          <TabsTrigger value="analytics" className="text-xs">Analytics</TabsTrigger>
          <TabsTrigger value="steps" className="text-xs">Step Stats</TabsTrigger>
          <TabsTrigger value="checklist" className="text-xs">Checklist</TabsTrigger>
        </TabsList>

        {/* Overview tab */}
        <TabsContent value="overview" className="mt-3 space-y-4">
          <Card>
            <CardHeader className="pb-2 pt-3 px-4">
              <CardTitle className="text-sm">Configuration</CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-4 space-y-2 text-sm">
              <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
                <span className="text-muted-foreground">Audience</span>
                <span className="font-medium">
                  {c.audienceType === "segment" && c.audienceSegment
                    ? c.audienceSegment.name
                    : c.audienceType === "contacts"
                    ? `${(c.audienceIds as number[] ?? []).length} contacts`
                    : "—"}
                </span>
                <span className="text-muted-foreground">Sequence</span>
                <span className="font-medium flex items-center gap-1">
                  {c.sequence ? (
                    <><GitBranch className="h-3.5 w-3.5 text-teal-500" />{c.sequence.name}</>
                  ) : "—"}
                </span>
                <span className="text-muted-foreground">Sender</span>
                <span className="font-medium flex items-center gap-1">
                  {c.senderType === "account" && c.sendingAccount
                    ? <><Mail className="h-3.5 w-3.5 text-green-500" />{c.sendingAccount.fromEmail}</>
                    : c.senderType === "pool" && c.senderPool
                    ? <><Layers className="h-3.5 w-3.5 text-indigo-500" />{c.senderPool.name}</>
                    : "—"}
                </span>
                <span className="text-muted-foreground">Throttle</span>
                <span className="font-medium">{c.throttlePerHour}/hr · {c.throttlePerDay}/day</span>
                <span className="text-muted-foreground">Rotation</span>
                <span className="font-medium capitalize">{(c.rotationStrategy ?? "round_robin").replace("_", " ")}</span>
              </div>
            </CardContent>
          </Card>

          {(c.abVariants as any[] ?? []).length > 0 && (
            <Card>
              <CardHeader className="pb-2 pt-3 px-4">
                <CardTitle className="text-sm">A/B Variants</CardTitle>
              </CardHeader>
              <CardContent className="px-4 pb-4 space-y-2">
                {(c.abVariants as any[]).map((v: any, i: number) => (
                  <div key={i} className="flex items-center gap-3 text-sm">
                    <Badge variant="outline" className="shrink-0">{v.label}</Badge>
                    <span className="flex-1 truncate text-muted-foreground">{v.subjectLine}</span>
                    <span className="text-xs font-mono shrink-0">{v.weight}%</span>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}
        </TabsContent>

        {/* Analytics tab */}
        <TabsContent value="analytics" className="mt-3 space-y-4">
          {analytics.isLoading ? (
            <div className="flex items-center justify-center py-8 text-muted-foreground gap-2">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading analytics…
            </div>
          ) : (
            <>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <StatCard label="Sent" value={String(a?.totalSent ?? 0)} />
                <StatCard label="Delivered" value={String(a?.totalDelivered ?? 0)} />
                <StatCard label="Open rate" value={`${a?.openRate ?? 0}%`} />
                <StatCard label="Click rate" value={`${a?.clickRate ?? 0}%`} />
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                <StatCard label="Reply rate" value={`${a?.replyRate ?? 0}%`} />
                <StatCard label="Bounce rate" value={`${a?.bounceRate ?? 0}%`} />
                <StatCard label="Unsubscribed" value={String(a?.totalUnsubscribed ?? 0)} />
              </div>

              <Card>
                <CardHeader className="pb-2 pt-3 px-4">
                  <CardTitle className="text-sm">Engagement Funnel</CardTitle>
                </CardHeader>
                <CardContent className="px-4 pb-4 space-y-3">
                  {[
                    { label: "Delivered", value: a?.totalDelivered ?? 0, max: a?.totalSent ?? 1, icon: Mail },
                    { label: "Opened", value: a?.totalOpened ?? 0, max: a?.totalDelivered ?? 1, icon: Mail },
                    { label: "Clicked", value: a?.totalClicked ?? 0, max: a?.totalOpened ?? 1, icon: MousePointerClick },
                    { label: "Replied", value: a?.totalReplied ?? 0, max: a?.totalDelivered ?? 1, icon: Reply },
                    { label: "Bounced", value: a?.totalBounced ?? 0, max: a?.totalSent ?? 1, icon: AlertTriangle },
                  ].map(({ label, value, max, icon: Icon }) => (
                    <div key={label} className="space-y-1">
                      <div className="flex items-center justify-between text-xs">
                        <span className="flex items-center gap-1.5 text-muted-foreground">
                          <Icon className="h-3.5 w-3.5" />{label}
                        </span>
                        <span className="font-mono font-medium">
                          {value} <span className="text-muted-foreground">({pct(value, max)}%)</span>
                        </span>
                      </div>
                      <Progress value={pct(value, max)} className="h-1.5" />
                    </div>
                  ))}
                </CardContent>
              </Card>
            </>
          )}
        </TabsContent>

        {/* Step stats tab */}
        <TabsContent value="steps" className="mt-3">
          {stepStats.isLoading ? (
            <div className="flex items-center justify-center py-8 text-muted-foreground gap-2">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading step stats…
            </div>
          ) : steps.length === 0 ? (
            <EmptyState
              icon={BarChart3}
              title="No step data yet"
              description="Step-level stats appear once the campaign is live and emails are sent."
            />
          ) : (
            <div className="overflow-x-auto rounded-lg border">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/50">
                    <th className="px-3 py-2 text-left font-medium text-muted-foreground">Step</th>
                    <th className="px-3 py-2 text-right font-medium text-muted-foreground">Sent</th>
                    <th className="px-3 py-2 text-right font-medium text-muted-foreground">Delivered</th>
                    <th className="px-3 py-2 text-right font-medium text-muted-foreground">Opened</th>
                    <th className="px-3 py-2 text-right font-medium text-muted-foreground">Clicked</th>
                    <th className="px-3 py-2 text-right font-medium text-muted-foreground">Replied</th>
                    <th className="px-3 py-2 text-right font-medium text-muted-foreground">Bounced</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {steps.map((s: any) => (
                    <tr key={s.id} className="hover:bg-muted/30 transition-colors">
                      <td className="px-3 py-2 font-medium">{s.stepLabel ?? `Step ${s.stepIndex + 1}`}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{s.sent}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{s.delivered}</td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {s.opened} <span className="text-muted-foreground text-xs">({pct(s.opened, s.delivered)}%)</span>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {s.clicked} <span className="text-muted-foreground text-xs">({pct(s.clicked, s.opened)}%)</span>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {s.replied} <span className="text-muted-foreground text-xs">({pct(s.replied, s.delivered)}%)</span>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-red-600 dark:text-red-400">{s.bounced}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </TabsContent>

        {/* Checklist tab */}
        <TabsContent value="checklist" className="mt-3">
          <ChecklistTab
            campaignId={id}
            checklist={(c.checklist as any[]) ?? []}
            onLaunch={() => launch.mutate({ id })}
            launchPending={launch.isPending}
            canLaunch={canLaunch}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}

/* ─── Checklist Tab ─────────────────────────────────────────────────── */
function ChecklistTab({
  campaignId,
  checklist,
  onLaunch,
  launchPending,
  canLaunch,
}: {
  campaignId: number;
  checklist: Array<{ id: number; label: string; done: boolean }>;
  onLaunch: () => void;
  launchPending: boolean;
  canLaunch: boolean;
}) {
  const utils = trpc.useUtils();
  const toggle = trpc.campaigns.toggleChecklist.useMutation({
    onSuccess: () => {
      utils.campaigns.getWithDetails.invalidate();
      utils.campaigns.list.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });
  const allDone = checklist.length > 0 && checklist.every((x) => x.done);
  const doneCount = checklist.filter((x) => x.done).length;
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-2 pt-3 px-4">
          <CardTitle className="text-sm flex items-center justify-between">
            <span>Pre-launch Checklist</span>
            <span className="text-xs font-normal text-muted-foreground">{doneCount}/{checklist.length} complete</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="px-4 pb-4 space-y-2">
          {checklist.length === 0 && (
            <p className="text-sm text-muted-foreground">No checklist items.</p>
          )}
          {checklist.map((item) => (
            <button
              key={item.id}
              className="w-full flex items-center gap-3 p-3 rounded-lg border bg-card hover:bg-muted/40 transition-colors text-left"
              onClick={() => toggle.mutate({ id: campaignId, itemId: item.id, done: !item.done })}
              disabled={toggle.isPending}
            >
              {item.done
                ? <CheckSquare className="size-5 text-emerald-500 shrink-0" />
                : <Square className="size-5 text-muted-foreground shrink-0" />}
              <span className={`text-sm flex-1 ${item.done ? 'line-through text-muted-foreground' : ''}`}>{item.label}</span>
              {item.done && <CheckCircle2 className="size-4 text-emerald-500 shrink-0" />}
            </button>
          ))}
        </CardContent>
      </Card>
      {canLaunch && (
        <div className="flex flex-col gap-2">
          {!allDone && (
            <p className="text-xs text-amber-600 flex items-center gap-1.5">
              <AlertTriangle className="size-3.5" />
              Tick all checklist items to enable launch.
            </p>
          )}
          <Button
            className="bg-emerald-600 hover:bg-emerald-700 text-white w-full"
            onClick={onLaunch}
            disabled={launchPending || !allDone}
          >
            {launchPending ? <Loader2 className="size-4 animate-spin mr-1" /> : <Rocket className="size-4 mr-1" />}
            Launch Campaign
          </Button>
        </div>
      )}
    </div>
  );
}

/* ─── Main Page ──────────────────────────────────────────────────────── */
export default function Campaigns() {
  const { data, isLoading } = trpc.campaigns.list.useQuery();
  const [selected, setSelected] = useState<number | null>(null);
  const [openCreate, setOpenCreate] = useState(false);
  const [openEdit, setOpenEdit] = useState(false);

  const detail = trpc.campaigns.getWithDetails.useQuery({ id: selected! }, { enabled: !!selected });
  const campaigns: any[] = data ?? [];

  return (
    <Shell title="Campaigns">
      <PageHeader title="Outreach Campaigns" description="Orchestrate multi-channel campaigns combining email sequences, social posts, and ad placements. Set goals, assign audiences, and track performance across every channel in one view." pageKey="campaigns"
        icon={<Layers3 className="size-5" />}
      >
        <Button onClick={() => setOpenCreate(true)}>
          <Plus className="h-4 w-4 mr-1" /> New Campaign
        </Button>
      </PageHeader>

      <div className="p-6 grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left: Campaign list */}
        <div className="space-y-3">
          <span className="text-sm font-medium text-muted-foreground">
            {campaigns.length} campaign{campaigns.length !== 1 ? "s" : ""}
          </span>

          {isLoading ? (
            <div className="flex items-center justify-center py-12 text-muted-foreground gap-2">
              <Loader2 className="h-5 w-5 animate-spin" /> Loading…
            </div>
          ) : campaigns.length === 0 ? (
            <EmptyState icon={Megaphone} title="No campaigns yet" description="Create your first outreach campaign." />
          ) : (
            <div className="space-y-1.5">
              {campaigns.map((c) => (
                <button
                  key={c.id}
                  onClick={() => setSelected(c.id)}
                  className={`w-full text-left rounded-lg border p-3 transition-colors hover:bg-accent/50 ${
                    selected === c.id ? "border-primary bg-accent/60" : "border-border"
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium text-sm truncate">{c.name}</span>
                    <StatusBadge status={c.status} />
                  </div>
                  {c.objective && (
                    <p className="text-xs text-muted-foreground mt-0.5 truncate">{c.objective}</p>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Right: Detail panel */}
        <div className="lg:col-span-2">
          {!selected ? (
            <div className="flex flex-col items-center justify-center py-24 text-center text-muted-foreground">
              <Megaphone className="h-12 w-12 mb-3 opacity-20" />
              <p className="font-medium">Select a campaign</p>
              <p className="text-sm mt-1 opacity-70">Click a campaign to view details and analytics</p>
            </div>
          ) : (
            <CampaignDetail id={selected} onEdit={() => setOpenEdit(true)} />
          )}
        </div>
      </div>

      {/* Create dialog */}
      <CampaignDialog open={openCreate} onClose={() => setOpenCreate(false)} />

      {/* Edit dialog */}
      {selected && detail.data && (
        <CampaignDialog
          open={openEdit}
          onClose={() => setOpenEdit(false)}
          initial={detail.data}
        />
      )}
    </Shell>
  );
}
