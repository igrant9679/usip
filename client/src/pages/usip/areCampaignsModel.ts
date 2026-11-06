/**
 * The New Campaign wizard's starting values, apart from the page so tests can
 * call them (audit 2026-10-20, A16, A17).
 */

import { icpLabels } from "@shared/icpShape";

export type WizardAutonomy = "full" | "batch_approval" | "review_release";

export const EMPLOYEE_BANDS = [
  { value: "any", label: "Any size", min: undefined, max: undefined },
  { value: "1-10", label: "1–10", min: 1, max: 10 },
  { value: "11-50", label: "11–50", min: 11, max: 50 },
  { value: "51-200", label: "51–200", min: 51, max: 200 },
  { value: "201-500", label: "201–500", min: 201, max: 500 },
  { value: "501-1000", label: "501–1,000", min: 501, max: 1000 },
  { value: "1001-5000", label: "1,001–5,000", min: 1001, max: 5000 },
  { value: "5000+", label: "5,000+", min: 5000, max: undefined },
] as const;
export type EmployeeBand = (typeof EMPLOYEE_BANDS)[number]["value"] | "persona";

export interface PersonaTargeting {
  personaId: number | null;
  targetTitles: string[];
  targetIndustries: string[];
  targetGeographies: string[];
  keywords: string[];
  employeeBand: EmployeeBand;
  /** The persona's own size when no band matches it exactly. */
  personaEmployeeMin: number | null;
  personaEmployeeMax: number | null;
}

/**
 * Everything a persona sets, for the wizard (audit 2026-10-20, A62). Applying
 * one copied titles, industries and keywords only: its places, its company
 * size and the persona itself (whose research the AI writers use) were
 * dropped. A saved persona has an id; a preset has none.
 */
export function personaToTargeting(p: Record<string, any>): PersonaTargeting {
  const min = typeof p.employeeMin === "number" ? p.employeeMin : null;
  const max = typeof p.employeeMax === "number" ? p.employeeMax : null;
  const band = min == null && max == null
    ? EMPLOYEE_BANDS[0]
    : EMPLOYEE_BANDS.find((b) => (b.min ?? null) === min && (b.max ?? null) === max);
  return {
    personaId: typeof p.id === "number" ? p.id : null,
    targetTitles: icpLabels(p.targetTitles, "title"),
    targetIndustries: icpLabels(p.targetIndustries, "industry"),
    targetGeographies: icpLabels(p.targetGeographies, "geography"),
    keywords: icpLabels(p.keywords, "signal"),
    employeeBand: band ? band.value : "persona",
    personaEmployeeMin: band ? null : min,
    personaEmployeeMax: band ? null : max,
  };
}

/** The size the campaign targets: the band's, or the persona's own. */
export function employeeRangeOf(band: EmployeeBand, personaMin: number | null, personaMax: number | null): { employeeMin?: number; employeeMax?: number } {
  if (band === "persona") return { ...(personaMin != null ? { employeeMin: personaMin } : {}), ...(personaMax != null ? { employeeMax: personaMax } : {}) };
  const b = EMPLOYEE_BANDS.find((x) => x.value === band);
  return { ...(b?.min !== undefined ? { employeeMin: b.min } : {}), ...(b?.max !== undefined ? { employeeMax: b.max } : {}) };
}

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
