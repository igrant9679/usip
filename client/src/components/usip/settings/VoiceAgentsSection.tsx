/**
 * VoiceAgentsSection — Settings → Voice agents (internal SettingsHub subpage).
 *
 * Grok (xAI) voice agents: workspace xAI connection (BYOK key + voice model +
 * live test against GET /v1/tts/voices), the call-back webhook URL to register
 * numbers against in the xAI console, agent CRUD (admins manage everything;
 * each member may create/edit their own call-back agent that answers on their
 * behalf), and a recent-calls readout from voice_calls.
 *
 * Honest boundaries surfaced in the UI: outbound dialing is NOT offered yet
 * (xAI hasn't published the outbound-call endpoint); inbound call-backs are
 * live end-to-end (webhook → answer bridge).
 */
import { useMemo, useState } from "react";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  AudioLines,
  Copy,
  Loader2,
  Pencil,
  PhoneIncoming,
  PhoneOutgoing,
  Plus,
  ShieldCheck,
  Trash2,
} from "lucide-react";

type Agent = Record<string, any>;

const MODELS = ["grok-voice-latest", "grok-voice-think-fast-1.0"];

const CALL_STATUS_TONE: Record<string, string> = {
  completed: "text-emerald-600 dark:text-emerald-400",
  in_progress: "text-sky-600 dark:text-sky-400",
  ringing: "text-sky-600 dark:text-sky-400",
  failed: "text-rose-600 dark:text-rose-400",
  no_answer: "text-amber-600 dark:text-amber-400",
  queued: "text-muted-foreground",
};

function Card({ title, sub, children }: { title: string; sub?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-border/70 bg-card p-5 shadow-sm space-y-4">
      <div>
        <h2 className="text-[15px] font-semibold">{title}</h2>
        {sub && <p className="mt-0.5 text-[12.5px] text-muted-foreground">{sub}</p>}
      </div>
      {children}
    </section>
  );
}

