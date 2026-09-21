/**
 * areSequenceTemplates.ts — the ONE table behind the ARE sequence templates.
 *
 * The picker and the generator used to hold separate opinions about the same
 * four values. ARESettings printed "Aggressive 3-Step — 3 emails in 7 days"
 * and "Nurture 14-Step — 14 touches over 60 days" while the generator asked
 * the model for `campaign.sequenceTemplate === "standard_7step" ? 7 : 5` — so
 * BOTH of those campaigns produced five steps, and the two named counts were
 * decoration. The 21/60-day spans were never true either: the campaign owns
 * the cadence (shared/areStepCadence.ts, one week per step by default), so a
 * 7-step sequence has always spanned six weeks.
 *
 * Label and count now sit on the same object, so they cannot disagree, and
 * server/areSequenceTemplateSteps.test.ts pins that any label naming an
 * "N-Step" carries exactly N.
 */

export interface AreSequenceTemplate {
  value: string;
  label: string;
  steps: number;
  description: string;
}

/**
 * Steps for a template value that is not in the table. This is today's
 * behaviour for every non-standard value and must not change: sequenceTemplate
 * is z.string() on both writers (are/campaigns.ts update, admin.ts settings
 * save), so an arbitrary value is storable and an existing odd row must not
 * change its step count unannounced.
 */
export const FALLBACK_TEMPLATE_STEPS = 5;

/** Matches the `are_campaigns.sequenceTemplate` column default. */
export const DEFAULT_ARE_SEQUENCE_TEMPLATE = "standard_7step";

export const ARE_SEQUENCE_TEMPLATES: readonly AreSequenceTemplate[] = [
  {
    value: "standard_7step",
    label: "Standard 7-Step",
    steps: 7,
    description: "7 steps across the channels this campaign has enabled. At the campaign's default weekly step gap that is six weeks end to end.",
  },
  {
    value: "aggressive_3step",
    label: "Aggressive 3-Step",
    steps: 3,
    description: "3 steps. Shorten the campaign's step gap for a high-velocity run on a warm list.",
  },
  {
    value: "nurture_14step",
    label: "Nurture 14-Step",
    steps: 14,
    description: "14 steps for long enterprise cycles - about three months at the campaign's default weekly step gap.",
  },
  {
    value: "custom",
    label: "Custom",
    steps: FALLBACK_TEMPLATE_STEPS,
    description: "5 steps whose structure the AI designs from the campaign ICP, channels and sequence prompt.",
  },
];

/** Total by construction: an unknown or null value keeps today's 5. */
export function stepCountForTemplate(value: string | null | undefined): number {
  const t = ARE_SEQUENCE_TEMPLATES.find((x) => x.value === value);
  return t ? t.steps : FALLBACK_TEMPLATE_STEPS;
}

/**
 * Output-token budget for a one-shot call that has to carry `steps` written
 * emails. Both sequence calls send every step in a single JSON object, so the
 * response length scales with the step count and the provider defaults (8192
 * on the Anthropic structured-tool path, 4096 on OpenAI and Gemini) stop being
 * enough well before 14 steps — and a truncated response is not a short
 * sequence, it is parseLlmJson throwing and generation failing for every
 * prospect on the campaign. Floored at 8192 so no campaign that works today
 * gets a SMALLER budget than it has now.
 */
export function sequenceMaxTokens(steps: number): number {
  return Math.max(8192, Math.min(16000, 1100 * steps));
}
