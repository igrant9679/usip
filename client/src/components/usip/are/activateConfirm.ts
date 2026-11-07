/**
 * Activate asks first (audit 2026-10-20, A52).
 *
 * One click on Activate started real sending, from the campaign page and from
 * the campaign list alike, with nothing saying so. Both now go through this:
 * a confirm that says it starts sending, in which mode, up to what cap, inside
 * which window, and that nothing goes while outbound is paused for the
 * workspace. Pausing needs no confirm: it only ever sends less.
 */
import { confirmAction } from "@/components/usip/Common";
import { trpc } from "@/lib/trpc";
import { describeSendWindow, normalizeSendWindow } from "@shared/sendWindow";
import { approveThresholdSummary } from "@shared/areApproveThreshold";

export interface ActivatingCampaign {
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

/** The confirm both Activate buttons raise; `onYes` runs only after a yes. */
export function useConfirmActivate(): (c: ActivatingCampaign, onYes: () => void) => void {
  const settings = trpc.settings.get.useQuery(undefined, { staleTime: 60_000 });
  return (c, onYes) => confirmAction({
    title: `Activate "${c.name}" and start sending?`,
    description: activateMessage(c, settings.data as SendWindowFacts | undefined),
    confirmLabel: "Activate",
    destructive: false,
  }, onYes);
}
