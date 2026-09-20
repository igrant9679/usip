import { trpc } from "@/lib/trpc";
import { PERMISSION_KEYS, type PermissionKey } from "@shared/permissions";

/**
 * What the signed-in member may actually do, resolved by the server.
 *
 * ⚠️ DEFAULTS TO ALLOWED while the query is in flight. A permission toggle is
 * a rare, deliberate restriction; rendering every gated control as forbidden
 * for the first few hundred milliseconds of every page load would flicker the
 * Export button off and on for the ~100% of members who have no override row
 * at all. The server is the boundary either way — these helpers decide what to
 * SHOW, and a control that is shown but refused is a toast, while a control
 * that is hidden from someone entitled to it is a support ticket.
 *
 * For the client-side CSV exports specifically, hiding the button is UX and
 * not enforcement: the rows are already in the browser. See the comment on
 * reports.exportCsv (server/routers/reports.ts).
 */
export function usePermissions() {
  const q = trpc.team.myPermissions.useQuery(undefined, {
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  const map = (q.data ?? {}) as Record<string, boolean>;
  const can = (key: PermissionKey): boolean => map[key] !== false;

  return { can, permissions: map, isLoading: q.isLoading, keys: PERMISSION_KEYS };
}
