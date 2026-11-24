/**
 * CommunicationsSwitch — pause or resume everything this workspace sends to
 * people outside its team, from wherever you are (owner, 2026-11-23: "I want
 * to be able to re-enable / disable all communications from several places
 * within the app").
 *
 * One read (communications.status) and one write (communications.setPaused),
 * drawn three ways:
 *   · CommunicationsHeaderButton — in the top bar of every page;
 *   · CommunicationsCard — a row with the state spelled out, on the Autonomy
 *     Center and on Settings → Workspace overview;
 *   · CommunicationsResumeLink — inside the sending status bar, beside
 *     "Outbound paused", on the nine pages that show it.
 * Every one asks first, in the same words (@shared/communications), and says
 * what stops or starts. Only an admin may change it; everyone else sees the
 * state. Elsie proposes the same write as a card (assistantActionCatalog).
 */
import { useState } from "react";
import { Radio, PauseCircle } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  COMMUNICATIONS_LABEL, COMMUNICATIONS_PAUSE_EFFECT, COMMUNICATIONS_RESUME_EFFECT,
  communicationsPartialDetail, type CommunicationsState,
} from "@shared/communications";

type Ask = "pause" | "resume" | "choose" | "view";

/** The read, the write and the confirm, shared by every drawing of the switch. */
export function useCommunicationsSwitch() {
  const utils = trpc.useUtils();
  // Re-read each minute: another admin, or Elsie, may have flipped it.
  const q = trpc.communications.status.useQuery(undefined, { staleTime: 15_000, refetchInterval: 60_000, retry: false });
  const [ask, setAsk] = useState<Ask | null>(null);
  const set = trpc.communications.setPaused.useMutation({
    onSuccess: (r) => {
      toast.success(r.state === "paused" ? "All communications are paused." : "Communications are back on.");
      // Everything that shows either half of the switch.
      void utils.communications.status.invalidate();
      void utils.sendingStatus.current.invalidate();
      void utils.settings.get.invalidate();
      void utils.voiceAgents.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });
  const status = q.data;
  const state: CommunicationsState | null = status?.state ?? null;
  const canChange = !!status?.canChange;
  /** Open the confirm that fits the state: on → pause, paused → resume, partial → choose. */
  const open = () => {
    if (!state) return;
    if (!canChange) return setAsk("view");
    setAsk(state === "on" ? "pause" : state === "paused" ? "resume" : "choose");
  };
  const partial = status ? communicationsPartialDetail(status.emailPaused, status.callsPaused) : "";
  const dialog = (
    <AlertDialog open={ask !== null} onOpenChange={(o) => { if (!o) setAsk(null); }}>
      <AlertDialogContent data-communications-confirm={ask ?? undefined}>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {ask === "pause" ? "Pause all communications?"
              : ask === "resume" ? "Resume all communications?"
              : ask === "choose" ? "Communications are partly paused"
              : state ? COMMUNICATIONS_LABEL[state] : "Communications"}
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2 text-sm text-muted-foreground">
              {(ask === "choose" || ask === "view") && partial ? <p className="font-medium text-foreground">{partial}</p> : null}
              {ask === "pause" || ask === "choose" ? <p><span className="font-medium text-foreground">Pause all: </span>{COMMUNICATIONS_PAUSE_EFFECT}</p> : null}
              {ask === "resume" || ask === "choose" ? <p><span className="font-medium text-foreground">Resume all: </span>{COMMUNICATIONS_RESUME_EFFECT}</p> : null}
              {ask === "view" ? (
                <p>{state === "on"
                  ? "Email, LinkedIn and AI calls are on in this workspace. An admin can pause them all from here."
                  : "An admin paused these in this workspace. Nothing held is lost: what Velocity sends on its own goes out after an admin resumes."}</p>
              ) : null}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{ask === "view" ? "Close" : "Cancel"}</AlertDialogCancel>
          {ask === "pause" || ask === "choose" ? (
            <AlertDialogAction className="bg-rose-600 text-white hover:bg-rose-700" onClick={() => set.mutate({ paused: true })}>
              Pause all
            </AlertDialogAction>
          ) : null}
          {ask === "resume" || ask === "choose" ? (
            <AlertDialogAction onClick={() => set.mutate({ paused: false })}>Resume all</AlertDialogAction>
          ) : null}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
  return { status, state, canChange, partial, pending: set.isPending, open, dialog };
}

const TONE: Record<CommunicationsState, string> = {
  on: "text-muted-foreground hover:bg-secondary hover:text-foreground",
  paused: "bg-rose-100 text-rose-800 hover:bg-rose-200 dark:bg-rose-500/15 dark:text-rose-200",
  partial: "bg-amber-100 text-amber-900 hover:bg-amber-200 dark:bg-amber-500/15 dark:text-amber-200",
};
const SHORT: Record<CommunicationsState, string> = { on: "Sending on", paused: "Paused", partial: "Partly paused" };

/**
 * The top bar's switch. While communications are on it is a quiet icon (its
 * words appear from xl up); paused or partly paused it is a coloured pill
 * whose word always shows, so a paused workspace is visible from every page.
 */
export function CommunicationsHeaderButton() {
  const c = useCommunicationsSwitch();
  if (!c.state) return null;
  const off = c.state !== "on";
  const Icon = off ? PauseCircle : Radio;
  const hint = c.canChange
    ? (c.state === "on" ? "Pause all communications" : c.state === "paused" ? "Resume all communications" : "Pause or resume all communications")
    : "See what is paused";
  return (
    <>
      <button
        type="button"
        data-communications-switch="header"
        data-state={c.state}
        onClick={c.open}
        disabled={c.pending}
        title={`${COMMUNICATIONS_LABEL[c.state]}. ${hint}.`}
        aria-label={`${COMMUNICATIONS_LABEL[c.state]}. ${hint}.`}
        className={cn("flex items-center gap-1.5 px-2 py-1.5 rounded-md text-sm transition-colors shrink-0", TONE[c.state])}
      >
        <Icon className={cn("size-4", c.state === "on" && "text-emerald-600 dark:text-emerald-400")} />
        <span className={cn("font-medium whitespace-nowrap", off ? "inline" : "hidden xl:inline")}>{SHORT[c.state]}</span>
      </button>
      {c.dialog}
    </>
  );
}

/** The switch as a row with its state spelled out: Autonomy Center and Settings. */
export function CommunicationsCard({ className }: { className?: string }) {
  const c = useCommunicationsSwitch();
  if (!c.state || !c.status) return null;
  const since = c.status.emailPausedAt ?? c.status.callsPausedAt;
  const detail = c.state === "on"
    ? "Email, LinkedIn and AI calls are on in this workspace. One switch pauses them all."
    : c.state === "paused"
      ? `Nothing goes to anyone outside your team${since ? `, since ${new Date(since).toLocaleString()}` : ""}. What Velocity sends on its own is waiting.`
      : c.partial;
  return (
    <div
      data-communications-switch="card"
      data-state={c.state}
      className={cn(
        "rounded-xl border p-3 flex flex-wrap items-center gap-3",
        c.state === "paused" ? "border-rose-300 bg-rose-50 dark:border-rose-900 dark:bg-rose-950/30"
          : c.state === "partial" ? "border-amber-300 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/30"
          : "bg-card",
        className,
      )}
    >
      <span className={cn("shrink-0 size-9 rounded-full flex items-center justify-center", c.state === "on" ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300" : "bg-background")}>
        {c.state === "on" ? <Radio className="size-4" /> : <PauseCircle className="size-4" />}
      </span>
      <div className="min-w-0 flex-1 basis-56">
        <div className="text-sm font-medium">{COMMUNICATIONS_LABEL[c.state]}</div>
        <div className="text-xs text-muted-foreground">{detail}</div>
      </div>
      {c.canChange ? (
        <Button size="sm" variant={c.state === "on" ? "outline" : "default"} disabled={c.pending} onClick={c.open}>
          {c.state === "on" ? "Pause all" : c.state === "paused" ? "Resume all" : "Pause or resume"}
        </Button>
      ) : (
        <span className="text-xs text-muted-foreground">An admin can change this.</span>
      )}
      {c.dialog}
    </div>
  );
}

/** Inside the sending status bar, beside "Outbound paused": the way back on, for an admin. */
export function CommunicationsResumeLink() {
  const c = useCommunicationsSwitch();
  if (!c.canChange || !c.state || c.state === "on") return null;
  return (
    <>
      <button type="button" data-communications-switch="status-bar" onClick={c.open} disabled={c.pending} className="font-semibold underline underline-offset-2">
        {c.state === "paused" ? "Resume all" : "Pause or resume"}
      </button>
      {c.dialog}
    </>
  );
}
