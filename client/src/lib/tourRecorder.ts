/**
 * tourRecorder — capture tour steps by clicking through the app.
 *
 * Replaces the old phantom `window.__startTourRecorder()` console flow (those
 * globals were never defined). A module-level capture-phase click listener +
 * sessionStorage means recording survives SPA route changes AND full reloads,
 * so an admin can Start on /tour-builder, walk the real flow across pages, then
 * come back and Stop to get the step JSON.
 *
 * Clicks are NOT prevented — the admin is walking a real flow — so avoid
 * clicking destructive controls while recording. The recorder's own UI is
 * tagged [data-tour-recorder-ui] and ignored.
 */
export type RecordedStep = {
  targetDataTourId?: string;
  targetSelector?: string;
  routeTo: string;
  title: string;
};

const FLAG_KEY = "__tour_recording__";
const STEPS_KEY = "__tour_recorded_steps__";
const EVENT = "tour-recorder-update";

function emit() {
  window.dispatchEvent(new CustomEvent(EVENT));
}

export function getSteps(): RecordedStep[] {
  try {
    return JSON.parse(sessionStorage.getItem(STEPS_KEY) || "[]");
  } catch {
    return [];
  }
}

export function isRecording(): boolean {
  return sessionStorage.getItem(FLAG_KEY) === "1";
}

/** Build a short, reasonably-stable CSS selector for an element. */
function cssPath(el: Element): string {
  if (el.id) return `#${CSS.escape(el.id)}`;
  const parts: string[] = [];
  let node: Element | null = el;
  let depth = 0;
  while (node && node.nodeType === 1 && depth < 4) {
    let sel = node.tagName.toLowerCase();
    const cls = (node.getAttribute("class") || "")
      .trim()
      .split(/\s+/)
      .filter((c) => c && !c.includes(":") && !c.includes("[")) // skip variant/arbitrary classes
      .slice(0, 2);
    if (cls.length) sel += "." + cls.map((c) => CSS.escape(c)).join(".");
    const parent: Element | null = node.parentElement;
    if (parent) {
      const sameTag = Array.from(parent.children).filter((c) => c.tagName === node!.tagName);
      if (sameTag.length > 1) sel += `:nth-of-type(${sameTag.indexOf(node) + 1})`;
    }
    parts.unshift(sel);
    if (node.id) break;
    node = node.parentElement;
    depth++;
  }
  return parts.join(" > ");
}

function onClick(e: MouseEvent) {
  const target = e.target as Element | null;
  if (!target || target.nodeType !== 1) return;
  if (target.closest("[data-tour-recorder-ui]")) return; // ignore the recorder UI itself

  const tourEl = target.closest("[data-tour-id]");
  const labelEl = target.closest("button,a,[role='button'],input,textarea,select") || target;
  const step: RecordedStep = {
    routeTo: location.pathname,
    title: (
      (tourEl?.getAttribute("aria-label") ||
        labelEl.getAttribute?.("aria-label") ||
        (labelEl.textContent || "")) as string
    )
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 60),
  };
  if (tourEl) step.targetDataTourId = tourEl.getAttribute("data-tour-id") || undefined;
  else step.targetSelector = cssPath(labelEl);

  const steps = getSteps();
  steps.push(step);
  sessionStorage.setItem(STEPS_KEY, JSON.stringify(steps));
  emit();
}

export function startRecording(): void {
  sessionStorage.setItem(FLAG_KEY, "1");
  sessionStorage.setItem(STEPS_KEY, "[]");
  document.removeEventListener("click", onClick, true);
  document.addEventListener("click", onClick, true);
  emit();
}

export function stopRecording(): RecordedStep[] {
  sessionStorage.removeItem(FLAG_KEY);
  document.removeEventListener("click", onClick, true);
  emit();
  return getSteps();
}

export function clearSteps(): void {
  sessionStorage.setItem(STEPS_KEY, "[]");
  emit();
}

export function onRecorderUpdate(cb: () => void): () => void {
  window.addEventListener(EVENT, cb);
  return () => window.removeEventListener(EVENT, cb);
}

// Re-attach the listener after a full page reload if a recording was in progress.
if (typeof document !== "undefined" && isRecording()) {
  document.addEventListener("click", onClick, true);
}
