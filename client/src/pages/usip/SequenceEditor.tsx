/**
 * SequenceEditor — the sequence builder (/v2/sequences/:id).
 *
 * Apollo's sequence editor: header (name + Share / Add contacts / Activate),
 * tabs (Editor / Contacts / Activity / Report / Settings). The Editor tab is
 * the step builder — an ordered list of steps with an "Add a step" picker
 * (Automatic email / Manual email / Phone call / Action item / LinkedIn /
 * Wait) and inline editors per step. Steps persist via sequences.updateSteps;
 * name/description/status via sequences.update.
 */
import { useEffect, useMemo, useState } from "react";
import { useParams, useLocation, Link } from "wouter";
import { Shell, useAccentColor } from "@/components/usip/Shell";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import {
  Send, Star, Share2, Zap, UserPlus, ChevronDown, Plus, Mail, MailOpen, Phone,
  CheckSquare, MessageSquare, Clock, Trash2, GripVertical, ArrowUp, ArrowDown,
  Loader2, Users, Activity as ActivityIcon, BarChart3, Settings2, X,
} from "lucide-react";

type Step =
  | { type: "email"; subject: string; body?: string }
  | { type: "wait"; days: number }
  | { type: "task"; body: string }
  | { type: "linkedin_dm"; body?: string }
  | { type: "linkedin_invite"; note?: string };

const STEP_OPTIONS: { key: string; label: string; icon: any; make: () => Step }[] = [
  { key: "email_auto", label: "Automatic email", icon: Mail, make: () => ({ type: "email", subject: "", body: "" }) },
  { key: "email_manual", label: "Manual email", icon: MailOpen, make: () => ({ type: "email", subject: "", body: "" }) },
  { key: "call", label: "Phone call", icon: Phone, make: () => ({ type: "task", body: "Call: " }) },
  { key: "task", label: "Action item", icon: CheckSquare, make: () => ({ type: "task", body: "" }) },
  { key: "li_invite", label: "LinkedIn — connection request", icon: UserPlus, make: () => ({ type: "linkedin_invite", note: "" }) },
  { key: "li_dm", label: "LinkedIn — message", icon: MessageSquare, make: () => ({ type: "linkedin_dm", body: "" }) },
  { key: "wait", label: "Wait / delay", icon: Clock, make: () => ({ type: "wait", days: 2 }) },
];

function stepMeta(s: Step): { icon: any; label: string; summary: string } {
  switch (s.type) {
    case "email": return { icon: Mail, label: "Email", summary: s.subject || "Untitled email" };
    case "wait": return { icon: Clock, label: "Wait", summary: `Wait ${s.days} day${s.days === 1 ? "" : "s"}` };
    case "task": return { icon: CheckSquare, label: "Task", summary: s.body || "Action item" };
    case "linkedin_invite": return { icon: UserPlus, label: "LinkedIn invite", summary: s.note || "Connection request" };
    case "linkedin_dm": return { icon: MessageSquare, label: "LinkedIn message", summary: s.body || "LinkedIn message" };
  }
}

const TABS = ["Editor", "Contacts", "Activity", "Report", "Settings"] as const;
type Tab = (typeof TABS)[number];

