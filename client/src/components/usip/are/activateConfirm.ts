/**
 * Activate asks first (audit 2026-10-20, A52).
 *
 * One click on Activate started real sending, from the campaign page and from
 * the campaign list alike, with nothing saying so. Both now go through this:
 * a confirm that says it starts sending, in which mode, up to what cap, inside
 * which window, and that nothing goes while outbound is paused for the
 * workspace. Pausing needs no confirm: it only ever sends less.
 *
 * And it checks first (F15): the campaign's pre-flight (are.campaigns.
 * preflight) is read before the confirm. What would make the campaign fail —
 * nothing to send email from, a LinkedIn-only campaign with no account, no
 * one to send to — is listed and Activate is not offered; what only weakens
 * it is listed beside the confirm. The server refuses the same blockers, so
 * a stale page cannot get past them.
 */
import { createElement, type ReactNode } from "react";
import { confirmAction } from "@/components/usip/Common";
import { trpc } from "@/lib/trpc";
import { describeSendWindow, normalizeSendWindow } from "@shared/sendWindow";
import { approveThresholdSummary } from "@shared/areApproveThreshold";

export interface ActivatingCampaign {
  /** When given, the pre-flight is read before the confirm (F15). */
  id?: number;
  name: string;
  autonomyMode: string | null;
  autoApproveThreshold: number | null;
  dailySendCap: number | null;
}

export interface SendWindowFacts {
  sendWindowStartHour?: number | null;
  sendWindowEndHour?: number | null;
  sendWindowDays?: number[] | string | null;
  timezone?: string | null;
  outboundPausedAt?: string | Date | null;
}

/** One line of the pre-flight, as are.campaigns.preflight returns it. */
export interface PreflightLine { key: string; label: string; ok: boolean; blocking: boolean; detail: string }

/** What Activate will do, in words. `settings` is undefined when the workspace's could not be read. */
export function activateMessage(c: ActivatingCampaign, settings: SendWindowFacts | null | undefined): string {
  const mode = c.autonomyMode === "full"
    ? c.autoApproveThreshold == null
      ? "Fully autonomous, with no auto-approve threshold: nothing is approved automatically, so only the people you approve are sent."
      : `Fully autonomous: ${approveThresholdSummary(c.autoApproveThreshold).toLowerCase()}, with no review before sending.`
    : "Batch approval: only the people you approve are sequenced and sent.";
  const window = settings
    ? `inside the send window (${describeSendWindow(normalizeSendWindow({ startHour: settings.sendWindowStartHour, endHour: settings.sendWindowEndHour, days: settings.sendWindowDays }))}, ${settings.timezone || "UTC"})`
    : "inside the workspace's send window";
  const paused = settings?.outboundPausedAt
    ? " Outbound is paused for this workspace right now, so nothing is sent until someone resumes it."
    : " Nothing is sent while outbound is paused for the workspace.";
  return `This starts real sending. The engine picks the campaign up within 3 minutes and emails its enrolled prospects ${window}, up to ${c.dailySendCap ?? 50} a day for this campaign and within the workspace's Revenue Engine cap. ${mode}${paused}`;
}

/**
 * The dialog Activate raises, given the pre-flight (or none, when it could
 * not be read: the server still refuses the blockers). Pure, for the tests.
 */
export function activateDialog(c: ActivatingCampaign, settings: SendWindowFacts | null | undefined, checks: PreflightLine[] | null) {
  const blockers = (checks ?? []).filter((x) => x.blocking);
  const warnings = (checks ?? []).filter((x) => !x.ok && !x.blocking);
  if (blockers.length > 0) {
    return {
      blocked: true as const,
      title: `"${c.name}" can't start yet`,
      lead: "Fix these first — each would make the campaign fail:",
      lines: blockers.map((b) => `${b.label}: ${b.detail}`),
      confirmLabel: "OK",
    };
  }
  return {
    blocked: false as const,
    title: `Activate "${c.name}" and start sending?`,
    lead: activateMessage(c, settings),
    lines: warnings.map((w) => `${w.label}: ${w.detail}`),
    confirmLabel: "Activate",
  };
}

function dialogBody(lead: string, lines: string[], heading?: string): ReactNode {
  if (lines.length === 0) return lead;
  return createElement("span", { className: "block space-y-2" },
    createElement("span", { className: "block" }, lead),
    heading ? createElement("span", { className: "block font-medium text-foreground" }, heading) : null,
    createElement("span", { className: "block space-y-1" },
      ...lines.map((l, i) => createElement("span", { key: i, className: "block" }, `• ${l}`))),
  );
}

/** The confirm both Activate buttons raise; `onYes` runs only after a yes. */
export function useConfirmActivate(): (c: ActivatingCampaign, onYes: () => void) => void {
  const settings = trpc.settings.get.useQuery(undefined, { staleTime: 60_000 });
  const utils = trpc.useUtils();
  return (c, onYes) => {
    const ask = (checks: PreflightLine[] | null) => {
      const d = activateDialog(c, settings.data as SendWindowFacts | undefined, checks);
      if (d.blocked) {
        confirmAction({ title: d.title, description: dialogBody(d.lead, d.lines), confirmLabel: d.confirmLabel, cancelLabel: "Close", destructive: false }, () => {});
        return;
      }
      confirmAction({
        title: d.title,
        description: dialogBody(d.lead, d.lines, "Worth knowing before it starts:"),
        confirmLabel: d.confirmLabel,
        destructive: false,
      }, onYes);
    };
    if (c.id == null) { ask(null); return; }
    // Fresh each time: a mailbox added a minute ago counts.
    utils.are.campaigns.preflight.fetch({ id: c.id }, { staleTime: 0 }).then((r) => ask(r.checks), () => ask(null));
  };
}
