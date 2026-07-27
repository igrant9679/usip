/**
 * ChatAgents — Admin-only builder for the inbound AI chat agent (/v2/chat).
 *
 * Configure the agent's persona and qualifying questions, set its autonomy
 * (Off / Approve / Auto), publish it, then either share the /c/:slug link or
 * paste the iframe snippet into a website. The transcripts panel shows what
 * the agent actually said and what it produced (lead, meeting).
 *
 * The mode selector here is the real control; the Autonomy Control Center's
 * single "Inbound Chat" row is a bulk shortcut over the same field.
 */
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Shell, useAccentColor } from "@/components/usip/Shell";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { confirmAction } from "@/components/usip/Common";
import {
  MessageSquare, Plus, Trash2, Copy, ExternalLink, Check, Globe, Loader2, Users, CalendarCheck, Code2,
} from "lucide-react";

const MODES = [
  { value: "off", label: "Off", blurb: "The widget refuses to serve." },
  { value: "approval", label: "Approve", blurb: "Chats and captures the lead; a qualified visitor becomes a task for a rep." },
  { value: "auto", label: "Autonomous", blurb: "Shows your real availability and books the meeting itself." },
];

export default function ChatAgents() {
  const accent = useAccentColor();
  const { current } = useWorkspace();
  const isAdmin = current?.role === "admin" || current?.role === "super_admin";

  const utils = trpc.useUtils();
  const list = trpc.chatAgents.list.useQuery(undefined as any, { retry: false, enabled: isAdmin });
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const detail = trpc.chatAgents.get.useQuery({ id: selectedId! }, { enabled: isAdmin && !!selectedId, retry: false });
  const seqQ = trpc.sequences.list.useQuery(undefined as any, { enabled: isAdmin, retry: false });
  const sequences = ((seqQ.data as any[]) ?? []).filter((s) => s.status !== "archived");
  const sessionsQ = trpc.chatAgents.sessions.useQuery({ agentId: selectedId!, limit: 50 } as any, { enabled: isAdmin && !!selectedId, retry: false });
  const sessions = (sessionsQ.data as any[]) ?? [];

  const create = trpc.chatAgents.create.useMutation({
    onSuccess: (r: any) => { utils.chatAgents.list.invalidate(); setSelectedId(r.id); toast.success("Chat agent created"); },
    onError: (e: any) => toast.error(e?.message ?? "Failed"),
  });
  const update = trpc.chatAgents.update.useMutation({
    onSuccess: () => { utils.chatAgents.list.invalidate(); utils.chatAgents.get.invalidate(); toast.success("Saved"); },
    onError: (e: any) => toast.error(e?.message ?? "Save failed"),
  });
  const remove = trpc.chatAgents.remove.useMutation({
    onSuccess: () => { utils.chatAgents.list.invalidate(); setSelectedId(null); toast.success("Deleted"); },
    onError: (e: any) => toast.error(e?.message ?? "Failed"),
  });

  const [form, setForm] = useState<any>(null);
  const [copied, setCopied] = useState<"url" | "embed" | null>(null);
  const [openSession, setOpenSession] = useState<number | null>(null);

  useEffect(() => {
    if (detail.data) setForm({ ...detail.data, qualifyingQuestions: detail.data.qualifyingQuestions ?? [] });
  }, [detail.data]);

  const agents = (list.data as any[]) ?? [];
  const publicUrl = form?.slug ? `${window.location.origin}/c/${form.slug}` : "";
  // A launcher bubble, not a permanently-open 380x560 iframe: the snippet has
  // to be something a real marketing site would accept. Colour and name come
  // from the agent at runtime, so editing the persona never means re-pasting.
  const embedCode = form?.slug
    ? `<script src="${window.location.origin}/v/chat.js" data-agent="${form.slug}" async></script>`
    : "";
  const patch = (k: string, v: any) => setForm((f: any) => ({ ...f, [k]: v }));

  const copy = (text: string, which: "url" | "embed") => {
    navigator.clipboard?.writeText(text);
    setCopied(which);
    setTimeout(() => setCopied(null), 1500);
  };

  const save = () => {
    if (!form) return;
    update.mutate({
      id: form.id,
      name: form.name, displayName: form.displayName, greeting: form.greeting,
      persona: form.persona, themeColor: form.themeColor,
      qualifyingQuestions: (form.qualifyingQuestions as string[]).filter(Boolean),
      qualifyThreshold: form.qualifyThreshold,
      autoCreateLead: form.autoCreateLead, autoRoute: form.autoRoute,
      autoEnrollSequenceId: form.autoEnrollSequenceId ?? null,
    } as any);
  };

  /** Mode and publish state are one-click toggles — save immediately. */
  const setField = (k: string, v: any) => {
    patch(k, v);
    if (form?.id) update.mutate({ id: form.id, [k]: v } as any);
  };

  if (!isAdmin) {
    return (
      <Shell title="Chat">
        <div className="h-full flex items-center justify-center p-6 text-center">
          <div>
            <MessageSquare className="size-8 mx-auto text-muted-foreground opacity-50 mb-3" />
            <div className="text-sm font-semibold">Admins only</div>
            <p className="text-sm text-muted-foreground mt-1">Chat agent configuration is restricted to workspace admins.</p>
          </div>
        </div>
      </Shell>
    );
  }

  return (
    <Shell title="Chat">
      <div className="flex h-full min-h-0">
        {/* List */}
        <aside data-tour-id="chat-agent-list" className="w-72 shrink-0 border-r border-border flex flex-col bg-card/40">
          <div className="h-11 shrink-0 flex items-center gap-2 px-3 border-b border-border">
            <MessageSquare className="size-4" style={{ color: accent }} />
            <span className="text-sm font-semibold">Chat agents</span>
            <div className="flex-1" />
            <Button size="sm" className="h-7 gap-1 text-white" style={{ backgroundColor: accent }}
              disabled={create.isPending} onClick={() => create.mutate({ name: "Website chat" } as any)}>
              <Plus className="size-3.5" /> New
            </Button>
          </div>
          <div className="flex-1 min-h-0 overflow-auto p-2 space-y-1">
            {agents.length === 0 ? (
              <p className="text-xs text-muted-foreground p-3">No chat agents yet. Click <b>New</b> to create one — it captures meetings from your website without sending a single email.</p>
            ) : agents.map((a) => (
              <button key={a.id} onClick={() => setSelectedId(a.id)}
                className={`w-full text-left rounded-lg px-3 py-2 border transition-colors ${selectedId === a.id ? "border-primary bg-primary/5" : "border-transparent hover:bg-muted"}`}>
                <div className="flex items-center gap-2">
                  <span className="text-[13px] font-medium truncate flex-1">{a.name}</span>
                  <span className={`text-[9px] px-1.5 py-0.5 rounded-full font-medium ${a.status === "published" ? "bg-emerald-100 text-emerald-700" : "bg-muted text-muted-foreground"}`}>{a.status}</span>
                </div>
                <div className="text-[11px] text-muted-foreground mt-0.5 flex items-center gap-2">
                  <span className="inline-flex items-center gap-0.5"><MessageSquare className="size-3" /> {a.sessionCount}</span>
                  <span className="inline-flex items-center gap-0.5"><Users className="size-3" /> {a.leadCount}</span>
                  <span className="inline-flex items-center gap-0.5"><CalendarCheck className="size-3" /> {a.meetingCount}</span>
                  <span className="ml-auto">{a.mode === "auto" ? "Autonomous" : a.mode === "approval" ? "Approve" : "Off"}</span>
                </div>
              </button>
            ))}
          </div>
        </aside>

        {/* Editor */}
        <div className="flex-1 min-w-0 overflow-auto">
          {!form ? (
            <div className="h-full flex items-center justify-center text-sm text-muted-foreground">
              {selectedId ? <Loader2 className="size-5 animate-spin" /> : "Select an agent, or create a new one."}
            </div>
          ) : (
            <div className="max-w-2xl mx-auto p-6 space-y-6">
              <div className="flex items-center gap-2">
                <Input value={form.name} onChange={(e) => patch("name", e.target.value)} className="h-9 text-base font-semibold flex-1" />
                {form.status === "published" ? (
                  <Button variant="outline" size="sm" className="h-8" onClick={() => setField("status", "draft")}>Unpublish</Button>
                ) : (
                  <Button size="sm" className="h-8 gap-1 text-white" style={{ backgroundColor: accent }} onClick={() => setField("status", "published")}><Globe className="size-3.5" /> Publish</Button>
                )}
                <Button size="sm" className="h-8" disabled={update.isPending} onClick={save}>Save</Button>
              </div>

              {/* Autonomy — the thing that decides whether it books */}
              <Section title="Autonomy" tourId="chat-autonomy">
                <div className="grid gap-2">
                  {MODES.map((m) => (
                    <button key={m.value} type="button" onClick={() => setField("mode", m.value)}
                      className={`text-left rounded-lg border p-3 transition-colors ${form.mode === m.value ? "border-primary bg-primary/5" : "hover:bg-muted"}`}>
                      <div className="text-[13px] font-semibold">{m.label}</div>
                      <div className="text-[12px] text-muted-foreground mt-0.5">{m.blurb}</div>
                    </button>
                  ))}
                </div>
                {form.mode === "auto" && form.status === "published" && (
                  <p className="text-[11px] text-muted-foreground">
                    Qualified visitors will see your real open slots and book them. Make sure your booking link at <b>/b/…</b> has the working hours you want.
                  </p>
                )}
              </Section>

              {/* Share */}
              <Section title="Install" tourId="chat-install">
                <div className="rounded-lg border bg-card p-3 flex items-center gap-2">
                  <Globe className="size-4 shrink-0" style={{ color: accent }} />
                  <code className="text-[12px] truncate flex-1">{publicUrl}</code>
                  <Button variant="outline" size="sm" className="h-7 gap-1 shrink-0" onClick={() => copy(publicUrl, "url")}>
                    {copied === "url" ? <><Check className="size-3.5" /> Copied</> : <><Copy className="size-3.5" /> Copy</>}
                  </Button>
                  <Button variant="ghost" size="sm" className="h-7 gap-1 shrink-0" disabled={form.status !== "published"} onClick={() => window.open(publicUrl, "_blank")}><ExternalLink className="size-3.5" /> Open</Button>
                </div>
                {/* The one-click half: pages we already host for this workspace. */}
                <div className="rounded-lg border bg-card p-3 space-y-2">
                  <div className="flex items-center justify-between gap-3">
                    <Label className="text-sm">Show on my Velocity-hosted pages</Label>
                    <Switch checked={!!form.showOnHostedPages} onCheckedChange={(v) => setField("showOnHostedPages", v)} />
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    Adds the chat bubble to your landing pages (<b>/l/…</b>) and every rep's booking page (<b>/b/…</b>). No snippet, nothing to paste.
                    {form.status !== "published" && <> Takes effect once this agent is published.</>}
                  </p>
                </div>

                <Field label="Embed on your own website">
                  <div className="rounded-lg border bg-muted/40 p-3 space-y-2">
                    <code className="block text-[11px] leading-relaxed break-all text-muted-foreground">{embedCode}</code>
                    <Button variant="outline" size="sm" className="h-7 gap-1" onClick={() => copy(embedCode, "embed")}>
                      {copied === "embed" ? <><Check className="size-3.5" /> Copied</> : <><Code2 className="size-3.5" /> Copy snippet</>}
                    </Button>
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    Paste before <code>&lt;/body&gt;</code> on any page. It adds a chat bubble that opens the agent — it doesn't load the chat until a visitor clicks, and it shows nothing at all while this agent is unpublished or Off.
                  </p>
                </Field>
              </Section>

              {/* Funnel (measurement) */}
              <FunnelSection />

              {/* Abandonment follow-up (0137) — its own switch, not the agent's mode */}
              <Section title="If they leave without booking" tourId="chat-followup">
                <div className="flex gap-1.5">
                  {(["off", "approval", "auto"] as const).map((m) => (
                    <Button
                      key={m}
                      size="sm"
                      variant={form.followUpMode === m ? "default" : "outline"}
                      className="h-8 flex-1 text-[12px]"
                      style={form.followUpMode === m ? { backgroundColor: accent } : undefined}
                      onClick={() => setField("followUpMode", m)}
                    >
                      {m === "off" ? "Off" : m === "approval" ? "Draft for me" : "Send it"}
                    </Button>
                  ))}
                </div>
                <p className="text-[11px] text-muted-foreground">
                  When a visitor gives an email and then leaves without booking, write them one follow-up referencing what they actually said.
                  {" "}<b>Draft for me</b> puts it in your tasks to review; <b>Send it</b> sends unattended.
                  {" "}Only conversations from the last 7 days are ever followed up, and never more than once.
                </p>
                {form.followUpMode !== "off" && (
                  <Field label="Wait this long after their last message">
                    <div className="flex items-center gap-2">
                      <Input
                        type="number" min={5} max={1440} className="h-9 w-28"
                        value={form.followUpDelayMin ?? 45}
                        onChange={(e) => patch("followUpDelayMin", Number(e.target.value) || 45)}
                        onBlur={() => setField("followUpDelayMin", Math.min(1440, Math.max(5, Number(form.followUpDelayMin) || 45)))}
                      />
                      <span className="text-[12px] text-muted-foreground">minutes</span>
                    </div>
                  </Field>
                )}
              </Section>

              {/* What it is allowed to know (0136) */}
              <KnowledgeSection agentId={form.id} accent={accent} />

              {/* Persona */}
              <Section title="Persona">
                <Field label="Agent name (shown to visitors)"><Input value={form.displayName ?? ""} onChange={(e) => patch("displayName", e.target.value)} /></Field>
                <Field label="Opening message"><Textarea rows={2} value={form.greeting ?? ""} onChange={(e) => patch("greeting", e.target.value)} /></Field>
                <Field label="Extra instructions (optional)">
                  <Textarea rows={4} value={form.persona ?? ""} onChange={(e) => patch("persona", e.target.value)}
                    placeholder="e.g. We only work with nonprofits over 50 staff. Never quote prices — say pricing depends on scope." />
                  <p className="text-[11px] text-muted-foreground">Layered on top of your brand voice and company profile, which the agent already knows.</p>
                </Field>
                <Field label="Accent color">
                  <div className="flex items-center gap-2">
                    <input type="color" value={form.themeColor ?? "#14B89A"} onChange={(e) => patch("themeColor", e.target.value)} className="h-9 w-14 rounded border" />
                    <Input value={form.themeColor ?? ""} onChange={(e) => patch("themeColor", e.target.value)} className="w-32" />
                  </div>
                </Field>
              </Section>

              {/* Qualification */}
              <Section title="Qualification" tourId="chat-qualification">
                <Field label="Questions the agent should work in">
                  <div className="space-y-2">
                    {(form.qualifyingQuestions as string[]).map((q, i) => (
                      <div key={i} className="flex items-center gap-2">
                        <Input value={q} onChange={(e) => { const n = [...form.qualifyingQuestions]; n[i] = e.target.value; patch("qualifyingQuestions", n); }} />
                        <Button variant="ghost" size="icon" className="size-8 shrink-0 text-muted-foreground"
                          onClick={() => patch("qualifyingQuestions", form.qualifyingQuestions.filter((_: string, j: number) => j !== i))}>
                          <Trash2 className="size-4" />
                        </Button>
                      </div>
                    ))}
                    {(form.qualifyingQuestions as string[]).length < 8 && (
                      <Button variant="outline" size="sm" className="gap-1" onClick={() => patch("qualifyingQuestions", [...form.qualifyingQuestions, ""])}><Plus className="size-3.5" /> Add question</Button>
                    )}
                  </div>
                </Field>
                <Field label={`Qualified at score ${form.qualifyThreshold ?? 60} and above`}>
                  <input type="range" min={0} max={100} step={5} value={form.qualifyThreshold ?? 60}
                    onChange={(e) => patch("qualifyThreshold", Number(e.target.value))} className="w-full" />
                  <p className="text-[11px] text-muted-foreground">Lower captures more meetings and more noise. A visitor who explicitly asks for a meeting is offered one from 40 regardless.</p>
                </Field>
              </Section>

              {/* Outcomes */}
              <Section title="What happens to a visitor">
                <div className="flex items-center justify-between">
                  <Label className="text-sm">Create a lead once we have an email</Label>
                  <Switch checked={!!form.autoCreateLead} onCheckedChange={(v) => patch("autoCreateLead", v)} />
                </div>
                <div className="flex items-center justify-between">
                  <Label className="text-sm">Auto-route to an owner</Label>
                  <Switch checked={!!form.autoRoute} onCheckedChange={(v) => patch("autoRoute", v)} />
                </div>
                <Field label="Auto-enroll captured leads into a sequence">
                  <select className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                    value={form.autoEnrollSequenceId ?? ""}
                    onChange={(e) => patch("autoEnrollSequenceId", e.target.value ? Number(e.target.value) : null)}>
                    <option value="">None — capture only</option>
                    {sequences.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                </Field>
              </Section>

              {/* Transcripts */}
              <Section title={`Conversations${sessions.length ? ` (${sessions.length})` : ""}`}>
                {sessionsQ.isLoading ? (
                  <p className="text-xs text-muted-foreground">Loading…</p>
                ) : sessions.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No conversations yet. Publish the agent and install it to start capturing.</p>
                ) : (
                  <div className="rounded-lg border divide-y divide-border/60">
                    {sessions.map((s) => {
                      const msgs = Array.isArray(s.messages) ? (s.messages as Array<{ role: string; text: string }>) : [];
                      const open = openSession === s.id;
                      return (
                        <div key={s.id}>
                          <button className="w-full text-left px-3 py-2 hover:bg-muted/50" onClick={() => setOpenSession(open ? null : s.id)}>
                            <div className="flex items-center gap-2 text-[13px]">
                              <span className="font-medium truncate">{s.visitorName || s.visitorEmail || "Anonymous visitor"}</span>
                              {s.visitorCompany && <span className="text-muted-foreground truncate hidden sm:inline">· {s.visitorCompany}</span>}
                              <span className="flex-1" />
                              {s.meetingId ? (
                                <span className="text-[9px] px-1.5 py-0.5 rounded-full font-medium bg-emerald-100 text-emerald-700">booked</span>
                              ) : s.status === "qualified" ? (
                                <span className="text-[9px] px-1.5 py-0.5 rounded-full font-medium bg-amber-100 text-amber-700">qualified</span>
                              ) : null}
                              <span className="text-[11px] text-muted-foreground shrink-0">{s.score}</span>
                            </div>
                            {s.aiSummary && <p className="text-[11px] text-muted-foreground mt-0.5 truncate">{s.aiSummary}</p>}
                          </button>
                          {open && (
                            <div className="px-3 pb-3 space-y-1.5 bg-muted/20">
                              {msgs.map((m, i) => (
                                <div key={i} className="text-[12px]">
                                  <span className="font-medium">{m.role === "visitor" ? "Visitor" : form.displayName}:</span>{" "}
                                  <span className="text-muted-foreground">{m.text}</span>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </Section>

              <div className="flex items-center justify-between pt-2 border-t">
                <Button variant="ghost" size="sm" className="text-rose-600 gap-1"
                  onClick={() => confirmAction(
                    { title: "Delete this chat agent?", description: "The agent, its public URL and all of its conversation transcripts will be permanently deleted. Leads and meetings it created are kept.", confirmLabel: "Delete" },
                    () => { remove.mutate({ id: form.id }); },
                  )}>
                  <Trash2 className="size-4" /> Delete agent
                </Button>
                <Button size="sm" disabled={update.isPending} onClick={save} style={{ backgroundColor: accent }} className="text-white">Save changes</Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </Shell>
  );
}

/**
 * The chat's funnel. Every stage is a strict subset of the one above, which is
 * what makes a drop-off meaningful.
 *
 * Rates are shown against the RIGHT denominator, not the flattering one: email
 * capture is measured against engaged sessions (a visitor who typed nothing
 * never had the chance), and booking against qualified (the agent is not
 * supposed to book unqualified traffic). Under 20 sessions everything renders
 * muted with an asterisk — the house rule for thin data.
 */
function FunnelSection() {
  const f = trpc.chatAgents.funnel.useQuery(undefined, { staleTime: 60_000 });
  const d = f.data as any;
  if (!d) return null;

  const thin = d.sessions < 20;
  const stages = [
    { label: "Conversations", value: d.sessions, rate: null as number | null },
    { label: "Actually talked", value: d.engaged, rate: d.engagedRate },
    { label: "Gave an email", value: d.emailCaptured, rate: d.emailRate },
    { label: "Qualified", value: d.qualified, rate: d.qualifiedRate },
    { label: "Booked", value: d.meetings, rate: d.meetingRate },
  ];

  return (
    <Section title="How it's doing" tourId="chat-funnel">
      {d.sessions === 0 ? (
        <p className="text-[12px] text-muted-foreground italic">
          No conversations yet. Nothing here will mean anything until visitors reach the widget.
        </p>
      ) : (
        <>
          <div className="rounded-lg border bg-card divide-y">
            {stages.map((s) => (
              <div key={s.label} className="flex items-center justify-between px-3 py-2">
                <span className="text-[13px]">{s.label}</span>
                <span className="flex items-baseline gap-2">
                  <span className="text-[13px] font-semibold tabular-nums">{s.value}</span>
                  {s.rate !== null && (
                    <span className={`text-[11px] tabular-nums ${thin ? "text-muted-foreground/60" : "text-muted-foreground"}`}>
                      {s.rate}%{thin ? "*" : ""}
                    </span>
                  )}
                </span>
              </div>
            ))}
          </div>
          <p className="text-[11px] text-muted-foreground">
            {d.biggestDropStage !== "none" && (
              <>Biggest drop-off: <b>{d.biggestDropStage}</b> ({d.biggestDropCount} lost).{" "}</>
            )}
            {d.emailCaptured > 0 && <>Median messages before an email: <b>{d.medianMessagesToEmail}</b>.{" "}</>}
            {d.followUpsActioned > 0 && <>{d.followUpsActioned} abandoned {d.followUpsActioned === 1 ? "conversation" : "conversations"} followed up.</>}
          </p>
          {thin && (
            <p className="text-[11px] text-muted-foreground/70">
              * Under 20 conversations these rates are noise, not signal. Shown so you can watch them move, not to act on.
            </p>
          )}
        </>
      )}
    </Section>
  );
}

/**
 * The facts the agent may answer from (migration 0136).
 *
 * This exists because of what the live agent did without it: asked anything its
 * persona didn't cover, it invented — including a client claim and a savings
 * figure its own persona forbade. The claim scrubber stops it SAYING that;
 * these entries are what let it answer instead of just refusing.
 */
function KnowledgeSection({ agentId, accent }: { agentId: number; accent: string }) {
  const utils = trpc.useUtils();
  const list = trpc.chatAgents.knowledge.useQuery({ agentId }, { enabled: !!agentId });
  const save = trpc.chatAgents.knowledgeSave.useMutation({
    onSuccess: () => { utils.chatAgents.knowledge.invalidate(); setDraft(null); toast.success("Saved"); },
    onError: (e: any) => toast.error(e?.message ?? "Failed"),
  });
  const remove = trpc.chatAgents.knowledgeRemove.useMutation({
    onSuccess: () => { utils.chatAgents.knowledge.invalidate(); toast.success("Removed"); },
    onError: (e: any) => toast.error(e?.message ?? "Failed"),
  });

  const [draft, setDraft] = useState<{ id?: number; title: string; body: string } | null>(null);
  const rows = (list.data as any[]) ?? [];

  return (
    <Section title="What it knows" tourId="chat-knowledge">
      <p className="text-[11px] text-muted-foreground">
        The only specifics the agent may state. Anything not written here it will say it doesn't know, rather than guess — that is deliberate.
      </p>

      <div className="space-y-2">
        {rows.length === 0 && !draft && (
          <p className="text-[12px] text-muted-foreground italic">
            Nothing yet. Without facts the agent can only talk in generalities.
          </p>
        )}
        {rows.map((r) => (
          <div key={r.id} className="rounded-lg border bg-card p-3 space-y-1">
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-medium">{r.title}</div>
                <div className="text-[12px] text-muted-foreground whitespace-pre-wrap">{r.body}</div>
              </div>
              <Button variant="ghost" size="sm" className="h-7 shrink-0"
                onClick={() => setDraft({ id: r.id, title: r.title, body: r.body })}>Edit</Button>
              <Button variant="ghost" size="sm" className="h-7 shrink-0 text-rose-600"
                onClick={() => confirmAction(
                  { title: "Remove this fact?", description: "The agent will stop being able to answer questions about it.", confirmLabel: "Remove", destructive: true },
                  () => remove.mutate({ id: r.id }),
                )}>Remove</Button>
            </div>
          </div>
        ))}
      </div>

      {draft ? (
        <div className="rounded-lg border bg-muted/40 p-3 space-y-2">
          <Field label="Question or topic">
            <Input value={draft.title} placeholder="What happens on the audit call?"
              onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
          </Field>
          <Field label="Answer — in the agent's own words">
            <Textarea rows={3} value={draft.body} placeholder="We walk through your current process and map what is automatable. No commitment."
              onChange={(e) => setDraft({ ...draft, body: e.target.value })} />
          </Field>
          <div className="flex gap-2">
            <Button size="sm" className="h-8 text-white" style={{ backgroundColor: accent }}
              disabled={!draft.title.trim() || !draft.body.trim() || save.isPending}
              onClick={() => save.mutate({ id: draft.id, agentId, title: draft.title.trim(), body: draft.body.trim(), sortOrder: rows.length })}>
              Save
            </Button>
            <Button size="sm" variant="ghost" className="h-8" onClick={() => setDraft(null)}>Cancel</Button>
          </div>
        </div>
      ) : (
        <Button size="sm" variant="outline" className="h-8" onClick={() => setDraft({ title: "", body: "" })}>
          Add a fact
        </Button>
      )}
    </Section>
  );
}

function Section({ title, children, tourId }: { title: string; children: React.ReactNode; tourId?: string }) {
  return (
    <div className="space-y-3" data-tour-id={tourId}>
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h3>
      {children}
    </div>
  );
}
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-[13px]">{label}</Label>
      {children}
    </div>
  );
}