export function VoiceAgentsSection() {
  const utils = trpc.useUtils();
  const me = trpc.profile.getMe.useQuery();
  const isAdmin = me.data?.role === "admin" || me.data?.role === "super_admin";

  const settings = trpc.voiceAgents.getSettings.useQuery();
  const agents = trpc.voiceAgents.list.useQuery();
  const voices = trpc.voiceAgents.listVoices.useQuery();
  const calls = trpc.voiceAgents.listCalls.useQuery({ limit: 10 });
  const team = trpc.team.list.useQuery(undefined, { enabled: isAdmin });

  const [dialog, setDialog] = useState<{ open: boolean; agent?: Agent | null }>({ open: false });

  const webhookUrl = `${window.location.origin}/api/voice/xai/webhook`;

  return (
    <>
      <div className="shrink-0 px-6 pt-4">
        <h1 className="text-xl font-semibold tracking-tight">Voice agents</h1>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto bg-muted/40 mt-3 border-t border-border">
        <div className="mx-auto w-full max-w-4xl space-y-5 px-4 py-6 sm:px-6">
          <ConnectionCard
            isAdmin={isAdmin}
            configured={settings.data?.configured ?? false}
            masked={settings.data?.masked ?? ""}
            model={settings.data?.model ?? MODELS[0]}
          />

          <Card
            title="Call-back webhook"
            sub="Register your phone number in the xAI console (or via their API) with this webhook URL. When a prospect calls back, the matching agent below answers on the member's behalf."
          >
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded-md border border-border bg-muted/60 px-3 py-2 text-[12.5px]">
                {webhookUrl}
              </code>
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5 shrink-0"
                onClick={() => { void navigator.clipboard.writeText(webhookUrl); toast.success("Webhook URL copied"); }}
              >
                <Copy className="size-3.5" /> Copy
              </Button>
            </div>
            <p className="text-[12px] text-muted-foreground">
              Paste the signing secret xAI shows you (once) into the agent's "Webhook signing secret" field —
              it verifies each call and routes it to the right agent. SIP destination:{" "}
              <code className="rounded bg-muted px-1 py-0.5">{"sip:{number}@sip.voice.x.ai;transport=tls"}</code>
            </p>
          </Card>

          <Card
            title="Agents"
            sub="Outreach agents place automated calls (dialing activates once xAI publishes its outbound-call API). Call-back agents answer inbound calls on behalf of a team member."
          >
            <div className="flex justify-end -mt-2">
              <Button size="sm" className="gap-1.5" onClick={() => setDialog({ open: true, agent: null })}>
                <Plus className="size-3.5" /> New agent
              </Button>
            </div>
            {agents.isLoading ? (
              <div className="h-24 animate-pulse rounded-lg bg-muted/60" />
            ) : (agents.data ?? []).length === 0 ? (
              <div className="rounded-lg border border-dashed border-border px-4 py-10 text-center">
                <AudioLines className="mx-auto size-8 text-muted-foreground/60" />
                <div className="mt-2 text-[13.5px] font-semibold">No voice agents yet</div>
                <p className="mx-auto mt-1 max-w-sm text-[12.5px] text-muted-foreground">
                  Create an agent, register its phone number with the webhook above, and call-backs get
                  answered automatically.
                </p>
              </div>
            ) : (
              <div className="divide-y divide-border/60 rounded-lg border border-border/70">
                {(agents.data as Agent[]).map((a) => (
                  <AgentRow
                    key={a.id}
                    a={a}
                    canManage={!!a.canManage}
                    onEdit={() => setDialog({ open: true, agent: a })}
                  />
                ))}
              </div>
            )}
          </Card>

          {(calls.data ?? []).length > 0 && (
            <Card title="Recent calls" sub="The full log lives on the Calls page.">
              <div className="divide-y divide-border/60 rounded-lg border border-border/70 text-[13px]">
                {(calls.data as Record<string, any>[]).map((c) => (
                  <div key={c.id} className="flex items-center gap-3 px-3 py-2">
                    {c.direction === "inbound"
                      ? <PhoneIncoming className="size-4 shrink-0 text-sky-600" />
                      : <PhoneOutgoing className="size-4 shrink-0 text-muted-foreground" />}
                    <span className="min-w-0 flex-1 truncate">
                      <span className="font-medium">{c.agentName}</span>
                      <span className="text-muted-foreground"> · {c.fromNumber ?? "unknown"} → {c.toNumber ?? "—"}</span>
                    </span>
                    <span className={cn("shrink-0 text-[12px] font-medium capitalize", CALL_STATUS_TONE[c.status] ?? "text-muted-foreground")}>
                      {String(c.status).replace("_", " ")}
                    </span>
                    <span className="shrink-0 w-14 text-right text-[12px] tabular-nums text-muted-foreground">
                      {c.durationSec != null ? `${Math.floor(c.durationSec / 60)}:${String(c.durationSec % 60).padStart(2, "0")}` : "—"}
                    </span>
                    <span className="shrink-0 w-28 text-right text-[11.5px] text-muted-foreground">
                      {c.createdAt ? new Date(c.createdAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : ""}
                    </span>
                  </div>
                ))}
              </div>
            </Card>
          )}
        </div>
      </div>

      {/* key remounts the dialog per open/agent so the form re-seeds cleanly */}
      <AgentDialog
        key={`${dialog.agent?.id ?? "new"}-${dialog.open}`}
        open={dialog.open}
        agent={dialog.agent ?? null}
        isAdmin={isAdmin}
        voices={(voices.data?.voices as string[] | undefined) ?? ["eve", "ara", "rex", "sal", "leo"]}
        defaultModel={settings.data?.model ?? MODELS[0]}
        team={(team.data as Record<string, any>[] | undefined) ?? []}
        onClose={() => { setDialog({ open: false }); utils.voiceAgents.list.invalidate(); }}
      />
    </>
  );
}

/* ─────────────────────── xAI connection card ──────────────────────────── */

function ConnectionCard({
  isAdmin, configured, masked, model,
}: {
  isAdmin: boolean; configured: boolean; masked: string; model: string;
}) {
  const utils = trpc.useUtils();
  const [key, setKey] = useState("");
  const [modelSel, setModelSel] = useState<string | null>(null);
  const effectiveModel = modelSel ?? model;

  const save = trpc.voiceAgents.saveSettings.useMutation({
    onSuccess: () => { utils.voiceAgents.getSettings.invalidate(); utils.voiceAgents.listVoices.invalidate(); setKey(""); toast.success("Saved"); },
    onError: (e: any) => toast.error(e?.message ?? "Could not save"),
  });
  const test = trpc.voiceAgents.testKey.useMutation({
    onSuccess: (r: any) => toast.success(`Key verified — ${r.voiceCount} voices available (${r.latencyMs}ms)`),
    onError: (e: any) => toast.error(e?.message ?? "Key test failed"),
  });

  return (
    <Card
      title="xAI connection"
      sub="Your workspace's xAI API key powers all voice agents. Stored encrypted; get a key at console.x.ai. Voice usage is billed by xAI at their per-minute rate."
    >
      <div className="flex items-center gap-2 text-[13px]">
        <ShieldCheck className={cn("size-4", configured ? "text-emerald-600" : "text-muted-foreground")} />
        {configured ? (
          <span>Connected <span className="text-muted-foreground">· key {masked}</span></span>
        ) : (
          <span className="text-muted-foreground">Not connected — add your xAI API key to activate agents.</span>
        )}
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_220px]">
        <div className="space-y-1.5">
          <Label>xAI API key</Label>
          <Input
            type="password"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder={configured ? "Enter a new key to replace the saved one" : "xai-…"}
            disabled={!isAdmin}
            autoComplete="off"
          />
        </div>
        <div className="space-y-1.5">
          <Label>Voice model</Label>
          <select
            value={effectiveModel}
            onChange={(e) => setModelSel(e.target.value)}
            disabled={!isAdmin}
            className="h-9 w-full rounded-md border border-border bg-background px-2.5 text-[13px]"
          >
            {MODELS.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </div>
      </div>

      {isAdmin ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            disabled={save.isPending || (!key.trim() && effectiveModel === model)}
            onClick={() => save.mutate({ ...(key.trim() ? { apiKey: key.trim() } : {}), model: effectiveModel })}
            className="gap-1.5"
          >
            {save.isPending ? <Loader2 className="size-3.5 animate-spin" /> : null} Save
          </Button>
          <Button variant="outline" size="sm" disabled={!configured || test.isPending} onClick={() => test.mutate()} className="gap-1.5">
            {test.isPending ? <Loader2 className="size-3.5 animate-spin" /> : null} Test connection
          </Button>
          {configured && (
            <Button
              variant="outline"
              size="sm"
              disabled={save.isPending}
              onClick={() => { if (confirm("Remove the saved xAI API key? Agents stop answering until a new key is added.")) save.mutate({ apiKey: "" }); }}
              className="text-rose-600 hover:text-rose-600"
            >
              Remove key
            </Button>
          )}
        </div>
      ) : (
        <p className="text-[12px] text-muted-foreground">Only workspace admins can change the xAI connection.</p>
      )}
    </Card>
  );
}

