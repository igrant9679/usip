import { useLocation } from "wouter";
import { useEffect, useRef, useState } from "react";

const STORAGE_KEY = "velocity-reduce-motion";

/** Read the current reduce-motion preference from localStorage */
export function getReduceMotion(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

/** Persist the reduce-motion preference to localStorage */
export function setReduceMotion(value: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(value));
    // Dispatch a storage event so other tabs / components can react
    window.dispatchEvent(new StorageEvent("storage", { key: STORAGE_KEY, newValue: String(value) }));
  } catch {
    // ignore
  }
}

/** Hook to read + subscribe to the reduce-motion preference */
export function useReduceMotion(): [boolean, (v: boolean) => void] {
  const [reduceMotion, setLocal] = useState<boolean>(getReduceMotion);

  useEffect(() => {
    const handler = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) setLocal(e.newValue === "true");
    };
    window.addEventListener("storage", handler);
    return () => window.removeEventListener("storage", handler);
  }, []);

  const toggle = (v: boolean) => {
    setReduceMotion(v);
    setLocal(v);
  };

  return [reduceMotion, toggle];
}

/**
 * PageTransition wraps the main content area and applies a brief
 * fade + slide-up animation whenever the route changes.
 * Respects the "Reduce motion" preference stored in localStorage.
 */
export function PageTransition({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const [visible, setVisible] = useState(true);
  const prevLocation = useRef(location);
  const [reduceMotion] = useReduceMotion();

  useEffect(() => {
    if (location !== prevLocation.current) {
      if (reduceMotion) {
        // Skip animation — just swap content immediately
        prevLocation.current = location;
        return;
      }
      setVisible(false);
      const t = setTimeout(() => {
        prevLocation.current = location;
        setVisible(true);
      }, 80);
      return () => clearTimeout(t);
    }
  }, [location, reduceMotion]);

  return (
    <div
      style={{
        opacity: visible ? 1 : 0,
        transform: visible ? "translateY(0)" : "translateY(6px)",
        transition: reduceMotion ? "none" : "opacity 180ms ease, transform 180ms ease",
        height: "100%",
        display: "flex",
        flexDirection: "column",
      }}
    >
      {children}
    </div>
  );
}
