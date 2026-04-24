import { useLocation } from "wouter";
import { useEffect, useRef, useState } from "react";

/**
 * PageTransition wraps the main content area and applies a brief
 * fade + slide-up animation whenever the route changes.
 * Uses pure CSS transitions — no extra dependencies required.
 */
export function PageTransition({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const [visible, setVisible] = useState(true);
  const prevLocation = useRef(location);

  useEffect(() => {
    if (location !== prevLocation.current) {
      // Briefly hide (fade out), then show new content (fade in)
      setVisible(false);
      const t = setTimeout(() => {
        prevLocation.current = location;
        setVisible(true);
      }, 80); // 80ms out → swap → fade in
      return () => clearTimeout(t);
    }
  }, [location]);

  return (
    <div
      style={{
        opacity: visible ? 1 : 0,
        transform: visible ? "translateY(0)" : "translateY(6px)",
        transition: "opacity 180ms ease, transform 180ms ease",
        height: "100%",
        display: "flex",
        flexDirection: "column",
      }}
    >
      {children}
    </div>
  );
}
