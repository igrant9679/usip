/**
 * QueryState — a query's four outcomes, kept apart (audit 2026-10-20, Phase 4,
 * U2 / X1.6).
 *
 * About thirty screens rendered a failed load as their empty state ("No
 * routing rules yet", "No lists yet"), which reads as "there is nothing" and
 * invites a duplicate, and several spun forever on a record that does not
 * exist. Loading, failed (with Retry), empty, and not found are different
 * facts; a screen hands its query here and says what to show for each. Screens
 * with their own skeletons keep them and add the same error branch
 * (QueryError in Shell.tsx).
 *
 * A refetch that fails while data is already on screen keeps the data and
 * says the refresh failed, rather than blanking a page that was fine.
 */
import { useEffect, useState, type ReactNode } from "react";
import { useQueryClient, type Query } from "@tanstack/react-query";
import { SearchX } from "lucide-react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { EmptyState, QueryError, TableSkeleton } from "./Shell";
import { httpStatusOf } from "@/lib/queryRetry";

export function isNotFoundError(error: unknown): boolean {
  const code = (error as { data?: { code?: unknown } } | null)?.data?.code;
  return code === "NOT_FOUND" || httpStatusOf(error) === 404;
}

export function errorMessage(error: unknown): string | undefined {
  const m = (error as { message?: unknown } | null)?.message;
  return typeof m === "string" ? m : undefined;
}

export function NotFoundState({ what, backHref, backLabel }: { what: string; backHref?: string; backLabel?: string }) {
  return (
    <EmptyState
      icon={SearchX}
      title={`${what.charAt(0).toUpperCase()}${what.slice(1)} not found`}
      description="It may have been deleted, or it belongs to another workspace."
      action={backHref ? <Button asChild variant="outline" size="sm"><Link href={backHref}>{backLabel ?? "Back"}</Link></Button> : undefined}
    />
  );
}

/** Queries mounted on this page that failed and have nothing to show. */
export function failedActiveQueries(queries: Query[]): Query[] {
  return queries.filter((q) => q.getObserversCount() > 0 && q.state.status === "error" && q.state.data === undefined);
}

/**
 * For pages built from many small cards (Home, Analytics): a card whose query
 * failed showed 0, and a zero you cannot tell from a failure is worse than no
 * number (audit 2026-10-20, G57). One line names how many parts did not
 * load, with Retry for exactly those.
 */
export function FailedLoadsBanner() {
  const client = useQueryClient();
  const [failed, setFailed] = useState<Query[]>([]);
  useEffect(() => {
    const cache = client.getQueryCache();
    const check = () => setFailed(failedActiveQueries(cache.getAll()));
    check();
    return cache.subscribe(check);
  }, [client]);
  if (failed.length === 0) return null;
  return (
    <QueryError
      compact
      what={failed.length === 1 ? "one part of this page" : `${failed.length} parts of this page`}
      message="What is missing is left blank or shows 0 until it loads; it is not a real zero."
      onRetry={() => { for (const q of failed) void q.fetch(); }}
    />
  );
}

export interface QueryLike<T> {
  data: T | undefined;
  error: unknown;
  isLoading: boolean;
  refetch: () => unknown;
}

export function QueryState<T>({ query, what, loading, isEmpty, empty, notFound, children }: {
  query: QueryLike<T>;
  /** What is being loaded, for the messages: "routing rules", "this campaign". */
  what: string;
  loading?: ReactNode;
  isEmpty?: (data: T) => boolean;
  empty?: ReactNode;
  notFound?: ReactNode;
  children: (data: T) => ReactNode;
}) {
  const retry = () => { void query.refetch(); };
  if (query.error && query.data == null) {
    if (isNotFoundError(query.error)) return <>{notFound ?? <NotFoundState what={what} />}</>;
    return <QueryError what={what} message={errorMessage(query.error)} onRetry={retry} />;
  }
  if (query.data == null) {
    // Finished with nothing (a lookup that returned null): not found.
    if (!query.isLoading && query.data === null) return <>{notFound ?? <NotFoundState what={what} />}</>;
    return <>{loading ?? <TableSkeleton />}</>;
  }
  const data = query.data;
  return (
    <>
      {query.error ? <QueryError compact what={`the latest ${what}`} message={errorMessage(query.error)} onRetry={retry} /> : null}
      {isEmpty?.(data) ? (empty ?? <EmptyState title={`No ${what} yet`} />) : children(data)}
    </>
  );
}
