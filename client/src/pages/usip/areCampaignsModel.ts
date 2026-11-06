/**
 * The New Campaign wizard's starting values, apart from the page so tests can
 * call them (audit 2026-10-20, A16, A17).
 */

export type WizardAutonomy = "full" | "batch_approval" | "review_release";

export interface WizardDefaults {
  autonomyMode: WizardAutonomy;
  dailySendCap: number;
  autoApproveThreshold: number | null;
  channelsEnabled: { email: boolean; linkedin: boolean; sms: boolean; voice: boolean };
  sequenceTemplate: string;
  signalToOpportunityEnabled: boolean;
}

/**
 * ARE Settings' defaults for a new campaign, or the most manual ones when they
 * are not here.
 *
 * `settings` is undefined while the read is in flight and after it failed.
 * The fallback was Full Auto at a 60 threshold, so a slow or failed read
 * created campaigns that approved and sent on their own (A17). Now it is Batch
 * approval with no threshold, and the wizard says the defaults did not load.
 * An unset threshold stays unset (A16): nothing is approved automatically.
 */
export function wizardDefaults(settings: Record<string, unknown> | null | undefined): WizardDefaults {
  const s = (settings ?? {}) as Record<string, any>;
  const channels = (s.areDefaultChannels ?? null) as Record<string, boolean> | null;
  const mode = s.areDefaultAutonomyMode;
  return {
    autonomyMode: settings && (mode === "full" || mode === "batch_approval" || mode === "review_release") ? mode : "batch_approval",
    dailySendCap: Number(s.areDefaultDailySendCap ?? 50) || 50,
    autoApproveThreshold: typeof s.areDefaultAutoApproveThreshold === "number" ? s.areDefaultAutoApproveThreshold : null,
    channelsEnabled: {
      email: channels?.email ?? true,
      linkedin: channels?.linkedin ?? false,
      sms: channels?.sms ?? false,
      voice: channels?.voice ?? false,
    },
    sequenceTemplate: (s.areDefaultSequenceTemplate ?? "standard_7step") as string,
    signalToOpportunityEnabled: Boolean(s.areDefaultSignalToOpportunity ?? false),
  };
}
