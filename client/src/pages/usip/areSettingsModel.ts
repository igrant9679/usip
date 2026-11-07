/**
 * ARE Settings' form values, apart from the page so tests can call them
 * (audit 2026-10-20, A60).
 *
 * Save wrote every field, so saving one switch also wrote back every other
 * value as this page had last read it, over anything changed elsewhere since.
 * It now sends only what differs from what was loaded. Discard re-reads the
 * form from the loaded settings directly: it used to refetch and rely on an
 * effect that never ran when the refetch returned the same object.
 */
import { ARE_SOURCE_IDS, resolveSourceOrder } from "@shared/areSources";

export type AreAutonomyMode = "full" | "batch_approval";
export type IcpRegenSchedule = "daily" | "weekly" | "on_new_deal" | "manual";
export const ICP_REGEN_SCHEDULES: IcpRegenSchedule[] = ["daily", "weekly", "on_new_deal", "manual"];

export interface AreSettingsDraft {
  areDefaultAutonomyMode: AreAutonomyMode;
  areDefaultDailySendCap: number;
  areDefaultAutoApproveThreshold: number | null;
  areDefaultSignalToOpportunity: boolean;
  areDefaultChannels: Record<string, boolean>;
  areMaxConcurrentCampaigns: number;
  areNotifyOnMeetingBooked: boolean;
  areNotifyOnAutoApprove: boolean;
  areNotifyOnIcpUpdate: boolean;
  areDefaultSequenceTemplate: string;
  areScraperSources: Record<string, boolean>;
  areSourceOrder: string[];
  areIcpRegenSchedule: IcpRegenSchedule;
}

/** The form as the loaded settings say it should read. */
export function areSettingsDraft(settings: Record<string, any>): AreSettingsDraft {
  const saved = (settings.areScraperSources ?? {}) as Record<string, boolean>;
  const schedule = settings.areIcpRegenSchedule ?? "daily";
  return {
    // review_release was removed 2026-09-02; rows still carrying it read as batch_approval.
    areDefaultAutonomyMode: settings.areDefaultAutonomyMode === "full" ? "full" : "batch_approval",
    areDefaultDailySendCap: settings.areDefaultDailySendCap ?? 50,
    areDefaultAutoApproveThreshold: settings.areDefaultAutoApproveThreshold ?? null,
    areDefaultSignalToOpportunity: settings.areDefaultSignalToOpportunity ?? false,
    areDefaultChannels: (settings.areDefaultChannels as Record<string, boolean>) ?? { email: true, linkedin: false, sms: false, voice: false },
    areMaxConcurrentCampaigns: settings.areMaxConcurrentCampaigns ?? 5,
    areNotifyOnMeetingBooked: settings.areNotifyOnMeetingBooked ?? true,
    areNotifyOnAutoApprove: settings.areNotifyOnAutoApprove ?? false,
    areNotifyOnIcpUpdate: settings.areNotifyOnIcpUpdate ?? true,
    areDefaultSequenceTemplate: (settings.areDefaultSequenceTemplate as string) ?? "standard_7step",
    // Saved values may predate the unified vocabulary; read only the live ids
    // and default anything absent to on, so an old row doesn't silently
    // disable a working source.
    areScraperSources: Object.fromEntries(ARE_SOURCE_IDS.map((id) => [id, saved[id] ?? true])),
    areSourceOrder: resolveSourceOrder(settings.areSourceOrder ?? null, {}, ARE_SOURCE_IDS),
    // Anything unrecognised reads as the cadence the cron actually runs for it.
    areIcpRegenSchedule: ICP_REGEN_SCHEDULES.indexOf(schedule) >= 0 ? schedule : "daily",
  };
}

/** Only the fields that differ from what was loaded: the save's whole payload. */
export function changedAreSettings(loaded: AreSettingsDraft, current: AreSettingsDraft): Partial<AreSettingsDraft> {
  const out: Partial<AreSettingsDraft> = {};
  for (const k of Object.keys(current) as Array<keyof AreSettingsDraft>) {
    if (JSON.stringify(current[k]) !== JSON.stringify(loaded[k])) (out as Record<string, unknown>)[k] = current[k];
  }
  return out;
}
