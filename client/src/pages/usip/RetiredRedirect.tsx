/**
 * RetiredRedirect — one component for the v1 paths retired in Phase 5 item 2
 * (audit 2026-10-20). The mapping, and why each path is on it, lives in
 * `@/lib/retiredRoutes`; this only performs the hop.
 *
 * `replace: true` keeps the retired path out of the history stack, so Back
 * from the v2 page returns where the reader actually came from instead of
 * bouncing them through the redirect again.
 */
import { useEffect } from "react";
import { useLocation } from "wouter";
import { retiredRedirectUrl, type RetiredRoute } from "@/lib/retiredRoutes";

export default function RetiredRedirect({ from }: { from: RetiredRoute }) {
  const [, setLocation] = useLocation();
  useEffect(() => { setLocation(retiredRedirectUrl(from), { replace: true }); }, [from, setLocation]);
  return null;
}
