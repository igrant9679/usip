/**
 * ElsieAssistPane — Elsie's suggestions for the page you are on (owner
 * 2026-11-16: "a pane … where she can be advising, recommending … as the
 * user is navigating … and asking if the user wants her to do those actions").
 *
 * A column of the Shell, closed until the user opens it and remembered on
 * their account. While it is closed it asks the server for no suggestions:
 * only, once per page load, whether this account left it open.
 *
 * What it shows comes from rules over the same records the pages use
 * (shared/elsieAssist.ts): at most three suggestions, each with the reason
 * behind it and ONE button. The button opens a page, or puts a request to
 * Elsie in her chat, where anything that changes data still shows its confirm
 * card. Nothing in this pane changes a record.
 *
 * She has suggestions on four pages for now: Home, a campaign's page, Inbox
 * and a person's record. Everywhere else the pane says so and offers the chat.
 */
import { useEffect, useState } from "react";
import { useLocation, useSearch } from "wouter";
import { Compass, Loader2, PanelRight, PanelRightClose, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { addressOf } from "@/lib/lastPage";
import { assistantStore } from "@/lib/assistantStore";
import { assistPaneStore, useAssistPane } from "@/lib/assistPaneStore";
import { useWorkspaceRole } from "@/hooks/useWorkspaceRole";
import { ELSIE_NAME } from "@/components/usip/Elsie";
import { ASSIST_KINDS, ASSIST_PLACE_LABEL, assistPlaceFor, type AssistSuggestion } from "@shared/elsieAssist";

/** Saves the open/closed choice to the account; the pane has already moved. */
export function useAssistPaneToggle(): [boolean, () => void] {
  const { open } = useAssistPane();
  const save = trpc.elsieAssist.setPrefs.useMutation({ meta: { silentError: true } });
  const toggle = () => {
    const next = !assistPaneStore.get().open;
    assistPaneStore.setOpen(next);
    save.mutate({ open: next });
  };
  return [open, toggle];
}

/** The top-bar button, beside Elsie's own: opens and closes the pane. */
export function ElsieAssistButton() {
  const [open, toggle] = useAssistPaneToggle();
  return (
    <button
      type="button"
      data-tour-id="elsie-assist-button"
      onClick={toggle}
      title={open ? `Close ${ELSIE_NAME} Assist` : `${ELSIE_NAME} Assist: her suggestions for the page you are on`}
      aria-label={`${open ? "Close" : "Open"} ${ELSIE_NAME} Assist, her suggestions for this page`}
      aria-pressed={open}
      className={cn(
        "flex items-center gap-1.5 px-2 py-1.5 rounded-md text-sm transition-colors shrink-0",
        open
          ? "bg-violet-100 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300"
          : "text-muted-foreground hover:bg-secondary",
      )}
    >
      <PanelRight className="size-4" />
      <span className="hidden lg:inline font-medium">Assist</span>
    </button>
  );
}

export function ElsieAssistPane() {
  const { open, dismissed } = useAssistPane();
  const [, toggle] = useAssistPaneToggle();
  const [location, navigate] = useLocation();
  const search = useSearch();
  const pagePath = addressOf(location, search);
  const here = assistPlaceFor(pagePath);
  const { isAdmin } = useWorkspaceRole();
  const utils = trpc.useUtils();

  // The account's stored choice, once per page load. Cheap, and it is what
  // makes the pane follow the user to another browser.
  const prefs = trpc.elsieAssist.prefs.useQuery(undefined, { staleTime: Infinity, retry: false, meta: { silentError: true } });
  useEffect(() => {
    if (prefs.data) assistPaneStore.adoptServer(prefs.data.open);
  }, [prefs.data]);

  const q = trpc.elsieAssist.get.useQuery(
    { pagePath },
    { enabled: open && !!here, staleTime: 60_000, retry: false, meta: { silentError: true } },
  );
  const setPrefs = trpc.elsieAssist.setPrefs.useMutation({
    onSuccess: () => { void utils.elsieAssist.get.invalidate(); void utils.elsieAssist.prefs.invalidate(); },
    onError: (e) => toast.error(e.message),
  });
  const setCap = trpc.elsieAssist.setDailyCap.useMutation({
    onSuccess: () => { void utils.elsieAssist.get.invalidate(); toast.success("Saved"); },
    onError: (e) => toast.error(e.message),
  });
  const [capDraft, setCapDraft] = useState<string | null>(null);

  if (!open) return null;

  const muted = q.data?.muted ?? prefs.data?.muted ?? [];
  const suggestions = (q.data?.suggestions ?? []).filter((s) => !dismissed.has(s.id));
  const passes = q.data?.passes;

  const act = (s: AssistSuggestion) => {
    if (s.action.type === "navigate") navigate(s.action.href);
    else assistantStore.ask(s.action.prompt);
  };

  return (
    <aside
      aria-label={`${ELSIE_NAME} Assist`}
      data-tour-id="elsie-assist-pane"
      className="w-80 max-w-[100vw] shrink-0 border-l border-border bg-card flex flex-col fixed right-0 top-14 bottom-0 z-40 shadow-xl xl:static xl:z-auto xl:shadow-none"
    >
      <div className="flex items-center justify-between px-3 h-14 border-b border-border shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <Compass className="size-4 text-violet-600 shrink-0" />
          <span className="font-semibold text-sm truncate">{ELSIE_NAME} Assist</span>
        </div>
        <button
          type="button" onClick={toggle} aria-label={`Close ${ELSIE_NAME} Assist`} title="Close the pane"
          className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-muted text-muted-foreground"
        >
          <PanelRightClose className="size-4" />
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-3">
        {!here ? (
          <p className="text-[13px] text-muted-foreground">
            I have nothing to suggest on this page yet. For now I make suggestions on {ASSIST_PLACE_LABEL.home}, {ASSIST_PLACE_LABEL.campaign}, {ASSIST_PLACE_LABEL.inbox} and {ASSIST_PLACE_LABEL.person}. You can still ask me anything.
          </p>
        ) : q.isLoading ? (
          <div className="flex justify-center py-6"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>
        ) : q.isError ? (
          <p className="text-[13px] text-muted-foreground">I could not read this page's records just now. Try again in a moment.</p>
        ) : suggestions.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">Nothing here needs you right now.</p>
        ) : (
          suggestions.map((s) => (
            <div key={s.id} className="rounded-lg border bg-background p-3" data-assist-kind={s.kind}>
              <div className="flex items-start gap-2">
                <p className="text-[13px] font-semibold flex-1 min-w-0">{s.title}</p>
                <button
                  type="button" onClick={() => assistPaneStore.dismiss(s.id)} aria-label="Dismiss this suggestion"
                  className="text-muted-foreground hover:text-foreground shrink-0"
                >
                  <X className="size-3.5" />
                </button>
              </div>
              <p className="text-[12px] text-muted-foreground mt-1">{s.why}</p>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 mt-2.5">
                <button
                  type="button" onClick={() => act(s)}
                  className="px-3 py-1.5 text-[12px] font-medium text-white bg-violet-600 hover:bg-violet-700 rounded-lg"
                >
                  {s.action.label}
                </button>
                <button
                  type="button" disabled={setPrefs.isPending}
                  onClick={() => setPrefs.mutate({ mute: s.kind }, { onSuccess: () => toast.success(`I will stop suggesting ${ASSIST_KINDS[s.kind]}.`) })}
                  className="px-1 py-1.5 text-[12px] text-muted-foreground hover:text-foreground"
                  title={`Stop suggesting ${ASSIST_KINDS[s.kind]}`}
                >
                  Not useful
                </button>
              </div>
            </div>
          ))
        )}

        {muted.length > 0 && (
          <div className="text-[12px] text-muted-foreground">
            <p className="font-medium text-foreground/80">You asked me to stop suggesting:</p>
            <ul className="mt-1 space-y-0.5">
              {muted.map((k) => (
                <li key={k} className="flex items-center justify-between gap-2">
                  <span className="truncate">{ASSIST_KINDS[k]}</span>
                  <button type="button" className="hover:text-foreground underline shrink-0" disabled={setPrefs.isPending} onClick={() => setPrefs.mutate({ unmute: k })}>
                    Suggest again
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <div className="border-t border-border p-3 space-y-2 shrink-0">
        <button
          type="button" onClick={() => assistantStore.open()}
          className="w-full px-3 py-1.5 text-[12px] font-medium rounded-lg border hover:bg-muted"
        >
          Ask {ELSIE_NAME}
        </button>
        {passes && (
          <div className="text-[11px] text-muted-foreground flex items-center justify-between gap-2">
            <span title="A model orders and rewords the suggestions when there are two or more. The suggestions themselves come from your records.">
              {passes.cap === 0 ? "AI wording is off" : `AI wording today: ${passes.used} of ${passes.cap}`}
            </span>
            {isAdmin && capDraft === null && (
              <button type="button" className="underline hover:text-foreground" onClick={() => setCapDraft(String(passes.cap))}>Change</button>
            )}
          </div>
        )}
        {isAdmin && capDraft !== null && (
          <form
            className="flex items-center gap-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              const n = Math.floor(Number(capDraft));
              if (!Number.isFinite(n) || n < 0) { toast.error("Enter a whole number, 0 or more."); return; }
              setCap.mutate({ cap: n }, { onSuccess: () => setCapDraft(null) });
            }}
          >
            <input
              aria-label="AI wording passes per day" inputMode="numeric" value={capDraft} onChange={(e) => setCapDraft(e.target.value)}
              className="h-7 w-20 rounded-md border bg-background px-2 text-[12px]"
            />
            <span className="text-[11px] text-muted-foreground">a day (0 = off)</span>
            <button type="submit" disabled={setCap.isPending} className="ml-auto px-2 py-1 text-[11px] font-medium rounded-md bg-violet-600 text-white disabled:opacity-60">Save</button>
            <button type="button" className="px-1 py-1 text-[11px] text-muted-foreground" onClick={() => setCapDraft(null)}>Cancel</button>
          </form>
        )}
      </div>
    </aside>
  );
}

export default ElsieAssistPane;