/* ────────────────────────────── agent row ─────────────────────────────── */

function AgentRow({ a, canManage, onEdit }: { a: Agent; canManage: boolean; onEdit: () => void }) {
  const utils = trpc.useUtils();
  const update = trpc.voiceAgents.update.useMutation({
    onSuccess: () => utils.voiceAgents.list.invalidate(),
    onError: (e: any) => toast.error(e?.message ?? "Could not update"),
  });
  const remove = trpc.voiceAgents.remove.useMutation({
    onSuccess: () => { utils.voiceAgents.list.invalidate(); toast.success(`${a.name} deleted`); },
    onError: (e: any) => toast.error(e?.message ?? "Could not delete"),
  });
  const isCallback = a.purpose === "callback_receptionist";
  return (
    <div className="flex items-center gap-3 px-3.5 py-3">
      <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-lg", isCallback ? "bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300" : "bg-secondary text-muted-foreground")}>
        {isCallback ? <PhoneIncoming className="size-4" /> : <PhoneOutgoing className="size-4" />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-[13.5px] font-semibold">{a.name}</span>
          <span className="rounded-full bg-secondary px-2 py-0.5 text-[10.5px] font-medium text-muted-foreground capitalize">{a.voice}</span>
          {a.hasWebhookSecret && <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10.5px] font-medium text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300">Webhook verified</span>}
        </div>
        <div className="truncate text-[12px] text-muted-foreground">
          {isCallback ? `Call-back agent${a.owner?.name ? ` · answers for ${a.owner.name}` : ""}` : "Outreach agent"}
          {a.phoneNumber ? ` · ${a.phoneNumber}` : " · no number registered"}
        </div>
      </div>
      <label className="flex shrink-0 items-center gap-1.5 text-[12px] text-muted-foreground" title={canManage ? undefined : "You can only manage your own call-back agent"}>
        <Switch
          checked={a.status === "active"}
          disabled={!canManage || update.isPending}
          onCheckedChange={(v) => update.mutate({ id: a.id, status: v ? "active" : "paused" })}
        />
        {a.status === "active" ? "Active" : "Paused"}
      </label>
      <button
        type="button"
        disabled={!canManage}
        onClick={onEdit}
        aria-label={`Edit ${a.name}`}
        className="shrink-0 rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
      >
        <Pencil className="size-4" />
      </button>
      <button
        type="button"
        disabled={!canManage || remove.isPending}
        onClick={() => { if (confirm(`Delete ${a.name}? Its call history is kept.`)) remove.mutate({ id: a.id }); }}
        aria-label={`Delete ${a.name}`}
        className="shrink-0 rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-rose-600 disabled:opacity-40"
      >
        <Trash2 className="size-4" />
      </button>
    </div>
  );
}

/* ───────────────────────── create / edit dialog ───────────────────────── */

function AgentDialog({
  open, agent, isAdmin, voices, defaultModel, team, onClose,
}: {
  open: boolean;
  agent: Agent | null;
  isAdmin: boolean;
  voices: string[];
  defaultModel: string;
  team: Record<string, any>[];
  onClose: () => void;
}) {
  const [f, setF] = useState(() => ({
    name: agent?.name ?? "",
    purpose: (agent?.purpose ?? (isAdmin ? "outbound_outreach" : "callback_receptionist")) as string,
    ownerUserId: (agent?.ownerUserId ?? null) as number | null,
    voice: agent?.voice ?? "eve",
    model: agent?.model ?? defaultModel,
    instructions: agent?.instructions ?? "",
    phoneNumber: agent?.phoneNumber ?? "",
    secret: "",
    languageHint: agent?.languageHint ?? "",
  }));
  const set = (k: string, v: unknown) => setF((p) => ({ ...p, [k]: v }));

  const create = trpc.voiceAgents.create.useMutation({ onError: (e: any) => toast.error(e?.message ?? "Could not create agent") });
  const update = trpc.voiceAgents.update.useMutation({ onError: (e: any) => toast.error(e?.message ?? "Could not save agent") });
  const saving = create.isPending || update.isPending;

  const activeMembers = useMemo(
    () => team.filter((m) => !m.deactivatedAt && m.userId != null),
    [team],
  );

  const submit = async () => {
    if (!f.name.trim()) { toast.error("Give the agent a name"); return; }
    const payload = {
      name: f.name.trim(),
      purpose: f.purpose as "outbound_outreach" | "callback_receptionist",
      // Non-admins omit ownerUserId — the server pins their callback agent to
      // themselves; admins pick explicitly (null = shared outreach agent).
      ...(isAdmin ? { ownerUserId: f.purpose === "callback_receptionist" ? f.ownerUserId : null } : {}),
      voice: f.voice,
      model: f.model.trim() || defaultModel,
      instructions: f.instructions.trim() || null,
      phoneNumber: f.phoneNumber.trim() || null,
      ...(f.secret.trim() ? { sipWebhookSecret: f.secret.trim() } : {}),
      languageHint: f.languageHint.trim() || null,
    };
    if (agent) await update.mutateAsync({ id: agent.id, ...payload });
    else await create.mutateAsync({ ...payload, status: "active" });
    toast.success(agent ? "Agent saved" : "Agent created");
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{agent ? `Edit ${agent.name}` : "New voice agent"}</DialogTitle>
          <DialogDescription>
            {isAdmin
              ? "Configure the persona and, for call-back agents, which member it answers for."
              : "Your call-back agent answers inbound calls on your behalf and takes a message."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3.5">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Name</Label>
              <Input value={f.name} onChange={(e) => set("name", e.target.value)} placeholder="e.g. Velocity Receptionist" autoFocus />
            </div>
            <div className="space-y-1.5">
              <Label>Purpose</Label>
              <select
                value={f.purpose}
                onChange={(e) => set("purpose", e.target.value)}
                disabled={!isAdmin}
                className="h-9 w-full rounded-md border border-border bg-background px-2.5 text-[13px]"
              >
                <option value="outbound_outreach">Outreach (places calls)</option>
                <option value="callback_receptionist">Call-back (answers for a member)</option>
              </select>
            </div>
          </div>

          {f.purpose === "callback_receptionist" && (
            <div className="space-y-1.5">
              <Label>Answers on behalf of</Label>
              {isAdmin ? (
                <select
                  value={f.ownerUserId ?? ""}
                  onChange={(e) => set("ownerUserId", e.target.value ? Number(e.target.value) : null)}
                  className="h-9 w-full rounded-md border border-border bg-background px-2.5 text-[13px]"
                >
                  <option value="">Me</option>
                  {activeMembers.map((m) => (
                    <option key={m.userId} value={m.userId}>{m.name || m.email}</option>
                  ))}
                </select>
              ) : (
                <div className="rounded-md border border-border bg-muted/50 px-3 py-2 text-[13px] text-muted-foreground">You</div>
              )}
            </div>
          )}

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label>Voice</Label>
              <select value={f.voice} onChange={(e) => set("voice", e.target.value)} className="h-9 w-full rounded-md border border-border bg-background px-2.5 text-[13px] capitalize">
                {[...new Set([f.voice, ...voices])].map((v) => <option key={v} value={v}>{v}</option>)}
              </select>
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label>Model</Label>
              <select value={f.model} onChange={(e) => set("model", e.target.value)} className="h-9 w-full rounded-md border border-border bg-background px-2.5 text-[13px]">
                {[...new Set([f.model, ...MODELS])].map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Instructions <span className="font-normal text-muted-foreground">(optional — a professional receptionist script is used when empty)</span></Label>
            <textarea
              value={f.instructions}
              onChange={(e) => set("instructions", e.target.value)}
              rows={4}
              placeholder={"You are Ava, answering for Idris at Velocity. Greet the caller, find out what they need, take a detailed message with contact details…"}
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-[13px] outline-none focus:ring-2 focus:ring-ring"
            />
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Phone number</Label>
              <Input value={f.phoneNumber} onChange={(e) => set("phoneNumber", e.target.value)} placeholder="+1 555 0100" />
              <p className="text-[11.5px] text-muted-foreground">The number registered with xAI that reaches this agent.</p>
            </div>
            <div className="space-y-1.5">
              <Label>Webhook signing secret</Label>
              <Input
                type="password"
                value={f.secret}
                onChange={(e) => set("secret", e.target.value)}
                placeholder={agent?.hasWebhookSecret ? "Saved — enter to replace" : "whsec_…"}
                autoComplete="off"
              />
              <p className="text-[11.5px] text-muted-foreground">Shown once by xAI when the number is registered.</p>
            </div>
          </div>

          <div className="space-y-1.5 sm:w-1/2">
            <Label>Language hint <span className="font-normal text-muted-foreground">(optional)</span></Label>
            <Input value={f.languageHint} onChange={(e) => set("languageHint", e.target.value)} placeholder="en" />
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" size="sm" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button size="sm" onClick={submit} disabled={saving} className="gap-1.5">
            {saving ? <Loader2 className="size-3.5 animate-spin" /> : null} {agent ? "Save agent" : "Create agent"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
