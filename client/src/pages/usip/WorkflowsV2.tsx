/**
 * WorkflowsV2 — the Automation → "Workflows" surface (/v2/workflows).
 *
 * An Autonomy Control Center: one screen to see and control every autonomous
 * engine in Velocity. It doesn't add new automation — it surfaces and toggles
 * what already exists:
 *   1. Autopilots      — Tasks / Meetings / Conversations / Deals (Off/Approve/Auto)
 *   2. Revenue Engine  — ARE campaigns (start/pause + funnel)
 *   3. Workflow rules  — trigger→action rules + AI-suggested rules
 *   4. Auto-enroll     — segment→sequence rules
 * The full editors stay at /workflows and /are.
 */
import { useState } from "react";
import { Link } from "wouter";
import { toast } from "sonner";
import { Shell, useAccentColor } from "@/components/usip/Shell";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem,
} from "@/components/ui/select";
import {
  Workflow, ListTodo, CalendarClock, MessageSquare, KanbanSquare, Bot, Zap, Sparkles, Rocket,
  ExternalLink, Play, Pause, Check, X, Activity, GitBranch, Users, Mail, Share2, UserRoundCog, Database, Loader2,
} from "lucide-react";

function fmtWhen(d?: string | Date | null): string {
  if (!d) return "never";
  const date = new Date(d);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" }) + " " + date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

const MODE_LABEL: Record<string, string> = { off: "Off", approval: "Approve", auto: "Autonomous" };

export default function WorkflowsV2() {
  const accent = useAccentColor();
  const utils = trpc.useUtils();

  // ── Autopilots (my four features) ──
  const taskAp = trpc.tasks.getAutopilotSettings.useQuery();
  const meetAp = trpc.meetings.getAutopilotSettings.useQuery();
  const convAp = trpc.conversations.getAutopilotSettings.useQuery();
  const dealAp = trpc.deals.getAutopilotSettings.useQuery();
  const socialAp = trpc.unipile.getSocialAutopilotSettings.useQuery(undefined as any, { retry: false });
  const jobChangeAp = trpc.linkedinEnrichment.getJobChangeSettings.useQuery(undefined as any, { retry: false });
  // Chat autonomy lives per-agent; this row reports the most permissive agent
  // and writes to all of them. Per-agent control is on /v2/chat.
  const chatAp = trpc.chatAgents.getAutopilotSettings.useQuery(undefined as any, { retry: false });
  // Backlog enrichment sweep. "Approve" here means an attended run, not a
  // queued draft — enrichment writes data and sends nothing, so the only thing
  // worth gating is unattended Reoon credit spend.
  const sweepAp = trpc.prospects.sweepStatus.useQuery(undefined as any, { retry: false });
  // Separate switch from the sweep: this one spends LinkedIn lookups (~100/day
  // on the connected account), not Reoon credits. One control over two budgets
  // is how someone gets surprised by a bill they did not choose.
  const backfillAp = trpc.prospects.backfillStatus.useQuery(undefined as any, { retry: false });

  const setTaskAp = trpc.tasks.setAutopilotSettings.useMutation({ onSuccess: () => utils.tasks.getAutopilotSettings.invalidate() });
  const setMeetAp = trpc.meetings.setAutopilotSettings.useMutation({ onSuccess: () => utils.meetings.getAutopilotSettings.invalidate() });
  const setConvAp = trpc.conversations.setAutopilotSettings.useMutation({ onSuccess: () => utils.conversations.getAutopilotSettings.invalidate() });
  const setDealAp = trpc.deals.setAutopilotSettings.useMutation({ onSuccess: () => utils.deals.getAutopilotSettings.invalidate() });
  const setSocialAp = trpc.unipile.setSocialAutopilotSettings.useMutation({ onSuccess: () => utils.unipile.getSocialAutopilotSettings.invalidate(), onError: (e) => toast.error(e.message.includes("FORBIDDEN") ? "Only admins can change Social Autopilot" : e.message) });
  const setJobChangeAp = trpc.linkedinEnrichment.setJobChangeSettings.useMutation({ onSuccess: () => utils.linkedinEnrichment.getJobChangeSettings.invalidate(), onError: (e) => toast.error(e.message.includes("FORBIDDEN") ? "Only admins can change Job Change Autopilot" : e.message) });
  const runSweep = trpc.prospects.runSweep.useMutation({
    onSuccess: (r: any) => {
      utils.prospects.sweepStatus.invalidate();
      const why = r?.stoppedBecause === "no_key" ? "no Reoon key configured"
        : r?.stoppedBecause === "no_credits" ? "Reoon credits ran low"
        : r?.stoppedBecause === "no_candidates" ? "nothing was waiting"
        : r?.stoppedBecause === "cap" ? "hit the batch cap" : "finished the batch";
      toast.success(`Swept ${r?.attempted ?? 0} — found ${r?.emailsFound ?? 0} email${r?.emailsFound === 1 ? "" : "s"} (${why})`);
    },
    onError: (e) => toast.error(e.message),
  });
  const setBackfillAp = trpc.prospects.setBackfillSettings.useMutation({ onSuccess: () => utils.prospects.backfillStatus.invalidate(), onError: (e) => toast.error(e.message) });
  const setSweepAp = trpc.prospects.setSweepSettings.useMutation({ onSuccess: () => utils.prospects.sweepStatus.invalidate(), onError: (e) => toast.error(e.message) });
  const setChatAp = trpc.chatAgents.setAutopilotSettings.useMutation({ onSuccess: () => utils.chatAgents.getAutopilotSettings.invalidate(), onError: (e) => toast.error(e.message.includes("FORBIDDEN") ? "Only admins can change the Chat Agent" : e.message) });

  // Email AI auto-send — a boolean autonomy control, surfaced here too.
  const emailAuto = trpc.emailAutoSend.getAutoSendSettings.useQuery(undefined as any, { retry: false });
  const setEmailAuto = trpc.emailAutoSend.updateAutoSendSettings.useMutation({
    onSuccess: () => utils.emailAutoSend.getAutoSendSettings.invalidate(),
    onError: (e) => toast.error(e.message.includes("FORBIDDEN") ? "Only admins can change auto-send" : e.message),
  });
  const setEmailAutoEnabled = (enabled: boolean) => {
    const cur = emailAuto.data as any;
    setEmailAuto.mutate({
      aiAutoSendEnabled: enabled,
      aiAutoSendScoreMin: cur?.aiAutoSendScoreMin ?? 70,
      aiAutoSendConfidenceMin: cur?.aiAutoSendConfidenceMin ?? 75,
      aiAutoSendAllowUnscored: cur?.aiAutoSendAllowUnscored ?? false,
    } as any);
  };

  const autopilots = [
    { key: "tasks", label: "Task Autopilot", icon: ListTodo, blurb: "Next-best-action per prospect", href: "/v2/tasks", mode: taskAp.data?.mode ?? "off", lastRunAt: taskAp.data?.lastRunAt, set: (m: string) => setTaskAp.mutate({ mode: m as any }) },
    { key: "meetings", label: "Meeting Autopilot", icon: CalendarClock, blurb: "Propose times + book meetings", href: "/v2/meetings", mode: meetAp.data?.mode ?? "off", lastRunAt: meetAp.data?.lastRunAt, set: (m: string) => setMeetAp.mutate({ mode: m as any }) },
    { key: "conversations", label: "Conversation Autopilot", icon: MessageSquare, blurb: "Classify replies + act", href: "/v2/conversations", mode: convAp.data?.mode ?? "off", lastRunAt: convAp.data?.lastRunAt, set: (m: string) => setConvAp.mutate({ mode: m as any }) },
    { key: "deals", label: "Deal Autopilot", icon: KanbanSquare, blurb: "Advance deals toward close", href: "/v2/deals", mode: dealAp.data?.mode ?? "off", lastRunAt: dealAp.data?.lastRunAt, set: (m: string) => setDealAp.mutate({ mode: m as any }) },
    { key: "social", label: "Social Autopilot", icon: Share2, blurb: "Auto-invite leads → opener on accept", href: "/v2/conversations", mode: socialAp.data?.mode ?? "off", lastRunAt: socialAp.data?.lastRunAt, set: (m: string) => setSocialAp.mutate({ mode: m as any }) },
    { key: "jobChange", label: "Job Change Autopilot", icon: UserRoundCog, blurb: "Re-engage when a prospect changes jobs", href: "/v2/data-enrichment", mode: jobChangeAp.data?.mode ?? "off", lastRunAt: jobChangeAp.data?.lastRunAt, set: (m: string) => setJobChangeAp.mutate({ mode: m as any }) },
    { key: "enrichSweep", label: "Enrichment Sweep", icon: Database, blurb: "Backfill missing emails from company sites", href: "/prospects", mode: sweepAp.data?.mode ?? "off", lastRunAt: sweepAp.data?.lastRunAt, set: (m: string) => setSweepAp.mutate({ mode: m as any }) },
    { key: "companyBackfill", label: "Company Backfill", icon: Users, blurb: "Read missing employers off LinkedIn profiles", href: "/v2/data-enrichment", mode: backfillAp.data?.mode ?? "off", lastRunAt: backfillAp.data?.lastRunAt, set: (m: string) => setBackfillAp.mutate({ mode: m as any }) },
    { key: "chat", label: "Inbound Chat Agent", icon: MessageSquare, blurb: "Qualify website visitors → book the meeting", href: "/v2/chat", mode: chatAp.data?.mode ?? "off", lastRunAt: undefined, set: (m: string) => setChatAp.mutate({ mode: m as any }) },
  ];
  const onCount = autopilots.filter((a) => a.mode !== "off").length;

  const setAll = (mode: string) => {
    setTaskAp.mutate({ mode: mode as any });
    setMeetAp.mutate({ mode: mode as any });
    setConvAp.mutate({ mode: mode as any });
    setDealAp.mutate({ mode: mode as any });
    setSocialAp.mutate({ mode: mode as any });
    setJobChangeAp.mutate({ mode: mode as any });
    setChatAp.mutate({ mode: mode as any });
    setSweepAp.mutate({ mode: mode as any });
    setBackfillAp.mutate({ mode: mode as any });
    toast.success(mode === "off" ? "All autopilots turned off" : `All autopilots set to ${MODE_LABEL[mode]}`);
  };

  // One click to enable the whole autonomous stack in the safe Approve mode.
  const turnOnFullAutonomy = () => {
    setTaskAp.mutate({ mode: "approval" as any });
    setMeetAp.mutate({ mode: "approval" as any });
    setConvAp.mutate({ mode: "approval" as any });
    setDealAp.mutate({ mode: "approval" as any });
    setSocialAp.mutate({ mode: "approval" as any });
    setJobChangeAp.mutate({ mode: "approval" as any });
    setChatAp.mutate({ mode: "approval" as any });
    setSweepAp.mutate({ mode: "approval" as any });
    setBackfillAp.mutate({ mode: "approval" as any });
    setEmailAutoEnabled(true);
    toast.success("Full autonomy on (Approve mode) — AI actions will queue for your review");
  };

  // ── ARE campaigns ──
  const campaigns = trpc.are.campaigns.list.useQuery({ limit: 20 } as any, { retry: false });
  const setCampaignStatus = trpc.are.campaigns.setStatus.useMutation({ onSuccess: () => { utils.are.campaigns.list.invalidate(); }, onError: (e) => toast.error(e.message) });

  // ── Workflow rules + AI suggestions ──
  const rules = trpc.workflows.list.useQuery(undefined as any, { retry: false });
  const toggleRule = trpc.workflows.toggle.useMutation({ onSuccess: () => utils.workflows.list.invalidate(), onError: (e) => toast.error(e.message) });
  const suggestions = trpc.workflowsAi.listSuggestions.useQuery(undefined as any, { retry: false });
  const genSuggestions = trpc.workflowsAi.generateSuggestions.useMutation({ onSuccess: () => { utils.workflowsAi.listSuggestions.invalidate(); toast.success("AI generated new workflow ideas"); }, onError: (e) => toast.error(e.message) });
  const applySuggestion = trpc.workflowsAi.applySuggestion.useMutation({ onSuccess: () => { utils.workflowsAi.listSuggestions.invalidate(); utils.workflows.list.invalidate(); toast.success("Workflow created"); }, onError: (e) => toast.error(e.message) });
  const dismissSuggestion = trpc.workflowsAi.dismissSuggestion.useMutation({ onSuccess: () => utils.workflowsAi.listSuggestions.invalidate() });

  // ── Segment auto-enroll rules ──
  const segRules = trpc.segmentRules.list.useQuery(undefined as any, { retry: false });
  const saveSegRule = trpc.segmentRules.save.useMutation({ onSuccess: () => utils.segmentRules.list.invalidate(), onError: (e) => toast.error(e.message) });
  const runSegRules = trpc.segmentRules.runEnrollment.useMutation({ onSuccess: (r: any) => { utils.segmentRules.list.invalidate(); toast.success(`Enrolled ${r?.enrolled ?? 0} contact(s)`); }, onError: (e) => toast.error(e.message) });

  const campaignList = (campaigns.data as any[]) ?? [];
  const ruleList = (rules.data as any[]) ?? [];
  const sugList = (suggestions.data as any[]) ?? [];
  const segList = (segRules.data as any[]) ?? [];

  const Section = ({ icon: Icon, title, action, children }: any) => (
    <section>
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-sm font-semibold flex items-center gap-2"><Icon className="size-4" style={{ color: accent }} /> {title}</h2>
        {action}
      </div>
      {children}
    </section>
  );

  return (
    <Shell title="Workflows">
      <div className="flex flex-col h-full min-h-0">
        <div className="relative shrink-0 flex items-center gap-2 px-4 h-11 border-b border-border bg-card/40">
          <span aria-hidden className="absolute inset-x-0 top-0 h-0.5" style={{ backgroundColor: accent }} />
          <Workflow className="size-4" style={{ color: accent }} />
          <h1 className="text-[15px] font-semibold tracking-tight">Workflows</h1>
          <span className="text-[11px] text-muted-foreground hidden sm:inline">· Autonomy control center</span>
          <div className="flex-1" />
          <span className="text-[11px] text-muted-foreground mr-1">{onCount}/{autopilots.length} autopilots on</span>
          <Select onValueChange={setAll}>
            <SelectTrigger className="h-7 w-[150px] text-xs"><SelectValue placeholder="Set all autopilots" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="off">All: Off</SelectItem>
              <SelectItem value="approval">All: Approve</SelectItem>
              <SelectItem value="auto">All: Autonomous</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="flex-1 min-h-0 overflow-auto p-4 md:p-6 space-y-6">
          {/* Hero */}
          <div className="rounded-xl border px-4 py-3 flex items-center gap-3 shadow-sm" style={{ background: `linear-gradient(135deg, ${accent}0d, transparent)` }}>
            <span className="shrink-0 size-9 rounded-full flex items-center justify-center" style={{ backgroundColor: `${accent}1f`, color: accent }}><Rocket className="size-5" /></span>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium">Autonomous operation</div>
              <div className="text-[12px] text-muted-foreground">Turn on the autopilots to run the pipeline — prospect → task → reply → meeting → deal — with limited or no manual work. Set each to <b>Approve</b> to review first, or <b>Autonomous</b> to run hands-off.</div>
            </div>
            <Button data-tour-id="autonomy-turn-on-all" size="sm" className="shrink-0 gap-1.5" onClick={turnOnFullAutonomy}><Rocket className="size-3.5" /> Turn on full autonomy</Button>
          </div>

          {/* What Off / Approve / Autonomous actually mean. This is the concept
              the entire product rests on and the one nobody guesses right the
              first time, so it is spelled out once, here, next to the controls
              that use it — not left to a help article nobody opens mid-task. */}
          <div className="rounded-xl border bg-muted/30 px-4 py-3">
            <div className="text-[12px] font-medium mb-1.5">What the three settings mean</div>
            <ul className="text-[12px] text-muted-foreground space-y-1">
              <li><b className="text-foreground">Off</b> — nothing happens. Safe while you're still looking around.</li>
              <li><b className="text-foreground">Approve</b> — the AI does the work but stops before anything leaves the building. It arrives as a task for you to review. <b>Start here:</b> it shows you exactly what it would have done, at no risk.</li>
              <li><b className="text-foreground">Autonomous</b> — it acts on its own and tells you afterwards. Turn this on once Approve has been producing work you'd have sent anyway.</li>
            </ul>
          </div>

          {/* Autopilots */}
          <Section icon={Bot} title="Autopilots">
            <div data-tour-id="autonomy-autopilots" className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {autopilots.map((a) => (
                <div key={a.key} className="rounded-xl border bg-card p-3 shadow-sm flex items-center gap-3">
                  <span className="shrink-0 size-9 rounded-full flex items-center justify-center" style={{ backgroundColor: a.mode === "off" ? "hsl(var(--muted))" : "#7c3aed1f", color: a.mode === "off" ? undefined : "#7c3aed" }}>
                    {a.mode === "auto" ? <Zap className="size-4" /> : <a.icon className="size-4" />}
                  </span>
                  <div className="min-w-0 flex-1">
                    <Link href={a.href} className="text-sm font-medium hover:underline">{a.label}</Link>
                    <div className="text-[11px] text-muted-foreground">{a.blurb} · last run {fmtWhen(a.lastRunAt)}</div>
                  </div>
                  <Select value={a.mode} onValueChange={a.set}>
                    <SelectTrigger className="h-7 w-[128px] text-xs shrink-0"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="off">Off</SelectItem>
                      <SelectItem value="approval">Approve</SelectItem>
                      <SelectItem value="auto">Autonomous</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              ))}
            </div>
            {/* Enrichment Sweep needs an attended-run button: its "Approve" mode
                means "runs when you press this", so without a button that mode
                could never do anything at all. */}
            {(sweepAp.data as any) && (sweepAp.data as any).mode !== "off" && (
              <div className="rounded-xl border bg-card p-3 shadow-sm flex flex-wrap items-center gap-3 mt-3">
                <Database className="size-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium">Run an enrichment sweep now</div>
                  <div className="text-[11px] text-muted-foreground">
                    {(sweepAp.data as any).candidates} ready to verify
                    {(sweepAp.data as any).queue?.needsDomain ? ` · ${(sweepAp.data as any).queue.needsDomain} need a company domain first (free to resolve)` : ""}
                    {!(sweepAp.data as any).reoonConfigured ? " · no Reoon key — nothing can be verified" : ""}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  className="shrink-0 gap-1.5"
                  disabled={runSweep.isPending || !(sweepAp.data as any).reoonConfigured}
                  onClick={() => runSweep.mutate({ limit: 25 })}
                >
                  {runSweep.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
                  {runSweep.isPending ? "Sweeping…" : "Sweep 25"}
                </Button>
              </div>
            )}
            <div className="rounded-xl border bg-card p-3 shadow-sm flex items-center gap-3 mt-3">
              <span className="shrink-0 size-9 rounded-full flex items-center justify-center" style={{ backgroundColor: (emailAuto.data as any)?.aiAutoSendEnabled ? "#7c3aed1f" : "hsl(var(--muted))", color: (emailAuto.data as any)?.aiAutoSendEnabled ? "#7c3aed" : undefined }}>
                {(emailAuto.data as any)?.aiAutoSendEnabled ? <Zap className="size-4" /> : <Mail className="size-4" />}
              </span>
              <div className="min-w-0 flex-1">
                <Link href="/v2/emails" className="text-sm font-medium hover:underline">Email auto-send</Link>
                <div className="text-[11px] text-muted-foreground">AI drafts send themselves when lead score &amp; confidence are high enough</div>
              </div>
              <Switch checked={!!(emailAuto.data as any)?.aiAutoSendEnabled} onCheckedChange={setEmailAutoEnabled} disabled={setEmailAuto.isPending || !emailAuto.data} />
            </div>
          </Section>

          {/* ARE campaigns */}
          <Section icon={Activity} title="Autonomous Revenue Engine"
            action={<Link href="/are" className="text-[11px] text-muted-foreground hover:text-foreground inline-flex items-center gap-1"><ExternalLink className="size-3" /> Open ARE hub</Link>}>
            <div className="rounded-xl border bg-card overflow-hidden shadow-sm">
              {campaigns.isLoading ? (
                <div className="p-3 space-y-2">{Array.from({ length: 2 }).map((_, i) => <div key={i} className="h-10 rounded bg-muted/50 animate-pulse" />)}</div>
              ) : campaignList.length === 0 ? (
                <div className="text-center py-8 px-4">
                  <div className="text-sm font-medium">No campaigns yet</div>
                  <p className="text-xs text-muted-foreground mt-1">Create an autonomous outbound campaign in the ARE hub.</p>
                  <Link href="/are/campaigns"><Button size="sm" variant="outline" className="mt-3 gap-1.5"><Rocket className="size-3.5" /> New campaign</Button></Link>
                </div>
              ) : (
                campaignList.map((c: any) => (
                  <div key={c.id} className="flex items-center gap-3 px-3 py-2.5 border-b border-border/60 last:border-0">
                    <span className={cn("shrink-0 size-2 rounded-full", c.status === "active" ? "bg-emerald-500" : c.status === "paused" ? "bg-amber-400" : "bg-muted-foreground/40")} />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium truncate">{c.name}</div>
                      <div className="text-[11px] text-muted-foreground">
                        {(c.prospectsDiscovered ?? 0)} found · {(c.prospectsContacted ?? 0)} contacted · {(c.prospectsReplied ?? 0)} replied · <b className="text-emerald-600 dark:text-emerald-400">{(c.meetingsBooked ?? 0)} meetings</b>
                      </div>
                    </div>
                    <span className="shrink-0 text-[10px] rounded px-1.5 py-0.5 bg-secondary text-muted-foreground capitalize">{c.status}</span>
                    {c.status === "active" ? (
                      <Button size="icon" variant="ghost" className="size-7" title="Pause" onClick={() => setCampaignStatus.mutate({ id: c.id, status: "paused" })}><Pause className="size-3.5" /></Button>
                    ) : c.status === "paused" || c.status === "draft" ? (
                      <Button size="icon" variant="ghost" className="size-7" title="Start" onClick={() => setCampaignStatus.mutate({ id: c.id, status: "active" })}><Play className="size-3.5" /></Button>
                    ) : null}
                  </div>
                ))
              )}
            </div>
          </Section>

          {/* AI workflow suggestions */}
          {sugList.length > 0 && (
            <Section icon={Sparkles} title="AI workflow ideas">
              <div className="space-y-2">
                {sugList.map((sug: any) => (
                  <div key={sug.id} className="rounded-xl border bg-card p-3 shadow-sm flex items-start gap-3" style={{ borderColor: "#7c3aed40" }}>
                    <Sparkles className="size-4 mt-0.5 shrink-0" style={{ color: "#7c3aed" }} />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium">{sug.title}</div>
                      <div className="text-[12px] text-muted-foreground">{sug.description}</div>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <Button size="sm" variant="outline" className="h-7 gap-1" disabled={applySuggestion.isPending} onClick={() => applySuggestion.mutate({ id: sug.id })}><Check className="size-3.5" /> Add</Button>
                      <Button size="icon" variant="ghost" className="size-7 text-muted-foreground" onClick={() => dismissSuggestion.mutate({ id: sug.id })}><X className="size-4" /></Button>
                    </div>
                  </div>
                ))}
              </div>
            </Section>
          )}

          {/* Workflow rules */}
          <Section icon={GitBranch} title="Workflow rules"
            action={
              <div className="flex items-center gap-2">
                <Button size="sm" variant="outline" className="h-7 gap-1.5" disabled={genSuggestions.isPending} onClick={() => genSuggestions.mutate()}><Sparkles className="size-3.5" /> {genSuggestions.isPending ? "Thinking…" : "Suggest with AI"}</Button>
                <Link href="/workflows" className="text-[11px] text-muted-foreground hover:text-foreground inline-flex items-center gap-1"><ExternalLink className="size-3" /> Editor</Link>
              </div>
            }>
            <div className="rounded-xl border bg-card overflow-hidden shadow-sm">
              {rules.isLoading ? (
                <div className="p-3 space-y-2">{Array.from({ length: 2 }).map((_, i) => <div key={i} className="h-10 rounded bg-muted/50 animate-pulse" />)}</div>
              ) : ruleList.length === 0 ? (
                <div className="text-center py-8 px-4">
                  <div className="text-sm font-medium">No workflow rules</div>
                  <p className="text-xs text-muted-foreground mt-1">Rules fire on triggers (stage change, deal stuck, reply…) and run actions automatically. Ask AI for ideas, or build one in the editor.</p>
                </div>
              ) : (
                ruleList.map((r: any) => (
                  <div key={r.id} className="flex items-center gap-3 px-3 py-2.5 border-b border-border/60 last:border-0">
                    <Switch checked={!!r.enabled} onCheckedChange={(v) => toggleRule.mutate({ id: r.id, enabled: v })} />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium truncate">{r.name}</div>
                      <div className="text-[11px] text-muted-foreground">Trigger: {String(r.triggerType ?? "").replace(/_/g, " ")} · fired {r.fireCount ?? 0}× · last {fmtWhen(r.lastFiredAt)}</div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </Section>

          {/* Segment auto-enroll */}
          <Section icon={Users} title="Auto-enroll rules"
            action={segList.length > 0 ? <Button size="sm" variant="outline" className="h-7 gap-1.5" disabled={runSegRules.isPending} onClick={() => runSegRules.mutate()}><Play className="size-3.5" /> Run now</Button> : undefined}>
            <div className="rounded-xl border bg-card overflow-hidden shadow-sm">
              {segRules.isLoading ? (
                <div className="p-3 space-y-2">{Array.from({ length: 2 }).map((_, i) => <div key={i} className="h-10 rounded bg-muted/50 animate-pulse" />)}</div>
              ) : segList.length === 0 ? (
                <div className="text-center py-8 px-4">
                  <div className="text-sm font-medium">No auto-enroll rules</div>
                  <p className="text-xs text-muted-foreground mt-1">Map an audience segment to a sequence and matching contacts enroll automatically every hour.</p>
                </div>
              ) : (
                segList.map((r: any) => (
                  <div key={r.id} className="flex items-center gap-3 px-3 py-2.5 border-b border-border/60 last:border-0">
                    <Switch checked={!!r.enabled} onCheckedChange={(v) => saveSegRule.mutate({ id: r.id, segmentId: r.segmentId, sequenceId: r.sequenceId, enabled: v })} />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium truncate">{r.segmentName ?? `Segment #${r.segmentId}`} → {r.sequenceName ?? `Sequence #${r.sequenceId}`}</div>
                      <div className="text-[11px] text-muted-foreground">{r.enrolledCount ?? 0} enrolled · last run {fmtWhen(r.lastRunAt)}</div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </Section>
        </div>
      </div>
    </Shell>
  );
}
