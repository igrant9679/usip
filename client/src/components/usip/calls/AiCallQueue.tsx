/**
 * AiCallQueue — the approval list for outbound AI calls (Calls page).
 *
 * Owner ask 2026-10-04: AI calls "gated and not autonomous … approved, in
 * batches and/or 1 by 1". People are queued from People (Queue AI call);
 * here a manager approves them, one or many, confirming consent. Approved
 * calls dial during each person's calling hours (9 AM–5 PM weekdays, their
 * time), never while outbound is paused.
 */
import { useMemo, useState } from "react";
import { Link } from "wouter";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "sonner";
import { Bot, CalendarCheck, Check, Clock, PhoneCall, X } from "lucide-react";
import { rankOf, ROLE_RANK } from "@shared/roleRank";
import { isWithinCallingHours } from "@shared/callingHours";
import { formatPhone } from "@shared/phoneFormat";

type Tab = "draft" | "approved" | "done";

const RESULT_LABEL: Record<string, string> = {
  // Agreed on the call; it is booked when they confirm the emailed link (2026-10-06).
  booked: "Meeting agreed",
  not_interested: "Not interested",
  call_back: "Call back later",
  wrong_person: "Wrong person",
  do_not_call: "Asked not to be called",
  no_decision: "No decision",
  voicemail: "Voicemail",
  no_answer: "No answer",
  busy: "Busy",
  failed: "Call failed",
};

function localTime(tz: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, { timeZone: tz, hour: "numeric", minute: "2-digit", weekday: "short" }).format(new Date());
  } catch {
    return "";
  }
}

