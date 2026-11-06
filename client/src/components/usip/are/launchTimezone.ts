/**
 * The first-launch time-zone question (audit 2026-10-20, A31).
 *
 * A campaign's first launch is refused while the workspace's zone is still the
 * UTC default, with TIMEZONE_UNSET_ON_LAUNCH as the message: the send window
 * and daily cap run in that zone. Every launch button hands its error here;
 * when it is that refusal, the person is asked and `retry` launches on UTC.
 */
import { confirmAction } from "@/components/usip/Common";
import { TIMEZONE_UNSET_ON_LAUNCH } from "@shared/sendWindow";

/** True when this was the time-zone question, which has now been asked. */
export function askLaunchOnUtc(message: string, retry: () => void): boolean {
  if (message !== TIMEZONE_UNSET_ON_LAUNCH) return false;
  confirmAction(
    { title: "Launch on UTC?", description: message, confirmLabel: "Launch on UTC", cancelLabel: "Not yet" },
    retry,
  );
  return true;
}
