import { Button } from "@/components/ui/button";
import { Field, FormDialog, Section, SelectField, StatusPill, TextareaField } from "@/components/usip/Common";
import { EmptyState, PageHeader, Shell } from "@/components/usip/Shell";
import { trpc } from "@/lib/trpc";
import { Activity, GitBranch, Pause, Play, Plus, Power, Users, CheckCircle2, XCircle, Clock, BarChart3, RefreshCw } from "lucide-react";
import { useState } from "react";
import { Link } from "wouter";
import { toast } from "sonner";
import { Card, CardContent } from "@/components/ui/card";

function EnrollmentStatsPanel({ sequenceId, steps }: { sequenceId: number; steps: any[] }) {
  const { data: stats, isLoading: statsLoading, refetch } = trpc.sequences.getEnrollmentStats.useQuery({ sequenceId });
  const { data: stepStats = [] } = trpc.sequences.getEnrollmentStepStats.useQuery({ sequenceId });
  const { data: enrollmentList = [], isLoading: listLoading } = trpc.sequences.listEnrollments.useQuery({ sequenceId });

  const resume = trpc.sequences.resumeEnrollment.useMutation({
    onSuccess: () => { refetch(); toast.success("Enrollment resumed"); },
    onError: (e) => toast.error(e.message),
  });
  const exit = trpc.sequences.exitEnrollment.useMutation({
    onSuccess: () => { refetch(); toast.success("Enrollment exited"); },
    onError: (e) => toast.error(e.message),
  });
  const pauseOnReply = trpc.sequences.pauseOnReply.useMutation({
    onSuccess: () => { refetch(); toast.success("Enrollment paused (reply detected)"); },
    onError: (e) => toast.error(e.message),
  });

  const total = (stats?.active ?? 0) + (stats?.paused ?? 0) + (stats?.finished ?? 0) + (stats?.exited ?? 0);

  return (
    <div className="space-y-4">
      {/* Status summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        {[
          { label: "Active", value: stats?.active ?? 0, icon: Play, color: "text-emerald-600" },
          { label: "Paused", value: stats?.paused ?? 0, icon: Pause, color: "text-amber-600" },
          { label: "Finished", value: stats?.finished ?? 0, icon: CheckCircle2, color: "text-blue-600" },
          { label: "Exited", value: stats?.exited ?? 0, icon: XCircle, color: "text-muted-foreground" },
        ].map(({ label, value, icon: Icon, color }) => (
          <Card key={label} className="border">
            <CardContent className="p-3 flex items-center gap-2">
              <Icon className={`h-5 w-5 ${color} shrink-0`} />
              <div>
                <p className="text-xl font-bold tabular-nums">{value}</p>
                <p className="text-xs text-muted-foreground">{label}</p>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Per-step funnel */}
      {steps.length > 0 && stepStats.length > 0 && (
        <Section title="Step Performance">
          <div className="p-3 space-y-2">
            {steps.map((step, i) => {
              const count = stepStats.find((s: any) => s.step === i)?.count ?? 0;
              const pct = total > 0 ? Math.round((count / total) * 100) : 0;
              return (
                <div key={i} className="flex items-center gap-3 text-sm">
                  <span className="w-16 text-xs text-muted-foreground font-mono shrink-0">Step {i + 1}</span>
                  <span className="w-14 text-xs capitalize text-muted-foreground shrink-0">{step.type}</span>
                  <div className="flex-1 bg-muted rounded-full h-2">
                    <div
                      className="h-2 rounded-full bg-[#14B89A] transition-all"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <span className="text-xs tabular-nums w-8 text-right">{count}</span>
                </div>
              );
            })}
          </div>
        </Section>
      )}

      {/* Enrollment list */}
      <Section title={`Enrollments (${total})`} right={
        <Button size="sm" variant="ghost" onClick={() => refetch()}>
          <RefreshCw className="h-3 w-3 mr-1" /> Refresh
        </Button>
      }>
        {listLoading ? (
          <div className="p-3 text-sm text-muted-foreground">Loading…</div>
        ) : enrollmentList.length === 0 ? (
          <div className="p-3 text-sm text-muted-foreground">No enrollments yet.</div>
        ) : (
          <ul className="divide-y">
            {enrollmentList.map((e: any) => (
              <li key={e.id} className="p-3 flex items-center gap-2 text-sm">
                <div className="flex-1 min-w-0">
                  <span className="font-medium">Enrollment #{e.id}</span>
                  <span className="text-muted-foreground ml-2">· Step {e.currentStep + 1}</span>
                  {e.nextActionAt && (
                    <span className="text-xs text-muted-foreground ml-2">
                      · Next: {new Date(e.nextActionAt).toLocaleDateString()}
                    </span>
                  )}
                </div>
                <StatusPill tone={
                  e.status === "active" ? "success" :
                  e.status === "paused" ? "warning" :
                  e.status === "finished" ? "info" : "muted"
                }>{e.status}</StatusPill>
                <div className="flex gap-1 shrink-0">
                  {e.status === "paused" && (
                    <Button size="sm" variant="ghost" className="h-6 text-xs px-2"
                      onClick={() => resume.mutate({ id: e.id })}
                      disabled={resume.isPending}>
                      Resume
                    </Button>
                  )}
                  {e.status === "active" && (
                    <Button size="sm" variant="ghost" className="h-6 text-xs px-2 text-amber-600"
                      onClick={() => pauseOnReply.mutate({ enrollmentId: e.id })}
                      disabled={pauseOnReply.isPending}>
                      Reply
                    </Button>
                  )}
                  {(e.status === "active" || e.status === "paused") && (
                    <Button size="sm" variant="ghost" className="h-6 text-xs px-2 text-muted-foreground"
                      onClick={() => exit.mutate({ id: e.id })}
                      disabled={exit.isPending}>
                      Exit
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

export default function Sequences() {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<number | null>(null);
  const [activeTab, setActiveTab] = useState<"steps" | "stats">("steps");
  const utils = trpc.useUtils();
  const { data } = trpc.sequences.list.useQuery();
  const create = trpc.sequences.create.useMutation({
    onSuccess: () => { utils.sequences.list.invalidate(); setOpen(false); toast.success("Sequence created"); },
  });
  const setStatus = trpc.sequences.setStatus.useMutation({ onSuccess: () => utils.sequences.list.invalidate() });
  const detail = trpc.sequences.get.useQuery({ id: selected! }, { enabled: !!selected });

  return (
    <Shell title="Sequences">
      <PageHeader title="Sequences" description="Multi-step outbound cadences with AI compose.">
        <Button onClick={() => setOpen(true)}><Plus className="size-4" /> New sequence</Button>
      </PageHeader>
      <div className="p-6 grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-1">
          <Section title="All sequences">
            {(data ?? []).length === 0 ? <EmptyState icon={Activity} title="None yet" /> : (
              <ul className="divide-y">
                {data!.map((s) => (
                  <li key={s.id}
                    className={`p-3 cursor-pointer hover:bg-secondary/40 ${selected === s.id ? "bg-secondary/60" : ""}`}
                    onClick={() => { setSelected(s.id); setActiveTab("steps"); }}>
                    <div className="flex items-center gap-2">
                      <div className="flex-1 text-sm font-medium truncate">{s.name}</div>
                      <StatusPill tone={s.status === "active" ? "success" : s.status === "paused" ? "warning" : "muted"}>{s.status}</StatusPill>
                    </div>
                    <div className="text-xs text-muted-foreground line-clamp-1">{s.description}</div>
                    <div className="text-xs text-muted-foreground mt-0.5">
                      {s.enrolledCount} enrolled
                      {s.dailyCap ? ` · ${s.dailyCap}/day cap` : ""}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </div>
        <div className="lg:col-span-2 space-y-4">
          {!selected ? <EmptyState icon={Activity} title="Select a sequence" /> : detail.data ? (
            <>
              <Section title={detail.data.name} description={detail.data.description ?? ""}
                right={
                  <div className="flex gap-1 flex-wrap">
                    <Link href={`/sequences/${detail.data.id}/canvas`}>
                      <Button size="sm" variant="outline"><GitBranch className="size-3.5" /> Canvas</Button>
                    </Link>
                    <Button size="sm" variant="ghost"
                      onClick={() => setStatus.mutate({ id: detail.data!.id, status: detail.data!.status === "active" ? "paused" : "active" })}>
                      {detail.data.status === "active" ? <><Pause className="size-3.5" /> Pause</> : <><Play className="size-3.5" /> Activate</>}
                    </Button>
                    <Button size="sm" variant="ghost"
                      onClick={() => setStatus.mutate({ id: detail.data!.id, status: "archived" })}>
                      <Power className="size-3.5" /> Archive
                    </Button>
                  </div>
                }>
                {/* Tab bar */}
                <div className="flex border-b mb-3 px-3">
                  {[
                    { k: "steps", label: "Steps", icon: Activity },
                    { k: "stats", label: "Stats & Enrollments", icon: BarChart3 },
                  ].map(({ k, label, icon: Icon }) => (
                    <button key={k}
                      onClick={() => setActiveTab(k as any)}
                      className={`flex items-center gap-1.5 px-3 py-2 text-sm ${activeTab === k ? "border-b-2 border-[#14B89A] font-semibold" : "text-muted-foreground"}`}>
                      <Icon className="h-3.5 w-3.5" />
                      {label}
                    </button>
                  ))}
                </div>

                {activeTab === "steps" && (
                  <ol className="p-3 space-y-2">
                    {((detail.data.steps as any[]) ?? []).map((step, i) => (
                      <li key={i} className="border rounded p-2.5">
                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                          <span className="font-mono">Step {i + 1}</span> · {step.type}
                          {step.type === "wait" ? ` · ${step.days}d` : ""}
                        </div>
                        {step.subject && <div className="text-sm font-medium mt-1">{step.subject}</div>}
                        {step.body && <div className="text-xs text-muted-foreground line-clamp-3 mt-1">{step.body}</div>}
                      </li>
                    ))}
                    {((detail.data.steps as any[]) ?? []).length === 0 && (
                      <div className="text-sm text-muted-foreground py-4 text-center">
                        No steps yet. Open the canvas to build your sequence.
                      </div>
                    )}
                  </ol>
                )}

                {activeTab === "stats" && (
                  <div className="p-3">
                    <EnrollmentStatsPanel
                      sequenceId={detail.data.id}
                      steps={(detail.data.steps as any[]) ?? []}
                    />
                  </div>
                )}
              </Section>
            </>
          ) : null}
        </div>
      </div>

      <FormDialog open={open} onOpenChange={setOpen} title="New sequence" isPending={create.isPending}
        onSubmit={(f) => create.mutate({
          name: String(f.get("name")), description: String(f.get("description") ?? "") || undefined,
          steps: [
            { type: "email", subject: String(f.get("step1Subject") ?? "Quick intro"), body: String(f.get("step1Body") ?? "") },
            { type: "wait", days: 3 },
            { type: "email", subject: "Following up", body: "Did this come at a bad time?" },
          ],
        })}>
        <Field name="name" label="Name" required />
        <TextareaField name="description" label="Description" />
        <Field name="step1Subject" label="Step 1 subject" />
        <TextareaField name="step1Body" label="Step 1 body" />
      </FormDialog>
    </Shell>
  );
}