export default function SequenceEditor() {
  const { id: idStr } = useParams<{ id: string }>();
  const id = Number(idStr);
  const [, setLocation] = useLocation();
  const accent = useAccentColor();
  const utils = trpc.useUtils();

  const seqQ = trpc.sequences.get.useQuery({ id }, { enabled: Number.isFinite(id) });
  const seq = seqQ.data as any;

  const updateSteps = trpc.sequences.updateSteps.useMutation({ onSuccess: () => { utils.sequences.get.invalidate({ id }); utils.sequences.list.invalidate(); } });
  const updateMeta = trpc.sequences.update.useMutation({ onSuccess: () => { utils.sequences.get.invalidate({ id }); utils.sequences.list.invalidate(); } });

  const [tab, setTab] = useState<Tab>("Editor");
  const [steps, setSteps] = useState<Step[]>([]);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  // settings draft
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");

  useEffect(() => {
    if (seq) {
      setSteps(Array.isArray(seq.steps) ? seq.steps : []);
      setName(seq.name ?? "");
      setDescription(seq.description ?? "");
    }
  }, [seq?.id]);

  const commit = (next: Step[]) => { setSteps(next); updateSteps.mutate({ id, steps: next as any }); };
  const addStep = (make: () => Step) => { const next = [...steps, make()]; setSteps(next); updateSteps.mutate({ id, steps: next as any }); setExpanded(next.length - 1); setAddOpen(false); };
  const removeStep = (i: number) => { const next = steps.filter((_, idx) => idx !== i); commit(next); if (expanded === i) setExpanded(null); };
  const moveStep = (i: number, dir: -1 | 1) => { const j = i + dir; if (j < 0 || j >= steps.length) return; const next = [...steps]; [next[i], next[j]] = [next[j], next[i]]; commit(next); };
  const patchStep = (i: number, patch: Partial<Step>) => { setSteps((prev) => prev.map((s, idx) => (idx === i ? ({ ...s, ...patch } as Step) : s))); };
  const commitEdits = () => updateSteps.mutate({ id, steps: steps as any });

  const statusBadge = useMemo(() => {
    const s = seq?.status ?? "draft";
    const map: Record<string, string> = { active: "bg-emerald-100 text-emerald-800", paused: "bg-amber-100 text-amber-800", draft: "bg-secondary text-muted-foreground", archived: "bg-muted text-muted-foreground" };
    return <span className={cn("inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium capitalize", map[s])}>{s}</span>;
  }, [seq?.status]);

  if (seqQ.isLoading) {
    return <Shell title="Sequence"><div className="p-6"><div className="h-8 w-48 bg-muted/50 rounded animate-pulse mb-4" /><div className="h-40 bg-muted/40 rounded animate-pulse" /></div></Shell>;
  }
  if (!seq) {
    return <Shell title="Sequence"><div className="p-10 text-center text-sm text-muted-foreground">Sequence not found. <Link href="/v2/sequences" className="underline" style={{ color: accent }}>Back to Sequences</Link></div></Shell>;
  }

  return (
    <Shell title={seq.name}>
      <div className="flex flex-col h-full min-h-0">
        {/* header */}
        <div className="relative shrink-0 px-4 pt-2.5 pb-0 border-b border-border bg-card/40">
          <span aria-hidden className="absolute inset-x-0 top-0 h-0.5" style={{ backgroundColor: accent }} />
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground mb-0.5">
            <Link href="/v2/sequences" className="hover:text-foreground hover:underline">Sequences</Link><span>›</span>
            <span className="text-foreground truncate max-w-[240px]">{seq.name}</span>
          </div>
          <div className="flex items-center gap-2 mb-1.5">
            <Send className="size-4" style={{ color: accent }} />
            <h1 className="text-[16px] font-semibold tracking-tight truncate max-w-[300px]">{seq.name}</h1>
            <Star className="size-4 text-muted-foreground" />
            {statusBadge}
            <div className="flex-1" />
            <Button variant="ghost" size="sm" className="h-7 gap-1.5"><Share2 className="size-3.5" /> Share</Button>
            <Button variant="outline" size="sm" className="h-7 gap-1.5" onClick={() => setLocation("/v2/people")}><Users className="size-3.5" /> Add contacts</Button>
            <Button
              size="sm"
              className="h-7 gap-1.5"
              style={{ backgroundColor: seq.status === "active" ? "#6b7280" : accent }}
              disabled={updateMeta.isPending || steps.length === 0}
              title={steps.length === 0 ? "Add a step first" : undefined}
              onClick={() => setLocation("/sequences")}
            >
              <Zap className="size-3.5" /> {seq.status === "active" ? "Manage" : "Activate"}
            </Button>
          </div>
          {/* tabs */}
          <div className="flex items-center gap-1">
            {TABS.map((t) => (
              <button key={t} onClick={() => setTab(t)} className={cn("relative px-3 py-2 text-[13px] transition-colors", tab === t ? "font-semibold" : "text-muted-foreground hover:text-foreground")} style={tab === t ? { color: accent } : undefined}>
                {t}{tab === t && <span className="absolute inset-x-2 bottom-0 h-0.5 rounded-full" style={{ backgroundColor: accent }} />}
              </button>
            ))}
          </div>
        </div>

        <div className="flex-1 min-h-0 overflow-auto">
          {/* EDITOR */}
          {tab === "Editor" && (
            <div className="max-w-2xl mx-auto p-4 md:p-6">
              <div className="flex items-center gap-2 mb-4">
                <span className="text-[12px] font-medium px-2 py-1 rounded-md border bg-card inline-flex items-center gap-1.5"><Send className="size-3.5" style={{ color: accent }} /> {steps.length} step{steps.length === 1 ? "" : "s"}</span>
                {updateSteps.isPending && <span className="text-[11px] text-muted-foreground inline-flex items-center gap-1"><Loader2 className="size-3 animate-spin" /> Saving…</span>}
              </div>

              {steps.length === 0 ? (
                <div className="text-center py-14 border border-dashed rounded-xl">
                  <Send className="size-9 text-muted-foreground opacity-40 mx-auto mb-3" />
                  <div className="text-sm font-medium">Your sequence is empty</div>
                  <p className="text-sm text-muted-foreground mt-1">Add steps to build your sequence.</p>
                  <div className="mt-4"><AddStepButton accent={accent} open={addOpen} setOpen={setAddOpen} onAdd={addStep} /></div>
                </div>
              ) : (
                <div className="space-y-3">
                  {steps.map((s, i) => {
                    const meta = stepMeta(s);
                    const Icon = meta.icon;
                    const open = expanded === i;
                    return (
                      <div key={i} className="rounded-xl border bg-card shadow-sm">
                        <div className="flex items-center gap-3 px-3 py-2.5 cursor-pointer" onClick={() => setExpanded(open ? null : i)}>
                          <GripVertical className="size-4 text-muted-foreground/50 shrink-0" />
                          <span className="shrink-0 size-7 rounded-lg flex items-center justify-center text-[11px] font-bold" style={{ backgroundColor: `${accent}1f`, color: accent }}>{i + 1}</span>
                          <Icon className="size-4 shrink-0" style={{ color: accent }} />
                          <div className="min-w-0 flex-1">
                            <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{meta.label}</div>
                            <div className="text-[13px] truncate">{meta.summary}</div>
                          </div>
                          <div className="flex items-center gap-0.5 shrink-0" onClick={(e) => e.stopPropagation()}>
                            <Button variant="ghost" size="icon-sm" disabled={i === 0} onClick={() => moveStep(i, -1)}><ArrowUp className="size-3.5" /></Button>
                            <Button variant="ghost" size="icon-sm" disabled={i === steps.length - 1} onClick={() => moveStep(i, 1)}><ArrowDown className="size-3.5" /></Button>
                            <Button variant="ghost" size="icon-sm" className="text-muted-foreground hover:text-destructive" onClick={() => removeStep(i)}><Trash2 className="size-3.5" /></Button>
                            <ChevronDown className={cn("size-4 text-muted-foreground transition-transform", open && "rotate-180")} />
                          </div>
                        </div>
                        {open && (
                          <div className="border-t border-border/60 p-3 space-y-2" onBlur={commitEdits}>
                            <StepEditor step={s} onChange={(patch) => patchStep(i, patch)} accent={accent} />
                          </div>
                        )}
                      </div>
                    );
                  })}
                  <div className="pt-1"><AddStepButton accent={accent} open={addOpen} setOpen={setAddOpen} onAdd={addStep} /></div>
                </div>
              )}
            </div>
          )}

          {/* CONTACTS */}
          {tab === "Contacts" && (
            <div className="p-4 md:p-6">
              <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-2 mb-4">
                {[
                  { l: "Total", v: seq.enrolledCount ?? 0 }, { l: "Cold", v: 0 }, { l: "Approaching", v: 0 },
                  { l: "Replied", v: 0 }, { l: "Interested", v: 0 }, { l: "In progress", v: seq.enrolledCount ?? 0 },
                ].map((s) => (
                  <div key={s.l} className="rounded-lg border bg-card p-2.5 text-center shadow-sm">
                    <div className="text-lg font-semibold tabular-nums" style={{ color: accent }}>{s.v}</div>
                    <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{s.l}</div>
                  </div>
                ))}
              </div>
              <div className="rounded-xl border bg-card shadow-sm py-14 text-center">
                <Users className="size-8 text-muted-foreground opacity-40 mx-auto mb-2" />
                <div className="text-sm font-medium">{(seq.enrolledCount ?? 0) === 0 ? "No contacts enrolled yet" : `${seq.enrolledCount} enrolled`}</div>
                <p className="text-xs text-muted-foreground mt-1">Add people from the People page or a list to start this sequence.</p>
                <Button size="sm" className="mt-3" style={{ backgroundColor: accent }} onClick={() => setLocation("/v2/people")}>Add contacts</Button>
              </div>
            </div>
          )}

          {/* ACTIVITY */}
          {tab === "Activity" && (
            <div className="max-w-2xl mx-auto p-4 md:p-6">
              <div className="rounded-xl border bg-card shadow-sm divide-y divide-border/60">
                <div className="flex items-center gap-3 px-3 py-3">
                  <span className="size-7 rounded-full flex items-center justify-center" style={{ backgroundColor: `${accent}1f`, color: accent }}><Send className="size-3.5" /></span>
                  <div className="text-[13px]">You created the sequence.</div>
                  <div className="flex-1" />
                  <div className="text-[11px] text-muted-foreground">{seq.createdAt ? new Date(seq.createdAt).toLocaleString() : ""}</div>
                </div>
              </div>
            </div>
          )}

          {/* REPORT */}
          {tab === "Report" && (
            <div className="p-6 flex items-center justify-center">
              <div className="text-center max-w-sm">
                <div className="mx-auto size-12 rounded-full bg-secondary flex items-center justify-center mb-3"><BarChart3 className="size-5 text-muted-foreground" /></div>
                <h2 className="text-sm font-semibold">Report</h2>
                <p className="text-sm text-muted-foreground mt-1">Delivery, open, reply and meeting funnel — populates once this sequence starts sending.</p>
              </div>
            </div>
          )}

          {/* SETTINGS */}
          {tab === "Settings" && (
            <div className="max-w-xl mx-auto p-4 md:p-6 space-y-4">
              <div className="rounded-xl border bg-card shadow-sm p-4 space-y-3">
                <h2 className="text-sm font-semibold flex items-center gap-2"><Settings2 className="size-4" style={{ color: accent }} /> Sequence settings</h2>
                <div>
                  <div className="text-[12px] font-medium mb-1">Sequence name</div>
                  <Input value={name} onChange={(e) => setName(e.target.value)} />
                </div>
                <div>
                  <div className="text-[12px] font-medium mb-1">Description</div>
                  <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} className="w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2" style={{ ["--tw-ring-color" as any]: `${accent}55` }} />
                </div>
                <div className="flex items-center gap-2"><span className="text-[12px] text-muted-foreground">Status:</span> {statusBadge}</div>
                <div className="flex justify-end">
                  <Button size="sm" style={{ backgroundColor: accent }} disabled={updateMeta.isPending || !name.trim()} onClick={() => updateMeta.mutate({ id, patch: { name: name.trim(), description: description.trim() || null } })}>
                    {updateMeta.isPending ? "Saving…" : "Update settings"}
                  </Button>
                </div>
              </div>
              <div className="rounded-xl border bg-card shadow-sm p-4">
                <h2 className="text-sm font-semibold mb-2">Scheduling</h2>
                <p className="text-[12px] text-muted-foreground">Send window Mon–Fri, 8 AM–5 PM (workspace default). Per-sequence schedules coming soon.</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </Shell>
  );
}

function AddStepButton({ accent, open, setOpen, onAdd }: { accent: string; open: boolean; setOpen: (b: boolean) => void; onAdd: (make: () => Step) => void }) {
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button size="sm" className="gap-1.5" style={{ backgroundColor: accent }}><Plus className="size-4" /> Add a step</Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-60">
        {STEP_OPTIONS.map((o) => {
          const Icon = o.icon;
          return <DropdownMenuItem key={o.key} onClick={() => onAdd(o.make)}><Icon className="size-4 mr-2" style={{ color: accent }} /> {o.label}</DropdownMenuItem>;
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function StepEditor({ step, onChange, accent }: { step: Step; onChange: (patch: Partial<Step>) => void; accent: string }) {
  const ta = "w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2";
  const ring = { ["--tw-ring-color" as any]: `${accent}55` } as React.CSSProperties;
  if (step.type === "email") {
    return (
      <>
        <Input value={step.subject} placeholder="Subject line" onChange={(e) => onChange({ subject: e.target.value } as any)} />
        <textarea value={step.body ?? ""} placeholder="Write your email… Use {{first_name}} for personalization." rows={6} className={ta} style={ring} onChange={(e) => onChange({ body: e.target.value } as any)} />
      </>
    );
  }
  if (step.type === "wait") {
    return (
      <label className="flex items-center gap-2 text-[13px]">Wait
        <Input type="number" min={0} max={60} value={step.days} className="w-20 h-8" onChange={(e) => onChange({ days: Math.max(0, Math.min(60, Number(e.target.value) || 0)) } as any)} /> day(s) before the next step.
      </label>
    );
  }
  if (step.type === "task") {
    return <textarea value={step.body} placeholder="What should the rep do? (e.g. Call and reference their recent funding)" rows={3} className={ta} style={ring} onChange={(e) => onChange({ body: e.target.value } as any)} />;
  }
  if (step.type === "linkedin_invite") {
    return <textarea value={step.note ?? ""} placeholder="Connection request note (optional, 300 char max)" rows={3} maxLength={300} className={ta} style={ring} onChange={(e) => onChange({ note: e.target.value } as any)} />;
  }
  return <textarea value={step.body ?? ""} placeholder="LinkedIn message…" rows={4} className={ta} style={ring} onChange={(e) => onChange({ body: e.target.value } as any)} />;
}
