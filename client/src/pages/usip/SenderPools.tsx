/**
 * SenderPools -- Named pools of sending accounts with rotation strategy configuration.
 * Supports round-robin, weighted, and random rotation with daily-limit failover.
 */
import { useState } from "react";
import { PageHeader, Shell } from "@/components/usip/Shell";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { Slider } from "@/components/ui/slider";
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  GripVertical,
  Layers,
  Plus,
  RefreshCw,
  Trash2,
  Zap,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

type RotationStrategy = "round_robin" | "weighted" | "random";

interface PoolMemberForm {
  accountId: number;
  weight: number;
  priority: number;
}

interface PoolForm {
  name: string;
  description: string;
  rotationStrategy: RotationStrategy;
  members: PoolMemberForm[];
}

const defaultPoolForm: PoolForm = {
  name: "",
  description: "",
  rotationStrategy: "round_robin",
  members: [],
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

const STRATEGY_LABELS: Record<RotationStrategy, string> = {
  round_robin: "Round-robin",
  weighted: "Weighted",
  random: "Random",
};

const STRATEGY_DESCRIPTIONS: Record<RotationStrategy, string> = {
  round_robin: "Cycles through accounts in order, skipping any that have hit their daily limit.",
  weighted: "Distributes sends proportionally by weight. Higher weight = more sends assigned.",
  random: "Picks a random available account for each send. Good for natural variation.",
};

function StrategyBadge({ strategy }: { strategy: RotationStrategy }) {
  const map: Record<RotationStrategy, string> = {
    round_robin: "bg-blue-100 text-blue-700 border-blue-200",
    weighted: "bg-purple-100 text-purple-700 border-purple-200",
    random: "bg-emerald-100 text-emerald-700 border-emerald-200",
  };
  return (
    <Badge className={`${map[strategy]} text-xs`}>
      {STRATEGY_LABELS[strategy]}
    </Badge>
  );
}

// ─── Pool Form Dialog ─────────────────────────────────────────────────────────

function PoolFormDialog({
  open,
  onClose,
  editId,
}: {
  open: boolean;
  onClose: () => void;
  editId?: number;
}) {
  const utils = trpc.useUtils();
  const [form, setForm] = useState<PoolForm>(defaultPoolForm);
  const { data: accounts = [] } = trpc.sendingAccounts.list.useQuery();

  const createMutation = trpc.senderPools.create.useMutation({
    onSuccess: () => {
      utils.senderPools.list.invalidate();
      toast.success("Sender pool created");
      onClose();
      setForm(defaultPoolForm);
    },
    onError: (e) => toast.error(e.message),
  });

  const updateMutation = trpc.senderPools.update.useMutation({
    onSuccess: () => {
      utils.senderPools.list.invalidate();
      toast.success("Pool updated");
      onClose();
    },
    onError: (e) => toast.error(e.message),
  });

  function addMember(accountId: number) {
    if (form.members.find((m) => m.accountId === accountId)) return;
    setForm((f) => ({
      ...f,
      members: [
        ...f.members,
        { accountId, weight: 1, priority: f.members.length + 1 },
      ],
    }));
  }

  function removeMember(accountId: number) {
    setForm((f) => ({
      ...f,
      members: f.members
        .filter((m) => m.accountId !== accountId)
        .map((m, i) => ({ ...m, priority: i + 1 })),
    }));
  }

  function setWeight(accountId: number, weight: number) {
    setForm((f) => ({
      ...f,
      members: f.members.map((m) =>
        m.accountId === accountId ? { ...m, weight } : m
      ),
    }));
  }

  function moveMember(accountId: number, dir: -1 | 1) {
    const idx = form.members.findIndex((m) => m.accountId === accountId);
    if (idx < 0) return;
    const next = idx + dir;
    if (next < 0 || next >= form.members.length) return;
    const arr = [...form.members];
    [arr[idx], arr[next]] = [arr[next], arr[idx]];
    setForm((f) => ({ ...f, members: arr.map((m, i) => ({ ...m, priority: i + 1 })) }));
  }

  function handleSubmit() {
    const payload = {
      name: form.name,
      description: form.description || undefined,
      rotationStrategy: form.rotationStrategy,
      members: form.members,
    };
    if (editId) {
      updateMutation.mutate({ id: editId, ...payload });
    } else {
      createMutation.mutate(payload);
    }
  }

  const availableAccounts = accounts.filter(
    (a) => !form.members.find((m) => m.accountId === a.id)
  );
  const isBusy = createMutation.isPending || updateMutation.isPending;
  const totalWeight = form.members.reduce((s, m) => s + m.weight, 0);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{editId ? "Edit Sender Pool" : "Create Sender Pool"}</DialogTitle>
        </DialogHeader>

        <div className="space-y-5 py-2">
          {/* Name */}
          <div className="space-y-1.5">
            <Label>Pool name</Label>
            <Input
              placeholder="e.g. Enterprise outreach pool"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            />
          </div>

          {/* Description */}
          <div className="space-y-1.5">
            <Label>Description <span className="text-muted-foreground text-xs">(optional)</span></Label>
            <Input
              placeholder="What is this pool used for?"
              value={form.description}
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
            />
          </div>

          {/* Rotation strategy */}
          <div className="space-y-1.5">
            <Label>Rotation strategy</Label>
            <Select
              value={form.rotationStrategy}
              onValueChange={(v) => setForm((f) => ({ ...f, rotationStrategy: v as RotationStrategy }))}
            >
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {(Object.entries(STRATEGY_LABELS) as [RotationStrategy, string][]).map(([k, v]) => (
                  <SelectItem key={k} value={k}>{v}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">{STRATEGY_DESCRIPTIONS[form.rotationStrategy]}</p>
          </div>

          {/* Add accounts */}
          <div className="space-y-2">
            <Label>Accounts in pool</Label>
            {availableAccounts.length > 0 && (
              <Select onValueChange={(v) => addMember(parseInt(v))}>
                <SelectTrigger>
                  <SelectValue placeholder="Add an account..." />
                </SelectTrigger>
                <SelectContent>
                  {availableAccounts.map((a) => (
                    <SelectItem key={a.id} value={String(a.id)}>
                      {a.name} — {a.fromEmail}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}

            {/* Member list */}
            {form.members.length === 0 ? (
              <div className="border border-dashed rounded-lg p-4 text-center text-sm text-muted-foreground">
                No accounts added yet. Select from the dropdown above.
              </div>
            ) : (
              <div className="space-y-2">
                {form.members.map((m, idx) => {
                  const acct = accounts.find((a) => a.id === m.accountId);
                  if (!acct) return null;
                  const pct = totalWeight > 0 ? Math.round((m.weight / totalWeight) * 100) : 0;
                  return (
                    <div key={m.accountId} className="border rounded-lg p-3 space-y-2">
                      <div className="flex items-center gap-2">
                        <GripVertical className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium truncate">{acct.name}</p>
                          <p className="text-xs text-muted-foreground">{acct.fromEmail}</p>
                        </div>
                        <div className="flex items-center gap-1">
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-6 w-6"
                            disabled={idx === 0}
                            onClick={() => moveMember(m.accountId, -1)}
                          >
                            <ChevronUp className="w-3 h-3" />
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-6 w-6"
                            disabled={idx === form.members.length - 1}
                            onClick={() => moveMember(m.accountId, 1)}
                          >
                            <ChevronDown className="w-3 h-3" />
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-6 w-6 text-destructive hover:text-destructive"
                            onClick={() => removeMember(m.accountId)}
                          >
                            <Trash2 className="w-3 h-3" />
                          </Button>
                        </div>
                      </div>

                      {/* Weight slider (only for weighted strategy) */}
                      {form.rotationStrategy === "weighted" && (
                        <div className="space-y-1">
                          <div className="flex justify-between text-xs text-muted-foreground">
                            <span>Weight: {m.weight}</span>
                            <span>{pct}% of sends</span>
                          </div>
                          <Slider
                            min={1}
                            max={10}
                            step={1}
                            value={[m.weight]}
                            onValueChange={([v]) => setWeight(m.accountId, v)}
                          />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={isBusy}>Cancel</Button>
          <Button
            onClick={handleSubmit}
            disabled={isBusy || !form.name || form.members.length < 2}
          >
            {isBusy ? "Saving..." : editId ? "Save changes" : "Create pool"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Pool Card ────────────────────────────────────────────────────────────────

function PoolCard({ pool }: { pool: any }) {
  const utils = trpc.useUtils();
  const [expanded, setExpanded] = useState(false);

  const deleteMutation = trpc.senderPools.delete.useMutation({
    onSuccess: () => {
      utils.senderPools.list.invalidate();
      toast.success("Pool deleted");
    },
  });

  const { data: detail } = trpc.senderPools.getWithMembers.useQuery(
    { id: pool.id },
    { enabled: expanded }
  );

  const totalCapacity = detail?.members?.reduce(
    (s: number, m: any) => s + (m.account?.dailySendLimit ?? 0),
    0
  ) ?? 0;

  return (
    <Card>
      <CardContent className="p-4">
        {/* Header row */}
        <div className="flex items-start gap-3">
          <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center flex-shrink-0">
            <Layers className="w-4 h-4 text-primary" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-medium text-sm">{pool.name}</span>
              <StrategyBadge strategy={pool.rotationStrategy as RotationStrategy} />
              <Badge className="bg-zinc-100 text-zinc-600 border-zinc-200 text-xs">
                {pool.memberCount ?? 0} accounts
              </Badge>
            </div>
            {pool.description && (
              <p className="text-xs text-muted-foreground mt-0.5">{pool.description}</p>
            )}
          </div>
          <div className="flex items-center gap-1.5 flex-shrink-0">
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7"
              onClick={() => setExpanded((v) => !v)}
              title={expanded ? "Collapse" : "Expand"}
            >
              {expanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
            </Button>
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7 text-destructive hover:text-destructive"
              title="Delete pool"
              onClick={() => {
                if (confirm(`Delete pool "${pool.name}"?`)) {
                  deleteMutation.mutate({ id: pool.id });
                }
              }}
            >
              <Trash2 className="w-3.5 h-3.5" />
            </Button>
          </div>
        </div>

        {/* Expanded member list */}
        {expanded && (
          <div className="mt-3 pt-3 border-t space-y-2">
            {!detail ? (
              <div className="text-xs text-muted-foreground animate-pulse">Loading...</div>
            ) : detail.members?.length === 0 ? (
              <div className="text-xs text-muted-foreground">No accounts in this pool.</div>
            ) : (
              <>
                <div className="flex justify-between text-xs text-muted-foreground mb-1">
                  <span>Combined daily capacity</span>
                  <span className="font-medium text-foreground">{totalCapacity.toLocaleString()} emails/day</span>
                </div>
                {detail.members?.map((m: any) => {
                  const acct = m.account;
                  if (!acct) return null;
                  const sentPct = acct.dailySendLimit > 0
                    ? Math.min(100, Math.round(((acct.sentToday ?? 0) / acct.dailySendLimit) * 100))
                    : 0;
                  return (
                    <div key={m.id} className="flex items-center gap-2 text-xs">
                      <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                        acct.connectionStatus === "connected" ? "bg-emerald-500" :
                        acct.connectionStatus === "error" ? "bg-red-500" : "bg-zinc-400"
                      }`} />
                      <span className="flex-1 truncate font-medium">{acct.name}</span>
                      {pool.rotationStrategy === "weighted" && (
                        <span className="text-muted-foreground">w:{m.weight}</span>
                      )}
                      <span className="text-muted-foreground">
                        {(acct.sentToday ?? 0)}/{acct.dailySendLimit} ({sentPct}%)
                      </span>
                    </div>
                  );
                })}
              </>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function SenderPools() {
  const [showCreate, setShowCreate] = useState(false);
  const { data: pools = [], isLoading } = trpc.senderPools.list.useQuery();
  const { data: accounts = [] } = trpc.sendingAccounts.list.useQuery();

  const totalCapacity = accounts
    .filter((a) => a.enabled)
    .reduce((s, a) => s + a.dailySendLimit, 0);

  return (
    <Shell title="Sender Pools">
      <div className="space-y-6">
        <PageHeader
          title="Sender Pools" pageKey="sender-pools"
          description="Group sending accounts into pools for load-balanced, safe delivery."
        
        icon={<Layers className="size-5" />}
      >
          <Button onClick={() => setShowCreate(true)} className="gap-2" disabled={accounts.length < 2}>
            <Plus className="w-4 h-4" /> Create pool
          </Button>
        </PageHeader>

        {/* Info banner if not enough accounts */}
        {accounts.length < 2 && (
          <Card className="border-amber-200 bg-amber-50/50">
            <CardContent className="p-4 flex items-center gap-3">
              <AlertCircle className="w-5 h-5 text-amber-600 flex-shrink-0" />
              <div>
                <p className="text-sm font-medium text-amber-800">At least 2 sending accounts required</p>
                <p className="text-xs text-amber-700 mt-0.5">
                  Connect more accounts on the{" "}
                  <a href="/sending-accounts" className="underline">Sending Accounts</a> page first.
                </p>
              </div>
            </CardContent>
          </Card>
        )}

        {/* KPIs */}
        <div className="grid grid-cols-3 gap-4">
          <Card>
            <CardContent className="p-4">
              <p className="text-xs text-muted-foreground uppercase tracking-wide">Pools</p>
              <p className="text-2xl font-bold mt-1">{pools.length}</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <p className="text-xs text-muted-foreground uppercase tracking-wide">Total accounts</p>
              <p className="text-2xl font-bold mt-1">{accounts.length}</p>
              <p className="text-xs text-muted-foreground">{accounts.filter((a) => a.enabled).length} enabled</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <p className="text-xs text-muted-foreground uppercase tracking-wide">Combined capacity</p>
              <p className="text-2xl font-bold mt-1">{totalCapacity.toLocaleString()}</p>
              <p className="text-xs text-muted-foreground">emails / day</p>
            </CardContent>
          </Card>
        </div>

        {/* Pool list */}
        {isLoading ? (
          <div className="space-y-3">
            {[1, 2].map((i) => (
              <div key={i} className="h-20 bg-muted/40 rounded-lg animate-pulse" />
            ))}
          </div>
        ) : pools.length === 0 ? (
          <Card>
            <CardContent className="py-16 flex flex-col items-center gap-3 text-center">
              <div className="w-12 h-12 rounded-full bg-muted flex items-center justify-center">
                <Layers className="w-6 h-6 text-muted-foreground" />
              </div>
              <div>
                <p className="font-medium">No sender pools yet</p>
                <p className="text-sm text-muted-foreground mt-1">
                  Create a pool to enable rotation across multiple accounts in campaigns.
                </p>
              </div>
              {accounts.length >= 2 && (
                <Button onClick={() => setShowCreate(true)} className="gap-2 mt-2">
                  <Plus className="w-4 h-4" /> Create your first pool
                </Button>
              )}
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-3">
            {pools.map((p) => (
              <PoolCard key={p.id} pool={p} />
            ))}
          </div>
        )}

        {/* Strategy guide */}
        <Card className="border-dashed">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <Zap className="w-4 h-4 text-primary" /> Rotation strategy guide
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 pt-0">
            {(Object.entries(STRATEGY_DESCRIPTIONS) as [RotationStrategy, string][]).map(([k, v]) => (
              <div key={k} className="flex items-start gap-2 text-xs">
                <StrategyBadge strategy={k} />
                <span className="text-muted-foreground">{v}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      <PoolFormDialog open={showCreate} onClose={() => setShowCreate(false)} />
    </Shell>
  );
}