export function AiCallQueue({ accent }: { accent: string }) {
  const utils = trpc.useUtils();
  const me = trpc.profile.getMe.useQuery();
  const canApprove = rankOf((me.data as any)?.role ?? "rep") >= ROLE_RANK.manager;
  const [tab, setTab] = useState<Tab>("draft");
  const list = trpc.aiCalls.list.useQuery({ status: "all" }, { refetchInterval: 30_000 });
  // AI calls' own switch (2026-10-05).
  const aiCallsPaused = !!trpc.voiceAgents.plivoStatus.useQuery().data?.aiCallsPausedAt;
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const [consentFor, setConsentFor] = useState<number[] | null>(null);
  const [consentTicked, setConsentTicked] = useState(false);
  const [editing, setEditing] = useState<{ id: number; notes: string } | null>(null);

  const rows = (list.data ?? []) as Record<string, any>[];
  const byTab = useMemo(() => ({
    draft: rows.filter((r) => r.status === "draft"),
    approved: rows.filter((r) => r.status === "approved" || r.status === "dialing"),
    done: rows.filter((r) => ["done", "rejected", "skipped"].includes(r.status)),
  }), [rows]);
  const shown = byTab[tab];

  const refresh = () => { setChecked(new Set()); void utils.aiCalls.list.invalidate(); };
  const approve = trpc.aiCalls.approve.useMutation({
    onSuccess: (r) => {
      toast.success(`${r.approved} call${r.approved === 1 ? "" : "s"} approved. They dial during each person's calling hours.`);
      setConsentFor(null); setConsentTicked(false); refresh();
    },
    onError: (e) => toast.error(e.message),
  });
  const reject = trpc.aiCalls.reject.useMutation({
    onSuccess: (r) => { toast.success(`${r.rejected} removed from the queue`); refresh(); },
    onError: (e) => toast.error(e.message),
  });
  const update = trpc.aiCalls.update.useMutation({
    onSuccess: () => { toast.success("Notes saved"); setEditing(null); refresh(); },
    onError: (e) => toast.error(e.message),
  });

  const toggle = (id: number) => setChecked((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const allChecked = shown.length > 0 && shown.every((r) => checked.has(r.id));
  const selected = shown.filter((r) => checked.has(r.id)).map((r) => r.id as number);

  if (!list.isLoading && rows.length === 0) return null;

  return (
    <section>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold flex items-center gap-2">
          <Bot className="size-4" style={{ color: accent }} /> AI calls
        </h2>
        <div className="flex rounded-md border p-0.5 text-[12px]">
          {([["draft", "To approve"], ["approved", "Approved"], ["done", "Done"]] as const).map(([k, label]) => (
            <button key={k} onClick={() => { setTab(k); setChecked(new Set()); }}
              className={cn("rounded px-2 py-0.5", tab === k ? "bg-secondary font-medium" : "text-muted-foreground")}>
              {label} <span className="text-muted-foreground">{byTab[k].length}</span>
            </button>
          ))}
        </div>
        <div className="flex-1" />
        {selected.length > 0 && tab === "draft" && canApprove && (
          <Button size="sm" className="h-7 gap-1.5" onClick={() => setConsentFor(selected)}>
            <Check className="size-3.5" /> Approve {selected.length}
          </Button>
        )}
        {selected.length > 0 && (tab === "draft" || (tab === "approved" && canApprove)) && (
          <Button size="sm" variant="outline" className="h-7 gap-1.5" disabled={reject.isPending}
            onClick={() => reject.mutate({ ids: selected })}>
            <X className="size-3.5" /> {tab === "draft" ? "Reject" : "Take back"} {selected.length}
          </Button>
        )}
      </div>

      {aiCallsPaused && (
        <div className="mb-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-[12.5px] text-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
          AI calls are paused for this workspace: approved calls wait instead of dialing. Switch them back on in Settings → Voice agents.
        </div>
      )}
      {tab === "draft" && !canApprove && byTab.draft.length > 0 && (
        <p className="mb-2 text-[12px] text-muted-foreground">A manager or admin approves these before they dial.</p>
      )}

      <div className="rounded-xl border bg-card overflow-hidden shadow-sm">
        {shown.length === 0 ? (
          <div className="px-4 py-6 text-center text-[12.5px] text-muted-foreground">
            {tab === "draft" ? "Nothing waiting for approval. Queue people from People → Queue AI call." : tab === "approved" ? "No approved calls waiting to dial." : "No finished calls yet."}
          </div>
        ) : (
          <table className="w-full text-[12.5px]">
            <thead className="border-b border-border/60 text-[11px] text-muted-foreground">
              <tr>
                {tab !== "done" && (
                  <th className="w-8 px-3 py-2 text-left">
                    <Checkbox checked={allChecked} onCheckedChange={() => setChecked(allChecked ? new Set() : new Set(shown.map((r) => r.id)))} className="size-3.5" />
                  </th>
                )}
                <th className="px-3 py-2 text-left font-medium">Person</th>
                <th className="px-3 py-2 text-left font-medium">Their time</th>
                <th className="px-3 py-2 text-left font-medium">Agent</th>
                <th className="px-3 py-2 text-left font-medium">{tab === "done" ? "Result" : "Notes for the agent"}</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => {
                const open = isWithinCallingHours(Date.now(), r.timezone);
                const result = r.result ?? r.call?.result ?? null;
                return (
                  <tr key={r.id} className="border-b border-border/40 last:border-0 align-top">
                    {tab !== "done" && (
                      <td className="px-3 py-2"><Checkbox checked={checked.has(r.id)} onCheckedChange={() => toggle(r.id)} className="size-3.5" /></td>
                    )}
                    <td className="px-3 py-2">
                      <Link href={`/prospects/${r.prospectId}`} className="font-medium hover:underline">{r.personName}</Link>
                      <div className="text-[11px] text-muted-foreground">{[r.company, formatPhone(r.toNumber)].filter(Boolean).join(" · ")}</div>
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      <div className="flex items-center gap-1">
                        <Clock className={cn("size-3", open ? "text-emerald-600" : "text-muted-foreground")} /> {localTime(r.timezone)}
                      </div>
                      <div className="text-[11px] text-muted-foreground">{open ? "In calling hours" : "Outside calling hours"}</div>
                    </td>
                    <td className="px-3 py-2">
                      <div>{r.agent?.name ?? "—"}</div>
                      <div className="text-[11px] text-muted-foreground">{r.ownerName ? `Books on ${r.ownerName}'s calendar` : ""}</div>
                    </td>
                    <td className="px-3 py-2 max-w-[22rem]">
                      {tab === "done" ? (
                        <div>
                          <span className={cn("font-medium", result === "booked" && "text-emerald-700 dark:text-emerald-400")}>
                            {result === "booked" && <CalendarCheck className="mr-1 inline size-3.5" />}
                            {r.status === "rejected" ? "Rejected" : r.status === "skipped" ? "Skipped" : RESULT_LABEL[result] ?? "Done"}
                          </span>
                          {r.statusReason && <div className="text-[11px] text-muted-foreground">{r.statusReason}</div>}
                          {r.call?.durationSec != null && <div className="text-[11px] text-muted-foreground">{Math.floor(r.call.durationSec / 60)}:{String(r.call.durationSec % 60).padStart(2, "0")} on the call</div>}
                        </div>
                      ) : (
                        <div className="whitespace-pre-wrap text-muted-foreground">
                          {r.callNotes || <span className="italic">None: the agent works from the person's record.</span>}
                          {r.status === "dialing" && <div className="mt-1 flex items-center gap-1 text-sky-600"><PhoneCall className="size-3" /> Calling now</div>}
                          {r.statusReason && r.status !== "dialing" && <div className="mt-1 text-[11px]">{r.statusReason}</div>}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right whitespace-nowrap">
                      {r.status === "draft" && (
                        <>
                          <Button size="sm" variant="ghost" className="h-7" onClick={() => setEditing({ id: r.id, notes: r.callNotes ?? "" })}>Edit</Button>
                          {canApprove && <Button size="sm" variant="outline" className="h-7" onClick={() => setConsentFor([r.id])}>Approve</Button>}
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <Dialog open={!!consentFor} onOpenChange={(o) => { if (!o) { setConsentFor(null); setConsentTicked(false); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Approve {consentFor?.length ?? 0} AI call{consentFor?.length === 1 ? "" : "s"}</DialogTitle>
            <DialogDescription>
              Each call dials during the person's calling hours (9 AM–5 PM weekdays, their time), never while AI calls are paused (Settings → Voice agents).
              The agent says it is an AI and that the call is transcribed, offers times from the owner's calendar, and books the meeting if they agree.
            </DialogDescription>
          </DialogHeader>
          <label className="flex items-start gap-2 rounded-md border p-3 text-[13px]">
            <Checkbox checked={consentTicked} onCheckedChange={(v) => setConsentTicked(v === true)} className="mt-0.5" />
            <span>
              I confirm {consentFor?.length === 1 ? "this person has" : "these people have"} agreed to receive AI phone calls from us.
              <span className="block text-[11.5px] text-muted-foreground">US law treats an AI voice as an artificial voice: calls to mobiles need prior consent. Your confirmation is recorded with your name and the time.</span>
            </span>
          </label>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setConsentFor(null); setConsentTicked(false); }}>Cancel</Button>
            <Button disabled={!consentTicked || approve.isPending} onClick={() => consentFor && approve.mutate({ ids: consentFor, consentConfirmed: true })}>
              Approve
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!editing} onOpenChange={(o) => { if (!o) setEditing(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Notes for the agent</DialogTitle>
            <DialogDescription>What the agent should know or mention on this call. The person's name, title and company come from their record.</DialogDescription>
          </DialogHeader>
          <Textarea rows={6} maxLength={1500} value={editing?.notes ?? ""} onChange={(e) => setEditing((x) => (x ? { ...x, notes: e.target.value } : x))} />
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)}>Cancel</Button>
            <Button disabled={update.isPending} onClick={() => editing && update.mutate({ id: editing.id, callNotes: editing.notes })}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
