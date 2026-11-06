/**
 * Where "/" lands: the home picked with "Set as home" on Dashboards (audit
 * 2026-10-20, G56).
 *
 * Velocity has two homes and keeps both: Home (/v2/home, what needs you) and
 * the Dashboard (/dashboard, the pipeline numbers). The choice was saved and
 * then read only by a sidebar link that no longer exists, so "/" was always the
 * Dashboard whatever was picked. The Dashboard stays the default, so nobody
 * who never chose sees a change.
 */
export const HOME_CHOICES = [
  { label: "Home", href: "/v2/home" },
  { label: "Dashboard", href: "/dashboard" },
] as const;

export type HomeHref = (typeof HOME_CHOICES)[number]["href"];

export const DEFAULT_HOME: HomeHref = "/dashboard";

/**
 * The saved choice, if it is still one of the homes. Anything else (nothing
 * saved, "/" from before, the retired /dashboard-home2) is the default.
 */
export function homeHref(saved: string | null | undefined): HomeHref {
  const hit = HOME_CHOICES.find((c) => c.href === saved);
  return hit ? hit.href : DEFAULT_HOME;
}
