/**
 * The person's "Set as home" choice (audit 2026-10-20, U33), from the server.
 *
 * It lived in one browser's localStorage, so a second browser, a new laptop or
 * a cleared cache opened the other home. It is users.home_view now, read with
 * the rest of the account's appearance choices. A choice left in this browser
 * from before is read once: carried to the server when the server holds none,
 * and dropped either way, so the server's answer is the only one afterwards.
 */
import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { DEFAULT_HOME_VIEW, LEGACY_HOME_KEY, carryOverHomeView, homeViewFrom, type HomeView } from "@/lib/homeChoice";

function readLegacy(): string | null {
  try { return localStorage.getItem(LEGACY_HOME_KEY); } catch { return null; }
}
function dropLegacy() {
  try { localStorage.removeItem(LEGACY_HOME_KEY); } catch { /* nothing to drop */ }
}

export function useHomeView(): {
  /** The view Velocity opens on for this person. */
  homeView: HomeView;
  /** Whether the person chose it (false: the default). */
  chosen: boolean;
  setHomeView: (v: HomeView) => void;
  saving: boolean;
} {
  const utils = trpc.useUtils();
  const appearance = trpc.profile.getMyAppearance.useQuery(undefined, { staleTime: 60_000 });
  const save = trpc.profile.updateMyAppearance.useMutation({
    onSuccess: () => { void utils.profile.getMyAppearance.invalidate(); },
    onError: (e) => toast.error(e.message),
  });
  const carried = useRef(false);
  const server = appearance.data ? (appearance.data.homeView ?? null) : undefined;
  useEffect(() => {
    if (carried.current || server === undefined) return;
    carried.current = true;
    const carry = carryOverHomeView(server, readLegacy());
    dropLegacy();
    if (carry) save.mutate({ homeView: carry });
  }, [server]); // eslint-disable-line react-hooks/exhaustive-deps
  // Until the server answers, a choice still in this browser holds the page.
  const saved: HomeView | null = server === undefined ? homeViewFrom(readLegacy()) : server ?? (save.variables?.homeView ?? null);
  return {
    homeView: saved ?? DEFAULT_HOME_VIEW,
    chosen: saved != null,
    setHomeView: (v) => save.mutate({ homeView: v }),
    saving: save.isPending,
  };
}
