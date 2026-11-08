/**
 * The working-out behind the v2 sequence editor's Contacts tab and template
 * picker, kept apart from the page so it can be run on its own.
 */

export type EmailStep = {
  type: "email";
  subject: string;
  body?: string;
  /** Where the copy came from. The engine sends subject and body, never this. */
  templateId?: number;
  /** "dynamic": the engine has AI write subject and body per person when the step runs. */
  emailMode?: "typed" | "dynamic";
  aiTone?: string;
  aiLength?: string;
  aiFocus?: string;
  enabled?: boolean;
};

export type TemplateChoice = {
  id: number;
  name?: string | null;
  subject?: string | null;
  htmlOutput?: string | null;
  status?: string | null;
};

/** An empty rich-text editor leaves markup behind, so markup alone is not writing. */
export function hasBodyContent(html: string | null | undefined): boolean {
  const body = html ?? "";
  if (/<img\b/i.test(body)) return true;
  return body.replace(/<[^>]*>/g, " ").replace(/&nbsp;/gi, " ").trim() !== "";
}

/** Would using a template lose something? An AI-written step loses being AI-written. */
export function templateWouldReplace(step: EmailStep): boolean {
  return step.emailMode === "dynamic" || step.subject.trim() !== "" || hasBodyContent(step.body);
}

/**
 * Templates a step can use. Archived ones are retired, and one that was never
 * built has no HTML, so picking it would blank the email.
 */
export function usableTemplates<T extends TemplateChoice>(list: readonly T[]): T[] {
  return list.filter((t) => t.status !== "archived" && hasBodyContent(t.htmlOutput));
}

/**
 * The step with a copy of the template. It stays a copy: what is stored here is
 * what sends, so a later edit to the template does not reach this step. A
 * dynamic step has to become a typed one, or the engine ignores the copy and
 * writes its own.
 */
export function applyTemplate<S extends EmailStep>(step: S, template: TemplateChoice): S {
  return {
    ...step,
    subject: template.subject?.trim() ? template.subject : step.subject,
    body: template.htmlOutput ?? "",
    templateId: template.id,
    ...(step.emailMode === "dynamic" ? { emailMode: "typed" as const } : {}),
  };
}

/** The step with its link to the template dropped, so its text can be edited here. */
export function detachTemplate<S extends EmailStep>(step: S): S {
  const { templateId: _dropped, ...rest } = step;
  return rest as S;
}

/**
 * The window a sequence's email steps are drafted in, as the engine reads its
 * settings (resolveSendSettings in server/sequenceEngine.ts): 08:00 to 18:00
 * unless set, in the sequence's own zone or else the workspace's, weekends
 * skipped unless switched off (audit 2026-10-20, O39).
 */
export function describeSendWindow(settings: unknown): string {
  const s = (settings ?? {}) as { timezone?: string | null; sendWindowStart?: string | null; sendWindowEnd?: string | null; skipWeekends?: boolean | null };
  const start = s.sendWindowStart || "08:00";
  const end = s.sendWindowEnd || "18:00";
  const zone = s.timezone || "the workspace's time zone";
  const days = s.skipWeekends === false ? "every day" : "Monday to Friday";
  return `Email steps are drafted between ${start} and ${end} (${zone}), ${days}.`;
}

/** The longest wait a step keeps: the server's step schema caps it at 60 days. */
export const MAX_WAIT_DAYS = 60;

/**
 * A wait as whole days and hours (U14). The retired canvas wrote hours into a
 * wait (`days` is fractional: 1 day 6 hours is 1.25), and the v2 editor showed
 * one whole-number box, so it could not show or keep such a wait faithfully.
 */
export function waitParts(days: unknown): { days: number; hours: number } {
  const total = Number(days);
  if (!Number.isFinite(total) || total <= 0) return { days: 0, hours: 0 };
  let whole = Math.floor(total + 1e-9);
  let hours = Math.round((total - whole) * 24);
  if (hours >= 24) { whole += 1; hours = 0; }
  return { days: whole, hours };
}

/** Days and hours back to the step's `days`, kept whole when there are no hours. */
export function waitDaysFrom(days: number, hours: number): number {
  const d = Math.max(0, Math.floor(Number(days) || 0));
  const h = Math.max(0, Math.min(23, Math.floor(Number(hours) || 0)));
  return Math.min(MAX_WAIT_DAYS, h === 0 ? d : d + h / 24);
}

/**
 * A/B variants belong to a step's POSITION (`sequence_ab_variants.stepIndex`,
 * which the engine matches against the step it is running). Moving or
 * removing a step does not move them, so a variant would start sending at a
 * different step. Returns the first step, in the order given, that has
 * variants and whose position this change would alter, or null when the change
 * is safe. U14: legacy /sequences let the steps move under their variants.
 */
export function stepWithDisplacedVariants(
  change: { kind: "move"; from: number; to: number } | { kind: "remove"; at: number },
  stepCount: number,
  variantsByStep: ReadonlyMap<number, number>,
): number | null {
  const moved = change.kind === "move"
    ? [change.from, change.to]
    : Array.from({ length: Math.max(0, stepCount - change.at) }, (_, k) => change.at + k);
  for (const i of moved) if ((variantsByStep.get(i) ?? 0) > 0) return i;
  return null;
}

/**
 * How many people sit at each step. Only active and paused people sit anywhere:
 * someone finished or exited has left, though their row still names a step.
 *
 * Counted off the rows the tab already lists, so this can't disagree with them.
 * Someone can be past the end if steps were deleted after they enrolled, and
 * they are counted rather than dropped, so the bars still add up.
 */
export function stepDistribution(
  rows: readonly { status?: unknown; currentStep?: unknown }[],
  stepCount: number,
): { perStep: number[]; beyond: number; total: number } {
  const perStep = Array.from({ length: stepCount }, () => 0);
  let beyond = 0;
  let total = 0;
  for (const r of rows) {
    if (r.status !== "active" && r.status !== "paused") continue;
    total++;
    const at = typeof r.currentStep === "number" && r.currentStep >= 0 ? r.currentStep : 0;
    if (at < stepCount) perStep[at]++;
    else beyond++;
  }
  return { perStep, beyond, total };
}
