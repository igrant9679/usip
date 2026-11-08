/**
 * Which view of the one home page opens (audit 2026-10-20, G56, U33 and
 * X6.3).
 *
 * Velocity had two homes, Home (/v2/home, what needs you) and the Dashboard
 * (/dashboard, the pipeline numbers), and "Set as home" picked which one "/"
 * opened, kept in one browser's localStorage. Batch CONB (2026-11-08) made
 * them one page, /v2/home, with a Today view and a Pipeline view, and the
 * choice is now the person's, stored on the server (profile.updateMyAppearance
 * → users.home_view, migration 0430). A choice still sitting in a browser is
 * read once, carried to the server, and dropped (hooks/useHomeView.ts).
 *
 * The dashboard stays the default, so nobody who never chose sees a change.
 */
import { DEFAULT_HOME_VIEW, isHomeView, type HomeView } from "@shared/homeView";

export { DEFAULT_HOME_VIEW, type HomeView };

/** Where the old "Set as home" lived in each browser (velocity_home_dashboard). */
export const LEGACY_HOME_KEY = "velocity_home_dashboard";

/** The two views, as "Set as home" lists them, and the link to each. */
export const HOME_CHOICES = [
  { view: "today" as HomeView, label: "Home", href: "/v2/home?view=today" },
  { view: "pipeline" as HomeView, label: "Dashboard", href: "/v2/home?view=pipeline" },
] as const;

/**
 * A saved value → its view. Takes a view id, or what the old browser key
 * held: "/v2/home" (Home) and "/dashboard" (the Dashboard). Anything else
 * (nothing saved, "/", the retired /dashboard-home2) is no choice at all.
 */
export function homeViewFrom(saved: string | null | undefined): HomeView | null {
  if (isHomeView(saved)) return saved;
  if (saved === "/v2/home") return "today";
  if (saved === "/dashboard") return "pipeline";
  return null;
}

/**
 * A choice left in a browser, once the server has answered: what to carry to
 * the server. The server's own choice wins, so the browser's is only carried
 * when the server holds none. Either way the browser's copy is then dropped.
 */
export function carryOverHomeView(server: HomeView | null, legacyRaw: string | null): HomeView | null {
  return server === null ? homeViewFrom(legacyRaw) : null;
}

/**
 * The view to show: what the URL asks for (?view=), else the person's saved
 * choice, else the default.
 */
export function resolveHomeView(search: string, saved: HomeView | null | undefined): HomeView {
  const asked = new URLSearchParams(search.replace(/^\?/, "")).get("view");
  if (isHomeView(asked)) return asked;
  return saved ?? DEFAULT_HOME_VIEW;
}
