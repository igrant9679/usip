/**
 * RetiredRedirect — one component for the v1 paths retired in Phase 5 item 2
 * (audit 2026-10-20). The mapping, and why each path is on it, lives in
 * `@/lib/retiredRoutes`; this only performs the hop.
 *
 * `replace: true` keeps the retired path out of the history stack, so Back
 * from the v2 page returns where the reader actually came from instead of
 * bouncing them through the redirect again.
 *
 * The route's params and the query string ride along (U14, F25): a canvas
 * deep link keeps its sequence id, and /mailbox?reply=12 still opens reply 12.
 */
import { useEffect } from "react";
import { useLocation, useParams, useSearch } from "wouter";
import { retiredRedirectUrl, type RetiredRoute } from "@/lib/retiredRoutes";

export default function RetiredRedirect({ from }: { from: RetiredRoute }) {
  const [, setLocation] = useLocation();
  const params = useParams() as Record<string, string | undefined>;
  const search = useSearch();
  const to = retiredRedirectUrl(from, { params, search });
  useEffect(() => { setLocation(to, { replace: true }); }, [to, setLocation]);
  return null;
}
