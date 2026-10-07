/**
 * VoiceAgentsSection — Settings → Voice agents (internal SettingsHub subpage).
 *
 * Grok (xAI) voice agents: workspace xAI connection (BYOK key + voice model +
 * live test against GET /v1/tts/voices), the call-back webhook URL to register
 * numbers against in the xAI console, agent CRUD (admins manage everything;
 * each member may create/edit their own call-back agent that answers on their
 * behalf), and a recent-calls readout from voice_calls.
 *
 * Plivo (owner 2026-10-04): xAI cannot dial out, so outbound AI calls go
 * through the workspace's Plivo account. The Plivo card holds its keys; an
 * agent given a Plivo number places approved calls from it and answers calls
 * to it. The xAI call-back webhook stays for numbers registered in xAI's own
 * console.
 */
import { useMemo, useState } from "react";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { confirmAction } from "@/components/usip/Common";
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
  PhoneCall,
  Plus,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";
import { isAdminRole } from "@shared/roleRank";
import { formatPhone } from "@shared/phoneFormat";
import {
  agentNumbers,
  DEFAULT_VOICE_LIMITS,
  MAX_CALLS_PER_NUMBER_PER_DAY,
  MAX_NUMBERS_PER_AGENT,
  VOICE_LIMIT_CEILINGS,
  type VoiceLimits,
} from "@shared/voiceCapacity";

type Agent = Record<string, any>;

// Think Fast 2.0 first (owner 2026-10-04); grok-voice-latest is an alias xAI can move.
const MODELS = ["grok-voice-think-fast-2.0", "grok-voice-latest"];

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
  const isAdmin = isAdminRole(me.data?.role);

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

          <PlivoCard isAdmin={isAdmin} />

          <AiCallsSwitchCard isAdmin={isAdmin} />

          <CallingCapacityCard isAdmin={isAdmin} agents={(agents.data as Agent[] | undefined) ?? []} />

          <Card
            title="xAI phone number (optional)"
            sub="Only for a number registered in xAI's own console. Plivo numbers need none of this: connect them above and pick one on the agent."
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
            sub="Outreach agents place AI calls from their Plivo numbers, each one approved by a manager first (queue people from People → Queue AI call). Call-back agents answer calls on behalf of a team member. Any agent answers calls to its numbers."
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
                  Create an agent and give it a Plivo number. Outreach agents call the people you approve;
                  any agent answers calls to its number.
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
                      <span className="text-muted-foreground"> · {formatPhone(c.fromNumber) || "unknown"} → {formatPhone(c.toNumber) || "—"}</span>
                      {c.testedByUserId ? <span className="ml-1.5 rounded bg-secondary px-1.5 py-0.5 text-[10.5px] font-medium text-muted-foreground">Test</span> : null}
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
              onClick={() => { confirmAction({ title: "Remove the saved xAI API key?", description: "Agents stop answering until a new key is added.", confirmLabel: "Remove" }, () => { save.mutate({ apiKey: "" }); }); }}
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
  const me = trpc.profile.getMe.useQuery();
  const isAdminAgent = isAdminRole(me.data?.role);
  const [testing, setTesting] = useState(false);
  const numbers = agentNumbers(a);
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
          {/* No secret, no calls (security audit 2026-10-04): unsigned webhooks are rejected. */}
          {!a.hasWebhookSecret && a.phoneNumber && <span title="Calls to this number are rejected until you add the webhook signing secret xAI gave you." className="rounded-full bg-amber-100 px-2 py-0.5 text-[10.5px] font-medium text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">No signing secret: calls rejected</span>}
        </div>
        <div className="truncate text-[12px] text-muted-foreground">
          {isCallback ? `Call-back agent${a.owner?.name ? ` · answers for ${a.owner.name}` : ""}` : "Outreach agent"}
          {numbers.length ? ` · ${formatPhone(numbers[0])}${numbers.length > 1 ? ` + ${numbers.length - 1} more` : ""} (Plivo)` : ""}
          {a.phoneNumber ? ` · ${formatPhone(a.phoneNumber)} (xAI)` : ""}
          {!numbers.length && !a.phoneNumber ? " · no number yet" : ""}
        </div>
      </div>
      {isAdminAgent && !isCallback && a.plivoNumber && a.status === "active" && (
        <Button variant="outline" size="sm" className="h-7 gap-1.5 shrink-0" onClick={() => setTesting(true)}>
          <PhoneCall className="size-3.5" /> Test call
        </Button>
      )}
      <TestCallDialog open={testing} agent={a} onClose={() => setTesting(false)} />
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
        onClick={() => { confirmAction({ title: `Delete ${a.name}?`, description: "Its call history is kept.", confirmLabel: "Delete" }, () => { remove.mutate({ id: a.id }); }); }}
        aria-label={`Delete ${a.name}`}
        className="shrink-0 rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-rose-600 disabled:opacity-40"
      >
        <Trash2 className="size-4" />
      </button>
    </div>
  );
}

