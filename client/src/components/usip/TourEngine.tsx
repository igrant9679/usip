/**
 * TourEngine — guided tour overlay system (v2)
 *
 * Features:
 *  - Semi-transparent overlay with spotlight cutout around target element
 *  - Pulsing ring on target element
 *  - Floating tooltip card with title, body, progress bar, prev/next/skip
 *  - Confetti burst on tour completion
 *  - Achievement toast on completion
 *  - Proactive trigger: shows a "Start tour?" nudge when user first visits a page
 *  - Supports advance conditions: next_button, element_clicked, route_changed
 *  - Route navigation: each step declares routeTo to navigate before spotlighting
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { useLocation } from "wouter";
import { trpc } from "../../lib/trpc";

/* ─── Types ─────────────────────────────────────────────────────────────── */

export type TourStep = {
  id?: number;
  sortOrder: number;
  targetSelector?: string;
  targetDataTourId?: string;
  /** If set, the engine navigates to this route before spotlighting the target. */
  routeTo?: string;
  title: string;
  bodyMarkdown?: string;
  visualTreatment?: "spotlight" | "pulse" | "arrow" | "coach";
  advanceCondition?: "next_button" | "element_clicked" | "form_field_filled" | "route_changed" | "custom_event";
  skipAllowed?: boolean;
  backAllowed?: boolean;
};

export type Tour = {
  id: number;
  name: string;
  description?: string;
  type: string;
  estimatedMinutes?: number;
  steps: TourStep[];
};

type TourEngineContextType = {
  activeTour: Tour | null;
  currentStepIndex: number;
  startTour: (tour: Tour) => void;
  endTour: () => void;
  nextStep: () => void;
  prevStep: () => void;
  skipTour: () => void;
};

/* ─── Context ────────────────────────────────────────────────────────────── */

const TourEngineContext = createContext<TourEngineContextType>({
  activeTour: null,
  currentStepIndex: 0,
  startTour: () => {},
  endTour: () => {},
  nextStep: () => {},
  prevStep: () => {},
  skipTour: () => {},
});

export function useTourEngine() {
  return useContext(TourEngineContext);
}

/* ─── Confetti ───────────────────────────────────────────────────────────── */

function fireConfetti() {
  const canvas = document.createElement("canvas");
  canvas.style.cssText =
    "position:fixed;top:0;left:0;width:100vw;height:100vh;pointer-events:none;z-index:99999";
  document.body.appendChild(canvas);
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;

  const pieces = Array.from({ length: 120 }, () => ({
    x: Math.random() * canvas.width,
    y: -10,
    r: Math.random() * 6 + 4,
    d: Math.random() * 120,
    color: ["#6366f1", "#8b5cf6", "#ec4899", "#f59e0b", "#10b981"][Math.floor(Math.random() * 5)],
    tilt: Math.random() * 10 - 10,
    tiltAngle: 0,
    tiltAngleIncrement: Math.random() * 0.07 + 0.05,
  }));

  let frame = 0;
  function draw() {
    ctx!.clearRect(0, 0, canvas.width, canvas.height);
    pieces.forEach((p) => {
      ctx!.beginPath();
      ctx!.lineWidth = p.r / 2;
      ctx!.strokeStyle = p.color;
      ctx!.moveTo(p.x + p.tilt + p.r / 4, p.y);
      ctx!.lineTo(p.x + p.tilt, p.y + p.tilt + p.r / 4);
      ctx!.stroke();
    });
    pieces.forEach((p) => {
      p.tiltAngle += p.tiltAngleIncrement;
      p.y += (Math.cos(p.d) + 3 + p.r / 2) / 2;
      p.tilt = Math.sin(p.tiltAngle - frame / 3) * 15;
    });
    frame++;
    if (frame < 180) requestAnimationFrame(draw);
    else canvas.remove();
  }
  requestAnimationFrame(draw);
}

/* ─── Achievement Toast ──────────────────────────────────────────────────── */

