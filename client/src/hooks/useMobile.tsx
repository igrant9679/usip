import * as React from "react";

export const MOBILE_BREAKPOINT = 768;

const isPhoneWidth = () =>
  typeof window !== "undefined" && window.innerWidth < MOBILE_BREAKPOINT;

export function useIsMobile() {
  // Read the width on the first render, so a phone never paints the desktop
  // layout first and then swaps it (a rail flashing open, then into a sheet).
  const [isMobile, setIsMobile] = React.useState<boolean>(isPhoneWidth);

  React.useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
    const onChange = () => {
      setIsMobile(window.innerWidth < MOBILE_BREAKPOINT);
    };
    mql.addEventListener("change", onChange);
    setIsMobile(window.innerWidth < MOBILE_BREAKPOINT);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  return isMobile;
}
