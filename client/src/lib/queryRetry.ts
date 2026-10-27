/**
 * When a failed query is worth trying again (audit 2026-10-20, Phase 4, X1.6).
 *
 * React Query retried every failure three times, a few seconds apart, and a
 * page shows its loading state the whole time. A record that is not there,
 * not this workspace's, or not allowed answers the same on every try, so the
 * page spun for several seconds before it could say so (L4, L5): the ARE
 * campaign page and a bad proposal link looked like they would never load.
 * The server's answer to a 4xx is final; a network failure or a 5xx may not be.
 */
export const MAX_QUERY_RETRIES = 3;

export function httpStatusOf(error: unknown): number | null {
  const status = (error as { data?: { httpStatus?: unknown } } | null)?.data?.httpStatus;
  return typeof status === "number" ? status : null;
}

export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  const status = httpStatusOf(error);
  if (status !== null && status >= 400 && status < 500) return false;
  return failureCount < MAX_QUERY_RETRIES;
}