/* ───────────────────────── Plivo connection ───────────────────────────── */

/**
 * The workspace's Plivo account (owner 2026-10-04): it places the agents'
 * approved AI calls and answers calls to their numbers. The owner pastes
 * his own Auth ID and Auth Token; the token is stored encrypted.
 */
function PlivoCard({ isAdmin }: { isAdmin: boolean }) {
  const utils = trpc.useUtils();
  const status = trpc.voiceAgents.plivoStatus.useQuery();
  const [authId, setAuthId] = useState("");
  const [token, setToken] = useState("");
  const refresh = () => {
    void utils.voiceAgents.plivoStatus.invalidate();
    void utils.voiceAgents.plivoNumbers.invalidate();
  };
  const save = trpc.voiceAgents.savePlivo.useMutation({
    onSuccess: () => { toast.success("Plivo connection saved"); setAuthId(""); setToken(""); refresh(); },
    onError: (e: any) => toast.error(e?.message ?? "Could not save"),
  });
  const test = trpc.voiceAgents.testPlivo.useMutation({
    onSuccess: (r) => toast.success(`Connected to ${r.accountName ?? "Plivo"}: ${r.numbers} number${r.numbers === 1 ? "" : "s"}${r.credits ? `, $${r.credits} credit` : ""}`),
    onError: (e: any) => toast.error(e?.message ?? "Plivo rejected the connection"),
  });
  const configured = !!status.data?.configured;
  return (
    <Card
      title="Plivo connection"
      sub="Plivo places your agents' AI calls and answers calls to their numbers. The Auth ID and Auth Token are on the overview page of your Plivo console. The token is stored encrypted."
    >
      <div className="flex items-center gap-2 text-[13px]">
        {configured ? (
          <><ShieldCheck className="size-4 text-emerald-600" /> Connected · Auth ID <code className="text-[12px]">{status.data?.authId}</code></>
        ) : (
          <span className="text-muted-foreground">Not connected</span>
        )}
      </div>
      {isAdmin ? (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Auth ID</Label>
              <Input value={authId} onChange={(e) => setAuthId(e.target.value)} placeholder={status.data?.authId ?? "MA…"} autoComplete="off" />
            </div>
            <div className="space-y-1.5">
              <Label>Auth Token</Label>
              <Input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder={configured ? "Saved: enter a new one to replace it" : "Auth Token"} autoComplete="off" />
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={save.isPending || (!authId.trim() && !token.trim())}
              onClick={() => save.mutate({ ...(authId.trim() ? { authId: authId.trim() } : {}), ...(token.trim() ? { authToken: token.trim() } : {}) })}>
              Save
            </Button>
            <Button size="sm" variant="outline" disabled={!configured || test.isPending} onClick={() => test.mutate()}>
              {test.isPending ? <Loader2 className="size-3.5 animate-spin mr-1" /> : null} Test connection
            </Button>
            {configured && (
              <Button size="sm" variant="outline" className="text-rose-600"
                onClick={() => confirmAction({ title: "Disconnect Plivo?", description: "Approved AI calls stop dialing until it is connected again.", confirmLabel: "Disconnect" }, () => save.mutate({ authId: "", authToken: "" }))}>
                Disconnect
              </Button>
            )}
          </div>
        </>
      ) : (
        <p className="text-[12px] text-muted-foreground">An admin connects Plivo.</p>
      )}
    </Card>
  );
}

