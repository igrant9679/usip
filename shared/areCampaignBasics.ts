/**
 * A campaign's basics, editable after it is created (audit 2026-10-20, U11):
 * name, daily cap, target, channels, goal and sequence template. They were
 * set once, in the create wizard, though are.campaigns.update took every one.
 *
 * One rule for the Settings tab and the server: while outbound is paused for
 * the workspace, a campaign's daily cap can only go down and a channel only
 * be switched off — nothing saved then may make sending more likely when the
 * pause lifts without someone choosing it again — and a cap is never raised
 * past the workspace's own Revenue Engine cap, which the engine stops at
 * across every campaign (A19).
 *
 * No imports beyond shared/: reached from the client bundle and the server.
 */
import { campaignChannelOn } from "./areSequenceSteps";

export const ARE_GOALS = [
  { value: "reply", label: "A reply" },
  { value: "meeting_booked", label: "A meeting booked" },
  { value: "opportunity_created", label: "An opportunity created" },
] as const;
export type AreGoal = (typeof ARE_GOALS)[number]["value"];

/** The two channels a campaign can send on (sms and voice are never sent). */
export const ARE_BASIC_CHANNELS = ["email", "linkedin"] as const;

export const CAP_MIN = 1, CAP_MAX = 500, TARGET_MIN = 1, TARGET_MAX = 10000;

export interface BasicsDraft {
  name?: string;
  dailySendCap?: number;
  targetProspectCount?: number;
  channelsEnabled?: { email: boolean; linkedin: boolean };
  goalType?: AreGoal;
  sequenceTemplate?: string;
}

export interface BasicsSaved {
  name: string;
  dailySendCap: number;
  targetProspectCount: number;
  channelsEnabled: unknown;
  goalType: string;
  sequenceTemplate: string;
}

/** The channels as the engine reads them: email unless switched off, LinkedIn only when on. */
export function channelsOf(stored: unknown): { email: boolean; linkedin: boolean } {
  return { email: campaignChannelOn(stored, "email"), linkedin: campaignChannelOn(stored, "linkedin") };
}

/** Only what differs from what is saved: the update payload and the labels of what changed. */
export function basicsChanges(saved: BasicsSaved, draft: BasicsDraft): { payload: BasicsDraft; changed: string[] } {
  const payload: BasicsDraft = {};
  const changed: string[] = [];
  if (draft.name !== undefined && draft.name.trim() !== saved.name) { payload.name = draft.name.trim(); changed.push("name"); }
  if (draft.dailySendCap !== undefined && draft.dailySendCap !== saved.dailySendCap) { payload.dailySendCap = draft.dailySendCap; changed.push("daily cap"); }
  if (draft.targetProspectCount !== undefined && draft.targetProspectCount !== saved.targetProspectCount) { payload.targetProspectCount = draft.targetProspectCount; changed.push("target"); }
  if (draft.channelsEnabled !== undefined) {
    const was = channelsOf(saved.channelsEnabled);
    if (was.email !== draft.channelsEnabled.email || was.linkedin !== draft.channelsEnabled.linkedin) {
      // The rest of the stored map (sms, voice) is kept, switched off.
      payload.channelsEnabled = { ...draft.channelsEnabled };
      changed.push("channels");
    }
  }
  if (draft.goalType !== undefined && draft.goalType !== saved.goalType) { payload.goalType = draft.goalType; changed.push("goal"); }
  if (draft.sequenceTemplate !== undefined && draft.sequenceTemplate !== saved.sequenceTemplate) { payload.sequenceTemplate = draft.sequenceTemplate; changed.push("sequence template"); }
  return { payload, changed };
}

/** What is wrong with a basics draft as typed, or null. */
export function basicsProblem(d: BasicsDraft): string | null {
  if (d.name !== undefined && d.name.trim().length < 2) return "The name needs at least 2 characters.";
  if (d.dailySendCap !== undefined && (!Number.isInteger(d.dailySendCap) || d.dailySendCap < CAP_MIN || d.dailySendCap > CAP_MAX)) return `The daily cap is a whole number from ${CAP_MIN} to ${CAP_MAX}.`;
  if (d.targetProspectCount !== undefined && (!Number.isInteger(d.targetProspectCount) || d.targetProspectCount < TARGET_MIN || d.targetProspectCount > TARGET_MAX)) return `The target is a whole number from ${TARGET_MIN} to ${TARGET_MAX.toLocaleString("en-US")}.`;
  if (d.channelsEnabled && !d.channelsEnabled.email && !d.channelsEnabled.linkedin) return "Pick at least one channel.";
  return null;
}

/**
 * Why a change to the cap or the channels is refused, or null. `current` is
 * what is saved; `next` holds only the fields being changed.
 */
export function sendIncreaseRefusal(
  current: { dailySendCap: number; channelsEnabled: unknown },
  next: { dailySendCap?: number; channelsEnabled?: unknown },
  ctx: { outboundPaused: boolean; workspaceCap: number },
): string | null {
  const raising = next.dailySendCap !== undefined && next.dailySendCap > current.dailySendCap;
  const added = next.channelsEnabled === undefined
    ? []
    : ARE_BASIC_CHANNELS.filter((ch) => campaignChannelOn(next.channelsEnabled, ch) && !campaignChannelOn(current.channelsEnabled, ch));
  if ((raising || added.length > 0) && ctx.outboundPaused) {
    return "Outbound is paused for this workspace, so a campaign's daily cap can only be lowered and channels only switched off until the pause is lifted.";
  }
  if (raising && next.dailySendCap! > ctx.workspaceCap) {
    return `The workspace's Revenue Engine cap is ${ctx.workspaceCap} a day across all campaigns (ARE Settings), so a campaign's cap can't be raised past it.`;
  }
  return null;
}
