/**
 * communications — the one switch for everything a workspace sends to people
 * outside its own team (owner, 2026-11-23: "I want to be able to re-enable /
 * disable all communications from several places within the app").
 *
 * Two flags already existed, each with its own switch on its own settings
 * page: Pause all outbound (email and LinkedIn, workspace_settings
 * .outboundPausedAt) and the AI calls switch (.aiCallsPausedAt). They were
 * made separate on purpose (2026-10-05: "email can stay held while calls
 * run"), and they still are: this switch sets or clears BOTH in one write,
 * and each keeps its own switch where it was. So "paused" here means both
 * are on, "on" means neither is, and anything else is "partial", which the
 * switch names instead of rounding it either way.
 *
 * Shared, because the header, the status bar, the Autonomy Center, Settings
 * and Elsie's confirm card must all say the same thing about what stops.
 */
export type CommunicationsState = "on" | "paused" | "partial";

export function communicationsState(emailPaused: boolean, callsPaused: boolean): CommunicationsState {
  if (emailPaused && callsPaused) return "paused";
  if (!emailPaused && !callsPaused) return "on";
  return "partial";
}

export const COMMUNICATIONS_LABEL: Record<CommunicationsState, string> = {
  on: "Communications on",
  paused: "Communications paused",
  partial: "Partly paused",
};

/** Which half is held, for the partial state. */
export function communicationsPartialDetail(emailPaused: boolean, callsPaused: boolean): string {
  if (emailPaused && !callsPaused) return "Email and LinkedIn are paused. AI calls are on.";
  if (!emailPaused && callsPaused) return "AI calls are paused. Email and LinkedIn are on.";
  return "";
}

/** What pausing does. Said on every confirm, a person's and Elsie's. */
export const COMMUNICATIONS_PAUSE_EFFECT =
  "Stops everything this workspace sends to people outside your team: Revenue Engine and sequence emails, LinkedIn messages and invites, meeting invites and reminders, chat follow-ups, emails a person sends by hand, and AI calls. What Velocity sends on its own waits and goes out after you resume. Mail to your own team still goes, and so does anything a prospect asks for themselves, such as a booking confirmation.";

/** What resuming does. */
export const COMMUNICATIONS_RESUME_EFFECT =
  "Email, LinkedIn and AI calls start again in this workspace. Sends that were held go out the next time the send window is open, and approved AI calls start dialing. A campaign or sequence that is paused on its own stays paused.";