function AchievementToast({ badge, onDismiss }: { badge: string; onDismiss: () => void }) {
  useEffect(() => {
    const t = setTimeout(onDismiss, 4000);
    return () => clearTimeout(t);
  }, [onDismiss]);

  return (
    <div
      className="fixed bottom-6 right-6 z-[99998] flex items-center gap-3 rounded-xl bg-gradient-to-r from-violet-600 to-indigo-600 px-5 py-3 text-white shadow-2xl animate-in slide-in-from-bottom-4"
      style={{ animation: "slideUp 0.4s ease" }}
    >
      <span className="text-2xl">{badge.split(" ")[0]}</span>
      <div>
        <p className="text-xs font-medium opacity-80">Achievement Unlocked</p>
        <p className="text-sm font-semibold">{badge.split(" ").slice(1).join(" ")}</p>
      </div>
      <button onClick={onDismiss} className="ml-2 opacity-60 hover:opacity-100 text-lg">×</button>
    </div>
  );
}

/* ─── Spotlight Overlay ──────────────────────────────────────────────────── */

function SpotlightOverlay({
  targetRect,
  treatment,
}: {
  targetRect: DOMRect | null;
  treatment: string;
}) {
  if (!targetRect) {
    return (
      <div
        className="fixed inset-0 z-[9990] bg-black/50"
        style={{ pointerEvents: "none" }}
      />
    );
  }

  const pad = 8;
  const x = targetRect.left - pad;
  const y = targetRect.top - pad;
  const w = targetRect.width + pad * 2;
  const h = targetRect.height + pad * 2;

  return (
    <>
      {/* Dark overlay with SVG cutout */}
      <svg
        className="fixed inset-0 z-[9990]"
        style={{ pointerEvents: "none", width: "100vw", height: "100vh" }}
      >
        <defs>
          <mask id="spotlight-mask">
            <rect width="100%" height="100%" fill="white" />
            <rect x={x} y={y} width={w} height={h} rx="8" fill="black" />
          </mask>
        </defs>
        <rect
          width="100%"
          height="100%"
          fill="rgba(0,0,0,0.55)"
          mask="url(#spotlight-mask)"
        />
        {/* Spotlight border */}
        <rect
          x={x}
          y={y}
          width={w}
          height={h}
          rx="8"
          fill="none"
          stroke="rgba(99,102,241,0.8)"
          strokeWidth="2"
        />
      </svg>

      {/* Pulsing ring for pulse treatment */}
      {treatment === "pulse" && (
        <div
          className="fixed z-[9991] rounded-lg pointer-events-none"
          style={{
            left: x - 4,
            top: y - 4,
            width: w + 8,
            height: h + 8,
            boxShadow: "0 0 0 0 rgba(99,102,241,0.7)",
            animation: "tourPulse 1.5s infinite",
          }}
        />
      )}
    </>
  );
}

/* ─── Tooltip Card ───────────────────────────────────────────────────────── */