/* ───────────────────────── Test call ──────────────────────────────────── */

const TEST_NUMBER_KEY = "usip:voiceTestNumber";

/**
 * Have an outreach agent call you now (owner ask 2026-10-05: "a way to
 * 'Test' a call any time"): outside calling hours, no approval queue. The
 * agent treats you as the person called, so a booking invites you.
 */
function TestCallDialog({ open, agent, onClose }: { open: boolean; agent: Agent; onClose: () => void }) {
  const utils = trpc.useUtils();
  const [number, setNumber] = useState(() => {
    try { return localStorage.getItem(TEST_NUMBER_KEY) ?? ""; } catch { return ""; }
  });
  // Play a person (2026-10-06): their research and history, your phone and email.
  const [personQuery, setPersonQuery] = useState("");
  const [asPerson, setAsPerson] = useState<{ id: number; name: string; company: string | null } | null>(null);
  const people = trpc.prospects.list.useQuery(
    { page: 1, perPage: 10, search: personQuery.trim() } as any,
    { enabled: open && !asPerson && personQuery.trim().length >= 2 },
  );
  const peopleRows = (((people.data as any)?.data ?? []) as any[]);
  // Which of the agent's numbers rings you (several per agent since 2026-10-06).
  const numbers = agentNumbers(agent);
  const [picked, setFrom] = useState<string>(numbers[0] ?? "");
  // The agent's numbers can change while this stays mounted: fall back to the main one.
  const from = numbers.includes(picked) ? picked : (numbers[0] ?? "");
  const call = trpc.aiCalls.testCall.useMutation({
    onSuccess: (r) => {
      try { localStorage.setItem(TEST_NUMBER_KEY, number.trim()); } catch { /* per-browser convenience only */ }
      toast.success(`Calling ${formatPhone(r.to)} now from ${formatPhone(r.from)}`);
      void utils.voiceAgents.listCalls.invalidate();
      onClose();
    },
    onError: (e: any) => toast.error(e?.message ?? "The test call could not be placed"),
  });
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Test call from {agent.name}</DialogTitle>
          <DialogDescription>
            The agent calls this number right away, even outside calling hours, from {formatPhone(from)}. It treats you as the person
            it is calling (your name and email), so if you agree to a meeting it emails you a link to confirm the time; confirming books it on the owner's calendar and invites you.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label>Your phone number</Label>
          <Input value={number} onChange={(e) => setNumber(e.target.value)} placeholder="+1 571 555 0100" autoFocus />
          <p className="text-[11.5px] text-muted-foreground">
            Only call your own phone. On Plivo's free trial, the number must be verified in Plivo first. Up to 10 test calls a day.
          </p>
        </div>
        {numbers.length > 1 && (
          <div className="space-y-1.5">
            <Label>Call from</Label>
            <select value={from} onChange={(e) => setFrom(e.target.value)} className="h-9 w-full rounded-md border border-border bg-background px-2.5 text-[13px]">
              {numbers.map((n, i) => <option key={n} value={n}>{formatPhone(n)}{i === 0 ? " (main)" : ""}</option>)}
            </select>
            <p className="text-[11.5px] text-muted-foreground">Try each number to hear how it shows on your phone.</p>
          </div>
        )}
        <div className="space-y-1.5">
          <Label>Play the part of <span className="font-normal text-muted-foreground">(optional)</span></Label>
          {asPerson ? (
            <div className="flex items-center justify-between rounded-md border border-border px-3 py-2 text-[13px]">
              <span>{asPerson.name}{asPerson.company ? ` · ${asPerson.company}` : ""}</span>
              <button type="button" className="text-[12px] text-muted-foreground hover:text-foreground" onClick={() => setAsPerson(null)}>Change</button>
            </div>
          ) : (
            <>
              <Input value={personQuery} onChange={(e) => setPersonQuery(e.target.value)} placeholder="Search People by name or company" />
              {peopleRows.length > 0 && (
                <div className="max-h-40 overflow-y-auto rounded-md border border-border">
                  {peopleRows.map((p) => (
                    <button key={p.id} type="button" className="block w-full px-3 py-1.5 text-left text-[13px] hover:bg-muted"
                      onClick={() => { setAsPerson({ id: p.id, name: `${p.firstName ?? ""} ${p.lastName ?? ""}`.trim() || `#${p.id}`, company: p.company ?? null }); setPersonQuery(""); }}>
                      {`${p.firstName ?? ""} ${p.lastName ?? ""}`.trim()}<span className="text-muted-foreground">{p.title ? ` · ${p.title}` : ""}{p.company ? ` · ${p.company}` : ""}</span>
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
          <p className="text-[11.5px] text-muted-foreground">
            The agent uses that person's name, role, company, research and history, so you hear the real reason for calling and questions.
            It still rings your phone, invites your email, and writes nothing to their record.
          </p>
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" size="sm" onClick={onClose} disabled={call.isPending}>Cancel</Button>
          <Button size="sm" className="gap-1.5" disabled={!number.trim() || call.isPending} onClick={() => call.mutate({ agentId: agent.id, toNumber: number.trim(), ...(from ? { fromNumber: from } : {}), ...(asPerson ? { asProspectId: asPerson.id } : {}) })}>
            {call.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <PhoneCall className="size-3.5" />} Call me now
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* ───────────────────────── AI calls switch ────────────────────────────── */

/**
 * AI calls' own on/off (owner ask 2026-10-05). Off: approved calls wait
 * instead of dialing; calls to an agent's number are still answered. It is
 * not Pause all outbound, which holds automated email: every AI call was
 * already approved by a person.
 */
function AiCallsSwitchCard({ isAdmin }: { isAdmin: boolean }) {
  const utils = trpc.useUtils();
  const status = trpc.voiceAgents.plivoStatus.useQuery();
  const set = trpc.voiceAgents.setAiCallsPaused.useMutation({
    onSuccess: (r) => { toast.success(r.paused ? "AI calls paused" : "AI calls on"); void utils.voiceAgents.plivoStatus.invalidate(); },
    onError: (e: any) => toast.error(e?.message ?? "Could not change it"),
  });
  const pausedAt = status.data?.aiCallsPausedAt ?? null;
  const on = !pausedAt;
  return (
    <Card title="AI calls" sub="Whether approved AI calls dial. Calls to an agent's number are always answered. This is separate from Pause all outbound (Settings → Send window), which holds email, LinkedIn and invites.">
      <label className={cn("flex items-start gap-3 rounded-md border p-3", on ? "border-border" : "border-amber-300 bg-amber-50 dark:bg-amber-950/30")}>
        <Switch checked={on} disabled={!isAdmin || set.isPending || status.isLoading} aria-label="AI calls on"
          onCheckedChange={(v) => set.mutate({ paused: !v })} />
        <span className="min-w-0">
          <span className={cn("block text-sm font-medium", !on && "text-amber-800 dark:text-amber-300")}>{on ? "AI calls are on" : "AI calls are paused"}</span>
          <span className="block text-xs text-muted-foreground">
            {on
              ? "Approved calls dial during each person's calling hours (9 AM–5 PM weekdays, their time)."
              : `Paused since ${new Date(pausedAt as Date | string).toLocaleString()}. Approved calls wait and dial once this is back on.`}
            {!isAdmin ? " An admin changes this." : ""}
          </span>
        </span>
      </label>
    </Card>
  );
}

/* ───────────────────────── calling capacity ───────────────────────────── */

const LIMIT_FIELDS: { key: keyof VoiceLimits; label: string; hint: string }[] = [
  { key: "maxConcurrent", label: "Calls at once", hint: "In and out, across all agents" },
  { key: "dialsPerMinute", label: "New calls a minute", hint: "How fast approved calls start" },
  { key: "dailyMinutes", label: "Agent minutes a day", hint: "Any 24 hours, in and out" },
];
/** xAI's published voice rate (checked 2026-10-04); Plivo's per-minute rate comes on top. */
const XAI_DOLLARS_PER_MINUTE = 0.08;

/**
 * How many AI calls the workspace can make (owner ask 2026-10-06: "make more
 * outbound calls from a particular workspace"). More numbers raise the calls
 * a day; these limits set how fast and how much, up to fixed ceilings.
 */
function CallingCapacityCard({ isAdmin, agents }: { isAdmin: boolean; agents: Agent[] }) {
  const utils = trpc.useUtils();
  const status = trpc.voiceAgents.plivoStatus.useQuery();
  const saved = (status.data?.limits ?? DEFAULT_VOICE_LIMITS) as VoiceLimits;
  const [draft, setDraft] = useState<Partial<Record<keyof VoiceLimits, string>>>({});
  const value = (k: keyof VoiceLimits) => draft[k] ?? String(saved[k]);
  const parsed = Object.fromEntries(LIMIT_FIELDS.map(({ key }) => [key, Number(value(key))])) as VoiceLimits;
  const invalid = LIMIT_FIELDS.some(({ key }) => !Number.isInteger(parsed[key]) || parsed[key] < 1 || parsed[key] > VOICE_LIMIT_CEILINGS[key]);
  const dirty = LIMIT_FIELDS.some(({ key }) => parsed[key] !== saved[key]);
  const save = trpc.voiceAgents.setAiCallLimits.useMutation({
    onSuccess: () => { toast.success("Calling capacity saved"); setDraft({}); void utils.voiceAgents.plivoStatus.invalidate(); },
    onError: (e: any) => toast.error(e?.message ?? "Could not save"),
  });
  const outreachNumbers = agents
    .filter((a) => a.purpose === "outbound_outreach" && a.status === "active")
    .reduce((sum, a) => sum + agentNumbers(a).length, 0);
  const shown = invalid ? saved : parsed;
  return (
    <Card
      title="Calling capacity"
      sub={`How many AI calls this workspace can make. Each number places up to ${MAX_CALLS_PER_NUMBER_PER_DAY} calls a day, so more numbers on your outreach agents means more calls. These limits cap how fast and how much, so a mistake cannot run up the bill.`}
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {LIMIT_FIELDS.map(({ key, label, hint }) => (
          <div key={key} className="space-y-1.5">
            <Label>{label}</Label>
            <Input
              type="number"
              min={1}
              max={VOICE_LIMIT_CEILINGS[key]}
              value={value(key)}
              disabled={!isAdmin}
              onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))}
            />
            <p className="text-[11.5px] text-muted-foreground">{hint}. Up to {VOICE_LIMIT_CEILINGS[key]}; default {DEFAULT_VOICE_LIMITS[key]}.</p>
          </div>
        ))}
      </div>
      <p className="text-[12px] text-muted-foreground">
        {outreachNumbers === 0
          ? "No active outreach agent has a number yet."
          : `${outreachNumbers} number${outreachNumbers === 1 ? "" : "s"} on active outreach agents: up to ${outreachNumbers * MAX_CALLS_PER_NUMBER_PER_DAY} calls a day.`}{" "}
        {shown.dailyMinutes} agent minutes a day is at most about ${Math.round(shown.dailyMinutes * XAI_DOLLARS_PER_MINUTE)} of xAI time, plus Plivo's per-minute rate.
        Plivo's own account limits apply too (on its free trial, calls only go to verified numbers).
      </p>
      {isAdmin ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" disabled={!dirty || invalid || save.isPending} onClick={() => save.mutate(parsed)} className="gap-1.5">
            {save.isPending ? <Loader2 className="size-3.5 animate-spin" /> : null} Save
          </Button>
          {dirty && <Button size="sm" variant="outline" onClick={() => setDraft({})} disabled={save.isPending}>Cancel</Button>}
          {invalid && <span className="text-[12px] text-rose-600">Each limit is a whole number from 1 up to its maximum.</span>}
        </div>
      ) : (
        <p className="text-[12px] text-muted-foreground">An admin changes these.</p>
      )}
    </Card>
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
    // Main number first (several per agent since 2026-10-06).
    plivoNumbers: agentNumbers(agent) as string[],
    secret: "",
    languageHint: agent?.languageHint ?? "",
    // One per line (2026-10-06).
    discoveryQuestions: (Array.isArray(agent?.discoveryQuestions) ? agent.discoveryQuestions : []).join("\n") as string,
  }));
  const set = (k: string, v: unknown) => setF((p) => ({ ...p, [k]: v }));

  const create = trpc.voiceAgents.create.useMutation({ onError: (e: any) => toast.error(e?.message ?? "Could not create agent") });
  const update = trpc.voiceAgents.update.useMutation({ onError: (e: any) => toast.error(e?.message ?? "Could not save agent") });
  const setNumbers = trpc.voiceAgents.setPlivoNumbers.useMutation({ onError: (e: any) => toast.error(e?.message ?? "Could not connect the numbers") });
  const plivo = trpc.voiceAgents.plivoStatus.useQuery(undefined, { enabled: open });
  const plivoNumbers = trpc.voiceAgents.plivoNumbers.useQuery(undefined, { enabled: open && isAdmin && !!plivo.data?.configured });
  const allAgents = trpc.voiceAgents.list.useQuery(undefined, { enabled: open && isAdmin });
  const saving = create.isPending || update.isPending || setNumbers.isPending;

  // Which agent holds each number now: adding it here moves it.
  const holder = useMemo(() => {
    const m = new Map<string, string>();
    for (const o of (allAgents.data ?? []) as Agent[]) {
      if (o.id === agent?.id) continue;
      for (const n of agentNumbers(o)) m.set(n.replace(/\D/g, ""), o.name);
    }
    return m;
  }, [allAgents.data, agent?.id]);
  const mine = new Set(f.plivoNumbers.map((n) => n.replace(/\D/g, "")));
  const available = ((plivoNumbers.data ?? []) as { number: string }[]).filter((n) => !mine.has(n.number.replace(/\D/g, "")));
  const addNumber = (n: string) => { if (n && f.plivoNumbers.length < MAX_NUMBERS_PER_AGENT) set("plivoNumbers", [...f.plivoNumbers, n]); };
  const removeNumber = (n: string) => set("plivoNumbers", f.plivoNumbers.filter((x) => x !== n));
  const makeMain = (n: string) => set("plivoNumbers", [n, ...f.plivoNumbers.filter((x) => x !== n)]);

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
      discoveryQuestions: f.discoveryQuestions.split("\n").map((q: string) => q.trim()).filter(Boolean).slice(0, 8),
    };
    let id: number | undefined = agent?.id;
    if (agent) await update.mutateAsync({ id: agent.id, ...payload });
    else id = (await create.mutateAsync({ ...payload, status: "active" })).id;
    // The Plivo numbers: Velocity points each new one at itself (Plivo application) and records them.
    if (isAdmin && id && f.plivoNumbers.join(",") !== agentNumbers(agent).join(",")) {
      try {
        await setNumbers.mutateAsync({ agentId: id, numbers: f.plivoNumbers });
      } catch {
        return; // toasted; the agent itself is saved
      }
    }
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
            <Label>Instructions <span className="font-normal text-muted-foreground">(optional: extra guidance. Who is calling, that it is an AI, and how to book are built in)</span></Label>
            <textarea
              value={f.instructions}
              onChange={(e) => set("instructions", e.target.value)}
              rows={4}
              placeholder={"e.g. Keep it brief and warm. If they ask what's new, mention our October webinar. Never discuss pricing."}
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-[13px] outline-none focus:ring-2 focus:ring-ring"
            />
          </div>

          {isAdmin && (
            <div className="space-y-1.5">
              <Label>Plivo numbers</Label>
              {!plivo.data?.configured ? (
                <div className="rounded-md border border-dashed border-border px-3 py-2 text-[12.5px] text-muted-foreground">Connect Plivo above to pick a number.</div>
              ) : (
                <div className="space-y-2">
                  {f.plivoNumbers.length > 0 && (
                    <div className="divide-y divide-border/60 rounded-md border border-border">
                      {f.plivoNumbers.map((n, i) => (
                        <div key={n} className="flex items-center gap-2 px-3 py-1.5 text-[13px]">
                          <span className="min-w-0 flex-1 tabular-nums">{formatPhone(n)}</span>
                          {i === 0 ? (
                            <span className="rounded-full bg-secondary px-2 py-0.5 text-[10.5px] font-medium text-muted-foreground">Main</span>
                          ) : (
                            <button type="button" onClick={() => makeMain(n)} className="text-[12px] text-muted-foreground hover:text-foreground">Make main</button>
                          )}
                          <button type="button" onClick={() => removeNumber(n)} aria-label={`Remove ${formatPhone(n)}`} className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-rose-600">
                            <X className="size-3.5" />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                  {f.plivoNumbers.length < MAX_NUMBERS_PER_AGENT && (
                    <select value="" onChange={(e) => addNumber(e.target.value)} className="h-9 w-full rounded-md border border-border bg-background px-2.5 text-[13px]">
                      <option value="">
                        {plivoNumbers.isLoading ? "Loading your Plivo numbers…" : available.length === 0 ? "No other numbers on your Plivo account" : f.plivoNumbers.length ? "Add another number…" : "Add a number…"}
                      </option>
                      {available.map((n) => {
                        const on = holder.get(n.number.replace(/\D/g, ""));
                        return <option key={n.number} value={n.number}>{formatPhone(n.number)}{on ? ` (moves from ${on})` : ""}</option>;
                      })}
                    </select>
                  )}
                </div>
              )}
              <p className="text-[11.5px] text-muted-foreground">
                Calls to any of these numbers are answered by this agent. Outreach calls take turns across them: a person called before
                gets the same number again, otherwise one with their area code, otherwise the least used. Each number places up to{" "}
                {MAX_CALLS_PER_NUMBER_PER_DAY} calls a day, so add numbers to make more calls. Buy numbers in your Plivo console;
                Velocity sets them up when you save.
              </p>
            </div>
          )}

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>xAI phone number <span className="font-normal text-muted-foreground">(optional)</span></Label>
              <Input value={f.phoneNumber} onChange={(e) => set("phoneNumber", e.target.value)} placeholder="+1 555 0100" />
              <p className="text-[11.5px] text-muted-foreground">Only for a number registered in xAI's console. Leave blank when using Plivo.</p>
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
              <p className="text-[11.5px] text-muted-foreground">Only with an xAI phone number: shown once by xAI when it is registered. Required for it: calls Velocity cannot verify are rejected.</p>
            </div>
          </div>

          {f.purpose === "outbound_outreach" && (
            <div className="space-y-1.5">
              <Label>Discovery questions <span className="font-normal text-muted-foreground">(optional, one per line, up to 8)</span></Label>
              <textarea
                value={f.discoveryQuestions}
                onChange={(e) => set("discoveryQuestions", e.target.value)}
                rows={4}
                placeholder={"How do you run your scholarship applications today?\nWhat takes your team the most time in review season?\nWhat would you change about it if you could?"}
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-[13px] outline-none focus:ring-2 focus:ring-ring"
              />
              <p className="text-[11.5px] text-muted-foreground">
                The agent gives a reason for calling that is about them, asks two to four open questions one at a time (working these in when they fit),
                connects what they say to what you offer, and only then suggests a meeting.
              </p>
            </div>
          )}

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
