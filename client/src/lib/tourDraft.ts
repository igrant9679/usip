/**
 * What the Tour Builder form holds, and what it sends (audit 2026-10-20, G20).
 *
 * Kept apart from the page so the mapping can be tested without rendering it:
 *   - a saved step keeps its id, so a save updates it instead of inserting a
 *     second copy (every save used to duplicate every step);
 *   - the page key is sent as `pageKey`, the field the server reads (it was sent
 *     as `triggerPageKey` and stripped);
 *   - status is draft or published only, the two the server and the table have
 *     ("Archived" was offered and always refused).
 */

export const TOUR_STATUSES = ["draft", "published"] as const;
export type TourStatus = (typeof TOUR_STATUSES)[number];

export type StepDraft = {
  /** Present on a step that is already saved. */
  id?: number;
  sortOrder: number;
  targetDataTourId: string;
  targetSelector: string;
  title: string;
  bodyMarkdown: string;
  visualTreatment: string;
  advanceCondition: string;
  skipAllowed: boolean;
  backAllowed: boolean;
};

export type TourFormState = {
  name: string;
  description: string;
  type: string;
  pageKey: string;
  estimatedMinutes: string;
  status: TourStatus;
};

export function defaultStep(sortOrder: number): StepDraft {
  return {
    sortOrder,
    targetDataTourId: "",
    targetSelector: "",
    title: "",
    bodyMarkdown: "",
    visualTreatment: "spotlight",
    advanceCondition: "next_button",
    skipAllowed: true,
    backAllowed: true,
  };
}

export function tourFormFrom(initial: any): TourFormState {
  return {
    name: initial?.name ?? "",
    description: initial?.description ?? "",
    type: initial?.type ?? "feature",
    pageKey: initial?.pageKey ?? "",
    estimatedMinutes: initial?.estimatedMinutes?.toString() ?? "",
    status: initial?.status === "published" ? "published" : "draft",
  };
}

export function stepDraftsFrom(initial: any): StepDraft[] {
  if (!initial?.steps?.length) return [defaultStep(0)];
  return initial.steps.map((s: any) => ({
    ...(typeof s.id === "number" ? { id: s.id } : {}),
    sortOrder: s.sortOrder,
    targetDataTourId: s.targetDataTourId ?? "",
    targetSelector: s.targetSelector ?? "",
    title: s.title ?? "",
    bodyMarkdown: s.bodyMarkdown ?? "",
    visualTreatment: s.visualTreatment ?? "spotlight",
    advanceCondition: s.advanceCondition ?? "next_button",
    skipAllowed: s.skipAllowed ?? true,
    backAllowed: s.backAllowed ?? true,
  }));
}

/** The body for tours.create / tours.update. The step list is the whole list. */
export function tourSavePayload(form: TourFormState, steps: StepDraft[]) {
  const minutes = form.estimatedMinutes ? parseInt(form.estimatedMinutes, 10) : NaN;
  return {
    name: form.name,
    description: form.description,
    type: form.type as "onboarding" | "feature" | "whats_new" | "custom",
    pageKey: form.pageKey.trim() || null,
    estimatedMinutes: Number.isFinite(minutes) ? minutes : undefined,
    status: form.status,
    steps: steps.map((s, i) => ({ ...s, sortOrder: i })),
  };
}