function TooltipCard({
  step,
  stepIndex,
  totalSteps,
  targetRect,
  onNext,
  onPrev,
  onSkip,
  onEnd,
}: {
  step: TourStep;
  stepIndex: number;
  totalSteps: number;
  targetRect: DOMRect | null;
  onNext: () => void;
  onPrev: () => void;
  onSkip: () => void;
  onEnd: () => void;
}) {
  const isLast = stepIndex === totalSteps - 1;
  const progress = ((stepIndex + 1) / totalSteps) * 100;

  // Position tooltip: prefer below target, fall back to above, then center
  let style: React.CSSProperties = { position: "fixed", zIndex: 9995 };
  if (targetRect) {
    const spaceBelow = window.innerHeight - targetRect.bottom;
    const tooltipH = 200;
    const tooltipW = 340;
    const left = Math.min(Math.max(targetRect.left, 16), window.innerWidth - tooltipW - 16);
    if (spaceBelow > tooltipH + 20) {
      style = { ...style, top: targetRect.bottom + 16, left };
    } else {
      style = { ...style, top: Math.max(targetRect.top - tooltipH - 16, 16), left };
    }
  } else {
    style = { ...style, top: "50%", left: "50%", transform: "translate(-50%, -50%)" };
  }

  return (
    <div
      style={style}
      className="w-[340px] rounded-xl bg-white shadow-2xl border border-violet-100 overflow-hidden"
    >
      {/* Progress bar */}
      <div className="h-1 bg-violet-100">
        <div
          className="h-full bg-gradient-to-r from-violet-500 to-indigo-500 transition-all duration-300"
          style={{ width: `${progress}%` }}
        />
      </div>

      <div className="p-4">
        {/* Step counter */}
        <p className="text-xs text-violet-500 font-medium mb-1">
          Step {stepIndex + 1} of {totalSteps}
        </p>

        {/* Title */}
        <h3 className="text-sm font-semibold text-gray-900 mb-2">{step.title}</h3>

        {/* Body */}
        {step.bodyMarkdown && (
          <p className="text-xs text-gray-600 leading-relaxed mb-3 whitespace-pre-wrap">
            {step.bodyMarkdown.replace(/[#*`]/g, "")}
          </p>
        )}

        {/* Actions */}
        <div className="flex items-center justify-between gap-2">
          <div className="flex gap-1">
            {step.backAllowed !== false && stepIndex > 0 && (
              <button
                onClick={onPrev}
                className="px-3 py-1.5 text-xs text-gray-500 hover:text-gray-700 border border-gray-200 rounded-lg"
              >
                ← Back
              </button>
            )}
            {step.skipAllowed !== false && (
              <button
                onClick={onSkip}
                className="px-3 py-1.5 text-xs text-gray-400 hover:text-gray-600"
              >
                Skip tour
              </button>
            )}
          </div>
          <button
            onClick={isLast ? onEnd : onNext}
            className="px-4 py-1.5 text-xs font-medium text-white bg-violet-600 hover:bg-violet-700 rounded-lg"
          >
            {isLast ? "Finish 🎉" : "Next →"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ─── Proactive Nudge ────────────────────────────────────────────────────── */

export function TourNudge({
  tour,
  onStart,
  onDismiss,
}: {
  tour: { id: number; name: string; estimatedMinutes?: number };
  onStart: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className="fixed bottom-20 right-6 z-[9980] w-72 rounded-xl bg-white shadow-xl border border-violet-100 p-4 animate-in slide-in-from-bottom-4">
      <div className="flex items-start gap-3">
        <div className="w-8 h-8 rounded-full bg-violet-100 flex items-center justify-center flex-shrink-0">
          <span className="text-violet-600 text-sm">🎓</span>
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-xs font-semibold text-gray-800">New here?</p>
          <p className="text-xs text-gray-500 mt-0.5 line-clamp-2">
            Take a quick tour of {tour.name}
            {tour.estimatedMinutes ? ` (~${tour.estimatedMinutes} min)` : ""}
          </p>
          <div className="flex gap-2 mt-2">
            <button
              onClick={onStart}
              className="px-3 py-1 text-xs font-medium text-white bg-violet-600 hover:bg-violet-700 rounded-lg"
            >
              Start tour
            </button>
            <button
              onClick={onDismiss}
              className="px-3 py-1 text-xs text-gray-400 hover:text-gray-600"
            >
              Not now
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ─── TourEngine Provider ────────────────────────────────────────────────── */

export function TourEngineProvider({ children }: { children: React.ReactNode }) {
  const [activeTour, setActiveTour] = useState<Tour | null>(null);
  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  const [targetRect, setTargetRect] = useState<DOMRect | null>(null);
  const [achievementBadge, setAchievementBadge] = useState<string | null>(null);
  const rafRef = useRef<number>(0);
  const [, navigate] = useLocation();

  const completeMut = trpc.tours.completeTour.useMutation();
  const skipMut = trpc.tours.skipTour.useMutation();
  const advanceMut = trpc.tours.advanceStep.useMutation();

  /**
   * Navigate to a step's routeTo path if it differs from the current URL,
   * then wait two animation frames for the new page to mount before the
   * spotlight RAF loop tries to find the target element.
   */
  const navigateToStep = useCallback(
    (step: TourStep, currentPath: string) => {
      if (step.routeTo && step.routeTo !== currentPath) {
        navigate(step.routeTo);
      }
    },
    [navigate],
  );

  // Find target element for current step
  const findTarget = useCallback((step: TourStep): Element | null => {
    if (step.targetDataTourId) {
      return document.querySelector(`[data-tour-id="${step.targetDataTourId}"]`);
    }
    if (step.targetSelector) {
      return document.querySelector(step.targetSelector);
    }
    return null;
  }, []);

  // Update spotlight rect on every animation frame while tour is active
  useEffect(() => {
    if (!activeTour) return;
    const step = activeTour.steps[currentStepIndex];
    if (!step) return;

    function updateRect() {
      const el = findTarget(step);
      if (el) {
        const rect = el.getBoundingClientRect();
        setTargetRect(rect);
        // Scroll element into view if needed
        if (rect.top < 0 || rect.bottom > window.innerHeight) {
          el.scrollIntoView({ behavior: "smooth", block: "center" });
        }
      } else {
        setTargetRect(null);
      }
      rafRef.current = requestAnimationFrame(updateRect);
    }
    rafRef.current = requestAnimationFrame(updateRect);
    return () => cancelAnimationFrame(rafRef.current);
  }, [activeTour, currentStepIndex, findTarget]);

  // Wire advance condition: element_clicked
  useEffect(() => {
    if (!activeTour) return;
    const step = activeTour.steps[currentStepIndex];
    if (!step || step.advanceCondition !== "element_clicked") return;
    const el = findTarget(step);
    if (!el) return;
    const handler = () => nextStep();
    el.addEventListener("click", handler, { once: true });
    return () => el.removeEventListener("click", handler);
  });

  const startTour = useCallback(
    (tour: Tour) => {
      setActiveTour(tour);
      setCurrentStepIndex(0);
      // Navigate to the first step's route if specified
      const firstStep = tour.steps[0];
      if (firstStep?.routeTo) {
        navigate(firstStep.routeTo);
      }
    },
    [navigate],
  );

  const endTour = useCallback(() => {
    if (!activeTour) return;
    completeMut.mutate(
      { tourId: activeTour.id },
      {
        onSuccess: (data) => {
          fireConfetti();
          setAchievementBadge(data.badge);
        },
      },
    );
    setActiveTour(null);
    setTargetRect(null);
    cancelAnimationFrame(rafRef.current);
  }, [activeTour, completeMut]);

  const nextStep = useCallback(() => {
    if (!activeTour) return;
    const next = currentStepIndex + 1;
    if (next >= activeTour.steps.length) {
      endTour();
      return;
    }
    advanceMut.mutate({ tourId: activeTour.id, stepIndex: next });
    setCurrentStepIndex(next);
    // Navigate to the next step's route if specified
    const nextStepData = activeTour.steps[next];
    if (nextStepData?.routeTo) {
      navigate(nextStepData.routeTo);
    }
  }, [activeTour, currentStepIndex, endTour, advanceMut, navigate]);

  const prevStep = useCallback(() => {
    if (!activeTour || currentStepIndex === 0) return;
    const prev = currentStepIndex - 1;
    advanceMut.mutate({ tourId: activeTour.id, stepIndex: prev });
    setCurrentStepIndex(prev);
    // Navigate to the previous step's route if specified
    const prevStepData = activeTour.steps[prev];
    if (prevStepData?.routeTo) {
      navigate(prevStepData.routeTo);
    }
  }, [activeTour, currentStepIndex, advanceMut, navigate]);

  const skipTour = useCallback(() => {
    if (!activeTour) return;
    skipMut.mutate({ tourId: activeTour.id });
    setActiveTour(null);
    setTargetRect(null);
    cancelAnimationFrame(rafRef.current);
  }, [activeTour, skipMut]);

  // Suppress unused-variable warning for navigateToStep (used by external callers via context if needed)
  void navigateToStep;

  const currentStep = activeTour?.steps[currentStepIndex];

  return (
    <TourEngineContext.Provider
      value={{ activeTour, currentStepIndex, startTour, endTour, nextStep, prevStep, skipTour }}
    >
      {children}

      {/* Pulse animation style */}
      <style>{`
        @keyframes tourPulse {
          0% { box-shadow: 0 0 0 0 rgba(99,102,241,0.7); }
          70% { box-shadow: 0 0 0 12px rgba(99,102,241,0); }
          100% { box-shadow: 0 0 0 0 rgba(99,102,241,0); }
        }
      `}</style>

      {/* Overlay + spotlight */}
      {activeTour && currentStep && (
        <>
          <SpotlightOverlay
            targetRect={targetRect}
            treatment={currentStep.visualTreatment ?? "spotlight"}
          />
          <TooltipCard
            step={currentStep}
            stepIndex={currentStepIndex}
            totalSteps={activeTour.steps.length}
            targetRect={targetRect}
            onNext={nextStep}
            onPrev={prevStep}
            onSkip={skipTour}
            onEnd={endTour}
          />
        </>
      )}

      {/* Achievement toast */}
      {achievementBadge && (
        <AchievementToast
          badge={achievementBadge}
          onDismiss={() => setAchievementBadge(null)}
        />
      )}
    </TourEngineContext.Provider>
  );
}
